#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const PROFILES = ["protected-local", "hosting"];
const SCENARIOS = ["fresh-install", "managed-update"];
const EVIDENCE_CLASSES = new Set(["PASS", "SUPPORTING"]);
const LEGACY_V1_DIGEST = "sha256:b9ac4c751e0ad3e7455b177cd80538aedcbd8365aeac9eb7c174b72fea4c8ad8";
const LEGACY_V2_DIGEST = "sha256:a1a15e2b080c25921339ed2aa38d05a9745213728866b9f19b48cedc79854197";
const LEGACY_V2_EVIDENCE_POLICY_DIGEST =
  "sha256:327eb515f2ef9980ed17cab1751caa2d792b6f40a849fa9428ab8b3560d83369";
const commonPredicates = Object.freeze([
  "artifact-identity",
  "public-installer-acquisition",
  "lifecycle-performance",
  "canonical-lifecycle",
  "three-services-active",
  "wallet-status",
  "wallet-signer-doctor",
  "mining-status",
  "network-status",
  "plugin-doctor",
  "restart-health",
  "state-preservation",
  "installer-noop-performance",
  "updater-noop-performance",
  "installer-already-current",
  "updater-already-current",
]);
const legacyV2CommonPredicates = Object.freeze(
  commonPredicates.filter(
    (predicate) =>
      !["lifecycle-performance", "installer-noop-performance", "updater-noop-performance"].includes(
        predicate,
      ),
  ),
);

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
const LEGACY_V2_REQUIRED_PREDICATES = Object.freeze(
  Object.fromEntries(
    PROFILES.map((profile) => [
      profile,
      Object.freeze({
        "fresh-install": legacyV2CommonPredicates,
        "managed-update": Object.freeze([
          "artifact-identity",
          "public-installer-acquisition",
          "predecessor-capsule-attestation",
          "rollback-retry",
          ...legacyV2CommonPredicates.slice(2),
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
    if (!Object.hasOwn(contract, "evidencePolicy")) {
      exactKeys(contract, ["schemaVersion", "role", "contractId", "profiles"], "contract");
      if (
        contract.role !== "fased-lifecycle-acceptance-contract" ||
        contract.contractId !== "public-lifecycle-v2" ||
        digestStableContract(contract) !== LEGACY_V2_DIGEST
      ) {
        fail("published v2 contract digest is invalid");
      }
      validateProfiles(contract.profiles, LEGACY_V2_REQUIRED_PREDICATES);
      return contract;
    }
    if (digestStableContract(contract) === LEGACY_V2_EVIDENCE_POLICY_DIGEST) {
      return contract;
    }
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

function validateProfiles(profiles, requiredPredicates = REQUIRED_PREDICATES) {
  exactKeys(profiles, PROFILES, "contract profiles");
  for (const profile of PROFILES) {
    exactKeys(profiles[profile], SCENARIOS, `${profile} scenarios`);
    for (const scenario of SCENARIOS) {
      const actual = profiles[profile][scenario];
      const required = requiredPredicates[profile][scenario];
      if (
        !Array.isArray(actual) ||
        actual.length !== required.length ||
        actual.some((predicate, index) => predicate !== required[index])
      ) {
        fail(`${profile}/${scenario} predicates are incomplete or reordered`);
      }
    }
  }
}

export function validateAcceptanceContract(contract) {
  exactKeys(
    contract,
    ["schemaVersion", "role", "contractId", "evidencePolicy", "profiles"],
    "contract",
  );
  if (
    contract.schemaVersion !== 2 ||
    contract.role !== "fased-lifecycle-acceptance-contract" ||
    contract.contractId !== "public-lifecycle-v2"
  ) {
    fail("identity is invalid");
  }
  exactKeys(contract.evidencePolicy, ["enforcing", "branch", "supporting"], "evidence policy");
  for (const policy of ["enforcing", "branch", "supporting"]) {
    exactKeys(
      contract.evidencePolicy[policy],
      ["evidenceClass", "acquisitionEvidenceClass", "acquisitionMode", "transportSubstituted"],
      `${policy} evidence policy`,
    );
  }
  if (
    JSON.stringify(contract.evidencePolicy) !==
    JSON.stringify({
      enforcing: {
        evidenceClass: "PASS",
        acquisitionEvidenceClass: "PASS",
        acquisitionMode: "immutable-github-release",
        transportSubstituted: false,
      },
      branch: {
        evidenceClass: "PASS",
        acquisitionEvidenceClass: "SUPPORTING",
        acquisitionMode: "substituted-fixture",
        transportSubstituted: true,
      },
      supporting: {
        evidenceClass: "SUPPORTING",
        acquisitionEvidenceClass: "SUPPORTING",
        acquisitionMode: "substituted-fixture",
        transportSubstituted: true,
      },
    })
  ) {
    fail("evidence policy is invalid");
  }
  validateProfiles(contract.profiles);
  return contract;
}

function validateEvidence(evidence, required, version, evidenceClass, acquisitionEvidenceClass) {
  if (!Array.isArray(evidence) || evidence.length !== required.length) {
    fail("receipt evidence is incomplete");
  }
  for (const [index, record] of evidence.entries()) {
    exactKeys(record, ["id", "status", "evidenceDigest", "summary"], "predicate evidence");
    if (
      record.id !== required[index] ||
      record.status !==
        (record.id === "public-installer-acquisition" ? acquisitionEvidenceClass : evidenceClass) ||
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

function selectEvidencePolicy(evidencePolicy, evidenceClass, acquisitionEvidenceClass) {
  return Object.values(evidencePolicy).find(
    (policy) =>
      policy.evidenceClass === evidenceClass &&
      policy.acquisitionEvidenceClass === acquisitionEvidenceClass,
  );
}

function validateAcquisition(
  acquisition,
  version,
  evidenceClass,
  acquisitionEvidenceClass,
  evidencePolicy,
) {
  exactKeys(
    acquisition,
    ["mode", "releaseBaseUrl", "metadataBaseUrl", "transportSubstituted", "trustInventoryDigest"],
    "acquisition",
  );
  const releaseBaseUrl = `https://github.com/fased-ai/fased/releases/download/v${version}`;
  const policy = selectEvidencePolicy(evidencePolicy, evidenceClass, acquisitionEvidenceClass);
  if (
    !policy ||
    !DIGEST_PATTERN.test(acquisition.trustInventoryDigest || "") ||
    acquisition.releaseBaseUrl !== releaseBaseUrl ||
    acquisition.metadataBaseUrl !== releaseBaseUrl ||
    acquisition.mode !== policy.acquisitionMode ||
    acquisition.transportSubstituted !== policy.transportSubstituted
  ) {
    fail("acquisition evidence is invalid for its evidence class");
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
  predecessorInstallationClass = null,
  predecessorInstallationClassDigest = null,
  evidenceClass = "PASS",
  acquisitionEvidenceClass = evidenceClass,
  acquisition,
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
    (scenario === "managed-update" &&
      (!DIGEST_PATTERN.test(predecessorCapsuleDigest || "") ||
        !["public-stable", "canonical-managed"].includes(predecessorInstallationClass) ||
        !DIGEST_PATTERN.test(predecessorInstallationClassDigest || ""))) ||
    (scenario === "fresh-install" &&
      (predecessorCapsuleDigest !== null ||
        predecessorInstallationClass !== null ||
        predecessorInstallationClassDigest !== null))
  ) {
    fail("predecessor capsule binding is invalid");
  }
  if (!EVIDENCE_CLASSES.has(evidenceClass) || !EVIDENCE_CLASSES.has(acquisitionEvidenceClass)) {
    fail("evidence class is invalid");
  }
  validateAcquisition(
    acquisition,
    version,
    evidenceClass,
    acquisitionEvidenceClass,
    contract.evidencePolicy,
  );
  validateEvidence(evidence, required, version, evidenceClass, acquisitionEvidenceClass);
  return {
    schemaVersion: 3,
    role: "fased-lifecycle-acceptance-receipt",
    contractId: contract.contractId,
    contractDigest: digestAcceptanceContract(contract),
    profile,
    scenario,
    version,
    commit,
    candidateDescriptorDigest,
    predecessorCapsuleDigest,
    predecessorInstallationClass,
    predecessorInstallationClassDigest,
    evidenceClass,
    acquisitionEvidenceClass,
    acquisition: { ...acquisition },
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
      "predecessorInstallationClass",
      "predecessorInstallationClassDigest",
      "evidenceClass",
      "acquisitionEvidenceClass",
      "acquisition",
      "evidence",
    ],
    "receipt",
  );
  const rebuilt = buildAcceptanceReceipt({ contract, ...receipt });
  if (JSON.stringify(receipt) !== JSON.stringify(rebuilt)) {
    fail("receipt identity or contract binding is invalid");
  }
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (
      expectedValue !== undefined &&
      JSON.stringify(receipt[key]) !== JSON.stringify(expectedValue)
    ) {
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
    predecessorInstallationClass: options["predecessor-installation-class"] || null,
    predecessorInstallationClassDigest: options["predecessor-installation-class-digest"] || null,
    evidenceClass: options["evidence-class"] || "PASS",
    acquisitionEvidenceClass:
      options["acquisition-evidence-class"] || options["evidence-class"] || "PASS",
    acquisition: {
      mode: options["acquisition-mode"],
      releaseBaseUrl: options["release-base-url"],
      metadataBaseUrl: options["metadata-base-url"],
      transportSubstituted: options["transport-substituted"] === "true",
      trustInventoryDigest: options["trust-inventory-digest"],
    },
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
