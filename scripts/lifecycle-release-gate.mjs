#!/usr/bin/env node

import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const LIFECYCLE_RELEASE_GATE_CONTEXT = "fased/lifecycle-release-gate";

const KIND = "fased-lifecycle-release-gate";
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;
const GIT_OBJECT_PATTERN = /^[a-f0-9]{40}$/u;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const GATE_PATTERN = /^[A-Z][A-Z0-9_-]{0,31}$/u;
const EVIDENCE_TIERS = new Set(["T0", "T1", "T2", "T3"]);
const AUTHORITIES = new Set(["AUTHORITATIVE", "SUPPORTING"]);
const RESULTS = new Set(["PASS", "FAIL", "BLOCKED"]);
const AUTHORITATIVE_GATES = new Set(["P1", "RC0", "L0", "L1", "H1", "H2"]);
const STATEFUL_GATES = new Set(["P1", "RC0", "L1", "H2"]);
const PREDICATES = new Set(["rollback", "statePreservation", "alreadyCurrent"]);
const AUTHORIZED_ACTIONS = new Set(["docker", "github-release", "stable", "tag", "version"]);
const MAX_RECEIPT_LIFETIME_MS = 60 * 60 * 1000;

function fail(message) {
  throw new Error(`lifecycle release gate: ${message}`);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected, label) {
  if (!isObject(value)) {
    fail(`${label} must be an object`);
  }
  const actual = Object.keys(value)
    .toSorted((left, right) => left.localeCompare(right))
    .join(",");
  const wanted = [...expected].toSorted((left, right) => left.localeCompare(right)).join(",");
  if (actual !== wanted) {
    fail(`${label} contains unsupported or missing fields`);
  }
}

