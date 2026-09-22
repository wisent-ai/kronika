// First-use onboarding for the Kronika CLI.
//
// The journey Kronika presents is the definition it ships, which is also the
// file the publisher registers. A control plane may serve a newer version of
// the same journey; when it cannot be reached the shipped definition is
// authoritative, so the walkthrough works offline and on a first install.
//
// Progress lives in one local state file, and the journey completes only after
// `kronika init` has durably adopted existing documentation into the
// repository-s canonical sync manifest.

import { createHash, randomUUID } from "node:crypto";

import {
  FIRST_SUCCESS_FACT,
  JOURNEY_ID,
  JOURNEY_VERSION,
  PRODUCT_ID,
} from "./journey/shapes.js";
import type { Bundle, OnboardingView, Progress, Scalar, Screen, State } from "./journey/shapes.js";
import { canonicalFallback, FALLBACK_DEFINITION, isRecord, sha256, validateBundle } from "./journey/bundle.js";
import { loadState, saveState, StadoTransport } from "./journey/store.js";
import { OnboardingSession } from "./journey/session.js";
import { newProgress } from "./journey/next.js";


import type { OnboardingAction } from "./journey/shapes.js";

export type { OnboardingAction, OnboardingView } from "./journey/shapes.js";

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
