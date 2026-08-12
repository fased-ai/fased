#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const PROFILES = ["protected-local", "hosting"];
const SCENARIOS = ["fresh-install", "managed-update"];
const LEGACY_V1_DIGEST = "sha256:b9ac4c751e0ad3e7455b177cd80538aedcbd8365aeac9eb7c174b72fea4c8ad8";
const commonPredicates = Object.freeze([
  "artifact-identity",
  "public-installer-acquisition",
  "canonical-lifecycle",
  "three-services-active",
  "wallet-status",
  "wallet-signer-doctor",
  "mining-status",
  "network-status",
  "plugin-doctor",
  "restart-health",
  "state-preservation",
  "installer-already-current",
  "updater-already-current",
]);

export const REQUIRED_PREDICATES = Object.freeze(
  Object.fromEntries(
    PROFILES.map((profile) => [
      profile,
      Object.freeze({
        "fresh-install": commonPredicates,
        "managed-update": Object.freeze([
          "artifact-identity",
          "public-installer-acquisition",
          "predecessor-capsule-attestation",
          "rollback-retry",
          ...commonPredicates.slice(2),
        ]),
      }),
    ]),
  ),
);

// Temporary source compatibility for callers being migrated in D8. It is not
// the canonical contract because it lacks the Hosting profile dimension.
export const REQUIRED_SCENARIOS = REQUIRED_PREDICATES["protected-local"];

