#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash, createPublicKey, randomUUID, verify as verifyBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const SUPERVISOR_SCHEMA_VERSION = 1;
const SUPERVISOR_PROTOCOL_VERSION = 1;
const CONTROLLER_PROTOCOL_VERSION = 2;
const INITIAL_LIFECYCLE_ROOT_SHA256 =
  "23d3e8235a39729d6ae37a5784eaa717a47e4ac725f5a416e78754ad9b4618ca";
const INITIAL_LIFECYCLE_ROOT_ENVELOPE = Object.freeze({
  schemaVersion: 1,
  signed: {
    schemaVersion: 1,
    type: "fased-lifecycle-root",
    version: 1,
    issuedAt: "2026-07-29T20:37:38.000Z",
    expiresAt: "2031-07-29T20:37:38.000Z",
    keys: {
      "65e5a3b316f86ddacfefd042b2e06bf9320e2e170bef2053541556ae8ba3573b": {
        keyType: "ed25519",
        scheme: "ed25519",
        publicKey: "MCowBQYDK2VwAyEAtk4hgp9QDKjLUfgdhT7wyKVa3Ck578DzyAjCbsUs5b8=",
      },
      "93614a5dc68035b1718455dbc43163dd62e71243ab496f961ecd7f23a607a971": {
        keyType: "ed25519",
        scheme: "ed25519",
        publicKey: "MCowBQYDK2VwAyEA9T3Qt7kQz7YQ7bz9UPaVcdw/tzPZx5V5HdrfBTeNfqQ=",
      },
      a5f07688f14ff3e7c5b61d8e7109522360851c3bffbcc277ce8241d7151b4d3a: {
        keyType: "ed25519",
        scheme: "ed25519",
        publicKey: "MCowBQYDK2VwAyEA+47FOrsgi9MHmEFRaz/z9gGDsA2rr6hlH/cdviRezEc=",
      },
    },
    root: {
      keyIds: [
        "65e5a3b316f86ddacfefd042b2e06bf9320e2e170bef2053541556ae8ba3573b",
        "93614a5dc68035b1718455dbc43163dd62e71243ab496f961ecd7f23a607a971",
        "a5f07688f14ff3e7c5b61d8e7109522360851c3bffbcc277ce8241d7151b4d3a",
      ],
      threshold: 2,
    },
    releaseAuthority: {
      type: "github-artifact-attestation-v1",
      repository: "fased-ai/fased",
      workflow: "fased-ai/fased/.github/workflows/hosted-runtime-release.yml",
      sourceRefPrefix: "refs/tags/v",
      denySelfHostedRunners: true,
    },
    revocations: {
      releaseVersions: [],
      targetDigests: [],
    },
  },
  signatures: [
    {
      keyId: "93614a5dc68035b1718455dbc43163dd62e71243ab496f961ecd7f23a607a971",
      signature:
        "WMs+FJdQIklqIbdUCXCpBOGGjB12xNnCWgoSRIWqq7D9Vw2DtR229ICOnJpXiqpd4EJ1ogf/bTQOcMLA1bKrCg==",
    },
    {
      keyId: "a5f07688f14ff3e7c5b61d8e7109522360851c3bffbcc277ce8241d7151b4d3a",
      signature:
        "54q7i6AG4NAx9lLbccMIxp4juYBxLAWBjpYVqvVP3mFeNjCTt6nwSYk023NB1vxyrysJYUjat/5XukYM/EmSBA==",
    },
  ],
});
const RELEASE_BASE = "https://github.com/fased-ai/fased/releases/download";
const TRUST_METADATA_NAME = "fased-lifecycle-trust-v1.json";
const TRUST_METADATA_BUNDLE_NAME = `${TRUST_METADATA_NAME}.attestation.json`;
const SUPERVISOR_NAME = "fased-lifecycle-supervisor.mjs";
const CONTROLLER_SERVER_NAME = "fased-host-updater.mjs";
const CONTROLLER_CLIENT_NAME = "fased-host-updaterctl.mjs";
const EVIDENCE_VERIFIER_NAME = "fased-privileged-release-evidence.mjs";
const RELEASE_MANIFEST_NAME = "fased-hosted-release-v2.json";
const PRIVILEGED_PROVENANCE_NAME = "fased-privileged-provenance-v1.intoto.json";
const PRIVILEGED_PROVENANCE_BUNDLE_NAME = `${PRIVILEGED_PROVENANCE_NAME}.attestation.json`;
const PRIVILEGED_SBOM_NAME = "fased-privileged-sbom-v1.spdx.json";
const PRIVILEGED_VEX_NAME = "fased-privileged-vex-v1.openvex.json";
const MAX_REQUEST_BYTES = 4096;
const MAX_DOWNLOAD_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20 * 60_000;
const PRIVATE_UMASK = 0o077;
const MAX_METADATA_VALIDITY_MS = 400 * 24 * 60 * 60 * 1000;
const CONTROLLER_SELECTION_SCHEMA_VERSION = 1;
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const INSTANCE_ID_PATTERN = /^[a-f0-9]{16}$/u;
const HISTORICAL_CONTROLLER_CANDIDATE_PATTERN =
  /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?\.q0\.[a-f0-9]{12}$/u;
const TRANSACTION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CONTROLLER_OPERATIONS = new Set([
  "applyRelease",
  "prepareRelease",
  "activateRelease",
  "authorizeGatewayRelease",
  "gateGatewayRelease",
  "restartGateway",
  "commitRelease",
  "rollbackRelease",
]);
const CONTROLLER_SELECTION_CAPABILITIES = Object.freeze({
  supervisorProtocol: SUPERVISOR_PROTOCOL_VERSION,
  controllerProtocol: CONTROLLER_PROTOCOL_VERSION,
  requestSchema: 2,
});
const RUNNING_SUPERVISOR_SHA256 = createHash("sha256")
  .update(fs.readFileSync(fileURLToPath(import.meta.url)))
  .digest("hex");

function fail(message) {
  throw new Error(message);
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
    fail(`${label} contains unsupported or missing fields`);
  }
}

