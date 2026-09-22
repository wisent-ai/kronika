// One run of the journey: the session that holds the state, the bundle and the
// screen it is on, advances it, skips it and records what happened.

import { randomUUID } from "node:crypto";

import { FIRST_SUCCESS_FACT, PRODUCT_ID } from "./shapes.js";
import type { Bundle, OnboardingEvent, Progress, Scalar, Screen, State, Status } from "./shapes.js";
import type { Decision } from "./next.js";
import { saveState, StadoTransport } from "./store.js";
import { evaluate, newProgress, selectNext } from "./next.js";

export class OnboardingSession {
  constructor(
    readonly state: State,
    readonly bundle: Bundle,
    private readonly transport: StadoTransport,
    private readonly subjectHash: string,
  ) {}

  get progress(): Progress {
    return this.state.progress as Progress;
  }

  get screen(): Screen {
    const current = this.bundle.definition.screens.find(
      (screen) => screen.screen_id === this.progress.current_screen_id,
    );
    if (!current) throw new Error("onboarding progress points at an unknown screen");
    return current;
  }

  save(): Promise<void> {
    return saveState(this.state);
  }

  event(
    name: string,
    revision: string,
    properties: Record<string, Scalar | undefined> = {},
    screenId: string = this.progress.current_screen_id,
    decision?: Decision,
  ): OnboardingEvent {
    return {
      event_id: randomUUID(),
      event_name: name,
      attempt_id: this.progress.attempt_id,
      product_id: PRODUCT_ID,
      journey_version_id: this.progress.journey_version_id,
      subject_hash: this.subjectHash,
      scope_kind: "device",
      screen_id: screenId,
      occurred_at: new Date().toISOString(),
      evidence_revision: revision,
      experiment_id: this.progress.experiment_id,
      variant_id: this.progress.variant_id,
      selected_next_screen_id: decision?.screen_id,
      reason_code: decision?.reason_code,
      properties,
      answers: this.progress.answers,
    };
  }

  async emit(events: OnboardingEvent[]): Promise<void> {
    const queued = this.state.pending_events;
    const ids = new Set(queued.map((event) => event.event_id));
    for (const event of events) if (!ids.has(event.event_id)) queued.push(event);
    await this.save();
    await this.flush();
  }

  async flush(): Promise<void> {
    while (this.state.pending_events.length > 0) {
      const event = this.state.pending_events[0];
      if (!event) break;
      try {
        await this.transport.collectEvent(event);
      } catch {
        return;
      }
      this.state.pending_events.shift();
      await this.save();
    }
  }

  async expose(revision: string): Promise<void> {
    if (this.progress.status === "in_progress") {
      await this.emit([this.event("onboarding_step_viewed", revision)]);
    }
  }

  async advance(revision: string): Promise<Decision | null> {
    if (this.progress.status !== "in_progress") return null;
    const current = this.screen;
    const decision = selectNext(this.bundle, current.screen_id, this.state.evidence);
    if (!decision) return null;
    this.progress.current_screen_id = decision.screen_id;
    if (!this.progress.completed_screen_ids.includes(current.screen_id)) {
      this.progress.completed_screen_ids.push(current.screen_id);
    }
    this.progress.evidence_revision = revision;
    await this.emit([this.event("onboarding_step_completed", revision, {}, current.screen_id, decision)]);
    return decision;
  }

  async skip(revision: string): Promise<void> {
    if (this.progress.status === "completed") return;
    this.progress.status = "skipped";
    this.progress.evidence_revision = revision;
    await this.emit([this.event("onboarding_step_skipped", revision)]);
  }

  async reset(revision: string): Promise<void> {
    this.state.evidence = {};
    this.state.meta = {};
    this.state.progress = newProgress(this.bundle, this.subjectHash, revision);
    await this.emit([
      this.event("onboarding_reset", revision),
      this.event("onboarding_started", revision),
    ]);
  }

  // The journey completes on the product's own durable effect, not on a click:
  // the repository now has a validated sync manifest for its existing docs.
  async observeWorkspaceInitialized(revision: string, properties: Record<string, Scalar | undefined>): Promise<boolean> {
    if (this.progress.status !== "in_progress") return false;
    this.state.evidence = { ...this.state.evidence, [FIRST_SUCCESS_FACT]: true };
    const events: OnboardingEvent[] = [];
    if (!this.state.meta.first_action_recorded) {
      this.state.meta = { ...this.state.meta, first_action_recorded: true };
      events.push(this.event("onboarding_first_action_completed", revision, properties));
    }
    for (let index = 0; index < this.bundle.definition.screens.length; index += 1) {
      const current = this.screen;
      if (current.transitions.length === 0) break;
      const decision = selectNext(this.bundle, current.screen_id, this.state.evidence);
      if (!decision) break;
      if (!this.progress.completed_screen_ids.includes(current.screen_id)) {
        this.progress.completed_screen_ids.push(current.screen_id);
      }
      this.progress.current_screen_id = decision.screen_id;
      events.push(this.event("onboarding_step_completed", revision, properties, current.screen_id, decision));
    }
    const terminal = this.screen;
    if (terminal.transitions.length === 0 && this.state.evidence[FIRST_SUCCESS_FACT] === true
      && evaluate(terminal.completion_evidence, this.state.evidence)) {
      if (!this.progress.completed_screen_ids.includes(terminal.screen_id)) {
        this.progress.completed_screen_ids.push(terminal.screen_id);
      }
      this.progress.status = "completed";
      events.push(this.event("onboarding_step_completed", revision, properties, terminal.screen_id));
      events.push(this.event("onboarding_first_success_observed", revision, properties, terminal.screen_id));
      events.push(this.event("onboarding_completed", revision, properties, terminal.screen_id));
    }
    this.progress.evidence_revision = revision;
    await this.emit(events);
    return this.progress.status === "completed";
  }
}

