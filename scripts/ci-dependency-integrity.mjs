#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const EXACT_VERSION_RE = /^\d+\.\d+\.\d+$/u;

const ADVISORY_REMEDIATIONS = Object.freeze({
  "fast-uri": Object.freeze({ from: "3.1.4", to: "3.1.5" }),
  "ip-address": Object.freeze({ from: "10.2.0", to: "10.3.1" }),
  nanoid: Object.freeze({ from: null, to: "3.3.17" }),
  "undici@7": Object.freeze({ from: "7.28.0", to: "7.29.0" }),
  "undici@8": Object.freeze({ from: null, to: "8.9.0" }),
});

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
  baseZaloPackage,
  headZaloPackage,
}) {
  const baseOverrides = packageOverrides(basePackage, "base");
  const headOverrides = packageOverrides(headPackage, "head");
  const packageChanges = changedKeys(baseOverrides, headOverrides);
  if (packageChanges.length < 1 || packageChanges.length > 4) {
    fail("package.json must change between one and four named advisory overrides");
  }

  const remediations = packageChanges.map((dependency) => {
    const allowed = ADVISORY_REMEDIATIONS[dependency];
    if (!allowed) {
      fail(`override ${dependency} is outside the named advisory set`);
    }
    const fromVersion = baseOverrides[dependency] ?? null;
    const toVersion = headOverrides[dependency];
    if (fromVersion !== allowed.from || toVersion !== allowed.to) {
      fail(`override transition for ${dependency} is not authorized`);
    }
    if (fromVersion !== null && !isHigherVersion(fromVersion, toVersion)) {
      fail(`target override for ${dependency} is not a higher exact stable semantic version`);
    }
    exactVersionParts(toVersion);
    return { dependency, fromVersion, toVersion };
  });

  const expectedPaths = packageChanges.includes("undici@7")
    ? ["M\textensions/zalo/package.json", "M\tpackage.json", "M\tpnpm-lock.yaml"]
    : ["M\tpackage.json", "M\tpnpm-lock.yaml"];
  if (JSON.stringify(changedEntries) !== JSON.stringify(expectedPaths)) {
    fail("diff is outside the exact advisory manifest set");
  }

  const normalizedBase = structuredClone(basePackage);
  for (const remediation of remediations) {
    normalizedBase.pnpm.overrides[remediation.dependency] = remediation.toVersion;
  }
  if (packageChanges.includes("undici@7")) {
    if (
      basePackage.dependencies?.undici !== "7.28.0" ||
      headPackage.dependencies?.undici !== "7.29.0"
    ) {
      fail("root undici dependency is not aligned with the undici@7 remediation");
    }
    normalizedBase.dependencies.undici = "7.29.0";
  }
  if (packageChanges.includes("undici@8")) {
    if (basePackage.engines?.node !== ">=22.14.0" || headPackage.engines?.node !== ">=22.19.0") {
      fail("Node engine floor is not aligned with the undici@8 remediation");
    }
    normalizedBase.engines.node = ">=22.19.0";
  }
  if (JSON.stringify(stableValue(normalizedBase)) !== JSON.stringify(stableValue(headPackage))) {
    fail("package.json changes fields outside the named advisory remediation");
  }

  if (packageChanges.includes("undici@7")) {
    const normalizedBaseZalo = structuredClone(baseZaloPackage);
    if (
      baseZaloPackage?.dependencies?.undici !== "7.28.0" ||
      headZaloPackage?.dependencies?.undici !== "7.29.0"
    ) {
      fail("Zalo undici dependency is not aligned with the undici@7 remediation");
    }
    normalizedBaseZalo.dependencies.undici = "7.29.0";
    if (
      JSON.stringify(stableValue(normalizedBaseZalo)) !==
      JSON.stringify(stableValue(headZaloPackage))
    ) {
      fail("Zalo package changes fields outside the undici advisory remediation");
    }
  }

  const baseLockOverrides = parseRootOverrides(baseLockfile);
  const headLockOverrides = parseRootOverrides(headLockfile);
  const lockChanges = changedKeys(baseLockOverrides, headLockOverrides);
  if (JSON.stringify(lockChanges) !== JSON.stringify(packageChanges)) {
    fail("lockfile root override changes do not match package.json");
  }
  for (const remediation of remediations) {
    if (
      (baseLockOverrides[remediation.dependency] ?? null) !== remediation.fromVersion ||
      headLockOverrides[remediation.dependency] !== remediation.toVersion
    ) {
      fail(`lockfile root override does not match ${remediation.dependency}`);
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
  return verifyDependencyRemediation({
    changedEntries,
    basePackage: JSON.parse(git(["show", `${base}:package.json`])),
    headPackage: JSON.parse(git(["show", "HEAD:package.json"])),
    baseLockfile: git(["show", `${base}:pnpm-lock.yaml`]),
    headLockfile: git(["show", "HEAD:pnpm-lock.yaml"]),
    baseZaloPackage: changedEntries.includes("M\textensions/zalo/package.json")
      ? JSON.parse(git(["show", `${base}:extensions/zalo/package.json`]))
      : undefined,
    headZaloPackage: changedEntries.includes("M\textensions/zalo/package.json")
      ? JSON.parse(git(["show", "HEAD:extensions/zalo/package.json"]))
      : undefined,
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
