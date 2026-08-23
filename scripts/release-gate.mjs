#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;
const RUN_ID_PATTERN = /^[1-9][0-9]*$/u;
const CLAIM_NAME_PATTERN = /^[a-z][A-Za-z0-9]{0,63}$/u;
const MAX_RECEIPT_BYTES = 64 * 1024;

export const RELEASE_GATE_ROLE = "fased-release-gate-receipt";
export const RELEASE_GATE_SCHEMA_VERSION = 1;
export const RELEASE_GATE_PHASES = Object.freeze([
  "pre-candidate",
  "pre-tag-p1",
  "candidate-finalization",
  "candidate-publication",
]);

const REQUIRED_CLAIMS = Object.freeze({
  "pre-candidate": Object.freeze([
    "hostingStagingReceiptDigest",
    "mainChecksJobId",
    "mainRunId",
    "managedPredecessorVersion",
    "predecessorVersion",
    "releaseSequence",
    "securityEpoch",
    "workflowRunId",
  ]),
  "pre-tag-p1": Object.freeze([
    "hostingStagingReceiptDigest",
    "managedPredecessorVersion",
    "preCandidateRunId",
    "predecessorVersion",
    "releaseSequence",
    "securityEpoch",
    "workflowRunId",
  ]),
  "candidate-finalization": Object.freeze(["preCandidateRunId", "preTagP1RunId", "workflowRunId"]),
  "candidate-publication": Object.freeze(["publicationRunId", "sourceRunId", "workflowRunId"]),
});

const UPSTREAM_PHASES = Object.freeze({
  "pre-candidate": Object.freeze([]),
  "pre-tag-p1": Object.freeze(["pre-candidate"]),
  "candidate-finalization": Object.freeze(["pre-tag-p1"]),
  "candidate-publication": Object.freeze(["candidate-finalization"]),
});

function fail(message) {
  throw new Error(`release gate: ${message}`);
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

function canonicalJSON(value) {
  return JSON.stringify(stableValue(value));
}

export function digestValue(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const actual = Object.keys(value).toSorted().join(",");
  const wanted = [...expected].toSorted((left, right) => left.localeCompare(right)).join(",");
  if (actual !== wanted) {
    fail(`${label} contains unsupported or missing fields`);
  }
}

function validateSource(source) {
  exactKeys(source, ["commit", "lockfileDigest", "tree"], "source identity");
  if (
    !COMMIT_PATTERN.test(source.commit || "") ||
    !COMMIT_PATTERN.test(source.tree || "") ||
    !DIGEST_PATTERN.test(source.lockfileDigest || "")
  ) {
    fail("source identity is invalid");
  }
}

function validateRelease(release) {
  exactKeys(release, ["tag", "version"], "release identity");
  if (!VERSION_PATTERN.test(release.version || "") || release.tag !== `v${release.version}`) {
    fail("release identity is invalid");
  }
}

function validateArtifact(artifact) {
  if (artifact === null) {
    return;
  }
  exactKeys(artifact, ["artifactSetDigest", "descriptorDigest"], "artifact identity");
  if (
    !DIGEST_PATTERN.test(artifact.artifactSetDigest || "") ||
    !DIGEST_PATTERN.test(artifact.descriptorDigest || "")
  ) {
    fail("artifact identity is invalid");
  }
}

function validateClaims(phase, claims) {
  if (!claims || typeof claims !== "object" || Array.isArray(claims)) {
    fail("claims must be an object");
  }
  for (const [name, value] of Object.entries(claims)) {
    if (!CLAIM_NAME_PATTERN.test(name) || typeof value !== "string" || value.length > 4096) {
      fail("claim identity is invalid");
    }
  }
  const required = REQUIRED_CLAIMS[phase];
  if (!required.every((name) => Object.hasOwn(claims, name) && claims[name].length > 0)) {
    fail(`${phase} claims are incomplete`);
  }
  for (const name of Object.keys(claims).filter(
    (name) => name.endsWith("RunId") || name === "mainChecksJobId",
  )) {
    if (!RUN_ID_PATTERN.test(claims[name])) {
      fail(`${name} is invalid`);
    }
  }
  for (const name of Object.keys(claims).filter((name) => name.endsWith("Digest"))) {
    if (!DIGEST_PATTERN.test(claims[name])) {
      fail(`${name} is invalid`);
    }
  }
  for (const name of ["releaseSequence", "securityEpoch"]) {
    if (Object.hasOwn(claims, name) && !RUN_ID_PATTERN.test(claims[name])) {
      fail(`${name} is invalid`);
    }
  }
  if (
    Object.hasOwn(claims, "predecessorVersion") &&
    !/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(claims.predecessorVersion)
  ) {
    fail("predecessorVersion is invalid");
  }
  if (
    Object.hasOwn(claims, "managedPredecessorVersion") &&
    !VERSION_PATTERN.test(claims.managedPredecessorVersion)
  ) {
    fail("managedPredecessorVersion is invalid");
  }
}

function receiptBody(receipt) {
  const { receiptDigest: _receiptDigest, ...body } = receipt;
  return body;
}

export function parseReleaseGateReceipt(receipt, expected = {}) {
  exactKeys(
    receipt,
    [
      "artifact",
      "cacheKey",
      "claims",
      "phase",
      "receiptDigest",
      "release",
      "role",
      "schemaVersion",
      "source",
      "upstream",
    ],
    "release gate receipt",
  );
  if (
    receipt.schemaVersion !== RELEASE_GATE_SCHEMA_VERSION ||
    receipt.role !== RELEASE_GATE_ROLE ||
    !RELEASE_GATE_PHASES.includes(receipt.phase)
  ) {
    fail("release gate receipt header is invalid");
  }
  validateSource(receipt.source);
  validateRelease(receipt.release);
  validateArtifact(receipt.artifact);
  validateClaims(receipt.phase, receipt.claims);
  if (receipt.phase === "pre-candidate" && receipt.artifact !== null) {
    fail("pre-candidate receipt cannot bind candidate bytes");
  }
  if (
    ["pre-tag-p1", "candidate-finalization", "candidate-publication"].includes(receipt.phase) &&
    receipt.artifact === null
  ) {
    fail(`${receipt.phase} receipt must bind candidate bytes`);
  }
  const expectedCacheKey = digestValue(
    canonicalJSON({
      artifactSetDigest: receipt.artifact?.artifactSetDigest ?? null,
      lockfileDigest: receipt.source.lockfileDigest,
      tree: receipt.source.tree,
    }),
  );
  if (receipt.cacheKey !== expectedCacheKey) {
    fail("content-addressed cache key mismatch");
  }
  if (receipt.receiptDigest !== digestValue(canonicalJSON(receiptBody(receipt)))) {
    fail("receipt digest mismatch");
  }
  for (const [key, value] of Object.entries(expected)) {
    const actual = key.split(".").reduce((selected, part) => selected?.[part], receipt);
    if (value !== undefined && actual !== value) {
      fail(`expected ${key} mismatch`);
    }
  }
  return Object.freeze(receipt);
}

export function readReleaseGateReceipt(file, label = "upstream receipt") {
  const resolved = path.resolve(file);
  const info = lstatSync(resolved);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.size <= 0 ||
    info.size > MAX_RECEIPT_BYTES
  ) {
    fail(`${label} must be one bounded regular single-link file`);
  }
  try {
    const bytes = readFileSync(resolved, "utf8");
    const receipt = parseReleaseGateReceipt(JSON.parse(bytes));
    if (bytes !== `${JSON.stringify(receipt, null, 2)}\n`) {
      fail(`${label} is not canonical JSON`);
    }
    return receipt;
  } catch (error) {
    if (error instanceof SyntaxError) {
      fail(`${label} is not valid JSON`);
    }
    throw error;
  }
}

