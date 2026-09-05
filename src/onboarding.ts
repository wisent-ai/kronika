// First-use onboarding for the Kronika CLI.
//
// The journey Kronika presents is the definition it ships
// (`onboarding_first_use.json`), which is also the file Echo's publisher
// registers. A control plane may serve a newer version of the same journey; if
// it cannot be reached, the shipped definition is authoritative, so the
// walkthrough works offline and on a first install.
//
// Progress lives in one local state file, and the journey completes only after
// `kronika init` has durably adopted existing documentation into the
// repository's canonical sync manifest.

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import shippedDefinition from "./onboarding_first_use.json" with { type: "json" };

const PRODUCT_ID = "kronika";
const JOURNEY_ID = "first-use";
const JOURNEY_VERSION = "2026-09-05.1";
const JOURNEY_VERSION_ID = "59e8a0c3-55d8-4a95-80df-1dd4cfa57766";
const FIRST_SUCCESS_FACT = "documentation_workspace_initialized";
const STATE_PATH = join(
  process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"),
  "kronika",
  "onboarding.json",
);
const REQUEST_TIMEOUT_MS = 1_500;
const MAX_SCREENS = 128;

type Scalar = string | number | boolean | null;

type Condition =
  | { kind: "all" | "any"; conditions: Condition[] }
  | { kind: "not"; condition: Condition }
  | { kind: "fact"; fact: string; operator: string; value?: Scalar };

type Transition = {
  next_screen_id: string;
  reason_code: string;
  priority: number;
  condition?: Condition | null;
};

type Screen = {
  screen_id: string;
  screen_kind: string;
  title_key: string;
  body_key: string;
  required: boolean;
  entry_conditions?: Condition | null;
  completion_evidence?: Condition | null;
  actions: string[];
  transitions: Transition[];
  fallback_screen_id?: string | null;
  presentation?: Record<string, Scalar> | null;
};

type JourneyDefinition = {
  schema_version: number;
  product_id: string;
  journey_id: string;
  journey_version: string;
  entry_screen_id: string;
  first_success_fact: string;
  published_at: string;
  source_revision: string;
  screens: Screen[];
  analytics_contract: Record<string, string>;
  experiment_contract?: { experiment_id?: string } | null;
};

type Bundle = {
  journey_version_id: string;
  definition: JourneyDefinition;
  canonical_definition: string;
  content_sha256: string;
  source_revision?: string;
};

type Status = "in_progress" | "completed" | "skipped";

type OnboardingEvent = {
  event_id: string;
  event_name: string;
  attempt_id: string;
  product_id: string;
  journey_version_id: string;
  subject_hash: string;
  scope_kind: string;
  screen_id: string;
  occurred_at: string;
  evidence_revision: string;
  experiment_id: string | undefined;
  variant_id: string | undefined;
  selected_next_screen_id: string | undefined;
  reason_code: string | undefined;
  properties: Record<string, Scalar | undefined>;
  answers: unknown[];
};

type Progress = {
  attempt_id: string;
  product_id: string;
  journey_version_id: string;
  subject_hash: string;
  scope_kind: string;
  current_screen_id: string;
  completed_screen_ids: string[];
  status: Status;
  evidence_revision: string;
  answers: unknown[];
  experiment_id?: string;
  variant_id?: string;
};

type State = {
  schema_version: number;
  installation_id: string;
  pending_events: OnboardingEvent[];
  evidence: Record<string, Scalar>;
  meta: Record<string, boolean>;
  bundle?: unknown;
  progress?: unknown;
};

export type OnboardingAction = "show" | "status" | "advance" | "skip" | "reset";

export type OnboardingView = {
  productId: string;
  journeyId: string;
  journeyVersion: string;
  status: Status | "not_started";
  screenId: string;
  screenKind: string;
  step: number;
  stepCount: number;
  title: string;
  body: string;
  actions: string[];
  command?: string;
  result?: string;
  completedScreenIds: string[];
  firstSuccessFact: string;
};

const FALLBACK_DEFINITION = shippedDefinition as unknown as JourneyDefinition;

