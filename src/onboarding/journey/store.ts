// Where progress is kept and how the control plane is reached: the local state
// file read and written atomically, and the transport that gives up quietly
// when the plane cannot be reached, so the journey runs from local state alone.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { JOURNEY_ID, JOURNEY_VERSION, PRODUCT_ID, STATE_PATH } from "./shapes.js";
import type { Bundle, OnboardingEvent, Progress, State } from "./shapes.js";
import { isRecord } from "./bundle.js";
import { canonicalFallback, validateBundle } from "./bundle.js";

// The state file's format version, and the owner-only modes its directory and
// file are made with, as the onboarding section of the interfaces page states
// them.
const STATE_SCHEMA_VERSION = 1; // https://github.com/wisent-ai/kronika/blob/main/docs/interfaces.md ("The state file's format is `schema_version` 1")
const STATE_DIRECTORY_MODE = 0o700; // https://github.com/wisent-ai/kronika/blob/main/docs/interfaces.md ("its directory is created with mode 0700")
const STATE_FILE_MODE = 0o600; // https://github.com/wisent-ai/kronika/blob/main/docs/interfaces.md ("the file written with mode 0600")

// Only a store that does not exist yet starts fresh. One that exists but
// cannot be read, parsed or recognised is refused with its path and cause:
// starting fresh would be saved over it and lose its recorded evidence and
// pending events.
export const loadState = async (): Promise<State> => {
  let text: string;
  try {
    text = await readFile(STATE_PATH, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { schema_version: STATE_SCHEMA_VERSION, installation_id: randomUUID(), pending_events: [], evidence: {}, meta: {} };
    }
    throw new Error(`onboarding state ${STATE_PATH} cannot be read: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`onboarding state ${STATE_PATH} is not valid JSON: ${(error as Error).message}`);
  }
  if (!isRecord(parsed) || parsed.schema_version !== STATE_SCHEMA_VERSION) {
    throw new Error(`onboarding state ${STATE_PATH} is not a schema_version ${STATE_SCHEMA_VERSION} state`);
  }
  if (typeof parsed.installation_id !== "string" || !parsed.installation_id.trim()) {
    throw new Error(`onboarding state ${STATE_PATH} has no nonempty installation_id`);
  }
  if (!Array.isArray(parsed.pending_events)) {
    throw new Error(`onboarding state ${STATE_PATH} pending_events must be an array`);
  }
  if (!isRecord(parsed.evidence)) {
    throw new Error(`onboarding state ${STATE_PATH} evidence must be an object`);
  }
  if (!isRecord(parsed.meta)) {
    throw new Error(`onboarding state ${STATE_PATH} meta must be an object`);
  }
  return parsed as State;
};

export const saveState = async (state: State): Promise<void> => {
  await mkdir(dirname(STATE_PATH), { recursive: true, mode: STATE_DIRECTORY_MODE });
  const temporary = `${STATE_PATH}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: STATE_FILE_MODE });
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
    } catch (error) {
      this.available = false;
      throw new Error(`onboarding control plane URL STADO_INTEGRATION_API_URL does not parse: ${(error as Error).message}`);
    }
    if (base.protocol !== "https:" || base.username || base.password) {
      this.available = false;
      throw new Error(
        `onboarding control plane URL STADO_INTEGRATION_API_URL must be an https origin without credentials; it is ${base.protocol}${base.username || base.password ? " with credentials" : ""}`,
      );
    }
    const endpoint = new URL(
      `/integration/${encodeURIComponent(this.client)}/onboarding/${PRODUCT_ID}/${operation}`,
      base,
    );
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const envelope: unknown = await response.json();
      if (!response.ok || !isRecord(envelope) || envelope.ok !== true || !("result" in envelope)) {
        const said = isRecord(envelope) && typeof envelope.error === "string" ? `: ${envelope.error}` : "";
        throw new Error(`onboarding control plane refused ${operation} with HTTP ${response.status}${said}`);
      }
      return envelope.result;
    } catch (error) {
      this.available = false;
      throw error;
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

