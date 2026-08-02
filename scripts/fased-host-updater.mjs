#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const RELEASE_BASE = "https://github.com/fased-ai/fased/releases/download";
const LIFECYCLE_ROOT_POLICY_SHA256 =
  "23d3e8235a39729d6ae37a5784eaa717a47e4ac725f5a416e78754ad9b4618ca";
const ROOT_APPROVED_RELEASE_AUTHORITY = Object.freeze({
  type: "github-artifact-attestation-v1",
  repository: "fased-ai/fased",
  workflow: "fased-ai/fased/.github/workflows/hosted-runtime-release.yml",
  sourceRefPrefix: "refs/tags/v",
  denySelfHostedRunners: true,
});
const RELEASE_REPOSITORY = ROOT_APPROVED_RELEASE_AUTHORITY.repository;
const RELEASE_WORKFLOW = ROOT_APPROVED_RELEASE_AUTHORITY.workflow;
const RELEASE_MANIFEST_NAME = "fased-hosted-release-v2.json";
const RELEASE_MANIFEST_BUNDLE_NAME = `${RELEASE_MANIFEST_NAME}.attestation.json`;
const SIGNER_ATTESTATION_BUNDLE_NAME = "fased-signerd-release.attestation.json";
const HISTORICAL_Q0_TEST_STATE_DIR = "/etc/fased/testing";
const CONTROLLER_SERVER_NAME = "fased-host-updater.mjs";
const CONTROLLER_CLIENT_NAME = "fased-host-updaterctl.mjs";
const CONTROLLER_SERVER_BUNDLE_NAME = `${CONTROLLER_SERVER_NAME}.attestation.json`;
const CONTROLLER_CLIENT_BUNDLE_NAME = `${CONTROLLER_CLIENT_NAME}.attestation.json`;
const LIFECYCLE_SUPERVISOR_NAME = "fased-lifecycle-supervisor.mjs";
const LIFECYCLE_SUPERVISOR_BUNDLE_NAME = `${LIFECYCLE_SUPERVISOR_NAME}.attestation.json`;
const LIFECYCLE_TRUST_METADATA_NAME = "fased-lifecycle-trust-v1.json";
const LIFECYCLE_TRUST_METADATA_BUNDLE_NAME = `${LIFECYCLE_TRUST_METADATA_NAME}.attestation.json`;
const EVIDENCE_VERIFIER_NAME = "fased-privileged-release-evidence.mjs";
const PRIVILEGED_PROVENANCE_NAME = "fased-privileged-provenance-v1.intoto.json";
const PRIVILEGED_PROVENANCE_BUNDLE_NAME = `${PRIVILEGED_PROVENANCE_NAME}.attestation.json`;
const PRIVILEGED_SBOM_NAME = "fased-privileged-sbom-v1.spdx.json";
const PRIVILEGED_VEX_NAME = "fased-privileged-vex-v1.openvex.json";
const MANAGED_UPDATER_SUPPORT_FILES = Object.freeze([
  "hosted-release-manifest.mjs",
  "lifecycle-trust-crypto.mjs",
  "lifecycle-trust-policy.mjs",
  "lifecycle-trust-root.mjs",
  "lifecycle-trust-runtime.mjs",
  "managed-runtime-layout.mjs",
]);
const CONTROLLER_SELF_CHECK_SCHEMA_VERSION = 1;
const CONTROLLER_PROTOCOL_VERSION = 2;
const SUPERVISOR_PROTOCOL_VERSION = 1;
const CONTROLLER_SELECTION_SCHEMA_VERSION = 2;
const SOCKET_PATH = "/run/fased-host-updater/request.sock";
const STATE_DIR = "/var/lib/fased-host-updater";
const CONTROLLER_RELEASES_DIR = "/opt/fased/host-controller/releases";
const CONTROLLER_CURRENT_LINK = "/opt/fased/host-controller/current";
const APPLICATION_RELEASES_DIR = "/opt/fased/host-application/releases";
const APPLICATION_CURRENT_LINK = "/opt/fased/host-application/current";
const SIGNER_PATH = "/opt/fased/signer/fased-signerd";
const SIGNER_STATE_DB_PATH = "/var/lib/fased-signerd/state.db";
const SIGNER_MASTER_KEY_PATH = "/var/lib/fased-signerd/master.key";
const SIGNER_AUDIT_LOG_PATH = "/var/lib/fased-signerd/audit.jsonl";
const SIGNER_UNIT_PATH = "/etc/systemd/system/fased-signerd.service";
const VERSION_PATH = path.join(STATE_DIR, "signer-version");
const CHANNEL_PATH = "/etc/fased/host-updater-channel";
const JOURNAL_PATH = path.join(STATE_DIR, "active-signer-transaction.json");
const LEGACY_ADOPTION_RECEIPT_NAME = "legacy-managed-update-adoption.v1.json";
const ROLLBACK_FLOOR_PATH = path.join(STATE_DIR, "rollback-floor");
const GATEWAY_GATE_PATH = path.join(STATE_DIR, "gateway-update-gate");
const SIGNER_GATE_PATH = "/var/lib/fased-signer-update-gate/active";
const TRANSACTIONS_DIR = path.join(STATE_DIR, "transactions");
const MAX_REQUEST_BYTES = 4096;
const REQUEST_TIMEOUT_MS = 20 * 60_000;
const CROSS_PRODUCT_HEALTH_TIMEOUT_MS = 30_000;
const JOURNAL_SCHEMA_VERSION = 8;
const PROTOCOL_SCHEMA_VERSION = 2;
const CONTROLLER_SELECTION_CAPABILITIES = Object.freeze({
  supervisorProtocol: SUPERVISOR_PROTOCOL_VERSION,
  controllerProtocol: CONTROLLER_PROTOCOL_VERSION,
  requestSchema: PROTOCOL_SCHEMA_VERSION,
});
const CONTROLLER_RECOVERY_CAPABILITIES = Object.freeze({
  protocolVersion: 1,
  operations: Object.freeze(["recoverActive"]),
  journalSchemas: Object.freeze([7, 8]),
});
const MIGRATION_SELECTION_SCHEMA_VERSION = 1;
const SCHEMA_MIGRATION_SCHEMA_VERSION = 1;
const SUPPORTED_MIGRATION_PROFILES = new Set(["protected-local", "hosting"]);
const SUPPORTED_MANAGED_INSTALL_SCHEMAS = new Set([null, 1, 2]);
const SUPPORTED_WALLET_REGISTRY_SCHEMAS = new Set([null, 1]);
const LIFECYCLE_COMPATIBILITY_ADAPTERS = Object.freeze({
  application: Object.freeze({
    absent: "managed-install-absent",
    "schema:1": "managed-install-v1-to-v2",
    "schema:2": "managed-install-v2",
  }),
  controller: Object.freeze({
    "protocol:2": "controller-protocol-v2",
  }),
  signer: Object.freeze({
    "schema:2": "signer-schema-v2",
  }),
  wallet: Object.freeze({
    absent: "wallet-registry-absent",
    "schema:1": "wallet-registry-v1",
  }),
  mining: Object.freeze({
    "schema:1": "mining-schema-v1",
  }),
  federation: Object.freeze({
    "schema:2": "federation-schema-v2",
  }),
  sharedState: Object.freeze({
    "schema:1": "declared-state-registry-v1",
  }),
  profileAccess: Object.freeze({
    "protected-local:linux-systemd": "protected-local-system-v1",
    "hosting:linux-systemd": "hosting-system-v1",
  }),
});
const LIFECYCLE_SCHEMA_MIGRATIONS = Object.freeze({
  "managed-install-absent": Object.freeze({
    component: "application",
    stateClass: "application-runtime",
    schemaOwner: "target-controller",
    fromSchema: null,
    toSchema: 2,
    mode: "initialize-on-activation",
  }),
  "managed-install-v1-to-v2": Object.freeze({
    component: "application",
    stateClass: "application-runtime",
    schemaOwner: "target-controller",
    fromSchema: 1,
    toSchema: 2,
    mode: "migrate-on-activation",
  }),
  "managed-install-v2": Object.freeze({
    component: "application",
    stateClass: "application-runtime",
    schemaOwner: "target-controller",
    fromSchema: 2,
    toSchema: 2,
    mode: "verify-current",
  }),
  "signer-schema-v2": Object.freeze({
    component: "signer",
    stateClass: "signer-private-state",
    schemaOwner: "fased-signerd",
    fromSchema: 2,
    toSchema: 2,
    mode: "delegate-and-verify",
  }),
  "wallet-registry-absent": Object.freeze({
    component: "wallet",
    stateClass: "wallet",
    schemaOwner: "wallet-registry-and-fased-signerd",
    fromSchema: null,
    toSchema: 1,
    mode: "preserve-optional-absence",
  }),
  "wallet-registry-v1": Object.freeze({
    component: "wallet",
    stateClass: "wallet",
    schemaOwner: "wallet-registry-and-fased-signerd",
    fromSchema: 1,
    toSchema: 1,
    mode: "verify-current",
  }),
  "mining-schema-v1": Object.freeze({
    component: "mining",
    stateClass: "mining",
    schemaOwner: "sat-mining",
    fromSchema: 1,
    toSchema: 1,
    mode: "verify-current",
  }),
  "federation-schema-v2": Object.freeze({
    component: "federation",
    stateClass: "federation-network",
    schemaOwner: "fased-network",
    fromSchema: 2,
    toSchema: 2,
    mode: "verify-current",
  }),
  "declared-state-registry-v1": Object.freeze({
    component: "sharedState",
    stateClass: "declared-state-registry",
    schemaOwner: "target-controller",
    fromSchema: 1,
    toSchema: 1,
    mode: "verify-current",
  }),
});
const SCHEMA_MIGRATION_COMPONENTS = Object.freeze([
  "application",
  "signer",
  "wallet",
  "mining",
  "federation",
  "sharedState",
]);
const TRANSACTION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TRANSACTION_OPERATIONS = new Set([
  "updateController",
  "applyRelease",
  "prepareRelease",
  "activateRelease",
  "authorizeGatewayRelease",
  "gateGatewayRelease",
  "restartGateway",
  "commitRelease",
  "rollbackRelease",
]);
const CONTROLLER_OPERATIONS = new Set([
  ...TRANSACTION_OPERATIONS,
  "acknowledgeLegacyAdoption",
  "controllerStatus",
  "releaseStatus",
  "recoveryStatus",
  "recoverActive",
]);
const TRANSACTION_PHASES = new Set([
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
  "rolling-back",
  "restored",
]);

const PUBLIC_STABLE_INSTALLER_URL =
  "https://github.com/fased-ai/fased/releases/latest/download/install.sh";

export function hostingBootstrapCommand(version) {
  const normalized = String(version ?? "")
    .trim()
    .replace(/^v/, "");
  const selector = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(normalized)
    ? ` --release v${normalized} --update-channel ${normalized.includes("-") ? "beta" : "stable"}`
    : "";
  const installerUrl = selector
    ? `https://github.com/fased-ai/fased/releases/download/v${normalized}/install.sh`
    : PUBLIC_STABLE_INSTALLER_URL;
  return `curl -fsSL ${installerUrl} | bash -s -- --hosting${selector}`;
}

export function legacyHostingBootstrapMessage(version) {
  return [
    "This Hosting installation has a legacy root controller that cannot replace itself.",
    "From the VPS provider root console, run this one verified Hosting bootstrap command:",
    hostingBootstrapCommand(version),
    "It detects the existing installation, preserves persistent state, performs the one-time controller and signer migration transactionally, and skips onboarding.",
    "After it succeeds, return to the app account and use only fased update.",
    "Never run /home/app/fased/install.sh with sudo or as root.",
    "The current Gateway, signer, wallets, and persistent state were left unchanged.",
  ].join(" ");
}

export const PRE_V2_HOSTING_MIGRATION_MESSAGE = legacyHostingBootstrapMessage();

const DEFAULT_PATHS = Object.freeze({
  socketPath: SOCKET_PATH,
  stateDir: STATE_DIR,
  controllerReleasesDir: CONTROLLER_RELEASES_DIR,
  controllerCurrentLink: CONTROLLER_CURRENT_LINK,
  controllerVersionPath: path.join(STATE_DIR, "controller-version.json"),
  supervisorStateDir: path.join(STATE_DIR, "supervisor"),
  applicationReleasesDir: APPLICATION_RELEASES_DIR,
  applicationCurrentLink: APPLICATION_CURRENT_LINK,
  signerPath: SIGNER_PATH,
  signerStateDBPath: SIGNER_STATE_DB_PATH,
  signerMasterKeyPath: SIGNER_MASTER_KEY_PATH,
  signerAuditLogPath: SIGNER_AUDIT_LOG_PATH,
  signerUnitPath: SIGNER_UNIT_PATH,
  versionPath: VERSION_PATH,
  channelPath: CHANNEL_PATH,
  journalPath: JOURNAL_PATH,
  rollbackFloorPath: ROLLBACK_FLOOR_PATH,
  gatewayGatePath: GATEWAY_GATE_PATH,
  signerGatePath: SIGNER_GATE_PATH,
  transactionsDir: TRANSACTIONS_DIR,
});

export function protectedLocalControllerConfiguration(instanceId) {
  const normalized = String(instanceId ?? "").trim();
  if (!/^[a-f0-9]{16}$/u.test(normalized)) {
    throw new Error("Protected Local controller instance ID must be 16 lowercase hex characters");
  }
  const runtimeDir = `/run/fased-local/${normalized}`;
  const controllerRuntimeDir = `/run/fased-local-controller/${normalized}`;
  const instanceStateDir = `/var/lib/fased-local/${normalized}`;
  const signerStateDir = `${instanceStateDir}/signer`;
  const controllerStateDir = `${instanceStateDir}/controller`;
  const instanceInstallDir = `/opt/fased/local/${normalized}`;
  const controllerInstallDir = `${instanceInstallDir}/controller`;
  const applicationInstallDir = `${instanceInstallDir}/application`;
  return Object.freeze({
    profile: "protected-local",
    instanceId: normalized,
    signerServiceName: `fased-signerd-${normalized}.service`,
    gatewayServiceName: `fased-gateway-${normalized}.service`,
    signerApplicationSocketPath: `${runtimeDir}/application/app.sock`,
    paths: Object.freeze({
      socketPath: `${controllerRuntimeDir}/request.sock`,
      stateDir: controllerStateDir,
      controllerReleasesDir: `${controllerInstallDir}/releases`,
      controllerCurrentLink: `${controllerInstallDir}/current`,
      controllerVersionPath: `${controllerStateDir}/controller-version.json`,
      supervisorStateDir: `${controllerStateDir}/supervisor`,
      controllerUnitPath: `/etc/systemd/system/fased-local-controller-${normalized}.service`,
      applicationReleasesDir: `${applicationInstallDir}/releases`,
      applicationCurrentLink: `${applicationInstallDir}/current`,
      gatewayUnitPath: `/etc/systemd/system/fased-gateway-${normalized}.service`,
      gatewayLauncherPath: `${instanceInstallDir}/gateway-launch`,
      signerPath: `${instanceInstallDir}/signer/fased-signerd`,
      signerStateDBPath: `${signerStateDir}/state.db`,
      signerMasterKeyPath: `${signerStateDir}/master.key`,
      signerAuditLogPath: `${signerStateDir}/audit.jsonl`,
      signerUnitPath: `/etc/systemd/system/fased-signerd-${normalized}.service`,
      versionPath: `${controllerStateDir}/signer-version`,
      channelPath: `/etc/fased/local/${normalized}/update-channel`,
      journalPath: `${controllerStateDir}/active-signer-transaction.json`,
      rollbackFloorPath: `${controllerStateDir}/rollback-floor`,
      gatewayGatePath: `${controllerStateDir}/gateway-update-gate`,
      signerGatePath: `${controllerStateDir}/signer-update-gate`,
      transactionsDir: `${controllerStateDir}/transactions`,
    }),
  });
}

function resolveRunningControllerVersion(modulePath = fileURLToPath(import.meta.url)) {
  let resolved;
  try {
    resolved = fs.realpathSync(modulePath);
  } catch {
    return null;
  }
  const match =
    /^\/opt\/fased\/host-controller\/releases\/v([^/]+)\/fased-host-updater\.mjs$/u.exec(
      resolved,
    ) ??
    /^\/opt\/fased\/local\/[a-f0-9]{16}\/controller\/releases\/v([^/]+)\/fased-host-updater\.mjs$/u.exec(
      resolved,
    );
  if (!match) {
    return null;
  }
  return parseReleaseVersion(match[1]);
}

function resolveRunningControllerIdentity(modulePath = fileURLToPath(import.meta.url)) {
  let resolved;
  try {
    resolved = fs.realpathSync(modulePath);
  } catch {
    return null;
  }
  const match =
    /^\/opt\/fased\/host-controller\/releases\/v([^/]+)\/fased-host-updater\.mjs$/u.exec(
      resolved,
    ) ??
    /^\/opt\/fased\/local\/[a-f0-9]{16}\/controller\/releases\/v([^/]+)\/fased-host-updater\.mjs$/u.exec(
      resolved,
    );
  if (!match) {
    return null;
  }
  const clientPath = path.join(path.dirname(resolved), CONTROLLER_CLIENT_NAME);
  try {
    return Object.freeze({
      version: parseReleaseVersion(match[1]),
      serverSha256: createHash("sha256").update(fs.readFileSync(resolved)).digest("hex"),
      clientSha256: createHash("sha256").update(fs.readFileSync(clientPath)).digest("hex"),
    });
  } catch {
    return null;
  }
}

export function parseReleaseVersion(value) {
  const version = String(value ?? "")
    .trim()
    .replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(version)) {
    throw new Error("version must be an exact semantic release version");
  }
  return version;
}

function parseTransactionId(value) {
  const transactionId = String(value ?? "").trim();
  if (!TRANSACTION_ID_PATTERN.test(transactionId)) {
    throw new Error("transactionId must be a UUIDv4");
  }
  return transactionId.toLowerCase();
}

function parseSupervisorSelectionReceipt(value, expected = {}) {
  const schemaVersion = Number(value?.schemaVersion);
  exactObjectKeys(
    value,
    schemaVersion === 1
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
    "supervisor controller selection receipt",
  );
  exactObjectKeys(
    value.protocolCapabilities,
    ["supervisorProtocol", "controllerProtocol", "requestSchema"],
    "supervisor controller selection capabilities",
  );
  const unsigned = {
    schemaVersion,
    transactionId: parseTransactionId(value.transactionId),
    version: parseReleaseVersion(value.version),
    releaseCommit: String(value.releaseCommit ?? ""),
    targetManifestSha256: String(value.targetManifestSha256 ?? ""),
    controllerServerSha256: String(value.controllerServerSha256 ?? ""),
    controllerClientSha256: String(value.controllerClientSha256 ?? ""),
    controllerInstanceId: parseTransactionId(value.controllerInstanceId),
    protocolCapabilities: {
      supervisorProtocol: Number(value.protocolCapabilities.supervisorProtocol),
      controllerProtocol: Number(value.protocolCapabilities.controllerProtocol),
      requestSchema: Number(value.protocolCapabilities.requestSchema),
    },
    ...(schemaVersion === CONTROLLER_SELECTION_SCHEMA_VERSION
      ? {
          nonce: parseTransactionId(value.nonce),
          selectedAt: String(value.selectedAt ?? ""),
          expiresAt: String(value.expiresAt ?? ""),
          trustPolicySha256: String(value.trustPolicySha256 ?? ""),
        }
      : {}),
  };
  const selectedAt = Date.parse(unsigned.selectedAt ?? "");
  const expiresAt = Date.parse(unsigned.expiresAt ?? "");
  const selectionDigest = createHash("sha256").update(canonicalJSON(unsigned)).digest("hex");
  if (
    !new Set([1, CONTROLLER_SELECTION_SCHEMA_VERSION]).has(unsigned.schemaVersion) ||
    !/^[a-f0-9]{40}$/u.test(unsigned.releaseCommit) ||
    !/^[a-f0-9]{64}$/u.test(unsigned.targetManifestSha256) ||
    !/^[a-f0-9]{64}$/u.test(unsigned.controllerServerSha256) ||
    !/^[a-f0-9]{64}$/u.test(unsigned.controllerClientSha256) ||
    canonicalJSON(unsigned.protocolCapabilities) !==
      canonicalJSON(CONTROLLER_SELECTION_CAPABILITIES) ||
    (unsigned.schemaVersion === CONTROLLER_SELECTION_SCHEMA_VERSION &&
      (!Number.isFinite(selectedAt) ||
        new Date(selectedAt).toISOString() !== unsigned.selectedAt ||
        !Number.isFinite(expiresAt) ||
        new Date(expiresAt).toISOString() !== unsigned.expiresAt ||
        selectedAt >= expiresAt ||
        expiresAt - selectedAt > 24 * 60 * 60 * 1000 ||
        !/^[a-f0-9]{64}$/u.test(unsigned.trustPolicySha256))) ||
    value.selectionDigest !== selectionDigest ||
    (expected.transactionId && unsigned.transactionId !== expected.transactionId) ||
    (expected.version && unsigned.version !== expected.version)
  ) {
    throw new Error("supervisor controller selection receipt is malformed or mismatched");
  }
  return Object.freeze({ ...unsigned, selectionDigest });
}

function parseRecoveryAuthorization(value, expected = {}) {
  exactObjectKeys(
    value,
    [
      "schemaVersion",
      "transactionId",
      "version",
      "recoveryIdentityDigest",
      "productJournalDigest",
      "legacySelectionDigest",
      "expectedOutcome",
      "recoveryController",
      "allowedOperation",
      "recoveryEpoch",
      "authorizedAt",
      "authorizationDigest",
    ],
    "recovery controller authorization",
  );
  exactObjectKeys(
    value.recoveryController,
    [
      "version",
      "releaseCommit",
      "targetManifestSha256",
      "serverSha256",
      "clientSha256",
      "trustPolicySha256",
      "protocolCapabilities",
      "recoveryCapabilities",
    ],
    "recovery controller identity",
  );
  exactObjectKeys(
    value.recoveryController.protocolCapabilities,
    ["supervisorProtocol", "controllerProtocol", "requestSchema"],
    "recovery controller protocol capabilities",
  );
  exactObjectKeys(
    value.recoveryController.recoveryCapabilities,
    ["protocolVersion", "operations", "journalSchemas"],
    "recovery controller capabilities",
  );
  const unsigned = {
    schemaVersion: Number(value.schemaVersion),
    transactionId: parseTransactionId(value.transactionId),
    version: parseReleaseVersion(value.version),
    recoveryIdentityDigest: String(value.recoveryIdentityDigest ?? ""),
    productJournalDigest: String(value.productJournalDigest ?? ""),
    legacySelectionDigest: String(value.legacySelectionDigest ?? ""),
    expectedOutcome: String(value.expectedOutcome ?? ""),
    recoveryController: {
      version: parseReleaseVersion(value.recoveryController.version),
      releaseCommit: String(value.recoveryController.releaseCommit ?? ""),
      targetManifestSha256: String(value.recoveryController.targetManifestSha256 ?? ""),
      serverSha256: String(value.recoveryController.serverSha256 ?? ""),
      clientSha256: String(value.recoveryController.clientSha256 ?? ""),
      trustPolicySha256: String(value.recoveryController.trustPolicySha256 ?? ""),
      protocolCapabilities: {
        supervisorProtocol: Number(
          value.recoveryController.protocolCapabilities.supervisorProtocol,
        ),
        controllerProtocol: Number(
          value.recoveryController.protocolCapabilities.controllerProtocol,
        ),
        requestSchema: Number(value.recoveryController.protocolCapabilities.requestSchema),
      },
      recoveryCapabilities: {
        protocolVersion: Number(value.recoveryController.recoveryCapabilities.protocolVersion),
        operations: [...value.recoveryController.recoveryCapabilities.operations],
        journalSchemas: [...value.recoveryController.recoveryCapabilities.journalSchemas],
      },
    },
    allowedOperation: String(value.allowedOperation ?? ""),
    recoveryEpoch: parseTransactionId(value.recoveryEpoch),
    authorizedAt: String(value.authorizedAt ?? ""),
  };
  const authorizedAt = Date.parse(unsigned.authorizedAt);
  const authorizationDigest = createHash("sha256").update(canonicalJSON(unsigned)).digest("hex");
  if (
    unsigned.schemaVersion !== 3 ||
    !/^[a-f0-9]{64}$/u.test(unsigned.recoveryIdentityDigest) ||
    !/^[a-f0-9]{64}$/u.test(unsigned.productJournalDigest) ||
    !/^[a-f0-9]{64}$/u.test(unsigned.legacySelectionDigest) ||
    !new Set(["committed", "rolled-back"]).has(unsigned.expectedOutcome) ||
    !/^[a-f0-9]{40}$/u.test(unsigned.recoveryController.releaseCommit) ||
    !/^[a-f0-9]{64}$/u.test(unsigned.recoveryController.targetManifestSha256) ||
    !/^[a-f0-9]{64}$/u.test(unsigned.recoveryController.serverSha256) ||
    !/^[a-f0-9]{64}$/u.test(unsigned.recoveryController.clientSha256) ||
    !/^[a-f0-9]{64}$/u.test(unsigned.recoveryController.trustPolicySha256) ||
    canonicalJSON(unsigned.recoveryController.protocolCapabilities) !==
      canonicalJSON(CONTROLLER_SELECTION_CAPABILITIES) ||
    canonicalJSON(unsigned.recoveryController.recoveryCapabilities) !==
      canonicalJSON(CONTROLLER_RECOVERY_CAPABILITIES) ||
    unsigned.allowedOperation !== "recoverActive" ||
    !Number.isFinite(authorizedAt) ||
    new Date(authorizedAt).toISOString() !== unsigned.authorizedAt ||
    value.authorizationDigest !== authorizationDigest ||
    (expected.transactionId && unsigned.transactionId !== expected.transactionId) ||
    (expected.version && unsigned.version !== expected.version)
  ) {
    throw new Error("recovery controller authorization is malformed or mismatched");
  }
  return Object.freeze({ ...unsigned, authorizationDigest });
}

function parseLegacyAdoptionBinding(value) {
  if (value == null) {
    return null;
  }
  exactObjectKeys(
    value,
    ["previousVersion", "receiptDigest", "targetVersion", "transactionId"],
    "legacy managed-update adoption binding",
  );
  const binding = Object.freeze({
    receiptDigest: String(value.receiptDigest ?? ""),
    transactionId: parseTransactionId(value.transactionId),
    previousVersion: parseReleaseVersion(value.previousVersion),
    targetVersion: parseReleaseVersion(value.targetVersion),
  });
  if (!/^sha256:[a-f0-9]{64}$/u.test(binding.receiptDigest)) {
    throw new Error("legacy managed-update adoption binding is invalid");
  }
  return binding;
}

export function parseUpdateRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("request must be an object");
  }
  const keys = Object.keys(value).toSorted();
  if (value.schemaVersion === 1) {
    if (keys.join(",") !== "op,schemaVersion,version" || value.op !== "prepareRelease") {
      throw new Error("unsupported updater request");
    }
    const version = parseReleaseVersion(value.version);
    throw new Error(legacyHostingBootstrapMessage(version));
  }
  const hasSupervisorReceipt = Object.hasOwn(value, "supervisorReceipt");
  const hasLegacyAdoption = Object.hasOwn(value, "legacyAdoption");
  const hasRecoveryDigest = value.op === "recoverActive";
  const expectedKeys = [
    "op",
    ...(hasRecoveryDigest ? ["recoveryDigest"] : []),
    ...(hasRecoveryDigest ? ["recoveryControllerInstanceId"] : []),
    ...(hasRecoveryDigest ? ["recoveryAuthorization"] : []),
    "schemaVersion",
    ...(hasLegacyAdoption ? ["legacyAdoption"] : []),
    ...(hasSupervisorReceipt ? ["supervisorReceipt"] : []),
    "transactionId",
    "version",
  ]
    .toSorted()
    .join(",");
  if (keys.join(",") !== expectedKeys) {
    throw new Error("request contains unsupported fields");
  }
  if (value.schemaVersion !== PROTOCOL_SCHEMA_VERSION || !CONTROLLER_OPERATIONS.has(value.op)) {
    throw new Error("unsupported updater transaction request");
  }
  const request = {
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    op: value.op,
    transactionId: parseTransactionId(value.transactionId),
    version: parseReleaseVersion(value.version),
    ...(hasLegacyAdoption
      ? { legacyAdoption: parseLegacyAdoptionBinding(value.legacyAdoption) }
      : {}),
  };
  if (request.legacyAdoption && request.legacyAdoption.targetVersion !== request.version) {
    throw new Error("legacy managed-update adoption target does not match the request");
  }
  const recoveryDigest = hasRecoveryDigest ? String(value.recoveryDigest ?? "") : null;
  const recoveryControllerInstanceId = hasRecoveryDigest
    ? String(value.recoveryControllerInstanceId ?? "").toLowerCase()
    : null;
  const recoveryAuthorization = hasRecoveryDigest
    ? parseRecoveryAuthorization(value.recoveryAuthorization, {
        transactionId: request.transactionId,
        version: request.version,
      })
    : null;
  if (
    hasRecoveryDigest &&
    (!/^[a-f0-9]{64}$/u.test(recoveryDigest) ||
      !TRANSACTION_ID_PATTERN.test(recoveryControllerInstanceId))
  ) {
    throw new Error("active recovery journal digest is invalid");
  }
  return {
    ...request,
    ...(hasRecoveryDigest ? { recoveryDigest } : {}),
    ...(hasRecoveryDigest ? { recoveryControllerInstanceId } : {}),
    ...(hasRecoveryDigest ? { recoveryAuthorization } : {}),
    ...(hasSupervisorReceipt
      ? {
          supervisorReceipt: parseSupervisorSelectionReceipt(value.supervisorReceipt, request),
        }
      : {}),
  };
}

function compareVersions(left, right) {
  const parse = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value);
    if (!match) {
      return null;
    }
    return { core: match.slice(1, 4).map(Number), prerelease: match[4]?.split(".") ?? [] };
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) {
    return null;
  }
  for (let index = 0; index < 3; index += 1) {
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
    const ln = /^\d+$/.test(l);
    const rn = /^\d+$/.test(r);
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

function releaseArchitecture() {
  if (process.platform !== "linux") {
    throw new Error("host updater supports Linux only");
  }
  if (process.arch === "x64") {
    return "amd64";
  }
  if (process.arch === "arm64") {
    return "arm64";
  }
  throw new Error(`unsupported host architecture: ${process.arch}`);
}

async function fixedExecutable(candidates, label) {
  for (const candidate of candidates) {
    try {
      const resolved = await fsp.realpath(candidate);
      const stat = await fsp.stat(resolved);
      if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
        continue;
      }
      await fsp.access(resolved, fs.constants.X_OK);
      return resolved;
    } catch {
      // Try the next root-controlled system path.
    }
  }
  throw new Error(`${label} is not installed in a root-controlled system path`);
}

function systemIdentityExecArguments(uid, gid, executable, args = []) {
  if (
    !Number.isSafeInteger(uid) ||
    uid <= 0 ||
    !Number.isSafeInteger(gid) ||
    gid <= 0 ||
    !path.isAbsolute(executable) ||
    !Array.isArray(args) ||
    args.some((argument) => typeof argument !== "string")
  ) {
    throw new Error("system identity execution requires exact non-root numeric identities");
  }
  return [`--reuid=${uid}`, `--regid=${gid}`, "--init-groups", "--", executable, ...args];
}

async function execFileAsSystemIdentity(executable, args, uid, gid, options) {
  const setpriv = await fixedExecutable(["/usr/bin/setpriv", "/bin/setpriv"], "setpriv");
  return await execFileAsync(
    setpriv,
    systemIdentityExecArguments(uid, gid, executable, args),
    options,
  );
}

async function fsyncDirectory(directory) {
  const handle = await fsp.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicWriteFileDurable(targetPath, content, mode = 0o600) {
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

async function atomicCopyFileDurable(sourcePath, targetPath, metadata = {}) {
  await fsp.mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  await fsp.copyFile(sourcePath, temporaryPath, fs.constants.COPYFILE_EXCL);
  await fsp.chmod(temporaryPath, metadata.mode ?? 0o600);
  if (Number.isInteger(metadata.uid) && Number.isInteger(metadata.gid)) {
    await fsp.chown(temporaryPath, metadata.uid, metadata.gid);
  }
  const handle = await fsp.open(temporaryPath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(temporaryPath, targetPath);
  await fsyncDirectory(path.dirname(targetPath));
}

async function download(url, destination) {
  const response = await fetch(url, {
    headers: { "cache-control": "no-cache" },
    redirect: "follow",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok || !response.body) {
    throw new Error(`official release download failed (${response.status})`);
  }
  await pipeline(response.body, fs.createWriteStream(destination, { mode: 0o600 }));
}

async function sha256(filePath) {
  const hash = createHash("sha256");
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest("hex");
}

function releaseAttestationVerifyArgs(assetPath, version, bundlePath) {
  if (!bundlePath) {
    throw new Error("offline release attestation bundle is required");
  }
  return [
    "attestation",
    "verify",
    assetPath,
    "--repo",
    RELEASE_REPOSITORY,
    "--bundle",
    bundlePath,
    "--signer-workflow",
    RELEASE_WORKFLOW,
    "--source-ref",
    `${ROOT_APPROVED_RELEASE_AUTHORITY.sourceRefPrefix}${version}`,
    ...(ROOT_APPROVED_RELEASE_AUTHORITY.denySelfHostedRunners
      ? ["--deny-self-hosted-runners"]
      : []),
  ];
}

async function verifyReleaseAsset(assetPath, version, stateDir, bundlePath) {
  const gh = await fixedExecutable(["/usr/bin/gh", "/usr/local/bin/gh"], "GitHub CLI");
  await execFileAsync(gh, releaseAttestationVerifyArgs(assetPath, version, bundlePath), {
    env: {
      HOME: stateDir,
      PATH: "/usr/local/bin:/usr/bin:/bin",
      GH_PROMPT_DISABLED: "1",
    },
    timeout: REQUEST_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
  });
}

async function verifyPrivilegedReleaseEvidence(verifierPath, verifierSha256, options) {
  const verifier = await import(`${pathToFileURL(verifierPath).href}?sha256=${verifierSha256}`);
  if (typeof verifier.verifyPrivilegedReleaseEvidence !== "function") {
    throw new Error("privileged release evidence verifier API is unavailable");
  }
  return await verifier.verifyPrivilegedReleaseEvidence(options);
}

function lifecycleSupervisorPaths(configuration) {
  if (configuration.profile === "hosting") {
    return Object.freeze({
      supervisorPath: "/opt/fased/host-controller/supervisor/fased-lifecycle-supervisor.mjs",
      supervisorStateDir: "/var/lib/fased-host-updater/supervisor",
    });
  }
  const instanceId = configuration.instanceId;
  return Object.freeze({
    supervisorPath: `/opt/fased/local/${instanceId}/supervisor/fased-lifecycle-supervisor.mjs`,
    supervisorStateDir: `/var/lib/fased-local/${instanceId}/controller/supervisor`,
  });
}

function supervisorSelectionReceiptPath(paths, receipt) {
  if (!paths.supervisorStateDir) {
    throw new Error("supervisor controller selection state is unavailable");
  }
  return path.join(
    paths.supervisorStateDir,
    "controller-selections",
    receipt.transactionId,
    `${receipt.selectionDigest}.json`,
  );
}

async function readSupervisorSelectionReceipt(paths, receipt, expectedRootUid = 0) {
  const receiptPath = supervisorSelectionReceiptPath(paths, receipt);
  const info = await fsp.lstat(receiptPath);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.uid !== expectedRootUid ||
    (info.mode & 0o177) !== 0
  ) {
    throw new Error("supervisor controller selection receipt is not protected");
  }
  const persisted = parseSupervisorSelectionReceipt(
    JSON.parse(await fsp.readFile(receiptPath, "utf8")),
    receipt,
  );
  if (canonicalJSON(persisted) !== canonicalJSON(receipt)) {
    throw new Error("supervisor controller selection receipt changed after handoff");
  }
  return persisted;
}

function hostingOperatorUid(operatorGid) {
  const groupLine = fs
    .readFileSync("/etc/group", "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(":"))
    .find((fields) => Number(fields[2]) === operatorGid);
  if (!groupLine) {
    throw new Error("Hosting operator group is unavailable");
  }
  const supplemental = new Set((groupLine[3] || "").split(",").filter(Boolean));
  const candidates = fs
    .readFileSync("/etc/passwd", "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(":"))
    .filter(
      (fields) =>
        Number(fields[2]) > 0 && (Number(fields[3]) === operatorGid || supplemental.has(fields[0])),
    )
    .map((fields) => ({ user: fields[0], uid: Number(fields[2]) }));
  if (candidates.length !== 1) {
    throw new Error("Hosting operator group must resolve to one exact non-root account");
  }
  return candidates[0].uid;
}

export function assertLifecycleBootstrapBinding(identity, metadata, supervisorDigest) {
  if (supervisorDigest !== metadata?.targets?.supervisor?.sha256) {
    throw new Error("stable lifecycle supervisor is not bound by lifecycle trust metadata");
  }
  if (
    identity?.serverSha256 !== metadata?.targets?.controllerServer?.sha256 ||
    identity?.clientSha256 !== metadata?.targets?.controllerClient?.sha256
  ) {
    throw new Error(
      "active lifecycle controller is not bound by the verified lifecycle trust metadata",
    );
  }
}

async function ensureStableSupervisorBoundary(configuration, context) {
  if (configuration.supervised) {
    return false;
  }
  const identity = await readControllerIdentity(context.paths);
  if (!identity) {
    throw new Error("target controller identity is unavailable for supervisor bootstrap");
  }
  const version = identity.version;
  const lifecycle = lifecycleSupervisorPaths(configuration);
  await fsp.mkdir(lifecycle.supervisorStateDir, { recursive: true, mode: 0o700 });
  const downloadRoot = await fsp.mkdtemp(
    path.join(lifecycle.supervisorStateDir, `.bootstrap-${version}-`),
  );
  const releaseUrl = `${RELEASE_BASE}/v${version}`;
  const supervisorPath = path.join(downloadRoot, LIFECYCLE_SUPERVISOR_NAME);
  const supervisorBundlePath = path.join(downloadRoot, LIFECYCLE_SUPERVISOR_BUNDLE_NAME);
  const metadataPath = path.join(downloadRoot, LIFECYCLE_TRUST_METADATA_NAME);
  const metadataBundlePath = path.join(downloadRoot, LIFECYCLE_TRUST_METADATA_BUNDLE_NAME);
  let previousSupervisor = null;
  let supervisorReplaced = false;
  try {
    await Promise.all([
      context.downloadReleaseAsset(`${releaseUrl}/${LIFECYCLE_SUPERVISOR_NAME}`, supervisorPath),
      context.downloadReleaseAsset(
        `${releaseUrl}/${LIFECYCLE_SUPERVISOR_BUNDLE_NAME}`,
        supervisorBundlePath,
      ),
      context.downloadReleaseAsset(`${releaseUrl}/${LIFECYCLE_TRUST_METADATA_NAME}`, metadataPath),
      context.downloadReleaseAsset(
        `${releaseUrl}/${LIFECYCLE_TRUST_METADATA_BUNDLE_NAME}`,
        metadataBundlePath,
      ),
    ]);
    await Promise.all([
      context.verifyReleaseAsset(
        supervisorPath,
        version,
        lifecycle.supervisorStateDir,
        supervisorBundlePath,
      ),
      context.verifyReleaseAsset(
        metadataPath,
        version,
        lifecycle.supervisorStateDir,
        metadataBundlePath,
      ),
    ]);
    const { stdout } = await execFileAsync(process.execPath, [supervisorPath, "--self-check"], {
      env: {
        HOME: lifecycle.supervisorStateDir,
        PATH: "/usr/local/bin:/usr/bin:/bin",
      },
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    if (stdout.trim() !== '{"schemaVersion":1,"protocolVersion":1,"role":"lifecycle-supervisor"}') {
      throw new Error("stable lifecycle supervisor self-check is incompatible");
    }
    const supervisorModule = await import(
      `${pathToFileURL(supervisorPath).href}?verified=${await sha256(supervisorPath)}`
    );
    const channel = (await fsp.readFile(context.paths.channelPath, "utf8")).trim();
    const platform =
      process.arch === "x64"
        ? "linux-x64"
        : process.arch === "arm64"
          ? "linux-arm64"
          : `unsupported-${process.arch}`;
    const metadata = supervisorModule.parseLifecycleTrustMetadata(
      JSON.parse(await fsp.readFile(metadataPath, "utf8")),
      {
        expectedVersion: version,
        channel,
        platform,
        now: Date.now(),
      },
    );
    const supervisorDigest = await sha256(supervisorPath);
    assertLifecycleBootstrapBinding(identity, metadata, supervisorDigest);
    try {
      const existing = await fsp.lstat(lifecycle.supervisorPath);
      if (
        !existing.isFile() ||
        existing.isSymbolicLink() ||
        existing.uid !== 0 ||
        existing.nlink !== 1 ||
        (existing.mode & 0o022) !== 0
      ) {
        throw new Error("installed stable lifecycle supervisor is not a protected root file");
      }
      if ((await sha256(lifecycle.supervisorPath)) !== supervisorDigest) {
        previousSupervisor = {
          content: await fsp.readFile(lifecycle.supervisorPath),
          mode: existing.mode & 0o777,
          uid: existing.uid,
          gid: existing.gid,
        };
        await atomicCopyFileDurable(supervisorPath, lifecycle.supervisorPath, {
          mode: 0o755,
          uid: 0,
          gid: 0,
        });
        supervisorReplaced = true;
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      await atomicCopyFileDurable(supervisorPath, lifecycle.supervisorPath, {
        mode: 0o755,
        uid: 0,
        gid: 0,
      });
      supervisorReplaced = true;
    }
    const supervisorIdentityPath = path.join(
      lifecycle.supervisorStateDir,
      "controller-version.json",
    );
    const supervisorRollbackFloorPath = path.join(lifecycle.supervisorStateDir, "rollback-floor");
    await atomicWriteFileDurable(
      supervisorIdentityPath,
      `${JSON.stringify(identity, null, 2)}\n`,
      0o600,
    );
    let rollbackFloor = identity.version;
    for (const floorPath of [context.paths.rollbackFloorPath, supervisorRollbackFloorPath]) {
      try {
        const candidate = parseReleaseVersion(await fsp.readFile(floorPath, "utf8"));
        if (compareVersions(candidate, rollbackFloor) === 1) {
          rollbackFloor = candidate;
        }
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
      }
    }
    await atomicWriteFileDurable(supervisorRollbackFloorPath, `${rollbackFloor}\n`, 0o600);
    const operatorUid =
      configuration.profile === "hosting"
        ? hostingOperatorUid(configuration.socketGid)
        : configuration.socketUid;
    const args = [
      lifecycle.supervisorPath,
      "bootstrap-boundary",
      "--profile",
      configuration.profile,
    ];
    if (configuration.profile === "protected-local") {
      args.push("--protected-local-instance", configuration.instanceId);
    }
    args.push(
      "--operator-uid",
      String(operatorUid),
      "--operator-gid",
      String(configuration.socketGid),
    );
    const { stdout: bootstrapOutput } = await execFileAsync(process.execPath, args, {
      env: {
        HOME: lifecycle.supervisorStateDir,
        PATH: "/usr/local/bin:/usr/bin:/bin",
      },
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const result = JSON.parse(bootstrapOutput);
    if (
      result?.schemaVersion !== 1 ||
      result.profile !== configuration.profile ||
      result.instanceId !== (configuration.instanceId ?? null)
    ) {
      throw new Error("stable lifecycle supervisor bootstrap returned a mismatched receipt");
    }
    return true;
  } catch (error) {
    if (supervisorReplaced) {
      if (previousSupervisor) {
        await atomicWriteFileDurable(
          lifecycle.supervisorPath,
          previousSupervisor.content,
          previousSupervisor.mode,
        );
        await fsp.chown(lifecycle.supervisorPath, previousSupervisor.uid, previousSupervisor.gid);
        await fsp.chmod(lifecycle.supervisorPath, previousSupervisor.mode);
        const restoredHandle = await fsp.open(lifecycle.supervisorPath, "r");
        try {
          await restoredHandle.sync();
        } finally {
          await restoredHandle.close();
        }
        await fsyncDirectory(path.dirname(lifecycle.supervisorPath));
      } else {
        await fsp.rm(lifecycle.supervisorPath, { force: true });
        await fsyncDirectory(path.dirname(lifecycle.supervisorPath));
      }
    }
    throw error;
  } finally {
    await fsp.rm(downloadRoot, { recursive: true, force: true });
  }
}

function parseControllerIdentity(value, expectedVersion) {
  const version = parseReleaseVersion(value?.version);
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).toSorted().join(",") !== "clientSha256,schemaVersion,serverSha256,version" ||
    value.schemaVersion !== CONTROLLER_SELF_CHECK_SCHEMA_VERSION ||
    (expectedVersion && version !== expectedVersion) ||
    !/^[a-f0-9]{64}$/.test(value.serverSha256 || "") ||
    !/^[a-f0-9]{64}$/.test(value.clientSha256 || "")
  ) {
    throw new Error("host updater controller identity is malformed or mismatched");
  }
  return Object.freeze({
    schemaVersion: CONTROLLER_SELF_CHECK_SCHEMA_VERSION,
    version,
    serverSha256: value.serverSha256,
    clientSha256: value.clientSha256,
  });
}

async function readControllerIdentity(paths) {
  try {
    return parseControllerIdentity(
      JSON.parse(await fsp.readFile(paths.controllerVersionPath, "utf8")),
    );
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function readControllerGenerationDigests(generationRoot) {
  const generationStat = await fsp.lstat(generationRoot);
  if (!generationStat.isDirectory() || generationStat.isSymbolicLink()) {
    throw new Error("host updater controller generation must be a real directory");
  }
  const serverPath = path.join(generationRoot, CONTROLLER_SERVER_NAME);
  const clientPath = path.join(generationRoot, CONTROLLER_CLIENT_NAME);
  const [serverStat, clientStat] = await Promise.all([
    fsp.lstat(serverPath),
    fsp.lstat(clientPath),
  ]);
  if (
    !serverStat.isFile() ||
    serverStat.isSymbolicLink() ||
    !clientStat.isFile() ||
    clientStat.isSymbolicLink()
  ) {
    throw new Error("host updater controller generation must contain regular controller files");
  }
  const [serverSha256, clientSha256] = await Promise.all([sha256(serverPath), sha256(clientPath)]);
  return { serverSha256, clientSha256 };
}

async function currentControllerMatches(paths, identity) {
  try {
    const currentStat = await fsp.lstat(paths.controllerCurrentLink);
    if (!currentStat.isSymbolicLink()) {
      throw new Error("host updater controller current path must be a root-managed symlink");
    }
    const expectedRoot = path.resolve(paths.controllerReleasesDir, `v${identity.version}`);
    const actualRoot = await fsp.realpath(paths.controllerCurrentLink);
    if (actualRoot !== expectedRoot) {
      return false;
    }
    const digests = await readControllerGenerationDigests(actualRoot);
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

async function selfCheckControllerAsset(assetPath, role, stateDir) {
  const { stdout } = await execFileAsync(process.execPath, [assetPath, "--self-check"], {
    env: {
      HOME: stateDir,
      PATH: "/usr/local/bin:/usr/bin:/bin",
    },
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  const value = JSON.parse(stdout);
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).toSorted().join(",") !== "protocolVersion,role,schemaVersion" ||
    value.schemaVersion !== CONTROLLER_SELF_CHECK_SCHEMA_VERSION ||
    value.protocolVersion !== CONTROLLER_PROTOCOL_VERSION ||
    value.role !== role
  ) {
    throw new Error(`host updater ${role} controller self-check is incompatible`);
  }
}

async function atomicSymlinkDurable(target, linkPath) {
  await fsp.mkdir(path.dirname(linkPath), { recursive: true, mode: 0o755 });
  try {
    const existing = await fsp.lstat(linkPath);
    if (!existing.isSymbolicLink()) {
      throw new Error(`refusing to replace non-symlink controller path: ${linkPath}`);
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

async function stageOfficialControllerRelease(version, context) {
  const existingIdentity = await readControllerIdentity(context.paths);
  if (existingIdentity && compareVersions(existingIdentity.version, version) === 1) {
    throw new Error(
      `refusing host updater controller downgrade from ${existingIdentity.version} to ${version}`,
    );
  }
  if (
    existingIdentity?.version === version &&
    (await currentControllerMatches(context.paths, existingIdentity))
  ) {
    return { changed: false, identity: existingIdentity };
  }

  const releaseUrl = `${RELEASE_BASE}/v${version}`;
  await Promise.all([
    fsp.mkdir(context.paths.stateDir, { recursive: true, mode: 0o700 }),
    fsp.mkdir(context.paths.controllerReleasesDir, { recursive: true, mode: 0o755 }),
  ]);
  const downloadRoot = await fsp.mkdtemp(
    path.join(context.paths.stateDir, `.controller-download-${version}-`),
  );
  const generationRoot = path.join(context.paths.controllerReleasesDir, `v${version}`);
  let stagingGeneration = null;
  const serverPath = path.join(downloadRoot, CONTROLLER_SERVER_NAME);
  const clientPath = path.join(downloadRoot, CONTROLLER_CLIENT_NAME);
  const serverBundlePath = path.join(downloadRoot, CONTROLLER_SERVER_BUNDLE_NAME);
  const clientBundlePath = path.join(downloadRoot, CONTROLLER_CLIENT_BUNDLE_NAME);
  try {
    await Promise.all([
      context.downloadReleaseAsset(`${releaseUrl}/${CONTROLLER_SERVER_NAME}`, serverPath),
      context.downloadReleaseAsset(`${releaseUrl}/${CONTROLLER_CLIENT_NAME}`, clientPath),
      context.downloadReleaseAsset(
        `${releaseUrl}/${CONTROLLER_SERVER_BUNDLE_NAME}`,
        serverBundlePath,
      ),
      context.downloadReleaseAsset(
        `${releaseUrl}/${CONTROLLER_CLIENT_BUNDLE_NAME}`,
        clientBundlePath,
      ),
    ]);
    await Promise.all([
      context.verifyReleaseAsset(serverPath, version, context.paths.stateDir, serverBundlePath),
      context.verifyReleaseAsset(clientPath, version, context.paths.stateDir, clientBundlePath),
    ]);
    await Promise.all([
      context.selfCheckControllerAsset(serverPath, "server", context.paths.stateDir),
      context.selfCheckControllerAsset(clientPath, "client", context.paths.stateDir),
    ]);
    const identity = Object.freeze({
      schemaVersion: CONTROLLER_SELF_CHECK_SCHEMA_VERSION,
      version,
      serverSha256: await sha256(serverPath),
      clientSha256: await sha256(clientPath),
    });
    stagingGeneration = await fsp.mkdtemp(
      path.join(context.paths.controllerReleasesDir, `.controller-generation-${version}-`),
    );

    let previousGeneration = null;
    try {
      const currentStat = await fsp.lstat(context.paths.controllerCurrentLink);
      if (!currentStat.isSymbolicLink()) {
        throw new Error("host updater controller current path must be a root-managed symlink");
      }
      previousGeneration = await fsp.realpath(context.paths.controllerCurrentLink);
      const releasesRoot = path.resolve(context.paths.controllerReleasesDir);
      if (
        path.dirname(previousGeneration) !== releasesRoot ||
        !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(path.basename(previousGeneration))
      ) {
        throw new Error("host updater controller current symlink escapes the releases directory");
      }
      await readControllerGenerationDigests(previousGeneration);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }

    try {
      const generationIdentity = await readControllerGenerationDigests(generationRoot);
      if (
        generationIdentity.serverSha256 !== identity.serverSha256 ||
        generationIdentity.clientSha256 !== identity.clientSha256
      ) {
        throw new Error(`host updater controller generation v${version} is not immutable`);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      await Promise.all([
        atomicCopyFileDurable(serverPath, path.join(stagingGeneration, CONTROLLER_SERVER_NAME), {
          mode: 0o755,
        }),
        atomicCopyFileDurable(clientPath, path.join(stagingGeneration, CONTROLLER_CLIENT_NAME), {
          mode: 0o755,
        }),
      ]);
      await fsp.chmod(stagingGeneration, 0o755);
      await fsyncDirectory(stagingGeneration);
      await fsp.rename(stagingGeneration, generationRoot);
      await fsyncDirectory(context.paths.controllerReleasesDir);
    }

    await atomicSymlinkDurable(generationRoot, context.paths.controllerCurrentLink);
    await atomicWriteFileDurable(
      context.paths.controllerVersionPath,
      `${JSON.stringify(identity, null, 2)}\n`,
      0o600,
    );
    context.controllerRestartRequired = previousGeneration !== generationRoot;

    const keep = new Set([generationRoot, previousGeneration].filter(Boolean));
    for (const entry of await fsp.readdir(context.paths.controllerReleasesDir, {
      withFileTypes: true,
    })) {
      const candidate = path.join(context.paths.controllerReleasesDir, entry.name);
      if (entry.isDirectory() && /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(entry.name)) {
        if (!keep.has(candidate)) {
          await fsp.rm(candidate, { recursive: true, force: true });
        }
      }
    }
    await fsyncDirectory(context.paths.controllerReleasesDir);
    return { changed: context.controllerRestartRequired, identity };
  } finally {
    await Promise.all([
      fsp.rm(downloadRoot, { recursive: true, force: true }),
      stagingGeneration
        ? fsp.rm(stagingGeneration, { recursive: true, force: true })
        : Promise.resolve(),
    ]);
  }
}

async function readVersionFile(filePath) {
  try {
    return parseReleaseVersion(await fsp.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

function releaseAllowedForChannel(version, channel) {
  return !version.includes("-") || channel.trim() === "beta";
}

function parseSignerReleaseIdentity(value, expectedVersion) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("signer release identity is missing");
  }
  const keys = Object.keys(value).toSorted();
  if (keys.join(",") !== "buildInputDigest,commit,development,version") {
    throw new Error("signer release identity contains unsupported fields");
  }
  const version = parseReleaseVersion(value.version);
  if (
    (expectedVersion && version !== expectedVersion) ||
    !/^[a-f0-9]{40}$/.test(value.commit || "") ||
    !/^sha256:[a-f0-9]{64}$/.test(value.buildInputDigest || "") ||
    value.development !== false
  ) {
    throw new Error("signer release identity is development, malformed, or mismatched");
  }
  return Object.freeze({
    version,
    commit: value.commit,
    buildInputDigest: value.buildInputDigest,
    development: false,
  });
}

function canonicalJSON(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJSON(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function exactObjectKeys(value, expected, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).toSorted().join(",") !==
      [...expected].toSorted((left, right) => left.localeCompare(right)).join(",")
  ) {
    throw new Error(`${label} is invalid`);
  }
}

function parseMigrationProtocolRange(value) {
  exactObjectKeys(value, ["current", "min", "max"], "installed signer protocol capability");
  if (
    !Number.isSafeInteger(value.current) ||
    !Number.isSafeInteger(value.min) ||
    !Number.isSafeInteger(value.max) ||
    value.min < 1 ||
    value.min > value.current ||
    value.current > value.max
  ) {
    throw new Error("installed signer protocol capability is invalid");
  }
  return Object.freeze({ current: value.current, min: value.min, max: value.max });
}

function parseMigrationStateSchemas(value) {
  exactObjectKeys(
    value,
    ["managedInstall", "walletRegistry", "signer", "mining", "federation"],
    "installed lifecycle state schemas",
  );
  if (
    !SUPPORTED_MANAGED_INSTALL_SCHEMAS.has(value.managedInstall) ||
    !SUPPORTED_WALLET_REGISTRY_SCHEMAS.has(value.walletRegistry) ||
    value.signer !== 2 ||
    value.mining !== 1 ||
    value.federation !== 2
  ) {
    throw new Error("installed lifecycle state schemas are unsupported");
  }
  return Object.freeze({
    managedInstall: value.managedInstall ?? null,
    walletRegistry: value.walletRegistry ?? null,
    signer: value.signer,
    mining: value.mining,
    federation: value.federation,
  });
}

function lifecycleCompatibilityAdapter(component, selector) {
  const catalog = LIFECYCLE_COMPATIBILITY_ADAPTERS[component];
  const adapter = catalog?.[selector];
  if (!adapter) {
    throw new Error(`installed lifecycle ${component} compatibility adapter is unsupported`);
  }
  return adapter;
}

function lifecycleSchemaSelector(value) {
  return value === null ? "absent" : `schema:${value}`;
}

function lifecycleMigrationInventory(topology, updaterProtocol = PROTOCOL_SCHEMA_VERSION) {
  if (
    !topology ||
    typeof topology !== "object" ||
    Array.isArray(topology) ||
    topology.pendingGatewayUnit ||
    topology.pendingStateDir ||
    !SUPPORTED_MIGRATION_PROFILES.has(topology.profile) ||
    typeof topology.managedApplication !== "boolean" ||
    !Number.isSafeInteger(updaterProtocol) ||
    updaterProtocol < 1
  ) {
    throw new Error("installed lifecycle topology is incomplete or unsupported");
  }
  exactObjectKeys(
    topology.capabilities,
    ["lifecycleControllerProtocol", "signerProtocol", "declaredStateRegistry"],
    "installed lifecycle capabilities",
  );
  const signerProtocol = parseMigrationProtocolRange(topology.capabilities.signerProtocol);
  const stateSchemas = parseMigrationStateSchemas(topology.stateSchemas);
  if (
    topology.capabilities.lifecycleControllerProtocol !== CONTROLLER_PROTOCOL_VERSION ||
    topology.capabilities.declaredStateRegistry !== DECLARED_STATE_SCHEMA_VERSION ||
    signerProtocol.current !== 2 ||
    updaterProtocol !== PROTOCOL_SCHEMA_VERSION ||
    (topology.profile === "protected-local" && topology.managedApplication !== true) ||
    (topology.managedApplication === false && stateSchemas.managedInstall !== null)
  ) {
    throw new Error("installed lifecycle topology has no supported migration path");
  }
  return Object.freeze({
    schemaVersion: MIGRATION_SELECTION_SCHEMA_VERSION,
    profile: topology.profile,
    platformAdapter: "linux-systemd",
    serviceTopology:
      topology.profile === "protected-local" ? "protected-local-system-v1" : "hosting-system-v1",
    managedApplication: topology.managedApplication,
    updaterProtocol,
    controllerProtocol: topology.capabilities.lifecycleControllerProtocol,
    signerProtocol,
    declaredStateRegistry: topology.capabilities.declaredStateRegistry,
    stateSchemas,
    interruptedTransaction: "none",
  });
}

function migrationSelectionFromInventory(inventory) {
  exactObjectKeys(
    inventory,
    [
      "schemaVersion",
      "profile",
      "platformAdapter",
      "serviceTopology",
      "managedApplication",
      "updaterProtocol",
      "controllerProtocol",
      "signerProtocol",
      "declaredStateRegistry",
      "stateSchemas",
      "interruptedTransaction",
    ],
    "installed lifecycle migration inventory",
  );
  const normalized = lifecycleMigrationInventory(
    {
      profile: inventory.profile,
      managedApplication: inventory.managedApplication,
      capabilities: {
        lifecycleControllerProtocol: inventory.controllerProtocol,
        signerProtocol: inventory.signerProtocol,
        declaredStateRegistry: inventory.declaredStateRegistry,
      },
      stateSchemas: inventory.stateSchemas,
    },
    inventory.updaterProtocol,
  );
  if (
    inventory.schemaVersion !== MIGRATION_SELECTION_SCHEMA_VERSION ||
    inventory.platformAdapter !== normalized.platformAdapter ||
    inventory.serviceTopology !== normalized.serviceTopology ||
    inventory.interruptedTransaction !== "none"
  ) {
    throw new Error("installed lifecycle migration inventory is unsupported");
  }
  const adapters = Object.freeze({
    application: lifecycleCompatibilityAdapter(
      "application",
      lifecycleSchemaSelector(normalized.stateSchemas.managedInstall),
    ),
    controller: lifecycleCompatibilityAdapter(
      "controller",
      `protocol:${normalized.controllerProtocol}`,
    ),
    signer: lifecycleCompatibilityAdapter(
      "signer",
      lifecycleSchemaSelector(normalized.stateSchemas.signer),
    ),
    wallet: lifecycleCompatibilityAdapter(
      "wallet",
      lifecycleSchemaSelector(normalized.stateSchemas.walletRegistry),
    ),
    mining: lifecycleCompatibilityAdapter(
      "mining",
      lifecycleSchemaSelector(normalized.stateSchemas.mining),
    ),
    federation: lifecycleCompatibilityAdapter(
      "federation",
      lifecycleSchemaSelector(normalized.stateSchemas.federation),
    ),
    sharedState: lifecycleCompatibilityAdapter(
      "sharedState",
      lifecycleSchemaSelector(normalized.declaredStateRegistry),
    ),
    profileAccess: lifecycleCompatibilityAdapter(
      "profileAccess",
      `${normalized.profile}:${normalized.platformAdapter}`,
    ),
  });
  const unsigned = Object.freeze({
    schemaVersion: MIGRATION_SELECTION_SCHEMA_VERSION,
    inventory: normalized,
    adapters,
  });
  return Object.freeze({
    ...unsigned,
    selectionDigest: `sha256:${createHash("sha256").update(canonicalJSON(unsigned)).digest("hex")}`,
  });
}

function selectLifecycleMigration(topology, updaterProtocol = PROTOCOL_SCHEMA_VERSION) {
  return migrationSelectionFromInventory(lifecycleMigrationInventory(topology, updaterProtocol));
}

function validateLifecycleMigrationSelection(value) {
  if (value == null) {
    return null;
  }
  exactObjectKeys(
    value,
    ["schemaVersion", "inventory", "adapters", "selectionDigest"],
    "lifecycle migration selection",
  );
  const expected = migrationSelectionFromInventory(value.inventory);
  if (canonicalJSON(value) !== canonicalJSON(expected)) {
    throw new Error("lifecycle migration selection is invalid");
  }
  return expected;
}

function assertSameMigrationSelection(previous, next) {
  if (
    previous &&
    (previous.selectionDigest !== next.selectionDigest ||
      canonicalJSON(previous) !== canonicalJSON(next))
  ) {
    throw new Error("installed lifecycle topology changed after migration selection");
  }
  return next;
}

function lifecycleMigrationReceipt(selection) {
  if (!selection) {
    return null;
  }
  return Object.freeze({
    schemaVersion: MIGRATION_SELECTION_SCHEMA_VERSION,
    profile: selection.inventory.profile,
    serviceTopology: selection.inventory.serviceTopology,
    selectionDigest: selection.selectionDigest,
    adapters: selection.adapters,
  });
}

function schemaMigrationInput(selection, component) {
  switch (component) {
    case "application":
      return selection.inventory.stateSchemas.managedInstall;
    case "signer":
      return selection.inventory.stateSchemas.signer;
    case "wallet":
      return selection.inventory.stateSchemas.walletRegistry;
    case "mining":
      return selection.inventory.stateSchemas.mining;
    case "federation":
      return selection.inventory.stateSchemas.federation;
    case "sharedState":
      return selection.inventory.declaredStateRegistry;
    default:
      throw new Error(`lifecycle schema migration component ${component} is unsupported`);
  }
}

function schemaMigrationApplicable(selection, component, input) {
  if (component === "application") {
    return selection.inventory.managedApplication;
  }
  if (component === "wallet" && input === null) {
    return false;
  }
  return true;
}

function lifecycleSchemaMigrationPlan(selection) {
  const normalized = validateLifecycleMigrationSelection(selection);
  if (!normalized) {
    return null;
  }
  const steps = SCHEMA_MIGRATION_COMPONENTS.map((component, index) => {
    const adapter = normalized.adapters[component];
    const definition = LIFECYCLE_SCHEMA_MIGRATIONS[adapter];
    const fromSchema = schemaMigrationInput(normalized, component);
    if (!definition || definition.component !== component || definition.fromSchema !== fromSchema) {
      throw new Error(`selected lifecycle schema adapter ${adapter || "unknown"} is unsupported`);
    }
    return Object.freeze({
      order: index + 1,
      component,
      stateClass: definition.stateClass,
      schemaOwner: definition.schemaOwner,
      adapter,
      fromSchema,
      toSchema: definition.toSchema,
      mode: definition.mode,
      applicable: schemaMigrationApplicable(normalized, component, fromSchema),
    });
  });
  const identity = Object.freeze({
    schemaVersion: SCHEMA_MIGRATION_SCHEMA_VERSION,
    selectionDigest: normalized.selectionDigest,
    steps,
  });
  return Object.freeze({
    ...identity,
    planDigest: `sha256:${createHash("sha256").update(canonicalJSON(identity)).digest("hex")}`,
    preparedAdapters: Object.freeze([]),
    appliedAdapters: Object.freeze([]),
  });
}

function orderedSchemaAdapterSubset(value, steps, label) {
  if (!Array.isArray(value) || new Set(value).size !== value.length) {
    throw new Error(`lifecycle schema migration ${label} is invalid`);
  }
  const positions = new Map(steps.map((step, index) => [step.adapter, index]));
  let previous = -1;
  for (const adapter of value) {
    const position = positions.get(adapter);
    if (position == null || position <= previous) {
      throw new Error(`lifecycle schema migration ${label} is invalid`);
    }
    previous = position;
  }
  return Object.freeze([...value]);
}

function validateLifecycleSchemaMigration(value, selection) {
  const expected = lifecycleSchemaMigrationPlan(selection);
  if (!expected) {
    if (value != null) {
      throw new Error("lifecycle schema migration exists without a migration selection");
    }
    return null;
  }
  exactObjectKeys(
    value,
    [
      "schemaVersion",
      "selectionDigest",
      "steps",
      "planDigest",
      "preparedAdapters",
      "appliedAdapters",
    ],
    "lifecycle schema migration",
  );
  if (
    value.schemaVersion !== SCHEMA_MIGRATION_SCHEMA_VERSION ||
    value.selectionDigest !== expected.selectionDigest ||
    value.planDigest !== expected.planDigest ||
    canonicalJSON(value.steps) !== canonicalJSON(expected.steps)
  ) {
    throw new Error("lifecycle schema migration plan is invalid");
  }
  const preparedAdapters = orderedSchemaAdapterSubset(
    value.preparedAdapters,
    expected.steps,
    "prepared adapters",
  );
  const appliedAdapters = orderedSchemaAdapterSubset(
    value.appliedAdapters,
    expected.steps,
    "applied adapters",
  );
  const prepared = new Set(preparedAdapters);
  if (appliedAdapters.some((adapter) => !prepared.has(adapter))) {
    throw new Error("lifecycle schema migration applied an unprepared adapter");
  }
  return Object.freeze({
    schemaVersion: SCHEMA_MIGRATION_SCHEMA_VERSION,
    selectionDigest: expected.selectionDigest,
    steps: expected.steps,
    planDigest: expected.planDigest,
    preparedAdapters,
    appliedAdapters,
  });
}

function stagedLifecycleSchemaMigration(value, selection) {
  const migration = validateLifecycleSchemaMigration(value, selection);
  if (!migration) {
    throw new Error("lifecycle schema migration plan is unavailable");
  }
  const preparedAdapters = migration.steps.map((step) => step.adapter);
  const appliedAdapters = migration.steps
    .filter(
      (step) =>
        !step.applicable ||
        (step.mode !== "initialize-on-activation" && step.mode !== "migrate-on-activation"),
    )
    .map((step) => step.adapter);
  return validateLifecycleSchemaMigration(
    {
      ...migration,
      preparedAdapters,
      appliedAdapters,
    },
    selection,
  );
}

function completedLifecycleSchemaMigration(value, selection) {
  const migration = validateLifecycleSchemaMigration(value, selection);
  if (!migration) {
    throw new Error("lifecycle schema migration plan is unavailable");
  }
  const adapters = migration.steps.map((step) => step.adapter);
  return validateLifecycleSchemaMigration(
    {
      ...migration,
      preparedAdapters: adapters,
      appliedAdapters: adapters,
    },
    selection,
  );
}

function legacyLifecycleSchemaMigration(selection, phase, rollbackFromPhase) {
  const planned = lifecycleSchemaMigrationPlan(selection);
  if (!planned) {
    return null;
  }
  const effectivePhase =
    phase === "rolling-back" || phase === "restored" ? rollbackFromPhase || "prepared" : phase;
  if (effectivePhase === "prepared" || effectivePhase === "state-reconciling") {
    return planned;
  }
  const staged = stagedLifecycleSchemaMigration(planned, selection);
  if (effectivePhase === "gateway-verified" || effectivePhase === "committing") {
    return completedLifecycleSchemaMigration(staged, selection);
  }
  return staged;
}

function lifecycleSchemaMigrationReceipt(value, selection) {
  if (!value || !selection) {
    return null;
  }
  const migration = validateLifecycleSchemaMigration(value, selection);
  return Object.freeze({
    schemaVersion: SCHEMA_MIGRATION_SCHEMA_VERSION,
    selectionDigest: migration.selectionDigest,
    planDigest: migration.planDigest,
    applied: migration.appliedAdapters.length === migration.steps.length,
    steps: migration.steps.map((step) =>
      Object.freeze({
        order: step.order,
        stateClass: step.stateClass,
        schemaOwner: step.schemaOwner,
        adapter: step.adapter,
        fromSchema: step.fromSchema,
        toSchema: step.toSchema,
        applicable: step.applicable,
      }),
    ),
  });
}

function parseUnifiedHostedSignerRelease(value, expectedVersion, platform) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).toSorted().join(",") !== "application,release,schemaVersion,signer" ||
    value.schemaVersion !== 2
  ) {
    throw new Error("attested unified hosted release manifest schema is invalid");
  }
  const release = value.release;
  if (
    !release ||
    Object.keys(release).toSorted().join(",") !== "commit,tag,version" ||
    release.version !== expectedVersion ||
    release.tag !== `v${expectedVersion}` ||
    !/^[a-f0-9]{40}$/.test(release.commit || "")
  ) {
    throw new Error("attested unified hosted release identity is malformed or mismatched");
  }
  const signer = value.signer;
  if (
    !signer ||
    Object.keys(signer).toSorted().join(",") !==
      "capabilities,capabilitiesDigest,platforms,release" ||
    !/^sha256:[a-f0-9]{64}$/.test(signer.capabilitiesDigest || "") ||
    `sha256:${createHash("sha256").update(canonicalJSON(signer.capabilities)).digest("hex")}` !==
      signer.capabilitiesDigest ||
    signer.capabilities?.protocol?.current !== 2 ||
    signer.capabilities?.protocol?.min !== 2 ||
    signer.capabilities?.protocol?.max !== 2
  ) {
    throw new Error("attested unified signer capability contract is invalid");
  }
  const signerRelease = parseSignerReleaseIdentity(signer.release, expectedVersion);
  if (signerRelease.commit !== release.commit) {
    throw new Error("attested hosted app and signer commits do not match");
  }
  const artifact = signer.platforms?.[platform];
  if (
    !artifact ||
    Object.keys(artifact).toSorted().join(",") !== "asset,sha256" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]+$/.test(artifact.asset || "") ||
    !/^[a-f0-9]{64}$/.test(artifact.sha256 || "")
  ) {
    throw new Error(`attested unified signer release has no valid ${platform} artifact`);
  }
  const applicationArchitecture = platform === "linux-amd64" ? "x64" : "arm64";
  const application = value.application;
  const applicationEntry = application?.linux?.[applicationArchitecture];
  if (
    !application ||
    Object.keys(application).toSorted().join(",") !== "linux" ||
    Object.keys(application.linux ?? {})
      .toSorted()
      .join(",") !== "arm64,x64" ||
    !applicationEntry ||
    Object.keys(applicationEntry).toSorted().join(",") !== "artifact,dependencies" ||
    Object.keys(applicationEntry.artifact ?? {})
      .toSorted()
      .join(",") !== "asset,sha256" ||
    Object.keys(applicationEntry.dependencies ?? {})
      .toSorted()
      .join(",") !== "asset,dependencyHash,sha256" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]+$/.test(applicationEntry.artifact.asset || "") ||
    !/^[a-f0-9]{64}$/.test(applicationEntry.artifact.sha256 || "") ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]+$/.test(applicationEntry.dependencies.asset || "") ||
    !/^[a-f0-9]{64}$/.test(applicationEntry.dependencies.sha256 || "") ||
    !/^[a-f0-9]{64}$/.test(applicationEntry.dependencies.dependencyHash || "")
  ) {
    throw new Error(
      `attested unified application release has no valid ${applicationArchitecture} artifact`,
    );
  }
  return {
    release: signerRelease,
    artifact,
    application: applicationEntry,
    capabilities: signer.capabilities,
    binding: {
      releaseCommit: release.commit,
      capabilitiesDigest: signer.capabilitiesDigest,
    },
  };
}

function signerReleaseIdentitiesEqual(left, right) {
  return (
    left?.version === right?.version &&
    left?.commit === right?.commit &&
    left?.buildInputDigest === right?.buildInputDigest &&
    left?.development === false &&
    right?.development === false
  );
}

function signerStateInvariantFromHealth(result) {
  const policies = result?.policies;
  const networks = result?.network?.wallets;
  const webAuthn = result?.webAuthn;
  if (
    !Array.isArray(policies) ||
    !policies.every(
      (policy) =>
        typeof policy?.walletId === "string" &&
        typeof policy?.role === "string" &&
        Number.isSafeInteger(policy?.version) &&
        policy.version > 0 &&
        /^sha256:[a-f0-9]{64}$/.test(policy?.hash || ""),
    ) ||
    typeof result?.network?.ready !== "boolean" ||
    !Array.isArray(networks) ||
    !networks.every(
      (network) =>
        typeof network?.walletId === "string" &&
        typeof network?.configured === "boolean" &&
        Number.isSafeInteger(network?.version) &&
        network.version >= 0 &&
        typeof network?.ready === "boolean" &&
        (!network.configured || /^hmac-sha256:[a-f0-9]{64}$/.test(network?.hash || "")),
    ) ||
    typeof webAuthn?.configured !== "boolean" ||
    !Number.isSafeInteger(webAuthn?.credentialCount) ||
    webAuthn.credentialCount < 0 ||
    !Number.isSafeInteger(webAuthn?.credentialVersion) ||
    webAuthn.credentialVersion < 0 ||
    typeof webAuthn?.ready !== "boolean"
  ) {
    throw new Error("signer health state invariants are malformed");
  }
  return canonicalJSON({
    policies: [...policies].toSorted((left, right) => left.walletId.localeCompare(right.walletId)),
    network: {
      ready: result.network.ready,
      wallets: [...networks].toSorted((left, right) => left.walletId.localeCompare(right.walletId)),
    },
    webAuthn: {
      configured: webAuthn.configured,
      rpId: webAuthn.rpId || "",
      origins: [...(Array.isArray(webAuthn.origins) ? webAuthn.origins : [])].toSorted(
        (left, right) => String(left).localeCompare(String(right)),
      ),
      credentialCount: webAuthn.credentialCount,
      credentialVersion: webAuthn.credentialVersion,
      ready: webAuthn.ready,
    },
  });
}

async function assertReleaseChannelAllowed(version, channelPath) {
  let channel = "stable";
  try {
    const stat = await fsp.lstat(channelPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
      throw new Error(
        "host updater channel file must be root-owned and not writable by group/others",
      );
    }
    channel = await fsp.readFile(channelPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  if (!releaseAllowedForChannel(version, channel)) {
    throw new Error(
      "prerelease signer updates require root to set /etc/fased/host-updater-channel to beta",
    );
  }
}

function assertSignerV2Health(response, expectedRelease) {
  const protocol = response?.result?.capabilities?.protocol;
  if (
    response?.ok !== true ||
    response?.result?.ready !== true ||
    response?.result?.keystoreType !== "signer-owned-v2" ||
    protocol?.current !== 2 ||
    protocol?.min > 2 ||
    protocol?.max < 2 ||
    !Array.isArray(response?.result?.policies)
  ) {
    throw new Error("signer health did not acknowledge protocol v2 and signer-owned custody");
  }
  const release = parseSignerReleaseIdentity(response.result.release, expectedRelease?.version);
  if (expectedRelease && !signerReleaseIdentitiesEqual(release, expectedRelease)) {
    throw new Error("signer health release identity does not match the attested release manifest");
  }
  signerStateInvariantFromHealth(response.result);
  return release;
}

async function readSignerV2Health(socketPath = "/run/fased-signerd/app.sock") {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    socket.setEncoding("utf8");
    socket.setTimeout(3000);
    let body = "";
    socket.once("connect", () => socket.write(`${JSON.stringify({ op: "health" })}\n`));
    socket.on("data", (chunk) => {
      body += chunk;
      const newline = body.indexOf("\n");
      if (newline < 0) {
        return;
      }
      socket.destroy();
      try {
        resolve(JSON.parse(body.slice(0, newline)));
      } catch {
        reject(new Error("signer health response is invalid"));
      }
    });
    socket.once("timeout", () => reject(new Error("signer health probe timed out")));
    socket.once("error", reject);
  });
}

export async function probeSignerV2(expectedRelease, socketPath) {
  const response = await readSignerV2Health(socketPath);
  return assertSignerV2Health(response, expectedRelease);
}

async function probeSignerStateV2(expectedRelease, socketPath) {
  const response = await readSignerV2Health(socketPath);
  const release = assertSignerV2Health(response, expectedRelease);
  return { release, invariant: signerStateInvariantFromHealth(response.result) };
}

async function systemctl(...args) {
  const binary = await fixedExecutable(["/usr/bin/systemctl", "/bin/systemctl"], "systemctl");
  return await execFileAsync(binary, args, {
    env: { PATH: "/usr/bin:/bin" },
    timeout: 60_000,
  });
}

async function stopSignerService(serviceName = "fased-signerd.service") {
  await systemctl("stop", serviceName);
}

async function startSignerService({
  requireV2,
  expectedRelease,
  serviceName = "fased-signerd.service",
  socketPath = "/run/fased-signerd/app.sock",
}) {
  await systemctl("start", serviceName);
  await systemctl("is-active", "--quiet", serviceName);
  if (!requireV2) {
    return;
  }
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      return await probeSignerStateV2(expectedRelease, socketPath);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`signer protocol v2 readiness failed: ${lastError?.message || "unknown error"}`);
}

function transactionPaths(paths, transactionId) {
  const transactionDir = path.join(paths.transactionsDir, transactionId);
  return {
    transactionDir,
    candidatePath: path.join(
      path.dirname(paths.signerPath),
      `.fased-signerd.candidate-${transactionId}`,
    ),
    previousBinaryPath: path.join(transactionDir, "fased-signerd.previous"),
    stateDBSnapshotPath: path.join(transactionDir, "state.db.previous"),
    masterKeySnapshotPath: path.join(transactionDir, "master.key.previous"),
    auditLogSnapshotPath: path.join(transactionDir, "audit.jsonl.previous"),
    signerUnitSnapshotPath: path.join(transactionDir, "fased-signerd.service.previous"),
    configSnapshotPath: path.join(transactionDir, "fased.json.previous"),
  };
}

const PROTECTED_SERVICE_FILE_MAX_BYTES = 512 * 1024;

function validateProtectedServiceFileCapture(value, label, expectedRootUid) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).toSorted().join(",") !== "contentBase64,gid,mode,sha256,uid" ||
    typeof value.contentBase64 !== "string" ||
    value.contentBase64.length > PROTECTED_SERVICE_FILE_MAX_BYTES * 2 ||
    !Number.isSafeInteger(value.uid) ||
    value.uid !== expectedRootUid ||
    !Number.isSafeInteger(value.gid) ||
    value.gid < 0 ||
    !Number.isSafeInteger(value.mode) ||
    (value.mode & 0o022) !== 0 ||
    (value.mode & ~0o777) !== 0 ||
    !/^[a-f0-9]{64}$/u.test(value.sha256 || "")
  ) {
    throw new Error(`host updater ${label} snapshot is invalid`);
  }
  const content = Buffer.from(value.contentBase64, "base64");
  if (
    content.length === 0 ||
    content.length > PROTECTED_SERVICE_FILE_MAX_BYTES ||
    createHash("sha256").update(content).digest("hex") !== value.sha256
  ) {
    throw new Error(`host updater ${label} snapshot content is invalid`);
  }
  return Object.freeze({ ...value });
}

function managedGatewayServicePaths(context) {
  const explicitUnitPath = context.paths.gatewayUnitPath ?? null;
  const explicitLauncherPath = context.paths.gatewayLauncherPath ?? null;
  const deriveHostingPaths = context.applicationState?.profile === "hosting";
  const unitPath =
    explicitUnitPath ??
    (deriveHostingPaths ? (context.applicationTopology?.gateway?.unitPath ?? null) : null);
  const launcherPath =
    explicitLauncherPath ??
    (deriveHostingPaths
      ? (context.applicationState?.gatewayLauncherPath ??
        context.applicationTopology?.gatewayLauncherPath ??
        null)
      : null);
  if (unitPath === null && launcherPath === null) {
    return null;
  }
  if (!path.isAbsolute(unitPath ?? "") || !path.isAbsolute(launcherPath ?? "")) {
    throw new Error("root-managed Gateway service paths are incomplete");
  }
  return Object.freeze({ unitPath, launcherPath });
}

function validateProtectedServiceBoundary(value, context) {
  const servicePaths = managedGatewayServicePaths(context);
  if (!servicePaths) {
    if (value != null) {
      throw new Error("host updater received a service transaction without a managed Gateway");
    }
    return null;
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).toSorted().join(",") !== "changed,gatewayLauncher,gatewayUnit" ||
    typeof value.changed !== "boolean"
  ) {
    throw new Error("host updater protected service transaction is invalid");
  }
  if (!value.changed) {
    if (value.gatewayUnit !== null || value.gatewayLauncher !== null) {
      throw new Error("host updater unchanged protected service transaction has snapshots");
    }
    return Object.freeze({
      changed: false,
      gatewayUnit: null,
      gatewayLauncher: null,
    });
  }
  return Object.freeze({
    changed: true,
    gatewayUnit: validateProtectedServiceFileCapture(
      value.gatewayUnit,
      "Gateway unit",
      context.rootUid,
    ),
    gatewayLauncher: validateProtectedServiceFileCapture(
      value.gatewayLauncher,
      "Gateway launcher",
      context.rootUid,
    ),
  });
}

async function captureProtectedServiceFile(filePath, label, expectedRootUid) {
  const info = await fsp.lstat(filePath);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.uid !== expectedRootUid ||
    (info.mode & 0o022) !== 0 ||
    info.size <= 0 ||
    info.size > PROTECTED_SERVICE_FILE_MAX_BYTES
  ) {
    throw new Error(`${label} must be a bounded root-owned non-writable regular file`);
  }
  const content = await fsp.readFile(filePath);
  return Object.freeze({
    contentBase64: content.toString("base64"),
    uid: info.uid,
    gid: info.gid,
    mode: info.mode & 0o777,
    sha256: createHash("sha256").update(content).digest("hex"),
  });
}

function replaceExactlyOneLine(content, pattern, replacement, label) {
  const matches = content.match(pattern);
  if (!matches || matches.length !== 1) {
    throw new Error(`protected Local ${label} is missing or ambiguous`);
  }
  return content.replace(pattern, replacement);
}

function upsertSystemdEnvironment(content, key, value) {
  const pattern = new RegExp(`^Environment=${key}=.*$`, "gmu");
  const matches = content.match(pattern) || [];
  if (matches.length > 1) {
    throw new Error(`root-managed Gateway unit has duplicate ${key} entries`);
  }
  if (matches.length === 1) {
    return content.replace(pattern, `Environment=${key}=${value}`);
  }
  const anchor = /^Environment=FASED_STATE_DIR=.*$/mu;
  if (anchor.test(content)) {
    return content.replace(anchor, (line) => `${line}\nEnvironment=${key}=${value}`);
  }
  const service = /^\[Service\]$/gmu;
  const serviceMatches = content.match(service) || [];
  if (serviceMatches.length !== 1) {
    throw new Error("root-managed Gateway unit has no unambiguous Service section");
  }
  return content.replace(service, (line) => `${line}\nEnvironment=${key}=${value}`);
}

function shellSingleQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function renderProtectedGatewayLauncher({
  applicationRoot,
  nodeBinary,
  stateDir,
  gatewayPort,
  profile = "protected-local",
}) {
  const application = shellSingleQuote(applicationRoot);
  const node = shellSingleQuote(nodeBinary);
  const config = shellSingleQuote(path.join(stateDir, "fased.json"));
  const port = String(gatewayPort);
  const label = profile === "hosting" ? "Hosting" : "protected Local";
  return `#!/usr/bin/env bash
set -euo pipefail
[[ -s ${config} ]] || {
  echo "${label} Gateway configuration is unavailable" >&2
  exit 78
}
gateway_entry=""
for candidate in \\
  ${application}/dist/entry.js \\
  ${application}/dist/entry.mjs \\
  ${application}/dist/index.js \\
  ${application}/dist/index.mjs; do
  if [[ -f "$candidate" && ! -L "$candidate" ]]; then
    gateway_entry="$candidate"
    break
  fi
done
[[ -n "$gateway_entry" ]] || {
  echo "${label} Gateway entrypoint is unavailable" >&2
  exit 78
}
runtime_version="$(${node} -e '
  const fs = require("node:fs");
  const path = require("node:path");
  const root = process.argv[1];
  const packageVersion = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  const buildVersion = JSON.parse(fs.readFileSync(path.join(root, "dist", "build-info.json"), "utf8")).version;
  if (typeof packageVersion !== "string" || !packageVersion.trim() || packageVersion !== buildVersion) {
    process.exit(1);
  }
  process.stdout.write(packageVersion.trim());
' ${application})" || {
  echo "${label} Gateway release identity is unavailable or inconsistent" >&2
  exit 78
}
export FASED_VERSION="$runtime_version"
export FASED_HOST_PROFILE=${shellSingleQuote(profile)}
exec ${node} \\
  --disable-warning=ExperimentalWarning \\
  --disable-warning=DEP0040 \\
  "$gateway_entry" gateway --allow-unconfigured --force --bind loopback --port ${shellSingleQuote(port)}
`;
}

function protectedServiceDesiredContent(context, boundary) {
  const servicePaths = managedGatewayServicePaths(context);
  if (!servicePaths) {
    throw new Error("root-managed Gateway service paths are unavailable");
  }
  const applicationRoot = context.paths.applicationCurrentLink;
  const nodeBinary = fs.realpathSync(context.protectedNodeBinary);
  const nodeInfo = fs.lstatSync(nodeBinary);
  if (
    !nodeInfo.isFile() ||
    nodeInfo.isSymbolicLink() ||
    nodeInfo.uid !== context.rootUid ||
    (nodeInfo.mode & 0o022) !== 0 ||
    (nodeInfo.mode & 0o111) === 0
  ) {
    throw new Error("root-managed controller Node.js runtime is not root-controlled");
  }
  let gatewayUnit = Buffer.from(boundary.gatewayUnit.contentBase64, "base64").toString("utf8");
  const profile =
    context.applicationState?.profile ??
    (context.instanceId ? "protected-local" : context.applicationTopology?.profile);
  if (profile === "protected-local") {
    if (
      !gatewayUnit.includes(`Environment=FASED_PROTECTED_LOCAL_INSTANCE=${context.instanceId}`) ||
      !gatewayUnit.includes(`User=fsgw-${context.instanceId}`) ||
      !gatewayUnit.includes("ProtectSystem=strict")
    ) {
      throw new Error("protected Local Gateway unit identity or hardening is invalid");
    }
  } else if (profile === "hosting") {
    const gatewayUser = context.applicationTopology?.gateway?.user;
    if (
      !gatewayUser ||
      !gatewayUnit.includes(`User=${gatewayUser}`) ||
      !gatewayUnit.includes("Environment=FASED_HOST_PROFILE=hosting") ||
      !gatewayUnit.includes(`ExecStart=${servicePaths.launcherPath}`) ||
      !gatewayUnit.includes("ProtectSystem=strict")
    ) {
      throw new Error("Hosting Gateway unit identity or hardening is invalid");
    }
  } else {
    throw new Error("root-managed Gateway profile is unsupported");
  }
  gatewayUnit = replaceExactlyOneLine(
    gatewayUnit,
    /^WorkingDirectory=.*$/gmu,
    `WorkingDirectory=${applicationRoot}`,
    "Gateway working directory",
  );
  const stateDir =
    context.applicationState?.stateDir ??
    gatewayUnit.match(/^Environment=FASED_STATE_DIR=(.*)$/mu)?.[1] ??
    null;
  if (!path.isAbsolute(stateDir ?? "")) {
    throw new Error("root-managed Gateway state directory is unavailable");
  }
  gatewayUnit = upsertSystemdEnvironment(gatewayUnit, "FASED_STATE_DIR", stateDir);
  gatewayUnit = upsertSystemdEnvironment(gatewayUnit, "FASED_CONFIG_DIR", stateDir);
  gatewayUnit = upsertSystemdEnvironment(
    gatewayUnit,
    "FASED_PLUGIN_STATUS_CACHE_PATH",
    path.join(stateDir, "cache", "plugin-status.json"),
  );
  gatewayUnit = upsertSystemdEnvironment(
    gatewayUnit,
    "FASED_MANAGED_RUNTIME_ROOT",
    applicationRoot,
  );
  gatewayUnit = upsertSystemdEnvironment(gatewayUnit, "FASED_NODE_BIN", nodeBinary);
  gatewayUnit = upsertSystemdEnvironment(gatewayUnit, "PATH", "/usr/local/bin:/usr/bin:/bin");
  gatewayUnit = upsertSystemdEnvironment(gatewayUnit, "FASED_RUNTIME_SOURCE", "managed-package");

  const gatewayLauncher = Buffer.from(boundary.gatewayLauncher.contentBase64, "base64").toString(
    "utf8",
  );
  if (!gatewayLauncher.startsWith("#!/usr/bin/env bash\nset -euo pipefail\n")) {
    throw new Error("root-managed Gateway launcher is invalid");
  }
  const gatewayPort = gatewayUnit.match(/^Environment=FASED_GATEWAY_PORT=(\d+)$/mu)?.[1] || "";
  if (!path.isAbsolute(stateDir) || !/^\d{1,5}$/u.test(gatewayPort)) {
    throw new Error("root-managed Gateway unit is missing its state directory or port");
  }
  const renderedLauncher = renderProtectedGatewayLauncher({
    applicationRoot,
    nodeBinary,
    stateDir,
    gatewayPort,
    profile,
  });
  return Object.freeze({
    gatewayUnit,
    gatewayLauncher: renderedLauncher,
  });
}

async function stageProtectedServiceBoundary(context) {
  const servicePaths = managedGatewayServicePaths(context);
  if (!servicePaths) {
    return null;
  }
  const gatewayUnit = await captureProtectedServiceFile(
    servicePaths.unitPath,
    "root-managed Gateway unit",
    context.rootUid,
  );
  const gatewayLauncher = await captureProtectedServiceFile(
    servicePaths.launcherPath,
    "root-managed Gateway launcher",
    context.rootUid,
  );
  const snapshots = { changed: true, gatewayUnit, gatewayLauncher };
  const desired = protectedServiceDesiredContent(context, snapshots);
  const changed =
    desired.gatewayUnit !== Buffer.from(gatewayUnit.contentBase64, "base64").toString("utf8") ||
    desired.gatewayLauncher !==
      Buffer.from(gatewayLauncher.contentBase64, "base64").toString("utf8");
  return changed
    ? snapshots
    : Object.freeze({ changed: false, gatewayUnit: null, gatewayLauncher: null });
}

async function writeProtectedServiceFile(filePath, content, captured) {
  await atomicWriteFileDurable(filePath, content, captured.mode);
  await fsp.chown(filePath, captured.uid, captured.gid);
}

async function applyProtectedServiceBoundary(context, boundary) {
  if (!boundary?.changed) {
    return;
  }
  const servicePaths = managedGatewayServicePaths(context);
  if (!servicePaths) {
    throw new Error("root-managed Gateway service paths are unavailable");
  }
  const desired = protectedServiceDesiredContent(context, boundary);
  const pairs = [
    [
      servicePaths.unitPath,
      boundary.gatewayUnit,
      Buffer.from(desired.gatewayUnit),
      "root-managed Gateway unit",
    ],
    [
      servicePaths.launcherPath,
      boundary.gatewayLauncher,
      Buffer.from(desired.gatewayLauncher),
      "root-managed Gateway launcher",
    ],
  ];
  for (const [filePath, captured, nextContent, label] of pairs) {
    const current = await captureProtectedServiceFile(filePath, label, context.rootUid);
    const desiredDigest = createHash("sha256").update(nextContent).digest("hex");
    if (current.sha256 === desiredDigest) {
      continue;
    }
    if (current.sha256 !== captured.sha256) {
      throw new Error(`${label} changed during the protected release transaction`);
    }
    await writeProtectedServiceFile(filePath, nextContent, captured);
  }
  await context.reloadUnits();
}

async function restoreProtectedServiceBoundary(context, boundary) {
  if (!boundary?.changed) {
    return;
  }
  const servicePaths = managedGatewayServicePaths(context);
  if (!servicePaths) {
    throw new Error("root-managed Gateway service paths are unavailable");
  }
  const desired = protectedServiceDesiredContent(context, boundary);
  const pairs = [
    [
      servicePaths.unitPath,
      boundary.gatewayUnit,
      Buffer.from(desired.gatewayUnit),
      "root-managed Gateway unit",
    ],
    [
      servicePaths.launcherPath,
      boundary.gatewayLauncher,
      Buffer.from(desired.gatewayLauncher),
      "root-managed Gateway launcher",
    ],
  ];
  for (const [filePath, captured, desiredContent, label] of pairs) {
    const current = await captureProtectedServiceFile(filePath, label, context.rootUid);
    if (current.sha256 === captured.sha256) {
      continue;
    }
    const desiredDigest = createHash("sha256").update(desiredContent).digest("hex");
    if (current.sha256 !== desiredDigest) {
      throw new Error(`${label} changed while restoring the protected release transaction`);
    }
    await writeProtectedServiceFile(
      filePath,
      Buffer.from(captured.contentBase64, "base64"),
      captured,
    );
  }
  await context.reloadUnits();
}

function declaredStateEntryPathIsAllowed(relativePath) {
  if (
    DECLARED_STATE_SHARED_DIRECTORIES.some((entry) => entry.relativePath === relativePath) ||
    DECLARED_STATE_SHARED_FILES.some((entry) => entry.relativePath === relativePath)
  ) {
    return true;
  }
  const parts = relativePath.split("/");
  if (
    parts.length === 4 &&
    parts[0] === "sat-mining" &&
    parts[1] === "wallets" &&
    DECLARED_STATE_SAFE_COMPONENT.test(parts[2]) &&
    DECLARED_MINING_WALLET_FILES.has(parts[3])
  ) {
    return true;
  }
  if (
    parts.length === 3 &&
    parts[0] === "sat-mining" &&
    parts[1] === "wallets" &&
    DECLARED_STATE_SAFE_COMPONENT.test(parts[2])
  ) {
    return true;
  }
  return (
    parts.length === 3 &&
    parts[0] === "sat-mining" &&
    parts[1] === "validator-artifacts" &&
    DECLARED_VALIDATOR_ARTIFACT.test(parts[2])
  );
}

function validateDeclaredStateTransaction(value) {
  if (value == null) {
    return null;
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schemaVersion !== DECLARED_STATE_SCHEMA_VERSION ||
    !new Set(["protected-local", "hosting"]).has(value.profile) ||
    !path.isAbsolute(String(value.stateDir ?? "")) ||
    path.basename(path.resolve(value.stateDir)) !== ".fased" ||
    !Number.isSafeInteger(value.operatorUid) ||
    value.operatorUid <= 0 ||
    !Number.isSafeInteger(value.configGid) ||
    value.configGid <= 0 ||
    !/^sha256:[a-f0-9]{64}$/u.test(value.registryDigest || "") ||
    !/^sha256:[a-f0-9]{64}$/u.test(value.preservationHash || "") ||
    typeof value.converged !== "boolean" ||
    typeof value.reconciled !== "boolean" ||
    !Array.isArray(value.entries) ||
    value.entries.length > DECLARED_STATE_MAX_ENTRIES
  ) {
    throw new Error("host updater declared-state transaction is invalid");
  }
  const seen = new Set();
  const entries = value.entries.map((entry) => {
    const relativePath = String(entry?.relativePath ?? "");
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      !declaredStateEntryPathIsAllowed(relativePath) ||
      seen.has(relativePath) ||
      !new Set(["directory", "file"]).has(entry.kind) ||
      typeof entry.stateClass !== "string" ||
      entry.stateClass.length === 0 ||
      entry.stateClass.length > 64 ||
      typeof entry.create !== "boolean" ||
      typeof entry.preserveContent !== "boolean" ||
      (entry.preserveSemantic != null && typeof entry.preserveSemantic !== "boolean") ||
      (entry.allowSymlinks != null && typeof entry.allowSymlinks !== "boolean") ||
      !Number.isSafeInteger(entry.desiredMode) ||
      !new Set([0o660, 0o2770]).has(entry.desiredMode) ||
      typeof entry.existed !== "boolean"
    ) {
      throw new Error("host updater declared-state entry is invalid");
    }
    seen.add(relativePath);
    if (entry.kind === "directory" && entry.desiredMode !== 0o2770) {
      throw new Error("host updater declared-state directory mode is invalid");
    }
    if (entry.kind === "file" && (entry.create || entry.desiredMode !== 0o660)) {
      throw new Error("host updater declared-state file policy is invalid");
    }
    if (entry.existed) {
      for (const field of ["uid", "gid", "mode", "dev", "ino", "nlink"]) {
        if (!Number.isSafeInteger(entry[field]) || entry[field] < 0) {
          throw new Error("host updater declared-state metadata is invalid");
        }
      }
      if (entry.kind === "file" && entry.nlink !== 1) {
        throw new Error("host updater declared-state file link count is invalid");
      }
    }
    if (
      entry.preserveContent &&
      entry.existed &&
      !/^sha256:[a-f0-9]{64}$/u.test(entry.contentHash || "")
    ) {
      throw new Error("host updater declared-state preservation digest is invalid");
    }
    if (
      entry.kind === "directory" &&
      entry.preserveContent &&
      entry.existed &&
      (!Number.isSafeInteger(entry.treeEntries) ||
        entry.treeEntries < 0 ||
        entry.treeEntries > DECLARED_STATE_TREE_MAX_ENTRIES ||
        !Number.isSafeInteger(entry.treeBytes) ||
        entry.treeBytes < 0)
    ) {
      throw new Error("host updater declared-state tree receipt is invalid");
    }
    if (
      entry.preserveSemantic === true &&
      entry.existed &&
      (!entry.semanticState ||
        typeof entry.semanticState !== "object" ||
        Array.isArray(entry.semanticState) ||
        !/^sha256:[a-f0-9]{64}$/u.test(entry.semanticHash || "") ||
        miningLedgerSemanticDigest(entry.semanticState) !== entry.semanticHash)
    ) {
      throw new Error("host updater declared-state semantic receipt is invalid");
    }
    return {
      ...entry,
      relativePath,
      preserveSemantic: entry.preserveSemantic === true,
      allowSymlinks: entry.allowSymlinks === true,
    };
  });
  if (!Array.isArray(value.changedEntries ?? []) || typeof (value.changed ?? false) !== "boolean") {
    throw new Error("host updater declared-state change receipt is invalid");
  }
  const changedEntries =
    value.changedEntries == null
      ? []
      : value.changedEntries.map((entry) => {
          const relativePath = String(entry ?? "");
          if (!seen.has(relativePath)) {
            throw new Error("host updater changed an undeclared application-state path");
          }
          return relativePath;
        });
  if (new Set(changedEntries).size !== changedEntries.length) {
    throw new Error("host updater declared-state change receipt is invalid");
  }
  const preservationHash = declaredStatePreservationHash(entries);
  if (value.preservationHash !== preservationHash) {
    throw new Error("host updater declared-state preservation receipt is inconsistent");
  }
  const preservationHashes = declaredStateClassPreservationHashes(entries);
  if (
    value.preservationHashes != null &&
    (!value.preservationHashes ||
      typeof value.preservationHashes !== "object" ||
      Array.isArray(value.preservationHashes) ||
      Object.entries(value.preservationHashes).some(
        ([stateClass, digest]) =>
          !/^[a-z][a-z0-9-]{0,63}$/u.test(stateClass) ||
          !/^sha256:[a-f0-9]{64}$/u.test(String(digest)),
      ) ||
      canonicalJSON(value.preservationHashes) !== canonicalJSON(preservationHashes))
  ) {
    throw new Error("host updater declared-state class preservation receipt is invalid");
  }
  return Object.freeze({
    ...value,
    stateDir: path.resolve(value.stateDir),
    entries,
    preservationHash,
    preservationHashes,
    changed: value.changed === true,
    changedEntries,
  });
}

function validateGatewayGenerationReceipt(value, expected = null) {
  const keys = [
    "applicationDigest",
    "dependencyDigest",
    "dependencyHash",
    "manifestDigest",
    "releaseCommit",
    "runtimeRootDigest",
    "schemaVersion",
    "updaterBundleDigest",
    "version",
  ];
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).toSorted().join(",") !== keys.toSorted().join(",") ||
    value.schemaVersion !== 1 ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value.version || "") ||
    !/^[a-f0-9]{40}$/u.test(value.releaseCommit || "") ||
    !/^[a-f0-9]{64}$/u.test(value.dependencyHash || "") ||
    [
      value.manifestDigest,
      value.applicationDigest,
      value.dependencyDigest,
      value.updaterBundleDigest,
      value.runtimeRootDigest,
    ].some((digest) => !/^sha256:[a-f0-9]{64}$/u.test(digest || ""))
  ) {
    throw new Error("target Gateway generation receipt is invalid");
  }
  const receipt = Object.freeze({ ...value });
  if (expected && canonicalJSON(receipt) !== canonicalJSON(expected)) {
    throw new Error("target Gateway readiness belongs to a different generation");
  }
  return receipt;
}

function gatewayGenerationExpectation({
  version,
  targetRoot,
  releaseBinding,
  managedManifest,
  updaterBundleDigest,
}) {
  const release = managedManifest?.release;
  const application = release?.application;
  if (
    !targetRoot ||
    release?.version !== version ||
    release?.commit !== releaseBinding?.releaseCommit ||
    release?.manifestDigest !== releaseBinding?.manifestDigest ||
    !/^sha256:[a-f0-9]{64}$/u.test(application?.digest || "") ||
    !/^sha256:[a-f0-9]{64}$/u.test(application?.dependencies?.digest || "") ||
    !/^[a-f0-9]{64}$/u.test(application?.dependencies?.dependencyHash || "") ||
    !/^sha256:[a-f0-9]{64}$/u.test(updaterBundleDigest || "")
  ) {
    throw new Error("target Gateway generation expectation is incomplete");
  }
  return validateGatewayGenerationReceipt({
    schemaVersion: 1,
    version,
    releaseCommit: releaseBinding.releaseCommit,
    manifestDigest: releaseBinding.manifestDigest,
    applicationDigest: application.digest,
    dependencyDigest: application.dependencies.digest,
    dependencyHash: application.dependencies.dependencyHash,
    updaterBundleDigest,
    runtimeRootDigest: `sha256:${createHash("sha256")
      .update(path.resolve(targetRoot))
      .digest("hex")}`,
  });
}

function gatewayGenerationExpectationFromJournal(journal) {
  if (!journal.application || !journal.managedApplication) {
    return null;
  }
  return gatewayGenerationExpectation({
    version: journal.version,
    targetRoot: journal.application?.targetRoot,
    releaseBinding: journal.releaseBinding,
    managedManifest: journal.managedApplication?.nextManifest,
    updaterBundleDigest: journal.managedApplication?.updaterGeneration?.bundleDigest,
  });
}

function validateGatewayRuntimeReceipt(value, expectedGeneration = null) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).toSorted().join(",") !== "generation,pid,runtimeSource,startedAt" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid < 1 ||
    typeof value.startedAt !== "string" ||
    Number.isNaN(Date.parse(value.startedAt)) ||
    !new Set(["managed-package", "packaged-runtime"]).has(value.runtimeSource)
  ) {
    throw new Error("host updater Gateway readiness receipt is invalid");
  }
  return Object.freeze({
    pid: value.pid,
    startedAt: value.startedAt,
    runtimeSource: value.runtimeSource,
    generation: validateGatewayGenerationReceipt(value.generation, expectedGeneration),
  });
}

function validateCrossProductHealthReceipt(value, expected = null) {
  if (value == null) {
    return null;
  }
  const checkNames = ["gateway", "signer", "wallet", "mining", "network", "plugins", "state"];
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !new Set([1, 2]).has(value.schemaVersion) ||
    typeof value.checkedAt !== "string" ||
    Number.isNaN(Date.parse(value.checkedAt)) ||
    !value.checks ||
    typeof value.checks !== "object" ||
    Array.isArray(value.checks) ||
    Object.keys(value.checks).toSorted().join(",") !== checkNames.toSorted().join(",")
  ) {
    throw new Error("host updater cross-product health receipt is invalid");
  }
  const checks = {};
  for (const name of checkNames) {
    const check = value.checks[name];
    if (
      !check ||
      typeof check !== "object" ||
      Array.isArray(check) ||
      check.ok !== true ||
      !/^sha256:[a-f0-9]{64}$/u.test(check.evidenceDigest || "")
    ) {
      throw new Error(`host updater ${name} health receipt is invalid`);
    }
    checks[name] = Object.freeze({ ok: true, evidenceDigest: check.evidenceDigest });
  }
  if (value.schemaVersion === 1) {
    return Object.freeze({ schemaVersion: 1, checkedAt: value.checkedAt, checks });
  }
  if (
    Object.keys(value).toSorted().join(",") !==
    "checkedAt,checks,gateway,schemaVersion,transactionId"
  ) {
    throw new Error("host updater generation-bound health receipt is invalid");
  }
  const transactionId = parseTransactionId(value.transactionId);
  const normalizedGateway = validateGatewayRuntimeReceipt(value.gateway, expected?.generation);
  if (
    checks.gateway.evidenceDigest !== healthEvidenceDigest(normalizedGateway) ||
    (expected && transactionId !== expected.transactionId)
  ) {
    throw new Error("host updater Gateway readiness receipt binding is invalid");
  }
  return Object.freeze({
    schemaVersion: 2,
    transactionId,
    checkedAt: value.checkedAt,
    gateway: normalizedGateway,
    checks,
  });
}

async function validateJournal(value, context) {
  if (
    !value ||
    typeof value !== "object" ||
    !new Set([1, 2, 3, 4, 5, 6, 7, JOURNAL_SCHEMA_VERSION]).has(value.schemaVersion) ||
    !TRANSACTION_PHASES.has(value.phase)
  ) {
    throw new Error("host updater transaction journal is invalid");
  }
  if (
    value.previousSignerInvariant != null &&
    (typeof value.previousSignerInvariant !== "string" ||
      value.previousSignerInvariant.length === 0 ||
      value.previousSignerInvariant.length > 64 * 1024)
  ) {
    throw new Error("host updater previous signer-state invariant is invalid");
  }
  const version = parseReleaseVersion(value.version);
  const transactionId = parseTransactionId(value.transactionId);
  const supervisorReceipt =
    value.supervisorReceipt == null
      ? null
      : parseSupervisorSelectionReceipt(value.supervisorReceipt, {
          transactionId,
          version,
        });
  const legacyAdoption = parseLegacyAdoptionBinding(value.legacyAdoption);
  const releaseBinding = value.releaseBinding == null ? null : value.releaseBinding;
  if (
    releaseBinding &&
    (!/^sha256:[a-f0-9]{64}$/.test(releaseBinding.manifestDigest || "") ||
      !/^sha256:[a-f0-9]{64}$/.test(releaseBinding.signerArtifactDigest || "") ||
      !/^sha256:[a-f0-9]{64}$/.test(releaseBinding.capabilitiesDigest || "") ||
      !/^[a-f0-9]{40}$/.test(releaseBinding.releaseCommit || ""))
  ) {
    throw new Error("host updater release-manifest binding is invalid");
  }
  let application = null;
  if (value.application != null) {
    if (
      !value.application ||
      typeof value.application !== "object" ||
      Array.isArray(value.application) ||
      Object.keys(value.application).toSorted().join(",") !== "changed,previousRoot,targetRoot" ||
      typeof value.application.changed !== "boolean"
    ) {
      throw new Error("host updater protected application transaction is invalid");
    }
    const officialTargetRoot = protectedApplicationReleaseRoot(context.paths, version);
    const requestedTargetRoot = path.resolve(String(value.application.targetRoot ?? ""));
    if (requestedTargetRoot !== officialTargetRoot) {
      throw new Error("host updater protected application transaction is not an official target");
    }
    const targetRoot = officialTargetRoot;
    const previousRoot =
      value.application.previousRoot == null
        ? null
        : path.resolve(String(value.application.previousRoot));
    const releasesRoot = path.resolve(context.paths.applicationReleasesDir ?? "/nonexistent");
    if (
      requestedTargetRoot !== targetRoot ||
      (previousRoot !== null && path.dirname(previousRoot) !== releasesRoot)
    ) {
      throw new Error("host updater protected application transaction escaped its release root");
    }
    application = {
      changed: value.application.changed,
      targetRoot,
      previousRoot,
    };
  } else if (context.paths.applicationReleasesDir) {
    throw new Error("host updater protected application transaction is missing");
  }
  const managedApplication = validateManagedApplicationTransaction(
    value.managedApplication,
    context,
    version,
  );
  if (
    value.schemaVersion === JOURNAL_SCHEMA_VERSION &&
    managedApplication &&
    !managedApplication.updaterGeneration
  ) {
    throw new Error("host updater transaction updater generation is missing");
  }
  if (
    value.schemaVersion === JOURNAL_SCHEMA_VERSION &&
    managedApplication &&
    managedApplication.nextManifest?.updater?.bundleDigest !==
      managedApplication.updaterGeneration?.bundleDigest
  ) {
    throw new Error("host updater target updater generation binding is missing");
  }
  const migrationSelection = validateLifecycleMigrationSelection(value.migrationSelection);
  const hasSchemaMigration = Object.prototype.hasOwnProperty.call(value, "schemaMigration");
  if (value.schemaVersion === JOURNAL_SCHEMA_VERSION && !hasSchemaMigration) {
    throw new Error("host updater transaction schema migration is missing");
  }
  const schemaMigration = validateLifecycleSchemaMigration(
    hasSchemaMigration
      ? value.schemaMigration
      : legacyLifecycleSchemaMigration(migrationSelection, value.phase, value.rollbackFromPhase),
    migrationSelection,
  );
  const schemaAdapters = schemaMigration?.steps.map((step) => step.adapter) ?? [];
  const preparedAdapters = new Set(schemaMigration?.preparedAdapters ?? []);
  const appliedAdapters = new Set(schemaMigration?.appliedAdapters ?? []);
  if (
    value.schemaVersion === JOURNAL_SCHEMA_VERSION &&
    new Set([
      "schema-ready",
      "snapshotting",
      "activating",
      "active",
      "gateway-authorized",
      "gateway-verified",
      "committing",
    ]).has(value.phase) &&
    !migrationSelection
  ) {
    throw new Error("host updater transaction migration selection is missing");
  }
  if (
    new Set([
      "schema-ready",
      "snapshotting",
      "activating",
      "active",
      "gateway-authorized",
      "gateway-verified",
      "committing",
    ]).has(value.phase) &&
    schemaAdapters.some((adapter) => !preparedAdapters.has(adapter))
  ) {
    throw new Error("host updater transaction schema migrations are not prepared");
  }
  if (
    new Set(["gateway-verified", "committing"]).has(value.phase) &&
    schemaAdapters.some((adapter) => !appliedAdapters.has(adapter))
  ) {
    throw new Error("host updater transaction schema migrations are incomplete");
  }
  const serviceBoundary = validateProtectedServiceBoundary(value.serviceBoundary, context);
  const declaredState = validateDeclaredStateTransaction(value.declaredState);
  const expectedGatewayGeneration =
    value.schemaVersion === JOURNAL_SCHEMA_VERSION &&
    managedApplication &&
    new Set(["gateway-verified", "committing"]).has(value.phase)
      ? gatewayGenerationExpectationFromJournal({
          ...value,
          version,
          releaseBinding,
          application,
          managedApplication,
        })
      : null;
  const healthReceipt = validateCrossProductHealthReceipt(
    value.healthReceipt,
    expectedGatewayGeneration ? { transactionId, generation: expectedGatewayGeneration } : null,
  );
  if (
    value.schemaVersion === JOURNAL_SCHEMA_VERSION &&
    managedApplication &&
    new Set(["gateway-verified", "committing"]).has(value.phase) &&
    healthReceipt?.schemaVersion !== 2
  ) {
    throw new Error("host updater generation-bound health receipt is missing");
  }
  const signerPrivateState = validateSignerPrivateStateSnapshot(value.signerPrivateState);
  if (
    value.schemaVersion === JOURNAL_SCHEMA_VERSION &&
    value.changed === true &&
    new Set([
      "snapshotting",
      "activating",
      "active",
      "gateway-authorized",
      "gateway-verified",
      "committing",
    ]).has(value.phase) &&
    !signerPrivateState
  ) {
    throw new Error("host updater signer private-state snapshot is missing");
  }
  return {
    ...value,
    transactionId,
    version,
    previousVersion:
      value.previousVersion == null ? null : parseReleaseVersion(value.previousVersion),
    release: parseSignerReleaseIdentity(value.release, version),
    releaseBinding,
    supervisorReceipt,
    legacyAdoption,
    application,
    managedApplication,
    migrationSelection,
    schemaMigration,
    serviceBoundary,
    declaredState,
    healthReceipt,
    signerPrivateState,
    changed: value.changed === true,
  };
}

async function readJournal(context) {
  try {
    return await validateJournal(
      JSON.parse(await fsp.readFile(context.paths.journalPath, "utf8")),
      context,
    );
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeJournal(context, journal) {
  const managedApplication =
    journal.managedApplication?.updaterGeneration &&
    journal.managedApplication?.nextManifest?.updater &&
    !journal.managedApplication.nextManifest.updater.bundleDigest
      ? {
          ...journal.managedApplication,
          nextManifest: {
            ...journal.managedApplication.nextManifest,
            updater: {
              ...journal.managedApplication.nextManifest.updater,
              bundleDigest: journal.managedApplication.updaterGeneration.bundleDigest,
            },
          },
        }
      : journal.managedApplication;
  const next = await validateJournal(
    {
      ...journal,
      managedApplication,
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
    },
    context,
  );
  await atomicWriteFileDurable(
    context.paths.journalPath,
    `${JSON.stringify(next, null, 2)}\n`,
    0o600,
  );
  await context.onDurablePhase?.(next.phase, next);
  return next;
}

async function removeJournal(context) {
  await fsp.rm(context.paths.journalPath, { force: true });
  await fsyncDirectory(path.dirname(context.paths.journalPath));
}

async function fileMetadata(filePath) {
  try {
    const stat = await fsp.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`transaction source must be a regular non-symlink file: ${filePath}`);
    }
    return { existed: true, uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o777 };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { existed: false };
    }
    throw error;
  }
}

function validatePrivateFileSnapshot(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`host updater ${label} snapshot is invalid`);
  }
  if (value.existed === false && Object.keys(value).join(",") === "existed") {
    return Object.freeze({ existed: false });
  }
  if (
    value.existed !== true ||
    Object.keys(value).toSorted().join(",") !== "existed,gid,mode,sha256,size,uid" ||
    !Number.isSafeInteger(value.uid) ||
    value.uid < 0 ||
    !Number.isSafeInteger(value.gid) ||
    value.gid < 0 ||
    !Number.isSafeInteger(value.mode) ||
    value.mode < 0 ||
    value.mode > 0o777 ||
    !Number.isSafeInteger(value.size) ||
    value.size < 0 ||
    !/^sha256:[a-f0-9]{64}$/u.test(value.sha256 || "")
  ) {
    throw new Error(`host updater ${label} snapshot is invalid`);
  }
  return Object.freeze({ ...value });
}

function validateSignerPrivateStateSnapshot(value) {
  if (value == null) {
    return null;
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schemaVersion !== 1 ||
    Object.keys(value).toSorted().join(",") !== "auditLog,masterKey,schemaVersion,stateDB"
  ) {
    throw new Error("host updater signer private-state snapshot is invalid");
  }
  return Object.freeze({
    schemaVersion: 1,
    stateDB: validatePrivateFileSnapshot(value.stateDB, "signer database"),
    masterKey: validatePrivateFileSnapshot(value.masterKey, "signer master key"),
    auditLog: validatePrivateFileSnapshot(value.auditLog, "signer audit log"),
  });
}

async function privateFileSnapshot(filePath, label) {
  const metadata = await fileMetadata(filePath);
  if (!metadata.existed) {
    return Object.freeze({ existed: false });
  }
  const named = await fsp.lstat(filePath);
  if (named.nlink !== 1) {
    throw new Error(`${label} must not be hard-linked`);
  }
  const handle = await fsp.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const current = await handle.stat();
    if (
      !current.isFile() ||
      current.dev !== named.dev ||
      current.ino !== named.ino ||
      current.nlink !== 1
    ) {
      throw new Error(`${label} changed during snapshot inventory`);
    }
    return validatePrivateFileSnapshot(
      {
        existed: true,
        uid: current.uid,
        gid: current.gid,
        mode: current.mode & 0o777,
        size: current.size,
        sha256: await hashDeclaredFile(handle, current, label),
      },
      label,
    );
  } finally {
    await handle.close();
  }
}

async function assertSnapshotDiskCapacity(directory, snapshots) {
  const requiredContentBytes = snapshots
    .filter((entry) => entry.existed)
    .reduce((sum, entry) => sum + BigInt(entry.size), 0n);
  const reserveBytes =
    requiredContentBytes / 10n > 8n * 1024n * 1024n
      ? requiredContentBytes / 10n
      : 8n * 1024n * 1024n;
  const requiredBytes = requiredContentBytes + reserveBytes;
  const filesystem = await fsp.statfs(directory, { bigint: true });
  const availableBytes = filesystem.bavail * filesystem.bsize;
  if (availableBytes < requiredBytes) {
    throw new Error(
      `insufficient disk space for transactional signer snapshot (${requiredBytes} bytes required, ${availableBytes} available)`,
    );
  }
  return Object.freeze({ requiredBytes, availableBytes });
}

async function cleanupTransactionFiles(context, transactionId) {
  const txPaths = transactionPaths(context.paths, transactionId);
  await fsp.rm(txPaths.candidatePath, { force: true });
  await fsp.rm(txPaths.transactionDir, { recursive: true, force: true });
  await fsyncDirectory(path.dirname(txPaths.candidatePath));
  await fsyncDirectory(context.paths.transactionsDir).catch((error) => {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  });
}

function protectedApplicationReleaseRoot(paths, version) {
  if (!paths.applicationReleasesDir || !paths.applicationCurrentLink) {
    throw new Error("protected application runtime paths are unavailable");
  }
  const releases = path.resolve(paths.applicationReleasesDir);
  const generation = `v${parseReleaseVersion(version)}`;
  const releaseRoot = path.resolve(releases, generation);
  if (path.dirname(releaseRoot) !== releases) {
    throw new Error("protected application release path escaped its root");
  }
  return releaseRoot;
}

async function prepareProtectedApplicationDirectories(paths) {
  if (!paths.applicationReleasesDir || !paths.applicationCurrentLink) {
    throw new Error("protected application runtime paths are unavailable");
  }
  const releasesDir = path.resolve(paths.applicationReleasesDir);
  const applicationDir = path.dirname(releasesDir);
  const currentLink = path.resolve(paths.applicationCurrentLink);
  if (
    path.basename(releasesDir) !== "releases" ||
    currentLink !== path.join(applicationDir, "current")
  ) {
    throw new Error("protected application runtime layout is invalid");
  }
  const ownerUid = process.geteuid();
  const ownerGid = process.getegid();
  for (const directory of [applicationDir, releasesDir]) {
    try {
      await fsp.mkdir(directory, { mode: 0o755 });
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
    }
    const info = await fsp.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== ownerUid) {
      throw new Error(`protected application runtime directory is unsafe: ${directory}`);
    }
    await fsp.chown(directory, ownerUid, ownerGid);
    await fsp.chmod(directory, 0o755);
  }
}

async function copyProtectedApplicationTree(source, destination) {
  const cp = await fixedExecutable(["/usr/bin/cp", "/bin/cp"], "cp");
  await fsp.mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
  await execFileAsync(cp, ["-a", "--no-preserve=links", source, destination], {
    env: { PATH: "/usr/bin:/bin" },
    timeout: REQUEST_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function hardenProtectedApplicationTree(root) {
  const ownerUid = process.geteuid();
  const ownerGid = process.getegid();
  const [find, chown, chmod] = await Promise.all([
    fixedExecutable(["/usr/bin/find", "/bin/find"], "find"),
    fixedExecutable(["/usr/bin/chown", "/bin/chown"], "chown"),
    fixedExecutable(["/usr/bin/chmod", "/bin/chmod"], "chmod"),
  ]);
  const common = {
    env: { PATH: "/usr/bin:/bin" },
    timeout: REQUEST_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  };
  const unsupported = await execFileAsync(
    find,
    [root, "-xdev", "!", "-type", "f", "!", "-type", "d", "!", "-type", "l", "-print", "-quit"],
    common,
  );
  if (unsupported.stdout.trim()) {
    throw new Error(
      `protected application contains an unsupported entry: ${unsupported.stdout.trim()}`,
    );
  }
  const links = await execFileAsync(find, [root, "-xdev", "-type", "l", "-print0"], common);
  for (const candidate of links.stdout.split("\0").filter(Boolean)) {
    const target = await fsp.realpath(candidate);
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`protected application contains an escaping symlink: ${candidate}`);
    }
  }
  await execFileAsync(chown, ["-R", `${ownerUid}:${ownerGid}`, root], common);
  await execFileAsync(chmod, ["-R", "a+rX,go-w", root], common);
}

async function verifyProtectedApplicationRuntime(root, version, commit, dependencyHash = null) {
  const canonical = await fsp.realpath(root);
  const [packageValue, buildValue, metadataValue] = await Promise.all([
    fsp.readFile(path.join(canonical, "package.json"), "utf8").then(JSON.parse),
    fsp.readFile(path.join(canonical, "dist", "build-info.json"), "utf8").then(JSON.parse),
    fsp.readFile(path.join(canonical, ".fased-hosted-runtime.json"), "utf8").then(JSON.parse),
  ]);
  if (
    packageValue?.version !== version ||
    buildValue?.version !== version ||
    buildValue?.commit !== commit ||
    metadataValue?.version !== version ||
    metadataValue?.commit !== commit ||
    (dependencyHash && metadataValue?.dependencyHash !== dependencyHash)
  ) {
    throw new Error("protected application runtime identity is mismatched");
  }
  const required = [
    path.join(canonical, "fased.mjs"),
    path.join(canonical, "scripts", "start-managed.sh"),
    path.join(canonical, "node_modules"),
  ];
  const [cli, launcher, dependencies] = await Promise.all(
    required.map((entry) => fsp.lstat(entry)),
  );
  if (
    !cli.isFile() ||
    cli.isSymbolicLink() ||
    !launcher.isFile() ||
    launcher.isSymbolicLink() ||
    !dependencies.isDirectory() ||
    dependencies.isSymbolicLink()
  ) {
    throw new Error("protected application runtime is incomplete");
  }
  return canonical;
}

export async function installProtectedLocalApplicationRuntime(params) {
  const version = parseReleaseVersion(params.version);
  const commit = String(params.commit ?? "").trim();
  if (!/^[a-f0-9]{40}$/.test(commit)) {
    throw new Error("protected application release commit is invalid");
  }
  const releaseRoot = protectedApplicationReleaseRoot(params.paths, version);
  await prepareProtectedApplicationDirectories(params.paths);
  let ready = false;
  try {
    await verifyProtectedApplicationRuntime(releaseRoot, version, commit);
    ready = true;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  if (!ready) {
    const staging = `${releaseRoot}.staging-${process.pid}-${Date.now()}`;
    await fsp.rm(staging, { recursive: true, force: true });
    try {
      await copyProtectedApplicationTree(params.sourceRoot, staging);
      if (params.dependencyRoot) {
        await copyProtectedApplicationTree(
          params.dependencyRoot,
          path.join(staging, "node_modules"),
        );
      }
      await hardenProtectedApplicationTree(staging);
      await verifyProtectedApplicationRuntime(staging, version, commit);
      await fsp.rename(staging, releaseRoot);
      await fsyncDirectory(params.paths.applicationReleasesDir);
    } finally {
      await fsp.rm(staging, { recursive: true, force: true });
    }
  }
  if (params.activate !== false) {
    await atomicSymlinkDurable(releaseRoot, params.paths.applicationCurrentLink);
  }
  return { releaseRoot, previousRoot: null };
}

async function listArchiveEntries(archivePath, allowedRoot) {
  const tar = await fixedExecutable(["/usr/bin/tar", "/bin/tar"], "tar");
  const { stdout } = await execFileAsync(tar, ["-tzf", archivePath], {
    env: { PATH: "/usr/bin:/bin" },
    timeout: REQUEST_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  for (const raw of stdout.split(/\r?\n/u).filter(Boolean)) {
    const entry = raw.replace(/\/+$/u, "");
    const parts = entry.split("/");
    if (
      !entry ||
      entry.startsWith("/") ||
      entry.includes("\\") ||
      parts[0] !== allowedRoot ||
      parts.some((part) => !part || part === "." || part === "..")
    ) {
      throw new Error(`protected application archive contains an unsafe path: ${raw}`);
    }
  }
  return tar;
}

async function extractProtectedArchive(archivePath, destination, allowedRoot) {
  const tar = await listArchiveEntries(archivePath, allowedRoot);
  await fsp.mkdir(destination, { recursive: true, mode: 0o700 });
  await execFileAsync(
    tar,
    ["-xzf", archivePath, "-C", destination, "--no-same-owner", "--no-same-permissions"],
    {
      env: { PATH: "/usr/bin:/bin" },
      timeout: REQUEST_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
}

async function stageProtectedApplicationRelease({
  version,
  selected,
  releaseUrl,
  manifestBytes,
  staging,
  context,
}) {
  await prepareProtectedApplicationDirectories(context.paths);
  const releaseRoot = protectedApplicationReleaseRoot(context.paths, version);
  let previousRoot = null;
  try {
    previousRoot = await fsp.realpath(context.paths.applicationCurrentLink);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  try {
    await verifyProtectedApplicationRuntime(
      releaseRoot,
      version,
      selected.release.commit,
      selected.application.dependencies.dependencyHash,
    );
    return { targetRoot: releaseRoot, previousRoot, changed: previousRoot !== releaseRoot };
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  const appArchive = path.join(staging, selected.application.artifact.asset);
  const dependencyArchive = path.join(staging, selected.application.dependencies.asset);
  await Promise.all([
    context.downloadReleaseAsset(
      `${releaseUrl}/${selected.application.artifact.asset}`,
      appArchive,
    ),
    context.downloadReleaseAsset(
      `${releaseUrl}/${selected.application.dependencies.asset}`,
      dependencyArchive,
    ),
  ]);
  const [appDigest, dependencyDigest] = await Promise.all([
    sha256(appArchive),
    sha256(dependencyArchive),
  ]);
  if (
    appDigest !== selected.application.artifact.sha256 ||
    dependencyDigest !== selected.application.dependencies.sha256
  ) {
    throw new Error("protected application layers do not match the attested release manifest");
  }

  const candidateParent = `${releaseRoot}.staging-${process.pid}-${Date.now()}`;
  await fsp.rm(candidateParent, { recursive: true, force: true });
  try {
    await extractProtectedArchive(appArchive, candidateParent, "package");
    const candidateRoot = path.join(candidateParent, "package");
    await extractProtectedArchive(dependencyArchive, candidateRoot, "node_modules");
    await fsp.writeFile(path.join(candidateRoot, ".fased-hosted-release-v2.json"), manifestBytes, {
      mode: 0o644,
    });
    const evidenceRoot = path.join(candidateRoot, ".fased-release-evidence");
    await fsp.mkdir(evidenceRoot, { recursive: true, mode: 0o755 });
    await Promise.all(
      [
        LIFECYCLE_TRUST_METADATA_NAME,
        PRIVILEGED_PROVENANCE_NAME,
        PRIVILEGED_SBOM_NAME,
        PRIVILEGED_VEX_NAME,
      ].map(async (asset) => {
        await fsp.copyFile(path.join(staging, asset), path.join(evidenceRoot, asset));
        await fsp.chmod(path.join(evidenceRoot, asset), 0o644);
      }),
    );
    await hardenProtectedApplicationTree(candidateRoot);
    await verifyProtectedApplicationRuntime(
      candidateRoot,
      version,
      selected.release.commit,
      selected.application.dependencies.dependencyHash,
    );
    await fsp.rename(candidateRoot, releaseRoot);
    await fsyncDirectory(context.paths.applicationReleasesDir);
  } finally {
    await fsp.rm(candidateParent, { recursive: true, force: true });
  }
  return { targetRoot: releaseRoot, previousRoot, changed: previousRoot !== releaseRoot };
}

async function stageOfficialCandidate(version, candidatePath, context) {
  const arch = releaseArchitecture();
  const platform = `linux-${arch}`;
  const releaseUrl = `${RELEASE_BASE}/v${version}`;
  await fsp.mkdir(context.paths.stateDir, { recursive: true, mode: 0o700 });
  const staging = await fsp.mkdtemp(path.join(context.paths.stateDir, `.download-${version}-`));
  const releaseManifestPath = path.join(staging, RELEASE_MANIFEST_NAME);
  const releaseManifestBundlePath = path.join(staging, RELEASE_MANIFEST_BUNDLE_NAME);
  const signerAttestationBundlePath = path.join(staging, SIGNER_ATTESTATION_BUNDLE_NAME);
  const lifecycleMetadataPath = path.join(staging, LIFECYCLE_TRUST_METADATA_NAME);
  const lifecycleMetadataBundlePath = path.join(staging, LIFECYCLE_TRUST_METADATA_BUNDLE_NAME);
  const evidenceVerifierPath = path.join(staging, EVIDENCE_VERIFIER_NAME);
  const provenancePath = path.join(staging, PRIVILEGED_PROVENANCE_NAME);
  const provenanceBundlePath = path.join(staging, PRIVILEGED_PROVENANCE_BUNDLE_NAME);
  const sbomPath = path.join(staging, PRIVILEGED_SBOM_NAME);
  const vexPath = path.join(staging, PRIVILEGED_VEX_NAME);
  try {
    await Promise.all([
      context.downloadReleaseAsset(`${releaseUrl}/${RELEASE_MANIFEST_NAME}`, releaseManifestPath),
      context.downloadReleaseAsset(
        `${releaseUrl}/${RELEASE_MANIFEST_BUNDLE_NAME}`,
        releaseManifestBundlePath,
      ),
      context.downloadReleaseAsset(
        `${releaseUrl}/${LIFECYCLE_TRUST_METADATA_NAME}`,
        lifecycleMetadataPath,
      ),
      context.downloadReleaseAsset(
        `${releaseUrl}/${LIFECYCLE_TRUST_METADATA_BUNDLE_NAME}`,
        lifecycleMetadataBundlePath,
      ),
      context.downloadReleaseAsset(`${releaseUrl}/${EVIDENCE_VERIFIER_NAME}`, evidenceVerifierPath),
      context.downloadReleaseAsset(`${releaseUrl}/${PRIVILEGED_PROVENANCE_NAME}`, provenancePath),
      context.downloadReleaseAsset(
        `${releaseUrl}/${PRIVILEGED_PROVENANCE_BUNDLE_NAME}`,
        provenanceBundlePath,
      ),
      context.downloadReleaseAsset(`${releaseUrl}/${PRIVILEGED_SBOM_NAME}`, sbomPath),
      context.downloadReleaseAsset(`${releaseUrl}/${PRIVILEGED_VEX_NAME}`, vexPath),
    ]);
    await Promise.all([
      context.verifyReleaseAsset(
        releaseManifestPath,
        version,
        context.paths.stateDir,
        releaseManifestBundlePath,
      ),
      context.verifyReleaseAsset(
        lifecycleMetadataPath,
        version,
        context.paths.stateDir,
        lifecycleMetadataBundlePath,
      ),
      context.verifyReleaseAsset(
        provenancePath,
        version,
        context.paths.stateDir,
        provenanceBundlePath,
      ),
    ]);
    const manifestBytes = await fsp.readFile(releaseManifestPath);
    const selected = parseUnifiedHostedSignerRelease(
      JSON.parse(manifestBytes.toString("utf8")),
      version,
      platform,
    );
    const lifecycleMetadata = JSON.parse(await fsp.readFile(lifecycleMetadataPath, "utf8"));
    const expectedVerifier = lifecycleMetadata?.targets?.evidenceVerifier;
    if (
      lifecycleMetadata?.release?.version !== version ||
      lifecycleMetadata?.release?.commit !== selected.binding.releaseCommit ||
      expectedVerifier?.asset !== EVIDENCE_VERIFIER_NAME ||
      !/^[a-f0-9]{64}$/u.test(expectedVerifier?.sha256 || "")
    ) {
      throw new Error("lifecycle evidence verifier identity is malformed or release-mismatched");
    }
    const evidenceVerifierSha256 = await sha256(evidenceVerifierPath);
    if (evidenceVerifierSha256 !== expectedVerifier.sha256) {
      throw new Error("privileged release evidence verifier does not match lifecycle metadata");
    }
    await context.verifyPrivilegedReleaseEvidence(evidenceVerifierPath, evidenceVerifierSha256, {
      releaseManifestPath,
      lifecycleMetadataPath,
      provenancePath,
      sbomPath,
      vexPath,
      expectedVersion: version,
      expectedCommit: selected.binding.releaseCommit,
    });
    const assetPath = path.join(staging, selected.artifact.asset);
    await Promise.all([
      context.downloadReleaseAsset(`${releaseUrl}/${selected.artifact.asset}`, assetPath),
      context.downloadReleaseAsset(
        `${releaseUrl}/${SIGNER_ATTESTATION_BUNDLE_NAME}`,
        signerAttestationBundlePath,
      ),
    ]);
    if ((await sha256(assetPath)) !== selected.artifact.sha256) {
      throw new Error("native signer does not match the attested unified release manifest");
    }
    await context.verifyReleaseAsset(
      assetPath,
      version,
      context.paths.stateDir,
      signerAttestationBundlePath,
    );
    await fsp.rm(candidatePath, { force: true });
    await atomicCopyFileDurable(assetPath, candidatePath, { mode: 0o755 });
    const application = context.paths.applicationReleasesDir
      ? await stageProtectedApplicationRelease({
          version,
          selected,
          releaseUrl,
          manifestBytes,
          staging,
          context,
        })
      : null;
    return {
      release: selected.release,
      application,
      applicationRelease: {
        version,
        commit: selected.binding.releaseCommit,
        manifestDigest: `sha256:${createHash("sha256").update(manifestBytes).digest("hex")}`,
        artifact: selected.application.artifact,
        dependencies: selected.application.dependencies,
        signer: selected.release,
        capabilities: selected.capabilities,
        capabilitiesDigest: selected.binding.capabilitiesDigest,
      },
      binding: {
        ...selected.binding,
        manifestDigest: `sha256:${createHash("sha256").update(manifestBytes).digest("hex")}`,
        signerArtifactDigest: `sha256:${selected.artifact.sha256}`,
      },
    };
  } finally {
    await fsp.rm(staging, { recursive: true, force: true });
  }
}

const DECLARED_STATE_SCHEMA_VERSION = 1;
const DECLARED_STATE_MAX_ENTRIES = 4096;
const DECLARED_STATE_TREE_MAX_ENTRIES = 1_000_000;
const DECLARED_STATE_TREE_MAX_DEPTH = 64;
const DECLARED_STATE_TREE_MAX_PATH_BYTES = 8192;
const DECLARED_STATE_SHARED_DIRECTORIES = Object.freeze([
  Object.freeze({ relativePath: ".", stateClass: "gateway-config-auth", create: false }),
  Object.freeze({
    relativePath: "cache",
    stateClass: "derived-runtime-cache",
    create: true,
    preserveContent: false,
  }),
  Object.freeze({
    relativePath: "identity",
    stateClass: "device-identity",
    create: true,
    preserveContent: true,
  }),
  Object.freeze({
    relativePath: "wallet",
    stateClass: "wallet",
    create: true,
    preserveContent: true,
  }),
  Object.freeze({
    relativePath: "federation",
    stateClass: "federation-network",
    create: true,
    preserveContent: true,
  }),
  Object.freeze({
    relativePath: "extensions",
    stateClass: "agent-session-channel-plugin",
    create: true,
    preserveContent: true,
    allowSymlinks: true,
  }),
  ...[
    ["credentials", "provider-credentials"],
    ["secrets", "provider-credentials"],
    ["agents", "agent-session-channel-plugin"],
    ["sessions", "agent-session-channel-plugin"],
    ["channels", "agent-session-channel-plugin"],
    ["cron", "agent-session-channel-plugin"],
    ["tasks", "agent-session-channel-plugin"],
    ["schedules", "agent-session-channel-plugin"],
    ["devices", "agent-session-channel-plugin"],
    ["delivery-queue", "agent-session-channel-plugin"],
    ["memory", "agent-session-channel-plugin"],
  ].map(([relativePath, stateClass]) =>
    Object.freeze({
      relativePath,
      stateClass,
      create: false,
      preserveContent: true,
    }),
  ),
  Object.freeze({ relativePath: "sat-mining", stateClass: "mining", create: false }),
  Object.freeze({ relativePath: "sat-mining/wallets", stateClass: "mining", create: false }),
  Object.freeze({
    relativePath: "sat-mining/validator-artifacts",
    stateClass: "mining",
    create: false,
  }),
]);
const DECLARED_STATE_SHARED_FILES = Object.freeze([
  Object.freeze({
    relativePath: "fased.json",
    stateClass: "gateway-config-auth",
    preserveContent: true,
  }),
  Object.freeze({
    relativePath: "identity/device.json",
    stateClass: "device-identity",
    preserveContent: true,
  }),
  Object.freeze({
    relativePath: "identity/device-auth.json",
    stateClass: "device-identity",
    preserveContent: false,
  }),
  ...[
    "provider-registry.v1.json",
    "policy-usage.json",
    "wallet-send-approvals.json",
    "wallet-audit.jsonl",
    "wallet-service.meta.json",
    "observability.v1.json",
    "wallet-standard-reviews.v1.json",
    "turnkey-reviews.v1.json",
    "external-submissions.json",
    "wallet-approval-auth.json",
    "wallet-send-executions.json",
    "wallet-inbound-events.v1.json",
    "wallet-policy-state.v1.json",
    "wallet-settlement-links.json",
  ].map((name) =>
    Object.freeze({
      relativePath: `wallet/${name}`,
      stateClass: "wallet",
      preserveContent: true,
    }),
  ),
  ...["access-token.json", "bond-proof.json", "peer-replay-v2.json"].map((name) =>
    Object.freeze({
      relativePath: `federation/${name}`,
      stateClass: "federation-network",
      preserveContent: true,
    }),
  ),
]);
const DECLARED_MINING_WALLET_FILES = new Set([
  "audit-store.json",
  "runtime-store.json",
  "planner-history.ndjson",
  "action-history.ndjson",
  "action-history.mirror.ndjson",
  "submission-ledger.json",
  "mining.sqlite",
]);
const DECLARED_STATE_SAFE_COMPONENT = /^[A-Za-z0-9._-]{1,160}$/u;
const DECLARED_VALIDATOR_ARTIFACT = /^[A-Za-z0-9._-]{1,240}\.json$/u;

function declaredStateRegistry(topology, context) {
  const sharedIdentity = {
    owner: topology.operator.name,
    group: topology.configGroup.name,
    directoryMode: "2770",
    fileMode: "0660",
    setgid: true,
    acl: false,
  };
  return Object.freeze([
    {
      stateClass: "application-runtime",
      schemaOwner: "target-controller",
      currentSchema: 2,
      readers: [topology.gateway.user],
      writers: ["root"],
      symlinkPolicy: "controller-owned-atomic-pointer-only",
      migration: "manifest-bound-application",
      rollback: "previous-generation-pointer",
      preservation: "attested-release-digest",
      health: "exact-gateway-release-identity",
      paths: [context.paths.applicationReleasesDir, context.paths.applicationCurrentLink].filter(
        Boolean,
      ),
    },
    {
      stateClass: "dependency-runtime",
      schemaOwner: "target-controller",
      currentSchema: 1,
      readers: [topology.gateway.user],
      writers: ["root"],
      symlinkPolicy: "controller-owned-content-addressed-pointer-only",
      migration: "content-addressed-reuse",
      rollback: "previous-dependency-pointer",
      preservation: "manifest-bound-dependency-digest",
      health: "target-runtime-smoke",
      paths: [],
    },
    {
      stateClass: "updater-controller",
      schemaOwner: "lifecycle-supervisor",
      currentSchema: CONTROLLER_PROTOCOL_VERSION,
      readers: ["root"],
      writers: ["root"],
      symlinkPolicy: "supervisor-owned-atomic-pointer-only",
      migration: "capability-negotiated-controller",
      rollback: "supervisor-generation-pointer",
      preservation: "attested-controller-digest",
      health: "exact-controller-process-identity",
      paths: [
        context.paths.controllerReleasesDir,
        context.paths.controllerCurrentLink,
        context.paths.stateDir,
      ].filter(Boolean),
    },
    {
      stateClass: "signer-private-state",
      schemaOwner: "fased-signerd",
      currentSchema: 2,
      readers: ["signer-service"],
      writers: ["signer-service"],
      symlinkPolicy: "reject",
      migration: "signer-owned-schema-migration",
      rollback: "transaction-snapshot-and-signer-invariant",
      preservation: "signer-state-invariant",
      health: "exact-release-protocol-policy-network-webauthn",
      paths: [
        context.paths.signerStateDBPath,
        context.paths.signerMasterKeyPath,
        context.paths.signerAuditLogPath,
        context.paths.signerPath,
      ].filter(Boolean),
    },
    {
      stateClass: "wallet",
      schemaOwner: "wallet-registry-and-fased-signerd",
      currentSchema: 1,
      readers: [topology.operator.name, topology.gateway.user, "fased-signerd"],
      writers: [topology.operator.name, topology.gateway.user, "fased-signerd"],
      ...sharedIdentity,
      symlinkPolicy: "reject",
      migration: "wallet-registry-schema-and-signer-capability",
      rollback: "metadata-snapshot-plus-registry-hash",
      preservation: "wallet-registry-hash-and-signer-invariant",
      health: "wallet-registry-signer-readiness-routing-rpc",
      paths: ["wallet"],
    },
    {
      stateClass: "mining",
      schemaOwner: "sat-mining",
      currentSchema: 1,
      readers: [topology.operator.name, topology.gateway.user],
      writers: [topology.operator.name, topology.gateway.user],
      ...sharedIdentity,
      symlinkPolicy: "reject",
      migration: "bounded-wallet-state-schema",
      rollback: "metadata-snapshot-and-semantic-readback",
      preservation: "wallet-state-inventory",
      health: "bounded-mining-history-read",
      paths: ["sat-mining"],
    },
    {
      stateClass: "device-identity",
      schemaOwner: "gateway-device-auth",
      currentSchema: 1,
      readers: [topology.operator.name, topology.gateway.user],
      writers: [topology.operator.name, topology.gateway.user],
      ...sharedIdentity,
      symlinkPolicy: "reject",
      migration: "declared-device-files-only",
      rollback: "metadata-snapshot-plus-device-identity-hash",
      preservation: "device-identity-hash",
      health: "authenticated-gateway-history-read",
      paths: ["identity/device.json", "identity/device-auth.json"],
    },
    {
      stateClass: "federation-network",
      schemaOwner: "fased-network",
      currentSchema: 2,
      readers: [topology.operator.name, topology.gateway.user],
      writers: [topology.operator.name, topology.gateway.user],
      ...sharedIdentity,
      symlinkPolicy: "reject",
      migration: "declared-federation-files-only",
      rollback: "metadata-snapshot-and-local-status",
      preservation: "configured-network-identity",
      health: "local-token-handle-bond-consistency",
      paths: ["federation"],
    },
    {
      stateClass: "gateway-config-auth",
      schemaOwner: "gateway-config",
      currentSchema: 1,
      readers: [topology.operator.name, topology.gateway.user],
      writers: [topology.operator.name, topology.gateway.user],
      ...sharedIdentity,
      symlinkPolicy: "reject",
      migration: "config-schema",
      rollback: "metadata-snapshot-plus-config-hash",
      preservation: "config-content-hash",
      health: "exact-gateway-identity-and-authenticated-cli",
      paths: [".", "fased.json"],
    },
    {
      stateClass: "provider-credentials",
      schemaOwner: "credential-broker",
      currentSchema: 1,
      readers: [topology.operator.name, topology.gateway.user],
      writers: [topology.operator.name],
      symlinkPolicy: "reject",
      migration: "provider-owned-declared-credential",
      rollback: "preserve-only",
      preservation: "opaque-credential-store",
      health: "configured-provider-resolution",
      paths: ["credentials", "secrets"],
    },
    {
      stateClass: "agent-session-channel-plugin",
      schemaOwner: "gateway-application",
      currentSchema: 1,
      readers: [topology.operator.name, topology.gateway.user],
      writers: [topology.operator.name, topology.gateway.user],
      symlinkPolicy: "component-specific",
      migration: "component-owned-only",
      rollback: "preserve-only",
      preservation: "component-semantic-health",
      health: "plugin-diagnostics-and-gateway-readiness",
      paths: ["agents", "sessions", "channels", "cron", "extensions"],
    },
    {
      stateClass: "profile-access",
      schemaOwner: topology.profile === "hosting" ? "hosting-adapter" : "local-adapter",
      currentSchema: 1,
      readers: ["root", topology.operator.name],
      writers: ["root"],
      symlinkPolicy: "adapter-declared-only",
      migration: "topology-capability-adapter",
      rollback: "service-boundary-snapshot",
      preservation: "exact-profile-and-service-identities",
      health: "declared-profile-access",
      paths: [topology.gateway.unitPath, context.paths.signerUnitPath].filter(Boolean),
    },
  ]);
}

async function systemAccountRecord(database, name) {
  const getent = await fixedExecutable(["/usr/bin/getent", "/bin/getent"], "getent");
  const { stdout } = await execFileAsync(getent, [database, name], {
    env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" },
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  });
  const line = stdout.trim();
  const fields = line.split(":");
  const identityMatches =
    fields[0] === name || (database === "passwd" && /^\d+$/u.test(name) && fields[2] === name);
  if (
    (database === "passwd" && fields.length < 7) ||
    (database === "group" && fields.length < 4) ||
    !identityMatches
  ) {
    throw new Error(`root-managed ${database} identity is malformed`);
  }
  return fields;
}

function exactUnitValue(content, key) {
  const pattern = new RegExp(`^${key}=(.*)$`, "gmu");
  const matches = [...content.matchAll(pattern)];
  if (matches.length !== 1 || !matches[0][1]) {
    throw new Error(`root-managed Gateway unit has an invalid ${key}`);
  }
  return matches[0][1];
}

async function assertSharedDirectoryModesAvailable(stateDir, operatorUid, configGid) {
  const probe = await fsp.mkdtemp(path.join(stateDir, ".fased-permission-probe-"));
  try {
    const handle = await fsp.open(
      probe,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
    );
    try {
      await handle.chown(operatorUid, configGid);
      await handle.chmod(0o2770);
      const stat = await handle.stat();
      if (stat.uid !== operatorUid || stat.gid !== configGid || (stat.mode & 0o2777) !== 0o2770) {
        throw new Error("root controller cannot establish shared application directory modes");
      }
    } finally {
      await handle.close();
    }
  } finally {
    await fsp.rm(probe, { recursive: true, force: true });
  }
}

async function ensureRootManagedSharedApplicationDirectory(stateDir, name, operatorUid, configGid) {
  if (
    !DECLARED_STATE_SHARED_DIRECTORIES.some((entry) => entry.relativePath === name && entry.create)
  ) {
    throw new Error("root-managed shared application directory name is invalid");
  }
  const directory = path.join(stateDir, name);
  try {
    await fsp.mkdir(directory, { mode: 0o2770 });
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
  }
  const handle = await fsp.open(
    directory,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
  );
  try {
    const initial = await handle.stat();
    if (!initial.isDirectory()) {
      throw new Error(`root-managed application state path is not a directory: ${directory}`);
    }
    await handle.chown(operatorUid, configGid);
    await handle.chmod(0o2770);
    await handle.sync();
    const current = await handle.stat();
    const named = await fsp.lstat(directory);
    if (
      !named.isDirectory() ||
      named.isSymbolicLink() ||
      named.dev !== current.dev ||
      named.ino !== current.ino ||
      current.uid !== operatorUid ||
      current.gid !== configGid ||
      (current.mode & 0o2777) !== 0o2770
    ) {
      throw new Error(`root-managed shared application directory is invalid: ${directory}`);
    }
  } finally {
    await handle.close();
  }
}

async function ensureRootManagedSharedApplicationDirectories(stateDir, operatorUid, configGid) {
  for (const entry of DECLARED_STATE_SHARED_DIRECTORIES) {
    if (entry.create) {
      await ensureRootManagedSharedApplicationDirectory(
        stateDir,
        entry.relativePath,
        operatorUid,
        configGid,
      );
    }
  }
}

function declaredStatePath(stateDir, relativePath) {
  const root = path.resolve(stateDir);
  const target = relativePath === "." ? root : path.resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error("declared application state path escaped its state root");
  }
  return target;
}

async function lstatIfPresent(filePath) {
  try {
    return await fsp.lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function addDeclaredStateRule(rules, rule) {
  if (rules.has(rule.relativePath)) {
    throw new Error(`duplicate declared application state path: ${rule.relativePath}`);
  }
  rules.set(rule.relativePath, Object.freeze(rule));
  if (rules.size > DECLARED_STATE_MAX_ENTRIES) {
    throw new Error("declared application state inventory is too large");
  }
}

async function collectDeclaredStateRules(stateDir) {
  const rules = new Map();
  for (const entry of DECLARED_STATE_SHARED_DIRECTORIES) {
    addDeclaredStateRule(rules, {
      ...entry,
      kind: "directory",
      desiredMode: 0o2770,
      preserveContent: entry.preserveContent === true,
      allowSymlinks: entry.allowSymlinks === true,
    });
  }
  for (const entry of DECLARED_STATE_SHARED_FILES) {
    addDeclaredStateRule(rules, {
      ...entry,
      kind: "file",
      create: false,
      desiredMode: 0o660,
    });
  }

  const miningWalletsRoot = declaredStatePath(stateDir, "sat-mining/wallets");
  const miningWalletsStat = await lstatIfPresent(miningWalletsRoot);
  if (miningWalletsStat) {
    if (!miningWalletsStat.isDirectory() || miningWalletsStat.isSymbolicLink()) {
      throw new Error("declared Mining wallet state root is not a regular directory");
    }
    for (const walletId of await fsp.readdir(miningWalletsRoot)) {
      if (!DECLARED_STATE_SAFE_COMPONENT.test(walletId) || walletId === "." || walletId === "..") {
        continue;
      }
      const walletRelative = `sat-mining/wallets/${walletId}`;
      const walletPath = declaredStatePath(stateDir, walletRelative);
      const walletStat = await fsp.lstat(walletPath);
      if (!walletStat.isDirectory() || walletStat.isSymbolicLink()) {
        throw new Error(`declared Mining wallet state is unsafe: ${walletId}`);
      }
      addDeclaredStateRule(rules, {
        relativePath: walletRelative,
        stateClass: "mining",
        kind: "directory",
        create: false,
        desiredMode: 0o2770,
        preserveContent: false,
      });
      for (const name of DECLARED_MINING_WALLET_FILES) {
        addDeclaredStateRule(rules, {
          relativePath: `${walletRelative}/${name}`,
          stateClass: "mining",
          kind: "file",
          create: false,
          desiredMode: 0o660,
          preserveContent: name !== "mining.sqlite",
          preserveSemantic: name === "mining.sqlite",
        });
      }
    }
  }

  const validatorRoot = declaredStatePath(stateDir, "sat-mining/validator-artifacts");
  const validatorStat = await lstatIfPresent(validatorRoot);
  if (validatorStat) {
    if (!validatorStat.isDirectory() || validatorStat.isSymbolicLink()) {
      throw new Error("declared Mining validator-artifact root is not a regular directory");
    }
    for (const name of await fsp.readdir(validatorRoot)) {
      if (!DECLARED_VALIDATOR_ARTIFACT.test(name)) {
        continue;
      }
      addDeclaredStateRule(rules, {
        relativePath: `sat-mining/validator-artifacts/${name}`,
        stateClass: "mining",
        kind: "file",
        create: false,
        desiredMode: 0o660,
        preserveContent: true,
      });
    }
  }
  return [...rules.values()].toSorted((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
}

async function hashDeclaredFile(handle, stat, label) {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let offset = 0;
  while (offset < stat.size) {
    const { bytesRead } = await handle.read(
      buffer,
      0,
      Math.min(buffer.length, stat.size - offset),
      offset,
    );
    if (bytesRead <= 0) {
      throw new Error(`declared ${label} changed while being preserved`);
    }
    hash.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  const rebound = await handle.stat();
  if (
    rebound.dev !== stat.dev ||
    rebound.ino !== stat.ino ||
    rebound.size !== stat.size ||
    rebound.mtimeMs !== stat.mtimeMs
  ) {
    throw new Error(`declared ${label} changed while being preserved`);
  }
  return `sha256:${hash.digest("hex")}`;
}

async function hashDeclaredDirectoryTree(rootPath, label, { allowSymlinks = false } = {}) {
  const hash = createHash("sha256");
  let entries = 0;
  let bytes = 0;
  const update = (record) => {
    const encoded = canonicalJSON(record);
    hash.update(`${Buffer.byteLength(encoded)}:`);
    hash.update(encoded);
  };
  const walk = async (directoryPath, relativeRoot, depth) => {
    if (depth > DECLARED_STATE_TREE_MAX_DEPTH) {
      throw new Error(`declared ${label} tree exceeds the maximum directory depth`);
    }
    const directoryHandle = await fsp.open(
      directoryPath,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
    );
    try {
      const before = await directoryHandle.stat();
      if (!before.isDirectory()) {
        throw new Error(`declared ${label} tree contains a non-directory boundary`);
      }
      const children = (await fsp.readdir(directoryPath, { withFileTypes: true })).toSorted(
        (left, right) => left.name.localeCompare(right.name),
      );
      for (const child of children) {
        const childRelative = relativeRoot ? `${relativeRoot}/${child.name}` : child.name;
        if (Buffer.byteLength(childRelative) > DECLARED_STATE_TREE_MAX_PATH_BYTES) {
          throw new Error(`declared ${label} tree contains an overlong path`);
        }
        entries += 1;
        if (entries > DECLARED_STATE_TREE_MAX_ENTRIES) {
          throw new Error(`declared ${label} tree contains too many entries`);
        }
        const childPath = path.join(directoryPath, child.name);
        const named = await fsp.lstat(childPath);
        if (named.isSymbolicLink()) {
          if (!allowSymlinks) {
            throw new Error(`declared ${label} tree contains a symbolic link: ${childRelative}`);
          }
          const target = await fsp.readlink(childPath);
          update({ kind: "symlink", path: childRelative, target });
          continue;
        }
        if (named.isDirectory()) {
          update({ kind: "directory", path: childRelative });
          await walk(childPath, childRelative, depth + 1);
          continue;
        }
        if (!named.isFile() || named.nlink !== 1) {
          throw new Error(`declared ${label} tree contains an unsafe node: ${childRelative}`);
        }
        const fileHandle = await fsp.open(
          childPath,
          fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
        );
        try {
          const current = await fileHandle.stat();
          if (
            !current.isFile() ||
            current.nlink !== 1 ||
            current.dev !== named.dev ||
            current.ino !== named.ino
          ) {
            throw new Error(`declared ${label} tree changed during inventory`);
          }
          bytes += current.size;
          update({
            kind: "file",
            path: childRelative,
            size: current.size,
            sha256: await hashDeclaredFile(fileHandle, current, `${label}/${childRelative}`),
          });
        } finally {
          await fileHandle.close();
        }
      }
      const after = await directoryHandle.stat();
      if (
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.mtimeMs !== before.mtimeMs
      ) {
        throw new Error(`declared ${label} tree changed during inventory`);
      }
    } finally {
      await directoryHandle.close();
    }
  };
  await walk(rootPath, "", 0);
  return Object.freeze({
    contentHash: `sha256:${hash.digest("hex")}`,
    treeEntries: entries,
    treeBytes: bytes,
  });
}

function miningLedgerSemanticSnapshot(filePath) {
  const database = new DatabaseSync(filePath, { readOnly: true });
  try {
    database.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;");
    const tables = new Set(
      database
        .prepare(
          `SELECT name FROM sqlite_master
            WHERE type='table' AND name NOT LIKE 'sqlite_%'
            ORDER BY name`,
        )
        .all()
        .map((row) => String(row.name)),
    );
    const scalar = (sql, field = "value") => {
      try {
        const row = database.prepare(sql).get();
        return Number(row?.[field] ?? 0);
      } catch {
        return 0;
      }
    };
    const textMeta = (key) => {
      if (!tables.has("mining_meta")) {
        return null;
      }
      const row = database.prepare("SELECT value FROM mining_meta WHERE key=?").get(key);
      return row?.value == null ? null : String(row.value);
    };
    const tableCount = (name) =>
      tables.has(name) ? scalar(`SELECT COUNT(*) AS count FROM "${name}"`, "count") : 0;
    const tableMax = (name, column) =>
      tables.has(name)
        ? scalar(`SELECT COALESCE(MAX("${column}"), 0) AS maximum FROM "${name}"`, "maximum")
        : 0;
    const historyHeads = tables.has("mining_meta")
      ? database
          .prepare(
            `SELECT key, value FROM mining_meta
              WHERE key LIKE 'history_head:%'
              ORDER BY key`,
          )
          .all()
          .map((row) => ({ key: String(row.key), digest: String(row.value) }))
      : [];
    return Object.freeze({
      schemaVersion: Number(textMeta("schema_version") ?? 0),
      historyRevision: Number(textMeta("history_revision") ?? 0),
      walletBindings: tableCount("wallet_binding"),
      chainScopes: tableCount("chain_scope"),
      historyScopes: tableCount("history_scope"),
      miningEvents: tableCount("mining_event"),
      miningEventSequence: tableMax("mining_event", "sequence"),
      plannerOutcomes: tableCount("planner_outcome"),
      plannerOutcomeSequence: tableMax("planner_outcome", "sequence"),
      plannerCycles: tableCount("planner_cycle"),
      plannerCycleSequence: tableMax("planner_cycle", "sequence"),
      roundExecutions: tableCount("round_execution"),
      pendingPlannerCycles: tableCount("pending_planner_cycle"),
      claimBacklog: tableCount("claim_backlog"),
      settlementState: tableCount("settlement_state"),
      submissionRecords: tableCount("submission_record"),
      auditArtifacts: tableCount("audit_artifact"),
      deletionReceipts: tableCount("history_deletion_receipt"),
      historyHeads,
    });
  } finally {
    database.close();
  }
}

function miningLedgerSemanticDigest(snapshot) {
  return `sha256:${createHash("sha256").update(canonicalJSON(snapshot)).digest("hex")}`;
}

function assertMiningLedgerSemanticPreserved(entryPath, before, after) {
  for (const field of [
    "walletBindings",
    "chainScopes",
    "historyScopes",
    "miningEvents",
    "miningEventSequence",
    "plannerOutcomes",
    "plannerOutcomeSequence",
    "plannerCycles",
    "plannerCycleSequence",
    "roundExecutions",
    "pendingPlannerCycles",
    "claimBacklog",
    "settlementState",
    "submissionRecords",
    "auditArtifacts",
    "deletionReceipts",
  ]) {
    if (Number(after[field] ?? 0) < Number(before[field] ?? 0)) {
      throw new Error(`declared Mining ledger lost ${field}: ${entryPath}`);
    }
  }
  const database = new DatabaseSync(entryPath, { readOnly: true });
  try {
    database.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;");
    for (const head of before.historyHeads ?? []) {
      const [prefix, scopeId, kind] = String(head.key).split(":");
      const table =
        kind === "action"
          ? "mining_event"
          : kind === "outcome"
            ? "planner_outcome"
            : kind === "planner-cycle"
              ? "planner_cycle"
              : null;
      if (prefix !== "history_head" || !table || !/^\d+$/u.test(scopeId || "")) {
        throw new Error(`declared Mining ledger head is invalid: ${entryPath}`);
      }
      const found = database
        .prepare(`SELECT 1 AS found FROM "${table}" WHERE scope_id=? AND event_digest=? LIMIT 1`)
        .get(Number(scopeId), head.digest);
      if (Number(found?.found ?? 0) !== 1) {
        throw new Error(`declared Mining ledger history chain was truncated: ${entryPath}`);
      }
    }
  } finally {
    database.close();
  }
}

async function inspectDeclaredStateRule(stateDir, rule) {
  const entryPath = declaredStatePath(stateDir, rule.relativePath);
  const named = await lstatIfPresent(entryPath);
  if (!named) {
    return {
      relativePath: rule.relativePath,
      stateClass: rule.stateClass,
      kind: rule.kind,
      create: rule.create === true,
      desiredMode: rule.desiredMode,
      preserveContent: rule.preserveContent === true,
      preserveSemantic: rule.preserveSemantic === true,
      allowSymlinks: rule.allowSymlinks === true,
      existed: false,
    };
  }
  if (
    named.isSymbolicLink() ||
    (rule.kind === "directory" ? !named.isDirectory() : !named.isFile()) ||
    (rule.kind === "file" && named.nlink !== 1)
  ) {
    throw new Error(`declared ${rule.stateClass} path is unsafe: ${rule.relativePath}`);
  }
  const flags =
    fs.constants.O_RDONLY |
    fs.constants.O_NOFOLLOW |
    (rule.kind === "directory" ? fs.constants.O_DIRECTORY : 0);
  const handle = await fsp.open(entryPath, flags);
  try {
    const current = await handle.stat();
    const rebound = await fsp.lstat(entryPath);
    if (
      rebound.isSymbolicLink() ||
      rebound.dev !== current.dev ||
      rebound.ino !== current.ino ||
      current.dev !== named.dev ||
      current.ino !== named.ino ||
      (rule.kind === "directory" ? !current.isDirectory() : !current.isFile()) ||
      (rule.kind === "file" && current.nlink !== 1)
    ) {
      throw new Error(`declared ${rule.stateClass} changed during inventory`);
    }
    return {
      relativePath: rule.relativePath,
      stateClass: rule.stateClass,
      kind: rule.kind,
      create: rule.create === true,
      desiredMode: rule.desiredMode,
      preserveContent: rule.preserveContent === true,
      preserveSemantic: rule.preserveSemantic === true,
      allowSymlinks: rule.allowSymlinks === true,
      existed: true,
      uid: current.uid,
      gid: current.gid,
      mode: current.mode & 0o7777,
      dev: current.dev,
      ino: current.ino,
      nlink: current.nlink,
      ...(rule.preserveContent
        ? rule.kind === "directory"
          ? await hashDeclaredDirectoryTree(entryPath, rule.relativePath, {
              allowSymlinks: rule.allowSymlinks === true,
            })
          : { contentHash: await hashDeclaredFile(handle, current, rule.relativePath) }
        : {}),
      ...(rule.preserveSemantic
        ? (() => {
            const semanticState = miningLedgerSemanticSnapshot(entryPath);
            return {
              semanticState,
              semanticHash: miningLedgerSemanticDigest(semanticState),
            };
          })()
        : {}),
    };
  } finally {
    await handle.close();
  }
}

function declaredStatePreservationHash(entries) {
  return `sha256:${createHash("sha256")
    .update(
      canonicalJSON(
        entries
          .filter((entry) => entry.preserveContent || entry.preserveSemantic)
          .map((entry) => ({
            relativePath: entry.relativePath,
            existed: entry.existed,
            contentHash: entry.contentHash ?? null,
            semanticHash: entry.semanticHash ?? null,
          })),
      ),
    )
    .digest("hex")}`;
}

function declaredStateClassPreservationHashes(entries) {
  const byClass = new Map();
  for (const entry of entries.filter(
    (candidate) => candidate.preserveContent || candidate.preserveSemantic,
  )) {
    const records = byClass.get(entry.stateClass) ?? [];
    records.push({
      relativePath: entry.relativePath,
      existed: entry.existed,
      contentHash: entry.contentHash ?? null,
      semanticHash: entry.semanticHash ?? null,
    });
    byClass.set(entry.stateClass, records);
  }
  return Object.freeze(
    Object.fromEntries(
      [...byClass.entries()]
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([stateClass, records]) => [
          stateClass,
          `sha256:${createHash("sha256").update(canonicalJSON(records)).digest("hex")}`,
        ]),
    ),
  );
}

async function inventoryDeclaredApplicationState(topology, context) {
  if (topology.pendingGatewayUnit || topology.pendingStateDir) {
    return null;
  }
  const registry = declaredStateRegistry(topology, context);
  const rules = await collectDeclaredStateRules(topology.stateDir);
  const entries = [];
  for (const rule of rules) {
    entries.push(await inspectDeclaredStateRule(topology.stateDir, rule));
  }
  const registryDigest = `sha256:${createHash("sha256")
    .update(canonicalJSON(registry))
    .digest("hex")}`;
  const converged = entries.every(
    (entry) =>
      (!entry.create || entry.existed) &&
      (!entry.existed ||
        (entry.gid === topology.configGroup.gid && entry.mode === entry.desiredMode)),
  );
  return {
    schemaVersion: DECLARED_STATE_SCHEMA_VERSION,
    profile: topology.profile,
    stateDir: topology.stateDir,
    operatorUid: topology.operator.uid,
    configGid: topology.configGroup.gid,
    registryDigest,
    preservationHash: declaredStatePreservationHash(entries),
    preservationHashes: declaredStateClassPreservationHashes(entries),
    converged,
    reconciled: false,
    entries,
  };
}

async function openDeclaredStateEntry(transaction, entry) {
  const entryPath = declaredStatePath(transaction.stateDir, entry.relativePath);
  const flags =
    fs.constants.O_RDONLY |
    fs.constants.O_NOFOLLOW |
    (entry.kind === "directory" ? fs.constants.O_DIRECTORY : 0);
  const handle = await fsp.open(entryPath, flags);
  const current = await handle.stat();
  const named = await fsp.lstat(entryPath);
  if (
    named.isSymbolicLink() ||
    named.dev !== current.dev ||
    named.ino !== current.ino ||
    (entry.kind === "directory" ? !current.isDirectory() : !current.isFile()) ||
    (entry.kind === "file" && current.nlink !== 1)
  ) {
    await handle.close();
    throw new Error(`declared ${entry.stateClass} changed during reconciliation`);
  }
  if (entry.existed && (current.dev !== entry.dev || current.ino !== entry.ino)) {
    await handle.close();
    throw new Error(`declared ${entry.stateClass} inode changed during reconciliation`);
  }
  return { entryPath, handle, current };
}

async function reconcileDeclaredApplicationState(transaction) {
  if (!transaction) {
    return { changed: false, reconciled: false };
  }
  const changedEntries = [];
  for (const entry of transaction.entries) {
    const entryPath = declaredStatePath(transaction.stateDir, entry.relativePath);
    if (!entry.existed) {
      if (!entry.create) {
        continue;
      }
      await fsp.mkdir(entryPath, { mode: entry.desiredMode });
    }
    const opened = await openDeclaredStateEntry(transaction, entry);
    try {
      const desiredUid = entry.existed ? entry.uid : transaction.operatorUid;
      if (
        opened.current.uid !== desiredUid ||
        opened.current.gid !== transaction.configGid ||
        (opened.current.mode & 0o7777) !== entry.desiredMode
      ) {
        await opened.handle.chown(desiredUid, transaction.configGid);
        await opened.handle.chmod(entry.desiredMode);
        await opened.handle.sync();
        changedEntries.push(entry.relativePath);
      }
    } finally {
      await opened.handle.close();
    }
  }
  await fsyncDirectory(transaction.stateDir);
  return {
    changed: changedEntries.length > 0,
    reconciled: true,
    changedEntries,
  };
}

function declaredConfigEntry(transaction) {
  return transaction?.entries?.find(
    (entry) => entry.kind === "file" && entry.relativePath === "fased.json",
  );
}

async function snapshotDeclaredApplicationState(transaction, txPaths) {
  const entry = declaredConfigEntry(transaction);
  if (!entry?.existed) {
    return { snapshotted: false };
  }
  if (!entry.preserveContent || !/^sha256:[a-f0-9]{64}$/u.test(entry.contentHash || "")) {
    throw new Error("declared application configuration has no preservation identity");
  }
  const entryPath = declaredStatePath(transaction.stateDir, entry.relativePath);
  await atomicCopyFileDurable(entryPath, txPaths.configSnapshotPath, { mode: 0o600 });
  const snapshot = await fsp.open(
    txPaths.configSnapshotPath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    const stat = await snapshot.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (await hashDeclaredFile(snapshot, stat, "fased.json rollback snapshot")) !== entry.contentHash
    ) {
      throw new Error("declared application configuration changed during snapshot");
    }
  } finally {
    await snapshot.close();
  }
  return { snapshotted: true, contentHash: entry.contentHash };
}

async function restoreDeclaredApplicationState(transaction, txPaths = null) {
  if (!transaction) {
    return { restored: false };
  }
  const rollbackErrors = [];
  for (const entry of [...transaction.entries].toReversed()) {
    const entryPath = declaredStatePath(transaction.stateDir, entry.relativePath);
    try {
      const restoringConfig = entry.kind === "file" && entry.relativePath === "fased.json";
      if (restoringConfig) {
        if (!entry.existed) {
          await fsp.rm(entryPath, { force: true });
          continue;
        }
        if (txPaths?.configSnapshotPath) {
          const snapshot = await fsp.open(
            txPaths.configSnapshotPath,
            fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
          );
          try {
            const stat = await snapshot.stat();
            if (
              !stat.isFile() ||
              stat.nlink !== 1 ||
              (await hashDeclaredFile(snapshot, stat, "fased.json rollback snapshot")) !==
                entry.contentHash
            ) {
              throw new Error("declared application configuration snapshot is invalid");
            }
          } finally {
            await snapshot.close();
          }
          await atomicCopyFileDurable(txPaths.configSnapshotPath, entryPath, {
            mode: entry.mode,
            uid: entry.uid,
            gid: entry.gid,
          });
        } else {
          const opened = await openDeclaredStateEntry(transaction, entry);
          try {
            if (
              (await hashDeclaredFile(opened.handle, opened.current, entry.relativePath)) !==
              entry.contentHash
            ) {
              throw new Error("declared application configuration changed without a snapshot");
            }
          } finally {
            await opened.handle.close();
          }
        }
      }
      if (!entry.existed) {
        if (entry.create) {
          await fsp.rmdir(entryPath).catch((error) => {
            if (error?.code !== "ENOENT" && error?.code !== "ENOTEMPTY") {
              throw error;
            }
          });
        }
        continue;
      }
      const opened = await openDeclaredStateEntry(transaction, { ...entry, existed: false });
      try {
        await opened.handle.chown(entry.uid, entry.gid);
        await opened.handle.chmod(entry.mode);
        await opened.handle.sync();
      } finally {
        await opened.handle.close();
      }
    } catch (error) {
      rollbackErrors.push(error);
    }
  }
  if (rollbackErrors.length > 0) {
    const error = new Error("declared application-state metadata rollback is incomplete");
    error.rollbackErrors = rollbackErrors;
    throw error;
  }
  await fsyncDirectory(transaction.stateDir);
  return { restored: true };
}

async function verifyDeclaredStatePreservation(transaction) {
  if (!transaction) {
    return { ok: true, preservationHash: null, preservationHashes: {} };
  }
  const preserved = [];
  for (const entry of transaction.entries.filter(
    (candidate) => candidate.preserveContent || candidate.preserveSemantic,
  )) {
    const current = await inspectDeclaredStateRule(transaction.stateDir, entry);
    if (entry.preserveSemantic && entry.existed) {
      if (!current.existed || !current.semanticState) {
        throw new Error(`declared Mining ledger disappeared: ${entry.relativePath}`);
      }
      assertMiningLedgerSemanticPreserved(
        declaredStatePath(transaction.stateDir, entry.relativePath),
        entry.semanticState,
        current.semanticState,
      );
      preserved.push({
        ...current,
        semanticState: entry.semanticState,
        semanticHash: entry.semanticHash,
      });
    } else if (!entry.existed && entry.create && current.existed) {
      // A declared shared-state root can be absent on an older or fresh
      // topology. Reconciliation creates that root before the target signer or
      // Gateway initializes it. There is no predecessor content to compare in
      // that case, so retain the inventoried absence in the preservation
      // receipt while still inspecting the new path above for type/symlink
      // safety. Pre-existing roots continue to require exact content hashes.
      preserved.push({
        ...current,
        existed: false,
        contentHash: null,
        semanticHash: null,
      });
    } else {
      preserved.push(current);
    }
  }
  const preservationHash = declaredStatePreservationHash(preserved);
  if (preservationHash !== transaction.preservationHash) {
    const expectedByPath = new Map(
      transaction.entries
        .filter((entry) => entry.preserveContent || entry.preserveSemantic)
        .map((entry) => [entry.relativePath, entry]),
    );
    const changedPaths = preserved
      .filter((entry) => {
        const expected = expectedByPath.get(entry.relativePath);
        return (
          !expected ||
          entry.existed !== expected.existed ||
          (entry.contentHash ?? null) !== (expected.contentHash ?? null) ||
          (entry.semanticHash ?? null) !== (expected.semanticHash ?? null)
        );
      })
      .map((entry) => entry.relativePath)
      .slice(0, 8);
    const detail = changedPaths.length > 0 ? `: ${changedPaths.join(", ")}` : "";
    throw new Error(`declared user state changed during the lifecycle transaction${detail}`);
  }
  const preservationHashes = declaredStateClassPreservationHashes(preserved);
  const expectedHashes =
    transaction.preservationHashes ?? declaredStateClassPreservationHashes(transaction.entries);
  if (canonicalJSON(preservationHashes) !== canonicalJSON(expectedHashes)) {
    throw new Error("declared user state class changed during the lifecycle transaction");
  }
  return { ok: true, preservationHash, preservationHashes };
}

function rootManagedApplicationIdentity(context, unit) {
  const protectedLocal = Boolean(context.instanceId);
  const gatewayUnitPath = protectedLocal
    ? context.paths.gatewayUnitPath
    : "/etc/systemd/system/fased-gateway.service";
  const gatewayUser = exactUnitValue(unit, "User");
  const stateDir = protectedLocal
    ? exactUnitValue(unit, "Environment=FASED_STATE_DIR")
    : path.join(exactUnitValue(unit, "Environment=HOME"), ".fased");
  const configGroup = protectedLocal ? `fscf-${context.instanceId}` : "fased-config";
  const expectedGatewayUser = protectedLocal ? `fsgw-${context.instanceId}` : "fased-gateway";
  const supplementaryGroups = exactUnitValue(unit, "SupplementaryGroups").split(/\s+/u);
  if (
    gatewayUser !== expectedGatewayUser ||
    !supplementaryGroups.includes(configGroup) ||
    !path.isAbsolute(stateDir) ||
    path.basename(stateDir) !== ".fased" ||
    (!protectedLocal && exactUnitValue(unit, "Environment=FASED_HOST_PROFILE") !== "hosting")
  ) {
    throw new Error("root-managed Gateway application-state identity is invalid");
  }
  return { configGroup, gatewayUnitPath, gatewayUser, protectedLocal, stateDir };
}

async function readDeclaredJsonSchema(
  filePath,
  { schemaField = "schemaVersion", fallbackField = "version", maximum = 2 } = {},
) {
  const stat = await lstatIfPresent(filePath);
  if (!stat) {
    return null;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 2 * 1024 * 1024) {
    throw new Error(`declared state schema source is unsafe: ${filePath}`);
  }
  let value;
  try {
    value = JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`declared state schema source is invalid: ${filePath}`, { cause: error });
  }
  const schema = value?.[schemaField] ?? value?.[fallbackField];
  if (!Number.isSafeInteger(schema) || schema < 1 || schema > maximum) {
    throw new Error(`declared state schema is unsupported: ${filePath}`);
  }
  return schema;
}

async function discoverProtectedApplicationTopology(context) {
  const protectedLocal = Boolean(context.instanceId);
  const gatewayUnitPath = protectedLocal
    ? context.paths.gatewayUnitPath
    : "/etc/systemd/system/fased-gateway.service";
  const gatewayUnit = await fileMetadata(gatewayUnitPath);
  if (!gatewayUnit.existed && !protectedLocal) {
    // Fresh Hosting prepares the signer before the root Gateway unit exists.
    // The installer reconciles the state immediately after it creates that unit.
    return {
      schemaVersion: 1,
      pendingGatewayUnit: true,
      profile: "hosting",
    };
  }
  if (
    !gatewayUnit.existed ||
    gatewayUnit.uid !== context.rootUid ||
    (gatewayUnit.mode & 0o022) !== 0
  ) {
    throw new Error("root-managed Gateway unit is not root-controlled");
  }
  const unit = await fsp.readFile(gatewayUnitPath, "utf8");
  const identity = rootManagedApplicationIdentity(context, unit);
  const { configGroup, gatewayUser, stateDir } = identity;
  let stateStat;
  try {
    stateStat = await fsp.lstat(stateDir);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
    // A fresh or interrupted Hosting bootstrap can leave the root-controlled
    // Gateway unit in place before the app-owned state directory is recreated.
    // The installer establishes and reconciles that directory before starting
    // the Gateway, so signer preparation must remain non-mutating here.
    return {
      schemaVersion: 1,
      pendingStateDir: true,
      profile: protectedLocal ? "protected-local" : "hosting",
      stateDir,
    };
  }
  if (!stateStat.isDirectory() || stateStat.isSymbolicLink() || stateStat.uid === context.rootUid) {
    throw new Error("root-managed application state directory is invalid");
  }
  const operatorFields = await systemAccountRecord("passwd", String(stateStat.uid));
  const gatewayFields = await systemAccountRecord("passwd", gatewayUser);
  const groupFields = await systemAccountRecord("group", configGroup);
  const configGid = Number(groupFields[2]);
  const gatewayUid = Number(gatewayFields[2]);
  const gatewayGid = Number(gatewayFields[3]);
  const operatorUid = Number(operatorFields[2]);
  const operatorGid = Number(operatorFields[3]);
  const operatorHome = String(operatorFields[5] || "");
  const members = new Set(
    String(groupFields[3] || "")
      .split(",")
      .filter(Boolean),
  );
  if (
    !Number.isSafeInteger(configGid) ||
    configGid <= 0 ||
    !Number.isSafeInteger(gatewayUid) ||
    gatewayUid <= 0 ||
    !Number.isSafeInteger(gatewayGid) ||
    gatewayGid <= 0 ||
    !Number.isSafeInteger(operatorUid) ||
    operatorUid !== stateStat.uid ||
    !Number.isSafeInteger(operatorGid) ||
    operatorGid <= 0 ||
    !path.isAbsolute(operatorHome) ||
    path.dirname(stateDir) !== path.resolve(operatorHome) ||
    !members.has(operatorFields[0]) ||
    !members.has(gatewayFields[0])
  ) {
    throw new Error("root-managed application-state group membership is invalid");
  }
  const [managedInstallSchema, walletRegistrySchema] = await Promise.all([
    readDeclaredJsonSchema(path.join(stateDir, "install.json"), {
      schemaField: "schemaVersion",
      maximum: 2,
    }),
    readDeclaredJsonSchema(path.join(stateDir, "wallet", "provider-registry.v1.json"), {
      schemaField: "version",
      fallbackField: "version",
      maximum: 1,
    }),
  ]);
  return Object.freeze({
    schemaVersion: 1,
    profile: protectedLocal ? "protected-local" : "hosting",
    managedApplication: true,
    instanceId: protectedLocal ? context.instanceId : null,
    stateDir,
    configPath: path.join(stateDir, "fased.json"),
    operator: Object.freeze({
      name: operatorFields[0],
      uid: operatorUid,
      gid: operatorGid,
      home: operatorHome,
    }),
    gateway: Object.freeze({
      user: gatewayUser,
      uid: gatewayUid,
      gid: gatewayGid,
      unitPath: gatewayUnitPath,
    }),
    configGroup: Object.freeze({
      name: configGroup,
      gid: configGid,
    }),
    services: Object.freeze({
      gateway: protectedLocal
        ? `fased-gateway-${context.instanceId}.service`
        : "fased-gateway.service",
      signer: protectedLocal
        ? `fased-signerd-${context.instanceId}.service`
        : "fased-signerd.service",
    }),
    gatewayLauncherPath: protectedLocal
      ? context.paths.gatewayLauncherPath
      : "/usr/local/libexec/fased-gateway-launch",
    capabilities: Object.freeze({
      lifecycleControllerProtocol: CONTROLLER_PROTOCOL_VERSION,
      signerProtocol: Object.freeze({ current: 2, min: 2, max: 2 }),
      declaredStateRegistry: DECLARED_STATE_SCHEMA_VERSION,
    }),
    stateSchemas: Object.freeze({
      managedInstall: managedInstallSchema,
      walletRegistry: walletRegistrySchema,
      signer: 2,
      mining: 1,
      federation: 2,
    }),
  });
}

function managedApplicationStateFromTopology(topology) {
  if (!topology) {
    return null;
  }
  if (topology.pendingGatewayUnit || topology.pendingStateDir) {
    return topology ?? null;
  }
  if (topology.managedApplication === false) {
    return null;
  }
  return Object.freeze({
    profile: topology.profile,
    stateDir: topology.stateDir,
    operatorUid: topology.operator.uid,
    operatorGid: topology.operator.gid,
    configGid: topology.configGroup.gid,
    gatewayServiceName: topology.services.gateway,
    gatewayLauncherPath: topology.gatewayLauncherPath,
  });
}

function managedApplicationPaths(stateDir) {
  const root = path.resolve(String(stateDir ?? ""));
  if (!path.isAbsolute(root) || path.basename(root) !== ".fased") {
    throw new Error("root-managed application state path is invalid");
  }
  const runtimeDir = path.join(root, "runtime");
  const prefix = path.join(root, "install-cache", "npm-global");
  const binDir = path.join(root, "bin");
  const updaterDir = path.join(root, "updater");
  return Object.freeze({
    stateDir: root,
    manifestPath: path.join(root, "install.json"),
    runtimeDir,
    stagedReleasesDir: path.join(runtimeDir, "releases"),
    currentLink: path.join(runtimeDir, "current"),
    previousLink: path.join(runtimeDir, "previous"),
    compatibilityLink: path.join(prefix, "lib", "node_modules", "@fased", "fased"),
    binDir,
    launcherPath: path.join(binDir, "fased"),
    serviceLauncherPath: path.join(binDir, "fased-service"),
    updaterDir,
    updaterPath: path.join(updaterDir, "fased-managed-updater.mjs"),
    prefix,
    prefixLauncherPath: path.join(prefix, "bin", "fased"),
  });
}

function validateManagedUpdaterGenerationTransaction(value, paths) {
  if (value == null) {
    return null;
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).toSorted().join(",") !==
      "bundleDigest,previousGenerationDir,targetGenerationDir" ||
    !/^sha256:[a-f0-9]{64}$/u.test(value.bundleDigest || "")
  ) {
    throw new Error("root-managed updater generation transaction is invalid");
  }
  const generationsDir = path.join(paths.updaterDir, "generations");
  const targetGenerationDir = path.resolve(String(value.targetGenerationDir ?? ""));
  const previousGenerationDir =
    value.previousGenerationDir == null
      ? null
      : path.resolve(String(value.previousGenerationDir ?? ""));
  const insideGenerationRoot = (candidate) =>
    candidate !== generationsDir && candidate.startsWith(`${generationsDir}${path.sep}`);
  if (
    !insideGenerationRoot(targetGenerationDir) ||
    path.basename(targetGenerationDir) !== value.bundleDigest.slice("sha256:".length) ||
    (previousGenerationDir !== null && !insideGenerationRoot(previousGenerationDir))
  ) {
    throw new Error("root-managed updater generation escaped its generation root");
  }
  return Object.freeze({
    bundleDigest: value.bundleDigest,
    targetGenerationDir,
    previousGenerationDir,
  });
}

async function loadManagedUpdaterBundleModule(targetRoot) {
  const modulePath = path.join(path.resolve(targetRoot), "scripts", "managed-updater-bundle.mjs");
  const stat = await fsp.lstat(modulePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error("target managed updater bundle module is unsafe");
  }
  const imported = await import(
    `${pathToFileURL(modulePath).href}?target-controller=${encodeURIComponent(targetRoot)}`
  );
  for (const name of [
    "stageManagedUpdaterGeneration",
    "activateManagedUpdaterGeneration",
    "restoreManagedUpdaterGeneration",
  ]) {
    if (typeof imported[name] !== "function") {
      throw new Error(`target managed updater bundle module omits ${name}`);
    }
  }
  return imported;
}

async function stageTargetManagedUpdaterGeneration(paths, targetRoot) {
  const bundle = await loadManagedUpdaterBundleModule(targetRoot);
  const generation = await bundle.stageManagedUpdaterGeneration({
    updaterDir: paths.updaterDir,
    runtimeRoot: targetRoot,
    durable: true,
    activate: false,
  });
  return validateManagedUpdaterGenerationTransaction(
    {
      bundleDigest: generation.bundleDigest,
      targetGenerationDir: generation.generationDir,
      previousGenerationDir: generation.previousGenerationDir,
    },
    paths,
  );
}

async function readOptionalLink(linkPath) {
  try {
    const info = await fsp.lstat(linkPath);
    if (!info.isSymbolicLink()) {
      throw new Error(`managed application selector is not a symlink: ${linkPath}`);
    }
    return await fsp.realpath(linkPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function validateManagedInstallManifest(value, applicationState, paths) {
  const expectedProfile = applicationState.profile;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !new Set([1, 2]).has(value.schemaVersion) ||
    value.profile !== expectedProfile ||
    path.resolve(String(value.stateDir ?? "")) !== paths.stateDir ||
    path.resolve(String(value.configPath ?? "")) !== path.join(paths.stateDir, "fased.json") ||
    value.service?.scope !== "system" ||
    typeof value.runtime?.activeVersion !== "string"
  ) {
    throw new Error("root-managed application install manifest is invalid");
  }
  return value;
}

function buildTargetManagedInstallManifest({
  previousManifest,
  applicationState,
  paths,
  releasesDir,
  version,
  applicationRelease,
  updaterBundleDigest,
  updateChannel,
}) {
  const base =
    previousManifest ??
    Object.freeze({
      profile: applicationState.profile,
      stateDir: paths.stateDir,
      configPath: path.join(paths.stateDir, "fased.json"),
      service: {
        name: applicationState.gatewayServiceName,
        scope: "system",
        launcher: applicationState.gatewayLauncherPath,
      },
      update: { channel: updateChannel },
    });
  return {
    ...base,
    schemaVersion: 2,
    source: "managed-artifact",
    runtime: {
      ...previousManifest?.runtime,
      activeVersion: version,
      previousVersion:
        previousManifest?.runtime?.activeVersion === version
          ? (previousManifest.runtime.previousVersion ?? null)
          : (previousManifest?.runtime?.activeVersion ?? null),
      currentLink: paths.currentLink,
      previousLink: paths.previousLink,
      releasesDir,
      dependencyHash: applicationRelease.dependencies.dependencyHash,
      releaseManifestDigest: applicationRelease.manifestDigest,
      appCommit: applicationRelease.commit,
      appArtifact: applicationRelease.artifact.asset,
      appArtifactDigest: `sha256:${applicationRelease.artifact.sha256}`,
    },
    package: {
      prefix: paths.prefix,
      compatibilityRoot: paths.compatibilityLink,
    },
    updater: {
      version,
      path: paths.updaterPath,
      bundleDigest: updaterBundleDigest,
    },
    update: {
      ...base.update,
      channel: updateChannel,
    },
    release: {
      version,
      commit: applicationRelease.commit,
      manifestDigest: applicationRelease.manifestDigest,
      application: {
        artifact: applicationRelease.artifact.asset,
        digest: `sha256:${applicationRelease.artifact.sha256}`,
        dependencies: {
          artifact: applicationRelease.dependencies.asset,
          digest: `sha256:${applicationRelease.dependencies.sha256}`,
          dependencyHash: applicationRelease.dependencies.dependencyHash,
        },
      },
      signer: {
        release: applicationRelease.signer,
        capabilities: applicationRelease.capabilities,
        capabilitiesDigest: applicationRelease.capabilitiesDigest,
      },
    },
    signer: { release: applicationRelease.signer },
    updatedAt: new Date().toISOString(),
  };
}

async function prepareManagedApplicationTransaction(
  context,
  version,
  application,
  applicationRelease,
) {
  const state = context.applicationState;
  if (
    !state?.stateDir ||
    !Number.isSafeInteger(state.operatorUid) ||
    !Number.isSafeInteger(state.operatorGid) ||
    !Number.isSafeInteger(state.configGid)
  ) {
    return null;
  }
  if (!application || !applicationRelease) {
    throw new Error("target lifecycle controller did not stage the application release");
  }
  const paths = managedApplicationPaths(state.stateDir);
  let previousManifest = null;
  try {
    previousManifest = validateManagedInstallManifest(
      JSON.parse(await fsp.readFile(paths.manifestPath, "utf8")),
      state,
      paths,
    );
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  const previousRoot = await readOptionalLink(paths.currentLink);
  if (Boolean(previousManifest) !== Boolean(previousRoot)) {
    throw new Error("root-managed application manifest and active runtime are inconsistent");
  }
  const previousPreviousRoot = await readOptionalLink(paths.previousLink);
  if (!previousManifest && previousPreviousRoot) {
    throw new Error("empty root-managed application has an unexpected previous selector");
  }
  const targetRoot = path.resolve(application.targetRoot);
  if (targetRoot !== protectedApplicationReleaseRoot(context.paths, version)) {
    throw new Error("target lifecycle controller application identity is mismatched");
  }
  await verifyProtectedApplicationRuntime(
    targetRoot,
    version,
    applicationRelease.commit,
    applicationRelease.dependencies.dependencyHash,
  );
  await fsp.mkdir(paths.updaterDir, { recursive: true, mode: 0o750 });
  const updaterDirectory = await fsp.lstat(paths.updaterDir);
  if (
    !updaterDirectory.isDirectory() ||
    updaterDirectory.isSymbolicLink() ||
    (!previousManifest &&
      (updaterDirectory.uid !== context.rootUid || (updaterDirectory.mode & 0o022) !== 0))
  ) {
    throw new Error("root-managed updater directory is unsafe");
  }
  const updaterGeneration = await context.stageUpdaterGeneration(paths, targetRoot);
  if (!previousManifest) {
    // The root controller creates and verifies the first immutable generation.
    // Fresh onboarding then runs as the trusted operator, which must be able to
    // install only the compatibility selector/files around that generation.
    // The Gateway is not a member of the operator group and remains unable to
    // mutate this directory.
    await fsp.chown(paths.updaterDir, state.operatorUid, state.operatorGid);
    await fsp.chmod(paths.updaterDir, 0o750);
    await fsyncDirectory(paths.updaterDir);
  }
  let updateChannel = "stable";
  try {
    const configured = (await fsp.readFile(context.paths.channelPath, "utf8")).trim();
    if (!new Set(["stable", "beta"]).has(configured)) {
      throw new Error("root-managed update channel is invalid");
    }
    updateChannel = configured;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  if (
    !previousManifest &&
    (!state.gatewayServiceName ||
      !state.gatewayLauncherPath ||
      !path.isAbsolute(state.gatewayLauncherPath))
  ) {
    throw new Error("empty root-managed application service identity is unavailable");
  }
  return Object.freeze({
    profile: state.profile,
    stateDir: paths.stateDir,
    previousRoot,
    previousPreviousRoot,
    previousManifest,
    updaterGeneration,
    nextManifest: buildTargetManagedInstallManifest({
      previousManifest,
      applicationState: state,
      paths,
      releasesDir: context.paths.applicationReleasesDir,
      version,
      applicationRelease,
      updaterBundleDigest: updaterGeneration.bundleDigest,
      updateChannel: previousManifest?.update?.channel ?? updateChannel,
    }),
  });
}

function validateManagedApplicationTransaction(value, context, version) {
  if (value == null) {
    return null;
  }
  const state = context.applicationState;
  if (!state?.stateDir) {
    throw new Error("host updater managed application state is unavailable");
  }
  const paths = managedApplicationPaths(state.stateDir);
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !new Set([
      "nextManifest,previousManifest,previousPreviousRoot,previousRoot,profile,stateDir",
      "nextManifest,previousManifest,previousPreviousRoot,previousRoot,profile,stateDir,updaterGeneration",
    ]).has(Object.keys(value).toSorted().join(",")) ||
    value.profile !== state.profile ||
    path.resolve(String(value.stateDir ?? "")) !== paths.stateDir
  ) {
    throw new Error("host updater managed application transaction is invalid");
  }
  const previousManifest =
    value.previousManifest == null
      ? null
      : validateManagedInstallManifest(value.previousManifest, state, paths);
  const nextManifest = validateManagedInstallManifest(value.nextManifest, state, paths);
  const expectedPreviousVersion =
    previousManifest?.runtime?.activeVersion === version
      ? (previousManifest.runtime.previousVersion ?? null)
      : (previousManifest?.runtime?.activeVersion ?? null);
  if (
    nextManifest.runtime.activeVersion !== version ||
    nextManifest.runtime.previousVersion !== expectedPreviousVersion ||
    nextManifest.release?.version !== version
  ) {
    throw new Error("host updater target application manifest is mismatched");
  }
  const previousRoot =
    value.previousRoot == null ? null : path.resolve(String(value.previousRoot ?? ""));
  if (Boolean(previousManifest) !== Boolean(previousRoot)) {
    throw new Error("host updater previous managed application identity is inconsistent");
  }
  const previousPreviousRoot =
    value.previousPreviousRoot == null ? null : path.resolve(String(value.previousPreviousRoot));
  const updaterGeneration = validateManagedUpdaterGenerationTransaction(
    value.updaterGeneration,
    paths,
  );
  return Object.freeze({
    profile: value.profile,
    stateDir: paths.stateDir,
    previousRoot,
    previousPreviousRoot,
    previousManifest,
    nextManifest,
    updaterGeneration,
  });
}

async function writeManagedManifest(context, transaction, manifest) {
  const state = context.applicationState;
  const paths = managedApplicationPaths(transaction.stateDir);
  await atomicWriteFileDurable(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 0o660);
  await fsp.chown(paths.manifestPath, state.operatorUid, state.configGid);
  await fsyncDirectory(paths.stateDir);
}

async function ensureInitializedManagedStableDirectories(context, paths) {
  const state = context.applicationState;
  for (const directory of [paths.binDir, paths.updaterDir]) {
    await fsp.mkdir(directory, { recursive: true, mode: 0o750 });
    const info = await fsp.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`initialized managed application directory is unsafe: ${directory}`);
    }
    await fsp.chown(directory, state.operatorUid, state.operatorGid);
    await fsp.chmod(directory, 0o750);
    await fsyncDirectory(directory);
  }
}

async function ensureManagedCompatibilityDirectories(context, paths) {
  const state = context.applicationState;
  const directories = [
    path.dirname(paths.prefix),
    paths.prefix,
    path.dirname(paths.prefixLauncherPath),
    path.dirname(path.dirname(path.dirname(paths.compatibilityLink))),
    path.dirname(path.dirname(paths.compatibilityLink)),
    path.dirname(paths.compatibilityLink),
  ];
  for (const directory of directories) {
    const resolved = path.resolve(directory);
    if (resolved === paths.stateDir || !resolved.startsWith(`${paths.stateDir}${path.sep}`)) {
      throw new Error(`managed compatibility directory escaped application state: ${directory}`);
    }
    try {
      await fsp.mkdir(resolved, { mode: 0o750 });
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
    }
    const info = await fsp.lstat(resolved);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`managed compatibility directory is unsafe: ${resolved}`);
    }
    await fsp.chown(resolved, state.operatorUid, state.operatorGid);
    await fsp.chmod(resolved, 0o750);
    await fsyncDirectory(resolved);
  }
}

async function installInitializedManagedStableFiles(context, transaction, targetRoot) {
  if (transaction.previousManifest) {
    return;
  }
  const paths = managedApplicationPaths(transaction.stateDir);
  await ensureInitializedManagedStableDirectories(context, paths);
  const sources = [
    ["fased-managed-launcher.sh", paths.launcherPath, 0o750],
    ["fased-managed-service.sh", paths.serviceLauncherPath, 0o750],
    ...MANAGED_UPDATER_SUPPORT_FILES.map((name) => [
      name,
      path.join(paths.updaterDir, name),
      0o750,
    ]),
    // The immutable generation receipt binds the entrypoint mode as well as
    // its bytes. Parent-directory isolation still limits this operator-owned
    // compatibility copy to the trusted operator.
    ["fased-managed-updater.mjs", paths.updaterPath, 0o755],
  ];
  for (const [name, destination, mode] of sources) {
    await atomicCopyFileDurable(path.join(targetRoot, "scripts", name), destination, {
      mode,
      uid: context.applicationState.operatorUid,
      gid: context.applicationState.operatorGid,
    });
  }
  await atomicSymlinkDurable(paths.launcherPath, paths.prefixLauncherPath);
}

async function removeInitializedManagedStableFiles(transaction) {
  if (transaction.previousManifest) {
    return;
  }
  const paths = managedApplicationPaths(transaction.stateDir);
  for (const candidate of [
    paths.prefixLauncherPath,
    paths.launcherPath,
    paths.serviceLauncherPath,
    paths.updaterPath,
    ...MANAGED_UPDATER_SUPPORT_FILES.map((name) => path.join(paths.updaterDir, name)),
  ]) {
    await fsp.rm(candidate, { force: true });
  }
  for (const directory of [
    path.dirname(paths.prefixLauncherPath),
    paths.binDir,
    paths.updaterDir,
  ]) {
    await fsyncDirectory(directory).catch((error) => {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    });
  }
  for (const directory of [
    path.dirname(paths.prefixLauncherPath),
    path.dirname(paths.compatibilityLink),
    path.dirname(path.dirname(paths.compatibilityLink)),
    path.dirname(path.dirname(path.dirname(paths.compatibilityLink))),
    paths.prefix,
    path.dirname(paths.prefix),
    paths.binDir,
    paths.updaterDir,
    paths.runtimeDir,
  ]) {
    await fsp.rmdir(directory).catch((error) => {
      if (!new Set(["ENOENT", "ENOTEMPTY", "EEXIST"]).has(error?.code)) {
        throw error;
      }
    });
  }
  await fsyncDirectory(paths.stateDir);
}

async function activateTargetManagedUpdaterGeneration(context, journal) {
  const transaction = journal.managedApplication;
  if (!transaction?.updaterGeneration) {
    return;
  }
  const targetRoot = journal.application?.targetRoot;
  if (!targetRoot) {
    throw new Error("target updater generation has no application runtime");
  }
  const paths = managedApplicationPaths(transaction.stateDir);
  const activated = await context.activateUpdaterGeneration(
    paths,
    targetRoot,
    transaction.updaterGeneration,
  );
  if (activated.bundleDigest !== transaction.updaterGeneration.bundleDigest) {
    throw new Error("target updater generation identity changed before activation");
  }
}

async function restorePreviousManagedUpdaterGeneration(context, journal) {
  const transaction = journal.managedApplication;
  if (!transaction?.updaterGeneration) {
    return;
  }
  const targetRoot = journal.application?.targetRoot;
  if (!targetRoot) {
    throw new Error("rollback updater generation has no target application runtime");
  }
  const paths = managedApplicationPaths(transaction.stateDir);
  await context.restoreUpdaterGeneration(paths, targetRoot, transaction.updaterGeneration);
}

async function installCommittedManagedLaunchers(context, journal) {
  const transaction = journal.managedApplication;
  if (!transaction?.updaterGeneration) {
    return;
  }
  const targetRoot = journal.application?.targetRoot;
  if (!targetRoot) {
    throw new Error("committed updater generation has no target application runtime");
  }
  const paths = managedApplicationPaths(transaction.stateDir);
  await ensureManagedCompatibilityDirectories(context, paths);
  for (const [name, destination] of [
    ["fased-managed-launcher.sh", paths.launcherPath],
    ["fased-managed-service.sh", paths.serviceLauncherPath],
  ]) {
    await atomicCopyFileDurable(path.join(targetRoot, "scripts", name), destination, {
      mode: 0o750,
      uid: context.applicationState.operatorUid,
      gid: context.applicationState.operatorGid,
    });
  }
  await atomicSymlinkDurable(paths.launcherPath, paths.prefixLauncherPath);
}

async function selectManagedApplication(context, journal) {
  if (!journal.managedApplication) {
    return;
  }
  const paths = managedApplicationPaths(journal.managedApplication.stateDir);
  const targetRoot = journal.application?.targetRoot;
  if (!targetRoot) {
    throw new Error("managed application target is unavailable");
  }
  await ensureManagedCompatibilityDirectories(context, paths);
  await activateTargetManagedUpdaterGeneration(context, journal);
  if (
    journal.managedApplication.previousRoot &&
    journal.managedApplication.previousRoot !== targetRoot
  ) {
    await atomicSymlinkDurable(journal.managedApplication.previousRoot, paths.previousLink);
  } else if (!journal.managedApplication.previousRoot) {
    await fsp.rm(paths.previousLink, { force: true });
  }
  await atomicSymlinkDurable(targetRoot, paths.currentLink);
  await atomicSymlinkDurable(paths.currentLink, paths.compatibilityLink);
  await installInitializedManagedStableFiles(context, journal.managedApplication, targetRoot);
  await writeManagedManifest(
    context,
    journal.managedApplication,
    journal.managedApplication.nextManifest,
  );
}

function prepareLifecycleSchemaMigrations(journal) {
  const migration = validateLifecycleSchemaMigration(
    journal.schemaMigration,
    journal.migrationSelection,
  );
  if (!migration) {
    throw new Error("target lifecycle transaction has no schema migration plan");
  }
  const application = migration.steps.find((step) => step.component === "application");
  if (application?.applicable) {
    if (!journal.managedApplication) {
      throw new Error("managed application schema migration has no rollback-bound transaction");
    }
    const previousSchema = journal.managedApplication.previousManifest?.schemaVersion ?? null;
    const nextSchema = journal.managedApplication.nextManifest?.schemaVersion ?? null;
    if (
      previousSchema !== application.fromSchema ||
      nextSchema !== application.toSchema ||
      (application.mode === "initialize-on-activation" && previousSchema !== null) ||
      (application.mode === "migrate-on-activation" &&
        !(previousSchema === 1 && nextSchema === 2)) ||
      (application.mode === "verify-current" && previousSchema !== nextSchema)
    ) {
      throw new Error("managed application schema migration transaction is mismatched");
    }
  }
  return stagedLifecycleSchemaMigration(migration, journal.migrationSelection);
}

async function completeLifecycleSchemaMigrations(context, journal) {
  const migration = validateLifecycleSchemaMigration(
    journal.schemaMigration,
    journal.migrationSelection,
  );
  if (!migration) {
    throw new Error("target lifecycle transaction has no schema migration plan");
  }
  if (migration.preparedAdapters.length !== migration.steps.length) {
    throw new Error("target lifecycle schema migration was not prepared");
  }
  const activationSteps = migration.steps.filter(
    (step) =>
      step.applicable &&
      (step.mode === "initialize-on-activation" || step.mode === "migrate-on-activation"),
  );
  if (activationSteps.length > 1) {
    throw new Error("target lifecycle schema migration has multiple activation writers");
  }
  if (activationSteps.length === 1) {
    const [step] = activationSteps;
    if (step.component !== "application" || !journal.managedApplication) {
      throw new Error("target lifecycle schema activation owner is invalid");
    }
    const paths = managedApplicationPaths(journal.managedApplication.stateDir);
    const manifest = validateManagedInstallManifest(
      JSON.parse(await fsp.readFile(paths.manifestPath, "utf8")),
      context.applicationState,
      paths,
    );
    const activeRoot = await readOptionalLink(paths.currentLink);
    if (
      manifest.schemaVersion !== step.toSchema ||
      manifest.runtime.activeVersion !== journal.version ||
      activeRoot !== journal.application?.targetRoot
    ) {
      throw new Error("managed application schema migration did not activate atomically");
    }
  }
  return completedLifecycleSchemaMigration(migration, journal.migrationSelection);
}

function assertLifecycleSchemaMigrationsApplied(journal) {
  const migration = validateLifecycleSchemaMigration(
    journal.schemaMigration,
    journal.migrationSelection,
  );
  if (
    !migration ||
    migration.preparedAdapters.length !== migration.steps.length ||
    migration.appliedAdapters.length !== migration.steps.length
  ) {
    throw new Error("target lifecycle schema migrations are incomplete");
  }
  return migration;
}

function lifecycleSchemaMigrationsApplied(journal) {
  const migration = validateLifecycleSchemaMigration(
    journal.schemaMigration,
    journal.migrationSelection,
  );
  return Boolean(
    migration &&
    migration.preparedAdapters.length === migration.steps.length &&
    migration.appliedAdapters.length === migration.steps.length,
  );
}

async function restoreManagedApplication(context, journal) {
  if (!journal.managedApplication) {
    return;
  }
  const transaction = journal.managedApplication;
  const paths = managedApplicationPaths(transaction.stateDir);
  await restorePreviousManagedUpdaterGeneration(context, journal);
  if (!transaction.previousRoot) {
    await fsp.rm(paths.currentLink, { force: true });
    await fsp.rm(paths.compatibilityLink, { force: true });
    await fsp.rm(paths.manifestPath, { force: true });
    await removeInitializedManagedStableFiles(transaction);
  } else {
    await atomicSymlinkDurable(transaction.previousRoot, paths.currentLink);
    await atomicSymlinkDurable(paths.currentLink, paths.compatibilityLink);
    await writeManagedManifest(context, transaction, transaction.previousManifest);
  }
  if (transaction.previousPreviousRoot) {
    await atomicSymlinkDurable(transaction.previousPreviousRoot, paths.previousLink);
  } else {
    await fsp.rm(paths.previousLink, { force: true });
    await fsyncDirectory(paths.runtimeDir).catch((error) => {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    });
  }
}

async function removeManagedUpdateLock(journal) {
  if (!journal.managedApplication) {
    return;
  }
  const lockPath = path.join(journal.managedApplication.stateDir, "update.lock");
  await fsp.rm(lockPath, { force: true });
  await fsyncDirectory(journal.managedApplication.stateDir);
}

async function readGatewayReadinessEndpoint(endpoint, timeoutMs) {
  return await new Promise((resolve, reject) => {
    const client = endpoint.tls ? https : http;
    const request = client.get(
      {
        hostname: "127.0.0.1",
        port: endpoint.port,
        path: "/readyz",
        timeout: timeoutMs,
        ...(endpoint.tls ? { rejectUnauthorized: false } : {}),
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
          if (body.length > 64 * 1024) {
            request.destroy(new Error("target Gateway readiness response is too large"));
          }
        });
        response.on("end", () => {
          try {
            resolve({ statusCode: response.statusCode, payload: JSON.parse(body) });
          } catch (error) {
            reject(new Error(`target Gateway readiness response is invalid: ${error.message}`));
          }
        });
      },
    );
    request.on("timeout", () =>
      request.destroy(new Error("target Gateway readiness probe timed out")),
    );
    request.on("error", reject);
  });
}

function validateGatewayReadinessResponse(response, version, expectedGeneration) {
  const payload = response?.payload;
  if (
    response?.statusCode !== 200 ||
    payload?.ok !== true ||
    payload?.ready !== true ||
    payload?.status !== "ready" ||
    payload?.version !== version ||
    !new Set(["managed-package", "packaged-runtime"]).has(payload?.runtimeSource) ||
    !Number.isSafeInteger(payload?.pid) ||
    payload.pid < 1 ||
    typeof payload?.startedAt !== "string" ||
    Number.isNaN(Date.parse(payload.startedAt)) ||
    !Number.isFinite(payload?.uptimeMs) ||
    payload.uptimeMs < 0
  ) {
    throw new Error(
      `target Gateway readiness identity is ${payload?.version ?? "unknown"}/${payload?.runtimeSource ?? "unknown"}`,
    );
  }
  const generation = validateGatewayGenerationReceipt(payload.generation, expectedGeneration);
  return Object.freeze({
    pid: payload.pid,
    startedAt: payload.startedAt,
    runtimeSource: payload.runtimeSource,
    generation,
  });
}

async function probeTargetGateway(context, version, expectedGeneration, timeoutMs = 30_000) {
  const stateDir = context.applicationState?.stateDir;
  if (!stateDir) {
    throw new Error("target Gateway configuration is unavailable");
  }
  let endpoint = { port: 18789, tls: false };
  try {
    const config = JSON.parse(await fsp.readFile(path.join(stateDir, "fased.json"), "utf8"));
    endpoint = {
      port: Number.isInteger(config?.gateway?.port) ? config.gateway.port : 18789,
      tls: config?.gateway?.tls?.enabled === true,
    };
  } catch {
    // A missing optional port override means the product default.
  }
  const deadline = Date.now() + timeoutMs;
  let lastError = new Error("target Gateway health endpoint is unavailable");
  while (Date.now() < deadline) {
    try {
      const response = await context.readGatewayReadiness(
        endpoint,
        Math.min(3000, Math.max(25, deadline - Date.now())),
      );
      return validateGatewayReadinessResponse(response, version, expectedGeneration);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`target Gateway did not become healthy as v${version}: ${lastError.message}`, {
    cause: lastError,
  });
}

function healthEvidenceDigest(value) {
  return `sha256:${createHash("sha256").update(canonicalJSON(value)).digest("hex")}`;
}

function parseBoundedJsonOutput(stdout, label) {
  const text = String(stdout ?? "").trim();
  if (!text || text.length > 1024 * 1024) {
    throw new Error(`${label} health output is empty or too large`);
  }
  const starts = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "{" || text[index] === "[") {
      starts.push(index);
    }
  }
  for (const index of starts) {
    try {
      return JSON.parse(text.slice(index));
    } catch {
      // Plugin preload messages can precede one final JSON document.
    }
  }
  throw new Error(`${label} health output is not valid JSON`);
}

function healthJsonShape(value) {
  if (Array.isArray(value)) {
    return { type: "array", length: value.length };
  }
  if (value && typeof value === "object") {
    return { type: "object", keys: Object.keys(value).toSorted() };
  }
  return { type: typeof value };
}

function healthObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} health is invalid`);
  }
  return value;
}

function canonicalizePluginConfigValue(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalizePluginConfigValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalizePluginConfigValue(child)]),
    );
  }
  return value;
}

function pluginStatusConfigFingerprint(config) {
  return createHash("sha256")
    .update(
      JSON.stringify(
        canonicalizePluginConfigValue({
          plugins: config?.plugins,
        }),
      ),
    )
    .digest("hex");
}

function targetPluginStatusCachePath(topology) {
  return path.join(topology.stateDir, "cache", "plugin-status.json");
}

function pathIsStrictlyInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function readTargetPluginStatusCache(context, topology, journal) {
  const targetRoot = journal.application?.targetRoot;
  const expectedTargetRoot = protectedApplicationReleaseRoot(context.paths, journal.version);
  if (!targetRoot || path.resolve(targetRoot) !== expectedTargetRoot) {
    throw new Error("target plugin application identity is unavailable");
  }
  const cachePath = targetPluginStatusCachePath(topology);
  const cacheStat = await fsp.lstat(cachePath);
  if (
    !cacheStat.isFile() ||
    cacheStat.isSymbolicLink() ||
    cacheStat.nlink !== 1 ||
    cacheStat.size < 2 ||
    cacheStat.size > 2 * 1024 * 1024
  ) {
    throw new Error("target Gateway plugin status cache is unsafe");
  }
  const [cache, config] = await Promise.all([
    fsp.readFile(cachePath, "utf8").then(JSON.parse),
    fsp.readFile(topology.configPath, "utf8").then(JSON.parse),
  ]);
  if (
    cache?.schemaVersion !== 2 ||
    cache.packageVersion !== journal.version ||
    typeof cache.generatedAt !== "string" ||
    !Number.isFinite(Date.parse(cache.generatedAt)) ||
    cache.configPath !== topology.configPath ||
    cache.configFingerprint !== pluginStatusConfigFingerprint(config) ||
    !Array.isArray(cache.plugins) ||
    !Array.isArray(cache.diagnostics) ||
    cache.plugins.length > 1024 ||
    cache.diagnostics.length > 1024
  ) {
    throw new Error("target Gateway plugin status cache is stale or malformed");
  }
  const canonicalTargetRoot = await fsp.realpath(targetRoot);
  for (const plugin of cache.plugins) {
    if (
      !plugin ||
      typeof plugin !== "object" ||
      Array.isArray(plugin) ||
      typeof plugin.id !== "string" ||
      plugin.id.length === 0 ||
      plugin.id.length > 256 ||
      typeof plugin.source !== "string" ||
      plugin.source.length === 0 ||
      plugin.source.length > 4096 ||
      typeof plugin.origin !== "string" ||
      !new Set(["loaded", "disabled", "error"]).has(plugin.status) ||
      !(plugin.sourceMtimeMs === null || Number.isFinite(plugin.sourceMtimeMs))
    ) {
      throw new Error("target Gateway plugin status entry is malformed");
    }
    const source = path.resolve(plugin.source);
    const canonicalSource = await fsp.realpath(source).catch((error) => {
      if (plugin.sourceMtimeMs === null && error?.code === "ENOENT") {
        return null;
      }
      throw error;
    });
    if (
      plugin.origin === "bundled" &&
      (!canonicalSource || !pathIsStrictlyInside(canonicalTargetRoot, canonicalSource))
    ) {
      throw new Error("target Gateway bundled plugin status escaped the target application");
    }
    if (plugin.sourceMtimeMs !== null) {
      const sourceStat = await fsp.stat(canonicalSource);
      if (!sourceStat.isFile() || Math.abs(sourceStat.mtimeMs - plugin.sourceMtimeMs) > 0.5) {
        throw new Error("target Gateway plugin status source identity changed");
      }
    }
  }
  for (const diagnostic of cache.diagnostics) {
    if (
      !diagnostic ||
      typeof diagnostic !== "object" ||
      Array.isArray(diagnostic) ||
      typeof diagnostic.level !== "string" ||
      typeof diagnostic.message !== "string"
    ) {
      throw new Error("target Gateway plugin diagnostic is malformed");
    }
  }
  const errors = cache.plugins.filter((plugin) => plugin.status === "error");
  const diagnostics = cache.diagnostics.filter((entry) => entry?.level === "error");
  return {
    ok: errors.length === 0 && diagnostics.length === 0,
    errors,
    diagnostics,
  };
}

function unwrapHealthPayload(value) {
  let current = value;
  for (let index = 0; index < 3; index += 1) {
    if (
      !current ||
      typeof current !== "object" ||
      Array.isArray(current) ||
      !Object.hasOwn(current, "payload")
    ) {
      return current;
    }
    current = current.payload;
  }
  return current;
}

function validateCanonicalWalletHealth(walletStatus, walletDoctor, topology) {
  if (walletDoctor?.ok !== true) {
    throw new Error("target Wallet signer health is not ready");
  }
  const status = healthObject(walletStatus?.status, "target Wallet status");
  const expectedMode =
    topology.profile === "hosting" ? "hosting-operator" : "protected-local-operator";
  if (status.mode !== expectedMode || !Array.isArray(status.wallets)) {
    throw new Error("target Wallet status did not use the canonical operator registry");
  }
  const wallets = new Map();
  const handles = new Set();
  const addresses = new Set();
  let miningWallets = 0;
  for (const value of status.wallets) {
    const wallet = healthObject(value, "target Wallet record");
    const id = typeof wallet.id === "string" ? wallet.id.trim() : "";
    const handle = typeof wallet.handle === "string" ? wallet.handle.trim() : "";
    const address = typeof wallet.publicAddress === "string" ? wallet.publicAddress.trim() : "";
    const role = typeof wallet.role === "string" ? wallet.role.trim() : "";
    const signer = healthObject(wallet.signer, "target signer Wallet readiness");
    const expectedLanes = {
      agent: new Set(["agent-reviewed-and-autonomous"]),
      mining: new Set(["mining-reviewed-only", "mining-typed-sat"]),
      vault: new Set(["vault-reviewed-only"]),
    };
    if (
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/u.test(id) ||
      handle !== `@wallet:${id}` ||
      !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/u.test(address) ||
      !Object.hasOwn(expectedLanes, role) ||
      signer.walletId !== id ||
      signer.publicKey !== address ||
      signer.role !== role ||
      signer.ready !== true ||
      signer.keyReady !== true ||
      signer.policyReady !== true ||
      signer.networkReady !== true ||
      !Number.isSafeInteger(signer.baselineVersion) ||
      signer.baselineVersion < 1 ||
      !Number.isSafeInteger(signer.policyVersion) ||
      signer.policyVersion < 1 ||
      !/^sha256:[a-f0-9]{64}$/u.test(String(signer.policyHash ?? "")) ||
      !Number.isSafeInteger(signer.networkVersion) ||
      signer.networkVersion < 1 ||
      !/^hmac-sha256:[a-f0-9]{64}$/u.test(String(signer.networkHash ?? "")) ||
      !expectedLanes[role].has(signer.operationLane) ||
      wallets.has(id) ||
      handles.has(handle) ||
      addresses.has(address)
    ) {
      throw new Error("target Wallet registry and signer identity did not converge");
    }
    if (role === "mining") {
      miningWallets += 1;
    }
    wallets.set(id, { id, handle, address, role, lane: signer.operationLane });
    handles.add(handle);
    addresses.add(address);
  }
  if (miningWallets > 1) {
    throw new Error("target Wallet registry has more than one Mining Wallet");
  }
  const assignments = status.assignments ?? {};
  if (!assignments || typeof assignments !== "object" || Array.isArray(assignments)) {
    throw new Error("target Wallet routing assignments are invalid");
  }
  for (const [assignment, walletId] of Object.entries(assignments)) {
    if (!assignment.trim() || typeof walletId !== "string" || !wallets.has(walletId)) {
      throw new Error("target Wallet routing references a non-canonical Wallet");
    }
  }
  const defaultWalletId =
    typeof status.defaultWalletId === "string" ? status.defaultWalletId.trim() : "";
  if (defaultWalletId && wallets.get(defaultWalletId)?.role !== "agent") {
    throw new Error("target default Wallet routing is not assigned to an Agent Wallet");
  }
  return {
    wallets,
    evidence: {
      mode: status.mode,
      walletCount: wallets.size,
      miningWalletCount: miningWallets,
      assignmentCount: Object.keys(assignments).length,
      defaultWalletPresent: Boolean(defaultWalletId),
      signerChecks: Array.isArray(walletDoctor.checks) ? walletDoctor.checks.length : 0,
    },
  };
}

function validateCrossProductApplicationEvidence(params) {
  const canonicalWallets = validateCanonicalWalletHealth(
    params.walletStatus,
    params.walletDoctor,
    params.topology,
  );
  const mining = healthObject(unwrapHealthPayload(params.mining), "target Mining history");
  const network = healthObject(params.network, "target Fased Network");
  const bond = healthObject(params.bond, "target Fased Network bond");
  const plugins = healthObject(params.plugins, "target plugin diagnostics");
  const signerIsolation = healthObject(params.signerIsolation, "target signer isolation");
  if (
    network.configured === true &&
    (typeof network.handle !== "string" || network.handle.trim().length === 0)
  ) {
    throw new Error("configured Fased Network identity is incomplete");
  }
  if (bond.walletId != null) {
    const walletId = typeof bond.walletId === "string" ? bond.walletId.trim() : "";
    const wallet = canonicalWallets.wallets.get(walletId);
    if (
      !wallet ||
      wallet.role !== "vault" ||
      typeof bond.walletAddress !== "string" ||
      bond.walletAddress.trim() !== wallet.address
    ) {
      throw new Error("Fased Network bond is not bound to the canonical Vault Wallet");
    }
  }
  if (
    plugins.ok !== true ||
    !Array.isArray(plugins.errors) ||
    !Array.isArray(plugins.diagnostics) ||
    plugins.errors.length > 0 ||
    plugins.diagnostics.length > 0
  ) {
    const category = (value) => {
      const text = typeof value === "string" ? value : "";
      if (/(?:EACCES|EPERM|permission denied|operation not permitted)/iu.test(text)) {
        return "permission-denied";
      }
      if (/(?:ERR_MODULE_NOT_FOUND|Cannot find (?:module|package))/iu.test(text)) {
        return "module-not-found";
      }
      if (/missing config schema/iu.test(text)) {
        return "missing-schema";
      }
      if (/invalid config/iu.test(text)) {
        return "invalid-config";
      }
      if (/entry path escapes|alias checks/iu.test(text)) {
        return "unsafe-entry";
      }
      if (/register/iu.test(text)) {
        return "register-failed";
      }
      return "plugin-error";
    };
    const identifiers = new Map();
    for (const entry of Array.isArray(plugins.errors) ? plugins.errors : []) {
      if (typeof entry?.id === "string" && entry.id.trim()) {
        identifiers.set(entry.id.trim(), category(entry.error));
      }
    }
    for (const entry of Array.isArray(plugins.diagnostics) ? plugins.diagnostics : []) {
      const id =
        typeof entry?.pluginId === "string" && entry.pluginId.trim()
          ? entry.pluginId.trim()
          : "global";
      identifiers.set(id, category(entry.message));
    }
    const boundedIdentifiers =
      [...identifiers]
        .slice(0, 8)
        .map(([id, failureCategory]) => `${id}:${failureCategory}`)
        .join(", ") || "unknown";
    throw new Error(`target plugin diagnostics are not healthy (${boundedIdentifiers})`);
  }
  if (signerIsolation.operatorDenied !== true || signerIsolation.controlDenied !== true) {
    throw new Error("target Gateway can reach a privileged signer socket");
  }
  return Object.freeze({
    wallet: {
      ok: true,
      evidenceDigest: healthEvidenceDigest(canonicalWallets.evidence),
    },
    mining: {
      ok: true,
      evidenceDigest: healthEvidenceDigest({
        ...healthJsonShape(mining),
        miningWalletIds: [...canonicalWallets.wallets.values()]
          .filter((wallet) => wallet.role === "mining")
          .map((wallet) => wallet.id)
          .toSorted((left, right) => left.localeCompare(right)),
      }),
    },
    network: {
      ok: true,
      evidenceDigest: healthEvidenceDigest({
        configured: network.configured === true,
        autoConnectEnabled: network.autoConnectEnabled === true,
        tokenPresent: network.tokenPresent === true,
        handlePresent: typeof network.handle === "string" && network.handle.trim().length > 0,
        managedTokenPresent: Boolean(network.managedToken),
        bondVaultPresent: bond.walletId != null,
      }),
    },
    plugins: {
      ok: true,
      evidenceDigest: healthEvidenceDigest({
        errors: plugins.errors.length,
        diagnostics: plugins.diagnostics.length,
      }),
    },
    signerIsolation: {
      ok: true,
      evidenceDigest: healthEvidenceDigest({
        operatorDenied: true,
        controlDenied: true,
      }),
    },
  });
}

async function readGatewayHealthConfiguration(topology) {
  const configStat = await lstatIfPresent(topology.configPath);
  if (
    !configStat ||
    !configStat.isFile() ||
    configStat.isSymbolicLink() ||
    configStat.nlink !== 1 ||
    configStat.size > 2 * 1024 * 1024
  ) {
    throw new Error("target Gateway configuration is unavailable for product health");
  }
  let config;
  try {
    config = JSON.parse(await fsp.readFile(topology.configPath, "utf8"));
  } catch (error) {
    throw new Error("target Gateway configuration is invalid for product health", {
      cause: error,
    });
  }
  const token =
    typeof config?.gateway?.auth?.token === "string" ? config.gateway.auth.token.trim() : "";
  const port = Number.isInteger(config?.gateway?.port) ? config.gateway.port : 18789;
  if (!token || token.length > 4096 || port < 1 || port > 65535) {
    throw new Error("target Gateway authentication configuration is incomplete");
  }
  return { token, port };
}

async function runTargetApplicationCommand(
  context,
  topology,
  journal,
  args,
  label,
  { json = true } = {},
) {
  const targetRoot = journal.application?.targetRoot;
  if (
    !targetRoot ||
    targetRoot !== protectedApplicationReleaseRoot(context.paths, journal.version)
  ) {
    throw new Error("target application identity is unavailable for product health");
  }
  const entrypoint = path.join(targetRoot, "fased.mjs");
  const entrypointStat = await lstatIfPresent(entrypoint);
  if (
    !entrypointStat ||
    !entrypointStat.isFile() ||
    entrypointStat.isSymbolicLink() ||
    entrypointStat.nlink !== 1
  ) {
    throw new Error("target application entrypoint is invalid for product health");
  }
  const { token } = await readGatewayHealthConfiguration(topology);
  const nodeBinary = path.resolve(context.protectedNodeBinary);
  const { stdout } = await execFileAsSystemIdentity(
    nodeBinary,
    [entrypoint, ...args],
    topology.operator.uid,
    topology.operator.gid,
    {
      env: {
        HOME: topology.operator.home,
        USER: topology.operator.name,
        LOGNAME: topology.operator.name,
        PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        FASED_NODE: nodeBinary,
        FASED_STATE_DIR: topology.stateDir,
        FASED_CONFIG_PATH: topology.configPath,
        FASED_HOST_PROFILE: topology.profile === "hosting" ? "hosting" : "local",
        FASED_GATEWAY_TOKEN: token,
      },
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    },
  );
  return json ? parseBoundedJsonOutput(stdout, label) : { outputPresent: stdout.length > 0 };
}

function privilegedSignerSocketPaths(context) {
  if (context.instanceId) {
    const runtime = `/run/fased-local/${context.instanceId}`;
    return {
      operator: `${runtime}/operator/operator.sock`,
      control: `${runtime}/control/control.sock`,
    };
  }
  return {
    operator: "/run/fased-signerd/operator.sock",
    control: "/run/fased-signerd/control.sock",
  };
}

async function assertSocketDeniedToGateway(context, topology, socketPath, label) {
  const stat = await fsp.lstat(socketPath);
  if (!stat.isSocket() || stat.isSymbolicLink()) {
    throw new Error(`target signer ${label} socket is invalid`);
  }
  const nodeBinary = path.resolve(context.protectedNodeBinary);
  const probe = [
    'const net=require("node:net");',
    "const socket=net.createConnection({path:process.argv[1]});",
    "socket.setTimeout(3000);",
    'socket.once("connect",()=>process.exit(42));',
    'socket.once("timeout",()=>process.exit(43));',
    'socket.once("error",(error)=>process.exit(error.code==="EACCES"||error.code==="EPERM"?0:44));',
  ].join("");
  try {
    await execFileAsSystemIdentity(
      nodeBinary,
      ["-e", probe, socketPath],
      topology.gateway.uid,
      topology.gateway.gid,
      {
        env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" },
        timeout: 5_000,
        maxBuffer: 16 * 1024,
      },
    );
  } catch (error) {
    throw new Error(`target Gateway can reach or ambiguously probe signer ${label} authority`, {
      cause: error,
    });
  }
}

async function probeSignerSocketIsolation(context, topology) {
  const sockets = privilegedSignerSocketPaths(context);
  await Promise.all([
    assertSocketDeniedToGateway(context, topology, sockets.operator, "operator"),
    assertSocketDeniedToGateway(context, topology, sockets.control, "control"),
  ]);
  return { operatorDenied: true, controlDenied: true };
}

function targetMiningHealthArgs() {
  return ["mining", "history", "--timeout", "5000", "--json"];
}

async function collectCrossProductApplicationHealthEvidence(
  runCommand,
  probeIsolation,
  probePlugins,
) {
  // Each CLI process loads the application and native plugin graph. Running all
  // product probes at once can exhaust a 2 GiB installation and can make
  // plugin diagnostics observe another process's transient native-loader work.
  // Keep the inexpensive root/Gateway/signer prerequisites parallel, but bound
  // product health to one application process at a time.
  const walletStatus = await runCommand(["wallet", "status", "--json"], "Wallet");
  const walletDoctor = await runCommand(["wallet", "signer", "doctor", "--json"], "Wallet signer");
  const mining = await runCommand(targetMiningHealthArgs(), "Mining");
  const network = await runCommand(["federation", "status", "--json"], "Fased Network");
  const bond = await runCommand(
    ["federation", "bond-wallet", "status", "--json"],
    "Fased Network bond",
  );
  const plugins = await probePlugins();
  const signerIsolation = await probeIsolation();
  return { walletStatus, walletDoctor, mining, network, bond, plugins, signerIsolation };
}

async function probeCrossProductApplicationHealth(context, topology, journal) {
  if (topology.pendingGatewayUnit || topology.pendingStateDir) {
    throw new Error("application topology is incomplete during product health verification");
  }
  const { walletStatus, walletDoctor, mining, network, bond, plugins, signerIsolation } =
    await collectCrossProductApplicationHealthEvidence(
      async (args, label) =>
        await runTargetApplicationCommand(context, topology, journal, args, label),
      async () => await probeSignerSocketIsolation(context, topology),
      async () => await readTargetPluginStatusCache(context, topology, journal),
    );
  return validateCrossProductApplicationEvidence({
    topology,
    walletStatus,
    walletDoctor,
    mining,
    network,
    bond,
    plugins,
    signerIsolation,
  });
}

async function verifyCrossProductHealth(context, journal) {
  const topology =
    context.applicationTopology ??
    (await context.discoverApplicationTopology().then((value) => {
      context.applicationTopology = value;
      return value;
    }));
  const expectedGatewayGeneration = gatewayGenerationExpectationFromJournal(journal);
  const [gateway, signerRelease, state] = await Promise.all([
    context.verifyGateway(journal.version, expectedGatewayGeneration),
    context.probeSigner(journal.release),
    context.verifyApplicationState(journal.declaredState),
  ]);
  const product = await context.probeApplicationHealth(topology, journal);
  const signer = parseSignerReleaseIdentity(signerRelease, journal.version);
  if (!expectedGatewayGeneration) {
    return validateCrossProductHealthReceipt({
      schemaVersion: 1,
      checkedAt: new Date().toISOString(),
      checks: {
        gateway: {
          ok: true,
          evidenceDigest: healthEvidenceDigest({
            version: gateway?.version ?? journal.version,
            runtimeSource: gateway?.runtimeSource ?? "verified-by-adapter",
          }),
        },
        signer: {
          ok: true,
          evidenceDigest: healthEvidenceDigest({
            release: signer,
            privilegedSockets: product.signerIsolation.evidenceDigest,
          }),
        },
        wallet: product.wallet,
        mining: product.mining,
        network: product.network,
        plugins: product.plugins,
        state: {
          ok: true,
          evidenceDigest: healthEvidenceDigest({
            preservationHash: state.preservationHash,
            preservationHashes: state.preservationHashes ?? {},
          }),
        },
      },
    });
  }
  let gatewayReceipt;
  try {
    gatewayReceipt = validateGatewayRuntimeReceipt(
      {
        pid: gateway.pid,
        startedAt: gateway.startedAt,
        runtimeSource: gateway.runtimeSource,
        generation: gateway.generation,
      },
      expectedGatewayGeneration,
    );
  } catch (error) {
    if (!context.allowSyntheticGatewayReceipt) {
      throw error;
    }
    gatewayReceipt = Object.freeze({
      pid: process.pid,
      startedAt: new Date(0).toISOString(),
      runtimeSource: gateway?.runtimeSource ?? "managed-package",
      generation: expectedGatewayGeneration,
    });
  }
  return validateCrossProductHealthReceipt(
    {
      schemaVersion: 2,
      transactionId: journal.transactionId,
      checkedAt: new Date().toISOString(),
      gateway: gatewayReceipt,
      checks: {
        gateway: {
          ok: true,
          evidenceDigest: healthEvidenceDigest(gatewayReceipt),
        },
        signer: {
          ok: true,
          evidenceDigest: healthEvidenceDigest({
            release: signer,
            privilegedSockets: product.signerIsolation.evidenceDigest,
          }),
        },
        wallet: product.wallet,
        mining: product.mining,
        network: product.network,
        plugins: product.plugins,
        state: {
          ok: true,
          evidenceDigest: healthEvidenceDigest({
            preservationHash: state.preservationHash,
            preservationHashes: state.preservationHashes ?? {},
          }),
        },
      },
    },
    { transactionId: journal.transactionId, generation: expectedGatewayGeneration },
  );
}

async function ensureProtectedLocalControllerServicePolicy(context) {
  if (!context.instanceId || !context.paths.controllerUnitPath) {
    return false;
  }
  const unitPath = context.paths.controllerUnitPath;
  const captured = await captureProtectedServiceFile(
    unitPath,
    "protected Local controller unit",
    context.rootUid,
  );
  const content = Buffer.from(captured.contentBase64, "base64").toString("utf8");
  const restrictionPattern = /^RestrictSUIDSGID=(.*)$/gmu;
  const restrictions = [...content.matchAll(restrictionPattern)];
  if (restrictions.length === 0) {
    return false;
  }
  if (restrictions.length !== 1 || restrictions[0][1] !== "true") {
    throw new Error("protected Local controller unit has an ambiguous set-ID restriction");
  }
  const expectedController = `${context.paths.controllerCurrentLink}/${CONTROLLER_SERVER_NAME}`;
  const entrypoints = content.split("\n").filter((line) => line.startsWith("ExecStart="));
  if (
    entrypoints.length !== 1 ||
    !entrypoints[0].includes(
      ` ${expectedController} --protected-local-instance ${context.instanceId} `,
    )
  ) {
    throw new Error("protected Local controller unit has an invalid instance-bound entrypoint");
  }
  const required = [
    ["root user", /^User=root$/mu],
    ["root group", /^Group=root$/mu],
    ["strict filesystem protection", /^ProtectSystem=strict$/mu],
    ["non-escalating process policy", /^NoNewPrivileges=true$/mu],
    ["system unit write boundary", /^ReadWritePaths=.* \/etc\/systemd\/system$/mu],
  ];
  for (const [label, pattern] of required) {
    if (!pattern.test(content)) {
      throw new Error(`protected Local controller unit has an invalid ${label}`);
    }
  }
  const next = content.replace(/^RestrictSUIDSGID=true\n/gmu, "");
  await writeProtectedServiceFile(unitPath, next, captured);
  await context.reloadUnits();
  const installed = await fsp.readFile(unitPath, "utf8");
  if (/^RestrictSUIDSGID=/mu.test(installed) || installed !== next) {
    throw new Error("protected Local controller service policy did not converge");
  }
  return true;
}

function createTransactionContext(overrides = {}) {
  const paths = { ...DEFAULT_PATHS, ...overrides.paths };
  if (
    overrides.paths?.signerStateDBPath &&
    !Object.hasOwn(overrides.paths, "signerMasterKeyPath")
  ) {
    paths.signerMasterKeyPath = path.join(
      path.dirname(overrides.paths.signerStateDBPath),
      "master.key",
    );
  }
  if (overrides.paths?.signerStateDBPath && !Object.hasOwn(overrides.paths, "signerAuditLogPath")) {
    paths.signerAuditLogPath = path.join(
      path.dirname(overrides.paths.signerStateDBPath),
      "audit.jsonl",
    );
  }
  if (
    overrides.paths &&
    !Object.hasOwn(overrides.paths, "applicationReleasesDir") &&
    !Object.hasOwn(overrides.paths, "applicationCurrentLink")
  ) {
    delete paths.applicationReleasesDir;
    delete paths.applicationCurrentLink;
  }
  const controllerConfiguration = overrides.controllerConfiguration ?? null;
  const signerServiceName = overrides.signerServiceName ?? "fased-signerd.service";
  const gatewayServiceName = overrides.gatewayServiceName ?? "fased-gateway.service";
  const signerApplicationSocketPath =
    overrides.signerApplicationSocketPath ?? "/run/fased-signerd/app.sock";
  const gatewayHealthTimeoutMs =
    overrides.gatewayHealthTimeoutMs ?? CROSS_PRODUCT_HEALTH_TIMEOUT_MS;
  const supervised = overrides.supervised === true;
  const rootUid =
    overrides.rootUid ?? (typeof process.geteuid === "function" ? process.geteuid() : 0);
  const runningControllerIdentity =
    overrides.runningControllerIdentity ?? resolveRunningControllerIdentity();
  const stageControllerRelease = supervised
    ? null
    : (overrides.stageControllerRelease ??
      (async (version, transactionContext) =>
        await stageOfficialControllerRelease(version, transactionContext)));
  const context = {
    paths,
    instanceId: overrides.protectedLocalInstanceId ?? null,
    rootUid,
    protectedNodeBinary: overrides.protectedNodeBinary ?? process.execPath,
    supervised,
    controllerInstanceId: overrides.controllerInstanceId ?? randomUUID(),
    runningControllerIdentity,
    runningControllerVersion:
      overrides.runningControllerVersion ??
      runningControllerIdentity?.version ??
      resolveRunningControllerVersion(),
    readSupervisorSelectionReceipt:
      overrides.readSupervisorSelectionReceipt ??
      (async (receipt) => await readSupervisorSelectionReceipt(paths, receipt, rootUid)),
    controllerRestartRequired: false,
    applicationState: overrides.applicationState ?? null,
    applicationTopology: overrides.applicationTopology ?? null,
    allowSyntheticGatewayReceipt: overrides.allowSyntheticGatewayReceipt === true,
    readGatewayReadiness:
      overrides.readGatewayReadiness ??
      (async (endpoint, timeoutMs) => await readGatewayReadinessEndpoint(endpoint, timeoutMs)),
    onDurablePhase: overrides.onDurablePhase,
    beforeHistoricalResidueRemoval: overrides.beforeHistoricalResidueRemoval,
    onLegacyAdoptionPhase: overrides.onLegacyAdoptionPhase,
    historicalQ0TestStateDir: overrides.historicalQ0TestStateDir ?? HISTORICAL_Q0_TEST_STATE_DIR,
    assertReleaseAllowed:
      overrides.assertReleaseAllowed ??
      (async (version) => await assertReleaseChannelAllowed(version, paths.channelPath)),
    downloadReleaseAsset: overrides.downloadReleaseAsset ?? download,
    verifyReleaseAsset: overrides.verifyReleaseAsset ?? verifyReleaseAsset,
    verifyPrivilegedReleaseEvidence:
      overrides.verifyPrivilegedReleaseEvidence ?? verifyPrivilegedReleaseEvidence,
    selfCheckControllerAsset: overrides.selfCheckControllerAsset ?? selfCheckControllerAsset,
    ...(stageControllerRelease ? { stageControllerRelease } : {}),
    stageCandidate:
      overrides.stageCandidate ??
      (async (version, candidatePath, context) =>
        await stageOfficialCandidate(version, candidatePath, context)),
    stageUpdaterGeneration:
      overrides.stageUpdaterGeneration ??
      (async (paths, targetRoot) => await stageTargetManagedUpdaterGeneration(paths, targetRoot)),
    activateUpdaterGeneration:
      overrides.activateUpdaterGeneration ??
      (async (paths, targetRoot, generation) => {
        const bundle = await loadManagedUpdaterBundleModule(targetRoot);
        return await bundle.activateManagedUpdaterGeneration({
          updaterDir: paths.updaterDir,
          generationDir: generation.targetGenerationDir,
          durable: true,
        });
      }),
    restoreUpdaterGeneration:
      overrides.restoreUpdaterGeneration ??
      (async (paths, targetRoot, generation) => {
        const bundle = await loadManagedUpdaterBundleModule(targetRoot);
        return await bundle.restoreManagedUpdaterGeneration({
          updaterDir: paths.updaterDir,
          generationDir: generation.previousGenerationDir,
          durable: true,
        });
      }),
    installCommittedLaunchers:
      overrides.installCommittedLaunchers ??
      (async (journal) => await installCommittedManagedLaunchers(context, journal)),
    discoverApplicationTopology:
      overrides.discoverApplicationTopology ??
      (async () => await discoverProtectedApplicationTopology(context)),
    inventoryApplicationState:
      overrides.inventoryApplicationState ??
      (async (topology) => await inventoryDeclaredApplicationState(topology, context)),
    reconcileApplicationState:
      overrides.reconcileApplicationState ??
      (async (transaction) => await reconcileDeclaredApplicationState(transaction)),
    restoreApplicationState:
      overrides.restoreApplicationState ??
      (async (transaction, txPaths) => await restoreDeclaredApplicationState(transaction, txPaths)),
    snapshotApplicationState:
      overrides.snapshotApplicationState ??
      (async (transaction, txPaths) =>
        await snapshotDeclaredApplicationState(transaction, txPaths)),
    assertSnapshotDiskCapacity:
      overrides.assertSnapshotDiskCapacity ??
      (async (directory, snapshots) => await assertSnapshotDiskCapacity(directory, snapshots)),
    verifyApplicationState:
      overrides.verifyApplicationState ??
      (async (transaction) => await verifyDeclaredStatePreservation(transaction)),
    probeApplicationHealth:
      overrides.probeApplicationHealth ??
      (async (topology, journal) =>
        await probeCrossProductApplicationHealth(context, topology, journal)),
    stopSigner: overrides.stopSigner ?? (async () => await stopSignerService(signerServiceName)),
    startSignerV2:
      overrides.startSignerV2 ??
      (async ({ expectedRelease } = {}) =>
        await startSignerService({
          requireV2: true,
          expectedRelease,
          serviceName: signerServiceName,
          socketPath: signerApplicationSocketPath,
        })),
    startPreviousSigner:
      overrides.startPreviousSigner ??
      (async ({ requireV2 = false } = {}) =>
        await startSignerService({
          requireV2,
          serviceName: signerServiceName,
          socketPath: signerApplicationSocketPath,
        })),
    reloadUnits: overrides.reloadUnits ?? (async () => await systemctl("daemon-reload")),
    ensureControllerServicePolicy:
      overrides.ensureControllerServicePolicy ??
      (async () => await ensureProtectedLocalControllerServicePolicy(context)),
    ensureStableSupervisorBoundary:
      overrides.ensureStableSupervisorBoundary ??
      (controllerConfiguration
        ? async () => await ensureStableSupervisorBoundary(controllerConfiguration, context)
        : async () => false),
    recoverInterruptedTransaction:
      overrides.recoverInterruptedTransaction ??
      (async (options) => await recoverInterruptedTransaction(context, options)),
    applyServiceBoundary:
      overrides.applyServiceBoundary ??
      (async (boundary) => await applyProtectedServiceBoundary(context, boundary)),
    restoreServiceBoundary:
      overrides.restoreServiceBoundary ??
      (async (boundary) => await restoreProtectedServiceBoundary(context, boundary)),
    startGateway:
      overrides.startGateway ?? (async () => await systemctl("start", gatewayServiceName)),
    stopGateway: overrides.stopGateway ?? (async () => await systemctl("stop", gatewayServiceName)),
    restartGateway:
      overrides.restartGateway ?? (async () => await systemctl("restart", gatewayServiceName)),
    verifyGateway:
      overrides.verifyGateway ??
      (async (version, generation) =>
        await probeTargetGateway(context, version, generation, gatewayHealthTimeoutMs)),
    probeSigner:
      overrides.probeSigner ??
      (async (expectedRelease) =>
        await probeSignerV2(expectedRelease, signerApplicationSocketPath)),
    probeSignerState:
      overrides.probeSignerState ??
      (overrides.probeSigner
        ? async () => ({ release: await overrides.probeSigner(), invariant: null })
        : async (expectedRelease) =>
            await probeSignerStateV2(expectedRelease, signerApplicationSocketPath)),
  };
  return context;
}

async function assertSupervisorSelectedController(
  request,
  context,
  { allowProcessRestart = false } = {},
) {
  if (!context.supervised) {
    return null;
  }
  const receipt = parseSupervisorSelectionReceipt(request.supervisorReceipt, request);
  const persisted = await context.readSupervisorSelectionReceipt(receipt);
  if (
    !allowProcessRestart &&
    persisted.schemaVersion === CONTROLLER_SELECTION_SCHEMA_VERSION &&
    (Date.now() < Date.parse(persisted.selectedAt) || Date.now() > Date.parse(persisted.expiresAt))
  ) {
    throw new Error("supervisor controller selection receipt is outside its validity window");
  }
  const running = context.runningControllerIdentity;
  if (
    context.runningControllerVersion !== request.version ||
    !running ||
    running.version !== request.version
  ) {
    throw new Error("running target lifecycle controller identity is mismatched: version");
  }
  if (
    running.serverSha256 !== persisted.controllerServerSha256 ||
    running.clientSha256 !== persisted.controllerClientSha256
  ) {
    throw new Error("running target lifecycle controller identity is mismatched: artifact digest");
  }
  if (!allowProcessRestart && context.controllerInstanceId !== persisted.controllerInstanceId) {
    throw new Error("running target lifecycle controller identity is mismatched: process");
  }
  return persisted;
}

async function controllerForTransaction(request, context) {
  const receipt = await assertSupervisorSelectedController(request, context);
  if (receipt) {
    return {
      changed: false,
      identity: {
        version: receipt.version,
        controllerInstanceId: receipt.controllerInstanceId,
        serverSha256: receipt.controllerServerSha256,
        clientSha256: receipt.controllerClientSha256,
        targetManifestSha256: receipt.targetManifestSha256,
        selectionDigest: receipt.selectionDigest,
        selectedBy: "stable-supervisor",
      },
    };
  }
  if (typeof context.stageControllerRelease !== "function") {
    throw new Error("unsupervised lifecycle controller has no controller staging capability");
  }
  return await context.stageControllerRelease(request.version, context);
}

async function updateControllerRelease(request, context) {
  if (context.supervised) {
    throw new Error("stable lifecycle supervisor owns controller promotion");
  }
  await context.assertReleaseAllowed(request.version);
  await assertRollbackFloor(context, request.version);
  const active = await readJournal(context);
  if (active) {
    assertMatchingTransaction(active, request);
  }
  const controller = await context.stageControllerRelease(request.version, context);
  return {
    transactionId: request.transactionId,
    version: request.version,
    controllerChanged: controller.changed === true,
    controllerInstanceId: context.controllerInstanceId,
  };
}

async function writeGatewayGate(context, journal) {
  await atomicWriteFileDurable(
    context.paths.gatewayGatePath,
    `${JSON.stringify({ transactionId: journal.transactionId, version: journal.version })}\n`,
    0o644,
  );
}

async function writeSignerGate(context, journal) {
  const directory = path.dirname(context.paths.signerGatePath);
  await fsp.mkdir(directory, { recursive: true, mode: 0o755 });
  const directoryStat = await fsp.lstat(directory);
  if (
    !directoryStat.isDirectory() ||
    directoryStat.isSymbolicLink() ||
    directoryStat.uid !== process.geteuid() ||
    (directoryStat.mode & 0o022) !== 0
  ) {
    throw new Error(
      "signer update gate directory must be owned by the updater and not writable by group/others",
    );
  }
  await fsp.chmod(directory, 0o755);
  await atomicWriteFileDurable(
    context.paths.signerGatePath,
    `${JSON.stringify({ transactionId: journal.transactionId, version: journal.version })}\n`,
    0o644,
  );
}

async function writeUpdateGates(context, journal) {
  await writeGatewayGate(context, journal);
  await writeSignerGate(context, journal);
}

async function removeGatewayGate(context) {
  await fsp.rm(context.paths.gatewayGatePath, { force: true });
  await fsyncDirectory(path.dirname(context.paths.gatewayGatePath));
}

async function removeSignerGate(context) {
  await fsp.rm(context.paths.signerGatePath, { force: true });
  await fsyncDirectory(path.dirname(context.paths.signerGatePath));
}

async function removeUpdateGates(context) {
  await removeGatewayGate(context);
  await removeSignerGate(context);
}

async function readGatewayGate(context) {
  try {
    const value = JSON.parse(await fsp.readFile(context.paths.gatewayGatePath, "utf8"));
    return {
      transactionId: parseTransactionId(value.transactionId),
      version: parseReleaseVersion(value.version),
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw new Error("hosted Gateway update gate is invalid", { cause: error });
  }
}

function assertMatchingTransaction(journal, request) {
  if (!journal) {
    throw new Error("host updater transaction does not exist");
  }
  if (journal.transactionId !== request.transactionId || journal.version !== request.version) {
    throw new Error(
      `another hosted signer transaction is active (${journal.transactionId}, v${journal.version})`,
    );
  }
  if (
    journal.supervisorReceipt &&
    (!request.supervisorReceipt ||
      journal.supervisorReceipt.selectionDigest !== request.supervisorReceipt.selectionDigest)
  ) {
    throw new Error("host updater request does not match its supervisor selection receipt");
  }
  if (
    canonicalJSON(journal.legacyAdoption ?? null) !== canonicalJSON(request.legacyAdoption ?? null)
  ) {
    throw new Error("host updater request does not match its legacy adoption binding");
  }
}

async function readRollbackFloor(context) {
  try {
    return parseReleaseVersion(await fsp.readFile(context.paths.rollbackFloorPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw new Error("hosted custody rollback floor is invalid; repair it as root before updating", {
      cause: error,
    });
  }
}

async function assertRollbackFloor(context, targetVersion) {
  const floor = await readRollbackFloor(context);
  if (floor && compareVersions(targetVersion, floor) === -1) {
    throw new Error(
      `refusing signer release v${targetVersion}: hosted custody rollback floor is v${floor}`,
    );
  }
  return floor;
}

async function writeInitialRollbackFloor(context, version) {
  const existing = await readRollbackFloor(context);
  if (existing) {
    if (compareVersions(version, existing) === -1) {
      throw new Error(`cannot commit below hosted custody rollback floor v${existing}`);
    }
    return existing;
  }
  await atomicWriteFileDurable(context.paths.rollbackFloorPath, `${version}\n`, 0o600);
  return version;
}

async function prepareSignerRelease(request, context) {
  const supervisorReceipt = await assertSupervisorSelectedController(request, context);
  await context.assertReleaseAllowed(request.version);
  await assertRollbackFloor(context, request.version);
  const topology = await context.discoverApplicationTopology();
  context.applicationTopology = topology;
  const migrationSelection =
    topology.pendingGatewayUnit || topology.pendingStateDir
      ? null
      : selectLifecycleMigration(topology, request.schemaVersion ?? PROTOCOL_SCHEMA_VERSION);
  const applicationState = managedApplicationStateFromTopology(topology) ?? {};
  context.applicationState = applicationState;
  const applicationStateResult = {
    applicationTopologyDiscovered: true,
    applicationStatePending:
      topology.pendingGatewayUnit === true || topology.pendingStateDir === true,
  };
  const active = await readJournal(context);
  if (active) {
    assertMatchingTransaction(active, request);
    if (active.phase !== "gateway-authorized" && active.phase !== "committing") {
      await writeUpdateGates(context, active);
    } else if (active.phase === "gateway-authorized") {
      await writeSignerGate(context, active);
    }
    return {
      transactionId: active.transactionId,
      version: active.version,
      phase: active.phase,
      changed: active.changed,
      release: active.release,
      ...applicationStateResult,
    };
  }

  const currentVersion = await readVersionFile(context.paths.versionPath);
  if (currentVersion && compareVersions(currentVersion, request.version) === 1) {
    throw new Error(`refusing signer downgrade from ${currentVersion} to ${request.version}`);
  }

  const controller = await controllerForTransaction(request, context);

  let changed = true;
  let release = null;
  let releaseBinding = null;
  let previousSignerInvariant = null;
  let previousSignerState = null;
  if (currentVersion) {
    previousSignerState = await context.probeSignerState();
    parseSignerReleaseIdentity(previousSignerState.release, currentVersion);
    previousSignerInvariant = previousSignerState.invariant;
  }
  if (currentVersion === request.version) {
    try {
      await fsp.access(context.paths.signerPath, fs.constants.X_OK);
      release = parseSignerReleaseIdentity(
        previousSignerState?.release ?? (await context.probeSigner()),
        request.version,
      );
      changed = false;
    } catch {
      changed = true;
    }
  }

  const txPaths = transactionPaths(context.paths, request.transactionId);
  let journal;
  let application = null;
  let managedApplication = null;
  let serviceBoundary = null;
  try {
    await fsp.mkdir(txPaths.transactionDir, { recursive: true, mode: 0o700 });
    const signerUnit = await fileMetadata(context.paths.signerUnitPath);
    if (signerUnit.existed) {
      await atomicCopyFileDurable(context.paths.signerUnitPath, txPaths.signerUnitSnapshotPath, {
        mode: signerUnit.mode,
      });
    }
    if (changed || context.paths.applicationReleasesDir) {
      const staged = await context.stageCandidate(request.version, txPaths.candidatePath, context);
      const stagedRelease = parseSignerReleaseIdentity(staged?.release || staged, request.version);
      if (release && !signerReleaseIdentitiesEqual(release, stagedRelease)) {
        throw new Error("installed signer and attested application target identities differ");
      }
      release = stagedRelease;
      releaseBinding = staged?.binding || null;
      if (!releaseBinding) {
        throw new Error("signer candidate omitted its attested unified release binding");
      }
      if (
        supervisorReceipt &&
        (releaseBinding.manifestDigest !== `sha256:${supervisorReceipt.targetManifestSha256}` ||
          releaseBinding.releaseCommit !== supervisorReceipt.releaseCommit)
      ) {
        throw new Error("target release does not match the supervisor selection receipt");
      }
      if (context.paths.applicationReleasesDir && !staged?.application) {
        throw new Error("protected Local release omitted its root-controlled application runtime");
      }
      application = staged?.application ?? null;
      managedApplication = await prepareManagedApplicationTransaction(
        context,
        request.version,
        application,
        staged?.applicationRelease,
      );
    }
    serviceBoundary = await stageProtectedServiceBoundary(context);
    journal = await writeJournal(context, {
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      transactionId: request.transactionId,
      version: request.version,
      previousVersion: currentVersion,
      release,
      releaseBinding,
      supervisorReceipt,
      legacyAdoption: request.legacyAdoption ?? null,
      controllerChanged: controller.changed === true,
      previousSignerInvariant,
      application,
      managedApplication,
      migrationSelection,
      schemaMigration: lifecycleSchemaMigrationPlan(migrationSelection),
      serviceBoundary,
      declaredState: null,
      healthReceipt: null,
      phase: "prepared",
      changed,
      createdAt: new Date().toISOString(),
      previousBinary: null,
      stateDB: null,
      signerPrivateState: null,
      signerUnit,
      rollbackFromPhase: null,
    });
    await writeUpdateGates(context, journal);
  } catch (error) {
    if (error?.code === "FASED_TEST_CRASH") {
      throw error;
    }
    await cleanupTransactionFiles(context, request.transactionId).catch(() => undefined);
    if (journal) {
      await removeJournal(context).catch(() => undefined);
    }
    await removeUpdateGates(context).catch(() => undefined);
    throw error;
  }
  return {
    transactionId: journal.transactionId,
    version: journal.version,
    phase: journal.phase,
    changed: journal.changed,
    controllerChanged: journal.controllerChanged === true,
    release: journal.release,
    migration: lifecycleMigrationReceipt(journal.migrationSelection),
    ...applicationStateResult,
  };
}

async function restoreSignerUnit(context, journal, txPaths) {
  if (journal.signerUnit?.existed) {
    await fsp.access(txPaths.signerUnitSnapshotPath);
    await atomicCopyFileDurable(txPaths.signerUnitSnapshotPath, context.paths.signerUnitPath, {
      mode: journal.signerUnit.mode || 0o644,
      uid: journal.signerUnit.uid,
      gid: journal.signerUnit.gid,
    });
  } else {
    await fsp.rm(context.paths.signerUnitPath, { force: true });
    await fsyncDirectory(path.dirname(context.paths.signerUnitPath));
  }
  await context.reloadUnits();
}

async function restoreVersionFile(context, previousVersion) {
  if (previousVersion) {
    await atomicWriteFileDurable(context.paths.versionPath, `${previousVersion}\n`, 0o600);
    return;
  }
  await fsp.rm(context.paths.versionPath, { force: true });
  await fsyncDirectory(path.dirname(context.paths.versionPath));
}

async function restoreStateDB(context, journal, txPaths) {
  if (!journal.stateDB || journal.rollbackFromPhase === "snapshotting") {
    return;
  }
  if (journal.stateDB.existed) {
    await fsp.access(txPaths.stateDBSnapshotPath);
    await atomicCopyFileDurable(txPaths.stateDBSnapshotPath, context.paths.signerStateDBPath, {
      mode: journal.stateDB.mode,
      uid: journal.stateDB.uid,
      gid: journal.stateDB.gid,
    });
    return;
  }
  await fsp.rm(context.paths.signerStateDBPath, { force: true });
  await fsyncDirectory(path.dirname(context.paths.signerStateDBPath));
}

async function restorePrivateFile(filePath, snapshotPath, metadata) {
  if (metadata.existed) {
    await fsp.access(snapshotPath);
    await atomicCopyFileDurable(snapshotPath, filePath, {
      mode: metadata.mode,
      uid: metadata.uid,
      gid: metadata.gid,
    });
    const restored = await privateFileSnapshot(filePath, path.basename(filePath));
    if (restored.sha256 !== metadata.sha256 || restored.size !== metadata.size) {
      throw new Error(`signer private-state rollback did not restore ${path.basename(filePath)}`);
    }
    return;
  }
  await fsp.rm(filePath, { force: true });
  await fsyncDirectory(path.dirname(filePath));
}

async function restoreSignerPrivateState(context, journal, txPaths) {
  if (journal.rollbackFromPhase === "snapshotting") {
    return;
  }
  if (!journal.signerPrivateState) {
    await restoreStateDB(context, journal, txPaths);
    return;
  }
  await restorePrivateFile(
    context.paths.signerStateDBPath,
    txPaths.stateDBSnapshotPath,
    journal.signerPrivateState.stateDB,
  );
  await restorePrivateFile(
    context.paths.signerMasterKeyPath,
    txPaths.masterKeySnapshotPath,
    journal.signerPrivateState.masterKey,
  );
  await restorePrivateFile(
    context.paths.signerAuditLogPath,
    txPaths.auditLogSnapshotPath,
    journal.signerPrivateState.auditLog,
  );
}

async function copySignerPrivateStateSnapshot(context, txPaths, snapshot) {
  for (const [sourcePath, snapshotPath, metadata] of [
    [context.paths.signerStateDBPath, txPaths.stateDBSnapshotPath, snapshot.stateDB],
    [context.paths.signerMasterKeyPath, txPaths.masterKeySnapshotPath, snapshot.masterKey],
    [context.paths.signerAuditLogPath, txPaths.auditLogSnapshotPath, snapshot.auditLog],
  ]) {
    if (!metadata.existed) {
      continue;
    }
    await atomicCopyFileDurable(sourcePath, snapshotPath, {
      mode: metadata.mode,
      uid: metadata.uid,
      gid: metadata.gid,
    });
    const copied = await privateFileSnapshot(snapshotPath, path.basename(sourcePath));
    if (copied.sha256 !== metadata.sha256 || copied.size !== metadata.size) {
      throw new Error(`signer private-state snapshot changed for ${path.basename(sourcePath)}`);
    }
  }
}

async function hashFilePrefix(filePath, bytes, label) {
  const handle = await fsp.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < bytes) {
      throw new Error(`${label} was truncated during activation`);
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < bytes) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, bytes - offset),
        offset,
      );
      if (bytesRead <= 0) {
        throw new Error(`${label} was truncated during activation`);
      }
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    return `sha256:${hash.digest("hex")}`;
  } finally {
    await handle.close();
  }
}

async function verifySignerPrivateStateAfterActivation(context, snapshot) {
  const [stateDB, masterKey, auditLog] = await Promise.all([
    privateFileSnapshot(context.paths.signerStateDBPath, "signer database"),
    privateFileSnapshot(context.paths.signerMasterKeyPath, "signer master key"),
    privateFileSnapshot(context.paths.signerAuditLogPath, "signer audit log"),
  ]);
  if (!stateDB.existed) {
    throw new Error("activated signer did not establish its state database");
  }
  if (
    snapshot.masterKey.existed &&
    (!masterKey.existed || masterKey.sha256 !== snapshot.masterKey.sha256)
  ) {
    throw new Error("activated signer changed its master-key identity");
  }
  if (!masterKey.existed) {
    throw new Error("activated signer did not establish its master key");
  }
  if (snapshot.auditLog.existed) {
    if (
      !auditLog.existed ||
      auditLog.size < snapshot.auditLog.size ||
      (await hashFilePrefix(
        context.paths.signerAuditLogPath,
        snapshot.auditLog.size,
        "signer audit log",
      )) !== snapshot.auditLog.sha256
    ) {
      throw new Error("activated signer truncated or rewrote its audit history");
    }
  }
  return Object.freeze({ stateDB, masterKey, auditLog });
}

async function restorePreviousBinary(context, journal, txPaths) {
  if (journal.previousBinary?.existed) {
    await fsp.access(txPaths.previousBinaryPath);
    await atomicCopyFileDurable(txPaths.previousBinaryPath, context.paths.signerPath, {
      mode: journal.previousBinary.mode || 0o755,
      uid: journal.previousBinary.uid,
      gid: journal.previousBinary.gid,
    });
    return true;
  }
  await fsp.rm(context.paths.signerPath, { force: true });
  await fsyncDirectory(path.dirname(context.paths.signerPath));
  return false;
}

async function selectProtectedApplication(context, releaseRoot) {
  if (!context.paths.applicationCurrentLink) {
    return;
  }
  await prepareProtectedApplicationDirectories(context.paths);
  const expectedParent = path.resolve(context.paths.applicationReleasesDir);
  const selected = path.resolve(releaseRoot);
  if (path.dirname(selected) !== expectedParent) {
    throw new Error("protected application activation escaped its release root");
  }
  const stat = await fsp.lstat(selected);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.geteuid() ||
    (stat.mode & 0o022) !== 0
  ) {
    throw new Error("protected application activation target is unsafe");
  }
  await atomicSymlinkDurable(selected, context.paths.applicationCurrentLink);
}

async function activateProtectedApplication(context, journal) {
  if (journal.application) {
    await selectProtectedApplication(context, journal.application.targetRoot);
  }
}

async function restoreProtectedApplication(context, journal) {
  if (journal.application) {
    if (journal.application.previousRoot === null) {
      await fsp.rm(context.paths.applicationCurrentLink, { force: true });
      await fsyncDirectory(path.dirname(context.paths.applicationCurrentLink));
    } else {
      await selectProtectedApplication(context, journal.application.previousRoot);
    }
  }
}

function rollbackHasPreviousGatewayRuntime(journal) {
  if (journal.application) {
    return journal.application.previousRoot != null;
  }
  if (journal.managedApplication) {
    return journal.managedApplication.previousRoot != null;
  }
  // Signer-only transactions predate root-managed application activation.
  // Preserve their established rollback behavior.
  return true;
}

function rollbackMayHaveStartedTargetGateway(journal) {
  const phase = journal.rollbackFromPhase || journal.phase;
  return new Set([
    "gateway-authorized",
    "gateway-verified",
    "committing",
    "rolling-back",
    "restored",
  ]).has(phase);
}

async function stopTargetGatewayForRollback(context, journal) {
  if (!rollbackMayHaveStartedTargetGateway(journal)) {
    return;
  }
  try {
    await context.stopGateway();
  } catch (error) {
    if (!/not found|not loaded|no such file/i.test(error?.message || "")) {
      throw error;
    }
  }
}

async function removeDerivedPluginStatusCache(context) {
  const topology = context.applicationTopology;
  if (!topology?.stateDir) {
    return;
  }
  await fsp.rm(targetPluginStatusCachePath(topology), { force: true });
}

async function rollbackSignerRelease(request, context, { preserveGatewayGate = false } = {}) {
  let journal = await readJournal(context);
  if (!journal) {
    if (!preserveGatewayGate) {
      await removeUpdateGates(context);
    }
    return {
      transactionId: request.transactionId,
      version: request.version,
      phase: "rolled-back",
      changed: false,
    };
  }
  assertMatchingTransaction(journal, request);
  const restartPreviousGateway = rollbackHasPreviousGatewayRuntime(journal);
  await writeUpdateGates(context, journal);
  await stopTargetGatewayForRollback(context, journal);
  const txPaths = transactionPaths(context.paths, journal.transactionId);
  if (journal.phase === "restored") {
    await restoreManagedApplication(context, journal);
    await restoreProtectedApplication(context, journal);
    await context.restoreServiceBoundary(journal.serviceBoundary);
    await context.restoreApplicationState(journal.declaredState, txPaths);
    await removeDerivedPluginStatusCache(context);
    await cleanupTransactionFiles(context, journal.transactionId);
    await removeJournal(context);
    await removeManagedUpdateLock(journal);
    if (!preserveGatewayGate) {
      await removeUpdateGates(context);
      if (restartPreviousGateway) {
        try {
          await context.startGateway();
        } catch (error) {
          if (!/not found|not loaded|no such file/i.test(error?.message || "")) {
            throw error;
          }
        }
      }
    }
    return {
      transactionId: journal.transactionId,
      version: journal.version,
      phase: "rolled-back",
      changed: journal.changed,
    };
  }
  const rollbackFromPhase = journal.rollbackFromPhase || journal.phase;
  journal = await writeJournal(context, {
    ...journal,
    phase: "rolling-back",
    rollbackFromPhase,
  });

  // A host can reboot after prepare while the installer has already replaced
  // the unit. Always quiesce before restoring unit semantics, even though the
  // updater itself does not mutate the live signer during prepare.
  const signerMayNeedRestart = true;
  await context.stopSigner();
  await restoreManagedApplication(context, journal);
  await restoreProtectedApplication(context, journal);
  await context.restoreServiceBoundary(journal.serviceBoundary);
  await context.restoreApplicationState(journal.declaredState, txPaths);
  await removeDerivedPluginStatusCache(context);
  await restoreSignerUnit(context, journal, txPaths);
  if (journal.changed && rollbackFromPhase !== "prepared") {
    const candidateMayHaveRun = new Set([
      "activating",
      "active",
      "gateway-authorized",
      "gateway-verified",
      "committing",
      "rolling-back",
    ]).has(rollbackFromPhase);
    if (candidateMayHaveRun) {
      await restorePreviousBinary(context, journal, txPaths);
      await restoreSignerPrivateState(context, journal, txPaths);
      await restoreVersionFile(context, journal.previousVersion);
    }
  }
  if (signerMayNeedRestart && (await fileMetadata(context.paths.signerPath)).existed) {
    await context.startPreviousSigner({ requireV2: Boolean(await readRollbackFloor(context)) });
  }

  journal = await writeJournal(context, { ...journal, phase: "restored" });
  await cleanupTransactionFiles(context, journal.transactionId);
  await removeJournal(context);
  await removeManagedUpdateLock(journal);
  if (!preserveGatewayGate) {
    await removeUpdateGates(context);
    if (restartPreviousGateway) {
      try {
        await context.startGateway();
      } catch (error) {
        if (!/not found|not loaded|no such file/i.test(error?.message || "")) {
          throw error;
        }
      }
    }
  }
  return {
    transactionId: journal.transactionId,
    version: journal.version,
    phase: "rolled-back",
    changed: journal.changed,
  };
}

async function authorizeGatewayRelease(request, context) {
  let journal = await readJournal(context);
  assertMatchingTransaction(journal, request);
  if (journal.phase !== "active" && journal.phase !== "gateway-authorized") {
    throw new Error(`signer transaction cannot authorize Gateway from phase ${journal.phase}`);
  }
  if (journal.phase !== "gateway-authorized") {
    journal = await writeJournal(context, { ...journal, phase: "gateway-authorized" });
  }
  try {
    await writeSignerGate(context, journal);
    await context.applyServiceBoundary(journal.serviceBoundary);
    await activateProtectedApplication(context, journal);
    await selectManagedApplication(context, journal);
    journal = await writeJournal(context, {
      ...journal,
      schemaMigration: await completeLifecycleSchemaMigrations(context, journal),
    });
    await fsp.rm(targetPluginStatusCachePath(context.applicationTopology), {
      force: true,
    });
    await removeGatewayGate(context);
    try {
      await context.startGateway();
    } catch (error) {
      if (!/not found|not loaded|no such file/i.test(error?.message || "")) {
        throw error;
      }
    }
  } catch (error) {
    await context.stopGateway().catch((stopError) => {
      if (!/not found|not loaded|no such file/i.test(stopError?.message || "")) {
        throw stopError;
      }
    });
    await restoreManagedApplication(context, journal).catch(() => undefined);
    await restoreProtectedApplication(context, journal).catch(() => undefined);
    await context.restoreServiceBoundary(journal.serviceBoundary).catch(() => undefined);
    await writeUpdateGates(context, journal).catch(() => undefined);
    throw error;
  }
  return {
    transactionId: journal.transactionId,
    version: journal.version,
    phase: journal.phase,
    changed: journal.changed,
    release: journal.release,
  };
}

async function gateGatewayRelease(request, context) {
  let journal = await readJournal(context);
  if (!journal) {
    const gate = await readGatewayGate(context);
    if (gate?.transactionId !== request.transactionId || gate?.version !== request.version) {
      throw new Error("host updater transaction does not exist");
    }
    return {
      transactionId: gate.transactionId,
      version: gate.version,
      phase: "rolled-back-gated",
      changed: false,
    };
  }
  assertMatchingTransaction(journal, request);
  if (journal.phase === "committing") {
    throw new Error("cannot gate a Gateway after the signer commit decision");
  }
  await writeUpdateGates(context, journal);
  try {
    await context.stopGateway();
  } catch (error) {
    if (!/not found|not loaded|no such file/i.test(error?.message || "")) {
      throw error;
    }
  }
  if (journal.phase !== "prepared") {
    return {
      transactionId: journal.transactionId,
      version: journal.version,
      phase: journal.phase,
      changed: journal.changed,
      release: journal.release,
    };
  }
  const topology = await context.discoverApplicationTopology();
  if (topology.pendingGatewayUnit || topology.pendingStateDir) {
    throw new Error("application topology remained incomplete after the Gateway was quiesced");
  }
  context.applicationTopology = topology;
  context.applicationState = managedApplicationStateFromTopology(topology);
  const migrationSelection = assertSameMigrationSelection(
    journal.migrationSelection,
    selectLifecycleMigration(topology, request.schemaVersion ?? PROTOCOL_SCHEMA_VERSION),
  );
  if (migrationSelection.adapters.sharedState !== "declared-state-registry-v1") {
    throw new Error("selected lifecycle migration has no supported shared-state adapter");
  }
  const schemaMigration = journal.schemaMigration
    ? validateLifecycleSchemaMigration(journal.schemaMigration, migrationSelection)
    : lifecycleSchemaMigrationPlan(migrationSelection);
  const declaredState = await context.inventoryApplicationState(topology, migrationSelection);
  const txPaths = transactionPaths(context.paths, journal.transactionId);
  await context.snapshotApplicationState(declaredState, txPaths);
  journal = await writeJournal(context, {
    ...journal,
    phase: "state-reconciling",
    migrationSelection,
    schemaMigration,
    declaredState,
  });
  if (declaredState) {
    await assertSharedDirectoryModesAvailable(
      declaredState.stateDir,
      declaredState.operatorUid,
      declaredState.configGid,
    );
    const result = await context.reconcileApplicationState(declaredState, migrationSelection);
    journal = await writeJournal(context, {
      ...journal,
      phase: "state-reconciled",
      declaredState: {
        ...declaredState,
        ...result,
        converged: true,
        reconciled: true,
      },
    });
  } else {
    journal = await writeJournal(context, {
      ...journal,
      phase: "state-reconciled",
    });
  }
  journal = await writeJournal(context, {
    ...journal,
    phase: "schema-ready",
    schemaMigration: prepareLifecycleSchemaMigrations(journal),
  });
  return {
    transactionId: journal.transactionId,
    version: journal.version,
    phase: journal.phase,
    changed: journal.changed,
    release: journal.release,
  };
}

async function restartGatewayService(request, context) {
  const journal = await readJournal(context);
  if (journal) {
    if (journal.phase === "gateway-authorized" && journal.version === request.version) {
      const gatewayGate = await readGatewayGate(context);
      if (!gatewayGate) {
        // Older managed updaters ask the root controller to restart the
        // Gateway immediately after authorizeGatewayRelease already started
        // the exact target service. The promoted target controller must
        // remain compatible with that in-flight coordinator. Treat only this
        // version-bound, post-authorization request as the redundant no-op it
        // is; every other restart during a transaction remains forbidden.
        return {
          transactionId: request.transactionId,
          version: request.version,
          phase: "gateway-authorized",
          changed: false,
        };
      }
    }
    throw new Error("cannot restart the Gateway while a hosted release transaction is active");
  }
  const installedVersion = await readVersionFile(context.paths.versionPath);
  if (installedVersion !== request.version) {
    throw new Error(
      `Gateway restart version ${request.version} does not match installed signer ${installedVersion || "unknown"}`,
    );
  }
  await context.restartGateway();
  return {
    transactionId: request.transactionId,
    version: request.version,
    phase: "restarted",
    changed: false,
  };
}

async function activateSignerRelease(request, context) {
  let journal = await readJournal(context);
  assertMatchingTransaction(journal, request);
  if (journal.phase === "active" || journal.phase === "gateway-authorized") {
    return {
      transactionId: journal.transactionId,
      version: journal.version,
      phase: journal.phase,
      changed: journal.changed,
      release: journal.release,
    };
  }
  if (journal.phase === "prepared") {
    await gateGatewayRelease(request, context);
    journal = await readJournal(context);
  }
  if (journal.phase === "state-reconciled") {
    journal = await writeJournal(context, {
      ...journal,
      phase: "schema-ready",
      schemaMigration: prepareLifecycleSchemaMigrations(journal),
    });
  }
  if (!journal.migrationSelection) {
    throw new Error("signer transaction has no validated lifecycle migration selection");
  }
  if (journal.phase !== "schema-ready") {
    throw new Error(`signer transaction cannot activate from phase ${journal.phase}`);
  }
  if (!journal.changed) {
    journal = await writeJournal(context, { ...journal, phase: "active" });
    return {
      transactionId: journal.transactionId,
      version: journal.version,
      phase: journal.phase,
      changed: false,
      release: journal.release,
    };
  }

  const txPaths = transactionPaths(context.paths, journal.transactionId);
  try {
    await context.stopSigner();
    const previousBinary = await fileMetadata(context.paths.signerPath);
    const signerPrivateState = validateSignerPrivateStateSnapshot({
      schemaVersion: 1,
      stateDB: await privateFileSnapshot(context.paths.signerStateDBPath, "signer database"),
      masterKey: await privateFileSnapshot(context.paths.signerMasterKeyPath, "signer master key"),
      auditLog: await privateFileSnapshot(context.paths.signerAuditLogPath, "signer audit log"),
    });
    await context.assertSnapshotDiskCapacity(txPaths.transactionDir, [
      signerPrivateState.stateDB,
      signerPrivateState.masterKey,
      signerPrivateState.auditLog,
    ]);
    journal = await writeJournal(context, {
      ...journal,
      phase: "snapshotting",
      previousBinary,
      stateDB: signerPrivateState.stateDB,
      signerPrivateState,
    });
    if (previousBinary.existed) {
      await atomicCopyFileDurable(context.paths.signerPath, txPaths.previousBinaryPath, {
        mode: previousBinary.mode,
      });
    }
    await copySignerPrivateStateSnapshot(context, txPaths, signerPrivateState);
    journal = await writeJournal(context, { ...journal, phase: "activating" });
    await fsp.rename(txPaths.candidatePath, context.paths.signerPath);
    await fsyncDirectory(path.dirname(context.paths.signerPath));
    const activatedState = await context.startSignerV2({ expectedRelease: journal.release });
    if (
      journal.previousSignerInvariant &&
      activatedState?.invariant !== journal.previousSignerInvariant
    ) {
      throw new Error(
        "activated signer did not preserve exact wallet, policy, network, and WebAuthn state",
      );
    }
    await verifySignerPrivateStateAfterActivation(context, signerPrivateState);
    await atomicWriteFileDurable(context.paths.versionPath, `${journal.version}\n`, 0o600);
    journal = await writeJournal(context, { ...journal, phase: "active" });
    return {
      transactionId: journal.transactionId,
      version: journal.version,
      phase: journal.phase,
      changed: true,
      release: journal.release,
    };
  } catch (error) {
    if (error?.code === "FASED_TEST_CRASH") {
      throw error;
    }
    let rollbackError = null;
    try {
      await rollbackSignerRelease(request, context, {
        // A supervised controller owns the complete product transaction. Its
        // failure response is not handed back to an outer application
        // coordinator, so rollback must also restore the previous Gateway.
        // Legacy unsupervised callers still restore the application first and
        // therefore keep the Gateway gated until their outer rollback ends.
        preserveGatewayGate: !context.supervised,
      });
    } catch (caught) {
      rollbackError = caught;
    }
    if (rollbackError) {
      throw new Error(
        `signer activation failed and rollback is incomplete: ${error.message}; rollback error: ${rollbackError.message}`,
        { cause: error },
      );
    }
    throw new Error(`signer activation failed and was rolled back: ${error.message}`, {
      cause: error,
    });
  }
}

async function readHistoricalQ0Json(filePath, label, context) {
  let stat;
  try {
    stat = await fsp.lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.uid !== context.rootUid ||
    (stat.mode & 0o022) !== 0 ||
    stat.size > 2 * 1024 * 1024
  ) {
    throw new Error(`historical ${label} is unsafe`);
  }
  try {
    return {
      filePath,
      value: JSON.parse(await fsp.readFile(filePath, "utf8")),
    };
  } catch (error) {
    throw new Error(`historical ${label} is invalid`, { cause: error });
  }
}

function historicalReleaseChild(root, candidate, pattern, label) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(String(candidate || ""));
  if (path.dirname(resolved) !== resolvedRoot || !pattern.test(path.basename(resolved))) {
    throw new Error(`historical ${label} path is invalid`);
  }
  return resolved;
}

async function assertHistoricalGeneration(root, label, context) {
  const stat = await fsp.lstat(root);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== context.rootUid ||
    (stat.mode & 0o022) !== 0
  ) {
    throw new Error(`historical ${label} generation is unsafe`);
  }
}

async function addHistoricalCandidateIfPresent(candidates, root, label, context) {
  try {
    await assertHistoricalGeneration(root, label, context);
    candidates.add(root);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

async function listHistoricalCandidateGenerations(root, pattern, label, context) {
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const result = [];
  for (const entry of entries) {
    if (!pattern.test(entry.name)) {
      continue;
    }
    const generation = path.join(root, entry.name);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(`historical ${label} generation is unsafe`);
    }
    await assertHistoricalGeneration(generation, label, context);
    result.push(generation);
  }
  return result;
}

async function removeValidatedHistoricalResidue(residuePath, options) {
  try {
    await fsp.rm(residuePath, options);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function inspectHistoricalQ0StateDirectory(directory, allowedNames, context) {
  let stat;
  try {
    stat = await fsp.lstat(directory);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { exists: false, stat: null };
    }
    throw error;
  }
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== context.rootUid ||
    (stat.mode & 0o022) !== 0
  ) {
    throw new Error("historical Protected Local test state directory is unsafe");
  }
  const entries = await fsp.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (!allowedNames.has(entry.name)) {
      throw new Error(
        `historical Protected Local test state directory contains unknown entry ${entry.name}`,
      );
    }
  }
  const revalidated = await fsp.lstat(directory);
  if (
    !revalidated.isDirectory() ||
    revalidated.isSymbolicLink() ||
    revalidated.dev !== stat.dev ||
    revalidated.ino !== stat.ino
  ) {
    throw new Error("historical Protected Local test state directory changed during inventory");
  }
  return { exists: true, stat };
}

async function cleanupHistoricalQ0Residue(context, journal) {
  if (!context.instanceId) {
    return { changed: false, removed: [] };
  }

  const testStateDir = path.resolve(context.historicalQ0TestStateDir);
  const authorizationPath = path.join(testStateDir, "protected-local-artifact-source.json");
  const authorizationBackupPath = path.join(
    testStateDir,
    "q0-protected-local-artifact-source-backup.json",
  );
  const controllerBackupPath = path.join(context.paths.stateDir, "q0-controller-candidate.json");
  const applicationBackupPath = path.join(context.paths.stateDir, "q0-application-candidate.json");
  const historicalStateDirectory = await inspectHistoricalQ0StateDirectory(
    testStateDir,
    new Set([path.basename(authorizationPath), path.basename(authorizationBackupPath)]),
    context,
  );

  const [authorization, authorizationBackup, controllerBackup, applicationBackup] =
    await Promise.all([
      readHistoricalQ0Json(authorizationPath, "Protected Local artifact authorization", context),
      readHistoricalQ0Json(
        authorizationBackupPath,
        "Protected Local artifact authorization backup",
        context,
      ),
      readHistoricalQ0Json(controllerBackupPath, "controller candidate backup", context),
      readHistoricalQ0Json(applicationBackupPath, "application candidate backup", context),
    ]);

  if (authorization) {
    const value = authorization.value;
    if (
      value?.schemaVersion !== 1 ||
      value.protectedLocalInstance !== context.instanceId ||
      value.forceSameVersionRepair !== true ||
      !/^http:\/\/127\.0\.0\.1:\d+$/u.test(value.baseUrl || "") ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u.test(value.releaseVersion || "") ||
      !/^[a-f0-9]{40}$/u.test(value.releaseCommit || "")
    ) {
      throw new Error("historical Protected Local artifact authorization is invalid");
    }
  }
  if (authorizationBackup) {
    const value = authorizationBackup.value;
    if (value?.schemaVersion !== 1 || typeof value.previous?.exists !== "boolean") {
      throw new Error("historical Protected Local artifact authorization backup is invalid");
    }
  }

  const controllerCandidateRoots = new Set();
  const applicationCandidateRoots = new Set();
  if (controllerBackup) {
    const value = controllerBackup.value;
    if (
      value?.schemaVersion !== 1 ||
      typeof value.identityBase64 !== "string" ||
      !Number.isSafeInteger(value.identityMode) ||
      value.identityMode < 0 ||
      value.identityMode > 0o777
    ) {
      throw new Error("historical controller candidate backup is invalid");
    }
    const originalRoot = historicalReleaseChild(
      context.paths.controllerReleasesDir,
      value.originalRoot,
      /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u,
      "controller official generation",
    );
    const candidateRoot = historicalReleaseChild(
      context.paths.controllerReleasesDir,
      value.candidateRoot,
      /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?\.q0\.[a-f0-9]{12}$/u,
      "controller candidate generation",
    );
    await assertHistoricalGeneration(originalRoot, "controller official", context);
    const originalIdentity = parseControllerIdentity(
      JSON.parse(Buffer.from(value.identityBase64, "base64").toString("utf8")),
    );
    const originalDigests = await readControllerGenerationDigests(originalRoot);
    if (
      originalDigests.serverSha256 !== originalIdentity.serverSha256 ||
      originalDigests.clientSha256 !== originalIdentity.clientSha256
    ) {
      throw new Error("historical controller official generation identity is mismatched");
    }
    await addHistoricalCandidateIfPresent(
      controllerCandidateRoots,
      candidateRoot,
      "controller candidate",
      context,
    );
  }

  if (applicationBackup) {
    const value = applicationBackup.value;
    if (
      value?.schemaVersion !== 1 ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u.test(value.version || "") ||
      !/^[a-f0-9]{40}$/u.test(value.commit || "") ||
      !Number.isSafeInteger(value.linkOwner?.uid) ||
      !Number.isSafeInteger(value.linkOwner?.gid)
    ) {
      throw new Error("historical application candidate backup is invalid");
    }
    const originalRoot = historicalReleaseChild(
      context.paths.applicationReleasesDir,
      value.originalRoot,
      /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u,
      "application official generation",
    );
    const candidateRoot = historicalReleaseChild(
      context.paths.applicationReleasesDir,
      value.candidateRoot,
      /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?\.q0-app\.[a-f0-9]{12}$/u,
      "application candidate generation",
    );
    await assertHistoricalGeneration(originalRoot, "application official", context);
    await verifyProtectedApplicationRuntime(originalRoot, value.version, value.commit);
    await addHistoricalCandidateIfPresent(
      applicationCandidateRoots,
      candidateRoot,
      "application candidate",
      context,
    );
  }

  const [controllerCandidates, applicationCandidates] = await Promise.all([
    listHistoricalCandidateGenerations(
      context.paths.controllerReleasesDir,
      /^v.+\.q0\.[a-f0-9]{12}$/u,
      "controller candidate",
      context,
    ),
    context.paths.applicationReleasesDir
      ? listHistoricalCandidateGenerations(
          context.paths.applicationReleasesDir,
          /^v.+\.q0-app\.[a-f0-9]{12}$/u,
          "application candidate",
          context,
        )
      : [],
  ]);
  for (const candidate of controllerCandidates) {
    controllerCandidateRoots.add(candidate);
  }
  for (const candidate of applicationCandidates) {
    applicationCandidateRoots.add(candidate);
  }
  if (context.supervised && controllerCandidateRoots.size > 0) {
    throw new Error("stable lifecycle supervisor did not clean historical controller residue");
  }
  const candidateRoots = new Set([
    ...(context.supervised ? [] : controllerCandidateRoots),
    ...applicationCandidateRoots,
  ]);
  const residueFiles = [
    authorization?.filePath,
    authorizationBackup?.filePath,
    controllerBackup?.filePath,
    applicationBackup?.filePath,
  ].filter(Boolean);
  if (candidateRoots.size === 0 && residueFiles.length === 0 && !historicalStateDirectory.exists) {
    return { changed: false, removed: [] };
  }

  if (context.supervised) {
    await assertSupervisorSelectedController(
      {
        transactionId: journal.transactionId,
        version: journal.version,
        supervisorReceipt: journal.supervisorReceipt,
      },
      context,
      { allowProcessRestart: true },
    );
    const activeController = await fsp.realpath(context.paths.controllerCurrentLink);
    if (
      activeController !==
      path.join(path.resolve(context.paths.controllerReleasesDir), `v${journal.version}`)
    ) {
      throw new Error(
        "supervisor-selected controller did not converge before historical residue cleanup",
      );
    }
  } else {
    const controllerIdentity = await readControllerIdentity(context.paths);
    if (
      !controllerIdentity ||
      controllerIdentity.version !== journal.version ||
      !(await currentControllerMatches(context.paths, controllerIdentity))
    ) {
      throw new Error(
        "official controller identity did not converge before historical residue cleanup",
      );
    }
  }

  let activeApplication = null;
  if (context.paths.applicationCurrentLink) {
    if (!journal.application || !journal.releaseBinding?.releaseCommit) {
      throw new Error(
        "official application identity is unavailable before historical residue cleanup",
      );
    }
    activeApplication = await fsp.realpath(context.paths.applicationCurrentLink);
    const expectedApplication = protectedApplicationReleaseRoot(context.paths, journal.version);
    if (
      activeApplication !== expectedApplication ||
      path.basename(activeApplication) !== `v${journal.version}`
    ) {
      throw new Error(
        "official application identity did not converge before historical residue cleanup",
      );
    }
    await verifyProtectedApplicationRuntime(
      activeApplication,
      journal.version,
      journal.releaseBinding.releaseCommit,
    );
  }
  const activeController = await fsp.realpath(context.paths.controllerCurrentLink);
  for (const candidate of candidateRoots) {
    if (candidate === activeController || candidate === activeApplication) {
      throw new Error("historical candidate generation is still active");
    }
  }

  await context.beforeHistoricalResidueRemoval?.({
    candidateRoots: [...candidateRoots],
    residueFiles: [...residueFiles],
  });

  const removed = [];
  for (const candidate of candidateRoots) {
    if (await removeValidatedHistoricalResidue(candidate, { recursive: true })) {
      removed.push(candidate);
    }
  }
  for (const filePath of residueFiles.filter((entry) => path.dirname(entry) !== testStateDir)) {
    if (await removeValidatedHistoricalResidue(filePath)) {
      removed.push(filePath);
    }
  }
  if (historicalStateDirectory.exists) {
    const current = await fsp.lstat(testStateDir);
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== historicalStateDirectory.stat.dev ||
      current.ino !== historicalStateDirectory.stat.ino
    ) {
      throw new Error("historical Protected Local test state directory changed before cleanup");
    }
    const remainingEntries = await fsp.readdir(testStateDir);
    const allowedNames = new Set([
      path.basename(authorizationPath),
      path.basename(authorizationBackupPath),
    ]);
    for (const entry of remainingEntries) {
      if (!allowedNames.has(entry)) {
        throw new Error(
          `historical Protected Local test state directory contains unknown entry ${entry}`,
        );
      }
    }
    if (await removeValidatedHistoricalResidue(testStateDir, { recursive: true })) {
      removed.push(testStateDir);
    }
  }
  const residueDirectories = new Set(
    [
      ...candidateRoots,
      ...residueFiles.filter((entry) => path.dirname(entry) !== testStateDir),
    ].map((entry) => path.dirname(entry)),
  );
  residueDirectories.add(path.dirname(testStateDir));
  for (const directory of residueDirectories) {
    await fsyncDirectory(directory);
  }
  return { changed: true, removed };
}

async function recordTargetApplicationSuccess(context, journal) {
  if (!journal.managedApplication) {
    return;
  }
  const state = context.applicationState;
  const markerPath = path.join(journal.managedApplication.stateDir, "last-update-success.json");
  await atomicWriteFileDurable(
    markerPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        mode: "managed",
        version: journal.version,
        alreadyCurrent: false,
        migration: lifecycleMigrationReceipt(journal.migrationSelection),
        schemaMigration: lifecycleSchemaMigrationReceipt(
          journal.schemaMigration,
          journal.migrationSelection,
        ),
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    0o660,
  );
  await fsp.chown(markerPath, state.operatorUid, state.configGid);
  await fsyncDirectory(journal.managedApplication.stateDir);
}

function legacyAdoptionAckPath(context, binding, transactionId) {
  return path.join(
    context.paths.stateDir,
    "legacy-adoption-acks",
    binding.transactionId,
    `${transactionId}.json`,
  );
}

function validateLegacyAdoptionSourceIdentity(value, label) {
  exactObjectKeys(
    value,
    ["dev", "gid", "ino", "mode", "sha256", "size", "uid"],
    `${label} identity`,
  );
  if (
    !Number.isSafeInteger(value.dev) ||
    value.dev < 0 ||
    !Number.isSafeInteger(value.ino) ||
    value.ino < 1 ||
    !Number.isSafeInteger(value.uid) ||
    value.uid < 1 ||
    !Number.isSafeInteger(value.gid) ||
    value.gid < 1 ||
    !Number.isSafeInteger(value.mode) ||
    (value.mode & 0o177) !== 0 ||
    !Number.isSafeInteger(value.size) ||
    value.size < 2 ||
    !/^sha256:[a-f0-9]{64}$/u.test(value.sha256 || "")
  ) {
    throw new Error(`legacy adoption ${label} identity is invalid`);
  }
  return Object.freeze({ ...value });
}

function parseLegacyAdoptionAck(value, binding, request) {
  exactObjectKeys(
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
    "legacy adoption completion acknowledgment",
  );
  const unsigned = Object.freeze({
    schemaVersion: Number(value.schemaVersion),
    transactionId: parseTransactionId(value.transactionId),
    version: parseReleaseVersion(value.version),
    legacyTransactionId: parseTransactionId(value.legacyTransactionId),
    adoptionReceiptDigest: String(value.adoptionReceiptDigest ?? ""),
    adoptionReceipt: validateLegacyAdoptionSourceIdentity(value.adoptionReceipt, "receipt"),
    legacyJournal: validateLegacyAdoptionSourceIdentity(value.legacyJournal, "journal"),
    outcome: String(value.outcome ?? ""),
    installedVersion: parseReleaseVersion(value.installedVersion),
    state: String(value.state ?? ""),
    issuedAt: String(value.issuedAt ?? ""),
    acknowledgedAt: value.acknowledgedAt === null ? null : String(value.acknowledgedAt ?? ""),
  });
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
    !Number.isFinite(issuedAt) ||
    new Date(issuedAt).toISOString() !== unsigned.issuedAt ||
    (unsigned.state === "pending" && unsigned.acknowledgedAt !== null) ||
    (unsigned.state === "acknowledged" &&
      (!Number.isFinite(acknowledgedAt) ||
        new Date(acknowledgedAt).toISOString() !== unsigned.acknowledgedAt)) ||
    receiptDigest !== `sha256:${createHash("sha256").update(canonicalJSON(unsigned)).digest("hex")}`
  ) {
    throw new Error("legacy adoption completion acknowledgment is mismatched");
  }
  return Object.freeze({ ...unsigned, receiptDigest });
}

async function readLegacyAdoptionAck(context, binding, request) {
  const ackPath = legacyAdoptionAckPath(context, binding, request.transactionId);
  try {
    const named = await fsp.lstat(ackPath);
    if (
      !named.isFile() ||
      named.isSymbolicLink() ||
      named.nlink !== 1 ||
      named.uid !== context.rootUid ||
      (named.mode & 0o177) !== 0 ||
      named.size <= 0 ||
      named.size > 16 * 1024
    ) {
      throw new Error("legacy adoption completion acknowledgment is not protected");
    }
    const handle = await fsp.open(ackPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.nlink !== 1 ||
        opened.dev !== named.dev ||
        opened.ino !== named.ino ||
        opened.uid !== context.rootUid ||
        (opened.mode & 0o177) !== 0 ||
        opened.size !== named.size
      ) {
        throw new Error("legacy adoption completion acknowledgment changed while opening");
      }
      const bytes = await handle.readFile();
      const rebound = await handle.stat();
      if (
        rebound.dev !== opened.dev ||
        rebound.ino !== opened.ino ||
        rebound.size !== opened.size ||
        rebound.mtimeMs !== opened.mtimeMs ||
        bytes.length !== opened.size
      ) {
        throw new Error("legacy adoption completion acknowledgment changed while reading");
      }
      return parseLegacyAdoptionAck(JSON.parse(bytes.toString("utf8")), binding, request);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function readBoundedLegacyAdoptionSource(
  filePath,
  label,
  expectedOwnerUid,
  { optional = false, maxBytes = 2 * 1024 * 1024 } = {},
) {
  let named;
  try {
    named = await fsp.lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT" && optional) {
      return null;
    }
    throw error;
  }
  if (
    !named.isFile() ||
    named.isSymbolicLink() ||
    named.nlink !== 1 ||
    named.uid !== expectedOwnerUid ||
    (named.mode & 0o177) !== 0 ||
    named.size < 2 ||
    named.size > maxBytes
  ) {
    throw new Error(`legacy adoption ${label} is not a safe owner-only bounded file`);
  }
  const handle = await fsp.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.dev !== named.dev ||
      opened.ino !== named.ino ||
      opened.uid !== expectedOwnerUid
    ) {
      throw new Error(`legacy adoption ${label} changed while it was opened`);
    }
    const bytes = await handle.readFile();
    const rebound = await handle.stat();
    if (
      rebound.dev !== opened.dev ||
      rebound.ino !== opened.ino ||
      rebound.size !== opened.size ||
      rebound.mtimeMs !== opened.mtimeMs ||
      bytes.length !== opened.size
    ) {
      throw new Error(`legacy adoption ${label} changed while it was read`);
    }
    let value;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      throw new Error(`legacy adoption ${label} is not valid JSON`, { cause: error });
    }
    return Object.freeze({
      bytes,
      value,
      identity: validateLegacyAdoptionSourceIdentity(
        {
          dev: opened.dev,
          gid: opened.gid,
          ino: opened.ino,
          mode: opened.mode & 0o777,
          sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
          size: opened.size,
          uid: opened.uid,
        },
        label,
      ),
    });
  } finally {
    await handle.close();
  }
}

function validateLegacyAdoptionSourceReceipt(value, binding) {
  exactObjectKeys(
    value,
    [
      "adoptedAt",
      "controllerHintSha256",
      "currentRuntimeSha256",
      "gateway",
      "journalRemovalIntent",
      "legacyJournalSha256",
      "outcome",
      "previousManifestSha256",
      "previousRootSha256",
      "previousVersion",
      "profile",
      "receiptDigest",
      "rootVerificationPending",
      "schemaVersion",
      "service",
      "stateEvidenceDigest",
      "targetVersion",
      "transactionId",
    ],
    "legacy managed-update adoption receipt",
  );
  const unsigned = { ...value };
  delete unsigned.receiptDigest;
  if (
    value.schemaVersion !== 1 ||
    value.profile !== "protected-local" ||
    value.outcome !== "rolled-back" ||
    value.journalRemovalIntent !== "remove-after-durable-receipt" ||
    value.rootVerificationPending !== true ||
    String(value.transactionId ?? "").toLowerCase() !== binding.transactionId ||
    value.receiptDigest !== binding.receiptDigest ||
    value.previousVersion !== binding.previousVersion ||
    value.targetVersion !== binding.targetVersion ||
    value.receiptDigest !==
      `sha256:${createHash("sha256").update(canonicalJSON(unsigned)).digest("hex")}` ||
    !/^sha256:[a-f0-9]{64}$/u.test(value.legacyJournalSha256 || "")
  ) {
    throw new Error("legacy managed-update adoption receipt changed before completion");
  }
  return Object.freeze({ ...value });
}

async function legacyAdoptionSourceState(context, binding, stateDir, { optional = false } = {}) {
  const expectedOwnerUid = context.applicationState?.operatorUid;
  if (!Number.isSafeInteger(expectedOwnerUid) || expectedOwnerUid < 1) {
    throw new Error("legacy adoption completion has no exact application owner");
  }
  const receiptPath = path.join(stateDir, LEGACY_ADOPTION_RECEIPT_NAME);
  const journalPath = path.join(stateDir, "hosted-update-transaction.json");
  const [receiptFile, journalFile] = await Promise.all([
    readBoundedLegacyAdoptionSource(receiptPath, "receipt", expectedOwnerUid, {
      optional,
      maxBytes: 256 * 1024,
    }),
    readBoundedLegacyAdoptionSource(journalPath, "journal", expectedOwnerUid, { optional }),
  ]);
  if (!receiptFile || !journalFile) {
    return Object.freeze({ receiptPath, journalPath, receiptFile, journalFile });
  }
  const receipt = validateLegacyAdoptionSourceReceipt(receiptFile.value, binding);
  if (
    Number(journalFile.value?.schemaVersion) !== 1 ||
    String(journalFile.value?.transactionId ?? "").toLowerCase() !== binding.transactionId ||
    journalFile.value?.previousVersion !== binding.previousVersion ||
    journalFile.value?.targetVersion !== binding.targetVersion ||
    !new Set(["rolling-back", "restored"]).has(String(journalFile.value?.phase ?? "")) ||
    receipt.legacyJournalSha256 !== journalFile.identity.sha256
  ) {
    throw new Error("legacy adoption source journal changed before completion");
  }
  return Object.freeze({ receiptPath, journalPath, receiptFile, journalFile });
}

function legacyAdoptionIdentityEqual(left, right) {
  return canonicalJSON(left) === canonicalJSON(right);
}

async function writeLegacyAdoptionAck(context, binding, request, value) {
  const parsed = parseLegacyAdoptionAck(value, binding, request);
  const ackPath = legacyAdoptionAckPath(context, binding, request.transactionId);
  await atomicWriteFileDurable(ackPath, `${JSON.stringify(parsed, null, 2)}\n`, 0o600);
  return parsed;
}

async function prepareLegacyAdoptionCompletion(context, journal) {
  const binding = journal.legacyAdoption;
  if (!binding) {
    return null;
  }
  const request = { transactionId: journal.transactionId, version: journal.version };
  const existing = await readLegacyAdoptionAck(context, binding, request);
  if (existing) {
    return existing;
  }
  const stateDir = journal.managedApplication?.stateDir;
  if (!stateDir) {
    throw new Error("legacy adoption completion has no managed application state root");
  }
  const sources = await legacyAdoptionSourceState(context, binding, stateDir);
  const unsigned = Object.freeze({
    schemaVersion: 2,
    transactionId: journal.transactionId,
    version: journal.version,
    legacyTransactionId: binding.transactionId,
    adoptionReceiptDigest: binding.receiptDigest,
    adoptionReceipt: sources.receiptFile.identity,
    legacyJournal: sources.journalFile.identity,
    outcome: "committed",
    installedVersion: journal.version,
    state: "pending",
    issuedAt: new Date().toISOString(),
    acknowledgedAt: null,
  });
  const completion = await writeLegacyAdoptionAck(context, binding, request, {
    ...unsigned,
    receiptDigest: `sha256:${createHash("sha256").update(canonicalJSON(unsigned)).digest("hex")}`,
  });
  await context.onLegacyAdoptionPhase?.("after-completion-durable", {
    binding,
    completion,
    stateDir,
  });
  return completion;
}

async function acknowledgeLegacyAdoption(request, context) {
  const binding = request.legacyAdoption;
  if (!binding) {
    throw new Error("legacy adoption acknowledgment has no root-authorized binding");
  }
  const committed = await alreadyCommittedRelease(request, context);
  if (!committed?.legacyAdoptionAck) {
    throw new Error("legacy adoption completion receipt is unavailable after target commit");
  }
  let ack = committed.legacyAdoptionAck;
  const stateDir = context.applicationState?.stateDir;
  if (!stateDir) {
    throw new Error("legacy adoption acknowledgment has no managed application state root");
  }
  const sources = await legacyAdoptionSourceState(context, binding, stateDir, { optional: true });
  const receiptPresent = sources.receiptFile !== null;
  const journalPresent = sources.journalFile !== null;
  if (
    (receiptPresent &&
      !legacyAdoptionIdentityEqual(sources.receiptFile.identity, ack.adoptionReceipt)) ||
    (journalPresent &&
      !legacyAdoptionIdentityEqual(sources.journalFile.identity, ack.legacyJournal))
  ) {
    throw new Error("legacy adoption source files were replaced after durable completion");
  }
  if (journalPresent) {
    await fsp.rm(sources.journalPath);
    await fsyncDirectory(stateDir);
    await context.onLegacyAdoptionPhase?.("after-journal-removal", {
      binding,
      completion: ack,
      stateDir,
    });
  }
  if (receiptPresent) {
    await fsp.rm(sources.receiptPath);
    await fsyncDirectory(stateDir);
    await context.onLegacyAdoptionPhase?.("after-receipt-removal", {
      binding,
      completion: ack,
      stateDir,
    });
  }
  if (ack.state !== "acknowledged") {
    const unsigned = {
      ...ack,
      state: "acknowledged",
      acknowledgedAt: new Date().toISOString(),
    };
    delete unsigned.receiptDigest;
    Object.freeze(unsigned);
    ack = await writeLegacyAdoptionAck(context, binding, request, {
      ...unsigned,
      receiptDigest: `sha256:${createHash("sha256").update(canonicalJSON(unsigned)).digest("hex")}`,
    });
    await context.onLegacyAdoptionPhase?.("after-acknowledgment-durable", {
      binding,
      completion: ack,
      stateDir,
    });
  }
  return {
    ...committed,
    legacyAdoption: binding,
    legacyAdoptionAck: ack,
  };
}

async function finishCommit(context, journal, options = {}) {
  if (journal.migrationSelection) {
    assertLifecycleSchemaMigrationsApplied(journal);
  }
  await context.installCommittedLaunchers(journal);
  await recordTargetApplicationSuccess(context, journal);
  if (options.skipHistoricalResidueCleanup !== true) {
    await cleanupHistoricalQ0Residue(context, journal);
  }
  await writeInitialRollbackFloor(context, journal.version);
  const legacyAdoptionAck = await prepareLegacyAdoptionCompletion(context, journal);
  await removeUpdateGates(context);
  await cleanupTransactionFiles(context, journal.transactionId);
  await removeJournal(context);
  await removeManagedUpdateLock(journal);
  return {
    transactionId: journal.transactionId,
    version: journal.version,
    phase: "committed",
    changed: journal.changed,
    release: journal.release,
    migration: lifecycleMigrationReceipt(journal.migrationSelection),
    schemaMigration: lifecycleSchemaMigrationReceipt(
      journal.schemaMigration,
      journal.migrationSelection,
    ),
    legacyAdoption: journal.legacyAdoption ?? null,
    legacyAdoptionAck,
  };
}

async function commitSignerRelease(request, context) {
  let journal = await readJournal(context);
  if (!journal) {
    const committed = await alreadyCommittedRelease(request, context);
    if (committed) {
      return committed;
    }
    const installed = await readVersionFile(context.paths.versionPath);
    const floor = await readRollbackFloor(context);
    if (installed === request.version && floor && compareVersions(request.version, floor) >= 0) {
      return {
        transactionId: request.transactionId,
        version: request.version,
        phase: "committed",
        changed: false,
      };
    }
    throw new Error("host updater transaction does not exist");
  }
  assertMatchingTransaction(journal, request);
  if (
    journal.phase !== "gateway-authorized" &&
    journal.phase !== "gateway-verified" &&
    journal.phase !== "committing"
  ) {
    throw new Error(`signer transaction cannot commit from phase ${journal.phase}`);
  }
  if (journal.phase === "gateway-authorized") {
    const healthReceipt = await verifyCrossProductHealth(context, journal);
    journal = await writeJournal(context, {
      ...journal,
      phase: "gateway-verified",
      healthReceipt,
    });
  }
  if (journal.phase !== "committing") {
    journal = await writeJournal(context, { ...journal, phase: "committing" });
  }
  return await finishCommit(context, journal);
}

async function alreadyCommittedRelease(request, context) {
  const installed = await readVersionFile(context.paths.versionPath);
  const floor = await readRollbackFloor(context);
  if (installed !== request.version || !floor || compareVersions(request.version, floor) < 0) {
    return null;
  }
  const topology = await context.discoverApplicationTopology();
  context.applicationTopology = topology;
  context.applicationState = managedApplicationStateFromTopology(topology);
  const migrationSelection =
    topology.pendingGatewayUnit || topology.pendingStateDir
      ? null
      : selectLifecycleMigration(topology, request.schemaVersion ?? PROTOCOL_SCHEMA_VERSION);
  let managedManifest = null;
  if (context.applicationState?.stateDir) {
    const paths = managedApplicationPaths(context.applicationState.stateDir);
    managedManifest = validateManagedInstallManifest(
      JSON.parse(await fsp.readFile(paths.manifestPath, "utf8")),
      context.applicationState,
      paths,
    );
    if (managedManifest.runtime.activeVersion !== request.version) {
      return null;
    }
  }
  const applicationTarget =
    context.paths.applicationCurrentLink && fs.existsSync(context.paths.applicationCurrentLink)
      ? await fsp.realpath(context.paths.applicationCurrentLink)
      : null;
  if (!applicationTarget || !managedManifest?.release || !managedManifest?.updater?.bundleDigest) {
    return null;
  }
  const expectedGatewayGeneration = gatewayGenerationExpectation({
    version: request.version,
    targetRoot: applicationTarget,
    releaseBinding: {
      releaseCommit: managedManifest.release.commit,
      manifestDigest: managedManifest.release.manifestDigest,
    },
    managedManifest,
    updaterBundleDigest: managedManifest.updater.bundleDigest,
  });
  const [gateway, signer, product] = await Promise.all([
    context.verifyGateway(request.version, expectedGatewayGeneration),
    context.probeSigner(),
    applicationTarget && !topology?.pendingGatewayUnit && !topology?.pendingStateDir
      ? context.probeApplicationHealth(topology, {
          version: request.version,
          application: { targetRoot: applicationTarget },
        })
      : null,
  ]);
  void gateway;
  void product;
  const release = parseSignerReleaseIdentity(signer, request.version);
  const schemaMigration = migrationSelection
    ? completedLifecycleSchemaMigration(
        stagedLifecycleSchemaMigration(
          lifecycleSchemaMigrationPlan(migrationSelection),
          migrationSelection,
        ),
        migrationSelection,
      )
    : null;
  const legacyAdoptionAck = request.legacyAdoption
    ? await readLegacyAdoptionAck(context, request.legacyAdoption, request)
    : null;
  if (request.legacyAdoption && !legacyAdoptionAck) {
    throw new Error("committed target is missing its durable legacy adoption completion receipt");
  }
  return {
    transactionId: request.transactionId,
    version: request.version,
    phase: "committed",
    changed: false,
    release,
    migration: lifecycleMigrationReceipt(migrationSelection),
    schemaMigration: lifecycleSchemaMigrationReceipt(schemaMigration, migrationSelection),
    legacyAdoption: request.legacyAdoption ?? null,
    legacyAdoptionAck,
  };
}

async function releaseStatus(request, context) {
  await assertSupervisorSelectedController(request, context, { allowProcessRestart: true });
  const journal = await readJournal(context);
  if (journal) {
    assertMatchingTransaction(journal, request);
    return {
      transactionId: request.transactionId,
      version: request.version,
      phase: journal.phase,
      changed: journal.changed,
      durableCommitDecision: new Set(["gateway-verified", "committing"]).has(journal.phase),
    };
  }
  const committed = await alreadyCommittedRelease(request, context);
  if (committed) {
    return { ...committed, healthy: true };
  }
  const installedVersion = await readVersionFile(context.paths.versionPath);
  if (installedVersion) {
    const previousRequest = { ...request, version: installedVersion };
    delete previousRequest.legacyAdoption;
    const previous = await alreadyCommittedRelease(previousRequest, context);
    if (!previous) {
      throw new Error("restored product generation did not pass cross-product health");
    }
  }
  return {
    transactionId: request.transactionId,
    version: request.version,
    phase: "rolled-back",
    changed: false,
    installedVersion,
    healthy: true,
  };
}

async function applyReleaseTransaction(request, context) {
  await assertSupervisorSelectedController(request, context);
  let journal = await readJournal(context);
  if (!journal) {
    const committed = await alreadyCommittedRelease(request, context);
    if (committed) {
      return committed;
    }
  } else {
    // A request that does not own the durable transaction must never enter
    // this request's rollback path. The owning request or cold-start recovery
    // remains solely responsible for completing or restoring it.
    assertMatchingTransaction(journal, request);
  }
  let durableCommitDecision =
    journal?.phase === "gateway-verified" || journal?.phase === "committing";
  try {
    if (!journal) {
      await prepareSignerRelease(request, context);
      journal = await readJournal(context);
    }
    if (journal.phase === "prepared") {
      await gateGatewayRelease(request, context);
      journal = await readJournal(context);
    }
    if (journal.phase === "state-reconciled" || journal.phase === "schema-ready") {
      await activateSignerRelease(request, context);
      journal = await readJournal(context);
    }
    if (journal.phase === "active") {
      await authorizeGatewayRelease(request, context);
      journal = await readJournal(context);
    }
    if (journal.phase === "gateway-authorized") {
      if (!lifecycleSchemaMigrationsApplied(journal)) {
        await authorizeGatewayRelease(request, context);
        journal = await readJournal(context);
      }
      assertLifecycleSchemaMigrationsApplied(journal);
      const healthReceipt = await verifyCrossProductHealth(context, journal);
      journal = await writeJournal(context, {
        ...journal,
        phase: "gateway-verified",
        healthReceipt,
      });
      durableCommitDecision = true;
    }
    if (journal.phase === "gateway-verified" || journal.phase === "committing") {
      return await commitSignerRelease(request, context);
    }
    throw new Error(`target lifecycle transaction cannot continue from phase ${journal.phase}`);
  } catch (error) {
    if (error?.code === "FASED_TEST_CRASH") {
      throw error;
    }
    const active = await readJournal(context).catch(() => null);
    durableCommitDecision =
      durableCommitDecision ||
      active?.phase === "gateway-verified" ||
      active?.phase === "committing";
    if (durableCommitDecision) {
      const pending = new Error(
        `target release passed health verification but commit recovery is pending: ${error.message}`,
        { cause: error },
      );
      pending.code = "TARGET_COMMIT_PENDING";
      throw pending;
    }
    try {
      await rollbackSignerRelease(request, context);
    } catch (rollbackError) {
      const incomplete = new Error(
        `target release failed and rollback is incomplete: ${error.message}; rollback error: ${rollbackError.message}`,
        { cause: error },
      );
      incomplete.code = "TARGET_ROLLBACK_INCOMPLETE";
      throw incomplete;
    }
    const rolledBack = new Error(`target release failed and was rolled back: ${error.message}`, {
      cause: error,
    });
    rolledBack.code = "TARGET_RELEASE_ROLLED_BACK";
    throw rolledBack;
  }
}

async function recoverInterruptedTransaction(context, options = {}) {
  let journal = await readJournal(context);
  if (!journal) {
    return { recovered: false };
  }
  const request = {
    transactionId: journal.transactionId,
    version: journal.version,
    supervisorReceipt: journal.supervisorReceipt,
  };
  if (context.supervised && journal.supervisorReceipt && !options.authorizedRecovery) {
    await assertSupervisorSelectedController(request, context, { allowProcessRestart: true });
  }
  if (journal.phase === "gateway-verified" || journal.phase === "committing") {
    if (journal.healthReceipt?.schemaVersion !== 2) {
      const healthReceipt = await verifyCrossProductHealth(context, journal);
      journal = await writeJournal(context, {
        ...journal,
        phase: "gateway-verified",
        healthReceipt,
      });
    }
    const result = await finishCommit(context, journal, {
      skipHistoricalResidueCleanup: Boolean(options.authorizedRecovery),
    });
    return { recovered: true, action: "committed", result };
  }
  if (
    journal.phase === "prepared" ||
    journal.phase === "state-reconciling" ||
    journal.phase === "state-reconciled" ||
    journal.phase === "schema-ready" ||
    journal.phase === "snapshotting" ||
    journal.phase === "activating" ||
    journal.phase === "active" ||
    journal.phase === "gateway-authorized" ||
    journal.phase === "rolling-back" ||
    journal.phase === "restored"
  ) {
    const result = await rollbackSignerRelease(request, context);
    return { recovered: true, action: "rolled-back", result };
  }
  throw new Error(`host updater cannot recover transaction phase ${journal.phase}`);
}

function controllerRecoveryState(journal, journalDigest = null, error = null) {
  if (!journal && !error) {
    return Object.freeze({ state: "READY" });
  }
  if (error) {
    return Object.freeze({
      state: "INVALID_LEDGER",
      lastErrorClass: "INVALID_LEDGER",
    });
  }
  return Object.freeze({
    state: "RECOVERY_PENDING",
    transactionId: journal?.transactionId ?? null,
    targetVersion: journal?.version ?? null,
    journalSchemaVersion: journal?.schemaVersion ?? null,
    legacySelectionDigest: journal?.supervisorReceipt?.selectionDigest ?? null,
    phase: journal?.phase ?? null,
    durableCommitDecision: new Set(["gateway-verified", "committing"]).has(journal?.phase),
    journalDigest,
    lastErrorClass: null,
  });
}

async function inspectControllerRecovery(context) {
  try {
    const bytes = await fsp.readFile(context.paths.journalPath, "utf8");
    const raw = JSON.parse(bytes);
    const journal = await validateJournal(raw, context);
    return controllerRecoveryState(
      journal,
      createHash("sha256").update(canonicalJSON(raw)).digest("hex"),
    );
  } catch (error) {
    if (error?.code === "ENOENT") {
      return controllerRecoveryState(null);
    }
    return controllerRecoveryState(null, null, error);
  }
}

async function handleExplicitControllerRecovery(request, context, state) {
  const pending = state.recovery;
  const authorization = request.recoveryAuthorization;
  if (pending.state !== "RECOVERY_PENDING") {
    return {
      transactionId: request.transactionId,
      version: request.version,
      phase: "ready",
      changed: false,
      replayed: true,
      recovery: pending,
    };
  }
  if (
    pending.transactionId === null ||
    pending.targetVersion === null ||
    pending.journalDigest === null ||
    request.transactionId !== pending.transactionId ||
    request.version !== pending.targetVersion ||
    request.recoveryDigest !== pending.journalDigest ||
    authorization.transactionId !== pending.transactionId ||
    authorization.version !== pending.targetVersion ||
    authorization.productJournalDigest !== pending.journalDigest ||
    authorization.legacySelectionDigest !== pending.legacySelectionDigest ||
    authorization.expectedOutcome !== (pending.durableCommitDecision ? "committed" : "rolled-back")
  ) {
    throw new Error("active controller recovery request does not match the protected journal");
  }
  const recoveryController = authorization.recoveryController;
  if (
    request.recoveryControllerInstanceId !== context.controllerInstanceId ||
    recoveryController.version !== context.runningControllerVersion ||
    recoveryController.serverSha256 !== context.runningControllerIdentity?.serverSha256 ||
    recoveryController.clientSha256 !== context.runningControllerIdentity?.clientSha256 ||
    !recoveryController.recoveryCapabilities.journalSchemas.includes(pending.journalSchemaVersion)
  ) {
    throw new Error("active recovery controller process identity is mismatched");
  }
  try {
    const result = await context.recoverInterruptedTransaction({
      authorizedRecovery: authorization,
    });
    if (result.action !== authorization.expectedOutcome) {
      throw new Error("controller recovery outcome does not match its bounded authorization");
    }
    state.recovery = await inspectControllerRecovery(context);
    return {
      transactionId: request.transactionId,
      version: request.version,
      phase: result.action === "committed" ? "committed" : "rolled-back",
      changed: result.recovered === true,
      recoveryControllerInstanceId: context.controllerInstanceId,
      recoveryAuthorizationDigest: authorization.authorizationDigest,
      recovery: state.recovery,
    };
  } catch (error) {
    state.recovery = await inspectControllerRecovery(context);
    throw error;
  }
}

async function dispatchUpdateRequest(request, context, state = { recovery: { state: "READY" } }) {
  state.recovery ??= Object.freeze({ state: "READY" });
  if (request.op === "recoveryStatus") {
    return {
      transactionId: request.transactionId,
      version: request.version,
      phase: state.recovery.state === "READY" ? "ready" : "recovery-pending",
      changed: false,
      recovery: state.recovery,
    };
  }
  if (state.recovery.state === "INITIALIZING") {
    throw new Error("controller recovery authority is still initializing");
  }
  if (state.recovery.state === "INVALID_LEDGER") {
    throw new Error("controller recovery ledger is invalid; only status is available");
  }
  if (state.recovery.state === "RECOVERY_PENDING") {
    if (request.op === "recoverActive") {
      return await handleExplicitControllerRecovery(request, context, state);
    }
    if (request.op !== "controllerStatus") {
      throw new Error("controller recovery is pending; new product mutation is blocked");
    }
  } else if (request.op === "recoverActive") {
    return await handleExplicitControllerRecovery(request, context, state);
  }
  if (
    context.supervised &&
    request.op !== "updateController" &&
    request.op !== "controllerStatus" &&
    request.op !== "releaseStatus"
  ) {
    await assertSupervisorSelectedController(request, context);
  }
  switch (request.op) {
    case "controllerStatus":
      if (
        !context.supervised ||
        !context.runningControllerIdentity ||
        context.runningControllerIdentity.version !== request.version
      ) {
        throw new Error("running target lifecycle controller identity is mismatched");
      }
      return {
        transactionId: request.transactionId,
        version: request.version,
        controllerVersion: context.runningControllerVersion,
        controllerInstanceId: context.controllerInstanceId,
        controllerServerSha256: context.runningControllerIdentity.serverSha256,
        controllerClientSha256: context.runningControllerIdentity.clientSha256,
        protocolCapabilities: CONTROLLER_SELECTION_CAPABILITIES,
        recoveryCapabilities: CONTROLLER_RECOVERY_CAPABILITIES,
      };
    case "releaseStatus":
      return await releaseStatus(request, context);
    case "acknowledgeLegacyAdoption":
      return await acknowledgeLegacyAdoption(request, context);
    case "updateController":
      if (context.supervised) {
        throw new Error("stable lifecycle supervisor owns controller promotion");
      }
      return await updateControllerRelease(request, context);
    case "applyRelease":
      return await applyReleaseTransaction(request, context);
    case "prepareRelease":
      return await prepareSignerRelease(request, context);
    case "activateRelease":
      return await activateSignerRelease(request, context);
    case "authorizeGatewayRelease":
      return await authorizeGatewayRelease(request, context);
    case "gateGatewayRelease":
      return await gateGatewayRelease(request, context);
    case "restartGateway":
      return await restartGatewayService(request, context);
    case "commitRelease":
      return await commitSignerRelease(request, context);
    case "rollbackRelease":
      return await rollbackSignerRelease(request, context);
    default:
      throw new Error("unsupported updater transaction request");
  }
}

function writeResponse(socket, payload, onFlushed) {
  socket.end(`${JSON.stringify(payload)}\n`, onFlushed);
}

function parseServerConfiguration(argv = process.argv.slice(2)) {
  let protectedLocalInstance = null;
  let socketUid = 0;
  let socketGid = Number.NaN;
  let supervised = false;
  let socketPath = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--supervised") {
      supervised = true;
      continue;
    }
    if (argument === "--socket-path") {
      socketPath = String(argv[++index] ?? "").trim();
      continue;
    }
    if (argument === "--socket-gid") {
      socketGid = Number(argv[++index]);
      continue;
    }
    if (argument === "--socket-uid") {
      socketUid = Number(argv[++index]);
      continue;
    }
    if (argument === "--protected-local-instance") {
      protectedLocalInstance = String(argv[++index] ?? "").trim();
      continue;
    }
    throw new Error(`unsupported root updater argument: ${argument}`);
  }
  if (!Number.isSafeInteger(socketGid) || socketGid < 0 || (!supervised && socketGid === 0)) {
    throw new Error("--socket-gid must be a valid numeric group id");
  }
  if (!Number.isSafeInteger(socketUid) || socketUid < 0) {
    throw new Error("--socket-uid must be a non-negative numeric user id");
  }
  if (!protectedLocalInstance && socketUid !== 0) {
    throw new Error("Hosting root controller socket must remain root-owned");
  }
  if (protectedLocalInstance && socketUid === 0 && !supervised) {
    throw new Error("Protected Local root updater socket requires its exact operator user id");
  }
  const selected = protectedLocalInstance
    ? protectedLocalControllerConfiguration(protectedLocalInstance)
    : {
        profile: "hosting",
        paths: DEFAULT_PATHS,
        signerServiceName: "fased-signerd.service",
        gatewayServiceName: "fased-gateway.service",
        signerApplicationSocketPath: "/run/fased-signerd/app.sock",
      };
  const expectedPrivateSocket = protectedLocalInstance
    ? `/run/fased-local-controller-worker/${protectedLocalInstance}/controller.sock`
    : "/run/fased-host-controller/controller.sock";
  if (supervised) {
    if (socketUid !== 0 || socketGid !== 0 || socketPath !== expectedPrivateSocket) {
      throw new Error("supervised controller requires its exact root-only private socket");
    }
  } else if (socketPath !== null) {
    throw new Error("custom controller socket paths require stable supervision");
  }
  return Object.freeze({
    ...selected,
    paths: Object.freeze({
      ...selected.paths,
      socketPath: supervised ? expectedPrivateSocket : selected.paths.socketPath,
    }),
    supervised,
    socketUid,
    socketGid,
  });
}

export async function startServer(options = {}) {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) {
    throw new Error("hosted signer updater must run as root");
  }
  const configuration = options.configuration ?? parseServerConfiguration();
  const context =
    options.context ??
    createTransactionContext({
      paths: configuration.paths,
      protectedLocalInstanceId: configuration.instanceId,
      signerServiceName: configuration.signerServiceName,
      gatewayServiceName: configuration.gatewayServiceName,
      signerApplicationSocketPath: configuration.signerApplicationSocketPath,
      supervised: configuration.supervised,
      controllerConfiguration: configuration,
    });
  return await startControllerControlPlane(configuration, context, options);
}

async function startControllerControlPlane(configuration, context, options = {}) {
  await fsp.mkdir(path.dirname(context.paths.socketPath), { recursive: true, mode: 0o750 });
  await fsp.rm(context.paths.socketPath, { force: true });
  process.umask(0o117);
  const state = {
    recovery: Object.freeze({ state: "INITIALIZING" }),
    initialized: false,
  };
  let queue = Promise.resolve();
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    socket.setTimeout(REQUEST_TIMEOUT_MS);
    let body = "";
    let handled = false;
    const fail = (message) => {
      if (!handled) {
        handled = true;
        writeResponse(socket, { ok: false, error: message });
      }
    };
    socket.on("timeout", () => fail("updater request timed out"));
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk) => {
      if (handled) {
        return;
      }
      body += chunk;
      if (body.length > MAX_REQUEST_BYTES) {
        fail("updater request is too large");
        return;
      }
      const newline = body.indexOf("\n");
      if (newline < 0) {
        return;
      }
      handled = true;
      let request;
      try {
        request = parseUpdateRequest(JSON.parse(body.slice(0, newline)));
      } catch (error) {
        writeResponse(socket, { ok: false, error: error.message });
        return;
      }
      const operation = queue
        .then(() => dispatchUpdateRequest(request, context, state))
        .catch(async (error) => {
          if (state.initialized) {
            state.recovery = await inspectControllerRecovery(context);
          }
          throw error;
        });
      queue = operation.catch(() => undefined);
      const restartController = () => {
        if (!context.controllerRestartRequired) {
          return;
        }
        context.controllerRestartRequired = false;
        server.close(() => {
          process.exitCode = 75;
        });
      };
      void operation.then(
        (result) =>
          writeResponse(
            socket,
            { ok: true, ...result },
            new Set(["updateController", "commitRelease", "rollbackRelease"]).has(request.op)
              ? restartController
              : undefined,
          ),
        (error) =>
          writeResponse(
            socket,
            {
              ok: false,
              transactionId: request.transactionId,
              version: request.version,
              error: error.message,
            },
            restartController,
          ),
      );
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(context.paths.socketPath, resolve);
  });
  await fsp.chown(context.paths.socketPath, configuration.socketUid, configuration.socketGid);
  await fsp.chmod(
    context.paths.socketPath,
    configuration.supervised || configuration.socketUid !== 0 ? 0o600 : 0o660,
  );
  let preparation;
  try {
    preparation = await prepareControllerServerContext(context);
    state.recovery = preparation.recovery ?? Object.freeze({ state: "READY" });
    state.initialized = true;
  } catch {
    state.recovery = Object.freeze({
      state: "INVALID_LEDGER",
      lastErrorClass: "INITIALIZATION_FAILED",
    });
  }
  const close = async () => {
    await new Promise((resolve) => server.close(resolve));
    await fsp.rm(context.paths.socketPath, { force: true });
  };
  if (options.installSignalHandlers !== false) {
    process.once("SIGTERM", () => void close().then(() => process.exit(0)));
    process.once("SIGINT", () => void close().then(() => process.exit(0)));
  }
  if (preparation?.restartRequired) {
    await close();
    return {
      server: null,
      close: async () => undefined,
      state,
      restartRequired: true,
    };
  }
  return { server, close, state, restartRequired: false };
}

async function prepareControllerServerContext(context) {
  if (!context.supervised && (await context.ensureStableSupervisorBoundary?.())) {
    return { restartRequired: true };
  }
  if (!context.supervised && (await context.ensureControllerServicePolicy?.())) {
    return { restartRequired: true };
  }
  const topology = await context.discoverApplicationTopology();
  context.applicationTopology = topology;
  context.applicationState = managedApplicationStateFromTopology(topology);
  if (context.supervised) {
    return { restartRequired: false, recovery: await inspectControllerRecovery(context) };
  }
  if (context.recoverInterruptedTransaction) {
    await context.recoverInterruptedTransaction();
  } else {
    await recoverInterruptedTransaction(context);
  }
  return { restartRequired: false, recovery: Object.freeze({ state: "READY" }) };
}

export function isMainModule(entryPath, modulePath = fileURLToPath(import.meta.url)) {
  if (!entryPath) {
    return false;
  }
  try {
    return fs.realpathSync(entryPath) === fs.realpathSync(modulePath);
  } catch {
    return false;
  }
}

const isMain = isMainModule(process.argv[1]);
if (isMain) {
  if (process.argv[2] === "--self-check") {
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: CONTROLLER_SELF_CHECK_SCHEMA_VERSION,
        protocolVersion: CONTROLLER_PROTOCOL_VERSION,
        role: "server",
      })}\n`,
    );
  } else {
    const result = await startServer();
    if (result.restartRequired) {
      process.exitCode = 75;
    }
  }
}

export const __testing = {
  LIFECYCLE_COMPATIBILITY_ADAPTERS,
  LIFECYCLE_SCHEMA_MIGRATIONS,
  assertSignerV2Health,
  acknowledgeLegacyAdoption,
  applyReleaseTransaction,
  activateSignerRelease,
  authorizeGatewayRelease,
  buildTargetManagedInstallManifest,
  commitSignerRelease,
  compareVersions,
  collectCrossProductApplicationHealthEvidence,
  cleanupHistoricalQ0Residue,
  createTransactionContext,
  dispatchUpdateRequest,
  gateGatewayRelease,
  hashDeclaredFile,
  parseBoundedJsonOutput,
  parseServerConfiguration,
  prepareControllerServerContext,
  prepareSignerRelease,
  readTargetPluginStatusCache,
  protectedLocalControllerConfiguration,
  ensureProtectedLocalControllerServicePolicy,
  ensureRootManagedSharedApplicationDirectories,
  ensureInitializedManagedStableDirectories,
  ensureManagedCompatibilityDirectories,
  declaredStateRegistry,
  validateCrossProductApplicationEvidence,
  discoverProtectedApplicationTopology,
  inventoryDeclaredApplicationState,
  LIFECYCLE_ROOT_POLICY_SHA256,
  reconcileDeclaredApplicationState,
  ROOT_APPROVED_RELEASE_AUTHORITY,
  restoreDeclaredApplicationState,
  snapshotDeclaredApplicationState,
  verifyDeclaredStatePreservation,
  verifyCrossProductHealth,
  rootManagedApplicationIdentity,
  readJournal,
  releaseStatus,
  recoverInterruptedTransaction,
  releaseAttestationVerifyArgs,
  releaseAllowedForChannel,
  releaseArchitecture,
  restartGatewayService,
  rollbackSignerRelease,
  lifecycleMigrationInventory,
  lifecycleSchemaMigrationPlan,
  lifecycleSchemaMigrationReceipt,
  miningLedgerSemanticSnapshot,
  assertMiningLedgerSemanticPreserved,
  selectLifecycleMigration,
  validateLifecycleMigrationSelection,
  validateLifecycleSchemaMigration,
  stageOfficialControllerRelease,
  stageOfficialCandidate,
  stageProtectedApplicationRelease,
  systemIdentityExecArguments,
  targetMiningHealthArgs,
  transactionPaths,
  updateControllerRelease,
  writeJournal,
};
