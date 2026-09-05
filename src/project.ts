import { randomUUID } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

import { loadSyncManifest, type SyncManifest } from "./sync.js";

export type InitializeWorkspaceOptions = {
  repo: string;
  manifestPath: string;
  documents?: string[];
  sources?: string[];
  instruction?: string;
  replace?: boolean;
};

export type InitializeWorkspaceResult = {
  status: "imported" | "unchanged" | "conflicting" | "rejected";
  repo: string;
  manifestPath: string;
  imported: string[];
  unchanged: string[];
  conflicting: Array<{ path: string; reason: string }>;
  rejected: Array<{ path: string; reason: string }>;
};

const isInside = (root: string, candidate: string): boolean => {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (
    pathFromRoot !== ".." &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    !pathFromRoot.startsWith(sep)
  );
};

const repositoryPath = (root: string, input: string, label: string): string => {
  const candidate = resolve(root, input);
  if (!isInside(root, candidate)) throw new Error(`${label} is outside the repository: ${input}`);
  if (!existsSync(candidate)) throw new Error(`${label} does not exist: ${input}`);
  const metadata = lstatSync(candidate);
  if (metadata.isSymbolicLink()) throw new Error(`${label} cannot be a symbolic link: ${input}`);
  if (!metadata.isFile() && !metadata.isDirectory()) {
    throw new Error(`${label} must be a regular file or directory: ${input}`);
  }
  accessSync(candidate, constants.R_OK);
  const resolved = realpathSync(candidate);
  if (!isInside(root, resolved)) throw new Error(`${label} resolves outside the repository: ${input}`);
  return resolved;
};

const relativePath = (root: string, candidate: string): string =>
  relative(root, candidate).split(sep).join("/") || ".";

const collectMarkdown = (root: string, candidate: string, paths: Set<string>): void => {
  const metadata = lstatSync(candidate);
  if (metadata.isSymbolicLink()) throw new Error(`Documentation source cannot contain a symbolic link: ${relativePath(root, candidate)}`);
  if (metadata.isFile()) {
    if (!candidate.toLowerCase().endsWith(".md")) {
      throw new Error(`Documentation source is not Markdown: ${relativePath(root, candidate)}`);
    }
    paths.add(relativePath(root, realpathSync(candidate)));
    return;
  }
  if (!metadata.isDirectory()) {
    throw new Error(`Documentation source is not a file or directory: ${relativePath(root, candidate)}`);
  }
  for (const entry of readdirSync(candidate, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const child = resolve(candidate, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Documentation source cannot contain a symbolic link: ${relativePath(root, child)}`);
    if (entry.isDirectory()) collectMarkdown(root, child, paths);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) collectMarkdown(root, child, paths);
  }
};

const existingDefaultDocuments = (root: string): string[] => {
  const candidates = ["README.md", "docs"];
  return candidates.filter((candidate) => existsSync(resolve(root, candidate)));
};

const stableJson = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const writeAtomic = (path: string, content: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, content, { encoding: "utf8", mode: 0o644, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
};

/**
 * Adopt the documentation already present in a repository into Kronika's
 * canonical sync manifest. This operation never calls Brama and never writes a
 * document: the only mutation is one atomically replaced project manifest.
 */
export const initializeDocumentationWorkspace = (
  options: InitializeWorkspaceOptions,
): InitializeWorkspaceResult => {
  const repoCandidate = resolve(options.repo);
  if (!existsSync(repoCandidate) || !lstatSync(repoCandidate).isDirectory()) {
    return {
      status: "rejected",
      repo: repoCandidate,
      manifestPath: resolve(repoCandidate, options.manifestPath),
      imported: [],
      unchanged: [],
      conflicting: [],
      rejected: [{ path: options.repo, reason: "repository does not exist or is not a directory" }],
    };
  }
  const repo = realpathSync(repoCandidate);
  const manifestPath = resolve(repo, options.manifestPath);
  if (!isInside(repo, manifestPath)) {
    return {
      status: "rejected",
      repo,
      manifestPath,
      imported: [],
      unchanged: [],
      conflicting: [],
      rejected: [{ path: options.manifestPath, reason: "manifest is outside the repository" }],
    };
  }

  try {
    const manifestRelative = relative(repo, manifestPath);
    let manifestParent = repo;
    for (const segment of dirname(manifestRelative).split(sep).filter((part) => part && part !== ".")) {
      manifestParent = resolve(manifestParent, segment);
      if (existsSync(manifestParent)) {
        const metadata = lstatSync(manifestParent);
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
          throw new Error(`manifest parent must be a real directory inside the repository: ${relativePath(repo, manifestParent)}`);
        }
      }
    }
    if (existsSync(manifestPath)) {
      const metadata = lstatSync(manifestPath);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new Error(`manifest must be a regular file, not a symbolic link or directory: ${relativePath(repo, manifestPath)}`);
      }
    }

    const selectedDocuments = options.documents?.length
      ? options.documents
      : existingDefaultDocuments(repo);
    if (selectedDocuments.length === 0) {
      throw new Error("no existing README.md or docs directory was found; pass --docs <path>");
    }
    const documents = new Set<string>();
    for (const selection of selectedDocuments) {
      collectMarkdown(repo, repositoryPath(repo, selection, "Documentation source"), documents);
    }
    if (documents.size === 0) throw new Error("documentation selection contains no Markdown documents");

    const sourceSelections = options.sources?.length ? options.sources : ["."];
    const sources = [...new Set(sourceSelections.map((selection) =>
      relativePath(repo, repositoryPath(repo, selection, "Evidence source"))))].sort();
    const instruction = options.instruction?.trim()
      || "Maintain this existing document from its declared repository evidence without changing its purpose.";
    const candidate: SyncManifest = {
      schemaVersion: 1,
      documents: [...documents].sort().map((output) => ({ output, sources, instruction })),
    };

    if (existsSync(manifestPath)) {
      let existing: SyncManifest;
      try {
        existing = loadSyncManifest(manifestPath);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return {
          status: "rejected",
          repo,
          manifestPath,
          imported: [],
          unchanged: [],
          conflicting: [],
          rejected: [{ path: relativePath(repo, manifestPath), reason }],
        };
      }
      if (JSON.stringify(existing) === JSON.stringify(candidate)) {
        return {
          status: "unchanged",
          repo,
          manifestPath,
          imported: [],
          unchanged: candidate.documents.map(({ output }) => output),
          conflicting: [],
          rejected: [],
        };
      }
      if (!options.replace) {
        return {
          status: "conflicting",
          repo,
          manifestPath,
          imported: [],
          unchanged: [],
          conflicting: [{
            path: relativePath(repo, manifestPath),
            reason: "an existing sync manifest declares different documents or evidence; preserve it or pass --replace",
          }],
          rejected: [],
        };
      }
    }

    writeAtomic(manifestPath, stableJson(candidate));
    return {
      status: "imported",
      repo,
      manifestPath,
      imported: candidate.documents.map(({ output }) => output),
      unchanged: [],
      conflicting: [],
      rejected: [],
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      status: "rejected",
      repo,
      manifestPath,
      imported: [],
      unchanged: [],
      conflicting: [],
      rejected: [{ path: options.repo, reason }],
    };
  }
};
