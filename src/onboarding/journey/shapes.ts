// What a first-use journey is made of: the journey this build knows, the
// screens and transitions a definition declares, the events a run records and
// the progress it keeps locally.

import { homedir } from "node:os";
import { join } from "node:path";

export const PRODUCT_ID = "kronika";
export const JOURNEY_ID = "first-use";
export const JOURNEY_VERSION = "2026-09-05.1";
export const JOURNEY_VERSION_ID = "59e8a0c3-55d8-4a95-80df-1dd4cfa57766";
export const FIRST_SUCCESS_FACT = "documentation_workspace_initialized";
export const STATE_PATH = join(
  process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"),
  "kronika",
  "onboarding.json",
);
export const REQUEST_TIMEOUT_MS = 1_500;
export const MAX_SCREENS = 128;

export type Scalar = string | number | boolean | null;

export type Condition =
  | { kind: "all" | "any"; conditions: Condition[] }
  | { kind: "not"; condition: Condition }
  | { kind: "fact"; fact: string; operator: string; value?: Scalar };

export type Transition = {
  next_screen_id: string;
  reason_code: string;
  priority: number;
  condition?: Condition | null;
};

export type Screen = {
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

export type JourneyDefinition = {
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

export type Bundle = {
  journey_version_id: string;
  definition: JourneyDefinition;
  canonical_definition: string;
  content_sha256: string;
  source_revision?: string;
};

export type Status = "in_progress" | "completed" | "skipped";

export type OnboardingEvent = {
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

export type Progress = {
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

export type State = {
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

