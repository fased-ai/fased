import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { resolveGitHeadPath } from "./git-root.js";

const formatCommit = (value?: string | null) => {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.length > 7 ? trimmed.slice(0, 7) : trimmed;
};

let cachedCommit: string | null | undefined;

const readCommitFromPackageJson = () => {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../../package.json") as {
      gitHead?: string;
      githead?: string;
    };
    return formatCommit(pkg.gitHead ?? pkg.githead ?? null);
  } catch {
    return null;
  }
};

const readCommitFromBuildInfo = () => {
  try {
    const require = createRequire(import.meta.url);
    const candidates = ["../build-info.json", "./build-info.json"];
    for (const candidate of candidates) {
      try {
        const info = require(candidate) as {
          commit?: string | null;
        };
        const formatted = formatCommit(info.commit ?? null);
        if (formatted) {
          return formatted;
        }
      } catch {
        // ignore missing candidate
      }
    }
    return null;
  } catch {
    return null;
  }
};

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function resolveGitRefsBase(headPath: string): string {
  const gitDir = path.dirname(headPath);
  try {
    const commonDirRaw = fs.readFileSync(path.join(gitDir, "commondir"), "utf-8").trim();
    if (!commonDirRaw) {
      return gitDir;
    }
    return path.resolve(gitDir, commonDirRaw);
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error;
    }
    return gitDir;
  }
}

function resolveRefPath(refsBase: string, ref: string): string | null {
  if (!ref.startsWith("refs/")) {
    return null;
  }
  if (path.isAbsolute(ref)) {
    return null;
  }
  if (ref.split(/[/\\]/).includes("..")) {
    return null;
  }
  const resolved = path.resolve(refsBase, ref);
  const rel = path.relative(refsBase, resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    return null;
  }
  return resolved;
}

function readCommitFromPackedRefs(refsBase: string, ref: string): string | null {
  try {
    const packedRefs = fs.readFileSync(path.join(refsBase, "packed-refs"), "utf-8");
    for (const line of packedRefs.split("\n")) {
      if (!line || line.startsWith("#") || line.startsWith("^")) {
        continue;
      }
      const [commit, packedRef] = line.trim().split(/\s+/, 2);
      if (packedRef === ref) {
        return formatCommit(commit);
      }
    }
    return null;
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error;
    }
    return null;
  }
}

export const resolveCommitHash = (options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) => {
  if (cachedCommit !== undefined) {
    return cachedCommit;
  }
  const env = options.env ?? process.env;
  const envCommit = env.GIT_COMMIT?.trim() || env.GIT_SHA?.trim();
  const normalized = formatCommit(envCommit);
  if (normalized) {
    cachedCommit = normalized;
    return cachedCommit;
  }
  const buildInfoCommit = readCommitFromBuildInfo();
  if (buildInfoCommit) {
    cachedCommit = buildInfoCommit;
    return cachedCommit;
  }
  const pkgCommit = readCommitFromPackageJson();
  if (pkgCommit) {
    cachedCommit = pkgCommit;
    return cachedCommit;
  }
  try {
    const headPath = resolveGitHeadPath(options.cwd ?? process.cwd());
    if (!headPath) {
      cachedCommit = null;
      return cachedCommit;
    }
    const head = fs.readFileSync(headPath, "utf-8").trim();
    if (!head) {
      cachedCommit = null;
      return cachedCommit;
    }
    if (head.startsWith("ref:")) {
      const ref = head.replace(/^ref:\s*/i, "").trim();
      const refsBase = resolveGitRefsBase(headPath);
      const refPath = resolveRefPath(refsBase, ref);
      if (!refPath) {
        cachedCommit = null;
        return cachedCommit;
      }
      try {
        const refHash = fs.readFileSync(refPath, "utf-8").trim();
        cachedCommit = formatCommit(refHash);
        return cachedCommit;
      } catch (error) {
        if (!isMissingPathError(error)) {
          throw error;
        }
      }
      const refHash = readCommitFromPackedRefs(refsBase, ref);
      cachedCommit = formatCommit(refHash);
      return cachedCommit;
    }
    cachedCommit = formatCommit(head);
    return cachedCommit;
  } catch {
    cachedCommit = null;
    return cachedCommit;
  }
};