function canonicalRootValue(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      fail("lifecycle root metadata numbers must be safe integers");
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalRootValue(entry)).join(",")}]`;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return `{${Object.keys(value)
      .toSorted((left, right) => left.localeCompare(right))
      .map((key) => `${JSON.stringify(key)}:${canonicalRootValue(value[key])}`)
      .join(",")}}`;
  }
  fail("lifecycle root metadata contains a non-canonical value");
}

function canonicalRootBytes(value) {
  return Buffer.from(canonicalRootValue(value), "utf8");
}

function controllerSelectionDigest(value) {
  return createHash("sha256").update(canonicalRootBytes(value)).digest("hex");
}

function controllerSelectionReceiptPath(paths, transactionId, selectionDigest) {
  if (
    !TRANSACTION_ID_PATTERN.test(transactionId || "") ||
    !DIGEST_PATTERN.test(selectionDigest || "")
  ) {
    fail("controller selection receipt path identity is invalid");
  }
  return path.join(
    paths.supervisorStateDir,
    "controller-selections",
    transactionId,
    `${selectionDigest}.json`,
  );
}

function parseControllerSelectionReceipt(value) {
  exactKeys(
    value,
    [
      "schemaVersion",
      "transactionId",
      "version",
      "releaseCommit",
      "targetManifestSha256",
      "controllerServerSha256",
      "controllerClientSha256",
      "controllerInstanceId",
      "protocolCapabilities",
      "selectionDigest",
    ],
    "controller selection receipt",
  );
  exactKeys(
    value.protocolCapabilities,
    ["supervisorProtocol", "controllerProtocol", "requestSchema"],
    "controller selection protocol capabilities",
  );
  const unsigned = {
    schemaVersion: Number(value.schemaVersion),
    transactionId: String(value.transactionId ?? "").toLowerCase(),
    version: parseVersion(value.version),
    releaseCommit: String(value.releaseCommit ?? ""),
    targetManifestSha256: String(value.targetManifestSha256 ?? ""),
    controllerServerSha256: String(value.controllerServerSha256 ?? ""),
    controllerClientSha256: String(value.controllerClientSha256 ?? ""),
    controllerInstanceId: String(value.controllerInstanceId ?? "").toLowerCase(),
    protocolCapabilities: {
      supervisorProtocol: Number(value.protocolCapabilities.supervisorProtocol),
      controllerProtocol: Number(value.protocolCapabilities.controllerProtocol),
      requestSchema: Number(value.protocolCapabilities.requestSchema),
    },
  };
  if (
    unsigned.schemaVersion !== CONTROLLER_SELECTION_SCHEMA_VERSION ||
    !TRANSACTION_ID_PATTERN.test(unsigned.transactionId) ||
    !COMMIT_PATTERN.test(unsigned.releaseCommit) ||
    !DIGEST_PATTERN.test(unsigned.targetManifestSha256) ||
    !DIGEST_PATTERN.test(unsigned.controllerServerSha256) ||
    !DIGEST_PATTERN.test(unsigned.controllerClientSha256) ||
    !TRANSACTION_ID_PATTERN.test(unsigned.controllerInstanceId) ||
    canonicalRootValue(unsigned.protocolCapabilities) !==
      canonicalRootValue(CONTROLLER_SELECTION_CAPABILITIES) ||
    value.selectionDigest !== controllerSelectionDigest(unsigned)
  ) {
    fail("controller selection receipt is malformed or mismatched");
  }
  return Object.freeze({ ...unsigned, selectionDigest: value.selectionDigest });
}

function createControllerSelectionReceipt(request, staged, controllerInstanceId) {
  const unsigned = {
    schemaVersion: CONTROLLER_SELECTION_SCHEMA_VERSION,
    transactionId: request.transactionId,
    version: request.version,
    releaseCommit: staged.releaseCommit,
    targetManifestSha256: staged.targetManifestSha256,
    controllerServerSha256: staged.identity?.serverSha256,
    controllerClientSha256: staged.identity?.clientSha256,
    controllerInstanceId,
    protocolCapabilities: CONTROLLER_SELECTION_CAPABILITIES,
  };
  return parseControllerSelectionReceipt({
    ...unsigned,
    selectionDigest: controllerSelectionDigest(unsigned),
  });
}

async function writeControllerSelectionReceipt(
  paths,
  request,
  staged,
  controllerInstanceId,
  rootUid = 0,
  rootGid = 0,
) {
  const receipt = createControllerSelectionReceipt(request, staged, controllerInstanceId);
  const receiptPath = controllerSelectionReceiptPath(
    paths,
    receipt.transactionId,
    receipt.selectionDigest,
  );
  await atomicWrite(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 0o600);
  await fsp.chown(receiptPath, rootUid, rootGid);
  await fsp.chmod(receiptPath, 0o600);
  const currentPath = path.join(path.dirname(receiptPath), "current");
  await atomicWrite(currentPath, `${receipt.selectionDigest}\n`, 0o600);
  await fsp.chown(currentPath, rootUid, rootGid);
  await fsp.chmod(currentPath, 0o600);
  return receipt;
}

async function readControllerSelectionReceipt(paths, request, rootUid = 0) {
  let selectionDigest = String(request.selectionDigest ?? "");
  if (!selectionDigest) {
    const currentPath = path.join(
      paths.supervisorStateDir,
      "controller-selections",
      request.transactionId,
      "current",
    );
    const currentInfo = await fsp.lstat(currentPath);
    if (
      !currentInfo.isFile() ||
      currentInfo.isSymbolicLink() ||
      currentInfo.nlink !== 1 ||
      currentInfo.uid !== rootUid ||
      (currentInfo.mode & 0o177) !== 0
    ) {
      fail("current controller selection receipt is not protected");
    }
    selectionDigest = (await fsp.readFile(currentPath, "utf8")).trim();
  }
  const receiptPath = controllerSelectionReceiptPath(paths, request.transactionId, selectionDigest);
  const info = await fsp.lstat(receiptPath);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.uid !== rootUid ||
    (info.mode & 0o177) !== 0
  ) {
    fail("controller selection receipt is not protected");
  }
  const receipt = parseControllerSelectionReceipt(
    JSON.parse(await fsp.readFile(receiptPath, "utf8")),
  );
  if (
    receipt.transactionId !== request.transactionId ||
    receipt.version !== request.version ||
    receipt.selectionDigest !== selectionDigest
  ) {
    fail("controller selection receipt does not match the supervisor transaction");
  }
  return receipt;
}

function canonicalRootBase64(value, label) {
  const text = String(value ?? "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(text) || text.length % 4 !== 0) {
    fail(`${label} is not canonical base64`);
  }
  const bytes = Buffer.from(text, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== text) {
    fail(`${label} is not canonical base64`);
  }
  return bytes;
}

function canonicalSortedUnique(values, pattern, label) {
  if (
    !Array.isArray(values) ||
    values.some((value) => !pattern.test(String(value ?? ""))) ||
    new Set(values).size !== values.length ||
    values.join(",") !== [...values].toSorted((left, right) => left.localeCompare(right)).join(",")
  ) {
    fail(`${label} must be unique, sorted, and canonical`);
  }
  return Object.freeze([...values]);
}

export function verifyEmbeddedLifecycleRootPolicy(
  envelope = INITIAL_LIFECYCLE_ROOT_ENVELOPE,
  pinnedSha256 = INITIAL_LIFECYCLE_ROOT_SHA256,
  now = Date.now(),
) {
  const digest = createHash("sha256").update(canonicalRootBytes(envelope)).digest("hex");
  if (digest !== pinnedSha256) {
    fail("embedded lifecycle root does not match its immutable bootstrap pin");
  }
  const root = parseLifecycleRootPolicy(envelope, now);
  const verified = verifyLifecycleRootSignatures(root, [root]);
  requireLifecycleRootThreshold(root, verified);
  return Object.freeze({
    ...root,
    pinnedSha256,
  });
}

function parseLifecycleRootPolicy(
  envelope,
  now = Date.now(),
  { enforceCurrentValidity = true } = {},
) {
  exactKeys(envelope, ["schemaVersion", "signed", "signatures"], "embedded lifecycle root");
  exactKeys(
    envelope.signed,
    [
      "schemaVersion",
      "type",
      "version",
      "issuedAt",
      "expiresAt",
      "keys",
      "root",
      "releaseAuthority",
      "revocations",
    ],
    "embedded lifecycle root metadata",
  );
  const issuedAt = Date.parse(envelope.signed.issuedAt);
  const expiresAt = Date.parse(envelope.signed.expiresAt);
  if (
    envelope.schemaVersion !== 1 ||
    envelope.signed.schemaVersion !== 1 ||
    envelope.signed.type !== "fased-lifecycle-root" ||
    !Number.isSafeInteger(envelope.signed.version) ||
    envelope.signed.version <= 0 ||
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt) ||
    new Date(issuedAt).toISOString() !== envelope.signed.issuedAt ||
    new Date(expiresAt).toISOString() !== envelope.signed.expiresAt ||
    issuedAt >= expiresAt ||
    (enforceCurrentValidity && (now < issuedAt || now > expiresAt)) ||
    expiresAt - issuedAt > 5 * 366 * 24 * 60 * 60 * 1000
  ) {
    fail("embedded lifecycle root is stale, malformed, or has an invalid validity window");
  }
  const keyIds = Object.keys(envelope.signed.keys ?? {}).toSorted();
  exactKeys(envelope.signed.root, ["keyIds", "threshold"], "embedded lifecycle root role");
  if (
    keyIds.length !== 3 ||
    envelope.signed.root.threshold !== 2 ||
    JSON.stringify(envelope.signed.root.keyIds) !== JSON.stringify(keyIds)
  ) {
    fail("embedded lifecycle root role must be exactly 2-of-3");
  }
  const keys = new Map();
  for (const keyId of keyIds) {
    const record = envelope.signed.keys[keyId];
    exactKeys(record, ["keyType", "scheme", "publicKey"], `embedded lifecycle root key ${keyId}`);
    if (record.keyType !== "ed25519" || record.scheme !== "ed25519") {
      fail("embedded lifecycle root keys must use Ed25519");
    }
    const bytes = canonicalRootBase64(record.publicKey, `embedded lifecycle root key ${keyId}`);
    if (createHash("sha256").update(bytes).digest("hex") !== keyId) {
      fail("embedded lifecycle root key ID does not match its public key");
    }
    const key = createPublicKey({ key: bytes, format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519") {
      fail("embedded lifecycle root key is not Ed25519");
    }
    keys.set(keyId, key);
  }
  if (!Array.isArray(envelope.signatures) || envelope.signatures.length < 2) {
    fail("embedded lifecycle root signature threshold was not met");
  }
  let priorKeyId = null;
  const signatures = [];
  for (const signature of envelope.signatures) {
    exactKeys(signature, ["keyId", "signature"], "embedded lifecycle root signature");
    if (
      !DIGEST_PATTERN.test(signature.keyId || "") ||
      (priorKeyId !== null && priorKeyId.localeCompare(signature.keyId) >= 0)
    ) {
      fail("embedded lifecycle root signatures must use unique sorted root key IDs");
    }
    priorKeyId = signature.keyId;
    const bytes = canonicalRootBase64(
      signature.signature,
      `embedded lifecycle root signature ${signature.keyId}`,
    );
    if (bytes.length !== 64) {
      fail("embedded lifecycle root contains an invalid Ed25519 signature");
    }
    signatures.push(Object.freeze({ keyId: signature.keyId, bytes }));
  }

  const authority = envelope.signed.releaseAuthority;
  exactKeys(
    authority,
    ["type", "repository", "workflow", "sourceRefPrefix", "denySelfHostedRunners"],
    "embedded lifecycle release authority",
  );
  if (
    authority.type !== "github-artifact-attestation-v1" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(authority.repository || "") ||
    authority.workflow !== `${authority.repository}/.github/workflows/hosted-runtime-release.yml` ||
    authority.sourceRefPrefix !== "refs/tags/v" ||
    !authority.denySelfHostedRunners
  ) {
    fail("embedded lifecycle release authority is invalid");
  }
  exactKeys(
    envelope.signed.revocations,
    ["releaseVersions", "targetDigests"],
    "embedded lifecycle revocations",
  );
  const revocations = Object.freeze({
    releaseVersions: canonicalSortedUnique(
      envelope.signed.revocations.releaseVersions,
      VERSION_PATTERN,
      "embedded revoked lifecycle releases",
    ),
    targetDigests: canonicalSortedUnique(
      envelope.signed.revocations.targetDigests,
      DIGEST_PATTERN,
      "embedded revoked lifecycle target digests",
    ),
  });
  return Object.freeze({
    envelope,
    signed: envelope.signed,
    version: envelope.signed.version,
    digest: createHash("sha256").update(canonicalRootBytes(envelope)).digest("hex"),
    keys,
    root: Object.freeze({
      keyIds: Object.freeze([...envelope.signed.root.keyIds]),
      threshold: envelope.signed.root.threshold,
    }),
    signatures: Object.freeze(signatures),
    releaseAuthority: Object.freeze({ ...authority }),
    revocations,
  });
}

function verifyLifecycleRootSignatures(candidate, roots, { rejectUnknown = true } = {}) {
  const keys = new Map();
  for (const root of roots) {
    for (const [keyId, key] of root.keys) {
      const prior = keys.get(keyId);
      if (
        prior &&
        prior
          .export({ format: "der", type: "spki" })
          .compare(key.export({ format: "der", type: "spki" })) !== 0
      ) {
        fail("lifecycle roots disagree about one key ID");
      }
      keys.set(keyId, key);
    }
  }
  const payload = canonicalRootBytes(candidate.signed);
  const verified = new Set();
  for (const signature of candidate.signatures) {
    const key = keys.get(signature.keyId);
    if (!key) {
      if (rejectUnknown) {
        fail("embedded lifecycle root contains a signature outside the trusted root roles");
      }
      continue;
    }
    if (!verifyBytes(null, payload, key, signature.bytes)) {
      fail("embedded lifecycle root contains an invalid Ed25519 signature");
    }
    verified.add(signature.keyId);
  }
  return verified;
}

function requireLifecycleRootThreshold(root, verified) {
  if (root.root.keyIds.filter((keyId) => verified.has(keyId)).length < root.root.threshold) {
    fail("embedded lifecycle root signature threshold was not met");
  }
}

function verifyLifecycleRootTransition(
  trustedEnvelope,
  candidateEnvelope,
  { previousState, now = Date.now() } = {},
) {
  const trusted = parseLifecycleRootPolicy(trustedEnvelope, now);
  requireLifecycleRootThreshold(
    trusted,
    verifyLifecycleRootSignatures(trusted, [trusted], { rejectUnknown: false }),
  );
  if (
    !previousState ||
    previousState.rootVersion !== trusted.version ||
    previousState.rootSha256 !== trusted.digest
  ) {
    fail("persisted lifecycle root does not match its trusted state floor");
  }
  if (
    trusted.digest ===
    createHash("sha256").update(canonicalRootBytes(candidateEnvelope)).digest("hex")
  ) {
    return trusted;
  }
  const candidate = parseLifecycleRootPolicy(candidateEnvelope, now);
  if (candidate.version !== trusted.version + 1) {
    fail("lifecycle root rotation must advance exactly one version");
  }
  const verified = verifyLifecycleRootSignatures(candidate, [trusted, candidate]);
  requireLifecycleRootThreshold(trusted, verified);
  requireLifecycleRootThreshold(candidate, verified);
  return candidate;
}

const EMBEDDED_LIFECYCLE_ROOT = verifyEmbeddedLifecycleRootPolicy();

function assertLifecycleReleaseAllowed(root, version, targetDigests = []) {
  if (root.revocations.releaseVersions.includes(version)) {
    fail(`lifecycle release v${version} is revoked by the trusted root`);
  }
  if (
    !Array.isArray(targetDigests) ||
    targetDigests.some((digest) => !DIGEST_PATTERN.test(digest || ""))
  ) {
    fail("lifecycle target digests are invalid");
  }
  if (targetDigests.some((digest) => root.revocations.targetDigests.includes(digest))) {
    fail("lifecycle target digest is revoked by the trusted root");
  }
}

function parsePositiveId(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    fail(`${label} must be a positive integer`);
  }
  return parsed;
}

function parseVersion(value) {
  const version = String(value ?? "")
    .trim()
    .replace(/^v/u, "");
  if (!VERSION_PATTERN.test(version)) {
    fail("version must be one exact semantic release version");
  }
  return version;
}

function compareVersions(left, right) {
  const parse = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u.exec(value);
    return match
      ? { core: match.slice(1, 4).map(Number), prerelease: match[4]?.split(".") ?? [] }
      : null;
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) {
    return null;
  }
  for (let index = 0; index < a.core.length; index += 1) {
    if (a.core[index] !== b.core[index]) {
      return a.core[index] < b.core[index] ? -1 : 1;
    }
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const l = a.prerelease[index];
    const r = b.prerelease[index];
    if (l === r) {
      continue;
    }
    if (l === undefined || r === undefined) {
      return l === undefined ? -1 : 1;
    }
    const ln = /^\d+$/u.test(l);
    const rn = /^\d+$/u.test(r);
    if (ln && rn) {
      return Number(l) < Number(r) ? -1 : 1;
    }
    if (ln !== rn) {
      return ln ? -1 : 1;
    }
    return l < r ? -1 : 1;
  }
  return 0;
}

function platformIdentity(arch = process.arch) {
  if (arch === "x64") {
    return "linux-x64";
  }
  if (arch === "arm64") {
    return "linux-arm64";
  }
  fail(`unsupported lifecycle supervisor architecture: ${arch}`);
}

function lifecyclePaths(profile, instanceId = null) {
  if (profile === "hosting") {
    return Object.freeze({
      profile,
      publicSocketPath: "/run/fased-host-updater/request.sock",
      privateSocketPath: "/run/fased-host-controller/controller.sock",
      stateDir: "/var/lib/fased-host-updater",
      supervisorStateDir: "/var/lib/fased-host-updater/supervisor",
      releasesDir: "/opt/fased/host-controller/releases",
      currentLink: "/opt/fased/host-controller/current",
      controllerVersionPath: "/var/lib/fased-host-updater/supervisor/controller-version.json",
      rollbackFloorPath: "/var/lib/fased-host-updater/supervisor/rollback-floor",
      trustedRootPath: "/var/lib/fased-host-updater/supervisor/trusted-root.json",
      trustStatePath: "/var/lib/fased-host-updater/supervisor/trust-state.json",
      supervisorTransactionPath:
        "/var/lib/fased-host-updater/supervisor/controller-transaction.json",
      channelPath: "/etc/fased/host-updater-channel",
      supervisorPath: "/opt/fased/host-controller/supervisor/fased-lifecycle-supervisor.mjs",
      controllerUnit: "fased-host-controller.service",
      supervisorUnit: "fased-host-updater.service",
    });
  }
  if (profile !== "protected-local" || !INSTANCE_ID_PATTERN.test(instanceId || "")) {
    fail("lifecycle supervisor profile or Protected Local instance is invalid");
  }
  const runtime = `/run/fased-local-controller/${instanceId}`;
  const state = `/var/lib/fased-local/${instanceId}/controller`;
  const install = `/opt/fased/local/${instanceId}`;
  return Object.freeze({
    profile,
    instanceId,
    publicSocketPath: `${runtime}/request.sock`,
    privateSocketPath: `/run/fased-local-controller-worker/${instanceId}/controller.sock`,
    stateDir: state,
    supervisorStateDir: `${state}/supervisor`,
    releasesDir: `${install}/controller/releases`,
    currentLink: `${install}/controller/current`,
    controllerVersionPath: `${state}/supervisor/controller-version.json`,
    rollbackFloorPath: `${state}/supervisor/rollback-floor`,
    trustedRootPath: `${state}/supervisor/trusted-root.json`,
    trustStatePath: `${state}/supervisor/trust-state.json`,
    supervisorTransactionPath: `${state}/supervisor/controller-transaction.json`,
    channelPath: `/etc/fased/local/${instanceId}/update-channel`,
    supervisorPath: `${install}/supervisor/fased-lifecycle-supervisor.mjs`,
    controllerUnit: `fased-local-controller-worker-${instanceId}.service`,
    supervisorUnit: `fased-local-controller-${instanceId}.service`,
  });
}

export function parseSupervisorConfiguration(argv = process.argv.slice(2)) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || values.has(key)) {
      fail("lifecycle supervisor arguments must be unique --name value pairs");
    }
    values.set(key, value);
  }
  const allowed = new Set([
    "--profile",
    "--protected-local-instance",
    "--operator-uid",
    "--operator-gid",
  ]);
  for (const key of values.keys()) {
    if (!allowed.has(key)) {
      fail(`unsupported lifecycle supervisor argument: ${key}`);
    }
  }
  const profile = values.get("--profile");
  if (!new Set(["hosting", "protected-local"]).has(profile)) {
    fail("--profile must be hosting or protected-local");
  }
  const instanceId = values.get("--protected-local-instance") ?? null;
  if (
    (profile === "hosting" && instanceId !== null) ||
    (profile === "protected-local" && !INSTANCE_ID_PATTERN.test(instanceId || ""))
  ) {
    fail("lifecycle supervisor instance selector does not match its profile");
  }
  return Object.freeze({
    profile,
    instanceId,
    operatorUid: parsePositiveId(values.get("--operator-uid"), "operator UID"),
    operatorGid: parsePositiveId(values.get("--operator-gid"), "operator GID"),
    paths: lifecyclePaths(profile, instanceId),
  });
}

export function parseSupervisorRequest(value) {
  exactKeys(
    value,
    ["schemaVersion", "op", "transactionId", "version"],
    "lifecycle supervisor request",
  );
  if (value.schemaVersion !== 2) {
    fail("unsupported lifecycle supervisor request schema");
  }
  const op = String(value.op ?? "");
  if (op !== "updateController" && !CONTROLLER_OPERATIONS.has(op)) {
    fail("unsupported lifecycle supervisor operation");
  }
  const transactionId = String(value.transactionId ?? "")
    .trim()
    .toLowerCase();
  if (!TRANSACTION_ID_PATTERN.test(transactionId)) {
    fail("lifecycle supervisor transactionId must be a UUIDv4");
  }
  return Object.freeze({
    schemaVersion: 2,
    op,
    transactionId,
    version: parseVersion(value.version),
  });
}

export function parseLifecycleTrustMetadata(
  value,
  { expectedVersion, channel, platform = platformIdentity(), now = Date.now() },
) {
  exactKeys(
    value,
    ["schemaVersion", "role", "rootPolicy", "release", "validity", "policy", "targets", "evidence"],
    "lifecycle trust metadata",
  );
  exactKeys(value.release, ["version", "tag", "commit"], "lifecycle release identity");
  exactKeys(value.validity, ["issuedAt", "expiresAt"], "lifecycle metadata validity");
  exactKeys(
    value.policy,
    ["channels", "platforms", "supervisorProtocol", "controllerProtocol"],
    "lifecycle metadata policy",
  );
  exactKeys(
    value.targets,
    ["bootstrap", "supervisor", "controllerServer", "controllerClient", "evidenceVerifier"],
    "lifecycle metadata targets",
  );
  exactKeys(value.evidence, ["provenance", "sbom", "vex"], "lifecycle metadata evidence");
  for (const [role, target] of Object.entries(value.targets)) {
    exactKeys(target, ["asset", "sha256"], `lifecycle ${role} target`);
  }
  exactKeys(value.rootPolicy, ["schemaVersion", "signed", "signatures"], "lifecycle root policy");
  const version = parseVersion(value.release.version);
  const issuedAt = Date.parse(value.validity.issuedAt);
  const expiresAt = Date.parse(value.validity.expiresAt);
  const expectedAssets = {
    bootstrap: "install.sh",
    supervisor: SUPERVISOR_NAME,
    controllerServer: CONTROLLER_SERVER_NAME,
    controllerClient: CONTROLLER_CLIENT_NAME,
    evidenceVerifier: EVIDENCE_VERIFIER_NAME,
  };
  const expectedEvidence = {
    provenance: PRIVILEGED_PROVENANCE_NAME,
    sbom: PRIVILEGED_SBOM_NAME,
    vex: PRIVILEGED_VEX_NAME,
  };
  const expectedChannels = version.includes("-") ? ["beta"] : ["beta", "stable"];
  const expectedPlatforms = ["linux-arm64", "linux-x64"];
  if (
    value.schemaVersion !== SUPERVISOR_SCHEMA_VERSION ||
    value.role !== "fased-lifecycle-targets" ||
    version !== expectedVersion ||
    value.release.tag !== `v${version}` ||
    !COMMIT_PATTERN.test(value.release.commit || "") ||
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt) ||
    new Date(issuedAt).toISOString() !== value.validity.issuedAt ||
    new Date(expiresAt).toISOString() !== value.validity.expiresAt ||
    issuedAt >= expiresAt ||
    expiresAt - issuedAt > MAX_METADATA_VALIDITY_MS ||
    now > expiresAt ||
    now < issuedAt ||
    JSON.stringify(value.policy.channels) !== JSON.stringify(expectedChannels) ||
    !value.policy.channels.includes(channel) ||
    JSON.stringify(value.policy.platforms) !== JSON.stringify(expectedPlatforms) ||
    !value.policy.platforms.includes(platform) ||
    value.policy.supervisorProtocol !== SUPERVISOR_PROTOCOL_VERSION ||
    value.policy.controllerProtocol !== CONTROLLER_PROTOCOL_VERSION
  ) {
    fail("lifecycle trust metadata is stale, incompatible, or mismatched");
  }
  for (const [role, expectedAsset] of Object.entries(expectedAssets)) {
    const target = value.targets[role];
    if (target.asset !== expectedAsset || !DIGEST_PATTERN.test(target.sha256 || "")) {
      fail(`lifecycle ${role} target identity is invalid`);
    }
  }
  for (const [role, expectedAsset] of Object.entries(expectedEvidence)) {
    const evidence = value.evidence[role];
    exactKeys(evidence, ["asset", "sha256"], `lifecycle ${role} evidence`);
    if (evidence.asset !== expectedAsset || !DIGEST_PATTERN.test(evidence.sha256 || "")) {
      fail(`lifecycle ${role} evidence identity is invalid`);
    }
  }
  return Object.freeze(value);
}

async function fsyncDirectory(directory) {
  const handle = await fsp.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicWrite(targetPath, content, mode = 0o600) {
  await fsp.mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  const handle = await fsp.open(temporaryPath, "wx", mode);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.chmod(temporaryPath, mode);
  await fsp.rename(temporaryPath, targetPath);
  await fsyncDirectory(path.dirname(targetPath));
}

async function atomicCopy(sourcePath, targetPath, mode = 0o755) {
  await fsp.mkdir(path.dirname(targetPath), { recursive: true, mode: 0o755 });
  const temporaryPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  await fsp.copyFile(sourcePath, temporaryPath, fs.constants.COPYFILE_EXCL);
  await fsp.chmod(temporaryPath, mode);
  const handle = await fsp.open(temporaryPath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(temporaryPath, targetPath);
  await fsyncDirectory(path.dirname(targetPath));
}

async function atomicSymlink(target, linkPath) {
  await fsp.mkdir(path.dirname(linkPath), { recursive: true, mode: 0o755 });
  try {
    const existing = await fsp.lstat(linkPath);
    if (!existing.isSymbolicLink()) {
      fail("controller current path must remain a root-managed symlink");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  const temporaryPath = `${linkPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fsp.symlink(target, temporaryPath, "dir");
    await fsp.rename(temporaryPath, linkPath);
    await fsyncDirectory(path.dirname(linkPath));
  } finally {
    await fsp.rm(temporaryPath, { force: true });
  }
}

