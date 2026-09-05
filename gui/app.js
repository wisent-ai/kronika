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

const token = new URLSearchParams(window.location.hash.slice(1)).get("token") || "";

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
  if (entries.length === 0) {
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

const renderProject = (project) => {
  clear(projectDocuments);
  if (!project) {
    projectState.hidden = true;
    return;
  }
  projectState.hidden = false;
  projectSchema.textContent = `Schema version ${project.schemaVersion}; ${project.documents.length} accepted document${project.documents.length === 1 ? "" : "s"}.`;
  project.documents.forEach((documentEntry, index) => {
    const article = document.createElement("article");
    article.className = "project-document";
    const heading = document.createElement("h4");
    heading.textContent = `${index + 1}. ${documentEntry.output}`;
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
    projectDocuments.append(article);
  });
};

const renderResult = ({ result, project }) => {
  const labels = {
    imported: "Imported",
    unchanged: "Unchanged",
    conflicting: "Conflict",
    rejected: "Rejected",
  };
  resultBadge.className = `badge ${result.status}`;
  resultBadge.textContent = labels[result.status] || result.status;
  resultSummary.textContent = result.status === "imported"
    ? "Kronika atomically persisted the project and read the accepted manifest back."
    : result.status === "unchanged"
      ? "The retained project is identical. No file was rewritten."
      : result.status === "conflicting"
        ? "A different project already exists. It was preserved; review it before choosing replace."
        : "Kronika refused the selection before accepting a project.";
  clear(resultMeta);
  appendDefinition(resultMeta, "Repository", result.repo);
  appendDefinition(resultMeta, "Manifest", result.manifestPath);
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

const request = async (path, options = {}) => {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.headers || {}),
      "X-Kronika-Token": token,
    },
  });
  const payload = await response.json();
  if (!response.ok && !payload.result) throw new Error(payload.error || `Request failed with HTTP ${response.status}`);
  return payload;
};

const loadSession = async () => {
  if (!token) throw new Error("Open the exact session URL printed by kronika gui; its token fragment is missing.");
  const config = await request("/api/config");
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
    formStatus.textContent = outcome.result.status === "imported" || outcome.result.status === "unchanged"
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
