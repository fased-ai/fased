#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const EXACT_VERSION_RE = /^\d+\.\d+\.\d+$/u;

function fail(message) {
  throw new Error(`dependency integrity: ${message}`);
}

function stableValue(value) {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

function exactVersionParts(value) {
  if (!EXACT_VERSION_RE.test(value ?? "")) {
    fail(`override version ${JSON.stringify(value)} is not an exact stable semantic version`);
  }
  return value.split(".").map(Number);
}

function isHigherVersion(previous, target) {
  const left = exactVersionParts(previous);
  const right = exactVersionParts(target);
  for (let index = 0; index < left.length; index += 1) {
    if (right[index] !== left[index]) {
      return right[index] > left[index];
    }
  }
  return false;
}

function packageOverrides(pkg, label) {
  const overrides = pkg?.pnpm?.overrides;
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    fail(`${label} package does not contain pnpm.overrides`);
  }
  return overrides;
}

function unquote(value) {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith("'") && trimmed.endsWith("'")) ||
      (trimmed.startsWith('"') && trimmed.endsWith('"')))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function parseRootOverrides(lockfile) {
  const lines = lockfile.split(/\r?\n/u);
  const start = lines.findIndex((line) => line === "overrides:");
  if (start < 0) {
    fail("lockfile does not contain root overrides");
  }
  const overrides = {};
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line && !line.startsWith(" ")) {
      break;
    }
    if (!line.trim() || line.trimStart().startsWith("#")) {
      continue;
    }
    const match = /^  (?:(['"])(.*?)\1|([^:]+)):\s+(.+?)\s*$/u.exec(line);
    if (!match) {
      fail(`unsupported root override syntax on line ${index + 1}`);
    }
    const key = match[2] ?? match[3].trim();
    const value = unquote(match[4]);
    if (!key || Object.hasOwn(overrides, key)) {
      fail(`duplicate or empty root override ${JSON.stringify(key)}`);
    }
    overrides[key] = value;
  }
  return overrides;
}

function changedKeys(previous, target) {
  return [...new Set([...Object.keys(previous), ...Object.keys(target)])]
    .filter((key) => previous[key] !== target[key])
    .toSorted((left, right) => left.localeCompare(right));
}

export function verifyDependencyRemediation({
  changedEntries,
  basePackage,
  headPackage,
  baseLockfile,
  headLockfile,
}) {
  if (
    changedEntries.length !== 2 ||
    changedEntries[0] !== "M\tpackage.json" ||
    changedEntries[1] !== "M\tpnpm-lock.yaml"
  ) {
    fail("diff is not exactly modified package.json plus pnpm-lock.yaml");
  }

  const baseOverrides = packageOverrides(basePackage, "base");
  const headOverrides = packageOverrides(headPackage, "head");
  const packageChanges = changedKeys(baseOverrides, headOverrides);
  if (packageChanges.length !== 1) {
    fail("package.json must change exactly one pnpm override");
  }
  const dependency = packageChanges[0];
  const fromVersion = baseOverrides[dependency];
  const toVersion = headOverrides[dependency];
  if (!isHigherVersion(fromVersion, toVersion)) {
    fail("target override is not a higher exact stable semantic version");
  }

  const normalizedHead = structuredClone(headPackage);
  normalizedHead.pnpm.overrides[dependency] = fromVersion;
  if (JSON.stringify(stableValue(basePackage)) !== JSON.stringify(stableValue(normalizedHead))) {
    fail("package.json changes fields outside the one override");
  }

  const baseLockOverrides = parseRootOverrides(baseLockfile);
  const headLockOverrides = parseRootOverrides(headLockfile);
  const lockChanges = changedKeys(baseLockOverrides, headLockOverrides);
  if (
    lockChanges.length !== 1 ||
    lockChanges[0] !== dependency ||
    baseLockOverrides[dependency] !== fromVersion ||
    headLockOverrides[dependency] !== toVersion
  ) {
    fail("lockfile root overrides do not match the one package override transition");
  }

  return Object.freeze({ dependency, fromVersion, toVersion });
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function resolveBase(env) {
  const explicit = env.DEPENDENCY_BASE?.trim();
  if (explicit) {
    return explicit;
  }
  const baseRef = env.GITHUB_BASE_REF?.trim();
  if (baseRef) {
    return git(["merge-base", `origin/${baseRef}`, "HEAD"]).trim();
  }
  const baseSha = env.GITHUB_BASE_SHA?.trim();
  return baseSha || "HEAD^";
}

export function verifyRepositoryDependencyRemediation(env = process.env) {
  const base = resolveBase(env);
  execFileSync("git", ["merge-base", "--is-ancestor", base, "HEAD"], { stdio: "ignore" });
  execFileSync("git", ["diff", "--check", base, "HEAD"], { stdio: "inherit" });
  const changedEntries = git(["diff", "--name-status", "--no-renames", base, "HEAD"])
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .toSorted((left, right) => left.localeCompare(right));
  return verifyDependencyRemediation({
    changedEntries,
    basePackage: JSON.parse(git(["show", `${base}:package.json`])),
    headPackage: JSON.parse(git(["show", "HEAD:package.json"])),
    baseLockfile: git(["show", `${base}:pnpm-lock.yaml`]),
    headLockfile: git(["show", "HEAD:pnpm-lock.yaml"]),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(JSON.stringify(verifyRepositoryDependencyRemediation(), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