async function sha256(filePath) {
  const hash = createHash("sha256");
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest("hex");
}

async function download(url, destination) {
  const response = await fetch(url, {
    headers: { "cache-control": "no-cache" },
    redirect: "follow",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok || !response.body) {
    fail(`official lifecycle release download failed (${response.status})`);
  }
  const advertised = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertised) && advertised > MAX_DOWNLOAD_BYTES) {
    fail("official lifecycle release asset exceeds its fixed size limit");
  }
  let received = 0;
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      callback(
        received > MAX_DOWNLOAD_BYTES
          ? new Error("official lifecycle release asset exceeds its fixed size limit")
          : null,
        chunk,
      );
    },
  });
  await pipeline(response.body, limiter, fs.createWriteStream(destination, { mode: 0o600 }));
}

async function sealSupervisorArtifact(filePath, rootUid, rootGid) {
  const before = await fsp.lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    fail("downloaded lifecycle release asset is not a regular single-link file");
  }
  await fsp.chown(filePath, rootUid, rootGid);
  await fsp.chmod(filePath, 0o600);
  const after = await fsp.lstat(filePath);
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    after.nlink !== 1 ||
    after.uid !== rootUid ||
    after.gid !== rootGid ||
    (after.mode & 0o777) !== 0o600
  ) {
    fail("downloaded lifecycle release asset did not converge to root-only ownership");
  }
}