function upstreamIdentity(phase, upstream) {
  const allowed = UPSTREAM_PHASES[phase];
  if (allowed.length === 0) {
    if (upstream !== null) {
      fail(`${phase} cannot have an upstream gate receipt`);
    }
    return null;
  }
  if (!upstream || !allowed.includes(upstream.phase)) {
    fail(`${phase} upstream phase is invalid`);
  }
  return Object.freeze({
    artifactSetDigest: upstream.artifact?.artifactSetDigest ?? null,
    phase: upstream.phase,
    receiptDigest: upstream.receiptDigest,
    sourceCommit: upstream.source.commit,
  });
}

function validateClaimContinuity(phase, claims, upstream) {
  if (phase === "pre-candidate") {
    return;
  }
  if (phase === "pre-tag-p1") {
    for (const name of [
      "managedPredecessorVersion",
      "predecessorVersion",
      "releaseSequence",
      "securityEpoch",
    ]) {
      if (claims[name] !== upstream.claims[name]) {
        fail(`${name} changed across the pre-tag gate`);
      }
    }
    if (claims.preCandidateRunId !== upstream.claims.workflowRunId) {
      fail("pre-candidate workflow identity changed across the pre-tag gate");
    }
    return;
  }
  if (phase === "candidate-finalization") {
    if (
      claims.preCandidateRunId !== upstream.claims.preCandidateRunId ||
      claims.preTagP1RunId !== upstream.claims.workflowRunId
    ) {
      fail("protected P1 workflow identity changed at candidate finalization");
    }
    return;
  }
  if (
    claims.sourceRunId !== upstream.claims.workflowRunId ||
    claims.publicationRunId !== claims.workflowRunId
  ) {
    fail("publication workflow identity is not bound to its upstream candidate");
  }
}