// The package already guards decoded values this way in `brama.ts`; a value
// narrowed here is an object, and its fields stay `unknown`.
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
};

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

const canonicalFallback = (): Bundle => {
  const canonicalDefinition = JSON.stringify(canonical(FALLBACK_DEFINITION));
  return {
    journey_version_id: JOURNEY_VERSION_ID,
    definition: FALLBACK_DEFINITION,
    canonical_definition: canonicalDefinition,
    content_sha256: sha256(canonicalDefinition),
    source_revision: FALLBACK_DEFINITION.source_revision,
  };
};

const FACT_OPERATORS: Record<string, true> = {
  present: true,
  absent: true,
  eq: true,
  not_eq: true,
  contains: true,
  gt: true,
  gte: true,
  lt: true,
  lte: true,
};

const validateCondition = (condition: unknown): boolean => {
  if (!isRecord(condition) || typeof condition.kind !== "string") return false;
  if (condition.kind === "all" || condition.kind === "any") {
    return Array.isArray(condition.conditions) && condition.conditions.every(validateCondition);
  }
  if (condition.kind === "not") return validateCondition(condition.condition);
  return condition.kind === "fact"
    && typeof condition.fact === "string"
    && typeof condition.operator === "string"
    && FACT_OPERATORS[condition.operator] === true;
};

// JSON has no `undefined`: a field the producer left out arrives missing and a
// field it emitted empty arrives as `null`. Both mean the same thing here, and
// every optional condition and fallback in this file is read through this.
const absent = (value: unknown): boolean => value === undefined || value === null;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// A bundle from the control plane is only accepted when it is the journey this
// build knows, its canonical form hashes to the advertised digest, and its
// screen graph resolves. Anything else falls back to the shipped definition.
const validateBundle = (candidate: unknown): Bundle => {
  if (!isRecord(candidate)
    || typeof candidate.journey_version_id !== "string" || !UUID.test(candidate.journey_version_id)
    || typeof candidate.content_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(candidate.content_sha256)
    || typeof candidate.canonical_definition !== "string") {
    throw new Error("onboarding bundle envelope is invalid");
  }
  const definition = candidate.definition;
  if (!isRecord(definition) || definition.schema_version !== 1 || definition.product_id !== PRODUCT_ID
    || definition.journey_id !== JOURNEY_ID || definition.journey_version !== JOURNEY_VERSION
    || definition.first_success_fact !== FIRST_SUCCESS_FACT || typeof definition.entry_screen_id !== "string") {
    throw new Error("onboarding bundle identity is invalid");
  }
  if (JSON.stringify(canonical(definition)) !== candidate.canonical_definition
    || sha256(candidate.canonical_definition) !== candidate.content_sha256) {
    throw new Error("onboarding bundle integrity is invalid");
  }
  if (!Array.isArray(definition.screens) || definition.screens.length === 0 || definition.screens.length > MAX_SCREENS) {
    throw new Error("onboarding screen graph is invalid");
  }
  const ids = new Set<string>();
  for (const screen of definition.screens) {
    if (!isRecord(screen) || typeof screen.screen_id !== "string" || ids.has(screen.screen_id)
      || typeof screen.screen_kind !== "string"
      || typeof screen.title_key !== "string" || typeof screen.body_key !== "string"
      || !Array.isArray(screen.actions) || !screen.actions.every((action) => typeof action === "string")
      || !Array.isArray(screen.transitions)
      || (!absent(screen.completion_evidence) && !validateCondition(screen.completion_evidence))) {
      throw new Error("onboarding screen is invalid");
    }
    ids.add(screen.screen_id);
  }
  if (!ids.has(definition.entry_screen_id)) throw new Error("onboarding entry screen is missing");
  for (const screen of definition.screens as Screen[]) {
    if (!absent(screen.fallback_screen_id) && !ids.has(screen.fallback_screen_id as string)) {
      throw new Error("onboarding fallback is missing");
    }
    for (const transition of screen.transitions) {
      if (!isRecord(transition) || typeof transition.next_screen_id !== "string" || !ids.has(transition.next_screen_id)
        || typeof transition.reason_code !== "string" || typeof transition.priority !== "number"
        || (!absent(transition.condition) && !validateCondition(transition.condition))) {
        throw new Error("onboarding transition is invalid");
      }
    }
  }
  return candidate as Bundle;
};

