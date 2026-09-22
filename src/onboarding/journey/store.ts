// Where progress is kept and how the control plane is reached: the local state
// file read and written atomically, and the transport that gives up quietly
// when the plane cannot be reached, so the journey runs from local state alone.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { JOURNEY_ID, JOURNEY_VERSION, PRODUCT_ID, REQUEST_TIMEOUT_MS, STATE_PATH } from "./shapes.js";
import type { Bundle, OnboardingEvent, Progress, State } from "./shapes.js";
import { isRecord } from "./bundle.js";
import { canonicalFallback, validateBundle } from "./bundle.js";

export const loadState = async (): Promise<State> => {
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

export const saveState = async (state: State): Promise<void> => {
  await mkdir(dirname(STATE_PATH), { recursive: true, mode: 0o700 });
  const temporary = `${STATE_PATH}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, STATE_PATH);
};

// The control plane is optional: without a configured integration endpoint and
// token every call fails fast and the journey runs from local state alone.
export class StadoTransport {
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