export function buildReleaseGateReceipt({ phase, source, release, artifact, claims, upstream }) {
  if (!RELEASE_GATE_PHASES.includes(phase)) {
    fail("phase is invalid");
  }
  validateSource(source);
  validateRelease(release);
  validateArtifact(artifact);
  validateClaims(phase, claims);
  const selectedUpstream = upstreamIdentity(phase, upstream);
  if (upstream) {
    validateClaimContinuity(phase, claims, upstream);
    if (upstream.release.version !== release.version) {
      fail("release identity changed across gate receipts");
    }
    if (phase !== "pre-tag-p1" && upstream.source.commit !== source.commit) {
      fail("source commit changed after the pre-tag gate");
    }
    if (
      phase === "candidate-publication" &&
      canonicalJSON(upstream.artifact) !== canonicalJSON(artifact)
    ) {
      fail("candidate bytes changed after finalization");
    }
  }
  const body = {
    schemaVersion: RELEASE_GATE_SCHEMA_VERSION,
    role: RELEASE_GATE_ROLE,
    phase,
    source: stableValue(source),
    release: stableValue(release),
    artifact: artifact === null ? null : stableValue(artifact),
    upstream: selectedUpstream,
    claims: stableValue(claims),
    cacheKey: digestValue(
      canonicalJSON({
        artifactSetDigest: artifact?.artifactSetDigest ?? null,
        lockfileDigest: source.lockfileDigest,
        tree: source.tree,
      }),
    ),
  };
  return parseReleaseGateReceipt({
    ...body,
    receiptDigest: digestValue(canonicalJSON(body)),
  });
}

function parseArguments(args) {
  if (args.length === 0) {
    fail("command is required");
  }
  const command = args[0];
  const values = new Map();
  const claims = [];
  for (let index = 1; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      fail("arguments must be --name value pairs");
    }
    if (key === "--claim") {
      claims.push(value);
    } else if (values.has(key)) {
      fail(`duplicate argument: ${key}`);
    } else {
      values.set(key, value);
    }
  }
  return { command, values, claims };
}

function parseClaims(entries) {
  const claims = {};
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    const name = separator > 0 ? entry.slice(0, separator) : "";
    const value = separator > 0 ? entry.slice(separator + 1) : "";
    if (!CLAIM_NAME_PATTERN.test(name) || !value || Object.hasOwn(claims, name)) {
      fail("claims must be unique name=value pairs");
    }
    claims[name] = value;
  }
  return claims;
}

function required(values, name) {
  const value = values.get(name);
  if (!value) {
    fail(`${name} is required`);
  }
  return value;
}

function optionalArtifact(values) {
  const descriptorDigest = values.get("--candidate-descriptor-digest");
  const artifactSetDigest = values.get("--artifact-set-digest");
  if (!descriptorDigest && !artifactSetDigest) {
    return null;
  }
  if (!descriptorDigest || !artifactSetDigest) {
    fail("candidate descriptor and artifact-set digests must be provided together");
  }
  return { descriptorDigest, artifactSetDigest };
}

function main() {
  const { command, values, claims } = parseArguments(process.argv.slice(2));
  if (command === "verify") {
    const expectedClaims = parseClaims(claims);
    const expected = Object.fromEntries(
      [
        ["phase", values.get("--phase")],
        ["source.commit", values.get("--source-commit")],
        ["source.tree", values.get("--source-tree")],
        ["source.lockfileDigest", values.get("--lockfile-digest")],
        ["release.version", values.get("--release-version")],
        ["artifact.descriptorDigest", values.get("--candidate-descriptor-digest")],
        ["artifact.artifactSetDigest", values.get("--artifact-set-digest")],
        ...Object.entries(expectedClaims).map(([name, value]) => [`claims.${name}`, value]),
      ].filter(([, value]) => value !== undefined),
    );
    const receipt = parseReleaseGateReceipt(
      readReleaseGateReceipt(required(values, "--receipt"), "release gate receipt"),
      expected,
    );
    const expectedPhase = values.get("--phase");
    if (expectedPhase && receipt.phase !== expectedPhase) {
      fail("expected phase mismatch");
    }
    process.stdout.write(`${JSON.stringify({ ok: true, ...receipt })}\n`);
    return;
  }
  if (command !== "record") {
    fail("command must be record or verify");
  }
  const upstreamFile = values.get("--upstream-receipt");
  const receipt = buildReleaseGateReceipt({
    phase: required(values, "--phase"),
    source: {
      commit: required(values, "--source-commit"),
      tree: required(values, "--source-tree"),
      lockfileDigest: required(values, "--lockfile-digest"),
    },
    release: {
      version: required(values, "--release-version"),
      tag: `v${required(values, "--release-version")}`,
    },
    artifact: optionalArtifact(values),
    claims: parseClaims(claims),
    upstream: upstreamFile ? readReleaseGateReceipt(upstreamFile) : null,
  });
  const output = path.resolve(required(values, "--output"));
  writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ ok: true, ...receipt })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
