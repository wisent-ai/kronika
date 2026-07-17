import { execFileSync } from "node:child_process";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { basename, extname, relative, resolve, sep } from "node:path";

import type {
  SkippedSource,
  SourceCollection,
  SourceDocument,
  SourceOptions,
} from "./types.js";

const AUTOMATIC_TEXT_EXTENSIONS: Record<string, true> = {
  ".c": true,
  ".cc": true,
  ".cpp": true,
  ".css": true,
  ".go": true,
  ".graphql": true,
  ".h": true,
  ".html": true,
  ".java": true,
  ".js": true,
  ".json": true,
  ".jsx": true,
  ".kt": true,
  ".md": true,
  ".mdx": true,
  ".mjs": true,
  ".php": true,
  ".proto": true,
  ".py": true,
  ".rb": true,
  ".rs": true,
  ".sh": true,
  ".sql": true,
  ".swift": true,
  ".toml": true,
  ".ts": true,
  ".tsx": true,
  ".txt": true,
  ".xml": true,
  ".yaml": true,
  ".yml": true,
};

const AUTOMATIC_FILENAMES: Record<string, true> = {
  "Dockerfile": true,
  "Makefile": true,
  "Procfile": true,
  "README": true,
};

const EXCLUDED_DIRECTORIES: Record<string, true> = {
  ".git": true,
  ".next": true,
  ".turbo": true,
  ".vercel": true,
  ".venv": true,
  "build": true,
  "coverage": true,
  "dist": true,
  "node_modules": true,
  "recordings": true,
  "target": true,
  "vendor": true,
};

const EXCLUDED_FILENAMES: Record<string, true> = {
  ".netrc": true,
  ".npmrc": true,
  "Cargo.lock": true,
  "auth.json": true,
  "bun.lock": true,
  "bun.lockb": true,
  "credentials.json": true,
  "id_dsa": true,
  "id_ed25519": true,
  "id_rsa": true,
  "package-lock.json": true,
  "pnpm-lock.yaml": true,
  "secrets.json": true,
  "yarn.lock": true,
};

const isInsideRepository = (repo: string, candidate: string): boolean => {
  const pathFromRepo = relative(repo, candidate);
  return pathFromRepo === "" || (
    pathFromRepo !== ".." &&
    !pathFromRepo.startsWith(`..${sep}`) &&
    !pathFromRepo.startsWith(sep)
  );
};

const sensitiveReason = (relativePath: string): string | undefined => {
  const segments = relativePath.split(/[\\/]/);
  if (segments.some((segment) => EXCLUDED_DIRECTORIES[segment])) {
    return "generated, dependency, recording, or private deployment directory";
  }

  const name = basename(relativePath);
  const lowerName = name.toLowerCase();
  if (EXCLUDED_FILENAMES[name] || lowerName === ".env" || lowerName.startsWith(".env.")) {
    return "credential or generated lock file";
  }
  if ([".key", ".p12", ".pfx", ".pem"].includes(extname(lowerName))) {
    return "private key or certificate material";
  }
  return undefined;
};

const walkDirectory = (directory: string, paths: string[]): void => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRECTORIES[entry.name]) walkDirectory(fullPath, paths);
      continue;
    }
    if (entry.isFile()) paths.push(fullPath);
  }
};

