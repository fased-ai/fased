#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const VERSION_SPEC_RE = /^(?<prefix>[~^]?)(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)$/u;
const DEPENDENCY_FIELDS = Object.freeze([
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
]);

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

function versionSpec(value, label) {
  const match = VERSION_SPEC_RE.exec(value ?? "");
  if (!match?.groups) {
    fail(`${label} ${JSON.stringify(value)} is not a bounded stable semantic version`);
  }
  return {
    prefix: match.groups.prefix,
    parts: [match.groups.major, match.groups.minor, match.groups.patch].map(Number),
  };
}

function isHigherVersion(previous, target, label) {
  const left = versionSpec(previous, `${label} previous version`);
  const right = versionSpec(target, `${label} target version`);
  if (left.prefix !== right.prefix) {
    fail(`${label} changes its version-range prefix`);
  }
  for (let index = 0; index < left.parts.length; index += 1) {
    if (right.parts[index] !== left.parts[index]) {
      return right.parts[index] > left.parts[index];
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

function dependencyName(key, override = false) {
  if (!override) {
    return key;
  }
  if (key.startsWith("@")) {
    const separator = key.indexOf("@", key.indexOf("/") + 1);
    return separator > 0 ? key.slice(0, separator) : key;
  }
  const separator = key.indexOf("@");
  return separator > 0 ? key.slice(0, separator) : key;
}

function recordVersionChange(
  remediations,
  { dependency, field, fromVersion, manifest, toVersion },
) {
  if (fromVersion === undefined) {
    versionSpec(toVersion, `${manifest} ${field}.${dependency}`);
  } else if (!isHigherVersion(fromVersion, toVersion, `${manifest} ${field}.${dependency}`)) {
    fail(`${manifest} ${field}.${dependency} is not a version increase`);
  }
  remediations.push({ dependency, field, fromVersion: fromVersion ?? null, manifest, toVersion });
}

function verifyManifest(path, baseManifest, headManifest, remediations) {
  const normalized = structuredClone(baseManifest);
  for (const field of DEPENDENCY_FIELDS) {
    const baseDependencies = baseManifest[field] ?? {};
    const headDependencies = headManifest[field] ?? {};
    for (const key of changedKeys(baseDependencies, headDependencies)) {
      const toVersion = headDependencies[key];
      if (typeof toVersion !== "string") {
        fail(`${path} removes ${field}.${key}`);
      }
      recordVersionChange(remediations, {
        dependency: key,
        field,
        fromVersion: baseDependencies[key],
        manifest: path,
        toVersion,
      });
      normalized[field] = { ...normalized[field], [key]: toVersion };
    }
  }

  if (path === "package.json") {
    const baseOverrides = packageOverrides(baseManifest, "base");
    const headOverrides = packageOverrides(headManifest, "head");
    for (const key of changedKeys(baseOverrides, headOverrides)) {
      const toVersion = headOverrides[key];
      if (typeof toVersion !== "string") {
        fail(`package.json removes pnpm.overrides.${key}`);
      }
      recordVersionChange(remediations, {
        dependency: dependencyName(key, true),
        field: `pnpm.overrides.${key}`,
        fromVersion: baseOverrides[key],
        manifest: path,
        toVersion,
      });
      normalized.pnpm.overrides[key] = toVersion;
    }
  }

  if (JSON.stringify(stableValue(normalized)) !== JSON.stringify(stableValue(headManifest))) {
    fail(`${path} changes fields outside dependency versions and root overrides`);
  }
}

export function verifyDependencyRemediation({
  changedEntries,
  baseManifests,
  headManifests,
  baseLockfile,
  headLockfile,
}) {
  const manifestPaths = Object.keys(headManifests).toSorted((left, right) =>
    left.localeCompare(right),
  );
  if (manifestPaths.length < 1 || manifestPaths.length > 8) {
    fail("change must contain between one and eight existing package manifests");
  }
  const expectedPaths = [
    ...manifestPaths.map((path) => `M\t${path}`),
    "M\tpnpm-lock.yaml",
  ].toSorted((left, right) => left.localeCompare(right));
  if (JSON.stringify(changedEntries) !== JSON.stringify(expectedPaths)) {
    fail("diff is outside package manifests plus the exact pnpm lockfile");
  }

  if (baseLockfile === headLockfile) {
    fail("pnpm-lock.yaml does not change");
  }
  const remediations = [];
  for (const path of manifestPaths) {
    if (!baseManifests[path] || !headManifests[path]) {
      fail(`${path} is not present on both sides of the change`);
    }
    verifyManifest(path, baseManifests[path], headManifests[path], remediations);
  }
  if (remediations.length < 1 || remediations.length > 24) {
    fail("change must contain between one and twenty-four dependency version increases");
  }

  if (headManifests["package.json"]) {
    const baseOverrides = packageOverrides(baseManifests["package.json"], "base");
    const headOverrides = packageOverrides(headManifests["package.json"], "head");
    const baseLockOverrides = parseRootOverrides(baseLockfile);
    const headLockOverrides = parseRootOverrides(headLockfile);
    for (const key of changedKeys(baseOverrides, headOverrides)) {
      if (
        baseLockOverrides[key] !== baseOverrides[key] ||
        headLockOverrides[key] !== headOverrides[key]
      ) {
        fail(`lockfile root override does not match package.json pnpm.overrides.${key}`);
      }
    }
  }

  return Object.freeze({ remediations });
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
  const manifestPaths = changedEntries
    .map((entry) => /^M\t(?<path>(?:.+\/)?package\.json)$/u.exec(entry)?.groups?.path)
    .filter(Boolean)
    .toSorted((left, right) => left.localeCompare(right));
  const baseManifests = Object.fromEntries(
    manifestPaths.map((path) => [path, JSON.parse(git(["show", `${base}:${path}`]))]),
  );
  const headManifests = Object.fromEntries(
    manifestPaths.map((path) => [path, JSON.parse(git(["show", `HEAD:${path}`]))]),
  );
  return verifyDependencyRemediation({
    changedEntries,
    baseManifests,
    headManifests,
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
