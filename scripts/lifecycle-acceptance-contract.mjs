#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;

export const REQUIRED_SCENARIOS = Object.freeze({
  "fresh-install": Object.freeze([
    "artifact-identity",
    "public-installer-acquisition",
    "canonical-lifecycle",
    "four-services-active",
    "wallet-status",
    "wallet-signer-doctor",
    "mining-status",
    "network-status",
    "plugin-doctor",
    "restart-health",
    "state-preservation",
    "already-current",
  ]),
  "managed-update": Object.freeze([
    "artifact-identity",
    "public-installer-acquisition",
    "rollback-retry",
    "canonical-lifecycle",
    "four-services-active",
    "wallet-status",
    "wallet-signer-doctor",
    "mining-status",
    "network-status",
    "plugin-doctor",
    "restart-health",
    "state-preservation",
    "already-current",
  ]),
});

function fail(message) {
  throw new Error(`lifecycle acceptance contract: ${message}`);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const actual = Object.keys(value)
    .toSorted((left, right) => left.localeCompare(right))
    .join(",");
  const wanted = [...expected].toSorted((left, right) => left.localeCompare(right)).join(",");
  if (actual !== wanted) {
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
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(stableValue(contract)))
    .digest("hex")}`;
}

export function validateAcceptanceContract(contract) {
  exactKeys(contract, ["schemaVersion", "role", "contractId", "scenarios"], "contract");
  if (
    contract.schemaVersion !== 1 ||
    contract.role !== "fased-lifecycle-acceptance-contract" ||
    contract.contractId !== "public-local-lifecycle-v1"
  ) {
    fail("identity is invalid");
  }
  exactKeys(contract.scenarios, Object.keys(REQUIRED_SCENARIOS), "contract scenarios");
  for (const [scenario, required] of Object.entries(REQUIRED_SCENARIOS)) {
    const actual = contract.scenarios[scenario];
    if (
      !Array.isArray(actual) ||
      actual.length !== required.length ||
      actual.some((predicate, index) => predicate !== required[index])
    ) {
      fail(`${scenario} predicates are incomplete or reordered`);
    }
  }
  return contract;
}

export function buildAcceptanceReceipt({
  contract,
  scenario,
  version,
  commit,
  candidateDescriptorDigest,
  passedPredicates,
}) {
  validateAcceptanceContract(contract);
  const required = REQUIRED_SCENARIOS[scenario];
  if (!required) {
    fail(`unsupported scenario ${String(scenario)}`);
  }
  if (
    !Array.isArray(passedPredicates) ||
    passedPredicates.length !== required.length ||
    passedPredicates.some((predicate, index) => predicate !== required[index])
  ) {
    fail(`${scenario} did not pass the exact required predicate sequence`);
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
  return {
    schemaVersion: 1,
    role: "fased-lifecycle-acceptance-receipt",
    contractId: contract.contractId,
    contractDigest: digestAcceptanceContract(contract),
    scenario,
    version,
    commit,
    candidateDescriptorDigest,
    predicates: [...passedPredicates],
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
      "scenario",
      "version",
      "commit",
      "candidateDescriptorDigest",
      "predicates",
    ],
    "receipt",
  );
  const rebuilt = buildAcceptanceReceipt({
    contract,
    scenario: receipt.scenario,
    version: receipt.version,
    commit: receipt.commit,
    candidateDescriptorDigest: receipt.candidateDescriptorDigest,
    passedPredicates: receipt.predicates,
  });
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
  if (command === "issue-receipt") {
    const passedPredicates = readFileSync(options["passed-file"], "utf8")
      .split("\n")
      .filter(Boolean);
    const receipt = buildAcceptanceReceipt({
      contract,
      scenario: options.scenario,
      version: options.version,
      commit: options.commit,
      candidateDescriptorDigest: options["candidate-descriptor-digest"],
      passedPredicates,
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
      expected: {
        scenario: options.scenario,
        version: options.version,
        commit: options.commit,
        candidateDescriptorDigest: options["candidate-descriptor-digest"],
      },
    });
    process.stdout.write(`${JSON.stringify({ ok: true, scenario: receipt.scenario })}\n`);
    return;
  }
  fail(`unsupported command ${String(command)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