const repositoryPaths = (repo: string): string[] => {
  try {
    const output = execFileSync(
      "git",
      ["-C", repo, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return output
      .split("\0")
      .filter(Boolean)
      .map((path) => resolve(repo, path));
  } catch {
    const paths: string[] = [];
    walkDirectory(repo, paths);
    return paths;
  }
};

const selectedPaths = (repo: string, selections: string[]): string[] => {
  const paths: string[] = [];
  for (const selection of selections) {
    const candidate = resolve(repo, selection);
    if (!isInsideRepository(repo, candidate)) {
      throw new Error(`Source is outside the repository: ${selection}`);
    }

    let metadata;
    try {
      metadata = lstatSync(candidate);
    } catch {
      throw new Error(`Source does not exist: ${selection}`);
    }
    if (metadata.isSymbolicLink()) {
      throw new Error(`Symbolic-link sources are not allowed: ${selection}`);
    }
    if (metadata.isDirectory()) walkDirectory(candidate, paths);
    else if (metadata.isFile()) paths.push(candidate);
  }
  return paths;
};

const automaticSource = (path: string): boolean => {
  const name = basename(path);
  if (AUTOMATIC_FILENAMES[name] || name.startsWith("README.")) return true;
  return Boolean(AUTOMATIC_TEXT_EXTENSIONS[extname(name).toLowerCase()]);
};

const priority = (relativePath: string, output: string): number => {
  if (relativePath === output) return 0;
  const lower = relativePath.toLowerCase();
  if (lower === "readme.md" || lower.startsWith("docs/")) return 1;
  if (["package.json", "pyproject.toml", "cargo.toml", "go.mod"].includes(lower)) return 2;
  if (lower.includes("config") || lower.includes("schema")) return 3;
  if (lower.startsWith("src/") || lower.startsWith("app/")) return 4;
  if (lower.includes("test")) return 6;
  return 5;
};

export const collectSources = (options: SourceOptions): SourceCollection => {
  const repo = resolve(options.repo);
  if (!statSync(repo).isDirectory()) throw new Error(`Repository is not a directory: ${repo}`);
  if (options.maxInputBytes <= 0 || options.maxFileBytes <= 0) {
    throw new Error("Source byte limits must be positive");
  }

  const explicit = Boolean(options.sources?.length);
  const candidates = explicit
    ? selectedPaths(repo, options.sources ?? [])
    : repositoryPaths(repo);
  const outputRelative = relative(repo, resolve(repo, options.output)).split(sep).join("/");
  if (outputRelative.startsWith("../") || outputRelative === "..") {
    throw new Error(`Output is outside the repository: ${options.output}`);
  }

  const normalized = [...new Set(candidates)]
    .filter((path) => isInsideRepository(repo, path))
    .map((path) => ({
      fullPath: path,
      relativePath: relative(repo, path).split(sep).join("/"),
    }))
    .sort((left, right) => {
      const rank = priority(left.relativePath, outputRelative) - priority(right.relativePath, outputRelative);
      return rank || left.relativePath.localeCompare(right.relativePath);
    });

  const documents: SourceDocument[] = [];
  const skipped: SkippedSource[] = [];
  let totalBytes = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });

  for (const candidate of normalized) {
    const exclusion = sensitiveReason(candidate.relativePath);
    if (exclusion) {
      skipped.push({ path: candidate.relativePath, reason: exclusion });
      continue;
    }
    if (!explicit && !automaticSource(candidate.relativePath)) continue;

    const metadata = lstatSync(candidate.fullPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
    if (metadata.size > options.maxFileBytes) {
      skipped.push({ path: candidate.relativePath, reason: `larger than ${options.maxFileBytes} bytes` });
      continue;
    }
    if (totalBytes + metadata.size > options.maxInputBytes) {
      skipped.push({ path: candidate.relativePath, reason: `total source limit ${options.maxInputBytes} bytes reached` });
      continue;
    }

    const bytes = readFileSync(candidate.fullPath);
    if (bytes.includes(0)) {
      skipped.push({ path: candidate.relativePath, reason: "binary content" });
      continue;
    }

    let content: string;
    try {
      content = decoder.decode(bytes);
    } catch {
      skipped.push({ path: candidate.relativePath, reason: "not valid UTF-8 text" });
      continue;
    }
    if (!content.trim()) continue;

    documents.push({ path: candidate.relativePath, content, bytes: metadata.size });
    totalBytes += metadata.size;
  }

  return { documents, skipped, totalBytes };
};
