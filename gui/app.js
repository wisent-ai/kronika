const form = document.querySelector("#import-form");
const submitButton = document.querySelector("#submit-button");
const formStatus = document.querySelector("#form-status");
const repoPath = document.querySelector("#repo-path");
const resultTitle = document.querySelector("#result-title");
const resultBadge = document.querySelector("#result-badge");
const resultEmpty = document.querySelector("#result-empty");
const resultContent = document.querySelector("#result-content");
const resultSummary = document.querySelector("#result-summary");
const resultMeta = document.querySelector("#result-meta");
const outcomeGroups = document.querySelector("#outcome-groups");
const projectState = document.querySelector("#project-state");
const projectSchema = document.querySelector("#project-schema");
const projectDocuments = document.querySelector("#project-documents");

// The session token kronika gui printed in the URL fragment; null when the
// page was opened without it, which loadSession refuses by name.
const token = new URLSearchParams(window.location.hash.replace(/^#/u, "")).get("token");

// Every status an import answers, with its badge and its sentence. A status
// this page does not know is refused by name, never shown as a raw word.
const STATUSES = {
  imported: {
    label: "Imported",
    summary: "Kronika atomically persisted the project and read the accepted manifest back.",
  },
  unchanged: {
    label: "Unchanged",
    summary: "The retained project is identical. No file was rewritten.",
  },
  conflicting: {
    label: "Conflict",
    summary: "A different project already exists. It was preserved; review it before choosing replace.",
  },
  rejected: {
    label: "Rejected",
    summary: "Kronika refused the selection before accepting a project.",
  },
};

const lines = (value) => value
  .split(/\r?\n/u)
  .map((entry) => entry.trim())
  .filter(Boolean);

const clear = (element) => {
  while (element.firstChild) element.firstChild.remove();
};

const appendDefinition = (list, term, description) => {
  const dt = document.createElement("dt");
  dt.textContent = term;
  const dd = document.createElement("dd");
  dd.textContent = description;
  list.append(dt, dd);
};

const appendPathGroup = (title, entries, tone) => {
  const section = document.createElement("section");
  section.className = `outcome ${tone}`;
  const heading = document.createElement("h3");
  heading.textContent = `${title} (${entries.length})`;
  section.append(heading);
  if (!entries.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "None";
    section.append(empty);
  } else {
    const list = document.createElement("ul");
    entries.forEach((entry) => {
      const item = document.createElement("li");
      if (typeof entry === "string") {
        item.textContent = entry;
      } else {
        const path = document.createElement("code");
        path.textContent = entry.path;
        const reason = document.createElement("span");
        reason.textContent = entry.reason;
        item.append(path, reason);
      }
      list.append(item);
    });
    section.append(list);
  }
  outcomeGroups.append(section);
};

// The documents in their accepted order, as an ordered list numbers them.
const renderProject = (project) => {
  clear(projectDocuments);
  if (!project) {
    projectState.hidden = true;
    return;
  }
  projectState.hidden = false;
  const accepted = new Intl.PluralRules("en-US").select(project.documents.length) === "one" ? "document" : "documents";
  projectSchema.textContent = `Schema version ${project.schemaVersion}; ${project.documents.length} accepted ${accepted}.`;
  const ordered = document.createElement("ol");
  project.documents.forEach((documentEntry) => {
    const article = document.createElement("li");
    article.className = "project-document";
    const heading = document.createElement("h4");
    heading.textContent = documentEntry.output;
    const sourceLabel = document.createElement("p");
    sourceLabel.className = "document-label";
    sourceLabel.textContent = "Evidence sources";
    const sourceList = document.createElement("ul");
    documentEntry.sources.forEach((source) => {
      const item = document.createElement("li");
      item.textContent = source;
      sourceList.append(item);
    });
    const instructionLabel = document.createElement("p");
    instructionLabel.className = "document-label";
    instructionLabel.textContent = "Standing instruction";
    const instruction = document.createElement("p");
    instruction.textContent = documentEntry.instruction;
    article.append(heading, sourceLabel, sourceList, instructionLabel, instruction);
    ordered.append(article);
  });
  projectDocuments.append(ordered);
};

const renderResult = ({ result, project }) => {
  if (!Object.hasOwn(STATUSES, result.status)) {
    throw new Error(`Kronika answered import status ${JSON.stringify(result.status)}, which this page does not know`);
  }
  const status = STATUSES[result.status];
  resultBadge.className = `badge ${result.status}`;
  resultBadge.textContent = status.label;
  resultSummary.textContent = status.summary;
  clear(resultMeta);
  appendDefinition(resultMeta, "Repository", result.repo);
  appendDefinition(resultMeta, "Manifest", result.manifestPath);
  if (result.onboarding) {
    appendDefinition(resultMeta, "Onboarding", result.onboarding.error
      ? `Not recorded: ${result.onboarding.error}`
      : result.onboarding.completed ? "Completed" : "No completion recorded");
    // Absent only when the record itself failed, which the line above says.
    if (Array.isArray(result.onboarding.controlPlaneFailures)) {
      for (const failure of result.onboarding.controlPlaneFailures) {
        appendDefinition(resultMeta, "Onboarding control plane", failure);
      }
    }
  }
  clear(outcomeGroups);
  appendPathGroup("Imported", result.imported, "success");
  appendPathGroup("Unchanged", result.unchanged, "quiet");
  appendPathGroup("Conflicting", result.conflicting, "warning");
  appendPathGroup("Rejected", result.rejected, "danger");
  renderProject(project);
  resultEmpty.hidden = true;
  resultContent.hidden = false;
  resultTitle.focus();
};

const renderError = (message) => {
  resultBadge.className = "badge rejected";
  resultBadge.textContent = "Request refused";
  resultSummary.textContent = message;
  clear(resultMeta);
  clear(outcomeGroups);
  renderProject(null);
  resultEmpty.hidden = true;
  resultContent.hidden = false;
  resultTitle.focus();
};

// One request to the session's server with its token. An answer that is not
// a success and carries no result is refused with the server's own error, or
// with its status and body when it names none.
const request = async (path, init) => {
  const headers = new Headers(init.headers);
  headers.set("X-Kronika-Token", token);
  const response = await fetch(path, { ...init, headers });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} answered HTTP ${response.status} with a body that is not JSON (${error.message}): ${text}`);
  }
  if (!response.ok && !payload.result) {
    throw new Error(typeof payload.error === "string" ? payload.error : `${path} answered HTTP ${response.status}: ${text}`);
  }
  return payload;
};

const loadSession = async () => {
  if (!token) throw new Error("Open the exact session URL printed by kronika gui; its token fragment is missing.");
  const config = await request("/api/config", { method: "GET" });
  repoPath.textContent = config.repo;
};

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  submitButton.disabled = true;
  formStatus.textContent = "Validating the complete selection…";
  try {
    const documents = lines(form.elements.documents.value);
    const sources = lines(form.elements.sources.value);
    const payload = {
      ...(documents.length ? { documents } : {}),
      ...(sources.length ? { sources } : {}),
      manifestPath: form.elements.manifest.value.trim(),
      instruction: form.elements.instruction.value,
      replace: form.elements.replace.checked,
    };
    const outcome = await request("/api/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    renderResult(outcome);
    formStatus.textContent = outcome.result.accepted
      ? "Project accepted."
      : "Project not changed; review the result.";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    renderError(message);
    formStatus.textContent = "Request refused.";
  } finally {
    submitButton.disabled = false;
  }
});

loadSession().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  repoPath.textContent = "Session unavailable";
  renderError(message);
  formStatus.textContent = "Session unavailable.";
  submitButton.disabled = true;
});
