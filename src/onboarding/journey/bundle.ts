// Whether a bundle from the control plane is the journey this build knows: the
// canonical form its digest is taken over, the conditions a screen may
// declare, and the screen graph that has to resolve before it is accepted.
// Anything else falls back to the definition this build ships.

import { createHash } from "node:crypto";

import shippedDefinition from "../onboarding_first_use.json" with { type: "json" };
import {
  FIRST_SUCCESS_FACT,
  JOURNEY_ID,
  JOURNEY_VERSION,
  JOURNEY_VERSION_ID,
  MAX_SCREENS,
  PRODUCT_ID,
} from "./shapes.js";
import type { Bundle, Condition, JourneyDefinition, Screen } from "./shapes.js";

export const FALLBACK_DEFINITION = shippedDefinition as unknown as JourneyDefinition;

// The package already guards decoded values this way in `brama.ts`; a value
// narrowed here is an object, and its fields stay `unknown`.
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const canonical = (value: unknown): unknown => {
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

export const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

export const canonicalFallback = (): Bundle => {
  const canonicalDefinition = JSON.stringify(canonical(FALLBACK_DEFINITION));
  return {
    journey_version_id: JOURNEY_VERSION_ID,
    definition: FALLBACK_DEFINITION,
    canonical_definition: canonicalDefinition,
    content_sha256: sha256(canonicalDefinition),
    source_revision: FALLBACK_DEFINITION.source_revision,
  };
};

export const FACT_OPERATORS: Record<string, true> = {
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

export const validateCondition = (condition: unknown): boolean => {
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
export const absent = (value: unknown): boolean => value === undefined || value === null;

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// A bundle from the control plane is only accepted when it is the journey this
// build knows, its canonical form hashes to the advertised digest, and its
// screen graph resolves. Anything else falls back to the shipped definition.
export const validateBundle = (candidate: unknown): Bundle => {
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

