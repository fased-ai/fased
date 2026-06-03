import { spawnSync } from "node:child_process";
import fs from "node:fs";
import module from "node:module";
import path from "node:path";
import process from "node:process";

const defaultRequire = module.createRequire(import.meta.url);

export const parseNodeVersion = (version) => {
  const match = String(version ?? "").match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return null;
  }
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
  };
};

export const nodeVersionAllowed = (version) => {
  const parsed = parseNodeVersion(version);
  if (!parsed) {
    return false;
  }
  if (parsed.major > 22) {
    return true;
  }
  return parsed.major === 22 && parsed.minor >= 14;
};

export const currentNodeCanRunFased = ({
  nodeVersion = process.versions?.node,
  requireFn = defaultRequire,
} = {}) => {
  if (!nodeVersionAllowed(nodeVersion)) {
    return false;
  }
  try {
    requireFn("node:sqlite");
    return true;
  } catch {
    return false;
  }
};

export const nodeCandidateCanRunFased = (candidate, { spawnSyncImpl = spawnSync } = {}) => {
  const probe = [
    "const v=process.versions.node.split('.').map(Number);",
    "if (!(v[0] > 22 || (v[0] === 22 && v[1] >= 14))) process.exit(1);",
    "require('node:sqlite');",
  ].join("");
  const result = spawnSyncImpl(candidate, ["-e", probe], { stdio: "ignore" });
  return result.status === 0;
};

export const compareNodeVersionDesc = (a, b) => {
  const av = parseNodeVersion(a) ?? { major: 0, minor: 0, patch: 0 };
  const bv = parseNodeVersion(b) ?? { major: 0, minor: 0, patch: 0 };
  return bv.major - av.major || bv.minor - av.minor || bv.patch - av.patch;
};

export const collectNvmNodeCandidates = ({
  env = process.env,
  fsImpl = fs,
  pathImpl = path,
} = {}) => {
  const versionsDir = env.HOME ? pathImpl.join(env.HOME, ".nvm", "versions", "node") : "";
  if (!versionsDir) {
    return [];
  }
  let entries = [];
  try {
    entries = fsImpl.readdirSync(versionsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && parseNodeVersion(entry.name))
    .map((entry) => entry.name)
    .toSorted(compareNodeVersionDesc)
    .map((versionDir) => pathImpl.join(versionsDir, versionDir, "bin", "node"));
};

export const uniqueNodeCandidates = ({
  env = process.env,
  execPath = process.execPath,
  fsImpl = fs,
  pathImpl = path,
} = {}) => {
  const candidates = [
    env.FASED_NODE,
    ...collectNvmNodeCandidates({ env, fsImpl, pathImpl }),
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/usr/bin/node",
  ].filter((candidate) => typeof candidate === "string" && candidate.trim());
  const seen = new Set();
  const out = [];
  for (const candidate of candidates) {
    const normalized = pathImpl.resolve(candidate);
    if (normalized === execPath || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    if (fsImpl.existsSync(normalized)) {
      out.push(normalized);
    }
  }
  return out;
};

export const reexecWithSupportedNodeIfNeeded = ({
  argv = process.argv,
  env = process.env,
  execPath = process.execPath,
  exit = (code) => process.exit(code),
  fsImpl = fs,
  nodeVersion = process.versions?.node,
  pathImpl = path,
  requireFn = defaultRequire,
  selfPath,
  spawnSyncImpl = spawnSync,
} = {}) => {
  if (env.FASED_RUNTIME_REEXEC === "1" || currentNodeCanRunFased({ nodeVersion, requireFn })) {
    return;
  }
  for (const candidate of uniqueNodeCandidates({ env, execPath, fsImpl, pathImpl })) {
    if (!nodeCandidateCanRunFased(candidate, { spawnSyncImpl })) {
      continue;
    }
    const result = spawnSyncImpl(candidate, [selfPath, ...argv.slice(2)], {
      stdio: "inherit",
      env: { ...env, FASED_RUNTIME_REEXEC: "1" },
    });
    if (result.error) {
      continue;
    }
    exit(result.status ?? 1);
  }
};