function fail(message) {
  throw new Error(`lifecycle acceptance contract: ${message}`);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const actual = Object.keys(value).toSorted().join(",");
  if (actual !== [...expected].toSorted((left, right) => left.localeCompare(right)).join(",")) {
    fail(`${label} fields are invalid`);
  }
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

export function digestAcceptanceContract(contract) {
  validateAcceptanceContract(contract);
  return digestStableContract(contract);
}

function digestStableContract(contract) {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(stableValue(contract)))
    .digest("hex")}`;
}

export function digestPublishedAcceptanceContract(contract) {
  validatePublishedAcceptanceContract(contract);
  return digestStableContract(contract);
}

export function validatePublishedAcceptanceContract(contract) {
  if (contract?.schemaVersion === 2) {
    return validateAcceptanceContract(contract);
  }
  exactKeys(contract, ["schemaVersion", "role", "contractId", "scenarios"], "contract");
  if (
    contract.schemaVersion !== 1 ||
    contract.role !== "fased-lifecycle-acceptance-contract" ||
    contract.contractId !== "public-local-lifecycle-v1"
  ) {
    fail("published contract identity is invalid");
  }
  if (digestStableContract(contract) !== LEGACY_V1_DIGEST) {
    fail("published v1 contract digest is invalid");
  }
  return contract;
}

export function validateAcceptanceContract(contract) {
  exactKeys(contract, ["schemaVersion", "role", "contractId", "profiles"], "contract");
  if (
    contract.schemaVersion !== 2 ||
    contract.role !== "fased-lifecycle-acceptance-contract" ||
    contract.contractId !== "public-lifecycle-v2"
  ) {
    fail("identity is invalid");
  }
  exactKeys(contract.profiles, PROFILES, "contract profiles");
  for (const profile of PROFILES) {
    exactKeys(contract.profiles[profile], SCENARIOS, `${profile} scenarios`);
    for (const scenario of SCENARIOS) {
      const actual = contract.profiles[profile][scenario];
      const required = REQUIRED_PREDICATES[profile][scenario];
      if (
        !Array.isArray(actual) ||
        actual.length !== required.length ||
        actual.some((predicate, index) => predicate !== required[index])
      ) {
        fail(`${profile}/${scenario} predicates are incomplete or reordered`);
      }
    }
  }
  return contract;
}

function validateEvidence(evidence, required, version) {
  if (!Array.isArray(evidence) || evidence.length !== required.length) {
    fail("receipt evidence is incomplete");
  }
  for (const [index, record] of evidence.entries()) {
    exactKeys(record, ["id", "status", "evidenceDigest", "summary"], "predicate evidence");
    if (
      record.id !== required[index] ||
      record.status !== "PASS" ||
      !DIGEST_PATTERN.test(record.evidenceDigest || "") ||
      typeof record.summary !== "string" ||
      record.summary.length === 0 ||
      record.summary.length > 240 ||
      /[\r\n]/u.test(record.summary) ||
      record.summary.includes("\0")
    ) {
      fail("predicate evidence is invalid or reordered");
    }
    if (
      (record.id === "installer-already-current" || record.id === "updater-already-current") &&
      record.summary !== `Already current: ${version}`
    ) {
      fail(`${record.id} lacks the literal idempotence result`);
    }
  }
}

export function buildAcceptanceReceipt({
  contract,
  profile,
  scenario,
  version,
  commit,
  candidateDescriptorDigest,
  predecessorCapsuleDigest = null,
  evidence,
}) {
  validateAcceptanceContract(contract);
  const required = REQUIRED_PREDICATES[profile]?.[scenario];
  if (!required) {
    fail("profile or scenario is unsupported");
  }
  if (!VERSION_PATTERN.test(version || "")) {
    fail("receipt version is invalid");
  }
  if (!COMMIT_PATTERN.test(commit || "")) {
    fail("receipt commit is invalid");
  }
  if (!DIGEST_PATTERN.test(candidateDescriptorDigest || "")) {
    fail("candidate descriptor digest is invalid");
  }
  if (
    (scenario === "managed-update" && !DIGEST_PATTERN.test(predecessorCapsuleDigest || "")) ||
    (scenario === "fresh-install" && predecessorCapsuleDigest !== null)
  ) {
    fail("predecessor capsule binding is invalid");
  }
  validateEvidence(evidence, required, version);
  return {
    schemaVersion: 2,
    role: "fased-lifecycle-acceptance-receipt",
    contractId: contract.contractId,
    contractDigest: digestAcceptanceContract(contract),
    profile,
    scenario,
    version,
    commit,
    candidateDescriptorDigest,
    predecessorCapsuleDigest,
    evidence: evidence.map((record) => ({ ...record })),
  };
}

export function verifyAcceptanceReceipt({ contract, receipt, expected = {} }) {
  exactKeys(
    receipt,
    [
      "schemaVersion",
      "role",
      "contractId",
      "contractDigest",
      "profile",
      "scenario",
      "version",
      "commit",
      "candidateDescriptorDigest",
      "predecessorCapsuleDigest",
      "evidence",
    ],
    "receipt",
  );
  const rebuilt = buildAcceptanceReceipt({ contract, ...receipt });
  if (JSON.stringify(receipt) !== JSON.stringify(rebuilt)) {
    fail("receipt identity or contract binding is invalid");
  }
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (expectedValue !== undefined && receipt[key] !== expectedValue) {
      fail(`receipt ${key} mismatch`);
    }
  }
  return receipt;
}

function parseArguments(args) {
  const [command, ...rest] = args;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      fail("arguments must be --name value pairs");
    }
    options[key.slice(2)] = value;
  }
  return { command, options };
}

function readJson(file, label) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail(`${label} is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function main() {
  const { command, options } = parseArguments(process.argv.slice(2));
  const contract = readJson(options.contract, "contract");
  if (command === "validate") {
    validateAcceptanceContract(contract);
    process.stdout.write(
      `${JSON.stringify({ ok: true, digest: digestAcceptanceContract(contract) })}\n`,
    );
    return;
  }
  const receiptOptions = {
    contract,
    profile: options.profile,
    scenario: options.scenario,
    version: options.version,
    commit: options.commit,
    candidateDescriptorDigest: options["candidate-descriptor-digest"],
    predecessorCapsuleDigest: options["predecessor-capsule-digest"] || null,
  };
  if (command === "issue-receipt") {
    const receipt = buildAcceptanceReceipt({
      ...receiptOptions,
      evidence: readJson(options["evidence-file"], "predicate evidence"),
    });
    writeFileSync(options.output, `${JSON.stringify(receipt, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    return;
  }
  if (command === "verify-receipt") {
    const receipt = verifyAcceptanceReceipt({
      contract,
      receipt: readJson(options.receipt, "receipt"),
      expected: receiptOptions,
    });
    process.stdout.write(
      `${JSON.stringify({ ok: true, profile: receipt.profile, scenario: receipt.scenario })}\n`,
    );
    return;
  }
  fail(`unsupported command ${String(command)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