function canonicalJSON(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJSON(entry)).join(",")}]`;
  }
  if (isObject(value)) {
    return `{${Object.keys(value)
      .toSorted((left, right) => left.localeCompare(right))
      .map((key) => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function lifecycleReleaseReceiptDigest(receipt) {
  return `sha256:${createHash("sha256").update(canonicalJSON(receipt)).digest("hex")}`;
}

function canonicalInstant(value, label) {
  if (typeof value !== "string") {
    fail(`${label} must be one canonical ISO-8601 UTC instant`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    fail(`${label} must be one canonical ISO-8601 UTC instant`);
  }
  return milliseconds;
}

function requireString(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    fail(`${label} is invalid`);
  }
}

function requireBoolean(value, label) {
  if (typeof value !== "boolean") {
    fail(`${label} must be boolean`);
  }
}

function validateAuthorizedActions(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    fail(`${label} must be a non-empty array`);
  }
  if (value.some((action) => typeof action !== "string" || !AUTHORIZED_ACTIONS.has(action))) {
    fail(`${label} contains an unsupported release action`);
  }
  const canonical = [...new Set(value)].toSorted((left, right) => left.localeCompare(right));
  if (
    canonical.length !== value.length ||
    canonical.some((action, index) => action !== value[index])
  ) {
    fail(`${label} must be sorted and unique`);
  }
  return canonical;
}

function validateExpected(expected) {
  if (!isObject(expected)) {
    fail("expected identity must be an object");
  }
  for (const [name, pattern, label] of [
    ["expectedVersion", VERSION_PATTERN, "expected version"],
    ["expectedCommit", GIT_OBJECT_PATTERN, "expected commit"],
    ["expectedTree", GIT_OBJECT_PATTERN, "expected tree"],
    ["expectedPlanDigest", DIGEST_PATTERN, "expected plan digest"],
    ["expectedArtifactDigest", DIGEST_PATTERN, "expected artifact digest"],
    ["expectedTopologyDigest", DIGEST_PATTERN, "expected topology digest"],
    ["expectedRunnerDigest", DIGEST_PATTERN, "expected runner digest"],
    ["expectedEvaluationDigest", DIGEST_PATTERN, "expected evaluation digest"],
    ["expectedGate", GATE_PATTERN, "expected gate"],
    ["expectedReceiptDigest", DIGEST_PATTERN, "expected receipt digest"],
  ]) {
    if (expected[name] !== undefined) {
      requireString(expected[name], pattern, label);
    }
  }
  if (
    expected.now !== undefined &&
    !(expected.now instanceof Date) &&
    typeof expected.now !== "string"
  ) {
    fail("verification time is invalid");
  }
  if (
    expected.requiredPredicates !== undefined &&
    (!Array.isArray(expected.requiredPredicates) ||
      expected.requiredPredicates.some((name) => !PREDICATES.has(name)))
  ) {
    fail("required predicates are invalid");
  }
  if (expected.expectedAuthorizedActions !== undefined) {
    validateAuthorizedActions(expected.expectedAuthorizedActions, "expected authorized actions");
  }
  if (expected.requireAuthoritative === true) {
    for (const name of [
      "expectedVersion",
      "expectedCommit",
      "expectedTree",
      "expectedPlanDigest",
      "expectedArtifactDigest",
      "expectedTopologyDigest",
      "expectedRunnerDigest",
      "expectedEvaluationDigest",
      "expectedGate",
      "expectedReceiptDigest",
      "expectedAuthorizedActions",
    ]) {
      if (expected[name] === undefined) {
        fail(`${name} is required for authoritative verification`);
      }
    }
  }
}

function validateCandidate(candidate) {
  exactKeys(candidate, ["version", "commit", "tree"], "candidate");
  requireString(candidate.version, VERSION_PATTERN, "candidate version");
  requireString(candidate.commit, GIT_OBJECT_PATTERN, "candidate commit");
  requireString(candidate.tree, GIT_OBJECT_PATTERN, "candidate tree");
}

function validateBindings(bindings) {
  exactKeys(
    bindings,
    ["planDigest", "artifactDigest", "topologyDigest", "runnerDigest", "evaluationDigest"],
    "receipt bindings",
  );
  requireString(bindings.planDigest, DIGEST_PATTERN, "plan digest");
  requireString(bindings.artifactDigest, DIGEST_PATTERN, "artifact digest");
  requireString(bindings.topologyDigest, DIGEST_PATTERN, "topology digest");
  requireString(bindings.runnerDigest, DIGEST_PATTERN, "runner digest");
  requireString(bindings.evaluationDigest, DIGEST_PATTERN, "evaluation digest");
}

function validateGate(gate) {
  exactKeys(gate, ["name", "evidenceTier", "authority"], "gate");
  requireString(gate.name, GATE_PATTERN, "gate name");
  if (!EVIDENCE_TIERS.has(gate.evidenceTier)) {
    fail("evidence tier is invalid");
  }
  if (!AUTHORITIES.has(gate.authority)) {
    fail("gate authority is invalid");
  }
  if (AUTHORITATIVE_GATES.has(gate.name)) {
    if (gate.authority !== "AUTHORITATIVE" || gate.evidenceTier !== "T3") {
      fail(`${gate.name} requires authoritative T3 evidence`);
    }
  }
}

function validatePredicate(predicate, name, required) {
  exactKeys(predicate, ["required", "status"], `${name} result`);
  requireBoolean(predicate.required, `${name} required`);
  if (!new Set(["PASS", "N/A"]).has(predicate.status)) {
    fail(`${name} status is invalid`);
  }
  if (predicate.required !== required || predicate.status !== (required ? "PASS" : "N/A")) {
    fail(`${name} requirement and status are inconsistent`);
  }
}

function validateResult(result, candidate, bindings, gate, expected) {
  exactKeys(
    result,
    [
      "status",
      "releaseFrozen",
      "manualReviewRequired",
      "rollback",
      "statePreservation",
      "finalIdentity",
      "alreadyCurrent",
    ],
    "gate result",
  );
  if (!RESULTS.has(result.status)) {
    fail("gate result status is invalid");
  }
  if (result.status !== "PASS") {
    fail(`gate result is ${result.status}`);
  }
  requireBoolean(result.releaseFrozen, "releaseFrozen");
  requireBoolean(result.manualReviewRequired, "manualReviewRequired");
  if (result.releaseFrozen) {
    fail("release remains frozen");
  }
  if (result.manualReviewRequired) {
    fail("manual review remains required");
  }

  const required = new Set(expected.requiredPredicates ?? []);
  if (STATEFUL_GATES.has(gate.name)) {
    for (const name of PREDICATES) {
      required.add(name);
    }
  }
  validatePredicate(result.rollback, "rollback", required.has("rollback"));

  exactKeys(
    result.statePreservation,
    ["required", "status", "beforeDigest", "afterDigest"],
    "state preservation",
  );
  validatePredicate(
    {
      required: result.statePreservation.required,
      status: result.statePreservation.status,
    },
    "state preservation",
    required.has("statePreservation"),
  );
  if (required.has("statePreservation")) {
    requireString(result.statePreservation.beforeDigest, DIGEST_PATTERN, "before-state digest");
    requireString(result.statePreservation.afterDigest, DIGEST_PATTERN, "after-state digest");
    if (result.statePreservation.beforeDigest !== result.statePreservation.afterDigest) {
      fail("critical state preservation is mismatched");
    }
  } else if (
    result.statePreservation.beforeDigest !== null ||
    result.statePreservation.afterDigest !== null
  ) {
    fail("unselected state preservation digests must be null");
  }

  validatePredicate(result.alreadyCurrent, "already current", required.has("alreadyCurrent"));

  exactKeys(
    result.finalIdentity,
    ["version", "commit", "tree", "artifactDigest"],
    "final identity",
  );
  validateCandidate({
    version: result.finalIdentity.version,
    commit: result.finalIdentity.commit,
    tree: result.finalIdentity.tree,
  });
  requireString(result.finalIdentity.artifactDigest, DIGEST_PATTERN, "final artifact digest");
  if (
    result.finalIdentity.version !== candidate.version ||
    result.finalIdentity.commit !== candidate.commit ||
    result.finalIdentity.tree !== candidate.tree ||
    result.finalIdentity.artifactDigest !== bindings.artifactDigest
  ) {
    fail("final identity does not match the candidate bindings");
  }
}

function verificationTime(now) {
  const value = now ?? new Date();
  const milliseconds = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    fail("verification time is invalid");
  }
  return milliseconds;
}

export function verifyLifecycleReleaseGateReceipt(envelope, expected) {
  validateExpected(expected);
  exactKeys(envelope, ["schemaVersion", "receipt", "receiptDigest"], "receipt envelope");
  if (envelope.schemaVersion !== 1) {
    fail("schemaVersion must be 1");
  }
  requireString(envelope.receiptDigest, DIGEST_PATTERN, "receipt digest");
  exactKeys(
    envelope.receipt,
    ["kind", "context", "authorizedActions", "candidate", "bindings", "gate", "result", "validity"],
    "receipt",
  );
  if (envelope.receipt.kind !== KIND) {
    fail("receipt kind is invalid");
  }
  if (envelope.receipt.context !== LIFECYCLE_RELEASE_GATE_CONTEXT) {
    fail("receipt context is invalid");
  }
  const authorizedActions = validateAuthorizedActions(
    envelope.receipt.authorizedActions,
    "authorized actions",
  );

  validateCandidate(envelope.receipt.candidate);
  validateBindings(envelope.receipt.bindings);
  validateGate(envelope.receipt.gate);
  if (
    expected.requireAuthoritative === true &&
    (!AUTHORITATIVE_GATES.has(envelope.receipt.gate.name) ||
      envelope.receipt.gate.authority !== "AUTHORITATIVE" ||
      envelope.receipt.gate.evidenceTier !== "T3")
  ) {
    fail("only a known authoritative T3 gate can authorize a release");
  }
  validateResult(
    envelope.receipt.result,
    envelope.receipt.candidate,
    envelope.receipt.bindings,
    envelope.receipt.gate,
    expected,
  );
  exactKeys(envelope.receipt.validity, ["issuedAt", "expiresAt"], "receipt validity");

  const issuedAt = canonicalInstant(envelope.receipt.validity.issuedAt, "issuedAt");
  const expiresAt = canonicalInstant(envelope.receipt.validity.expiresAt, "expiresAt");
  const now = verificationTime(expected.now);
  if (
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > MAX_RECEIPT_LIFETIME_MS ||
    issuedAt > now ||
    expiresAt <= now
  ) {
    fail("receipt is stale, not yet valid, or exceeds the one-hour validity window");
  }

  const computedDigest = lifecycleReleaseReceiptDigest(envelope.receipt);
  if (
    envelope.receiptDigest !== computedDigest ||
    (expected.expectedReceiptDigest !== undefined &&
      expected.expectedReceiptDigest !== computedDigest)
  ) {
    fail("receipt digest is invalid or does not match the expected receipt");
  }

  const candidate = envelope.receipt.candidate;
  const bindings = envelope.receipt.bindings;
  const gate = envelope.receipt.gate;
  if (
    (expected.expectedVersion !== undefined && candidate.version !== expected.expectedVersion) ||
    (expected.expectedCommit !== undefined && candidate.commit !== expected.expectedCommit) ||
    (expected.expectedTree !== undefined && candidate.tree !== expected.expectedTree) ||
    (expected.expectedPlanDigest !== undefined &&
      bindings.planDigest !== expected.expectedPlanDigest) ||
    (expected.expectedArtifactDigest !== undefined &&
      bindings.artifactDigest !== expected.expectedArtifactDigest) ||
    (expected.expectedTopologyDigest !== undefined &&
      bindings.topologyDigest !== expected.expectedTopologyDigest) ||
    (expected.expectedRunnerDigest !== undefined &&
      bindings.runnerDigest !== expected.expectedRunnerDigest) ||
    (expected.expectedEvaluationDigest !== undefined &&
      bindings.evaluationDigest !== expected.expectedEvaluationDigest) ||
    (expected.expectedGate !== undefined && gate.name !== expected.expectedGate) ||
    (expected.expectedAuthorizedActions !== undefined &&
      expected.expectedAuthorizedActions.join(",") !== authorizedActions.join(","))
  ) {
    fail(
      "receipt identity does not match the expected candidate, plan, artifact, topology, or gate",
    );
  }
  return Object.freeze({
    ok: true,
    context: LIFECYCLE_RELEASE_GATE_CONTEXT,
    state: "success",
    candidate: Object.freeze({ ...candidate }),
    gate: gate.name,
    evidenceTier: gate.evidenceTier,
    authority: gate.authority,
    authorizedActions: Object.freeze([...authorizedActions]),
    receiptDigest: computedDigest,
    releaseEligible: gate.authority === "AUTHORITATIVE",
  });
}

async function readReceipt(filePath) {
  const info = await fsp.lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 1024 * 1024) {
    fail("receipt must be one bounded regular single-link file");
  }
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error("lifecycle release gate: receipt is not valid JSON", { cause: error });
  }
}

