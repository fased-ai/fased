#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_CONTRACT = path.join(REPO_ROOT, "config", "lifecycle-managed-authority.v1.json");
const CAPABILITY_KEYS = [
  "id",
  "boundary",
  "profiles",
  "owner",
  "implementation",
  "evidence",
  "status",
];
const PROFILE_KEYS = ["id", "support", "platforms", "serviceManager"];
const MANAGED_STATUSES = new Set(["implemented", "partial", "missing"]);

function fail(message) {
  throw new Error(`managed lifecycle authority contract: ${message}`);
}

function exactKeys(value, keys, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value)
      .toSorted((left, right) => left.localeCompare(right))
      .join(",") !== [...keys].toSorted((left, right) => left.localeCompare(right)).join(",")
  ) {
    fail(`${label} fields are invalid`);
  }
}

function uniqueStrings(values, label, { allowEmpty = false } = {}) {
  if (
    !Array.isArray(values) ||
    (!allowEmpty && values.length === 0) ||
    values.some((value) => typeof value !== "string" || value.length === 0) ||
    new Set(values).size !== values.length
  ) {
    fail(`${label} must contain unique non-empty strings`);
  }
}

function verifyRepoPaths(paths, label) {
  for (const relative of paths) {
    if (
      path.isAbsolute(relative) ||
      relative.split("/").some((part) => part === "" || part === "." || part === "..") ||
      !existsSync(path.join(REPO_ROOT, relative))
    ) {
      fail(`${label} references missing or unsafe path ${relative}`);
    }
  }
}

export function validateManagedAuthorityContract(contract, { release = false } = {}) {
  exactKeys(
    contract,
    ["schemaVersion", "role", "releaseRule", "profiles", "capabilities"],
    "top level",
  );
  if (
    contract.schemaVersion !== 1 ||
    contract.role !== "fased-managed-lifecycle-authority" ||
    contract.releaseRule !== "every-required-capability-must-be-implemented-and-proven"
  ) {
    fail("identity is invalid");
  }

  if (!Array.isArray(contract.profiles) || contract.profiles.length === 0) {
    fail("profiles are empty");
  }
  const profiles = new Map();
  let retainedProfileCount = 0;
  for (const profile of contract.profiles) {
    exactKeys(profile, PROFILE_KEYS, `profile ${String(profile?.id)}`);
    if (
      typeof profile.id !== "string" ||
      profiles.has(profile.id) ||
      !["retained", "deferred"].includes(profile.support) ||
      typeof profile.serviceManager !== "string"
    ) {
      fail(`profile ${String(profile.id)} is invalid`);
    }
    uniqueStrings(profile.platforms, `profile ${profile.id} platforms`);
    profiles.set(profile.id, profile.support);
    if (profile.support === "retained") {
      retainedProfileCount += 1;
    }
  }

  if (!Array.isArray(contract.capabilities) || contract.capabilities.length === 0) {
    fail("capabilities are empty");
  }
  const capabilities = new Set();
  const blockers = [];
  for (const capability of contract.capabilities) {
    exactKeys(capability, CAPABILITY_KEYS, `capability ${String(capability?.id)}`);
    if (
      typeof capability.id !== "string" ||
      capabilities.has(capability.id) ||
      typeof capability.owner !== "string" ||
      capability.owner.length === 0
    ) {
      fail(`capability ${String(capability.id)} identity is invalid`);
    }
    capabilities.add(capability.id);
    uniqueStrings(capability.profiles, `capability ${capability.id} profiles`);
    for (const profile of capability.profiles) {
      if (profile !== "*" && profile !== "developer-source" && !profiles.has(profile)) {
        fail(`capability ${capability.id} references unknown profile ${profile}`);
      }
    }
    uniqueStrings(capability.implementation, `capability ${capability.id} implementation`, {
      allowEmpty: true,
    });
    uniqueStrings(capability.evidence, `capability ${capability.id} evidence`, {
      allowEmpty: true,
    });

    if (capability.boundary === "managed") {
      if (!MANAGED_STATUSES.has(capability.status)) {
        fail(`managed capability ${capability.id} has invalid status ${capability.status}`);
      }
      if (capability.status === "implemented") {
        if (capability.implementation.length === 0 || capability.evidence.length === 0) {
          fail(`implemented managed capability ${capability.id} lacks code or evidence`);
        }
        verifyRepoPaths(capability.implementation, `capability ${capability.id} implementation`);
        verifyRepoPaths(capability.evidence, `capability ${capability.id} evidence`);
      } else if (
        capability.profiles.includes("*") ||
        capability.profiles.some((profile) => profiles.get(profile) === "retained")
      ) {
        blockers.push(capability.id);
      }
    } else if (
      !["application", "separate-unprivileged"].includes(capability.boundary) ||
      capability.status !== "separate"
    ) {
      fail(`non-managed capability ${capability.id} has an invalid boundary or status`);
    } else {
      verifyRepoPaths(capability.implementation, `capability ${capability.id} implementation`);
      verifyRepoPaths(capability.evidence, `capability ${capability.id} evidence`);
    }
  }
  if (release && blockers.length > 0) {
    fail(`release blockers: ${blockers.join(", ")}`);
  }
  return Object.freeze({
    profileCount: profiles.size,
    retainedProfileCount,
    deferredProfileCount: profiles.size - retainedProfileCount,
    capabilityCount: capabilities.size,
    blockers,
  });
}

export function loadManagedAuthorityContract(file = DEFAULT_CONTRACT, options) {
  return validateManagedAuthorityContract(JSON.parse(readFileSync(file, "utf8")), options);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const release = process.argv.slice(2).includes("--verify-release");
  const result = loadManagedAuthorityContract(DEFAULT_CONTRACT, { release });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

export const __testing = { DEFAULT_CONTRACT };