async function privateMkdtemp(prefix, rootUid, rootGid, operations = fsp) {
  const directory = await operations.mkdtemp(prefix);
  try {
    const before = await operations.lstat(directory);
    if (!before.isDirectory() || before.isSymbolicLink()) {
      fail("lifecycle transaction directory is not a private directory");
    }
    await operations.chown(directory, rootUid, rootGid);
    await operations.chmod(directory, 0o700);
    const after = await operations.lstat(directory);
    if (
      !after.isDirectory() ||
      after.isSymbolicLink() ||
      after.uid !== rootUid ||
      after.gid !== rootGid ||
      (after.mode & 0o777) !== 0o700
    ) {
      fail("lifecycle transaction directory did not converge to root-only access");
    }
    return directory;
  } catch (error) {
    await operations.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function fixedExecutable(candidates, label) {
  for (const candidate of candidates) {
    try {
      const resolved = await fsp.realpath(candidate);
      const info = await fsp.stat(resolved);
      if (!info.isFile() || info.uid !== 0 || (info.mode & 0o022) !== 0) {
        continue;
      }
      await fsp.access(resolved, fs.constants.X_OK);
      return resolved;
    } catch {
      // Try the next fixed system path.
    }
  }
  fail(`${label} is unavailable from a root-controlled system path`);
}

async function verifyMetadata(metadataPath, bundlePath, version, stateDir, trustedRoot) {
  assertLifecycleReleaseAllowed(trustedRoot, version);
  const gh = await fixedExecutable(["/usr/bin/gh", "/usr/local/bin/gh"], "GitHub CLI");
  const authority = trustedRoot.releaseAuthority;
  await execFileAsync(
    gh,
    [
      "attestation",
      "verify",
      metadataPath,
      "--repo",
      authority.repository,
      "--bundle",
      bundlePath,
      "--signer-workflow",
      authority.workflow,
      "--source-ref",
      `${authority.sourceRefPrefix}${version}`,
      ...(authority.denySelfHostedRunners ? ["--deny-self-hosted-runners"] : []),
    ],
    {
      env: {
        HOME: stateDir,
        PATH: "/usr/local/bin:/usr/bin:/bin",
        GH_PROMPT_DISABLED: "1",
      },
      timeout: REQUEST_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
}

async function selfCheckController(assetPath, role, stateDir) {
  const { stdout } = await execFileAsync(process.execPath, [assetPath, "--self-check"], {
    env: { HOME: stateDir, PATH: "/usr/local/bin:/usr/bin:/bin" },
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  const value = JSON.parse(stdout);
  exactKeys(
    value,
    ["schemaVersion", "protocolVersion", "role"],
    `lifecycle controller ${role} self-check`,
  );
  if (value.schemaVersion !== 1 || value.protocolVersion !== 2 || value.role !== role) {
    fail(`lifecycle controller ${role} self-check is incompatible`);
  }
}

async function selfCheckSupervisor(assetPath, stateDir) {
  const { stdout } = await execFileAsync(process.execPath, [assetPath, "--self-check"], {
    env: { HOME: stateDir, PATH: "/usr/local/bin:/usr/bin:/bin" },
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  const value = JSON.parse(stdout);
  exactKeys(value, ["schemaVersion", "protocolVersion", "role"], "lifecycle supervisor self-check");
  if (
    value.schemaVersion !== SUPERVISOR_SCHEMA_VERSION ||
    value.protocolVersion !== SUPERVISOR_PROTOCOL_VERSION ||
    value.role !== "lifecycle-supervisor"
  ) {
    fail("lifecycle supervisor self-check is incompatible");
  }
}

async function verifyReleaseEvidence(verifierPath, verifierSha256, options) {
  const verifier = await import(`${pathToFileURL(verifierPath).href}?sha256=${verifierSha256}`);
  if (typeof verifier.verifyPrivilegedReleaseEvidence !== "function") {
    fail("privileged release evidence verifier API is unavailable");
  }
  return await verifier.verifyPrivilegedReleaseEvidence(options);
}

async function readChannel(channelPath) {
  const channel = (await fsp.readFile(channelPath, "utf8")).trim();
  if (!new Set(["stable", "beta"]).has(channel)) {
    fail("lifecycle update channel is invalid");
  }
  return channel;
}

async function readRollbackFloor(paths) {
  try {
    return parseVersion(await fsp.readFile(paths.rollbackFloorPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function initialLifecycleTrustState() {
  return Object.freeze({
    schemaVersion: 1,
    rootVersion: EMBEDDED_LIFECYCLE_ROOT.version,
    rootSha256: EMBEDDED_LIFECYCLE_ROOT.digest,
    targetsVersion: null,
    targetsCommit: null,
    targetsSha256: null,
  });
}

function parseLifecycleTrustState(value, root) {
  exactKeys(
    value,
    [
      "schemaVersion",
      "rootVersion",
      "rootSha256",
      "targetsVersion",
      "targetsCommit",
      "targetsSha256",
    ],
    "persisted lifecycle trust state",
  );
  const emptyTargets =
    value.targetsVersion === null && value.targetsCommit === null && value.targetsSha256 === null;
  const populatedTargets =
    VERSION_PATTERN.test(value.targetsVersion || "") &&
    COMMIT_PATTERN.test(value.targetsCommit || "") &&
    DIGEST_PATTERN.test(value.targetsSha256 || "");
  if (
    value.schemaVersion !== 1 ||
    value.rootVersion !== root.version ||
    value.rootSha256 !== root.digest ||
    (!emptyTargets && !populatedTargets)
  ) {
    fail("persisted lifecycle trust state is malformed or mismatched");
  }
  return Object.freeze({ ...value });
}

async function readProtectedJson(filePath, label, rootUid) {
  const info = await fsp.lstat(filePath);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.uid !== rootUid ||
    (info.mode & 0o077) !== 0 ||
    info.size <= 0 ||
    info.size > MAX_DOWNLOAD_BYTES
  ) {
    fail(`${label} is not one protected root-owned file`);
  }
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
}

async function readLifecycleTrust(paths, rootUid, now = Date.now()) {
  let rootExists = true;
  let stateExists = true;
  try {
    await fsp.access(paths.trustedRootPath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
    rootExists = false;
  }
  try {
    await fsp.access(paths.trustStatePath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
    stateExists = false;
  }
  if (!rootExists && !stateExists) {
    return Object.freeze({
      root: EMBEDDED_LIFECYCLE_ROOT,
      envelope: INITIAL_LIFECYCLE_ROOT_ENVELOPE,
      state: initialLifecycleTrustState(),
      persisted: false,
    });
  }
  if (!rootExists || !stateExists) {
    fail("persisted lifecycle root and trust state must exist together");
  }
  const envelope = await readProtectedJson(
    paths.trustedRootPath,
    "persisted lifecycle root",
    rootUid,
  );
  const root = parseLifecycleRootPolicy(envelope, now);
  requireLifecycleRootThreshold(
    root,
    verifyLifecycleRootSignatures(root, [root], { rejectUnknown: false }),
  );
  const state = parseLifecycleTrustState(
    await readProtectedJson(paths.trustStatePath, "persisted lifecycle trust state", rootUid),
    root,
  );
  return Object.freeze({ root, envelope, state, persisted: true });
}

function advanceLifecycleTrustState(trusted, candidateRoot, metadata) {
  const targetsSha256 = createHash("sha256").update(canonicalRootBytes(metadata)).digest("hex");
  const previous = trusted.state;
  if (previous.targetsVersion !== null) {
    const comparison = compareVersions(metadata.release.version, previous.targetsVersion);
    if (comparison === null || comparison < 0) {
      fail("lifecycle targets metadata is below its trusted release floor");
    }
    if (
      comparison === 0 &&
      (metadata.release.commit !== previous.targetsCommit ||
        targetsSha256 !== previous.targetsSha256)
    ) {
      fail("lifecycle targets metadata changed without advancing its release version");
    }
  }
  return Object.freeze({
    schemaVersion: 1,
    rootVersion: candidateRoot.version,
    rootSha256: candidateRoot.digest,
    targetsVersion: metadata.release.version,
    targetsCommit: metadata.release.commit,
    targetsSha256,
  });
}

async function readControllerIdentity(paths) {
  try {
    const value = JSON.parse(await fsp.readFile(paths.controllerVersionPath, "utf8"));
    exactKeys(
      value,
      ["schemaVersion", "version", "serverSha256", "clientSha256"],
      "controller identity",
    );
    const version = parseVersion(value.version);
    if (
      value.schemaVersion !== 1 ||
      !DIGEST_PATTERN.test(value.serverSha256 || "") ||
      !DIGEST_PATTERN.test(value.clientSha256 || "")
    ) {
      fail("controller identity is malformed");
    }
    return Object.freeze({ ...value, version });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function controllerGenerationDigests(generationRoot, expectedRootUid = 0) {
  const info = await fsp.lstat(generationRoot);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    fail("controller generation must be one real directory");
  }
  const entries = await fsp.readdir(generationRoot);
  if (
    entries.toSorted().join(",") !==
    [CONTROLLER_CLIENT_NAME, CONTROLLER_SERVER_NAME].toSorted().join(",")
  ) {
    fail("controller generation contains unsupported files");
  }
  const result = {};
  for (const [role, asset] of [
    ["serverSha256", CONTROLLER_SERVER_NAME],
    ["clientSha256", CONTROLLER_CLIENT_NAME],
  ]) {
    const candidate = path.join(generationRoot, asset);
    const candidateInfo = await fsp.lstat(candidate);
    if (
      !candidateInfo.isFile() ||
      candidateInfo.isSymbolicLink() ||
      candidateInfo.nlink !== 1 ||
      candidateInfo.uid !== expectedRootUid ||
      (candidateInfo.mode & 0o022) !== 0
    ) {
      fail("controller generation target is not root-owned and immutable");
    }
    result[role] = await sha256(candidate);
  }
  return result;
}

async function currentControllerMatches(paths, identity, expectedRootUid = 0) {
  try {
    const target = await fsp.realpath(paths.currentLink);
    const expected = path.join(paths.releasesDir, `v${identity.version}`);
    if (target !== expected) {
      return false;
    }
    const digests = await controllerGenerationDigests(target, expectedRootUid);
    return (
      digests.serverSha256 === identity.serverSha256 &&
      digests.clientSha256 === identity.clientSha256
    );
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function cleanupHistoricalControllerCandidates(paths, version, expectedRootUid = 0) {
  const releasesRoot = path.resolve(paths.releasesDir);
  let entries;
  try {
    entries = await fsp.readdir(releasesRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const candidates = entries.filter((entry) =>
    HISTORICAL_CONTROLLER_CANDIDATE_PATTERN.test(entry.name),
  );
  if (candidates.length === 0) {
    return [];
  }
  const expectedActive = path.join(releasesRoot, `v${parseVersion(version)}`);
  const active = await fsp.realpath(paths.currentLink);
  if (active !== expectedActive) {
    fail("supervisor-selected controller did not converge before historical cleanup");
  }

  const removed = [];
  for (const entry of candidates) {
    const candidate = path.join(releasesRoot, entry.name);
    const before = await fsp.lstat(candidate);
    if (
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      !before.isDirectory() ||
      before.isSymbolicLink() ||
      before.uid !== expectedRootUid ||
      (before.mode & 0o022) !== 0
    ) {
      fail("historical controller candidate is unsafe");
    }
    await controllerGenerationDigests(candidate, expectedRootUid);
    const revalidated = await fsp.lstat(candidate);
    if (
      !revalidated.isDirectory() ||
      revalidated.isSymbolicLink() ||
      revalidated.dev !== before.dev ||
      revalidated.ino !== before.ino
    ) {
      fail("historical controller candidate changed during cleanup");
    }
    await fsp.rm(candidate, { recursive: true });
    removed.push(candidate);
  }
  if (removed.length > 0) {
    await fsyncDirectory(releasesRoot);
  }
  return removed;
}

function supervisorGenerationPath(paths, digest) {
  if (!DIGEST_PATTERN.test(digest || "")) {
    fail("lifecycle supervisor generation digest is invalid");
  }
  return path.join(paths.supervisorStateDir, "supervisor-generations", `${digest}.mjs`);
}

async function assertSupervisorGeneration(filePath, digest, rootUid, rootGid) {
  const info = await fsp.lstat(filePath);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.uid !== rootUid ||
    info.gid !== rootGid ||
    (info.mode & 0o022) !== 0 ||
    (await sha256(filePath)) !== digest
  ) {
    fail("lifecycle supervisor generation is not root-owned and immutable");
  }
  return filePath;
}

async function preserveSupervisorGeneration(sourcePath, digest, rootUid, rootGid, paths) {
  const generationPath = supervisorGenerationPath(paths, digest);
  try {
    return await assertSupervisorGeneration(generationPath, digest, rootUid, rootGid);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  await fsp.mkdir(path.dirname(generationPath), { recursive: true, mode: 0o700 });
  await fsp.chown(path.dirname(generationPath), rootUid, rootGid);
  await fsp.chmod(path.dirname(generationPath), 0o700);
  await atomicCopy(sourcePath, generationPath, 0o700);
  await fsp.chown(generationPath, rootUid, rootGid);
  await fsp.chmod(generationPath, 0o700);
  return await assertSupervisorGeneration(generationPath, digest, rootUid, rootGid);
}

async function activateStagedSupervisor(paths, staged, rootUid = 0, rootGid = 0) {
  if (!staged.supervisorChanged) {
    return;
  }
  await assertSupervisorGeneration(
    staged.targetSupervisorGeneration,
    staged.targetSupervisorDigest,
    rootUid,
    rootGid,
  );
  await atomicCopy(staged.targetSupervisorGeneration, paths.supervisorPath, 0o755);
  await fsp.chown(paths.supervisorPath, rootUid, rootGid);
  await fsp.chmod(paths.supervisorPath, 0o755);
  if ((await sha256(paths.supervisorPath)) !== staged.targetSupervisorDigest) {
    fail("activated lifecycle supervisor does not match its trusted target");
  }
}

async function restoreSupervisorSelection(paths, staged, rootUid = 0, rootGid = 0) {
  if (!staged.supervisorChanged) {
    return;
  }
  const previousPath = supervisorGenerationPath(paths, staged.previousSupervisorDigest);
  await assertSupervisorGeneration(previousPath, staged.previousSupervisorDigest, rootUid, rootGid);
  await atomicCopy(previousPath, paths.supervisorPath, 0o755);
  await fsp.chown(paths.supervisorPath, rootUid, rootGid);
  await fsp.chmod(paths.supervisorPath, 0o755);
  if ((await sha256(paths.supervisorPath)) !== staged.previousSupervisorDigest) {
    fail("restored lifecycle supervisor does not match its prior generation");
  }
}

async function durableReceipt(paths, request, result) {
  const receipt = {
    schemaVersion: 1,
    transactionId: request.transactionId,
    operation: request.op,
    version: request.version,
    outcome: result.outcome,
    controllerChanged: result.controllerChanged === true,
    phase: result.phase ?? null,
    release: result.release ?? null,
    ...(result.selectionDigest ? { selectionDigest: result.selectionDigest } : {}),
    recordedAt: new Date().toISOString(),
  };
  await atomicWrite(
    path.join(paths.supervisorStateDir, "receipts", `${request.transactionId}.json`),
    `${JSON.stringify(receipt, null, 2)}\n`,
    0o600,
  );
  return receipt;
}

async function readDurableReceipt(paths, request) {
  try {
    const receipt = JSON.parse(
      await fsp.readFile(
        path.join(paths.supervisorStateDir, "receipts", `${request.transactionId}.json`),
        "utf8",
      ),
    );
    if (
      receipt?.schemaVersion !== 1 ||
      receipt.transactionId !== request.transactionId ||
      receipt.operation !== request.op ||
      receipt.version !== request.version
    ) {
      return null;
    }
    return receipt;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function stageTrustedController(request, context) {
  const { paths } = context;
  const channel = await context.readChannel(paths.channelPath);
  const trusted = await context.readLifecycleTrust(paths, context.rootUid, context.now());
  const floor = await context.readRollbackFloor(paths);
  if (floor && compareVersions(request.version, floor) === -1) {
    fail(`controller release v${request.version} is below rollback floor v${floor}`);
  }
  const existing = await context.readControllerIdentity(paths);
  if (existing && compareVersions(existing.version, request.version) === 1) {
    fail(`refusing controller downgrade from ${existing.version} to ${request.version}`);
  }
  const existingSelectionMatches = existing
    ? await context.currentControllerMatches(paths, existing, context.rootUid)
    : false;
  const targetAlreadySelected = existing?.version === request.version && existingSelectionMatches;

  await Promise.all([
    fsp.mkdir(paths.supervisorStateDir, { recursive: true, mode: 0o700 }),
    fsp.mkdir(paths.releasesDir, { recursive: true, mode: 0o755 }),
  ]);
  const downloadRoot = await privateMkdtemp(
    path.join(paths.supervisorStateDir, `.download-${request.version}-`),
    context.rootUid,
    context.rootGid,
  );
  const releaseUrl = `${RELEASE_BASE}/v${request.version}`;
  const metadataPath = path.join(downloadRoot, TRUST_METADATA_NAME);
  const bundlePath = path.join(downloadRoot, TRUST_METADATA_BUNDLE_NAME);
  const targetSupervisorPath = path.join(downloadRoot, SUPERVISOR_NAME);
  const serverPath = path.join(downloadRoot, CONTROLLER_SERVER_NAME);
  const clientPath = path.join(downloadRoot, CONTROLLER_CLIENT_NAME);
  const evidenceVerifierPath = path.join(downloadRoot, EVIDENCE_VERIFIER_NAME);
  const releaseManifestPath = path.join(downloadRoot, RELEASE_MANIFEST_NAME);
  const provenancePath = path.join(downloadRoot, PRIVILEGED_PROVENANCE_NAME);
  const provenanceBundlePath = path.join(downloadRoot, PRIVILEGED_PROVENANCE_BUNDLE_NAME);
  const sbomPath = path.join(downloadRoot, PRIVILEGED_SBOM_NAME);
  const vexPath = path.join(downloadRoot, PRIVILEGED_VEX_NAME);
  let stagingGeneration = null;
  try {
    await Promise.all([
      context.download(`${releaseUrl}/${TRUST_METADATA_NAME}`, metadataPath),
      context.download(`${releaseUrl}/${TRUST_METADATA_BUNDLE_NAME}`, bundlePath),
    ]);
    await Promise.all(
      [metadataPath, bundlePath].map(
        async (filePath) =>
          await context.sealSupervisorArtifact(filePath, context.rootUid, context.rootGid),
      ),
    );
    await context.verifyMetadata(
      metadataPath,
      bundlePath,
      request.version,
      paths.supervisorStateDir,
      trusted.root,
    );
    await Promise.all(
      [metadataPath, bundlePath].map(
        async (filePath) =>
          await context.sealSupervisorArtifact(filePath, context.rootUid, context.rootGid),
      ),
    );
    const metadata = parseLifecycleTrustMetadata(
      JSON.parse(await fsp.readFile(metadataPath, "utf8")),
      {
        expectedVersion: request.version,
        channel,
        platform: context.platform,
        now: context.now(),
      },
    );
    const candidateRoot = verifyLifecycleRootTransition(trusted.envelope, metadata.rootPolicy, {
      previousState: trusted.state,
      now: context.now(),
    });
    const trustState = advanceLifecycleTrustState(trusted, candidateRoot, metadata);
    assertLifecycleReleaseAllowed(
      candidateRoot,
      request.version,
      [...Object.values(metadata.targets), ...Object.values(metadata.evidence)].map(
        ({ sha256: targetSha256 }) => targetSha256,
      ),
    );
    await Promise.all([
      context.download(`${releaseUrl}/${metadata.targets.supervisor.asset}`, targetSupervisorPath),
      context.download(`${releaseUrl}/${metadata.targets.controllerServer.asset}`, serverPath),
      context.download(`${releaseUrl}/${metadata.targets.controllerClient.asset}`, clientPath),
      context.download(
        `${releaseUrl}/${metadata.targets.evidenceVerifier.asset}`,
        evidenceVerifierPath,
      ),
      context.download(`${releaseUrl}/${RELEASE_MANIFEST_NAME}`, releaseManifestPath),
      context.download(`${releaseUrl}/${metadata.evidence.provenance.asset}`, provenancePath),
      context.download(`${releaseUrl}/${PRIVILEGED_PROVENANCE_BUNDLE_NAME}`, provenanceBundlePath),
      context.download(`${releaseUrl}/${metadata.evidence.sbom.asset}`, sbomPath),
      context.download(`${releaseUrl}/${metadata.evidence.vex.asset}`, vexPath),
    ]);
    await Promise.all(
      [
        targetSupervisorPath,
        serverPath,
        clientPath,
        evidenceVerifierPath,
        releaseManifestPath,
        provenancePath,
        provenanceBundlePath,
        sbomPath,
        vexPath,
      ].map(
        async (filePath) =>
          await context.sealSupervisorArtifact(filePath, context.rootUid, context.rootGid),
      ),
    );
    const [
      targetSupervisorDigest,
      serverSha256,
      clientSha256,
      evidenceVerifierSha256,
      targetManifestSha256,
    ] = await Promise.all([
      sha256(targetSupervisorPath),
      sha256(serverPath),
      sha256(clientPath),
      sha256(evidenceVerifierPath),
      sha256(releaseManifestPath),
    ]);
    if (
      targetSupervisorDigest !== metadata.targets.supervisor.sha256 ||
      serverSha256 !== metadata.targets.controllerServer.sha256 ||
      clientSha256 !== metadata.targets.controllerClient.sha256 ||
      evidenceVerifierSha256 !== metadata.targets.evidenceVerifier.sha256
    ) {
      fail(
        "downloaded lifecycle supervisor, controller, or evidence verifier does not match trust metadata",
      );
    }
    await context.verifyMetadata(
      provenancePath,
      provenanceBundlePath,
      request.version,
      paths.supervisorStateDir,
      candidateRoot,
    );
    await Promise.all(
      [provenancePath, provenanceBundlePath].map(
        async (filePath) =>
          await context.sealSupervisorArtifact(filePath, context.rootUid, context.rootGid),
      ),
    );
    await context.verifyReleaseEvidence(evidenceVerifierPath, evidenceVerifierSha256, {
      releaseManifestPath,
      lifecycleMetadataPath: metadataPath,
      provenancePath,
      sbomPath,
      vexPath,
      expectedVersion: request.version,
      expectedCommit: metadata.release.commit,
    });
    await Promise.all([
      context.selfCheckSupervisor(targetSupervisorPath, paths.supervisorStateDir),
      context.selfCheckController(serverPath, "server", paths.supervisorStateDir),
      context.selfCheckController(clientPath, "client", paths.supervisorStateDir),
    ]);
    const previousSupervisorDigest = await sha256(paths.supervisorPath);
    if (previousSupervisorDigest !== context.runningSupervisorDigest) {
      fail("installed lifecycle supervisor changed beneath the running trusted process");
    }
    await assertSupervisorGeneration(
      paths.supervisorPath,
      previousSupervisorDigest,
      context.rootUid,
      context.rootGid,
    );
    const supervisorChanged = previousSupervisorDigest !== targetSupervisorDigest;
    const previousSupervisorGeneration = await preserveSupervisorGeneration(
      paths.supervisorPath,
      previousSupervisorDigest,
      context.rootUid,
      context.rootGid,
      paths,
    );
    const targetSupervisorGeneration = await preserveSupervisorGeneration(
      targetSupervisorPath,
      targetSupervisorDigest,
      context.rootUid,
      context.rootGid,
      paths,
    );
    const identity = {
      schemaVersion: 1,
      version: request.version,
      serverSha256,
      clientSha256,
    };
    const generationRoot = path.join(paths.releasesDir, `v${request.version}`);
    try {
      const digests = await controllerGenerationDigests(generationRoot, context.rootUid);
      if (digests.serverSha256 !== serverSha256 || digests.clientSha256 !== clientSha256) {
        fail(`controller generation v${request.version} is not immutable`);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      stagingGeneration = await privateMkdtemp(
        path.join(paths.releasesDir, `.generation-${request.version}-`),
        context.rootUid,
        context.rootGid,
      );
      await Promise.all([
        atomicCopy(serverPath, path.join(stagingGeneration, CONTROLLER_SERVER_NAME)),
        atomicCopy(clientPath, path.join(stagingGeneration, CONTROLLER_CLIENT_NAME)),
      ]);
      await fsp.chown(stagingGeneration, context.rootUid, context.rootGid);
      await fsp.chmod(stagingGeneration, 0o755);
      await fsyncDirectory(stagingGeneration);
      await fsp.rename(stagingGeneration, generationRoot);
      stagingGeneration = null;
      await fsyncDirectory(paths.releasesDir);
    }
    let previousGeneration = null;
    try {
      previousGeneration = await fsp.realpath(paths.currentLink);
      const releasesRoot = path.resolve(paths.releasesDir);
      if (
        path.dirname(previousGeneration) !== releasesRoot ||
        !/^v[0-9A-Za-z.-]+$/u.test(path.basename(previousGeneration))
      ) {
        fail("controller current symlink escapes its fixed releases directory");
      }
      await controllerGenerationDigests(previousGeneration, context.rootUid);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
    if ((previousGeneration === null) !== (existing === null)) {
      fail("controller selection and persisted identity must exist together");
    }
    if (
      previousGeneration &&
      (path.basename(previousGeneration) !== `v${existing.version}` || !existingSelectionMatches)
    ) {
      fail("controller selection does not match its persisted identity");
    }
    return {
      changed: !targetAlreadySelected || previousGeneration !== generationRoot,
      identity,
      generationRoot,
      previousGeneration,
      previousIdentity: existing,
      releaseCommit: metadata.release.commit,
      targetManifestSha256,
      supervisorChanged,
      previousSupervisorDigest,
      targetSupervisorDigest,
      previousSupervisorGeneration,
      targetSupervisorGeneration,
      trusted,
      candidateRoot,
      trustState,
      trustChanged:
        candidateRoot.digest !== trusted.root.digest ||
        JSON.stringify(trustState) !== JSON.stringify(trusted.state),
    };
  } finally {
    await Promise.all([
      fsp.rm(downloadRoot, { recursive: true, force: true }),
      stagingGeneration
        ? fsp.rm(stagingGeneration, { recursive: true, force: true })
        : Promise.resolve(),
    ]);
  }
}

async function activateStagedController(paths, staged) {
  if (!staged.changed) {
    return;
  }
  await atomicSymlink(staged.generationRoot, paths.currentLink);
  await atomicWrite(
    paths.controllerVersionPath,
    `${JSON.stringify(staged.identity, null, 2)}\n`,
    0o600,
  );
}

async function restoreControllerSelection(paths, staged) {
  if (staged.previousGeneration) {
    const releasesRoot = path.resolve(paths.releasesDir);
    const previous = path.resolve(staged.previousGeneration);
    if (
      path.dirname(previous) !== releasesRoot ||
      !/^v[0-9A-Za-z.-]+$/u.test(path.basename(previous))
    ) {
      fail("prior controller generation escapes its fixed releases directory");
    }
    await atomicSymlink(staged.previousGeneration, paths.currentLink);
  } else {
    await fsp.rm(paths.currentLink, { force: true });
    await fsyncDirectory(path.dirname(paths.currentLink));
  }
  if (staged.previousIdentity) {
    await atomicWrite(
      paths.controllerVersionPath,
      `${JSON.stringify(staged.previousIdentity, null, 2)}\n`,
      0o600,
    );
  } else {
    await fsp.rm(paths.controllerVersionPath, { force: true });
    await fsyncDirectory(path.dirname(paths.controllerVersionPath));
  }
}

async function commitLifecycleTrust(paths, staged) {
  if (!staged.trustChanged) {
    return;
  }
  await atomicWrite(
    paths.trustedRootPath,
    `${JSON.stringify(staged.candidateRoot.envelope, null, 2)}\n`,
    0o600,
  );
  await atomicWrite(paths.trustStatePath, `${JSON.stringify(staged.trustState, null, 2)}\n`, 0o600);
}

async function restoreLifecycleTrust(paths, trusted) {
  if (trusted.persisted) {
    await atomicWrite(
      paths.trustedRootPath,
      `${JSON.stringify(trusted.envelope, null, 2)}\n`,
      0o600,
    );
    await atomicWrite(paths.trustStatePath, `${JSON.stringify(trusted.state, null, 2)}\n`, 0o600);
    return;
  }
  await Promise.all([
    fsp.rm(paths.trustedRootPath, { force: true }),
    fsp.rm(paths.trustStatePath, { force: true }),
  ]);
  await fsyncDirectory(paths.supervisorStateDir);
}

function supervisorTransactionRecord(request, staged) {
  return Object.freeze({
    schemaVersion: 2,
    transactionId: request.transactionId,
    version: request.version,
    previousGenerationVersion: staged.previousGeneration
      ? path.basename(staged.previousGeneration).slice(1)
      : null,
    previousIdentity: staged.previousIdentity,
    supervisorChanged: staged.supervisorChanged === true,
    previousSupervisorDigest: staged.previousSupervisorDigest,
    targetSupervisorDigest: staged.targetSupervisorDigest,
    previousTrust: {
      persisted: staged.trusted.persisted,
      envelope: staged.trusted.persisted ? staged.trusted.envelope : null,
      state: staged.trusted.persisted ? staged.trusted.state : null,
    },
  });
}

function parseSupervisorTransaction(value, paths) {
  const schemaVersion = Number(value?.schemaVersion);
  exactKeys(
    value,
    schemaVersion === 1
      ? [
          "schemaVersion",
          "transactionId",
          "version",
          "previousGenerationVersion",
          "previousIdentity",
          "previousTrust",
        ]
      : [
          "schemaVersion",
          "transactionId",
          "version",
          "previousGenerationVersion",
          "previousIdentity",
          "supervisorChanged",
          "previousSupervisorDigest",
          "targetSupervisorDigest",
          "previousTrust",
        ],
    "lifecycle supervisor transaction",
  );
  if (
    !new Set([1, 2]).has(schemaVersion) ||
    !TRANSACTION_ID_PATTERN.test(value.transactionId || "") ||
    !VERSION_PATTERN.test(value.version || "") ||
    (value.previousGenerationVersion !== null &&
      !VERSION_PATTERN.test(value.previousGenerationVersion || ""))
  ) {
    fail("lifecycle supervisor transaction identity is invalid");
  }
  const supervisorChanged = schemaVersion === 2 && value.supervisorChanged === true;
  const previousSupervisorDigest =
    schemaVersion === 2 ? String(value.previousSupervisorDigest ?? "") : null;
  const targetSupervisorDigest =
    schemaVersion === 2 ? String(value.targetSupervisorDigest ?? "") : null;
  if (
    schemaVersion === 2 &&
    (typeof value.supervisorChanged !== "boolean" ||
      !DIGEST_PATTERN.test(previousSupervisorDigest) ||
      !DIGEST_PATTERN.test(targetSupervisorDigest) ||
      (!supervisorChanged && previousSupervisorDigest !== targetSupervisorDigest))
  ) {
    fail("lifecycle supervisor transaction generation identity is invalid");
  }
  let previousIdentity = null;
  if (value.previousIdentity !== null) {
    exactKeys(
      value.previousIdentity,
      ["schemaVersion", "version", "serverSha256", "clientSha256"],
      "prior lifecycle controller identity",
    );
    if (
      value.previousIdentity.schemaVersion !== 1 ||
      value.previousIdentity.version !== value.previousGenerationVersion ||
      !DIGEST_PATTERN.test(value.previousIdentity.serverSha256 || "") ||
      !DIGEST_PATTERN.test(value.previousIdentity.clientSha256 || "")
    ) {
      fail("prior lifecycle controller identity is invalid");
    }
    previousIdentity = Object.freeze({ ...value.previousIdentity });
  } else if (value.previousGenerationVersion !== null) {
    fail("prior lifecycle generation requires its exact identity");
  }
  exactKeys(
    value.previousTrust,
    ["persisted", "envelope", "state"],
    "prior lifecycle trust transaction state",
  );
  if (
    typeof value.previousTrust.persisted !== "boolean" ||
    (value.previousTrust.persisted
      ? value.previousTrust.envelope === null || value.previousTrust.state === null
      : value.previousTrust.envelope !== null || value.previousTrust.state !== null)
  ) {
    fail("prior lifecycle trust transaction state is invalid");
  }
  let previousTrust;
  if (value.previousTrust.persisted) {
    const root = parseLifecycleRootPolicy(value.previousTrust.envelope, Date.now(), {
      enforceCurrentValidity: false,
    });
    requireLifecycleRootThreshold(
      root,
      verifyLifecycleRootSignatures(root, [root], { rejectUnknown: false }),
    );
    previousTrust = Object.freeze({
      persisted: true,
      envelope: value.previousTrust.envelope,
      root,
      state: parseLifecycleTrustState(value.previousTrust.state, root),
    });
  } else {
    previousTrust = Object.freeze({
      persisted: false,
      envelope: INITIAL_LIFECYCLE_ROOT_ENVELOPE,
      root: EMBEDDED_LIFECYCLE_ROOT,
      state: initialLifecycleTrustState(),
    });
  }
  return Object.freeze({
    request: Object.freeze({
      schemaVersion: 2,
      op: "updateController",
      transactionId: value.transactionId,
      version: value.version,
    }),
    previousGeneration: value.previousGenerationVersion
      ? path.join(paths.releasesDir, `v${value.previousGenerationVersion}`)
      : null,
    previousIdentity,
    supervisorChanged,
    previousSupervisorDigest,
    targetSupervisorDigest,
    previousTrust,
  });
}

async function beginSupervisorTransaction(paths, request, staged) {
  try {
    await fsp.access(paths.supervisorTransactionPath);
    fail("another lifecycle supervisor transaction is already active");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  await atomicWrite(
    paths.supervisorTransactionPath,
    `${JSON.stringify(supervisorTransactionRecord(request, staged), null, 2)}\n`,
    0o600,
  );
}

async function clearSupervisorTransaction(paths) {
  await fsp.rm(paths.supervisorTransactionPath, { force: true });
  await fsyncDirectory(paths.supervisorStateDir);
}

async function readSupervisorTransaction(paths, rootUid) {
  try {
    return parseSupervisorTransaction(
      await readProtectedJson(
        paths.supervisorTransactionPath,
        "lifecycle supervisor transaction",
        rootUid,
      ),
      paths,
    );
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function recoverSupervisorTransaction(context) {
  const transaction = await readSupervisorTransaction(context.paths, context.rootUid);
  if (!transaction) {
    return false;
  }
  await restoreControllerSelection(context.paths, transaction);
  await context.restoreSupervisorSelection(context.paths, transaction);
  await restoreLifecycleTrust(context.paths, transaction.previousTrust);
  await context.restartController();
  await context.waitForController();
  await clearSupervisorTransaction(context.paths);
  if (
    transaction.supervisorChanged &&
    context.runningSupervisorDigest !== transaction.previousSupervisorDigest
  ) {
    context.supervisorRestartRequired = true;
  }
  return true;
}

async function systemctl(...args) {
  const binary = await fixedExecutable(["/usr/bin/systemctl", "/bin/systemctl"], "systemctl");
  await execFileAsync(binary, args, {
    env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
    timeout: 120_000,
    maxBuffer: 2 * 1024 * 1024,
  });
}

function unitPath(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll(" ", "\\x20");
}

function passwdRecord(uid) {
  const matches = fs
    .readFileSync("/etc/passwd", "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(":"))
    .filter((fields) => Number(fields[2]) === uid);
  if (matches.length !== 1) {
    fail("lifecycle operator UID does not resolve to one system account");
  }
  const fields = matches[0];
  const user = fields[0];
  const home = fields[5];
  if (
    !/^[A-Za-z_][A-Za-z0-9_.-]{0,30}$/u.test(user) ||
    user === "root" ||
    !path.isAbsolute(home) ||
    path.resolve(home) !== home
  ) {
    fail("lifecycle operator account or home is unsafe");
  }
  return Object.freeze({ user, home });
}

function protectedLocalStateDir(configuration, operator) {
  const registryPath = "/var/lib/fased-local-registry/instances.json";
  const info = fs.lstatSync(registryPath);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.uid !== 0 ||
    (info.mode & 0o177) !== 0
  ) {
    fail("Protected Local registry is not a root-owned immutable input");
  }
  const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  if (registry?.schemaVersion !== 1 || !Array.isArray(registry.instances)) {
    fail("Protected Local registry schema is unsupported");
  }
  const matches = registry.instances.filter(
    (entry) =>
      entry?.instanceId === configuration.instanceId &&
      entry?.operatorUid === configuration.operatorUid &&
      entry?.operatorUser === operator.user,
  );
  if (matches.length !== 1) {
    fail("Protected Local registry does not bind this supervisor instance");
  }
  const stateDir = String(matches[0].stateDir ?? "");
  if (
    !path.isAbsolute(stateDir) ||
    path.resolve(stateDir) !== stateDir ||
    (stateDir !== operator.home && !stateDir.startsWith(`${operator.home}${path.sep}`))
  ) {
    fail("Protected Local application state is outside its declared operator home");
  }
  return stateDir;
}

function renderBoundaryUnits(configuration, nodeBinary) {
  const { paths } = configuration;
  const operator = passwdRecord(configuration.operatorUid);
  const appStateDir =
    configuration.profile === "hosting"
      ? path.join(operator.home, ".fased")
      : protectedLocalStateDir(configuration, operator);
  const controllerExec =
    configuration.profile === "hosting"
      ? `${unitPath(nodeBinary)} /opt/fased/host-controller/current/fased-host-updater.mjs --supervised --socket-path /run/fased-host-controller/controller.sock --socket-uid 0 --socket-gid 0`
      : `${unitPath(nodeBinary)} /opt/fased/local/${configuration.instanceId}/controller/current/fased-host-updater.mjs --protected-local-instance ${configuration.instanceId} --supervised --socket-path /run/fased-local-controller-worker/${configuration.instanceId}/controller.sock --socket-uid 0 --socket-gid 0`;
  const controllerRuntime =
    configuration.profile === "hosting"
      ? "fased-host-controller"
      : `fased-local-controller-worker/${configuration.instanceId}`;
  const controllerState =
    configuration.profile === "hosting"
      ? "fased-host-updater"
      : `fased-local/${configuration.instanceId}/controller`;
  const controllerWrites =
    configuration.profile === "hosting"
      ? `/opt/fased/host-application /opt/fased/signer /var/lib/fased-host-updater /var/lib/fased-signer-update-gate /var/lib/fased-signerd /run/fased-host-controller /etc/systemd/system ${unitPath(appStateDir)}`
      : `/opt/fased/local/${configuration.instanceId} /var/lib/fased-local/${configuration.instanceId}/signer /var/lib/fased-local/${configuration.instanceId}/controller ${unitPath(appStateDir)} /run/fased-local-controller-worker/${configuration.instanceId} /etc/systemd/system`;
  const controllerReadOnly =
    configuration.profile === "hosting"
      ? `/opt/fased/host-controller /var/lib/fased-host-updater/controller-version.json /var/lib/fased-host-updater/supervisor ${unitPath(path.join("/etc/systemd/system", paths.controllerUnit))} ${unitPath(path.join("/etc/systemd/system", `${paths.controllerUnit}.d`))} ${unitPath(path.join("/etc/systemd/system", paths.supervisorUnit))} ${unitPath(path.join("/etc/systemd/system", `${paths.supervisorUnit}.d`))}`
      : `/opt/fased/local/${configuration.instanceId}/controller /opt/fased/local/${configuration.instanceId}/supervisor /opt/fased/local/${configuration.instanceId}/signer-owner /opt/fased/local/${configuration.instanceId}/operator-socket-finalize /var/lib/fased-local/${configuration.instanceId}/controller/controller-version.json /var/lib/fased-local/${configuration.instanceId}/controller/supervisor ${unitPath(path.join("/etc/systemd/system", paths.controllerUnit))} ${unitPath(path.join("/etc/systemd/system", `${paths.controllerUnit}.d`))} ${unitPath(path.join("/etc/systemd/system", paths.supervisorUnit))} ${unitPath(path.join("/etc/systemd/system", `${paths.supervisorUnit}.d`))}`;
  const controller = `[Unit]
Description=Fased target lifecycle controller
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
Group=root
RuntimeDirectory=${controllerRuntime}
RuntimeDirectoryMode=0711
StateDirectory=${controllerState}
StateDirectoryMode=0711
UMask=0077
Environment=HOME=${unitPath(paths.stateDir)}
ExecStart=${controllerExec}
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
AmbientCapabilities=CAP_SETUID CAP_SETGID
PrivateTmp=true
ProtectHome=read-only
ProtectSystem=strict
ReadWritePaths=${controllerWrites}
ReadOnlyPaths=${controllerReadOnly}
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
ProtectClock=true
ProtectHostname=true
LockPersonality=true
RestrictRealtime=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
SystemCallArchitectures=native

[Install]
WantedBy=multi-user.target
`;
  const supervisorRuntime =
    configuration.profile === "hosting"
      ? "fased-host-updater"
      : `fased-local-controller/${configuration.instanceId}`;
  const supervisorWrites =
    configuration.profile === "hosting"
      ? "/opt/fased/host-controller /var/lib/fased-host-updater/supervisor /run/fased-host-updater"
      : `/opt/fased/local/${configuration.instanceId}/controller /opt/fased/local/${configuration.instanceId}/supervisor /var/lib/fased-local/${configuration.instanceId}/controller/supervisor /run/fased-local-controller/${configuration.instanceId}`;
  const instanceArgs =
    configuration.profile === "protected-local"
      ? ` --protected-local-instance ${configuration.instanceId}`
      : "";
  const supervisor = `[Unit]
Description=Fased stable lifecycle supervisor
After=${paths.controllerUnit} network-online.target
Wants=${paths.controllerUnit} network-online.target

[Service]
Type=simple
User=root
Group=root
RuntimeDirectory=${supervisorRuntime}
RuntimeDirectoryMode=0711
UMask=0177
Environment=HOME=${unitPath(paths.supervisorStateDir)}
ExecStart=${unitPath(nodeBinary)} ${unitPath(paths.supervisorPath)} --profile ${configuration.profile}${instanceArgs} --operator-uid ${configuration.operatorUid} --operator-gid ${configuration.operatorGid}
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=${supervisorWrites}
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
ProtectClock=true
ProtectHostname=true
LockPersonality=true
RestrictSUIDSGID=true
RestrictRealtime=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
SystemCallArchitectures=native
CapabilityBoundingSet=CAP_CHOWN
AmbientCapabilities=

[Install]
WantedBy=multi-user.target
`;
  return Object.freeze({
    controller: {
      path: path.join("/etc/systemd/system", paths.controllerUnit),
      content: controller,
    },
    supervisor: {
      path: path.join("/etc/systemd/system", paths.supervisorUnit),
      content: supervisor,
    },
  });
}

async function ensureProtectedUnitDropInDirectory(unitName) {
  const directory = path.join("/etc/systemd/system", `${unitName}.d`);
  try {
    const info = await fsp.lstat(directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== 0 ||
      (info.mode & 0o022) !== 0
    ) {
      fail(`lifecycle unit drop-in boundary is unsafe: ${directory}`);
    }
    const entries = await fsp.readdir(directory);
    if (entries.length !== 0) {
      fail(`lifecycle unit drop-in boundary is not empty: ${directory}`);
    }
    return Object.freeze({ directory, created: false });
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  await fsp.mkdir(directory, { mode: 0o755 });
  await fsp.chown(directory, 0, 0);
  await fsp.chmod(directory, 0o755);
  return Object.freeze({ directory, created: true });
}

async function captureFile(filePath) {
  try {
    const info = await fsp.lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== 0) {
      fail(`lifecycle unit input is unsafe: ${filePath}`);
    }
    return {
      exists: true,
      content: await fsp.readFile(filePath),
      mode: info.mode & 0o777,
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { exists: false };
    }
    throw error;
  }
}

async function restoreCapturedFile(filePath, captured) {
  if (!captured.exists) {
    await fsp.rm(filePath, { force: true });
    return;
  }
  await atomicWrite(filePath, captured.content, captured.mode);
}

export async function installSupervisorBoundary(configuration) {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) {
    fail("lifecycle supervisor bootstrap must run as root");
  }
  const supervisorRealPath = await fsp.realpath(configuration.paths.supervisorPath);
  const selfRealPath = await fsp.realpath(fileURLToPath(import.meta.url));
  const supervisorInfo = await fsp.lstat(supervisorRealPath);
  if (
    supervisorRealPath !== selfRealPath ||
    !supervisorInfo.isFile() ||
    supervisorInfo.isSymbolicLink() ||
    supervisorInfo.uid !== 0 ||
    supervisorInfo.nlink !== 1 ||
    (supervisorInfo.mode & 0o022) !== 0
  ) {
    fail("stable lifecycle supervisor bootstrap is not executing its fixed root-owned target");
  }
  const nodeBinary = await fsp.realpath(process.execPath);
  const nodeInfo = await fsp.stat(nodeBinary);
  if (!nodeInfo.isFile() || nodeInfo.uid !== 0 || (nodeInfo.mode & 0o022) !== 0) {
    fail("lifecycle supervisor requires one root-controlled system Node.js runtime");
  }
  const units = renderBoundaryUnits(configuration, nodeBinary);
  const snapshots = new Map();
  const protectedDropInDirectories = [];
  for (const unit of Object.values(units)) {
    snapshots.set(unit.path, await captureFile(unit.path));
  }
  try {
    for (const unitName of [
      configuration.paths.controllerUnit,
      configuration.paths.supervisorUnit,
    ]) {
      protectedDropInDirectories.push(await ensureProtectedUnitDropInDirectory(unitName));
    }
    for (const unit of Object.values(units)) {
      await atomicWrite(unit.path, unit.content, 0o644);
    }
    await systemctl("daemon-reload");
    await systemctl("enable", "--now", configuration.paths.controllerUnit);
    await systemctl("enable", configuration.paths.supervisorUnit);
    await atomicWrite(
      path.join(configuration.paths.supervisorStateDir, "boundary.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          profile: configuration.profile,
          instanceId: configuration.instanceId,
          supervisorProtocol: SUPERVISOR_PROTOCOL_VERSION,
          controllerProtocol: CONTROLLER_PROTOCOL_VERSION,
          operatorUid: configuration.operatorUid,
          operatorGid: configuration.operatorGid,
          installedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      0o600,
    );
  } catch (error) {
    for (const [filePath, snapshot] of snapshots) {
      await restoreCapturedFile(filePath, snapshot);
    }
    for (const { directory, created } of protectedDropInDirectories.toReversed()) {
      if (created) {
        await fsp.rmdir(directory).catch(() => undefined);
      }
    }
    await systemctl("daemon-reload").catch(() => undefined);
    throw error;
  }
  return {
    schemaVersion: 1,
    profile: configuration.profile,
    instanceId: configuration.instanceId,
    supervisorUnit: configuration.paths.supervisorUnit,
    controllerUnit: configuration.paths.controllerUnit,
  };
}

async function waitForControllerSocket(socketPath, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const info = await fsp.lstat(socketPath);
      if (info.isSocket() && !info.isSymbolicLink()) {
        return;
      }
    } catch {
      // The fixed worker service is still restarting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  fail("replaceable lifecycle controller did not create its private socket");
}

function createContext(configuration, overrides = {}) {
  const rootUid =
    overrides.rootUid ?? (typeof process.geteuid === "function" ? process.geteuid() : 0);
  const rootGid =
    overrides.rootGid ?? (typeof process.getegid === "function" ? process.getegid() : 0);
  return {
    configuration,
    paths: configuration.paths,
    rootUid,
    rootGid,
    platform: overrides.platform ?? platformIdentity(),
    now: overrides.now ?? (() => Date.now()),
    readChannel: overrides.readChannel ?? readChannel,
    readRollbackFloor: overrides.readRollbackFloor ?? readRollbackFloor,
    readLifecycleTrust: overrides.readLifecycleTrust ?? readLifecycleTrust,
    readControllerIdentity: overrides.readControllerIdentity ?? readControllerIdentity,
    currentControllerMatches: overrides.currentControllerMatches ?? currentControllerMatches,
    download: overrides.download ?? download,
    sealSupervisorArtifact: overrides.sealSupervisorArtifact ?? sealSupervisorArtifact,
    verifyMetadata: overrides.verifyMetadata ?? verifyMetadata,
    verifyReleaseEvidence: overrides.verifyReleaseEvidence ?? verifyReleaseEvidence,
    selfCheckSupervisor: overrides.selfCheckSupervisor ?? selfCheckSupervisor,
    selfCheckController: overrides.selfCheckController ?? selfCheckController,
    stageTrustedController: overrides.stageTrustedController ?? stageTrustedController,
    activateStagedSupervisor:
      overrides.activateStagedSupervisor ??
      (async (paths, staged) => await activateStagedSupervisor(paths, staged, rootUid, rootGid)),
    activateStagedController: overrides.activateStagedController ?? activateStagedController,
    restoreSupervisorSelection:
      overrides.restoreSupervisorSelection ??
      (async (paths, staged) => await restoreSupervisorSelection(paths, staged, rootUid, rootGid)),
    restoreControllerSelection: overrides.restoreControllerSelection ?? restoreControllerSelection,
    beginSupervisorTransaction: overrides.beginSupervisorTransaction ?? beginSupervisorTransaction,
    commitLifecycleTrust: overrides.commitLifecycleTrust ?? commitLifecycleTrust,
    restoreLifecycleTrust: overrides.restoreLifecycleTrust ?? restoreLifecycleTrust,
    clearSupervisorTransaction: overrides.clearSupervisorTransaction ?? clearSupervisorTransaction,
    recoverSupervisorTransaction:
      overrides.recoverSupervisorTransaction ?? recoverSupervisorTransaction,
    cleanupHistoricalControllerCandidates:
      overrides.cleanupHistoricalControllerCandidates ?? cleanupHistoricalControllerCandidates,
    writeControllerSelectionReceipt:
      overrides.writeControllerSelectionReceipt ?? writeControllerSelectionReceipt,
    readControllerSelectionReceipt:
      overrides.readControllerSelectionReceipt ?? readControllerSelectionReceipt,
    probeControllerIdentity: overrides.probeControllerIdentity ?? probeControllerIdentity,
    restartController:
      overrides.restartController ??
      (async () => await systemctl("restart", configuration.paths.controllerUnit)),
    waitForController:
      overrides.waitForController ??
      (async () => await waitForControllerSocket(configuration.paths.privateSocketPath)),
    requestController:
      overrides.requestController ??
      (async (request, transactionContext) => await requestController(request, transactionContext)),
    runningSupervisorDigest: overrides.runningSupervisorDigest ?? RUNNING_SUPERVISOR_SHA256,
    supervisorRestartRequired: false,
  };
}

async function requestController(request, context) {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: context.paths.privateSocketPath });
    socket.setEncoding("utf8");
    socket.setTimeout(REQUEST_TIMEOUT_MS);
    let body = "";
    let settled = false;
    const rejectOnce = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      reject(error);
    };
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_REQUEST_BYTES) {
        rejectOnce(new Error("replaceable lifecycle controller response is too large"));
        return;
      }
      const newline = body.indexOf("\n");
      if (newline < 0 || settled) {
        return;
      }
      try {
        const response = JSON.parse(body.slice(0, newline));
        if (
          response?.transactionId !== request.transactionId ||
          response?.version !== request.version ||
          typeof response?.ok !== "boolean"
        ) {
          rejectOnce(new Error("replaceable lifecycle controller returned a mismatched response"));
          return;
        }
        settled = true;
        socket.destroy();
        resolve(response);
      } catch (error) {
        rejectOnce(
          new Error(`replaceable lifecycle controller returned invalid JSON: ${error.message}`),
        );
      }
    });
    socket.once("timeout", () =>
      rejectOnce(new Error(`replaceable lifecycle controller timed out during ${request.op}`)),
    );
    socket.once("error", rejectOnce);
    socket.once("close", () => {
      if (!settled) {
        rejectOnce(new Error("replaceable lifecycle controller closed before responding"));
      }
    });
  });
}

async function probeControllerIdentity(request, context, expectedIdentity) {
  const response = await requestController(
    {
      ...request,
      op: "controllerStatus",
    },
    context,
  );
  if (
    !response.ok ||
    response.controllerVersion !== request.version ||
    !TRANSACTION_ID_PATTERN.test(response.controllerInstanceId || "") ||
    response.controllerServerSha256 !== expectedIdentity?.serverSha256 ||
    response.controllerClientSha256 !== expectedIdentity?.clientSha256 ||
    canonicalRootValue(response.protocolCapabilities) !==
      canonicalRootValue(CONTROLLER_SELECTION_CAPABILITIES)
  ) {
    fail("replaceable lifecycle controller is not running the verified target");
  }
  return response.controllerInstanceId;
}

async function handleSupervisorRequest(request, context, state) {
  if (request.op === "applyRelease") {
    const receipt = await readDurableReceipt(context.paths, request);
    if (receipt?.outcome === "committed") {
      return {
        ok: true,
        transactionId: request.transactionId,
        version: request.version,
        phase: "committed",
        changed: false,
        release: receipt.release,
        replayed: true,
      };
    }
  }
  if (request.op === "updateController") {
    const priorInstanceId = state.controllerInstanceId;
    const staged = await context.stageTrustedController(request, context);
    const durableChange = staged.changed || staged.supervisorChanged || staged.trustChanged;
    let transactionActive = false;
    let restarted = staged.changed;
    let selectionReceipt = null;
    try {
      if (durableChange) {
        await context.beginSupervisorTransaction(context.paths, request, staged);
        transactionActive = true;
      }
      if (staged.supervisorChanged) {
        await context.activateStagedSupervisor(context.paths, staged);
      }
      if (staged.changed) {
        await context.activateStagedController(context.paths, staged);
        await context.restartController();
        await context.waitForController();
      }
      try {
        state.controllerInstanceId = await context.probeControllerIdentity(
          request,
          context,
          staged.identity,
        );
      } catch (error) {
        if (staged.changed) {
          throw error;
        }
        restarted = true;
        await context.restartController();
        await context.waitForController();
        state.controllerInstanceId = await context.probeControllerIdentity(
          request,
          context,
          staged.identity,
        );
      }
      await context.cleanupHistoricalControllerCandidates(
        context.paths,
        request.version,
        context.rootUid,
      );
      if (durableChange) {
        await context.commitLifecycleTrust(context.paths, staged);
        await context.clearSupervisorTransaction(context.paths);
        transactionActive = false;
      }
    } catch (error) {
      let rollbackError = null;
      if (transactionActive) {
        try {
          await context.restoreControllerSelection(context.paths, staged);
          await context.restoreSupervisorSelection(context.paths, staged);
          await context.restoreLifecycleTrust(context.paths, staged.trusted);
          if (staged.changed) {
            await context.restartController();
            await context.waitForController();
          }
          await context.clearSupervisorTransaction(context.paths);
          transactionActive = false;
        } catch (rollbackFailure) {
          rollbackError = rollbackFailure;
        }
      }
      await durableReceipt(context.paths, request, {
        outcome: durableChange && !rollbackError ? "rolled-back" : "failed",
        controllerChanged: false,
      });
      if (rollbackError) {
        throw new Error(
          `controller promotion failed and rollback remains pending for startup recovery: ${rollbackError.message}`,
          { cause: error },
        );
      }
      throw new Error(
        durableChange
          ? `controller promotion failed and was restored: ${error.message}`
          : `controller verification failed: ${error.message}`,
        { cause: error },
      );
    }
    try {
      selectionReceipt = await context.writeControllerSelectionReceipt(
        context.paths,
        request,
        staged,
        state.controllerInstanceId,
        context.rootUid,
        context.rootGid,
      );
    } catch (error) {
      throw new Error(
        `verified target controller is selected but its authorization receipt is unavailable; retry the same update: ${error.message}`,
        { cause: error },
      );
    }
    await durableReceipt(context.paths, request, {
      outcome: "verified",
      controllerChanged: restarted,
      selectionDigest: selectionReceipt.selectionDigest,
    });
    return {
      ok: true,
      transactionId: request.transactionId,
      version: request.version,
      controllerChanged: restarted,
      supervisorChanged: staged.supervisorChanged === true,
      controllerInstanceId: restarted ? priorInstanceId : state.controllerInstanceId,
      selectionDigest: selectionReceipt.selectionDigest,
    };
  }

  const selectionReceipt = await context.readControllerSelectionReceipt(
    context.paths,
    request,
    context.rootUid,
  );
  const response = await context.requestController(
    { ...request, supervisorReceipt: selectionReceipt },
    context,
  );
  if (response.ok && new Set(["applyRelease", "commitRelease"]).has(request.op)) {
    await atomicWrite(context.paths.rollbackFloorPath, `${request.version}\n`, 0o600);
  }
  if (response.ok && request.op === "applyRelease" && response.phase === "committed") {
    await durableReceipt(context.paths, request, {
      outcome: "committed",
      controllerChanged: false,
      phase: response.phase,
      release: response.release,
      selectionDigest: selectionReceipt.selectionDigest,
    });
  } else if (request.op === "commitRelease" || request.op === "rollbackRelease") {
    await durableReceipt(context.paths, request, {
      outcome: response.ok
        ? request.op === "commitRelease"
          ? "committed"
          : "rolled-back"
        : "failed",
      controllerChanged: false,
    });
  }
  return response;
}

function writeResponse(socket, payload, onFlushed) {
  socket.end(`${JSON.stringify(payload)}\n`, onFlushed);
}

async function authorizePublicSocket(socketPath, operatorUid, operatorGid, operations = fsp) {
  // The supervisor intentionally retains CAP_CHOWN without CAP_FOWNER.
  // Tighten the root-owned socket before transferring ownership: after chown,
  // chmod would require the broader capability that this boundary excludes.
  await operations.chmod(socketPath, 0o600);
  await operations.chown(socketPath, operatorUid, operatorGid);
}

export async function startSupervisor(options = {}) {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) {
    fail("lifecycle supervisor must run as root");
  }
  const configuration = options.configuration ?? parseSupervisorConfiguration();
  const context = options.context ?? createContext(configuration);
  const state = { controllerInstanceId: randomUUID() };
  await fsp.mkdir(path.dirname(context.paths.publicSocketPath), {
    recursive: true,
    mode: 0o711,
  });
  await fsp.mkdir(context.paths.supervisorStateDir, { recursive: true, mode: 0o700 });
  const recovered = await context.recoverSupervisorTransaction(context);
  if (recovered && context.supervisorRestartRequired) {
    return { server: null, close: async () => undefined, context, restartRequired: true };
  }
  if (!recovered) {
    await context.waitForController();
  }
  await fsp.rm(context.paths.publicSocketPath, { force: true });
  process.umask(PRIVATE_UMASK);
  let queue = Promise.resolve();
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    socket.setTimeout(REQUEST_TIMEOUT_MS);
    let body = "";
    let handled = false;
    const failRequest = (message) => {
      if (!handled) {
        handled = true;
        writeResponse(socket, { ok: false, error: message });
      }
    };
    socket.on("timeout", () => failRequest("lifecycle supervisor request timed out"));
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk) => {
      if (handled) {
        return;
      }
      body += chunk;
      if (body.length > MAX_REQUEST_BYTES) {
        failRequest("lifecycle supervisor request is too large");
        return;
      }
      const newline = body.indexOf("\n");
      if (newline < 0) {
        return;
      }
      handled = true;
      let request;
      try {
        request = parseSupervisorRequest(JSON.parse(body.slice(0, newline)));
      } catch (error) {
        writeResponse(socket, { ok: false, error: error.message });
        return;
      }
      const operation = queue.then(() => handleSupervisorRequest(request, context, state));
      queue = operation.catch(() => undefined);
      const restartSupervisor = () => {
        server.close(() => {
          void fsp.rm(context.paths.publicSocketPath, { force: true }).finally(() => {
            process.exitCode = 75;
          });
        });
      };
      void operation.then(
        (result) =>
          writeResponse(
            socket,
            result,
            result.supervisorChanged === true ? restartSupervisor : undefined,
          ),
        (error) =>
          writeResponse(socket, {
            ok: false,
            transactionId: request.transactionId,
            version: request.version,
            error: error.message,
          }),
      );
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(context.paths.publicSocketPath, resolve);
  });
  await authorizePublicSocket(
    context.paths.publicSocketPath,
    configuration.operatorUid,
    configuration.operatorGid,
  );
  const close = async () => {
    await new Promise((resolve) => server.close(resolve));
    await fsp.rm(context.paths.publicSocketPath, { force: true });
  };
  process.once("SIGTERM", () => void close().then(() => process.exit(0)));
  process.once("SIGINT", () => void close().then(() => process.exit(0)));
  return { server, close, context, restartRequired: false };
}

async function main() {
  if (process.argv[2] === "--self-check") {
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: SUPERVISOR_SCHEMA_VERSION,
        protocolVersion: SUPERVISOR_PROTOCOL_VERSION,
        role: "lifecycle-supervisor",
      })}\n`,
    );
    return;
  }
  if (process.argv[2] === "bootstrap-boundary") {
    const result = await installSupervisorBoundary(
      parseSupervisorConfiguration(process.argv.slice(3)),
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  const running = await startSupervisor({
    configuration: parseSupervisorConfiguration(process.argv.slice(2)),
  });
  if (running.restartRequired) {
    process.exitCode = 75;
    return;
  }
  await new Promise((resolve, reject) => {
    running.server.once("close", resolve);
    running.server.once("error", reject);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`fased-lifecycle-supervisor: ${error.message}\n`);
    process.exitCode = 1;
  });
}

export const __testing = Object.freeze({
  CONTROLLER_CLIENT_NAME,
  CONTROLLER_SERVER_NAME,
  EMBEDDED_LIFECYCLE_ROOT,
  INITIAL_LIFECYCLE_ROOT_ENVELOPE,
  INITIAL_LIFECYCLE_ROOT_SHA256,
  PRIVATE_UMASK,
  SUPERVISOR_NAME,
  TRUST_METADATA_NAME,
  activateStagedSupervisor,
  activateStagedController,
  advanceLifecycleTrustState,
  atomicWrite,
  beginSupervisorTransaction,
  commitLifecycleTrust,
  createControllerSelectionReceipt,
  cleanupHistoricalControllerCandidates,
  compareVersions,
  createContext,
  handleSupervisorRequest,
  initialLifecycleTrustState,
  lifecyclePaths,
  platformIdentity,
  recoverSupervisorTransaction,
  readControllerSelectionReceipt,
  renderBoundaryUnits,
  restoreSupervisorSelection,
  restoreControllerSelection,
  writeControllerSelectionReceipt,
  authorizePublicSocket,
  privateMkdtemp,
  sealSupervisorArtifact,
  verifyLifecycleRootTransition,
});
