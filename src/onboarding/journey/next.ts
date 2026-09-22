// Which screen comes next: the conditions a transition declares, read against
// the evidence this installation has recorded, and the progress a fresh
// attempt starts from.

import { randomUUID } from "node:crypto";

import { PRODUCT_ID } from "./shapes.js";
import type { Bundle, Condition, Progress, Scalar } from "./shapes.js";
import { absent } from "./bundle.js";

export const evaluate = (condition: Condition | null | undefined, evidence: Record<string, Scalar>): boolean => {
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

export type Decision = { screen_id: string; reason_code: string };

export const selectNext = (bundle: Bundle, currentScreenId: string, evidence: Record<string, Scalar>): Decision | null => {
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

export const newProgress = (bundle: Bundle, subjectHash: string, revision: string): Progress => ({
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