function parseArgs(argv) {
  if (argv[0] !== "verify") {
    fail("usage: lifecycle-release-gate.mjs verify --receipt <path> --expected-* <value>");
  }
  const parsed = {};
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--require-authoritative") {
      parsed.requireAuthoritative = true;
      continue;
    }
    if (arg === "--json") {
      parsed.json = true;
      continue;
    }
    if (!arg.startsWith("--") || index + 1 >= argv.length) {
      fail(`unsupported or incomplete argument: ${arg}`);
    }
    const key = arg.slice(2).replaceAll(/-([a-z])/gu, (_match, letter) => letter.toUpperCase());
    if (parsed[key] !== undefined) {
      fail(`duplicate argument: ${arg}`);
    }
    parsed[key] = argv[index + 1];
    index += 1;
  }
  const allowed = new Set([
    "receipt",
    "expectedVersion",
    "expectedCommit",
    "expectedTree",
    "expectedPlanDigest",
    "expectedArtifactDigest",
    "expectedTopologyDigest",
    "expectedRunnerDigest",
    "expectedEvaluationDigest",
    "expectedGate",
    "expectedReceiptDigest",
    "expectedAuthorizedActions",
    "requiredPredicates",
    "now",
    "requireAuthoritative",
    "json",
  ]);
  for (const key of Object.keys(parsed)) {
    if (!allowed.has(key)) {
      fail(`unsupported argument: --${key}`);
    }
  }
  if (typeof parsed.receipt !== "string" || parsed.receipt.length === 0) {
    fail("--receipt is required");
  }
  if (parsed.requiredPredicates !== undefined) {
    parsed.requiredPredicates = parsed.requiredPredicates
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  }
  if (parsed.expectedAuthorizedActions !== undefined) {
    parsed.expectedAuthorizedActions = parsed.expectedAuthorizedActions
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  }
  return parsed;
}

export async function runLifecycleReleaseGateCli(argv) {
  const options = parseArgs(argv);
  const envelope = await readReceipt(options.receipt);
  return verifyLifecycleReleaseGateReceipt(envelope, options);
}

async function main() {
  console.log(JSON.stringify(await runLifecycleReleaseGateCli(process.argv.slice(2))));
}

if (
  process.argv[1] &&
  process.argv[2] === "verify" &&
  path.basename(process.argv[1]) === path.basename(fileURLToPath(import.meta.url))
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "lifecycle release gate: failed");
    process.exitCode = 1;
  });
}
