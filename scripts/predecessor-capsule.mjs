#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const GROUP_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/u;
const SCHEMA_NAME_PATTERN = /^[a-z][A-Za-z0-9]{0,127}$/u;
const forbiddenPath =
  /(^|\/)(?:master\.key|seed(?:\.json)?|private[-_.]?key|credentials?|tokens?|audit\.jsonl|[^/]*(?:wallet|signer)[-_.]?(?:key|secret)[^/]*)$/iu;
const MAX_ENTRIES = 256;

function canonicalValue(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .toSorted((left, right) => left.localeCompare(right))
        .map((key) => [key, canonicalValue(value[key])]),
    );
  }
  return value;
}

export function predecessorInstallationClassDigest(value) {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonicalValue(value)))
    .digest("hex")}`;
}

function fail(message) {
  throw new Error(`predecessor capsule: ${message}`);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  if (
    Object.keys(value).toSorted().join(",") !==
    [...expected].toSorted((left, right) => left.localeCompare(right)).join(",")
  ) {
    fail(`${label} fields are invalid`);
  }
}

function safeRelative(value) {
  return (
    typeof value === "string" &&
    value !== "" &&
    value.length <= 512 &&
    !path.posix.isAbsolute(value) &&
    path.posix.normalize(value) === value &&
    !value.split("/").includes("..") &&
    !/[\r\n]/u.test(value) &&
    !value.includes("\0")
  );
}

export function parsePredecessorCapsule(value, expected = {}) {
  exactKeys(
    value,
    [
      "schemaVersion",
      "role",
      "profile",
      "compatibilityGroupId",
      "compatibilityDigest",
      "release",
      "sourceReceipt",
      "releaseIndex",
      "topology",
      "installationClass",
      "installationClassDigest",
      "ownership",
      "pointers",
      "expectedReceiptDigest",
      "archive",
      "sanitization",
      "services",
      "entries",
    ],
    "descriptor",
  );
  exactKeys(value.release, ["version", "commit", "tree"], "release");
  exactKeys(
    value.sourceReceipt,
    ["schemaVersion", "repository", "tag", "authority", "manifest", "manifestAttestation"],
    "source receipt",
  );
  exactKeys(value.sourceReceipt.manifest, ["name", "sha256"], "source manifest");
  exactKeys(
    value.sourceReceipt.manifestAttestation,
    ["name", "sha256"],
    "source manifest attestation",
  );
  if (value.releaseIndex !== null) {
    exactKeys(value.releaseIndex, ["sequence", "securityEpoch", "sha256"], "release index");
  }
  exactKeys(value.topology, ["schemaVersion", "kind", "capabilities"], "topology");
  exactKeys(
    value.installationClass,
    [
      "kind",
      "manifestSchema",
      "platform",
      "activeGeneration",
      "previousGeneration",
      "stateSchemas",
      "capabilities",
    ],
    "installation class",
  );
  exactKeys(value.ownership, ["rootUid", "rootGid", "operatorUid", "operatorGid"], "ownership");
  exactKeys(value.pointers, ["current", "previous"], "pointers");
  exactKeys(value.archive, ["name", "size", "sha256"], "archive");
  exactKeys(value.sanitization, ["syntheticState", "containsSecrets"], "sanitization");
  if (
    value.schemaVersion !== 1 ||
    value.role !== "fased-sanitized-predecessor-capsule" ||
    !["protected-local", "hosting"].includes(value.profile) ||
    (expected.profile && value.profile !== expected.profile) ||
    (expected.installationClass && value.installationClass?.kind !== expected.installationClass) ||
    !GROUP_PATTERN.test(value.compatibilityGroupId || "") ||
    !DIGEST_PATTERN.test(value.compatibilityDigest || "") ||
    !VERSION_PATTERN.test(value.release.version || "") ||
    !COMMIT_PATTERN.test(value.release.commit || "") ||
    !COMMIT_PATTERN.test(value.release.tree || "") ||
    value.sourceReceipt.schemaVersion !== 1 ||
    value.sourceReceipt.repository !== "fased-ai/fased" ||
    value.sourceReceipt.tag !== `v${value.release.version}` ||
    value.sourceReceipt.authority !== "github-artifact-attestation" ||
    !NAME_PATTERN.test(value.sourceReceipt.manifest.name || "") ||
    !DIGEST_PATTERN.test(value.sourceReceipt.manifest.sha256 || "") ||
    !NAME_PATTERN.test(value.sourceReceipt.manifestAttestation.name || "") ||
    !DIGEST_PATTERN.test(value.sourceReceipt.manifestAttestation.sha256 || "") ||
    (value.releaseIndex !== null &&
      (!Number.isSafeInteger(value.releaseIndex.sequence) ||
        value.releaseIndex.sequence < 1 ||
        !Number.isSafeInteger(value.releaseIndex.securityEpoch) ||
        value.releaseIndex.securityEpoch < 1 ||
        !DIGEST_PATTERN.test(value.releaseIndex.sha256 || ""))) ||
    value.topology.schemaVersion !== 1 ||
    !["public-stable", "managed-generation"].includes(value.topology.kind) ||
    !Array.isArray(value.topology.capabilities) ||
    value.topology.capabilities.length === 0 ||
    value.topology.capabilities.some(
      (capability) => !GROUP_PATTERN.test(capability) || capability.length > 64,
    ) ||
    new Set(value.topology.capabilities).size !== value.topology.capabilities.length ||
    !DIGEST_PATTERN.test(value.installationClassDigest || "") ||
    value.installationClassDigest !== predecessorInstallationClassDigest(value.installationClass) ||
    value.ownership.rootUid !== 0 ||
    value.ownership.rootGid !== 0 ||
    !Number.isSafeInteger(value.ownership.operatorUid) ||
    value.ownership.operatorUid <= 0 ||
    !Number.isSafeInteger(value.ownership.operatorGid) ||
    value.ownership.operatorGid <= 0 ||
    !DIGEST_PATTERN.test(value.pointers.current || "") ||
    !(value.pointers.previous === null || DIGEST_PATTERN.test(value.pointers.previous || "")) ||
    !DIGEST_PATTERN.test(value.expectedReceiptDigest || "") ||
    !NAME_PATTERN.test(value.archive.name || "") ||
    !Number.isSafeInteger(value.archive.size) ||
    value.archive.size <= 0 ||
    !DIGEST_PATTERN.test(value.archive.sha256 || "") ||
    value.sanitization.syntheticState !== true ||
    value.sanitization.containsSecrets !== false
  ) {
    fail("identity, archive, or sanitization policy is invalid");
  }
  validateInstallationClass(value.installationClass, value.profile, value.topology);
  const requiredServices =
    value.installationClass.kind === "canonical-managed"
      ? Object.keys(value.installationClass.platform.services)
          .toSorted((left, right) => left.localeCompare(right))
          .map((role) => value.installationClass.platform.services[role])
      : value.profile === "hosting"
        ? [
            "fased-host-updater.service",
            "fased-host-controller.service",
            "fased-signerd.service",
            "fased-gateway.service",
          ]
        : ["fased-gateway.service"];
  if (
    !Array.isArray(value.services) ||
    value.services.length !== requiredServices.length ||
    value.services.some((service, index) => service !== requiredServices[index])
  ) {
    fail("service inventory is invalid");
  }
  if (
    !Array.isArray(value.entries) ||
    value.entries.length === 0 ||
    value.entries.length > MAX_ENTRIES
  ) {
    fail("entry inventory is empty");
  }
  const seen = new Set();
  for (const entry of value.entries) {
    const expectedKeys =
      entry?.type === "symlink"
        ? ["path", "type", "owner", "target"]
        : entry?.type === "directory"
          ? ["path", "type", "mode", "owner"]
          : ["path", "type", "mode", "owner", "sha256"];
    exactKeys(entry, expectedKeys, "entry");
    const commonUnsafe =
      !safeRelative(entry.path) ||
      seen.has(entry.path) ||
      forbiddenPath.test(entry.path) ||
      !["root", "operator"].includes(entry.owner);
    const fileUnsafe =
      entry.type === "file" &&
      (!Number.isSafeInteger(entry.mode) ||
        entry.mode < 0o400 ||
        entry.mode > 0o755 ||
        entry.mode & 0o022 ||
        !DIGEST_PATTERN.test(entry.sha256 || ""));
    const linkUnsafe =
      entry.type === "symlink" &&
      (!safeRelative(entry.target) ||
        path.posix.isAbsolute(entry.target) ||
        path.posix
          .normalize(path.posix.join(path.posix.dirname(entry.path), entry.target))
          .startsWith("../"));
    const directoryUnsafe =
      entry.type === "directory" &&
      (!Number.isSafeInteger(entry.mode) ||
        entry.mode < 0o500 ||
        entry.mode > 0o755 ||
        entry.mode & 0o022);
    if (
      commonUnsafe ||
      !["directory", "file", "symlink"].includes(entry.type) ||
      fileUnsafe ||
      linkUnsafe ||
      directoryUnsafe
    ) {
      fail(
        forbiddenPath.test(entry.path || "")
          ? "secret-bearing path is forbidden"
          : "entry inventory is unsafe",
      );
    }
    seen.add(entry.path);
  }
  return value;
}

function validateInstallationClass(value, profile, topology) {
  const validSchemas = (schemas) =>
    schemas &&
    typeof schemas === "object" &&
    !Array.isArray(schemas) &&
    Object.keys(schemas).length > 0 &&
    Object.entries(schemas).every(
      ([name, version]) =>
        SCHEMA_NAME_PATTERN.test(name) && Number.isSafeInteger(version) && version > 0,
    );
  if (!validSchemas(value.stateSchemas)) {
    fail("installation class state schemas are invalid");
  }
  if (value.kind === "public-stable") {
    if (
      topology.kind !== "public-stable" ||
      value.manifestSchema !== null ||
      value.platform !== null ||
      value.activeGeneration !== null ||
      value.previousGeneration !== null ||
      value.capabilities !== null
    ) {
      fail("public-stable installation class is invalid");
    }
    return;
  }
  if (value.kind !== "canonical-managed" || topology.kind !== "managed-generation") {
    fail("managed installation class is invalid");
  }
  if (!Number.isSafeInteger(value.manifestSchema) || value.manifestSchema < 1) {
    fail("managed manifest schema is invalid");
  }
  exactKeys(
    value.platform,
    ["adapter", "instanceId", "configurationDigest", "services"],
    "installation platform",
  );
  const adapters =
    profile === "hosting"
      ? ["linux-systemd-hosting-v1", "linux-systemd-hosting-v2"]
      : ["linux-systemd-local-v1", "linux-systemd-local-v2"];
  const legacy = value.platform.adapter.endsWith("-v1");
  const expectedRoles = legacy
    ? ["controller", "gateway", "signer", "supervisor"]
    : ["gateway", "signer", "supervisor"];
  if (
    !adapters.includes(value.platform.adapter) ||
    !GROUP_PATTERN.test(value.platform.instanceId || "") ||
    !DIGEST_PATTERN.test(value.platform.configurationDigest || "") ||
    !value.platform.services ||
    typeof value.platform.services !== "object" ||
    Array.isArray(value.platform.services) ||
    Object.keys(value.platform.services).toSorted().join(",") !== expectedRoles.join(",") ||
    Object.values(value.platform.services).some(
      (unit) =>
        typeof unit !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}\.service$/u.test(unit),
    )
  ) {
    fail("managed platform identity is invalid");
  }
  exactKeys(
    value.activeGeneration,
    ["id", "version", "commit", "tree", "artifactSetDigest"],
    "active generation",
  );
  if (
    !DIGEST_PATTERN.test(value.activeGeneration.id || "") ||
    !VERSION_PATTERN.test(value.activeGeneration.version || "") ||
    !COMMIT_PATTERN.test(value.activeGeneration.commit || "") ||
    !COMMIT_PATTERN.test(value.activeGeneration.tree || "") ||
    !DIGEST_PATTERN.test(value.activeGeneration.artifactSetDigest || "")
  ) {
    fail("managed active generation is invalid");
  }
  if (value.previousGeneration !== null) {
    exactKeys(
      value.previousGeneration,
      ["id", "version", "commit", "tree", "artifactSetDigest"],
      "previous generation",
    );
    if (
      !DIGEST_PATTERN.test(value.previousGeneration.id || "") ||
      !VERSION_PATTERN.test(value.previousGeneration.version || "") ||
      !COMMIT_PATTERN.test(value.previousGeneration.commit || "") ||
      !COMMIT_PATTERN.test(value.previousGeneration.tree || "") ||
      !DIGEST_PATTERN.test(value.previousGeneration.artifactSetDigest || "") ||
      value.previousGeneration.id === value.activeGeneration.id
    ) {
      fail("managed previous generation is invalid");
    }
  }
  exactKeys(value.capabilities, ["supervisor", "controller", "migrator", "signer"], "capabilities");
  for (const range of Object.values(value.capabilities)) {
    exactKeys(range, ["min", "max"], "capability range");
    if (
      !Number.isSafeInteger(range.min) ||
      !Number.isSafeInteger(range.max) ||
      range.min < 1 ||
      range.max < range.min
    ) {
      fail("capability range is invalid");
    }
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] !== "verify" || args[1] !== "--descriptor" || !args[2]) {
    fail("usage: verify --descriptor FILE");
  }
  const capsule = parsePredecessorCapsule(JSON.parse(readFileSync(args[2], "utf8")));
  process.stdout.write(
    `${JSON.stringify({ ok: true, profile: capsule.profile, version: capsule.release.version })}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
