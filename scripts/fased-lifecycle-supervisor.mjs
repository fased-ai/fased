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
const MAX_ROOT_RECOVERY_ATTEMPTS = 8;
const ROOT_LEDGER_SCHEMA_VERSION = 3;
const ROOT_LEDGER_PROTOCOL_VERSION = 2;
const LEGACY_ADOPTION_RECEIPT_NAME = "legacy-managed-update-adoption.v1.json";
const PRIVATE_UMASK = 0o077;
const MAX_METADATA_VALIDITY_MS = 400 * 24 * 60 * 60 * 1000;
const CONTROLLER_SELECTION_SCHEMA_VERSION = 2;
const LEGACY_CONTROLLER_SELECTION_SCHEMA_VERSION = 1;
const CONTROLLER_SELECTION_VALIDITY_MS = 24 * 60 * 60 * 1000;
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
const RECOVERY_OPERATIONS = new Set(["recoveryStatus", "recoverActive"]);
const ROOT_TRANSACTION_OPERATIONS = new Set([
  "applyRelease",
  "prepareRelease",
  "activateRelease",
  "authorizeGatewayRelease",
  "gateGatewayRelease",
  "commitRelease",
  "rollbackRelease",
]);
const ROOT_TRANSACTION_PHASES = new Set([
  "selected",
  "dispatching",
  "prepared",
  "state-reconciling",
  "state-reconciled",
  "schema-ready",
  "snapshotting",
  "activating",
  "active",
  "gateway-authorized",
  "gateway-verified",
  "committing",
  "commit-ack-pending",
  "commit-acknowledged",
  "rolling-back",
  "restored",
  "legacy-recovery",
  "product-recovered",
]);
const ROOT_FORWARD_PHASES = Object.freeze([
  "prepared",
  "state-reconciling",
  "state-reconciled",
  "schema-ready",
  "snapshotting",
  "activating",
  "active",
  "gateway-authorized",
  "gateway-verified",
  "committing",
  "commit-ack-pending",
  "commit-acknowledged",
]);
const ROOT_PRECOMMIT_PHASES = new Set([
  "selected",
  "dispatching",
  "prepared",
  "state-reconciling",
  "state-reconciled",
  "schema-ready",
  "snapshotting",
  "activating",
  "active",
  "gateway-authorized",
  "legacy-recovery",
]);
const CONTROLLER_SELECTION_CAPABILITIES = Object.freeze({
  supervisorProtocol: SUPERVISOR_PROTOCOL_VERSION,
  controllerProtocol: CONTROLLER_PROTOCOL_VERSION,
  requestSchema: 2,
});
const CONTROLLER_RECOVERY_CAPABILITIES = Object.freeze({
  protocolVersion: 1,
  operations: Object.freeze(["recoverActive"]),
  journalSchemas: Object.freeze([7, 8]),
});
const SUPERVISOR_CLIENT_CAPABILITIES = Object.freeze({
  protocolVersion: 2,
  requestSchema: 3,
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
  const schemaVersion = Number(value?.schemaVersion);
  exactKeys(
    value,
    schemaVersion === LEGACY_CONTROLLER_SELECTION_SCHEMA_VERSION
      ? [
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
        ]
      : [
          "schemaVersion",
          "transactionId",
          "version",
          "releaseCommit",
          "targetManifestSha256",
          "controllerServerSha256",
          "controllerClientSha256",
          "controllerInstanceId",
          "protocolCapabilities",
          "nonce",
          "selectedAt",
          "expiresAt",
          "trustPolicySha256",
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
    schemaVersion,
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
    ...(schemaVersion === CONTROLLER_SELECTION_SCHEMA_VERSION
      ? {
          nonce: String(value.nonce ?? "").toLowerCase(),
          selectedAt: String(value.selectedAt ?? ""),
          expiresAt: String(value.expiresAt ?? ""),
          trustPolicySha256: String(value.trustPolicySha256 ?? ""),
        }
      : {}),
  };
  const selectedAt = Date.parse(unsigned.selectedAt ?? "");
  const expiresAt = Date.parse(unsigned.expiresAt ?? "");
  if (
    !new Set([LEGACY_CONTROLLER_SELECTION_SCHEMA_VERSION, CONTROLLER_SELECTION_SCHEMA_VERSION]).has(
      unsigned.schemaVersion,
    ) ||
    !TRANSACTION_ID_PATTERN.test(unsigned.transactionId) ||
    !COMMIT_PATTERN.test(unsigned.releaseCommit) ||
    !DIGEST_PATTERN.test(unsigned.targetManifestSha256) ||
    !DIGEST_PATTERN.test(unsigned.controllerServerSha256) ||
    !DIGEST_PATTERN.test(unsigned.controllerClientSha256) ||
    !TRANSACTION_ID_PATTERN.test(unsigned.controllerInstanceId) ||
    canonicalRootValue(unsigned.protocolCapabilities) !==
      canonicalRootValue(CONTROLLER_SELECTION_CAPABILITIES) ||
    (unsigned.schemaVersion === CONTROLLER_SELECTION_SCHEMA_VERSION &&
      (!TRANSACTION_ID_PATTERN.test(unsigned.nonce) ||
        !Number.isFinite(selectedAt) ||
        new Date(selectedAt).toISOString() !== unsigned.selectedAt ||
        !Number.isFinite(expiresAt) ||
        new Date(expiresAt).toISOString() !== unsigned.expiresAt ||
        selectedAt >= expiresAt ||
        expiresAt - selectedAt > CONTROLLER_SELECTION_VALIDITY_MS ||
        !DIGEST_PATTERN.test(unsigned.trustPolicySha256))) ||
    value.selectionDigest !== controllerSelectionDigest(unsigned)
  ) {
    fail("controller selection receipt is malformed or mismatched");
  }
  return Object.freeze({ ...unsigned, selectionDigest: value.selectionDigest });
}

function assertControllerSelectionReceiptFresh(receipt, now = Date.now()) {
  if (
    receipt.schemaVersion === CONTROLLER_SELECTION_SCHEMA_VERSION &&
    (now < Date.parse(receipt.selectedAt) || now > Date.parse(receipt.expiresAt))
  ) {
    fail("controller selection receipt is outside its validity window");
  }
  return receipt;
}

function createControllerSelectionReceipt(request, staged, controllerInstanceId, options = {}) {
  const selectedAtMs = options.now ?? Date.now();
  const trustPolicySha256 =
    staged.trustPolicySha256 ?? staged.candidateRoot?.digest ?? staged.trusted?.root?.digest;
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
    nonce: options.nonce ?? request.nonce ?? randomUUID(),
    selectedAt: new Date(selectedAtMs).toISOString(),
    expiresAt: new Date(selectedAtMs + CONTROLLER_SELECTION_VALIDITY_MS).toISOString(),
    trustPolicySha256,
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
  options = {},
) {
  try {
    const existing = await readControllerSelectionReceipt(paths, request, rootUid, {
      allowExpired: true,
    });
    let fresh = true;
    try {
      assertControllerSelectionReceiptFresh(existing, options.now ?? Date.now());
    } catch {
      fresh = false;
    }
    if (fresh && existing.schemaVersion === CONTROLLER_SELECTION_SCHEMA_VERSION) {
      const trustPolicySha256 =
        staged.trustPolicySha256 ?? staged.candidateRoot?.digest ?? staged.trusted?.root?.digest;
      if (
        existing.releaseCommit !== staged.releaseCommit ||
        existing.targetManifestSha256 !== staged.targetManifestSha256 ||
        existing.controllerServerSha256 !== staged.identity?.serverSha256 ||
        existing.controllerClientSha256 !== staged.identity?.clientSha256 ||
        existing.controllerInstanceId !== controllerInstanceId ||
        existing.trustPolicySha256 !== trustPolicySha256
      ) {
        const active = await readRootProductTransaction(paths, rootUid);
        if (active?.selectionDigest === existing.selectionDigest) {
          fail("controller selection receipt equivocation was detected");
        }
      } else {
        return existing;
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  const receipt = createControllerSelectionReceipt(request, staged, controllerInstanceId, options);
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

async function readControllerSelectionReceipt(paths, request, rootUid = 0, options = {}) {
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
  if (options.allowExpired !== true) {
    assertControllerSelectionReceiptFresh(receipt, options.now ?? Date.now());
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
      rootTransactionPath: "/var/lib/fased-host-updater/supervisor/product-transaction.json",
      productJournalPath: "/var/lib/fased-host-updater/active-signer-transaction.json",
      productVersionPath: "/var/lib/fased-host-updater/signer-version",
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
    rootTransactionPath: `${state}/supervisor/product-transaction.json`,
    productJournalPath: `${state}/active-signer-transaction.json`,
    productVersionPath: `${state}/signer-version`,
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
  const schemaVersion = Number(value?.schemaVersion);
  const operation = String(value?.op ?? "");
  const hasRecoveryDigest = operation === "recoverActive";
  exactKeys(
    value,
    schemaVersion === 2
      ? [
          "schemaVersion",
          "op",
          "transactionId",
          "version",
          ...(hasRecoveryDigest ? ["recoveryDigest"] : []),
        ]
      : [
          "schemaVersion",
          "op",
          "transactionId",
          "nonce",
          "version",
          "clientCapabilities",
          ...(hasRecoveryDigest ? ["recoveryDigest"] : []),
          ...(hasRecoveryDigest ? ["recoveryControllerVersion"] : []),
        ],
    "lifecycle supervisor request",
  );
  if (!new Set([2, 3]).has(schemaVersion)) {
    fail("unsupported lifecycle supervisor request schema");
  }
  if (RECOVERY_OPERATIONS.has(operation) && schemaVersion !== 3) {
    fail("lifecycle recovery requires the current authenticated request schema");
  }
  const op = operation;
  if (op !== "updateController" && !CONTROLLER_OPERATIONS.has(op) && !RECOVERY_OPERATIONS.has(op)) {
    fail("unsupported lifecycle supervisor operation");
  }
  const transactionId = String(value.transactionId ?? "")
    .trim()
    .toLowerCase();
  if (!TRANSACTION_ID_PATTERN.test(transactionId)) {
    fail("lifecycle supervisor transactionId must be a UUIDv4");
  }
  let nonce = transactionId;
  let clientCapabilities = Object.freeze({ protocolVersion: 1, requestSchema: 2 });
  if (schemaVersion === 3) {
    exactKeys(
      value.clientCapabilities,
      ["protocolVersion", "requestSchema"],
      "lifecycle supervisor client capabilities",
    );
    nonce = String(value.nonce ?? "")
      .trim()
      .toLowerCase();
    clientCapabilities = Object.freeze({
      protocolVersion: Number(value.clientCapabilities.protocolVersion),
      requestSchema: Number(value.clientCapabilities.requestSchema),
    });
    if (
      !TRANSACTION_ID_PATTERN.test(nonce) ||
      (hasRecoveryDigest && nonce === transactionId) ||
      canonicalRootValue(clientCapabilities) !== canonicalRootValue(SUPERVISOR_CLIENT_CAPABILITIES)
    ) {
      fail("lifecycle supervisor request nonce or capabilities are invalid");
    }
  }
  const recoveryDigest = hasRecoveryDigest ? String(value.recoveryDigest ?? "") : null;
  const recoveryControllerVersion = hasRecoveryDigest
    ? parseVersion(value.recoveryControllerVersion)
    : null;
  if (hasRecoveryDigest && !DIGEST_PATTERN.test(recoveryDigest)) {
    fail("lifecycle supervisor recovery digest is invalid");
  }
  return Object.freeze({
    schemaVersion,
    op,
    transactionId,
    nonce,
    version: parseVersion(value.version),
    clientCapabilities,
    ...(hasRecoveryDigest ? { recoveryDigest, recoveryControllerVersion } : {}),
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
  const releasesRoot = path.dirname(generationRoot);
  const releasesInfo = await fsp.lstat(releasesRoot);
  const info = await fsp.lstat(generationRoot);
  if (
    !releasesInfo.isDirectory() ||
    releasesInfo.isSymbolicLink() ||
    releasesInfo.uid !== expectedRootUid ||
    (releasesInfo.mode & 0o022) !== 0 ||
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== expectedRootUid ||
    (info.mode & 0o022) !== 0
  ) {
    fail("controller releases and generation must be real root-owned immutable directories");
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

function supervisorSelectionLink(paths, name) {
  if (!new Set(["current", "known-good"]).has(name)) {
    fail("lifecycle supervisor selection name is invalid");
  }
  return path.join(paths.supervisorStateDir, `supervisor-${name}`);
}

async function readSupervisorSelection(paths, name, rootUid, rootGid) {
  const linkPath = supervisorSelectionLink(paths, name);
  const target = await fsp.realpath(linkPath);
  const generationsRoot = path.resolve(paths.supervisorStateDir, "supervisor-generations");
  if (
    path.dirname(target) !== generationsRoot ||
    !/^[a-f0-9]{64}\.mjs$/u.test(path.basename(target))
  ) {
    fail(`lifecycle supervisor ${name} selection escaped its immutable generations`);
  }
  const digest = path.basename(target, ".mjs");
  await assertSupervisorGeneration(target, digest, rootUid, rootGid);
  return Object.freeze({ linkPath, target, digest });
}

async function selectSupervisorGeneration(paths, name, generationPath, digest, rootUid, rootGid) {
  await assertSupervisorGeneration(generationPath, digest, rootUid, rootGid);
  await atomicSymlink(generationPath, supervisorSelectionLink(paths, name));
  return await readSupervisorSelection(paths, name, rootUid, rootGid);
}

async function ensureSupervisorKnownGood(paths, generationPath, digest, rootUid, rootGid) {
  try {
    return await readSupervisorSelection(paths, "known-good", rootUid, rootGid);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  return await selectSupervisorGeneration(
    paths,
    "known-good",
    generationPath,
    digest,
    rootUid,
    rootGid,
  );
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
  await ensureSupervisorKnownGood(
    paths,
    staged.previousSupervisorGeneration,
    staged.previousSupervisorDigest,
    rootUid,
    rootGid,
  );
  await selectSupervisorGeneration(
    paths,
    "current",
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
  await selectSupervisorGeneration(
    paths,
    "current",
    previousPath,
    staged.previousSupervisorDigest,
    rootUid,
    rootGid,
  );
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

async function readDurableReceipt(paths, request, allowedOperations = [request.op]) {
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
      !allowedOperations.includes(receipt.operation) ||
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
  if (
    transaction.supervisorChanged &&
    context.runningSupervisorDigest === transaction.targetSupervisorDigest
  ) {
    const activeDigest = await sha256(context.paths.supervisorPath);
    if (activeDigest !== transaction.targetSupervisorDigest) {
      fail("running lifecycle supervisor does not match its selected target slot");
    }
    const targetGeneration = supervisorGenerationPath(
      context.paths,
      transaction.targetSupervisorDigest,
    );
    await selectSupervisorGeneration(
      context.paths,
      "current",
      targetGeneration,
      transaction.targetSupervisorDigest,
      context.rootUid,
      context.rootGid,
    );
    const identity = await context.readControllerIdentity(context.paths, context.rootUid);
    if (
      !identity ||
      identity.version !== transaction.request.version ||
      !(await context.currentControllerMatches(context.paths, identity, context.rootUid))
    ) {
      fail("target lifecycle supervisor started before its controller selection converged");
    }
    const trusted = await context.readLifecycleTrust(context.paths, context.rootUid, context.now());
    if (trusted.state.targetsVersion !== transaction.request.version) {
      fail("target lifecycle supervisor started before its trust state converged");
    }
    await selectSupervisorGeneration(
      context.paths,
      "known-good",
      targetGeneration,
      transaction.targetSupervisorDigest,
      context.rootUid,
      context.rootGid,
    );
    await clearSupervisorTransaction(context.paths);
    return false;
  }
  if (
    transaction.supervisorChanged &&
    context.runningSupervisorDigest !== transaction.previousSupervisorDigest
  ) {
    fail("running lifecycle supervisor matches neither transaction slot");
  }
  await restoreControllerSelection(context.paths, transaction);
  await context.restoreSupervisorSelection(context.paths, transaction);
  await restoreLifecycleTrust(context.paths, transaction.previousTrust);
  await context.restartController();
  await context.waitForController();
  await clearSupervisorTransaction(context.paths);
  return true;
}

function parseRootProductTransaction(value) {
  const schemaVersion = Number(value?.schemaVersion);
  exactKeys(
    value,
    [
      "schemaVersion",
      ...(schemaVersion >= 2
        ? ["protocolVersion", "requestNonce", "clientCapabilities", "rollbackPointers"]
        : []),
      ...(schemaVersion === ROOT_LEDGER_SCHEMA_VERSION
        ? [
            "legacyAdoptionDigest",
            "legacyAdoptionTransactionId",
            "legacyAdoptionPreviousVersion",
            "legacyAdoptionTargetVersion",
            "legacyAdoptionAckDigest",
          ]
        : []),
      "transactionId",
      "version",
      "phase",
      "operation",
      "previousVersion",
      "previousControllerIdentity",
      "previousControllerGenerationVersion",
      "targetControllerReceipt",
      "targetReleaseIdentity",
      "artifactDigests",
      "targetJournalSha256",
      "selectionDigest",
      "durableCommitDecision",
      "legacyAdopted",
      "recoveryAttempts",
      "lastErrorClass",
      "createdAt",
      "updatedAt",
    ],
    "root product transaction",
  );
  const transactionId = String(value.transactionId ?? "").toLowerCase();
  const version = parseVersion(value.version);
  const previousVersion =
    value.previousVersion === null ? null : parseVersion(value.previousVersion);
  const selectionDigest = value.selectionDigest === null ? null : String(value.selectionDigest);
  let previousControllerIdentity = null;
  if (value.previousControllerIdentity !== null) {
    exactKeys(
      value.previousControllerIdentity,
      ["schemaVersion", "version", "serverSha256", "clientSha256"],
      "root product transaction previous controller identity",
    );
    previousControllerIdentity = Object.freeze({
      schemaVersion: Number(value.previousControllerIdentity.schemaVersion),
      version: parseVersion(value.previousControllerIdentity.version),
      serverSha256: String(value.previousControllerIdentity.serverSha256 ?? ""),
      clientSha256: String(value.previousControllerIdentity.clientSha256 ?? ""),
    });
    if (
      previousControllerIdentity.schemaVersion !== 1 ||
      !DIGEST_PATTERN.test(previousControllerIdentity.serverSha256) ||
      !DIGEST_PATTERN.test(previousControllerIdentity.clientSha256)
    ) {
      fail("root product transaction previous controller identity is invalid");
    }
  }
  const previousControllerGenerationVersion =
    value.previousControllerGenerationVersion === null
      ? null
      : parseVersion(value.previousControllerGenerationVersion);
  const protocolVersion = schemaVersion >= 2 ? Number(value.protocolVersion) : 1;
  const requestNonce =
    schemaVersion >= 2 ? String(value.requestNonce ?? "").toLowerCase() : transactionId;
  const clientCapabilities =
    schemaVersion >= 2 ? value.clientCapabilities : { protocolVersion: 1, requestSchema: 2 };
  exactKeys(
    clientCapabilities,
    ["protocolVersion", "requestSchema"],
    "root product transaction client capabilities",
  );
  const normalizedClientCapabilities = Object.freeze({
    protocolVersion: Number(clientCapabilities.protocolVersion),
    requestSchema: Number(clientCapabilities.requestSchema),
  });
  const clientCapabilityPair = `${normalizedClientCapabilities.protocolVersion}:${normalizedClientCapabilities.requestSchema}`;
  const rollbackPointers =
    schemaVersion >= 2
      ? value.rollbackPointers
      : {
          controllerGenerationVersion: previousControllerGenerationVersion,
          productVersion: previousVersion,
        };
  exactKeys(
    rollbackPointers,
    ["controllerGenerationVersion", "productVersion"],
    "root product transaction rollback pointers",
  );
  const normalizedRollbackPointers = Object.freeze({
    controllerGenerationVersion:
      rollbackPointers.controllerGenerationVersion === null
        ? null
        : parseVersion(rollbackPointers.controllerGenerationVersion),
    productVersion:
      rollbackPointers.productVersion === null
        ? null
        : parseVersion(rollbackPointers.productVersion),
  });
  if (
    (previousControllerIdentity !== null &&
      previousControllerIdentity.version !== previousControllerGenerationVersion) ||
    (previousControllerIdentity === null) !== (previousControllerGenerationVersion === null)
  ) {
    fail("root product transaction previous controller generation is inconsistent");
  }
  const targetControllerReceipt =
    value.targetControllerReceipt === null
      ? null
      : parseControllerSelectionReceipt(value.targetControllerReceipt);
  if (
    targetControllerReceipt &&
    (targetControllerReceipt.transactionId !== transactionId ||
      targetControllerReceipt.version !== version ||
      targetControllerReceipt.selectionDigest !== selectionDigest)
  ) {
    fail("root product transaction target controller receipt is mismatched");
  }
  let targetReleaseIdentity = null;
  if (value.targetReleaseIdentity !== null) {
    exactKeys(
      value.targetReleaseIdentity,
      ["version", "commit", "buildInputDigest", "development"],
      "root product transaction release identity",
    );
    targetReleaseIdentity = Object.freeze({
      version: parseVersion(value.targetReleaseIdentity.version),
      commit: String(value.targetReleaseIdentity.commit ?? ""),
      buildInputDigest: String(value.targetReleaseIdentity.buildInputDigest ?? ""),
      development: value.targetReleaseIdentity.development,
    });
    if (
      targetReleaseIdentity.version !== version ||
      !COMMIT_PATTERN.test(targetReleaseIdentity.commit) ||
      !/^sha256:[a-f0-9]{64}$/u.test(targetReleaseIdentity.buildInputDigest) ||
      targetReleaseIdentity.development !== false
    ) {
      fail("root product transaction release identity is invalid");
    }
  }
  let artifactDigests = null;
  if (value.artifactDigests !== null) {
    exactKeys(
      value.artifactDigests,
      ["application", "dependencies", "signer", "updaterBundle"],
      "root product transaction artifact digests",
    );
    artifactDigests = Object.freeze(
      Object.fromEntries(
        Object.entries(value.artifactDigests).map(([name, artifactDigest]) => {
          if (artifactDigest !== null && typeof artifactDigest !== "string") {
            fail(`root product transaction ${name} digest is invalid`);
          }
          const normalized = artifactDigest;
          if (normalized !== null && !DIGEST_PATTERN.test(normalized)) {
            fail(`root product transaction ${name} digest is invalid`);
          }
          return [name, normalized];
        }),
      ),
    );
  }
  const targetJournalSha256 =
    value.targetJournalSha256 === null ? null : String(value.targetJournalSha256);
  const recoveryAttempts = Number(value.recoveryAttempts);
  const lastErrorClass = value.lastErrorClass === null ? null : String(value.lastErrorClass);
  const createdAt = Date.parse(String(value.createdAt ?? ""));
  const updatedAt = Date.parse(String(value.updatedAt ?? ""));
  if (
    !new Set([1, 2, ROOT_LEDGER_SCHEMA_VERSION]).has(schemaVersion) ||
    (schemaVersion >= 2 &&
      (protocolVersion !== ROOT_LEDGER_PROTOCOL_VERSION ||
        !TRANSACTION_ID_PATTERN.test(requestNonce) ||
        !new Set(["1:2", "2:3"]).has(clientCapabilityPair))) ||
    normalizedRollbackPointers.controllerGenerationVersion !==
      previousControllerGenerationVersion ||
    normalizedRollbackPointers.productVersion !== previousVersion ||
    !TRANSACTION_ID_PATTERN.test(transactionId) ||
    !ROOT_TRANSACTION_PHASES.has(value.phase) ||
    (value.operation !== "updateController" && !ROOT_TRANSACTION_OPERATIONS.has(value.operation)) ||
    (selectionDigest !== null && !DIGEST_PATTERN.test(selectionDigest)) ||
    (targetJournalSha256 !== null && !DIGEST_PATTERN.test(targetJournalSha256)) ||
    typeof value.durableCommitDecision !== "boolean" ||
    typeof value.legacyAdopted !== "boolean" ||
    !Number.isSafeInteger(recoveryAttempts) ||
    recoveryAttempts < 0 ||
    recoveryAttempts > MAX_ROOT_RECOVERY_ATTEMPTS ||
    (lastErrorClass !== null && !/^[A-Z][A-Z0-9_]{0,63}$/u.test(lastErrorClass)) ||
    Number.isNaN(createdAt) ||
    new Date(createdAt).toISOString() !== value.createdAt ||
    Number.isNaN(updatedAt) ||
    new Date(updatedAt).toISOString() !== value.updatedAt ||
    updatedAt < createdAt
  ) {
    fail("root product transaction is malformed");
  }
  const legacyAdoptionDigest =
    schemaVersion === ROOT_LEDGER_SCHEMA_VERSION ? value.legacyAdoptionDigest : null;
  const legacyAdoptionTransactionId =
    schemaVersion === ROOT_LEDGER_SCHEMA_VERSION ? value.legacyAdoptionTransactionId : null;
  const legacyAdoptionPreviousVersion =
    schemaVersion === ROOT_LEDGER_SCHEMA_VERSION ? value.legacyAdoptionPreviousVersion : null;
  const legacyAdoptionTargetVersion =
    schemaVersion === ROOT_LEDGER_SCHEMA_VERSION ? value.legacyAdoptionTargetVersion : null;
  const legacyAdoptionAckDigest =
    schemaVersion === ROOT_LEDGER_SCHEMA_VERSION ? value.legacyAdoptionAckDigest : null;
  if (
    (legacyAdoptionDigest === null) !== (legacyAdoptionTransactionId === null) ||
    (legacyAdoptionDigest === null) !== (legacyAdoptionPreviousVersion === null) ||
    (legacyAdoptionDigest === null) !== (legacyAdoptionTargetVersion === null) ||
    (legacyAdoptionDigest !== null &&
      (!/^sha256:[a-f0-9]{64}$/u.test(legacyAdoptionDigest) ||
        !TRANSACTION_ID_PATTERN.test(legacyAdoptionTransactionId) ||
        parseVersion(legacyAdoptionPreviousVersion) !== previousVersion ||
        parseVersion(legacyAdoptionTargetVersion) !== version)) ||
    (legacyAdoptionAckDigest !== null &&
      (!/^sha256:[a-f0-9]{64}$/u.test(legacyAdoptionAckDigest) ||
        legacyAdoptionDigest === null ||
        value.phase !== "commit-acknowledged")) ||
    (value.phase === "commit-acknowledged" && legacyAdoptionAckDigest === null)
  ) {
    fail("root product transaction legacy adoption binding is invalid");
  }
  return Object.freeze({
    ...value,
    schemaVersion,
    protocolVersion,
    requestNonce,
    clientCapabilities: normalizedClientCapabilities,
    rollbackPointers: normalizedRollbackPointers,
    transactionId,
    version,
    previousVersion,
    previousControllerIdentity,
    previousControllerGenerationVersion,
    targetControllerReceipt,
    targetReleaseIdentity,
    artifactDigests,
    targetJournalSha256,
    selectionDigest,
    legacyAdopted: value.legacyAdopted,
    recoveryAttempts,
    lastErrorClass,
    legacyAdoptionDigest,
    legacyAdoptionTransactionId,
    legacyAdoptionPreviousVersion,
    legacyAdoptionTargetVersion,
    legacyAdoptionAckDigest,
  });
}

async function readRootProductTransaction(paths, rootUid) {
  try {
    return parseRootProductTransaction(
      await readProtectedJson(paths.rootTransactionPath, "root product transaction", rootUid),
    );
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function assertRootProductTransactionTransition(previous, next) {
  if (
    previous.transactionId !== next.transactionId ||
    previous.version !== next.version ||
    previous.previousVersion !== next.previousVersion ||
    previous.previousControllerGenerationVersion !== next.previousControllerGenerationVersion ||
    canonicalRootValue(previous.previousControllerIdentity) !==
      canonicalRootValue(next.previousControllerIdentity) ||
    canonicalRootValue(previous.targetControllerReceipt) !==
      canonicalRootValue(next.targetControllerReceipt) ||
    previous.selectionDigest !== next.selectionDigest ||
    previous.requestNonce !== next.requestNonce ||
    canonicalRootValue(previous.clientCapabilities) !==
      canonicalRootValue(next.clientCapabilities) ||
    canonicalRootValue(previous.rollbackPointers) !== canonicalRootValue(next.rollbackPointers) ||
    previous.legacyAdopted !== next.legacyAdopted ||
    previous.legacyAdoptionDigest !== next.legacyAdoptionDigest ||
    previous.legacyAdoptionTransactionId !== next.legacyAdoptionTransactionId ||
    previous.legacyAdoptionPreviousVersion !== next.legacyAdoptionPreviousVersion ||
    previous.legacyAdoptionTargetVersion !== next.legacyAdoptionTargetVersion ||
    previous.createdAt !== next.createdAt
  ) {
    fail("root product transaction identity cannot change during recovery");
  }
  if (
    previous.legacyAdoptionAckDigest !== null &&
    previous.legacyAdoptionAckDigest !== next.legacyAdoptionAckDigest
  ) {
    fail("root product transaction legacy adoption acknowledgment cannot change");
  }
  if (previous.durableCommitDecision === true && next.durableCommitDecision !== true) {
    fail("root product transaction cannot reverse its durable commit decision");
  }
  if (
    next.durableCommitDecision === true &&
    new Set(["rolling-back", "restored"]).has(next.phase)
  ) {
    fail("root product transaction cannot roll back after its durable commit decision");
  }
  if (next.recoveryAttempts < previous.recoveryAttempts) {
    fail("root product transaction recovery attempts cannot decrease");
  }
  if (
    previous.targetReleaseIdentity &&
    canonicalRootValue(previous.targetReleaseIdentity) !==
      canonicalRootValue(next.targetReleaseIdentity)
  ) {
    fail("root product transaction release identity cannot change");
  }
  for (const name of ["application", "dependencies", "signer", "updaterBundle"]) {
    if (
      previous.artifactDigests?.[name] &&
      previous.artifactDigests[name] !== next.artifactDigests?.[name]
    ) {
      fail(`root product transaction ${name} digest cannot change`);
    }
  }
  if (previous.phase === next.phase) {
    return;
  }
  if (next.phase === "product-recovered" && previous.phase !== "selected") {
    return;
  }
  if (
    next.phase === "dispatching" &&
    (previous.phase === "selected" || ROOT_FORWARD_PHASES.includes(previous.phase))
  ) {
    return;
  }
  if (
    next.phase === "rolling-back" &&
    previous.durableCommitDecision === false &&
    ROOT_PRECOMMIT_PHASES.has(previous.phase)
  ) {
    return;
  }
  if (previous.phase === "rolling-back" && next.phase === "restored") {
    return;
  }
  if (previous.phase === "legacy-recovery" && ROOT_FORWARD_PHASES.includes(next.phase)) {
    return;
  }
  if (previous.phase === "product-recovered" && next.phase === "commit-ack-pending") {
    return;
  }
  if (previous.phase === "dispatching" && ROOT_FORWARD_PHASES.includes(next.phase)) {
    return;
  }
  const previousIndex = ROOT_FORWARD_PHASES.indexOf(previous.phase);
  const nextIndex = ROOT_FORWARD_PHASES.indexOf(next.phase);
  if (previousIndex >= 0 && nextIndex >= previousIndex) {
    return;
  }
  fail(`root product transaction cannot advance from ${previous.phase} to ${next.phase}`);
}

function assertRootProductJournalBinding(transaction, productJournal) {
  if (!productJournal) {
    return;
  }
  if (
    productJournal.transactionId !== transaction.transactionId ||
    productJournal.version !== transaction.version ||
    productJournal.previousVersion !== transaction.previousVersion
  ) {
    fail("root and target-controller transactions disagree");
  }
  if (
    transaction.selectionDigest !== null &&
    productJournal.selectionDigest !== transaction.selectionDigest
  ) {
    fail("target-controller journal selection digest is not root-authorized");
  }
  if (
    transaction.targetControllerReceipt !== null &&
    canonicalRootValue(productJournal.targetControllerReceipt) !==
      canonicalRootValue(transaction.targetControllerReceipt)
  ) {
    fail("target-controller journal receipt is not root-authorized");
  }
  if (
    transaction.targetReleaseIdentity !== null &&
    canonicalRootValue(productJournal.targetReleaseIdentity) !==
      canonicalRootValue(transaction.targetReleaseIdentity)
  ) {
    fail("target-controller journal release identity changed during recovery");
  }
  for (const name of ["application", "dependencies", "signer", "updaterBundle"]) {
    if (
      transaction.artifactDigests?.[name] !== null &&
      transaction.artifactDigests?.[name] !== undefined &&
      productJournal.artifactDigests?.[name] !== transaction.artifactDigests[name]
    ) {
      fail(`target-controller journal ${name} digest changed during recovery`);
    }
  }
  if (
    canonicalRootValue(productJournal.legacyAdoption) !==
    canonicalRootValue(rootLegacyAdoptionBinding(transaction))
  ) {
    fail("target-controller journal legacy adoption binding is not root-authorized");
  }
}

async function writeRootProductTransaction(paths, value, rootUid = 0, rootGid = 0) {
  const parsed = parseRootProductTransaction(value);
  const previous = await readRootProductTransaction(paths, rootUid);
  if (previous) {
    assertRootProductTransactionTransition(previous, parsed);
  }
  await atomicWrite(paths.rootTransactionPath, `${JSON.stringify(parsed, null, 2)}\n`, 0o600);
  await fsp.chown(paths.rootTransactionPath, rootUid, rootGid);
  await fsp.chmod(paths.rootTransactionPath, 0o600);
  return parsed;
}

async function clearRootProductTransaction(paths) {
  await fsp.rm(paths.rootTransactionPath, { force: true });
  await fsyncDirectory(paths.supervisorStateDir);
}

async function readControllerProductJournal(paths, rootUid) {
  try {
    const value = await readProtectedJson(
      paths.productJournalPath,
      "target-controller product transaction",
      rootUid,
    );
    const transactionId = String(value?.transactionId ?? "").toLowerCase();
    const version = parseVersion(value?.version);
    if (
      !TRANSACTION_ID_PATTERN.test(transactionId) ||
      typeof value?.phase !== "string" ||
      !value.phase
    ) {
      fail("target-controller product transaction identity is invalid");
    }
    const targetControllerReceipt =
      value?.supervisorReceipt == null
        ? null
        : parseControllerSelectionReceipt(value.supervisorReceipt);
    const selectionDigest = targetControllerReceipt?.selectionDigest ?? null;
    const normalizeDigest = (candidate) => {
      const normalized = String(candidate ?? "").replace(/^sha256:/u, "");
      return DIGEST_PATTERN.test(normalized) ? normalized : null;
    };
    const artifactDigests = Object.freeze({
      application: normalizeDigest(
        value?.managedApplication?.nextManifest?.release?.application?.digest,
      ),
      dependencies: normalizeDigest(
        value?.managedApplication?.nextManifest?.release?.application?.dependencies?.digest,
      ),
      signer: normalizeDigest(value?.releaseBinding?.signerArtifactDigest),
      updaterBundle: normalizeDigest(value?.managedApplication?.updaterGeneration?.bundleDigest),
    });
    const legacyAdoption =
      value?.legacyAdoption == null
        ? null
        : Object.freeze({
            receiptDigest: String(value.legacyAdoption.receiptDigest ?? ""),
            transactionId: String(value.legacyAdoption.transactionId ?? "").toLowerCase(),
          });
    if (
      legacyAdoption &&
      (!/^sha256:[a-f0-9]{64}$/u.test(legacyAdoption.receiptDigest) ||
        !TRANSACTION_ID_PATTERN.test(legacyAdoption.transactionId))
    ) {
      fail("target-controller product transaction legacy adoption binding is invalid");
    }
    return Object.freeze({
      schemaVersion: Number(value.schemaVersion),
      transactionId,
      version,
      phase: value.phase,
      previousVersion:
        value.previousVersion === null || value.previousVersion === undefined
          ? null
          : parseVersion(value.previousVersion),
      selectionDigest,
      targetControllerReceipt,
      targetReleaseIdentity:
        value?.release == null
          ? null
          : Object.freeze({
              version: parseVersion(value.release.version),
              commit: String(value.release.commit ?? ""),
              buildInputDigest: String(value.release.buildInputDigest ?? ""),
              development: value.release.development,
            }),
      artifactDigests,
      legacyAdoption,
      journalSha256: createHash("sha256").update(canonicalRootValue(value)).digest("hex"),
    });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function readProductVersion(paths, rootUid) {
  try {
    const info = await fsp.lstat(paths.productVersionPath);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      info.uid !== rootUid ||
      (info.mode & 0o077) !== 0 ||
      info.size <= 0 ||
      info.size > 256
    ) {
      fail("installed product release identity is not protected");
    }
    return parseVersion((await fsp.readFile(paths.productVersionPath, "utf8")).trim());
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function rootProductTransactionRecord({
  request,
  phase,
  operation = request.op,
  previousVersion = null,
  previousControllerIdentity = null,
  previousControllerGenerationVersion = null,
  requestNonce = request.nonce ?? request.transactionId,
  clientCapabilities = request.clientCapabilities ??
    Object.freeze({ protocolVersion: 1, requestSchema: 2 }),
  rollbackPointers = null,
  targetControllerReceipt = null,
  targetReleaseIdentity = null,
  artifactDigests = null,
  targetJournalSha256 = null,
  selectionDigest = null,
  durableCommitDecision = false,
  legacyAdopted = false,
  legacyAdoptionDigest = null,
  legacyAdoptionTransactionId = null,
  legacyAdoptionPreviousVersion = null,
  legacyAdoptionTargetVersion = null,
  legacyAdoptionAckDigest = null,
  recoveryAttempts = 0,
  lastErrorClass = null,
  createdAt = null,
  now = Date.now(),
}) {
  const timestamp = new Date(now).toISOString();
  return parseRootProductTransaction({
    schemaVersion: ROOT_LEDGER_SCHEMA_VERSION,
    protocolVersion: ROOT_LEDGER_PROTOCOL_VERSION,
    requestNonce,
    clientCapabilities,
    rollbackPointers: rollbackPointers ?? {
      controllerGenerationVersion: previousControllerGenerationVersion,
      productVersion: previousVersion,
    },
    transactionId: request.transactionId,
    version: request.version,
    phase,
    operation,
    previousVersion,
    previousControllerIdentity,
    previousControllerGenerationVersion,
    targetControllerReceipt,
    targetReleaseIdentity,
    artifactDigests,
    targetJournalSha256,
    selectionDigest,
    durableCommitDecision,
    legacyAdopted,
    legacyAdoptionDigest,
    legacyAdoptionTransactionId,
    legacyAdoptionPreviousVersion,
    legacyAdoptionTargetVersion,
    legacyAdoptionAckDigest,
    recoveryAttempts,
    lastErrorClass,
    createdAt: createdAt ?? timestamp,
    updatedAt: timestamp,
  });
}

function advanceRootProductTransaction(
  transaction,
  {
    request = {
      transactionId: transaction.transactionId,
      version: transaction.version,
      op: transaction.operation,
    },
    phase = transaction.phase,
    operation = transaction.operation,
    targetReleaseIdentity = transaction.targetReleaseIdentity,
    artifactDigests = transaction.artifactDigests,
    targetJournalSha256 = transaction.targetJournalSha256,
    durableCommitDecision = transaction.durableCommitDecision,
    legacyAdopted = transaction.legacyAdopted,
    legacyAdoptionDigest = transaction.legacyAdoptionDigest,
    legacyAdoptionTransactionId = transaction.legacyAdoptionTransactionId,
    legacyAdoptionPreviousVersion = transaction.legacyAdoptionPreviousVersion,
    legacyAdoptionTargetVersion = transaction.legacyAdoptionTargetVersion,
    legacyAdoptionAckDigest = transaction.legacyAdoptionAckDigest,
    recoveryAttempts = transaction.recoveryAttempts,
    lastErrorClass = transaction.lastErrorClass,
    now = Date.now(),
  } = {},
) {
  return rootProductTransactionRecord({
    request,
    phase,
    operation,
    previousVersion: transaction.previousVersion,
    previousControllerIdentity: transaction.previousControllerIdentity,
    previousControllerGenerationVersion: transaction.previousControllerGenerationVersion,
    requestNonce: transaction.requestNonce,
    clientCapabilities: transaction.clientCapabilities,
    rollbackPointers: transaction.rollbackPointers,
    targetControllerReceipt: transaction.targetControllerReceipt,
    targetReleaseIdentity,
    artifactDigests,
    targetJournalSha256,
    selectionDigest: transaction.selectionDigest,
    durableCommitDecision,
    legacyAdopted,
    legacyAdoptionDigest,
    legacyAdoptionTransactionId,
    legacyAdoptionPreviousVersion,
    legacyAdoptionTargetVersion,
    legacyAdoptionAckDigest,
    recoveryAttempts,
    lastErrorClass,
    createdAt: transaction.createdAt,
    now,
  });
}

function recoveryErrorClass(error) {
  const candidate = String(error?.code ?? "").toUpperCase();
  return /^[A-Z][A-Z0-9_]{0,63}$/u.test(candidate) ? candidate : "RECOVERY_FAILED";
}

function lifecycleRecoveryState(supervisorTransaction, transaction, productJournal, error = null) {
  if (!supervisorTransaction && !transaction && !productJournal && !error) {
    return Object.freeze({ state: "READY" });
  }
  if (error) {
    return Object.freeze({
      state: "INVALID_LEDGER",
      lastErrorClass: "INVALID_LEDGER",
    });
  }
  const transactionId =
    supervisorTransaction?.request?.transactionId ??
    transaction?.transactionId ??
    productJournal?.transactionId ??
    null;
  const targetVersion =
    supervisorTransaction?.request?.version ??
    transaction?.version ??
    productJournal?.version ??
    null;
  const journalDigest = recoveryBindingDigest(supervisorTransaction, transaction, productJournal);
  const identityDigest = recoveryIdentityDigest(supervisorTransaction, transaction, productJournal);
  const targetControllerReceipt = transaction?.targetControllerReceipt ?? null;
  return Object.freeze({
    state: "RECOVERY_PENDING",
    source: supervisorTransaction ? "supervisor" : "product",
    transactionId,
    targetVersion,
    phase: supervisorTransaction
      ? "controller-selection"
      : (productJournal?.phase ?? transaction?.phase ?? null),
    durableCommitDecision:
      transaction?.durableCommitDecision === true ||
      new Set(["gateway-verified", "committing"]).has(productJournal?.phase),
    journalDigest,
    recoveryIdentityDigest: identityDigest,
    recoveryAttempts: transaction?.recoveryAttempts ?? 0,
    lastErrorClass: transaction?.lastErrorClass ?? null,
    controller:
      targetControllerReceipt === null
        ? null
        : Object.freeze({
            version: targetControllerReceipt.version,
            serverSha256: targetControllerReceipt.controllerServerSha256,
            clientSha256: targetControllerReceipt.controllerClientSha256,
            processInstanceId: targetControllerReceipt.controllerInstanceId,
            selectionDigest: targetControllerReceipt.selectionDigest,
            protocolCapabilities: targetControllerReceipt.protocolCapabilities,
          }),
  });
}

function recoveryBindingDigest(supervisorTransaction, transaction, productJournal) {
  return createHash("sha256")
    .update(
      canonicalRootValue({
        schemaVersion: 1,
        supervisorTransaction,
        rootProductTransaction: transaction,
        controllerProductJournal: productJournal,
      }),
    )
    .digest("hex");
}

function recoveryIdentityDigest(supervisorTransaction, transaction, productJournal) {
  return createHash("sha256")
    .update(
      canonicalRootValue({
        schemaVersion: 1,
        source: supervisorTransaction ? "supervisor" : "product",
        supervisor: supervisorTransaction
          ? {
              transactionId: supervisorTransaction.request.transactionId,
              version: supervisorTransaction.request.version,
              previousGeneration: supervisorTransaction.previousGeneration,
              previousIdentity: supervisorTransaction.previousIdentity,
              targetSupervisorDigest: supervisorTransaction.targetSupervisorDigest,
              previousSupervisorDigest: supervisorTransaction.previousSupervisorDigest,
            }
          : null,
        root: transaction
          ? {
              transactionId: transaction.transactionId,
              version: transaction.version,
              phase: transaction.phase,
              previousVersion: transaction.previousVersion,
              previousControllerIdentity: transaction.previousControllerIdentity,
              targetControllerReceipt: transaction.targetControllerReceipt,
              targetReleaseIdentity: transaction.targetReleaseIdentity,
              artifactDigests: transaction.artifactDigests,
              selectionDigest: transaction.selectionDigest,
              durableCommitDecision: transaction.durableCommitDecision,
              rollbackPointers: transaction.rollbackPointers,
            }
          : null,
        product: productJournal
          ? {
              transactionId: productJournal.transactionId,
              version: productJournal.version,
              phase: productJournal.phase,
              previousVersion: productJournal.previousVersion,
              selectionDigest: productJournal.selectionDigest,
              targetControllerReceipt: productJournal.targetControllerReceipt,
              targetReleaseIdentity: productJournal.targetReleaseIdentity,
              artifactDigests: productJournal.artifactDigests,
            }
          : null,
      }),
    )
    .digest("hex");
}

function assertRecoveryLedgerComposition(supervisorTransaction, transaction, productJournal) {
  if (!supervisorTransaction || (!transaction && !productJournal)) {
    return;
  }
  const productTransactionId = transaction?.transactionId ?? productJournal?.transactionId;
  const productVersion = transaction?.version ?? productJournal?.version;
  const sameSelection =
    supervisorTransaction.request.transactionId === productTransactionId &&
    supervisorTransaction.request.version === productVersion;
  const requiredController =
    transaction?.targetControllerReceipt ?? productJournal?.targetControllerReceipt ?? null;
  const rollbackSlotMatches =
    supervisorTransaction.previousIdentity !== null &&
    requiredController !== null &&
    supervisorTransaction.previousIdentity.version === requiredController.version &&
    supervisorTransaction.previousIdentity.serverSha256 ===
      requiredController.controllerServerSha256 &&
    supervisorTransaction.previousIdentity.clientSha256 ===
      requiredController.controllerClientSha256;
  if (!sameSelection && !rollbackSlotMatches) {
    fail("supervisor and product recovery ledgers have no safe controller dependency");
  }
}

async function inspectRootProductRecovery(context) {
  try {
    const [supervisorTransaction, transaction, productJournal] = await Promise.all([
      context.readSupervisorTransaction(context.paths, context.rootUid),
      context.readRootProductTransaction(context.paths, context.rootUid),
      context.readControllerProductJournal(context.paths, context.rootUid),
    ]);
    assertRecoveryLedgerComposition(supervisorTransaction, transaction, productJournal);
    if (transaction) {
      assertRootProductJournalBinding(transaction, productJournal);
    }
    return lifecycleRecoveryState(supervisorTransaction, transaction, productJournal);
  } catch (error) {
    return lifecycleRecoveryState(null, null, null, error);
  }
}

async function refreshSupervisorRecoveryState(context, state) {
  state.recovery = await inspectRootProductRecovery(context);
  return state.recovery;
}

function explicitRecoveryAttemptPath(context) {
  return path.join(context.paths.supervisorStateDir, "explicit-recovery-attempt.json");
}

async function readExplicitRecoveryAttempt(context) {
  try {
    const value = await readProtectedJson(
      explicitRecoveryAttemptPath(context),
      "explicit recovery attempt",
      context.rootUid,
    );
    exactKeys(
      value,
      [
        "schemaVersion",
        "recoveryIdentityDigest",
        "transactionId",
        "targetVersion",
        "attempts",
        "lastNonce",
        "createdAt",
        "updatedAt",
      ],
      "explicit recovery attempt",
    );
    if (
      value.schemaVersion !== 1 ||
      !DIGEST_PATTERN.test(value.recoveryIdentityDigest || "") ||
      !TRANSACTION_ID_PATTERN.test(value.transactionId || "") ||
      !VERSION_PATTERN.test(value.targetVersion || "") ||
      !Number.isSafeInteger(value.attempts) ||
      value.attempts < 1 ||
      !TRANSACTION_ID_PATTERN.test(value.lastNonce || "") ||
      Number.isNaN(Date.parse(value.createdAt || "")) ||
      Number.isNaN(Date.parse(value.updatedAt || ""))
    ) {
      fail("explicit recovery attempt is invalid");
    }
    return Object.freeze({ ...value });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function authorizeExplicitRecoveryAttempt(context, pending, request) {
  const previous = await readExplicitRecoveryAttempt(context);
  const sameBinding =
    previous?.recoveryIdentityDigest === pending.recoveryIdentityDigest &&
    previous?.transactionId === pending.transactionId &&
    previous?.targetVersion === pending.targetVersion;
  if (sameBinding && previous.lastNonce === request.nonce) {
    fail("explicit recovery request nonce was already consumed");
  }
  // This is an audit counter, not a lifetime lockout. Each client invocation
  // is already bounded and every attempt is bound to the exact protected
  // recovery identity with a one-shot nonce. A transient failure must not make
  // a later ordinary update permanently ineligible to recover.
  const attempts = sameBinding ? Math.min(previous.attempts + 1, Number.MAX_SAFE_INTEGER) : 1;
  const now = new Date(context.now()).toISOString();
  const record = Object.freeze({
    schemaVersion: 1,
    recoveryIdentityDigest: pending.recoveryIdentityDigest,
    transactionId: pending.transactionId,
    targetVersion: pending.targetVersion,
    attempts,
    lastNonce: request.nonce,
    createdAt: sameBinding ? previous.createdAt : now,
    updatedAt: now,
  });
  const attemptPath = explicitRecoveryAttemptPath(context);
  await atomicWrite(attemptPath, `${JSON.stringify(record, null, 2)}\n`, 0o600);
  await fsp.chown(attemptPath, context.rootUid, context.rootGid);
  await fsp.chmod(attemptPath, 0o600);
  return record;
}

async function clearExplicitRecoveryAttempt(context) {
  await fsp.rm(explicitRecoveryAttemptPath(context), { force: true });
  await fsyncDirectory(context.paths.supervisorStateDir);
}

async function verifyRecoveredProduct(transaction, installedVersion, context) {
  if (transaction.targetControllerReceipt) {
    const response = await context.requestController(
      {
        schemaVersion: 2,
        op: "releaseStatus",
        transactionId: transaction.transactionId,
        version: transaction.version,
        supervisorReceipt: transaction.targetControllerReceipt,
      },
      context,
    );
    if (response.ok) {
      if (!new Set(["committed", "rolled-back"]).has(response.phase)) {
        fail("target controller recovery health response has no durable outcome");
      }
      const action = response.phase;
      if (
        response.healthy !== true ||
        (action === "committed" && installedVersion !== transaction.version) ||
        (action === "rolled-back" && installedVersion !== transaction.previousVersion)
      ) {
        fail("target controller recovery health response is mismatched");
      }
      return Object.freeze({ action, release: response.release ?? null, supporting: false });
    }
    if (
      !transaction.legacyAdopted ||
      !/unsupported updater transaction request|unsupported.*releaseStatus/iu.test(
        response.error || "",
      )
    ) {
      fail(response.error || "target controller recovery health check failed");
    }
  }
  if (!transaction.legacyAdopted) {
    fail("root product transaction has no verified target-controller health authority");
  }
  const action = installedVersion === transaction.version ? "committed" : "rolled-back";
  if (
    (transaction.durableCommitDecision && action !== "committed") ||
    (!transaction.durableCommitDecision && installedVersion !== transaction.previousVersion)
  ) {
    fail("legacy target recovery did not converge to its durable decision");
  }
  return Object.freeze({
    action,
    release: transaction.targetReleaseIdentity,
    supporting: true,
  });
}

async function recoverRootProductTransaction(context, options = {}) {
  const supervisorTransaction = await context.readSupervisorTransaction(
    context.paths,
    context.rootUid,
  );
  let transaction = await context.readRootProductTransaction(context.paths, context.rootUid);
  let productJournal = await context.readControllerProductJournal(context.paths, context.rootUid);
  if (!transaction && productJournal) {
    const previousControllerIdentity = await context.readControllerIdentity(
      context.paths,
      context.rootUid,
    );
    if (
      !previousControllerIdentity ||
      !(await context.currentControllerMatches(
        context.paths,
        previousControllerIdentity,
        context.rootUid,
      ))
    ) {
      fail("legacy product recovery cannot prove its previous controller generation");
    }
    transaction = await context.writeRootProductTransaction(
      context.paths,
      rootProductTransactionRecord({
        request: {
          transactionId: productJournal.transactionId,
          version: productJournal.version,
          op: "updateController",
        },
        phase: "legacy-recovery",
        previousVersion: productJournal.previousVersion,
        previousControllerIdentity,
        previousControllerGenerationVersion: previousControllerIdentity.version,
        targetControllerReceipt: productJournal.targetControllerReceipt,
        targetReleaseIdentity: productJournal.targetReleaseIdentity,
        artifactDigests: productJournal.artifactDigests,
        targetJournalSha256: productJournal.journalSha256,
        selectionDigest: productJournal.selectionDigest,
        durableCommitDecision: new Set(["gateway-verified", "committing"]).has(
          productJournal.phase,
        ),
        legacyAdopted: true,
        now: context.now(),
      }),
      context.rootUid,
      context.rootGid,
    );
  }
  if (!transaction) {
    return Object.freeze({ recovered: false });
  }
  assertRootProductJournalBinding(transaction, productJournal);
  const activeJournalDigest = recoveryBindingDigest(
    supervisorTransaction,
    transaction,
    productJournal,
  );
  if (
    options.expectedJournalDigest !== undefined &&
    activeJournalDigest !== options.expectedJournalDigest
  ) {
    fail("root product recovery journal changed before the explicit retry");
  }

  const legacyAdoption = rootLegacyAdoptionBinding(transaction);
  if (legacyAdoption && !productJournal && transaction.phase !== "selected") {
    if (!transaction.targetControllerReceipt) {
      fail("legacy adoption recovery has no selected target-controller receipt");
    }
    const recoveryRequest = Object.freeze({
      schemaVersion: 2,
      op: "applyRelease",
      transactionId: transaction.transactionId,
      version: transaction.version,
    });
    const status = await context.requestController(
      targetControllerRequest(
        recoveryRequest,
        "releaseStatus",
        transaction.targetControllerReceipt,
        legacyAdoption,
      ),
      context,
    );
    if (status?.ok === true && status.phase === "committed" && status.healthy === true) {
      if (transaction.phase !== "commit-acknowledged") {
        transaction = await context.writeRootProductTransaction(
          context.paths,
          advanceRootProductTransaction(transaction, {
            phase: "commit-ack-pending",
            targetReleaseIdentity: status.release ?? transaction.targetReleaseIdentity,
            durableCommitDecision: true,
            now: context.now(),
          }),
          context.rootUid,
          context.rootGid,
        );
      }
      await context.onLegacyAdoptionPhase?.("after-root-commit-durable", {
        request: recoveryRequest,
        rootTransaction: transaction,
        response: status,
      });
      const finalized = await completeRootLegacyAdoption(
        recoveryRequest,
        transaction,
        transaction.targetControllerReceipt,
        status,
        context,
      );
      await durableReceipt(context.paths, recoveryRequest, {
        outcome: "committed",
        controllerChanged: false,
        phase: "committed",
        release: finalized.release ?? transaction.targetReleaseIdentity ?? undefined,
        selectionDigest: transaction.selectionDigest ?? undefined,
      });
      if (options.explicit === true) {
        await clearRecoveryControllerArtifacts(context, transaction.transactionId);
      }
      await context.clearRootProductTransaction(context.paths);
      return Object.freeze({
        recovered: true,
        action: "committed",
        transactionId: transaction.transactionId,
        version: transaction.version,
      });
    }
    if (status?.ok === true && status.phase === "rolled-back" && status.healthy === true) {
      if (
        transaction.durableCommitDecision ||
        status.installedVersion !== transaction.previousVersion
      ) {
        fail("legacy adoption rollback conflicts with the durable root transaction");
      }
      await restorePreviousControllerAfterProductRollback(
        transaction,
        context,
        options.supervisorState,
      );
      await durableReceipt(context.paths, recoveryRequest, {
        outcome: "rolled-back",
        controllerChanged: false,
        phase: "rolled-back",
        selectionDigest: transaction.selectionDigest ?? undefined,
      });
      if (options.explicit === true) {
        await clearRecoveryControllerArtifacts(context, transaction.transactionId);
      }
      await context.clearRootProductTransaction(context.paths);
      return Object.freeze({
        recovered: true,
        action: "rolled-back",
        transactionId: transaction.transactionId,
        version: transaction.version,
      });
    }
    fail(
      status?.error ||
        "legacy adoption recovery is pending its bound target-controller commit and acknowledgment",
    );
  }

  if (transaction.phase === "selected" && !productJournal) {
    const installedVersion = await context.readProductVersion(context.paths, context.rootUid);
    if (installedVersion !== transaction.previousVersion) {
      fail("controller-only recovery found an unexpected product generation");
    }
    if (!transaction.targetControllerReceipt) {
      fail("controller-only recovery has no selected target-controller receipt");
    }
    await context.probeControllerIdentity(
      {
        transactionId: transaction.transactionId,
        version: transaction.version,
      },
      context,
      {
        serverSha256: transaction.targetControllerReceipt.controllerServerSha256,
        clientSha256: transaction.targetControllerReceipt.controllerClientSha256,
      },
    );
    await restorePreviousControllerAfterProductRollback(
      transaction,
      context,
      options.supervisorState,
    );
    await durableReceipt(
      context.paths,
      {
        op: "recoverRelease",
        transactionId: transaction.transactionId,
        version: transaction.version,
      },
      {
        outcome: "rolled-back",
        controllerChanged: false,
        phase: "rolled-back",
        selectionDigest: transaction.selectionDigest ?? undefined,
      },
    );
    if (options.explicit === true) {
      await clearRecoveryControllerArtifacts(context, transaction.transactionId);
    }
    await context.clearRootProductTransaction(context.paths);
    return Object.freeze({
      recovered: true,
      action: "rolled-back",
      transactionId: transaction.transactionId,
      version: transaction.version,
    });
  }

  if (transaction.recoveryAttempts >= MAX_ROOT_RECOVERY_ATTEMPTS && options.explicit !== true) {
    fail("root product transaction exceeded its bounded recovery attempts");
  }
  const nextRecoveryAttempts =
    transaction.recoveryAttempts >= MAX_ROOT_RECOVERY_ATTEMPTS
      ? MAX_ROOT_RECOVERY_ATTEMPTS
      : transaction.recoveryAttempts + 1;
  transaction = await context.writeRootProductTransaction(
    context.paths,
    advanceRootProductTransaction(transaction, {
      phase: productJournal?.phase ?? transaction.phase,
      artifactDigests: productJournal?.artifactDigests ?? transaction.artifactDigests,
      targetReleaseIdentity:
        productJournal?.targetReleaseIdentity ?? transaction.targetReleaseIdentity,
      targetJournalSha256: productJournal?.journalSha256 ?? transaction.targetJournalSha256,
      durableCommitDecision:
        transaction.durableCommitDecision ||
        new Set(["gateway-verified", "committing"]).has(productJournal?.phase),
      recoveryAttempts: nextRecoveryAttempts,
      lastErrorClass: null,
      now: context.now(),
    }),
    context.rootUid,
    context.rootGid,
  );
  let explicitOutcome = null;
  try {
    if (productJournal) {
      if (options.explicit === true) {
        const recoveryAuthority = await context.stageRecoveryController(
          transaction,
          productJournal,
          options.recoveryRequest,
          context,
          options.supervisorState,
        );
        const result = await context.recoverControllerProductTransaction(
          transaction,
          productJournal,
          recoveryAuthority,
          context,
        );
        explicitOutcome = result.phase;
        transaction = await context.writeRootProductTransaction(
          context.paths,
          advanceRootProductTransaction(transaction, {
            phase: "product-recovered",
            durableCommitDecision: result.phase === "committed",
            now: context.now(),
          }),
          context.rootUid,
          context.rootGid,
        );
      } else {
        await context.restartController();
        await context.waitForController();
      }
      productJournal = await context.readControllerProductJournal(context.paths, context.rootUid);
      assertRootProductJournalBinding(transaction, productJournal);
      if (productJournal) {
        fail("target-controller recovery did not clear its durable transaction");
      }
    }

    const installedVersion = await context.readProductVersion(context.paths, context.rootUid);
    const committed = explicitOutcome
      ? explicitOutcome === "committed"
      : transaction.durableCommitDecision;
    if (options.explicit === true) {
      if (committed) {
        await selectJournalBoundRecoveryController(transaction, context, options.supervisorState);
      } else {
        await restorePreviousControllerAfterProductRollback(
          transaction,
          context,
          options.supervisorState,
        );
      }
    }
    const verification =
      options.explicit === true && !committed
        ? Object.freeze({ action: "rolled-back", release: null, supporting: false })
        : await context.verifyRecoveredProduct(transaction, installedVersion, context);
    if (
      (committed && installedVersion !== transaction.version) ||
      (!committed && installedVersion !== transaction.previousVersion) ||
      verification.action !== (committed ? "committed" : "rolled-back")
    ) {
      fail("explicit product recovery outcome does not match its installed generation");
    }
    await durableReceipt(
      context.paths,
      {
        schemaVersion: 2,
        op: "recoverRelease",
        transactionId: transaction.transactionId,
        version: transaction.version,
      },
      {
        outcome: committed ? "committed" : "rolled-back",
        controllerChanged: false,
        phase: committed ? "committed" : "rolled-back",
        release: committed
          ? (verification.release ?? transaction.targetReleaseIdentity ?? undefined)
          : undefined,
        selectionDigest: transaction.selectionDigest ?? undefined,
      },
    );
    if (options.explicit === true) {
      await clearRecoveryControllerArtifacts(context, transaction.transactionId);
    }
    await context.clearRootProductTransaction(context.paths);
    return Object.freeze({
      recovered: true,
      action: committed ? "committed" : "rolled-back",
      transactionId: transaction.transactionId,
      version: transaction.version,
    });
  } catch (error) {
    await context.writeRootProductTransaction(
      context.paths,
      advanceRootProductTransaction(transaction, {
        lastErrorClass: recoveryErrorClass(error),
        now: context.now(),
      }),
      context.rootUid,
      context.rootGid,
    );
    throw error;
  }
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

function importedLegacyAdoptionPath(configuration) {
  return path.join(configuration.paths.supervisorStateDir, LEGACY_ADOPTION_RECEIPT_NAME);
}

function parseImportedLegacyAdoption(value, configuration, expectedStateDirSha256) {
  exactKeys(
    value,
    [
      "schemaVersion",
      "profile",
      "instanceId",
      "operatorUid",
      "operatorGid",
      "stateDirSha256",
      "adoptionReceiptDigest",
      "legacyTransactionId",
      "previousVersion",
      "targetVersion",
      "importedAt",
      "verification",
    ],
    "imported legacy adoption receipt",
  );
  const importedAt = Date.parse(String(value.importedAt ?? ""));
  if (
    Number(value.schemaVersion) !== 1 ||
    value.profile !== configuration.profile ||
    value.instanceId !== configuration.instanceId ||
    Number(value.operatorUid) !== configuration.operatorUid ||
    Number(value.operatorGid) !== configuration.operatorGid ||
    value.stateDirSha256 !== expectedStateDirSha256 ||
    !/^sha256:[a-f0-9]{64}$/u.test(value.adoptionReceiptDigest || "") ||
    !TRANSACTION_ID_PATTERN.test(value.legacyTransactionId || "") ||
    parseVersion(value.previousVersion) !== value.previousVersion ||
    parseVersion(value.targetVersion) !== value.targetVersion ||
    !Number.isFinite(importedAt) ||
    new Date(importedAt).toISOString() !== value.importedAt ||
    value.verification !== "pending"
  ) {
    fail("imported legacy adoption receipt is malformed or mismatched");
  }
  return Object.freeze({ ...value });
}

async function readImportedLegacyAdoption(context) {
  if (context.configuration.profile !== "protected-local") {
    return null;
  }
  try {
    return parseImportedLegacyAdoption(
      await readProtectedJson(
        importedLegacyAdoptionPath(context.configuration),
        "imported legacy adoption receipt",
        context.rootUid,
      ),
      context.configuration,
      context.operatorStateDirSha256,
    );
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function assertImportedLegacyAdoptionRequest(receipt, request, previousVersion) {
  if (!receipt) {
    return;
  }
  if (receipt.targetVersion !== request.version || receipt.previousVersion !== previousVersion) {
    fail("imported legacy adoption receipt does not bind this release transition");
  }
}

async function acknowledgeImportedLegacyAdoption(context, receipt) {
  if (!receipt) {
    return;
  }
  if (
    receipt.legacyAdoptionAck?.state !== "acknowledged" ||
    receipt.legacyAdoptionAck.adoptionReceiptDigest !== receipt.adoptionReceiptDigest ||
    receipt.legacyAdoptionAck.legacyTransactionId !== receipt.legacyTransactionId
  ) {
    fail("legacy adoption root cleanup has no verified target-controller acknowledgment");
  }
  const active = await readImportedLegacyAdoption(context);
  if (!active) {
    return;
  }
  if (
    active.adoptionReceiptDigest !== receipt.adoptionReceiptDigest ||
    active.legacyTransactionId !== receipt.legacyTransactionId
  ) {
    fail("legacy adoption acknowledgment no longer matches its root-owned receipt");
  }
  await fsp.rm(importedLegacyAdoptionPath(context.configuration));
  await fsyncDirectory(context.paths.supervisorStateDir);
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
      ? `/opt/fased/host-application /opt/fased/signer /var/lib/fased-host-updater /var/lib/fased-signer-update-gate /var/lib/fased-signerd /run/fased-host-controller /usr/local/libexec /etc/systemd/system ${unitPath(appStateDir)}`
      : `/opt/fased/local/${configuration.instanceId} /var/lib/fased-local/${configuration.instanceId}/signer /var/lib/fased-local/${configuration.instanceId}/controller ${unitPath(appStateDir)} /run/fased-local-controller-worker/${configuration.instanceId} /etc/systemd/system`;
  const controllerReadOnly =
    configuration.profile === "hosting"
      ? `/opt/fased/host-controller /var/lib/fased-host-updater/controller-version.json /var/lib/fased-host-updater/supervisor ${unitPath(path.join("/etc/systemd/system", paths.controllerUnit))} ${unitPath(path.join("/etc/systemd/system", `${paths.controllerUnit}.d`))} ${unitPath(path.join("/etc/systemd/system", paths.supervisorUnit))} ${unitPath(path.join("/etc/systemd/system", `${paths.supervisorUnit}.d`))}`
      : `/opt/fased/local/${configuration.instanceId}/controller /opt/fased/local/${configuration.instanceId}/supervisor /opt/fased/local/${configuration.instanceId}/signer-owner /opt/fased/local/${configuration.instanceId}/operator-socket-finalize /var/lib/fased-local/${configuration.instanceId}/controller/controller-version.json /var/lib/fased-local/${configuration.instanceId}/controller/supervisor ${unitPath(path.join("/etc/systemd/system", paths.controllerUnit))} ${unitPath(path.join("/etc/systemd/system", `${paths.controllerUnit}.d`))} ${unitPath(path.join("/etc/systemd/system", paths.supervisorUnit))} ${unitPath(path.join("/etc/systemd/system", `${paths.supervisorUnit}.d`))}`;
  const controller = `[Unit]
Description=Fased target lifecycle controller
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=3

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
StartLimitIntervalSec=60
StartLimitBurst=3

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
    // The replaceable worker is allowed to fail while an interrupted product
    // transaction is awaiting recovery.  Enable both units first, then start
    // the stable supervisor.  Its Wants= relationship may attempt the worker,
    // but a worker failure must not prevent the public recovery socket from
    // becoming available.
    await systemctl("enable", configuration.paths.controllerUnit);
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
    await systemctl("restart", configuration.paths.supervisorUnit);
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
  const operatorStateDirSha256 =
    overrides.operatorStateDirSha256 ??
    (configuration.profile === "protected-local"
      ? `sha256:${createHash("sha256")
          .update(protectedLocalStateDir(configuration, passwdRecord(configuration.operatorUid)))
          .digest("hex")}`
      : null);
  return {
    configuration,
    paths: configuration.paths,
    rootUid,
    rootGid,
    operatorStateDirSha256,
    platform: overrides.platform ?? platformIdentity(),
    now: overrides.now ?? (() => Date.now()),
    onLegacyAdoptionPhase: overrides.onLegacyAdoptionPhase,
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
    readSupervisorTransaction: overrides.readSupervisorTransaction ?? readSupervisorTransaction,
    recoverSupervisorTransaction:
      overrides.recoverSupervisorTransaction ?? recoverSupervisorTransaction,
    readRootProductTransaction: overrides.readRootProductTransaction ?? readRootProductTransaction,
    readImportedLegacyAdoption: overrides.readImportedLegacyAdoption ?? readImportedLegacyAdoption,
    acknowledgeImportedLegacyAdoption:
      overrides.acknowledgeImportedLegacyAdoption ?? acknowledgeImportedLegacyAdoption,
    writeRootProductTransaction:
      overrides.writeRootProductTransaction ?? writeRootProductTransaction,
    clearRootProductTransaction:
      overrides.clearRootProductTransaction ?? clearRootProductTransaction,
    readControllerProductJournal:
      overrides.readControllerProductJournal ?? readControllerProductJournal,
    readProductVersion: overrides.readProductVersion ?? readProductVersion,
    recoverRootProductTransaction:
      overrides.recoverRootProductTransaction ?? recoverRootProductTransaction,
    recoverControllerProductTransaction:
      overrides.recoverControllerProductTransaction ?? recoverControllerProductTransaction,
    stageRecoveryController: overrides.stageRecoveryController ?? stageRecoveryController,
    probeRecoveryControllerIdentity:
      overrides.probeRecoveryControllerIdentity ?? probeRecoveryControllerIdentity,
    verifyRecoveredProduct: overrides.verifyRecoveredProduct ?? verifyRecoveredProduct,
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

function createRecoveryAuthorization(
  transaction,
  productJournal,
  recoverySelectionReceipt,
  recoveryCapabilities,
  recoveryIdentityDigest,
  now = Date.now(),
) {
  if (
    !transaction.targetControllerReceipt ||
    !CONTROLLER_RECOVERY_CAPABILITIES.journalSchemas.includes(productJournal.schemaVersion)
  ) {
    fail("pending product journal has no supported compatibility recovery contract");
  }
  const unsigned = Object.freeze({
    schemaVersion: 3,
    transactionId: transaction.transactionId,
    version: transaction.version,
    recoveryIdentityDigest,
    productJournalDigest: productJournal.journalSha256,
    legacySelectionDigest: transaction.targetControllerReceipt.selectionDigest,
    expectedOutcome: transaction.durableCommitDecision ? "committed" : "rolled-back",
    recoveryController: Object.freeze({
      version: recoverySelectionReceipt.version,
      releaseCommit: recoverySelectionReceipt.releaseCommit,
      targetManifestSha256: recoverySelectionReceipt.targetManifestSha256,
      serverSha256: recoverySelectionReceipt.controllerServerSha256,
      clientSha256: recoverySelectionReceipt.controllerClientSha256,
      trustPolicySha256: recoverySelectionReceipt.trustPolicySha256,
      protocolCapabilities: recoverySelectionReceipt.protocolCapabilities,
      recoveryCapabilities,
    }),
    allowedOperation: "recoverActive",
    recoveryEpoch: transaction.requestNonce,
    authorizedAt: new Date(now).toISOString(),
  });
  return Object.freeze({
    ...unsigned,
    authorizationDigest: createHash("sha256").update(canonicalRootValue(unsigned)).digest("hex"),
  });
}

function assertRecoveryAuthorizationBinding(authorization, expected) {
  const unsigned = { ...authorization };
  delete unsigned.authorizationDigest;
  if (
    authorization?.schemaVersion !== 3 ||
    authorization.transactionId !== expected.transactionId ||
    authorization.version !== expected.version ||
    authorization.recoveryIdentityDigest !== expected.recoveryIdentityDigest ||
    authorization.productJournalDigest !== expected.productJournalDigest ||
    authorization.legacySelectionDigest !== expected.legacySelectionDigest ||
    authorization.expectedOutcome !== expected.expectedOutcome ||
    authorization.allowedOperation !== "recoverActive" ||
    authorization.recoveryEpoch !== expected.recoveryEpoch ||
    canonicalRootValue(authorization.recoveryController) !==
      canonicalRootValue(expected.recoveryController) ||
    !TRANSACTION_ID_PATTERN.test(authorization.recoveryEpoch || "") ||
    !Number.isFinite(Date.parse(authorization.authorizedAt || "")) ||
    new Date(Date.parse(authorization.authorizedAt)).toISOString() !== authorization.authorizedAt ||
    authorization.authorizationDigest !==
      createHash("sha256").update(canonicalRootValue(unsigned)).digest("hex")
  ) {
    fail("recovery controller authorization changed across retry");
  }
  return Object.freeze({ ...authorization });
}

async function readRecoveryAuthorization(context, transactionId, expected = null) {
  const directory = path.join(
    context.paths.supervisorStateDir,
    "recovery-authorizations",
    transactionId,
  );
  let entries;
  try {
    entries = await fsp.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  const candidates = entries.filter(
    (entry) =>
      entry.isFile() &&
      !entry.isSymbolicLink() &&
      DIGEST_PATTERN.test(entry.name.slice(0, -5)) &&
      entry.name.endsWith(".json"),
  );
  if (candidates.length !== 1 || candidates.length !== entries.length) {
    fail("recovery controller authorization set is ambiguous");
  }
  const authorization = await readProtectedJson(
    path.join(directory, candidates[0].name),
    "recovery controller authorization",
    context.rootUid,
  );
  return expected
    ? assertRecoveryAuthorizationBinding(authorization, expected)
    : Object.freeze({ ...authorization });
}

async function persistRecoveryAuthorization(context, authorization) {
  const authorizationPath = path.join(
    context.paths.supervisorStateDir,
    "recovery-authorizations",
    authorization.transactionId,
    `${authorization.authorizationDigest}.json`,
  );
  await atomicWrite(authorizationPath, `${JSON.stringify(authorization, null, 2)}\n`, 0o600);
  await fsp.chown(authorizationPath, context.rootUid, context.rootGid);
  await fsp.chmod(authorizationPath, 0o600);
  const persisted = await readProtectedJson(
    authorizationPath,
    "recovery controller authorization",
    context.rootUid,
  );
  if (canonicalRootValue(persisted) !== canonicalRootValue(authorization)) {
    fail("recovery controller authorization changed after durable write");
  }
  return Object.freeze({ authorizationPath, authorization: persisted });
}

async function clearRecoveryControllerArtifacts(context, transactionId) {
  await fsp.rm(
    path.join(context.paths.supervisorStateDir, "recovery-authorizations", transactionId),
    { recursive: true, force: true },
  );
  await fsyncDirectory(context.paths.supervisorStateDir);
}

async function probeRecoveryControllerIdentity(request, context, expectedIdentity) {
  const response = await context.requestController(
    targetControllerRequest(request, "controllerStatus"),
    context,
  );
  if (
    !response.ok ||
    response.controllerVersion !== request.version ||
    !TRANSACTION_ID_PATTERN.test(response.controllerInstanceId || "") ||
    response.controllerServerSha256 !== expectedIdentity?.serverSha256 ||
    response.controllerClientSha256 !== expectedIdentity?.clientSha256 ||
    canonicalRootValue(response.protocolCapabilities) !==
      canonicalRootValue(CONTROLLER_SELECTION_CAPABILITIES) ||
    canonicalRootValue(response.recoveryCapabilities) !==
      canonicalRootValue(CONTROLLER_RECOVERY_CAPABILITIES)
  ) {
    fail("verified recovery controller does not advertise the required compatibility contract");
  }
  return Object.freeze({
    controllerInstanceId: response.controllerInstanceId,
    recoveryCapabilities: response.recoveryCapabilities,
  });
}

async function stageRecoveryController(transaction, productJournal, request, context, state) {
  const recoveryRequest = Object.freeze({
    schemaVersion: 3,
    op: "updateController",
    transactionId: transaction.transactionId,
    nonce: transaction.requestNonce,
    version: request.recoveryControllerVersion,
    clientCapabilities: request.clientCapabilities,
  });
  const staged = await context.stageTrustedController(recoveryRequest, context);
  if (staged.supervisorChanged) {
    fail("compatibility recovery requires the already-running stable supervisor generation");
  }
  const authorizationIdentityDigest = recoveryIdentityDigest(null, transaction, productJournal);
  const durableChange = staged.changed || staged.trustChanged;
  let transactionActive = false;
  try {
    // Recovery-controller selection uses the same crash-recoverable supervisor
    // transaction as an ordinary controller transition. The selection receipt
    // is bound to the original product transaction nonce; each explicit
    // recovery attempt still receives its own one-shot authorization nonce.
    if (durableChange) {
      await context.beginSupervisorTransaction(context.paths, recoveryRequest, staged);
      transactionActive = true;
    }
    if (staged.changed) {
      await context.activateStagedController(context.paths, staged);
      await context.restartController();
      await context.waitForController();
    }
    let live;
    try {
      live = await context.probeRecoveryControllerIdentity(
        recoveryRequest,
        context,
        staged.identity,
      );
    } catch (error) {
      if (staged.changed) {
        throw error;
      }
      await context.restartController();
      await context.waitForController();
      live = await context.probeRecoveryControllerIdentity(
        recoveryRequest,
        context,
        staged.identity,
      );
    }
    if (staged.trustChanged) {
      await context.commitLifecycleTrust(context.paths, staged);
    }
    const selectionReceipt = await context.writeControllerSelectionReceipt(
      context.paths,
      recoveryRequest,
      staged,
      live.controllerInstanceId,
      context.rootUid,
      context.rootGid,
      { now: context.now(), nonce: transaction.requestNonce },
    );
    const proposedAuthorization = createRecoveryAuthorization(
      transaction,
      productJournal,
      selectionReceipt,
      live.recoveryCapabilities,
      authorizationIdentityDigest,
      context.now(),
    );
    const expectedAuthorization = Object.freeze({
      transactionId: proposedAuthorization.transactionId,
      version: proposedAuthorization.version,
      recoveryIdentityDigest: proposedAuthorization.recoveryIdentityDigest,
      productJournalDigest: proposedAuthorization.productJournalDigest,
      legacySelectionDigest: proposedAuthorization.legacySelectionDigest,
      expectedOutcome: proposedAuthorization.expectedOutcome,
      recoveryController: proposedAuthorization.recoveryController,
      recoveryEpoch: proposedAuthorization.recoveryEpoch,
    });
    const authorization =
      (await readRecoveryAuthorization(
        context,
        transaction.transactionId,
        expectedAuthorization,
      )) ?? proposedAuthorization;
    const durableAuthorization = await persistRecoveryAuthorization(context, authorization);
    if (transactionActive) {
      await context.clearSupervisorTransaction(context.paths);
      transactionActive = false;
    }
    state.controllerInstanceId = live.controllerInstanceId;
    context.recoveryControllerInstanceId = live.controllerInstanceId;
    return Object.freeze({
      authorization: durableAuthorization.authorization,
      selectionReceipt,
      selectionChanged: staged.changed,
      // A controller process identity is deliberately transient. It proves
      // which freshly probed process receives this attempt, but it is not part
      // of the durable authorization so a crash/restart can replay the same
      // transaction against the same verified controller generation.
      liveControllerInstanceId: live.controllerInstanceId,
    });
  } catch (error) {
    if (transactionActive) {
      try {
        if (staged.changed) {
          await context.restoreControllerSelection(context.paths, staged);
          await context.restartController();
          await context.waitForController();
        }
        // Trust state is monotonic and is deliberately not rolled back after a
        // verified trust transition. Only the mutable controller selection is
        // restored before the transaction is cleared.
        await context.clearSupervisorTransaction(context.paths);
        await clearRecoveryControllerArtifacts(context, transaction.transactionId);
      } catch (restoreError) {
        throw new Error(
          `recovery controller selection failed and restoration remains pending: ${restoreError.message}`,
          { cause: restoreError },
        );
      }
    } else {
      await clearRecoveryControllerArtifacts(context, transaction.transactionId);
    }
    throw error;
  }
}

async function recoverControllerProductTransaction(
  transaction,
  productJournal,
  recoveryAuthority,
  context,
) {
  const authorization = recoveryAuthority.authorization;
  const response = await context.requestController(
    {
      schemaVersion: 2,
      op: "recoverActive",
      transactionId: transaction.transactionId,
      version: transaction.version,
      recoveryDigest: productJournal.journalSha256,
      recoveryControllerInstanceId: recoveryAuthority.liveControllerInstanceId,
      recoveryAuthorization: authorization,
    },
    context,
  );
  if (
    !response.ok ||
    response.transactionId !== transaction.transactionId ||
    response.version !== transaction.version ||
    response.recoveryControllerInstanceId !== recoveryAuthority.liveControllerInstanceId ||
    response.recoveryAuthorizationDigest !== authorization.authorizationDigest ||
    response.phase !== authorization.expectedOutcome
  ) {
    fail(response.error || "target controller did not complete the bound product recovery");
  }
  return response;
}

async function selectJournalBoundRecoveryController(transaction, context, state) {
  const receipt = transaction.targetControllerReceipt;
  if (!receipt) {
    fail("root product recovery has no journal-bound controller receipt");
  }
  const identity = Object.freeze({
    schemaVersion: 1,
    version: receipt.version,
    serverSha256: receipt.controllerServerSha256,
    clientSha256: receipt.controllerClientSha256,
  });
  const generation = path.join(context.paths.releasesDir, `v${identity.version}`);
  const digests = await controllerGenerationDigests(generation, context.rootUid);
  if (
    digests.serverSha256 !== identity.serverSha256 ||
    digests.clientSha256 !== identity.clientSha256
  ) {
    fail("journal-bound recovery controller generation digest is mismatched");
  }
  const [selectionMatched, persistedIdentity] = await Promise.all([
    context.currentControllerMatches(context.paths, identity, context.rootUid),
    context.readControllerIdentity(context.paths, context.rootUid),
  ]);
  const identityMatched = canonicalRootValue(persistedIdentity) === canonicalRootValue(identity);
  await atomicSymlink(generation, context.paths.currentLink);
  await atomicWrite(
    context.paths.controllerVersionPath,
    `${JSON.stringify(identity, null, 2)}\n`,
    0o600,
  );
  await fsp.chown(context.paths.controllerVersionPath, context.rootUid, context.rootGid);
  await fsp.chmod(context.paths.controllerVersionPath, 0o600);
  if (!selectionMatched || !identityMatched) {
    await context.restartController();
    await context.waitForController();
  }
  const probe = async () =>
    await context.probeControllerIdentity(
      {
        schemaVersion: 3,
        op: "updateController",
        transactionId: transaction.transactionId,
        nonce: transaction.requestNonce,
        version: transaction.version,
        clientCapabilities: transaction.clientCapabilities,
      },
      context,
      identity,
    );
  let controllerInstanceId;
  try {
    controllerInstanceId = await probe();
  } catch (error) {
    if (!selectionMatched || !identityMatched) {
      throw error;
    }
    await context.restartController();
    await context.waitForController();
    controllerInstanceId = await probe();
  }
  if (state) {
    state.controllerInstanceId = controllerInstanceId;
  }
  context.recoveryControllerInstanceId = controllerInstanceId;
  return Object.freeze({ identity, controllerInstanceId });
}

async function restorePreviousControllerAfterProductRollback(transaction, context, state) {
  if (!transaction.previousControllerIdentity) {
    return;
  }
  const identity = transaction.previousControllerIdentity;
  const generation = path.join(context.paths.releasesDir, `v${identity.version}`);
  const digests = await controllerGenerationDigests(generation, context.rootUid);
  if (
    digests.serverSha256 !== identity.serverSha256 ||
    digests.clientSha256 !== identity.clientSha256
  ) {
    fail("previous controller generation digest is mismatched during product rollback");
  }
  await atomicSymlink(generation, context.paths.currentLink);
  await atomicWrite(
    context.paths.controllerVersionPath,
    `${JSON.stringify(identity, null, 2)}\n`,
    0o600,
  );
  await fsp.chown(context.paths.controllerVersionPath, context.rootUid, context.rootGid);
  await fsp.chmod(context.paths.controllerVersionPath, 0o600);
  await context.restartController();
  await context.waitForController();
  const controllerInstanceId = await context.probeControllerIdentity(
    {
      schemaVersion: 3,
      op: "updateController",
      transactionId: transaction.transactionId,
      nonce: transaction.requestNonce,
      version: identity.version,
      clientCapabilities: transaction.clientCapabilities,
    },
    context,
    identity,
  );
  if (state) {
    state.controllerInstanceId = controllerInstanceId;
  }
  context.recoveryControllerInstanceId = controllerInstanceId;
}

function rootLegacyAdoptionBinding(transaction) {
  return transaction?.legacyAdoptionDigest
    ? Object.freeze({
        receiptDigest: transaction.legacyAdoptionDigest,
        transactionId: transaction.legacyAdoptionTransactionId,
        previousVersion: transaction.legacyAdoptionPreviousVersion,
        targetVersion: transaction.legacyAdoptionTargetVersion,
      })
    : null;
}

function parseTargetLegacyAdoptionAck(value, binding, request, { acknowledged = false } = {}) {
  exactKeys(
    value,
    [
      "schemaVersion",
      "transactionId",
      "version",
      "legacyTransactionId",
      "adoptionReceiptDigest",
      "adoptionReceipt",
      "legacyJournal",
      "outcome",
      "installedVersion",
      "state",
      "issuedAt",
      "acknowledgedAt",
      "receiptDigest",
    ],
    "target-controller legacy adoption acknowledgment",
  );
  for (const [label, identity] of [
    ["receipt", value.adoptionReceipt],
    ["journal", value.legacyJournal],
  ]) {
    exactKeys(
      identity,
      ["dev", "gid", "ino", "mode", "sha256", "size", "uid"],
      `target-controller legacy adoption ${label} identity`,
    );
    if (
      !Number.isSafeInteger(identity.dev) ||
      identity.dev < 0 ||
      !Number.isSafeInteger(identity.ino) ||
      identity.ino < 1 ||
      !Number.isSafeInteger(identity.uid) ||
      identity.uid < 1 ||
      !Number.isSafeInteger(identity.gid) ||
      identity.gid < 1 ||
      !Number.isSafeInteger(identity.mode) ||
      (identity.mode & 0o177) !== 0 ||
      !Number.isSafeInteger(identity.size) ||
      identity.size < 2 ||
      !/^sha256:[a-f0-9]{64}$/u.test(identity.sha256 || "")
    ) {
      fail(`target-controller legacy adoption ${label} identity is invalid`);
    }
  }
  const unsigned = {
    schemaVersion: Number(value.schemaVersion),
    transactionId: String(value.transactionId ?? "").toLowerCase(),
    version: parseVersion(value.version),
    legacyTransactionId: String(value.legacyTransactionId ?? "").toLowerCase(),
    adoptionReceiptDigest: String(value.adoptionReceiptDigest ?? ""),
    adoptionReceipt: Object.freeze({ ...value.adoptionReceipt }),
    legacyJournal: Object.freeze({ ...value.legacyJournal }),
    outcome: String(value.outcome ?? ""),
    installedVersion: parseVersion(value.installedVersion),
    state: String(value.state ?? ""),
    issuedAt: String(value.issuedAt ?? ""),
    acknowledgedAt: value.acknowledgedAt === null ? null : String(value.acknowledgedAt ?? ""),
  };
  const issuedAt = Date.parse(unsigned.issuedAt);
  const acknowledgedAt =
    unsigned.acknowledgedAt === null ? null : Date.parse(unsigned.acknowledgedAt);
  const receiptDigest = String(value.receiptDigest ?? "");
  if (
    unsigned.schemaVersion !== 2 ||
    unsigned.transactionId !== request.transactionId ||
    unsigned.version !== request.version ||
    unsigned.legacyTransactionId !== binding.transactionId ||
    unsigned.adoptionReceiptDigest !== binding.receiptDigest ||
    unsigned.outcome !== "committed" ||
    unsigned.installedVersion !== request.version ||
    !new Set(["pending", "acknowledged"]).has(unsigned.state) ||
    (acknowledged && unsigned.state !== "acknowledged") ||
    !Number.isFinite(issuedAt) ||
    new Date(issuedAt).toISOString() !== unsigned.issuedAt ||
    (unsigned.state === "pending" && unsigned.acknowledgedAt !== null) ||
    (unsigned.state === "acknowledged" &&
      (!Number.isFinite(acknowledgedAt) ||
        new Date(acknowledgedAt).toISOString() !== unsigned.acknowledgedAt)) ||
    receiptDigest !==
      `sha256:${createHash("sha256").update(canonicalRootValue(unsigned)).digest("hex")}`
  ) {
    fail("target-controller legacy adoption acknowledgment is mismatched");
  }
  return Object.freeze({ ...unsigned, receiptDigest });
}

function assertTargetLegacyAdoptionResponse(
  response,
  binding,
  request,
  { acknowledged = false, healthy = false } = {},
) {
  if (
    response?.ok !== true ||
    response.transactionId !== request.transactionId ||
    response.version !== request.version ||
    response.phase !== "committed" ||
    (healthy && response.healthy !== true) ||
    canonicalRootValue(response.legacyAdoption) !== canonicalRootValue(binding)
  ) {
    fail("target-controller legacy adoption completion is not bound to the committed release");
  }
  return parseTargetLegacyAdoptionAck(response.legacyAdoptionAck, binding, request, {
    acknowledged,
  });
}

async function finalizeLegacyAdoptionAfterCommit(
  request,
  rootTransaction,
  selectionReceipt,
  response,
  context,
) {
  const binding = rootLegacyAdoptionBinding(rootTransaction);
  if (!binding) {
    return response;
  }
  assertTargetLegacyAdoptionResponse(response, binding, request);
  const status = await context.requestController(
    targetControllerRequest(request, "releaseStatus", selectionReceipt, binding),
    context,
  );
  assertTargetLegacyAdoptionResponse(status, binding, request, { healthy: true });
  const acknowledged = await context.requestController(
    targetControllerRequest(request, "acknowledgeLegacyAdoption", selectionReceipt, binding),
    context,
  );
  const legacyAdoptionAck = assertTargetLegacyAdoptionResponse(acknowledged, binding, request, {
    acknowledged: true,
  });
  return Object.freeze({ ...response, legacyAdoption: binding, legacyAdoptionAck });
}

async function completeRootLegacyAdoption(
  request,
  rootTransaction,
  selectionReceipt,
  response,
  context,
) {
  const binding = rootLegacyAdoptionBinding(rootTransaction);
  if (!binding) {
    return response;
  }
  const finalized = await finalizeLegacyAdoptionAfterCommit(
    request,
    rootTransaction,
    selectionReceipt,
    response,
    context,
  );
  rootTransaction = await context.writeRootProductTransaction(
    context.paths,
    advanceRootProductTransaction(rootTransaction, {
      phase: "commit-acknowledged",
      durableCommitDecision: true,
      legacyAdoptionAckDigest: finalized.legacyAdoptionAck.receiptDigest,
      now: context.now(),
    }),
    context.rootUid,
    context.rootGid,
  );
  await context.onLegacyAdoptionPhase?.("after-target-ack", {
    request,
    rootTransaction,
    response: finalized,
  });
  await context.acknowledgeImportedLegacyAdoption(context, {
    adoptionReceiptDigest: rootTransaction.legacyAdoptionDigest,
    legacyTransactionId: rootTransaction.legacyAdoptionTransactionId,
    legacyAdoptionAck: finalized.legacyAdoptionAck,
  });
  await context.onLegacyAdoptionPhase?.("after-root-import-removal", {
    request,
    rootTransaction,
    response: finalized,
  });
  return finalized;
}

function targetControllerRequest(
  request,
  op = request.op,
  supervisorReceipt = undefined,
  legacyAdoption = null,
) {
  return Object.freeze({
    schemaVersion: 2,
    op,
    transactionId: request.transactionId,
    version: request.version,
    ...(supervisorReceipt ? { supervisorReceipt } : {}),
    ...(legacyAdoption ? { legacyAdoption } : {}),
  });
}

async function probeControllerIdentity(request, context, expectedIdentity) {
  const response = await requestController(
    targetControllerRequest(request, "controllerStatus"),
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

async function recoverBeforeSupervisorRequest(request, context) {
  const [active, productJournal] = await Promise.all([
    context.readRootProductTransaction(context.paths, context.rootUid),
    context.readControllerProductJournal(context.paths, context.rootUid),
  ]);
  if (!active && !productJournal) {
    return null;
  }
  const sameProductTransaction =
    active &&
    productJournal &&
    (request.op === "updateController" || ROOT_TRANSACTION_OPERATIONS.has(request.op)) &&
    active.transactionId === request.transactionId &&
    active.version === request.version &&
    productJournal.transactionId === request.transactionId &&
    productJournal.version === request.version;
  if (sameProductTransaction) {
    // Every client phase verifies the selected controller again before it
    // continues a prepared release. Both that idempotent updateController
    // request and the subsequent prepare/activate/authorize/commit requests
    // belong to this transaction. Treating either as crash recovery rolls the
    // controller journal back immediately before it can continue.
    assertRootProductJournalBinding(active, productJournal);
    return null;
  }
  let selectionIsFresh = false;
  if (active?.targetControllerReceipt) {
    try {
      assertControllerSelectionReceiptFresh(active.targetControllerReceipt, context.now());
      selectionIsFresh = true;
    } catch {
      selectionIsFresh = false;
    }
  }
  const sameSelectedTransaction =
    active?.transactionId === request.transactionId &&
    active?.version === request.version &&
    active?.phase === "selected" &&
    selectionIsFresh &&
    !productJournal;
  if (sameSelectedTransaction) {
    return null;
  }
  fail("lifecycle recovery is pending; use the bound explicit recovery operation");
}

function supervisorRecoveryResponse(request, recovery, extra = {}) {
  return Object.freeze({
    ok: true,
    transactionId: request.transactionId,
    version: request.version,
    phase: recovery.state === "READY" ? "ready" : "recovery-pending",
    changed: false,
    recovery,
    ...extra,
  });
}

async function handleExplicitSupervisorRecovery(request, context, state) {
  const authorized = state.recovery;
  const pending = await inspectRootProductRecovery(context);
  state.recovery = pending;
  if (
    authorized.state !== pending.state ||
    authorized.journalDigest !== pending.journalDigest ||
    authorized.transactionId !== pending.transactionId ||
    authorized.targetVersion !== pending.targetVersion
  ) {
    fail("active lifecycle recovery journal changed after status authorization");
  }
  if (pending.state !== "RECOVERY_PENDING") {
    return supervisorRecoveryResponse(request, pending, { replayed: true });
  }
  if (
    pending.transactionId === null ||
    pending.targetVersion === null ||
    pending.journalDigest === null ||
    request.transactionId !== pending.transactionId ||
    request.version !== pending.targetVersion ||
    request.recoveryDigest !== pending.journalDigest
  ) {
    fail("active lifecycle recovery request does not match the protected journal");
  }
  await authorizeExplicitRecoveryAttempt(context, pending, request);
  try {
    let recoveryResult = null;
    if (pending.source === "supervisor") {
      const restartRequired = await context.recoverSupervisorTransaction(context);
      recoveryResult = Object.freeze({ recovered: true, restartRequired });
    } else {
      recoveryResult = await context.recoverRootProductTransaction(context, {
        explicit: true,
        expectedJournalDigest: pending.journalDigest,
        recoveryRequest: request,
        supervisorState: state,
      });
    }
    const recovery = await refreshSupervisorRecoveryState(context, state);
    if (
      recovery.state === "READY" ||
      (recovery.state === "RECOVERY_PENDING" && recovery.journalDigest !== pending.journalDigest)
    ) {
      await clearExplicitRecoveryAttempt(context);
    }
    return supervisorRecoveryResponse(request, recovery, {
      changed: recoveryResult?.recovered === true,
      action: recoveryResult?.action ?? null,
      restartRequired: recoveryResult?.restartRequired === true,
    });
  } catch (error) {
    await refreshSupervisorRecoveryState(context, state);
    throw error;
  }
}

async function handleSupervisorRequest(request, context, state) {
  state.recovery ??= Object.freeze({ state: "READY" });
  if (request.op === "recoveryStatus") {
    return supervisorRecoveryResponse(
      request,
      await refreshSupervisorRecoveryState(context, state),
    );
  }
  if (state.recovery.state === "INVALID_LEDGER") {
    fail("lifecycle recovery ledger is invalid; only status is available");
  }
  if (state.recovery.state === "RECOVERY_PENDING") {
    if (request.op !== "recoverActive") {
      fail("lifecycle recovery is pending; new product mutation is blocked");
    }
    return await handleExplicitSupervisorRecovery(request, context, state);
  }
  if (request.op === "recoverActive") {
    return supervisorRecoveryResponse(request, state.recovery, { replayed: true });
  }
  await recoverBeforeSupervisorRequest(request, context);
  if (request.op === "rollbackRelease") {
    const recovered = await readDurableReceipt(context.paths, request, [
      "rollbackRelease",
      "recoverRelease",
    ]);
    if (recovered?.outcome === "rolled-back") {
      return {
        ok: true,
        transactionId: request.transactionId,
        version: request.version,
        phase: "rolled-back",
        changed: false,
        replayed: true,
      };
    }
  }
  if (request.op === "applyRelease") {
    const receipt = await readDurableReceipt(context.paths, request);
    if (
      receipt?.outcome === "committed" &&
      receipt.operation === "applyRelease" &&
      receipt.release
    ) {
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
    const importedLegacyAdoption = await context.readImportedLegacyAdoption(context);
    const previousProductVersion = await context.readProductVersion(context.paths, context.rootUid);
    assertImportedLegacyAdoptionRequest(importedLegacyAdoption, request, previousProductVersion);
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
      // An unchanged controller can be serving an already-prepared product
      // transaction whose supervisor receipt is bound to this exact process.
      // Restarting it after one failed probe invalidates that receipt and turns
      // a retryable observation failure into a forced rollback. Let systemd
      // recover a genuinely failed worker and let the stable client retry the
      // same bounded request; only a newly selected generation is restarted by
      // this transaction.
      state.controllerInstanceId = await context.probeControllerIdentity(
        request,
        context,
        staged.identity,
      );
      await context.cleanupHistoricalControllerCandidates(
        context.paths,
        request.version,
        context.rootUid,
      );
      if (durableChange) {
        await context.commitLifecycleTrust(context.paths, staged);
        if (!staged.supervisorChanged) {
          await context.clearSupervisorTransaction(context.paths);
          transactionActive = false;
        }
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
        { now: context.now() },
      );
    } catch (error) {
      throw new Error(
        `verified target controller is selected but its authorization receipt is unavailable; retry the same update: ${error.message}`,
        { cause: error },
      );
    }
    const existingRootTransaction = await context.readRootProductTransaction(
      context.paths,
      context.rootUid,
    );
    if (existingRootTransaction) {
      const existingProductJournal =
        existingRootTransaction.phase === "selected"
          ? null
          : await context.readControllerProductJournal(context.paths, context.rootUid);
      const continuingProductTransaction =
        existingProductJournal &&
        existingProductJournal.transactionId === request.transactionId &&
        existingProductJournal.version === request.version;
      if (continuingProductTransaction) {
        assertRootProductJournalBinding(existingRootTransaction, existingProductJournal);
      }
      if (
        (existingRootTransaction.phase !== "selected" && !continuingProductTransaction) ||
        existingRootTransaction.transactionId !== request.transactionId ||
        existingRootTransaction.version !== request.version ||
        existingRootTransaction.selectionDigest !== selectionReceipt.selectionDigest ||
        canonicalRootValue(existingRootTransaction.targetControllerReceipt) !==
          canonicalRootValue(selectionReceipt) ||
        existingRootTransaction.legacyAdoptionDigest !==
          (importedLegacyAdoption?.adoptionReceiptDigest ?? null) ||
        existingRootTransaction.legacyAdoptionTransactionId !==
          (importedLegacyAdoption?.legacyTransactionId ?? null) ||
        existingRootTransaction.legacyAdoptionPreviousVersion !==
          (importedLegacyAdoption?.previousVersion ?? null) ||
        existingRootTransaction.legacyAdoptionTargetVersion !==
          (importedLegacyAdoption?.targetVersion ?? null)
      ) {
        fail("selected root product transaction does not match the controller retry");
      }
    } else {
      await context.writeRootProductTransaction(
        context.paths,
        rootProductTransactionRecord({
          request,
          phase: "selected",
          previousVersion: previousProductVersion,
          previousControllerIdentity: staged.previousIdentity ?? null,
          previousControllerGenerationVersion: staged.previousIdentity?.version ?? null,
          targetControllerReceipt: selectionReceipt,
          selectionDigest: selectionReceipt.selectionDigest,
          legacyAdopted: importedLegacyAdoption !== null,
          legacyAdoptionDigest: importedLegacyAdoption?.adoptionReceiptDigest ?? null,
          legacyAdoptionTransactionId: importedLegacyAdoption?.legacyTransactionId ?? null,
          legacyAdoptionPreviousVersion: importedLegacyAdoption?.previousVersion ?? null,
          legacyAdoptionTargetVersion: importedLegacyAdoption?.targetVersion ?? null,
          now: context.now(),
        }),
        context.rootUid,
        context.rootGid,
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
  let rootTransaction = null;
  if (ROOT_TRANSACTION_OPERATIONS.has(request.op)) {
    rootTransaction = await context.readRootProductTransaction(context.paths, context.rootUid);
    if (!rootTransaction) {
      const importedLegacyAdoption = await context.readImportedLegacyAdoption(context);
      const previousVersion = await context.readProductVersion(context.paths, context.rootUid);
      assertImportedLegacyAdoptionRequest(importedLegacyAdoption, request, previousVersion);
      rootTransaction = await context.writeRootProductTransaction(
        context.paths,
        rootProductTransactionRecord({
          request,
          phase: "selected",
          previousVersion,
          targetControllerReceipt: selectionReceipt,
          selectionDigest: selectionReceipt.selectionDigest,
          legacyAdopted: importedLegacyAdoption !== null,
          legacyAdoptionDigest: importedLegacyAdoption?.adoptionReceiptDigest ?? null,
          legacyAdoptionTransactionId: importedLegacyAdoption?.legacyTransactionId ?? null,
          legacyAdoptionPreviousVersion: importedLegacyAdoption?.previousVersion ?? null,
          legacyAdoptionTargetVersion: importedLegacyAdoption?.targetVersion ?? null,
          now: context.now(),
        }),
        context.rootUid,
        context.rootGid,
      );
    }
    if (
      rootTransaction.transactionId !== request.transactionId ||
      rootTransaction.version !== request.version ||
      rootTransaction.selectionDigest !== selectionReceipt.selectionDigest
    ) {
      fail("root product transaction does not match its selected controller");
    }
    rootTransaction = await context.writeRootProductTransaction(
      context.paths,
      advanceRootProductTransaction(rootTransaction, {
        phase: "dispatching",
        operation: request.op,
        now: context.now(),
      }),
      context.rootUid,
      context.rootGid,
    );
  }
  let response = await context.requestController(
    targetControllerRequest(
      request,
      request.op,
      selectionReceipt,
      // The target controller receives only the root-bound digest and legacy
      // transaction identity. It never treats the schema-1 operator journal as
      // one of its native schema-7/8 recovery journals.
      rootLegacyAdoptionBinding(rootTransaction),
    ),
    context,
  );
  if (!response.ok) {
    const error = new Error(response.error || `target controller rejected ${request.op}`);
    error.code = "TARGET_CONTROLLER_REJECTED";
    throw error;
  }
  if (rootTransaction) {
    const productJournal = await context.readControllerProductJournal(
      context.paths,
      context.rootUid,
    );
    if (
      (request.op === "applyRelease" || request.op === "commitRelease") &&
      response.ok &&
      response.phase === "committed"
    ) {
      if (productJournal) {
        fail("target controller reported commit before clearing its product journal");
      }
      if (rootLegacyAdoptionBinding(rootTransaction)) {
        rootTransaction = await context.writeRootProductTransaction(
          context.paths,
          advanceRootProductTransaction(rootTransaction, {
            phase: "commit-ack-pending",
            targetReleaseIdentity: response.release ?? rootTransaction.targetReleaseIdentity,
            durableCommitDecision: true,
            now: context.now(),
          }),
          context.rootUid,
          context.rootGid,
        );
        await context.onLegacyAdoptionPhase?.("after-root-commit-durable", {
          request,
          rootTransaction,
          response,
        });
        response = await completeRootLegacyAdoption(
          request,
          rootTransaction,
          selectionReceipt,
          response,
          context,
        );
      }
      await context.clearRootProductTransaction(context.paths);
    } else if (request.op === "rollbackRelease" && response.ok) {
      if (productJournal) {
        fail("target controller reported rollback before clearing its product journal");
      }
      await restorePreviousControllerAfterProductRollback(rootTransaction, context, state);
      await context.clearRootProductTransaction(context.paths);
    } else if (response.ok && ROOT_TRANSACTION_PHASES.has(response.phase)) {
      await context.writeRootProductTransaction(
        context.paths,
        advanceRootProductTransaction(rootTransaction, {
          phase: response.phase,
          targetReleaseIdentity:
            productJournal?.targetReleaseIdentity ?? rootTransaction.targetReleaseIdentity,
          artifactDigests: productJournal?.artifactDigests ?? rootTransaction.artifactDigests,
          targetJournalSha256: productJournal?.journalSha256 ?? rootTransaction.targetJournalSha256,
          durableCommitDecision:
            rootTransaction.durableCommitDecision ||
            new Set(["gateway-verified", "committing"]).has(response.phase),
          now: context.now(),
        }),
        context.rootUid,
        context.rootGid,
      );
    }
  }
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
  const state = {
    controllerInstanceId: randomUUID(),
    recovery: Object.freeze({ state: "READY" }),
  };
  await fsp.mkdir(path.dirname(context.paths.publicSocketPath), {
    recursive: true,
    mode: 0o711,
  });
  await fsp.mkdir(context.paths.supervisorStateDir, { recursive: true, mode: 0o700 });
  await refreshSupervisorRecoveryState(context, state);
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
      const operation = queue
        .then(() => handleSupervisorRequest(request, context, state))
        .catch(async (error) => {
          await refreshSupervisorRecoveryState(context, state);
          throw error;
        });
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
            recoveryComplete: error?.supervisorRecoveryComplete === true,
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
  return { server, close, context, state, restartRequired: false };
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
  advanceRootProductTransaction,
  advanceLifecycleTrustState,
  atomicWrite,
  assertRootProductTransactionTransition,
  beginSupervisorTransaction,
  commitLifecycleTrust,
  createControllerSelectionReceipt,
  parseControllerSelectionReceipt,
  parseRootProductTransaction,
  assertControllerSelectionReceiptFresh,
  cleanupHistoricalControllerCandidates,
  compareVersions,
  createContext,
  createRecoveryAuthorization,
  finalizeLegacyAdoptionAfterCommit,
  handleSupervisorRequest,
  initialLifecycleTrustState,
  lifecyclePaths,
  platformIdentity,
  recoverSupervisorTransaction,
  recoverRootProductTransaction,
  recoveryIdentityDigest,
  rootProductTransactionRecord,
  assertRecoveryAuthorizationBinding,
  readControllerSelectionReceipt,
  renderBoundaryUnits,
  supervisorGenerationPath,
  restoreSupervisorSelection,
  restoreControllerSelection,
  writeControllerSelectionReceipt,
  authorizePublicSocket,
  privateMkdtemp,
  sealSupervisorArtifact,
  verifyLifecycleRootTransition,
});