const loadState = async (): Promise<State> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(STATE_PATH, "utf8"));
    if (isRecord(parsed) && parsed.schema_version === 1) {
      const state = parsed as State;
      if (typeof state.installation_id !== "string") state.installation_id = randomUUID();
      if (!Array.isArray(state.pending_events)) state.pending_events = [];
      if (!isRecord(state.evidence)) state.evidence = {};
      if (!isRecord(state.meta)) state.meta = {};
      return state;
    }
  } catch {
    // A missing or damaged local store is replaced by a fresh, valid one.
  }
  return { schema_version: 1, installation_id: randomUUID(), pending_events: [], evidence: {}, meta: {} };
};

const saveState = async (state: State): Promise<void> => {
  await mkdir(dirname(STATE_PATH), { recursive: true, mode: 0o700 });
  const temporary = `${STATE_PATH}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, STATE_PATH);
};

// The control plane is optional: without a configured integration endpoint and
// token every call fails fast and the journey runs from local state alone.
class StadoTransport {
  private available = true;

  constructor(private readonly client: string) {}

  private async post(operation: string, body: unknown): Promise<unknown> {
    const baseValue = process.env.STADO_INTEGRATION_API_URL;
    const token = process.env.KRONIKA_STADO_INTEGRATION_TOKEN;
    if (!this.available || !baseValue || !token) throw new Error("onboarding control plane is unavailable");
    let base: URL;
    try {
      base = new URL(baseValue);
      if (base.protocol !== "https:" || base.username || base.password) throw new Error("invalid origin");
    } catch {
      this.available = false;
      throw new Error("onboarding control plane URL is invalid");
    }
    const endpoint = new URL(
      `/integration/${encodeURIComponent(this.client)}/onboarding/${PRODUCT_ID}/${operation}`,
      base,
    );
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const envelope: unknown = await response.json();
      if (!response.ok || !isRecord(envelope) || envelope.ok !== true || !("result" in envelope)) {
        throw new Error("onboarding control plane rejected the request");
      }
      return envelope.result;
    } catch (error) {
      this.available = false;
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  readBundle(): Promise<unknown> {
    return this.post("bundle.read", {
      product_id: PRODUCT_ID,
      journey_id: JOURNEY_ID,
      journey_version: JOURNEY_VERSION,
      if_none_match: null,
    });
  }

  readRemoteState(progress: Progress): Promise<unknown> {
    return this.post("state.read", {
      product_id: PRODUCT_ID,
      attempt_id: progress.attempt_id,
      subject_hash: progress.subject_hash,
    });
  }

  assignExperiment(subjectHash: string): Promise<unknown> {
    return this.post("experiments.assign", {
      product_id: PRODUCT_ID,
      journey_id: JOURNEY_ID,
      journey_version: JOURNEY_VERSION,
      subject_hash: subjectHash,
      scope_kind: "device",
      surface: this.client,
    });
  }

  collectEvent(event: OnboardingEvent): Promise<unknown> {
    return this.post("events.collect", event);
  }
}

const evaluate = (condition: Condition | null | undefined, evidence: Record<string, Scalar>): boolean => {
  if (absent(condition)) return true;
  const test = condition as Condition;
  if (test.kind === "all") return test.conditions.every((entry) => evaluate(entry, evidence));
  if (test.kind === "any") return test.conditions.some((entry) => evaluate(entry, evidence));
  if (test.kind === "not") return !evaluate(test.condition, evidence);
  if (test.kind !== "fact") return false;
  const actual = evidence[test.fact];
  if (test.operator === "present") return actual !== undefined && actual !== null;
  if (test.operator === "absent") return actual === undefined || actual === null;
  if (test.operator === "eq") return actual === test.value;
  if (test.operator === "not_eq") return actual !== test.value;
  if (test.operator === "contains") return Array.isArray(actual) && (actual as Scalar[]).includes(test.value as Scalar);
  if (typeof actual !== "number" || typeof test.value !== "number") return false;
  if (test.operator === "gt") return actual > test.value;
  if (test.operator === "gte") return actual >= test.value;
  if (test.operator === "lt") return actual < test.value;
  if (test.operator === "lte") return actual <= test.value;
  return false;
};

type Decision = { screen_id: string; reason_code: string };

const selectNext = (bundle: Bundle, currentScreenId: string, evidence: Record<string, Scalar>): Decision | null => {
  const current = bundle.definition.screens.find((screen) => screen.screen_id === currentScreenId);
  if (!current) return null;
  if (!absent(current.completion_evidence) && !evaluate(current.completion_evidence, evidence)) return null;
  const transition = [...current.transitions]
    .sort((left, right) => left.priority - right.priority)
    .find((candidate) => evaluate(candidate.condition, evidence));
  if (transition) return { screen_id: transition.next_screen_id, reason_code: transition.reason_code };
  if (!absent(current.fallback_screen_id)) {
    return { screen_id: current.fallback_screen_id as string, reason_code: "fallback_evidence_unavailable" };
  }
  return null;
};

const newProgress = (bundle: Bundle, subjectHash: string, revision: string): Progress => ({
  attempt_id: randomUUID(),
  product_id: PRODUCT_ID,
  journey_version_id: bundle.journey_version_id,
  subject_hash: subjectHash,
  scope_kind: "device",
  current_screen_id: bundle.definition.entry_screen_id,
  completed_screen_ids: [],
  status: "in_progress",
  evidence_revision: revision,
  answers: [],
});

class OnboardingSession {
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

const openSession = async (client: string, start: boolean): Promise<OnboardingSession | null> => {
  const state = await loadState();
  const subjectHash = sha256(`${PRODUCT_ID}:${state.installation_id}`);
  const transport = new StadoTransport(client);
  let bundle: Bundle;
  try {
    bundle = validateBundle(await transport.readBundle());
    state.bundle = bundle;
  } catch {
    try {
      bundle = validateBundle(state.bundle);
    } catch {
      bundle = canonicalFallback();
    }
  }
  // A persisted attempt is resumed only when it still belongs to this journey
  // version and this installation; anything else starts a fresh attempt.
  const persisted: unknown = state.progress;
  const existing = isRecord(persisted) && persisted.product_id === PRODUCT_ID
    && persisted.journey_version_id === bundle.journey_version_id
    && persisted.subject_hash === subjectHash && typeof persisted.attempt_id === "string"
    && bundle.definition.screens.some((screen) => screen.screen_id === persisted.current_screen_id)
    && Array.isArray(persisted.completed_screen_ids) && Array.isArray(persisted.answers);
  if (!start && !existing) return null;
  const revision = new Date().toISOString();
  if (!existing) {
    state.progress = newProgress(bundle, subjectHash, revision);
    state.evidence = {};
    state.meta = {};
  }
  const session = new OnboardingSession(state, bundle, transport, subjectHash);
  await session.save();
  if (existing) {
    try {
      await transport.readRemoteState(session.progress);
    } catch {
      // Local progress stays authoritative when the control plane is absent.
    }
  }
  const experiment = bundle.definition.experiment_contract;
  if (experiment && !session.progress.variant_id) {
    try {
      const assignment = await transport.assignExperiment(subjectHash);
      if (isRecord(assignment)) {
        session.progress.experiment_id = typeof assignment.experimentId === "string"
          ? assignment.experimentId
          : experiment.experiment_id ?? "";
        if (typeof assignment.variant === "string") session.progress.variant_id = assignment.variant;
        await session.save();
      }
    } catch {
      // The canonical journey is usable without an experiment assignment.
    }
  }
  if (!existing) await session.emit([session.event("onboarding_started", revision)]);
  else await session.flush();
  return session;
};

const stringField = (screen: Screen, key: string, fallback: string): string => {
  const local = FALLBACK_DEFINITION.screens.find((entry) => entry.screen_id === screen.screen_id);
  const value = screen.presentation?.[key] ?? local?.presentation?.[key];
  return typeof value === "string" ? value : fallback;
};

const view = (session: OnboardingSession): OnboardingView => {
  const screen = session.screen;
  const screens = session.bundle.definition.screens;
  const command = stringField(screen, "command", "");
  const result = stringField(screen, "result", "");
  return {
    productId: PRODUCT_ID,
    journeyId: JOURNEY_ID,
    journeyVersion: session.bundle.definition.journey_version,
    status: session.progress.status,
    screenId: screen.screen_id,
    screenKind: screen.screen_kind,
    step: screens.findIndex((entry) => entry.screen_id === screen.screen_id) + 1,
    stepCount: screens.length,
    title: stringField(screen, "title", screen.title_key),
    body: stringField(screen, "body", screen.body_key),
    actions: [...screen.actions],
    ...(command ? { command } : {}),
    ...(result ? { result } : {}),
    completedScreenIds: [...session.progress.completed_screen_ids],
    firstSuccessFact: session.bundle.definition.first_success_fact,
  };
};

/**
 * Present or move the first-use journey. `status` reports an existing attempt
 * without starting one; `reset` replays the journey from its entry screen.
 */
export const runOnboardingAction = async (
  action: OnboardingAction = "show",
  { client = "cli" }: { client?: string } = {},
): Promise<OnboardingView> => {
  const session = await openSession(client, action !== "status");
  if (!session) {
    const entry = FALLBACK_DEFINITION.screens.find(
      (screen) => screen.screen_id === FALLBACK_DEFINITION.entry_screen_id,
    );
    if (!entry) throw new Error("onboarding entry screen is missing");
    return {
      productId: PRODUCT_ID,
      journeyId: JOURNEY_ID,
      journeyVersion: JOURNEY_VERSION,
      status: "not_started",
      screenId: entry.screen_id,
      screenKind: entry.screen_kind,
      step: 1,
      stepCount: FALLBACK_DEFINITION.screens.length,
      title: stringField(entry, "title", entry.title_key),
      body: stringField(entry, "body", entry.body_key),
      actions: ["kronika onboarding"],
      completedScreenIds: [],
      firstSuccessFact: FIRST_SUCCESS_FACT,
    };
  }
  const revision = new Date().toISOString();
  if (action === "reset") await session.reset(revision);
  else if (action === "skip") await session.skip(revision);
  else if (action === "advance") await session.advance(revision);
  if (action !== "status" && action !== "skip") await session.expose(revision);
  return view(session);
};

/**
 * Record the first real setup result: existing documentation accepted into a
 * durable Kronika project manifest. Onboarding bookkeeping must never turn a
 * successful import into a failure, so every error is swallowed.
 */
export const recordWorkspaceInitialized = async (
  {
    client = "cli",
    documentCount,
    manifestPath,
  }: { client?: string; documentCount?: number; manifestPath?: string } = {},
): Promise<boolean> => {
  try {
    const session = await openSession(client, false);
    if (!session || session.progress.status !== "in_progress") return false;
    return await session.observeWorkspaceInitialized(new Date().toISOString(), {
      first_success_fact: FIRST_SUCCESS_FACT,
      command: "kronika init",
      document_count: documentCount ?? null,
      manifest_path: manifestPath ?? null,
    });
  } catch {
    return false;
  }
};

export const renderOnboardingView = (result: OnboardingView): string => [
  `Kronika first-use — step ${result.step} of ${result.stepCount} (${result.screenId})`,
  "",
  result.title,
  "",
  result.body,
  "",
  ...(result.command ? [`Run: ${result.command}`, ...(result.result ? [`Expect: ${result.result}`] : []), ""] : []),
  `Status: ${result.status}`,
  ...(result.status === "in_progress" && !result.command
    ? ["Next: kronika onboarding --advance"]
    : []),
  ...(result.status === "in_progress" && result.command
    ? [`Next: run the command above; it completes the journey (${result.firstSuccessFact})`]
    : []),
  ...(result.status === "completed" || result.status === "skipped"
    ? ["Replay: kronika onboarding --reset"]
    : []),
].join("\n");
