import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __testing as controllerTesting, parseUpdateRequest } from "./fased-host-updater.mjs";
import { recoverPendingSupervisorTransaction } from "./fased-host-updaterctl.mjs";
import {
  __testing as supervisorTesting,
  parseSupervisorRequest,
} from "./fased-lifecycle-supervisor.mjs";
import {
  MANAGED_UPDATER_SUPPORT_FILES,
  __testing as managedUpdaterTesting,
} from "./fased-managed-updater-core.mjs";
import { capabilitiesDigest } from "./hosted-release-manifest.mjs";
import {
  buildManagedInstallManifest,
  readHostedReleaseBinding,
  readHostedRuntimeMetadata,
  resolveManagedRuntimePaths,
} from "./managed-runtime-layout.mjs";
import { writeManagedUpdaterReleaseDescriptor } from "./managed-updater-bundle.mjs";
import { __testing as bootstrapTesting } from "./protected-local-bootstrap.mjs";

const roots: string[] = [];
const targetVersion = "1.2.2";
const recoveryControllerVersion = "1.2.3";
const previousVersion = "1.2.1";
const predecessorVersion = "1.2.0";
const now = Date.parse("2026-08-02T12:00:00.000Z");
const publishedLegacyRef = "v0.1.76-rc.30";
const publishedLegacyServerSha256 =
  "ecad0b06bc1eb0612f052534e77760b8995ae144071f5973f7b1dab1b802ca6d"; // pragma: allowlist secret
const publishedLegacyClientSha256 =
  "9cee31906ba86800c2a5699d9895cbe73d5b74fea6c3f2b3c56f7732d6f34799"; // pragma: allowlist secret
const digest = (character: string) => character.repeat(64);
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const prefixedSha256 = (value: string) => `sha256:${sha256(value)}`;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error("fixture contains a non-canonical number");
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonical(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .toSorted((left, right) => left.localeCompare(right))
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("fixture contains a non-canonical value");
}

function expectExactKeys(value: unknown, expected: readonly string[]): void {
  expect(value).toBeTruthy();
  expect(typeof value).toBe("object");
  expect(Array.isArray(value)).toBe(false);
  expect(Object.keys(value as Record<string, unknown>).toSorted()).toEqual(
    [...expected].toSorted(),
  );
}

function recoveryDigest(
  rootTransaction: Record<string, unknown> | null,
  productJournal: Record<string, unknown> | null,
): string {
  return sha256(
    canonical({
      schemaVersion: 1,
      supervisorTransaction: null,
      rootProductTransaction: rootTransaction,
      controllerProductJournal: productJournal,
    }),
  );
}

function fixturePaths(root: string) {
  return {
    publicSocketPath: path.join(root, "run", "supervisor.sock"),
    privateSocketPath: path.join(root, "run", "controller.sock"),
    stateDir: path.join(root, "state"),
    supervisorStateDir: path.join(root, "state", "supervisor"),
    releasesDir: path.join(root, "controller", "releases"),
    currentLink: path.join(root, "controller", "current"),
    controllerVersionPath: path.join(root, "state", "controller-version.json"),
    rollbackFloorPath: path.join(root, "state", "rollback-floor"),
    trustedRootPath: path.join(root, "state", "supervisor", "trusted-root.json"),
    trustStatePath: path.join(root, "state", "supervisor", "trust-state.json"),
    supervisorTransactionPath: path.join(
      root,
      "state",
      "supervisor",
      "controller-transaction.json",
    ),
    rootTransactionPath: path.join(root, "state", "supervisor", "product-transaction.json"),
    productJournalPath: path.join(root, "state", "product-transaction.json"),
    productVersionPath: path.join(root, "state", "product-version"),
    channelPath: path.join(root, "channel"),
    supervisorPath: path.join(root, "supervisor.mjs"),
    controllerUnit: "fased-local-controller-fixture.service",
    supervisorUnit: "fased-local-supervisor-fixture.service",
  };
}

function supervisorRequest(
  op: "applyRelease" | "recoverActive" | "recoveryStatus" | "updateController",
  transactionId: string,
  version = targetVersion,
  options: {
    nonce?: string;
    recoveryDigest?: string;
    recoveryControllerVersion?: string;
  } = {},
) {
  return parseSupervisorRequest({
    schemaVersion: 3,
    op,
    transactionId,
    nonce: options.nonce ?? randomUUID(),
    version,
    clientCapabilities: { protocolVersion: 2, requestSchema: 3 },
    ...(op === "recoverActive" ? { recoveryDigest: options.recoveryDigest } : {}),
    ...(op === "recoverActive"
      ? {
          recoveryControllerVersion: options.recoveryControllerVersion ?? recoveryControllerVersion,
        }
      : {}),
  });
}

function pendingState(
  rootTransaction: Record<string, unknown>,
  productJournal: Record<string, unknown>,
) {
  const receipt = rootTransaction.targetControllerReceipt as Record<string, unknown>;
  return {
    controllerInstanceId: randomUUID(),
    recovery: Object.freeze({
      state: "RECOVERY_PENDING",
      source: "product",
      transactionId: rootTransaction.transactionId,
      targetVersion: rootTransaction.version,
      phase: productJournal.phase,
      durableCommitDecision: false,
      journalDigest: recoveryDigest(rootTransaction, productJournal),
      recoveryAttempts: rootTransaction.recoveryAttempts,
      lastErrorClass: rootTransaction.lastErrorClass,
      controller: Object.freeze({
        version: receipt.version,
        serverSha256: receipt.controllerServerSha256,
        clientSha256: receipt.controllerClientSha256,
        processInstanceId: receipt.controllerInstanceId,
        selectionDigest: receipt.selectionDigest,
        protocolCapabilities: receipt.protocolCapabilities,
      }),
    }),
  };
}

async function writeControllerGeneration(
  releasesDir: string,
  version: string,
  server: string,
  client: string,
) {
  const generation = path.join(releasesDir, `v${version}`);
  await fs.mkdir(generation, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(generation, "fased-host-updater.mjs"), server, { mode: 0o600 }),
    fs.writeFile(path.join(generation, "fased-host-updaterctl.mjs"), client, { mode: 0o600 }),
  ]);
  return {
    generation,
    identity: {
      schemaVersion: 1,
      version,
      serverSha256: sha256(server),
      clientSha256: sha256(client),
    },
  };
}

async function writeJson(filePath: string, value: unknown, mode = 0o600): Promise<string> {
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, bytes, { mode });
  return bytes;
}

async function writeDurableJson(filePath: string, value: unknown): Promise<string> {
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const handle = await fs.open(filePath, "w", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.chmod(0o600);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const directory = await fs.open(path.dirname(filePath), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
  return bytes;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function sha256File(filePath: string): Promise<string> {
  return sha256(await fs.readFile(filePath, "utf8"));
}

async function snapshotFiles(paths: Record<string, string>): Promise<Record<string, string>> {
  return Object.fromEntries(
    await Promise.all(
      Object.entries(paths).map(async ([name, filePath]) => [name, await sha256File(filePath)]),
    ),
  );
}

async function writeVerifiedManagedRuntime(root: string, version: string, seed: string) {
  const commit = seed.repeat(40);
  const dependencyHash = seed.repeat(64);
  const applicationSha256 = seed === "b" ? digest("c") : digest("d");
  const dependencySha256 = seed === "b" ? digest("e") : digest("f");
  const capabilities = Object.freeze({
    protocol: Object.freeze({ current: 2, min: 2, max: 2 }),
    nativeFeeReservationLamports: 5_000_000,
    intentTypes: Object.freeze(["solana.nativeTransfer"]),
    operationStates: Object.freeze(["reserved"]),
    features: Object.freeze(["failClosedPolicies"]),
  });
  const artifact = Object.freeze({ asset: `fased-${version}.tar.gz`, sha256: applicationSha256 });
  const dependencies = Object.freeze({
    asset: `fased-${version}-dependencies.tar.gz`,
    sha256: dependencySha256,
    dependencyHash,
  });
  const signerRelease = Object.freeze({
    version,
    commit,
    buildInputDigest: `sha256:${seed.repeat(64)}`,
    development: false,
  });
  const platforms = Object.fromEntries(
    ["linux-amd64", "linux-arm64", "darwin-amd64", "darwin-arm64"].map((platform) => [
      platform,
      Object.freeze({ asset: `fased-signerd-${platform}`, sha256: seed.repeat(64) }),
    ]),
  );
  await Promise.all([
    fs.mkdir(path.join(root, "node_modules"), { recursive: true }),
    fs.mkdir(path.join(root, "dist", "control-ui"), { recursive: true }),
    fs.mkdir(path.join(root, "scripts"), { recursive: true }),
  ]);
  await Promise.all([
    writeJson(path.join(root, "package.json"), { name: "@fased/fased", version }, 0o644),
    writeJson(path.join(root, "dist", "build-info.json"), { version, commit }, 0o644),
    fs.writeFile(path.join(root, "fased.mjs"), "#!/usr/bin/env node\n", { mode: 0o755 }),
    writeJson(path.join(root, "dist", "control-ui", "version.json"), { version }, 0o644),
    writeJson(
      path.join(root, ".fased-hosted-runtime.json"),
      { schemaVersion: 2, version, commit, dependencyHash },
      0o644,
    ),
    writeJson(
      path.join(root, ".fased-hosted-release-v2.json"),
      {
        schemaVersion: 2,
        release: { version, tag: `v${version}`, commit },
        application: {
          linux: {
            x64: { artifact, dependencies },
            arm64: {
              artifact: { ...artifact, asset: `fased-${version}-arm64.tar.gz` },
              dependencies,
            },
          },
        },
        signer: {
          release: signerRelease,
          capabilities,
          capabilitiesDigest: capabilitiesDigest(capabilities),
          platforms,
        },
      },
      0o644,
    ),
  ]);
  for (const name of [
    "fased-managed-launcher.sh",
    "fased-managed-service.sh",
    "fased-managed-updater.mjs",
    ...MANAGED_UPDATER_SUPPORT_FILES,
    "managed-updater-bundle.mjs",
    "managed-updater-bundle.v1.json",
    "start-managed.sh",
  ]) {
    const source = path.join(import.meta.dirname, name);
    const destination = path.join(root, "scripts", name);
    const sourceInfo = await fs.stat(source);
    await fs.copyFile(source, destination);
    await fs.chmod(destination, sourceInfo.mode & 0o777);
  }
  const updaterDescriptor = await writeManagedUpdaterReleaseDescriptor({
    runtimeRoot: root,
    architecture: process.arch,
  });
  const metadata = await readHostedRuntimeMetadata(root);
  const release = await readHostedReleaseBinding(root, metadata, version);
  if (!metadata || !release) {
    throw new Error("fixture failed to build a verified managed release identity");
  }
  const identity = Object.freeze({ metadata, packageVersion: version, release });
  const identityDigest = prefixedSha256(canonical(identity));
  const expectedGatewayGeneration = Object.freeze({
    schemaVersion: 1,
    version: release.version,
    releaseCommit: release.commit,
    manifestDigest: release.manifestDigest,
    applicationDigest: release.appArtifactDigest,
    dependencyDigest: release.dependencyArtifactDigest,
    dependencyHash: release.dependencyHash,
    updaterBundleDigest: updaterDescriptor.bundleDigest,
    runtimeRootDigest: prefixedSha256(root),
  });
  return Object.freeze({
    commit,
    dependencyHash,
    expectedGatewayGeneration,
    identity,
    identityDigest,
    release,
    signerRelease,
  });
}

async function exactLegacyTopologyFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-local-legacy-adoption-t1-"));
  roots.push(root);
  const stateDir = path.join(root, "operator", ".fased");
  const managedPaths = resolveManagedRuntimePaths({ stateDir });
  const runtimeDir = managedPaths.runtimeDir;
  const releasesDir = managedPaths.releasesDir;
  const predecessorRoot = path.join(releasesDir, predecessorVersion);
  const installedRoot = path.join(releasesDir, previousVersion);
  const targetRoot = path.join(releasesDir, targetVersion);
  const currentLink = managedPaths.currentLink;
  const previousLink = managedPaths.previousLink;
  const installPath = managedPaths.manifestPath;
  const journalPath = path.join(stateDir, "hosted-update-transaction.json");
  const controllerHintPath = path.join(stateDir, "protected-local-controller-transaction.json");
  const adoptionReceiptPath = path.join(stateDir, "legacy-managed-update-adoption.v1.json");
  const updaterDir = managedPaths.updaterDir;
  const rootApplicationReleasesDir = path.join(root, "protected-application", "releases");
  const rootApplicationRoot = path.join(rootApplicationReleasesDir, `v${previousVersion}`);
  const rootTargetApplicationRoot = path.join(rootApplicationReleasesDir, `v${targetVersion}`);
  const rootApplicationCurrent = path.join(root, "protected-application", "current");
  const privateSupervisorDir = path.join(root, "protected-supervisor");
  const privateSupervisorPath = path.join(privateSupervisorDir, "fased-lifecycle-supervisor.mjs");
  const instanceId = "0123456789abcdef";
  const gatewayLauncher = `/opt/fased/local/${instanceId}/gateway-launch`;
  const fixtureGatewayLauncher = path.join(root, "protected-application", "gateway-launch");

  await Promise.all([
    fs.mkdir(predecessorRoot, { recursive: true }),
    fs.mkdir(updaterDir, { recursive: true }),
    fs.mkdir(privateSupervisorDir, { recursive: true, mode: 0o700 }),
    fs.mkdir(path.dirname(rootApplicationCurrent), { recursive: true }),
  ]);
  const [installedRuntime, targetRuntime, rootApplicationRuntime, rootTargetApplicationRuntime] =
    await Promise.all([
      writeVerifiedManagedRuntime(installedRoot, previousVersion, "b"),
      writeVerifiedManagedRuntime(targetRoot, targetVersion, "c"),
      writeVerifiedManagedRuntime(rootApplicationRoot, previousVersion, "b"),
      writeVerifiedManagedRuntime(rootTargetApplicationRoot, targetVersion, "c"),
    ]);
  await Promise.all([
    fs.writeFile(
      managedPaths.updaterPath,
      "#!/usr/bin/env node\n// intentionally incomplete legacy flat updater\n",
      { mode: 0o755 },
    ),
    fs.writeFile(privateSupervisorPath, "// private supervisor sentinel\n", { mode: 0o700 }),
    fs.writeFile(fixtureGatewayLauncher, "#!/bin/sh\nexit 0\n", { mode: 0o700 }),
  ]);
  await fs.chmod(privateSupervisorDir, 0o700);

  const installedManifest = Object.freeze({
    ...buildManagedInstallManifest({
      paths: managedPaths,
      profile: "protected-local",
      version: previousVersion,
      dependencyHash: installedRuntime.dependencyHash,
      hostedRelease: installedRuntime.release,
      previousVersion: predecessorVersion,
      service: {
        name: `fased-gateway-${instanceId}.service`,
        scope: "system",
        launcher: gatewayLauncher,
      },
      updateChannel: "beta",
    }),
    updatedAt: "2026-08-02T11:57:00.000Z",
  });
  const targetManifest = Object.freeze({
    ...buildManagedInstallManifest({
      paths: managedPaths,
      profile: "protected-local",
      version: targetVersion,
      dependencyHash: targetRuntime.dependencyHash,
      hostedRelease: targetRuntime.release,
      previousVersion,
      service: {
        name: `fased-gateway-${instanceId}.service`,
        scope: "system",
        launcher: gatewayLauncher,
      },
      updateChannel: "beta",
    }),
    updatedAt: "2026-08-02T11:58:00.000Z",
  });
  const installBytes = await writeJson(installPath, installedManifest);
  await Promise.all([
    fs.symlink(installedRoot, currentLink, "dir"),
    fs.symlink(predecessorRoot, previousLink, "dir"),
    fs.symlink(rootApplicationRoot, rootApplicationCurrent, "dir"),
  ]);

  const transactionId = randomUUID();
  const legacyJournal = Object.freeze({
    schemaVersion: 1,
    transactionId,
    targetVersion,
    previousVersion,
    targetRoot,
    previousRoot: installedRoot,
    nextManifest: targetManifest,
    previousManifest: installedManifest,
    phase: "rolling-back",
    signerRelease: targetRuntime.signerRelease,
    createdAt: "2026-08-02T11:58:00.000Z",
    updatedAt: "2026-08-02T11:58:30.000Z",
  });
  const legacyJournalBytes = await writeJson(journalPath, legacyJournal);
  const controllerHintTransactionId = randomUUID();
  const controllerHint = Object.freeze({
    schemaVersion: 1,
    transactionId: controllerHintTransactionId,
    version: recoveryControllerVersion,
  });
  const controllerHintBytes = await writeJson(controllerHintPath, controllerHint);

  const sentinels = Object.freeze({
    wallet: path.join(stateDir, "wallets", "registry.json"),
    signer: path.join(root, "protected-signer", "signer.db"),
    mining: path.join(stateDir, "extensions", "sat-mining", "history.sqlite"),
    network: path.join(stateDir, "identity", "device-auth.json"),
    plugin: path.join(stateDir, "plugins", "installed.json"),
    config: path.join(stateDir, "fased.json"),
  });
  await Promise.all([
    writeJson(sentinels.wallet, { wallets: [{ id: "agent", role: "mining" }] }),
    fs.mkdir(path.dirname(sentinels.signer), { recursive: true }),
    fs.mkdir(path.dirname(sentinels.mining), { recursive: true }),
    writeJson(sentinels.network, { identity: "device-fixture" }),
    writeJson(sentinels.plugin, { enabled: ["sat-mining"] }),
    writeJson(sentinels.config, { gateway: { bind: "loopback" } }),
  ]);
  await Promise.all([
    fs.writeFile(sentinels.signer, "signer-master-key-and-bbolt-sentinel\n", { mode: 0o600 }),
    fs.writeFile(sentinels.mining, "sqlite-mining-ledger-sentinel\n", { mode: 0o600 }),
  ]);

  const gateway = Object.freeze({
    generationDigest: prefixedSha256(canonical(rootApplicationRuntime.expectedGatewayGeneration)),
    pid: 42_424,
    runtimeSource: "managed-package",
    startedAt: "2026-08-02T11:59:00.000Z",
    version: previousVersion,
  });
  const service = Object.freeze({
    instanceId,
    launcher: gatewayLauncher,
    name: `fased-gateway-${instanceId}.service`,
    scope: "system",
  });

  return {
    root,
    stateDir,
    runtimeDir,
    releasesDir,
    managedPaths,
    predecessorRoot,
    installedRoot,
    targetRoot,
    currentLink,
    previousLink,
    installPath,
    journalPath,
    controllerHintPath,
    adoptionReceiptPath,
    updaterDir,
    rootApplicationReleasesDir,
    rootApplicationRoot,
    rootTargetApplicationRoot,
    rootApplicationCurrent,
    privateSupervisorDir,
    privateSupervisorPath,
    instanceId,
    gatewayLauncher,
    fixtureGatewayLauncher,
    installedManifest,
    targetManifest,
    installedRuntime,
    targetRuntime,
    rootApplicationRuntime,
    rootTargetApplicationRuntime,
    installBytes,
    transactionId,
    legacyJournal,
    legacyJournalBytes,
    controllerHint,
    controllerHintTransactionId,
    controllerHintBytes,
    sentinels,
    gateway,
    service,
  };
}

async function targetControllerContext(
  fixture: Awaited<ReturnType<typeof exactLegacyTopologyFixture>>,
) {
  const root = path.join(fixture.root, "target-controller");
  const stateDir = path.join(root, "state");
  const signerDir = path.join(root, "signer");
  const signerPath = path.join(signerDir, "fased-signerd");
  const signerStateDBPath = path.join(signerDir, "state.db");
  const signerMasterKeyPath = path.join(signerDir, "master.key");
  const signerAuditLogPath = path.join(signerDir, "audit.jsonl");
  const signerUnitPath = path.join(root, "systemd", "signer.service");
  const paths = {
    stateDir,
    controllerReleasesDir: path.join(root, "controller", "releases"),
    controllerCurrentLink: path.join(root, "controller", "current"),
    controllerVersionPath: path.join(stateDir, "controller-version.json"),
    supervisorStateDir: path.join(stateDir, "supervisor"),
    signerPath,
    signerStateDBPath,
    signerMasterKeyPath,
    signerAuditLogPath,
    signerUnitPath,
    versionPath: path.join(stateDir, "signer-version"),
    channelPath: path.join(root, "channel"),
    journalPath: path.join(stateDir, "active-signer-transaction.json"),
    rollbackFloorPath: path.join(stateDir, "rollback-floor"),
    gatewayGatePath: path.join(stateDir, "gateway-update-gate"),
    signerGatePath: path.join(root, "signer-update-gate", "active"),
    transactionsDir: path.join(stateDir, "transactions"),
    socketPath: path.join(root, "request.sock"),
    applicationReleasesDir: fixture.rootApplicationReleasesDir,
    applicationCurrentLink: fixture.rootApplicationCurrent,
  };
  await Promise.all([
    fs.mkdir(signerDir, { recursive: true }),
    fs.mkdir(path.dirname(signerUnitPath), { recursive: true }),
    fs.mkdir(path.dirname(paths.signerGatePath), { recursive: true, mode: 0o755 }),
    fs.mkdir(stateDir, { recursive: true }),
  ]);
  await Promise.all([
    fs.writeFile(signerPath, "previous-signer\n", { mode: 0o755 }),
    fs.writeFile(signerStateDBPath, "signer-state-db-sentinel\n", { mode: 0o600 }),
    fs.writeFile(signerMasterKeyPath, "signer-master-key-sentinel\n", { mode: 0o600 }),
    fs.writeFile(signerAuditLogPath, "signer-audit-sentinel\n", { mode: 0o600 }),
    fs.writeFile(signerUnitPath, "ExecStart=previous-signer\n", { mode: 0o644 }),
    fs.writeFile(paths.versionPath, `${previousVersion}\n`, { mode: 0o600 }),
    fs.writeFile(paths.channelPath, "beta\n", { mode: 0o600 }),
  ]);

  let activeSignerVersion = previousVersion;
  const topology = Object.freeze({
    schemaVersion: 1,
    profile: "protected-local",
    managedApplication: true,
    instanceId: fixture.instanceId,
    stateDir: fixture.stateDir,
    configPath: path.join(fixture.stateDir, "fased.json"),
    gatewayLauncherPath: fixture.gatewayLauncher,
    operator: Object.freeze({
      name: "fixture-operator",
      uid: process.getuid?.() ?? 1000,
      gid: process.getgid?.() ?? 1000,
      home: path.dirname(fixture.stateDir),
    }),
    gateway: Object.freeze({
      user: `fsgw-${fixture.instanceId}`,
      uid: process.getuid?.() ?? 1000,
      gid: process.getgid?.() ?? 1000,
      unitPath: path.join(root, "systemd", fixture.service.name),
    }),
    configGroup: Object.freeze({
      name: `fscf-${fixture.instanceId}`,
      gid: process.getgid?.() ?? 1000,
    }),
    services: Object.freeze({
      gateway: fixture.service.name,
      signer: `fased-signerd-${fixture.instanceId}.service`,
    }),
    capabilities: Object.freeze({
      lifecycleControllerProtocol: 2,
      signerProtocol: Object.freeze({ current: 2, min: 2, max: 2 }),
      declaredStateRegistry: 1,
    }),
    stateSchemas: Object.freeze({
      managedInstall: 2,
      walletRegistry: null,
      signer: 2,
      mining: 1,
      federation: 2,
    }),
  });
  const targetRelease = fixture.rootTargetApplicationRuntime.release;
  const targetApplicationRelease = Object.freeze({
    version: targetVersion,
    commit: targetRelease.commit,
    manifestDigest: targetRelease.manifestDigest,
    artifact: Object.freeze({
      asset: targetRelease.appArtifact,
      sha256: targetRelease.appArtifactDigest.slice("sha256:".length),
    }),
    dependencies: Object.freeze({
      asset: targetRelease.dependencyArtifact,
      sha256: targetRelease.dependencyArtifactDigest.slice("sha256:".length),
      dependencyHash: targetRelease.dependencyHash,
    }),
    signer: targetRelease.signer,
    capabilities: targetRelease.capabilities,
    capabilitiesDigest: targetRelease.capabilitiesDigest,
  });
  const context = controllerTesting.createTransactionContext({
    paths,
    protectedLocalInstanceId: fixture.instanceId,
    supervised: true,
    controllerInstanceId: randomUUID(),
    runningControllerVersion: targetVersion,
    runningControllerIdentity: {
      version: targetVersion,
      serverSha256: digest("7"),
      clientSha256: digest("8"),
    },
    readSupervisorSelectionReceipt: async (receipt: unknown) => receipt,
    assertReleaseAllowed: async () => undefined,
    stageCandidate: async (_version: string, candidatePath: string) => {
      await fs.writeFile(candidatePath, "target-signer\n", { mode: 0o755 });
      return Object.freeze({
        release: fixture.targetRuntime.signerRelease,
        binding: Object.freeze({
          manifestDigest: targetRelease.manifestDigest,
          signerArtifactDigest: `sha256:${digest("c")}`,
          capabilitiesDigest: targetRelease.capabilitiesDigest,
          releaseCommit: targetRelease.commit,
        }),
        application: Object.freeze({
          targetRoot: fixture.rootTargetApplicationRoot,
          previousRoot: fixture.rootApplicationRoot,
          changed: true,
        }),
        applicationRelease: targetApplicationRelease,
      });
    },
    stageUpdaterGeneration: async (managedPaths: { updaterDir: string }) => {
      const generations = path.join(managedPaths.updaterDir, "generations");
      const targetGenerationDir = path.join(generations, digest("7"));
      const previousGenerationDir = path.join(generations, digest("6"));
      await Promise.all([
        fs.mkdir(targetGenerationDir, { recursive: true }),
        fs.mkdir(previousGenerationDir, { recursive: true }),
      ]);
      return Object.freeze({
        bundleDigest: `sha256:${digest("7")}`,
        targetGenerationDir,
        previousGenerationDir,
      });
    },
    activateUpdaterGeneration: async () => ({ bundleDigest: `sha256:${digest("7")}` }),
    restoreUpdaterGeneration: async () => ({ restored: true }),
    installCommittedLaunchers: async () => undefined,
    discoverApplicationTopology: async () => topology,
    inventoryApplicationState: async () => null,
    snapshotApplicationState: async () => null,
    assertSnapshotDiskCapacity: async () => undefined,
    reconcileApplicationState: async () => ({ changed: false, reconciled: false }),
    restoreApplicationState: async () => ({ restored: true }),
    verifyApplicationState: async () => ({
      ok: true,
      preservationHash: null,
      preservationHashes: {},
    }),
    probeApplicationHealth: async () => ({
      wallet: { ok: true, evidenceDigest: `sha256:${digest("1")}` },
      mining: { ok: true, evidenceDigest: `sha256:${digest("2")}` },
      network: { ok: true, evidenceDigest: `sha256:${digest("3")}` },
      plugins: { ok: true, evidenceDigest: `sha256:${digest("4")}` },
      signerIsolation: { ok: true, evidenceDigest: `sha256:${digest("5")}` },
    }),
    stopSigner: async () => undefined,
    startSignerV2: async () => {
      activeSignerVersion = targetVersion;
      return Object.freeze({
        release: fixture.targetRuntime.signerRelease,
        invariant: "signer-state-preserved",
      });
    },
    startPreviousSigner: async () => {
      activeSignerVersion = previousVersion;
    },
    reloadUnits: async () => undefined,
    applyServiceBoundary: async () => undefined,
    restoreServiceBoundary: async () => undefined,
    startGateway: async () => undefined,
    stopGateway: async () => undefined,
    restartGateway: async () => undefined,
    verifyGateway: async (_version: string, generation: unknown) => ({
      pid: 42_425,
      startedAt: "2026-08-02T12:00:00.000Z",
      runtimeSource: "managed-package",
      generation,
    }),
    probeSigner: async () =>
      activeSignerVersion === targetVersion
        ? fixture.targetRuntime.signerRelease
        : fixture.installedRuntime.signerRelease,
    probeSignerState: async () => ({
      release:
        activeSignerVersion === targetVersion
          ? fixture.targetRuntime.signerRelease
          : fixture.installedRuntime.signerRelease,
      invariant: "signer-state-preserved",
    }),
    historicalQ0TestStateDir: path.join(root, "no-historical-q0-residue"),
  });
  return Object.freeze({ context, paths, topology });
}

describe("Local persisted-journal recovery control plane", () => {
  it("keeps invalid recovery state status-only and blocks mutation", async () => {
    const transactionId = randomUUID();
    const state = {
      controllerInstanceId: randomUUID(),
      recovery: Object.freeze({
        state: "INVALID_LEDGER",
        lastErrorClass: "INVALID_LEDGER",
      }),
    };
    const context = {} as Parameters<typeof supervisorTesting.handleSupervisorRequest>[1];

    await expect(
      supervisorTesting.handleSupervisorRequest(
        supervisorRequest("recoveryStatus", transactionId),
        context,
        state,
      ),
    ).resolves.toMatchObject({
      ok: true,
      recovery: { state: "INVALID_LEDGER", lastErrorClass: "INVALID_LEDGER" },
    });
    await expect(
      supervisorTesting.handleSupervisorRequest(
        supervisorRequest("applyRelease", transactionId),
        context,
        state,
      ),
    ).rejects.toThrow("only status is available");
  });

  it("adopts the exact schema1 rollback before the normal target-owned recovery transaction", async () => {
    // This is a frozen pre-change ledger literal. Do not construct it with the
    // current schema-3 writer: doing so would hide compatibility regressions by
    // carrying fields that never existed in persisted schema 2.
    const frozenSchema2TransactionId = "11111111-1111-4111-8111-111111111111";
    const frozenSchema2 = Object.freeze({
      schemaVersion: 2,
      protocolVersion: 2,
      requestNonce: "22222222-2222-4222-8222-222222222222",
      clientCapabilities: Object.freeze({ protocolVersion: 2, requestSchema: 3 }),
      rollbackPointers: Object.freeze({
        controllerGenerationVersion: null,
        productVersion: previousVersion,
      }),
      transactionId: frozenSchema2TransactionId,
      version: targetVersion,
      phase: "prepared",
      operation: "applyRelease",
      previousVersion,
      previousControllerIdentity: null,
      previousControllerGenerationVersion: null,
      targetControllerReceipt: null,
      targetReleaseIdentity: null,
      artifactDigests: null,
      targetJournalSha256: null,
      selectionDigest: null,
      durableCommitDecision: false,
      legacyAdopted: false,
      recoveryAttempts: 0,
      lastErrorClass: null,
      createdAt: "2026-08-02T11:50:00.000Z",
      updatedAt: "2026-08-02T11:50:01.000Z",
    });
    const parsedFrozenSchema2 = supervisorTesting.parseRootProductTransaction(frozenSchema2);
    const advancedFrozenSchema2 = supervisorTesting.advanceRootProductTransaction(
      parsedFrozenSchema2,
      {
        phase: "state-reconciling",
        now: Date.parse("2026-08-02T11:50:02.000Z"),
      },
    );
    expect(parsedFrozenSchema2).toMatchObject({
      schemaVersion: 2,
      transactionId: frozenSchema2TransactionId,
      legacyAdoptionDigest: null,
      legacyAdoptionTransactionId: null,
      legacyAdoptionPreviousVersion: null,
      legacyAdoptionTargetVersion: null,
      legacyAdoptionAckDigest: null,
    });
    expect(advancedFrozenSchema2).toMatchObject({
      schemaVersion: 3,
      transactionId: frozenSchema2TransactionId,
      phase: "state-reconciling",
      legacyAdoptionDigest: null,
      legacyAdoptionTransactionId: null,
      legacyAdoptionPreviousVersion: null,
      legacyAdoptionTargetVersion: null,
      legacyAdoptionAckDigest: null,
    });
    expect(() =>
      supervisorTesting.assertRootProductTransactionTransition(
        parsedFrozenSchema2,
        advancedFrozenSchema2,
      ),
    ).not.toThrow();

    const fixture = await exactLegacyTopologyFixture();
    const uid = process.getuid?.() ?? 0;
    const gid = process.getgid?.() ?? 0;
    const sentinelsBefore = await snapshotFiles(fixture.sentinels);
    const privateSupervisorBefore = await sha256File(fixture.privateSupervisorPath);
    const readRootApplicationIdentity = vi.fn(async () => {
      expect(await fs.realpath(fixture.rootApplicationCurrent)).toBe(fixture.rootApplicationRoot);
      return Object.freeze({
        version: previousVersion,
        identityDigest: fixture.rootApplicationRuntime.identityDigest,
        root: fixture.rootApplicationRoot,
        identity: fixture.rootApplicationRuntime.identity,
        expectedGatewayGeneration: fixture.rootApplicationRuntime.expectedGatewayGeneration,
      });
    });
    const probeGateway = vi.fn(
      async ({
        expectedGeneration,
        expectedVersion,
      }: {
        expectedGeneration: unknown;
        expectedVersion: string;
      }) => {
        expect(expectedVersion).toBe(previousVersion);
        expect(expectedGeneration).toEqual(
          fixture.rootApplicationRuntime.expectedGatewayGeneration,
        );
        expect(await fs.realpath(fixture.currentLink)).toBe(fixture.installedRoot);
        expect(await fs.realpath(fixture.rootApplicationCurrent)).toBe(fixture.rootApplicationRoot);
        return fixture.gateway;
      },
    );
    const adoptionOptions = (overrides: Record<string, unknown> = {}) => ({
      stateDir: fixture.stateDir,
      journalPath: fixture.journalPath,
      controllerHintPath: fixture.controllerHintPath,
      adoptionReceiptPath: fixture.adoptionReceiptPath,
      expectedOwnerUid: uid,
      readRootApplicationIdentity,
      probeGateway,
      now: () => now,
      ...overrides,
    });

    const receiptCrash = new Error("fixture crash after durable user adoption receipt");
    await expect(
      managedUpdaterTesting.adoptLegacyManagedUpdate(
        adoptionOptions({
          crashPoint: async (stage: string) => {
            expect(stage).toBe("after-receipt-durable");
            expect(await pathExists(fixture.adoptionReceiptPath)).toBe(true);
            expect(await fs.readFile(fixture.journalPath, "utf8")).toBe(fixture.legacyJournalBytes);
            throw receiptCrash;
          },
        }),
      ),
    ).rejects.toBe(receiptCrash);
    const durableUserReceiptBytes = await fs.readFile(fixture.adoptionReceiptPath, "utf8");
    const durableUserReceipt = managedUpdaterTesting.validateLegacyManagedUpdateAdoptionReceipt(
      JSON.parse(durableUserReceiptBytes),
    ) as Record<string, unknown>;
    const adapterResult = await managedUpdaterTesting.adoptLegacyManagedUpdate(adoptionOptions());
    expect(adapterResult).toMatchObject({
      status: "pending-root-import",
      replayed: true,
      receiptPath: fixture.adoptionReceiptPath,
    });
    expect(await fs.readFile(fixture.adoptionReceiptPath, "utf8")).toBe(durableUserReceiptBytes);
    expect(await fs.readFile(fixture.journalPath, "utf8")).toBe(fixture.legacyJournalBytes);
    expectExactKeys(durableUserReceipt, [
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
    ]);
    expect(durableUserReceipt).toMatchObject({
      schemaVersion: 1,
      profile: "protected-local",
      transactionId: fixture.transactionId,
      targetVersion,
      previousVersion,
      outcome: "rolled-back",
      currentRuntimeSha256: fixture.installedRuntime.identityDigest,
      previousRootSha256: fixture.installedRuntime.identityDigest,
      controllerHintSha256: prefixedSha256(fixture.controllerHintBytes),
      legacyJournalSha256: prefixedSha256(fixture.legacyJournalBytes),
      previousManifestSha256: prefixedSha256(canonical(fixture.installedManifest)),
      journalRemovalIntent: "remove-after-durable-receipt",
      rootVerificationPending: true,
      gateway: fixture.gateway,
      service: fixture.service,
    });
    expect(fixture.controllerHintTransactionId).not.toBe(fixture.transactionId);
    expect(durableUserReceipt).not.toHaveProperty("controllerVersion");
    const unsignedUserReceipt = { ...durableUserReceipt };
    delete unsignedUserReceipt.receiptDigest;
    expect(durableUserReceipt.receiptDigest).toBe(prefixedSha256(canonical(unsignedUserReceipt)));
    expect(durableUserReceipt.stateEvidenceDigest).toBe(
      prefixedSha256(
        canonical({
          controllerHintSha256: prefixedSha256(fixture.controllerHintBytes),
          currentRuntimeSha256: fixture.installedRuntime.identityDigest,
          gateway: fixture.gateway,
          legacyJournalSha256: prefixedSha256(fixture.legacyJournalBytes),
          previousManifestSha256: prefixedSha256(canonical(fixture.installedManifest)),
          previousRootSha256: fixture.installedRuntime.identityDigest,
          rootApplicationSha256: fixture.installedRuntime.identityDigest,
          service: fixture.service,
        }),
      ),
    );
    await expect(
      fs.access(path.join(fixture.updaterDir, "fased-managed-updater-core.mjs")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.realpath(fixture.currentLink)).toBe(fixture.installedRoot);
    expect(JSON.parse(await fs.readFile(fixture.installPath, "utf8"))).toEqual(
      fixture.installedManifest,
    );

    const sourceRoot = path.dirname(import.meta.dirname);
    const rootBindingPath = path.join(
      fixture.root,
      "root-supervisor-state",
      "legacy-managed-update-adoption.v1.json",
    );
    const spec = Object.freeze({
      profile: "protected-local",
      stateDir: fixture.stateDir,
      gatewayPort: 18789,
      operatorUid: uid,
      operatorGid: gid,
      operatorUser: "fixture-operator",
    });
    const layout = Object.freeze({
      instanceId: fixture.instanceId,
      supervisorStateDir: path.dirname(rootBindingPath),
      gatewayUnit: fixture.service.name,
      installDir: `/opt/fased/local/${fixture.instanceId}`,
      applicationCurrentLink: fixture.rootApplicationCurrent,
      applicationReleasesDir: fixture.rootApplicationReleasesDir,
    });
    const registryEntry = Object.freeze({
      profile: "protected-local",
      stateDir: fixture.stateDir,
      instanceId: fixture.instanceId,
      operatorUid: uid,
      operatorUser: spec.operatorUser,
    });
    const probeRootGateway = vi.fn(
      async (expected: { generation: unknown; identityDigest: string; version: string }) => {
        expect(expected.version).toBe(previousVersion);
        expect(expected.identityDigest).toBe(fixture.rootApplicationRuntime.identityDigest);
        expect(expected.generation).toEqual(
          fixture.rootApplicationRuntime.expectedGatewayGeneration,
        );
        return fixture.gateway;
      },
    );
    const verifyServiceBoundary = vi.fn(async (service: unknown) => {
      expect(service).toEqual(fixture.service);
    });
    const importOptions = (overrides: Record<string, unknown> = {}) => ({
      runAdapter: async () => adapterResult,
      bindingPath: rootBindingPath,
      expectedRootUid: uid,
      now: () => now + 1_000,
      probeGateway: probeRootGateway,
      verifyServiceBoundary,
      ...overrides,
    });

    const mutatedJournal = {
      ...fixture.legacyJournal,
      updatedAt: "2026-08-02T11:58:31.000Z",
    };
    await writeJson(fixture.journalPath, mutatedJournal);
    await expect(
      bootstrapTesting.importLegacyManagedUpdateAdoption(
        sourceRoot,
        spec,
        layout,
        registryEntry,
        importOptions(),
      ),
    ).rejects.toThrow(/journal|receipt|durable state/iu);
    await fs.writeFile(fixture.journalPath, fixture.legacyJournalBytes, { mode: 0o600 });

    await fs.rm(fixture.currentLink);
    await fs.symlink(fixture.targetRoot, fixture.currentLink, "dir");
    await expect(
      bootstrapTesting.importLegacyManagedUpdateAdoption(
        sourceRoot,
        spec,
        layout,
        registryEntry,
        importOptions(),
      ),
    ).rejects.toThrow(/runtime\/current|previous transaction outcome/iu);
    await fs.rm(fixture.currentLink);
    await fs.symlink(fixture.installedRoot, fixture.currentLink, "dir");

    await writeJson(fixture.installPath, {
      ...fixture.installedManifest,
      service: { ...fixture.installedManifest.service, name: "unbound.service" },
    });
    await expect(
      bootstrapTesting.importLegacyManagedUpdateAdoption(
        sourceRoot,
        spec,
        layout,
        registryEntry,
        importOptions(),
      ),
    ).rejects.toThrow(/manifest|service/iu);
    await fs.writeFile(fixture.installPath, fixture.installBytes, { mode: 0o600 });

    const mismatchedGatewayProbe = vi.fn(async () => ({
      ...fixture.gateway,
      generationDigest: `sha256:${digest("9")}`,
    }));
    await expect(
      bootstrapTesting.importLegacyManagedUpdateAdoption(
        sourceRoot,
        spec,
        layout,
        registryEntry,
        importOptions({
          probeGateway: mismatchedGatewayProbe,
        }),
      ),
    ).rejects.toThrow(/receipt|durable state|Gateway/iu);
    expect(await pathExists(rootBindingPath)).toBe(false);

    const rootImportCrash = new Error("fixture crash after durable root adoption import");
    let durableRootBindingBytes = "";
    await expect(
      bootstrapTesting.importLegacyManagedUpdateAdoption(
        sourceRoot,
        spec,
        layout,
        registryEntry,
        importOptions({
          writeBinding: async (bindingPath: string, binding: unknown) => {
            durableRootBindingBytes = await writeDurableJson(bindingPath, binding);
            throw rootImportCrash;
          },
        }),
      ),
    ).rejects.toBe(rootImportCrash);
    expect(await fs.readFile(rootBindingPath, "utf8")).toBe(durableRootBindingBytes);
    expect(await fs.readFile(fixture.journalPath, "utf8")).toBe(fixture.legacyJournalBytes);
    expect(await fs.readFile(fixture.adoptionReceiptPath, "utf8")).toBe(durableUserReceiptBytes);
    const imported = (await bootstrapTesting.importLegacyManagedUpdateAdoption(
      sourceRoot,
      spec,
      layout,
      registryEntry,
      importOptions(),
    )) as Record<string, unknown>;
    expect(await fs.readFile(rootBindingPath, "utf8")).toBe(durableRootBindingBytes);
    expectExactKeys(imported, [
      "adoptionReceiptDigest",
      "importedAt",
      "instanceId",
      "legacyTransactionId",
      "operatorGid",
      "operatorUid",
      "previousVersion",
      "profile",
      "schemaVersion",
      "stateDirSha256",
      "targetVersion",
      "verification",
    ]);
    expect(imported).toMatchObject({
      schemaVersion: 1,
      profile: "protected-local",
      instanceId: fixture.instanceId,
      operatorUid: uid,
      operatorGid: gid,
      stateDirSha256: prefixedSha256(fixture.stateDir),
      adoptionReceiptDigest: durableUserReceipt.receiptDigest,
      legacyTransactionId: fixture.transactionId,
      previousVersion,
      targetVersion,
      verification: "pending",
    });
    expect(await snapshotFiles(fixture.sentinels)).toEqual(sentinelsBefore);
    expect(await sha256File(fixture.privateSupervisorPath)).toBe(privateSupervisorBefore);
    expect((await fs.stat(fixture.privateSupervisorDir)).mode & 0o777).toBe(0o700);
    expect(await fs.realpath(fixture.currentLink)).toBe(fixture.installedRoot);
    expect(await fs.realpath(fixture.rootApplicationCurrent)).toBe(fixture.rootApplicationRoot);

    // The controlling case continues through the real normal target-owned B
    // transaction below. Root import alone is deliberately not acceptance.
    expect(imported.verification).toBe("pending");

    const targetController = await targetControllerContext(fixture);
    const supervisorRoot = path.join(fixture.root, "stable-supervisor");
    const baseSupervisorPaths = fixturePaths(supervisorRoot);
    const supervisorPaths = Object.freeze({
      ...baseSupervisorPaths,
      supervisorStateDir: path.dirname(rootBindingPath),
      rootTransactionPath: path.join(path.dirname(rootBindingPath), "product-transaction.json"),
      productJournalPath: targetController.paths.journalPath,
      productVersionPath: targetController.paths.versionPath,
    });
    await fs.mkdir(supervisorPaths.supervisorStateDir, { recursive: true, mode: 0o700 });
    const targetControllerIdentity = Object.freeze({
      schemaVersion: 1,
      version: targetVersion,
      serverSha256: digest("7"),
      clientSha256: digest("8"),
    });
    const stagedController = Object.freeze({
      changed: false,
      supervisorChanged: false,
      identity: targetControllerIdentity,
      releaseCommit: fixture.rootTargetApplicationRuntime.release.commit,
      targetManifestSha256: fixture.rootTargetApplicationRuntime.release.manifestDigest.slice(
        "sha256:".length,
      ),
      trustPolicySha256: digest("9"),
      previousGeneration: null,
      previousIdentity: null,
    });
    const controllerState = { recovery: Object.freeze({ state: "READY" }) };
    const controllerOperations: string[] = [];
    let loseFirstAcknowledgmentResponse = true;
    const supervisorContext = supervisorTesting.createContext(
      {
        profile: "protected-local",
        instanceId: fixture.instanceId,
        operatorUid: uid,
        operatorGid: gid,
        paths: supervisorPaths,
      },
      {
        rootUid: uid,
        rootGid: gid,
        operatorStateDirSha256: prefixedSha256(fixture.stateDir),
        now: () => Date.now(),
        stageTrustedController: async () => stagedController,
        cleanupHistoricalControllerCandidates: async () => undefined,
        probeControllerIdentity: async (
          _request: unknown,
          _context: unknown,
          expected: unknown,
        ) => {
          expect(expected).toEqual(targetControllerIdentity);
          return targetController.context.controllerInstanceId;
        },
        restartController: async () => undefined,
        waitForController: async () => undefined,
        requestController: async (value: Record<string, unknown>) => {
          controllerOperations.push(String(value.op));
          const parsed = parseUpdateRequest(value);
          const result = await controllerTesting.dispatchUpdateRequest(
            parsed,
            targetController.context,
            controllerState,
          );
          if (value.op === "acknowledgeLegacyAdoption" && loseFirstAcknowledgmentResponse) {
            loseFirstAcknowledgmentResponse = false;
            throw new Error("fixture lost response after durable target acknowledgment");
          }
          return Object.freeze({ ok: true, ...result });
        },
      },
    );
    const supervisorState = {
      controllerInstanceId: targetController.context.controllerInstanceId,
    };
    const updateTransactionId = randomUUID();
    const recoverSupervisor = async (
      transactionId: string,
      version: string,
      timeoutMs: number,
      socketPath: string,
    ) =>
      await recoverPendingSupervisorTransaction(
        {
          socketPath,
          transactionId,
          nonce: randomUUID(),
          version,
          timeoutMs,
        },
        {
          request: async (params: Record<string, unknown>) =>
            await supervisorTesting.handleSupervisorRequest(
              supervisorRequest(
                params.operation as "recoverActive" | "recoveryStatus",
                String(params.transactionId),
                String(params.version),
                {
                  nonce: String(params.nonce),
                  ...(typeof params.recoveryDigest === "string"
                    ? { recoveryDigest: params.recoveryDigest }
                    : {}),
                  ...(typeof params.recoveryControllerVersion === "string"
                    ? {
                        recoveryControllerVersion: params.recoveryControllerVersion,
                      }
                    : {}),
                },
              ),
              supervisorContext,
              supervisorState,
            ),
          wait: async () => undefined,
        },
      );
    const runManagedConvergence = async (currentVersion: string, manifest: unknown) =>
      await managedUpdaterTesting.convergeRootManagedTarget(
        {
          paths: fixture.managedPaths,
          existingManifest: manifest,
          currentVersion,
          targetVersion,
          timeoutMs: 30_000,
        },
        {
          randomTransactionId: () => updateTransactionId,
          resolveControllerSocket: () => "fixture://stable-supervisor",
          handoff: async (handoff: Record<string, unknown>) =>
            await managedUpdaterTesting.handoffTargetOwnedRelease({
              ...handoff,
              recoverSupervisor,
              ensureController: async () =>
                await supervisorTesting.handleSupervisorRequest(
                  supervisorRequest("updateController", updateTransactionId),
                  supervisorContext,
                  supervisorState,
                ),
              applyRelease: async () =>
                await supervisorTesting.handleSupervisorRequest(
                  supervisorRequest("applyRelease", updateTransactionId),
                  supervisorContext,
                  supervisorState,
                ),
            }),
        },
      );

    await expect(runManagedConvergence(previousVersion, fixture.installedManifest)).rejects.toThrow(
      "lost response after durable target acknowledgment",
    );
    expect(await pathExists(supervisorPaths.rootTransactionPath)).toBe(true);
    expect(await pathExists(rootBindingPath)).toBe(true);
    expect(await pathExists(fixture.journalPath)).toBe(false);
    expect(await pathExists(fixture.adoptionReceiptPath)).toBe(false);

    const converged = await runManagedConvergence(previousVersion, fixture.installedManifest);
    expect(converged.result).toMatchObject({
      phase: "committed",
      version: targetVersion,
      changed: false,
    });
    expect(await pathExists(supervisorPaths.rootTransactionPath)).toBe(false);
    expect(await pathExists(rootBindingPath)).toBe(false);
    expect(await snapshotFiles(fixture.sentinels)).toEqual(sentinelsBefore);
    expect(await sha256File(fixture.privateSupervisorPath)).toBe(privateSupervisorBefore);
    expect(await fs.realpath(fixture.currentLink)).toBe(fixture.rootTargetApplicationRoot);
    expect(await fs.realpath(fixture.rootApplicationCurrent)).toBe(
      fixture.rootTargetApplicationRoot,
    );
    expect(JSON.parse(await fs.readFile(fixture.installPath, "utf8"))).toMatchObject({
      profile: "protected-local",
      runtime: { activeVersion: targetVersion },
      updater: { version: targetVersion },
    });

    const targetManifest = JSON.parse(await fs.readFile(fixture.installPath, "utf8"));
    const alreadyCurrentTransactionId = randomUUID();
    const alreadyCurrent = await managedUpdaterTesting.convergeRootManagedTarget(
      {
        paths: fixture.managedPaths,
        existingManifest: targetManifest,
        currentVersion: targetVersion,
        targetVersion,
        timeoutMs: 30_000,
      },
      {
        randomTransactionId: () => alreadyCurrentTransactionId,
        resolveControllerSocket: () => "fixture://stable-supervisor",
        handoff: async (handoff: Record<string, unknown>) =>
          await managedUpdaterTesting.handoffTargetOwnedRelease({
            ...handoff,
            recoverSupervisor,
            ensureController: async () =>
              await supervisorTesting.handleSupervisorRequest(
                supervisorRequest("updateController", alreadyCurrentTransactionId),
                supervisorContext,
                supervisorState,
              ),
            applyRelease: async () =>
              await supervisorTesting.handleSupervisorRequest(
                supervisorRequest("applyRelease", alreadyCurrentTransactionId),
                supervisorContext,
                supervisorState,
              ),
          }),
      },
    );
    expect(alreadyCurrent.result).toMatchObject({
      phase: "committed",
      version: targetVersion,
      changed: false,
    });
    expect(controllerOperations).toEqual([
      "applyRelease",
      "releaseStatus",
      "acknowledgeLegacyAdoption",
      "releaseStatus",
      "releaseStatus",
      "acknowledgeLegacyAdoption",
      "applyRelease",
      "applyRelease",
    ]);
    expect(await snapshotFiles(fixture.sentinels)).toEqual(sentinelsBefore);
    expect(await pathExists(targetController.paths.journalPath)).toBe(false);
  });

  it("uses a verified recovery-capable controller instead of sending recoverActive to legacy A", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-local-recovery-t1-"));
    roots.push(root);
    const paths = fixturePaths(root);
    const uid = process.getuid?.() ?? 0;
    const gid = process.getgid?.() ?? 0;
    await fs.mkdir(paths.supervisorStateDir, { recursive: true, mode: 0o700 });

    const previous = await writeControllerGeneration(
      paths.releasesDir,
      previousVersion,
      "previous-controller-server\n",
      "previous-controller-client\n",
    );
    // This pinned published manifest is fixture evidence, never a migration
    // selector. Its published dispatcher operation contract had no explicit
    // recovery operation.
    const publishedLegacyContract = Object.freeze({
      ref: publishedLegacyRef,
      serverSha256: publishedLegacyServerSha256,
      clientSha256: publishedLegacyClientSha256,
      operations: Object.freeze([
        "updateController",
        "applyRelease",
        "prepareRelease",
        "activateRelease",
        "authorizeGatewayRelease",
        "gateGatewayRelease",
        "restartGateway",
        "commitRelease",
        "rollbackRelease",
        "controllerStatus",
        "releaseStatus",
      ]),
    });
    expect(publishedLegacyContract.operations).not.toContain("recoverActive");
    const legacyA = await writeControllerGeneration(
      paths.releasesDir,
      targetVersion,
      "pinned-published-legacy-controller-placeholder\n",
      "pinned-published-legacy-client-placeholder\n",
    );
    const legacyAIdentity = Object.freeze({
      ...legacyA.identity,
      serverSha256: publishedLegacyContract.serverSha256,
      clientSha256: publishedLegacyContract.clientSha256,
    });
    const recoveryB = await writeControllerGeneration(
      paths.releasesDir,
      recoveryControllerVersion,
      "verified-recovery-controller-b\n",
      "verified-recovery-controller-b-client\n",
    );
    await fs.symlink(legacyA.generation, paths.currentLink);
    await fs.writeFile(
      paths.controllerVersionPath,
      `${JSON.stringify(legacyAIdentity, null, 2)}\n`,
      { mode: 0o600 },
    );

    const transactionId = randomUUID();
    const selectedAInstance = randomUUID();
    const selectionRequest = supervisorRequest("updateController", transactionId);
    const legacyAReceipt = supervisorTesting.createControllerSelectionReceipt(
      selectionRequest,
      {
        releaseCommit: "a".repeat(40),
        targetManifestSha256: digest("1"),
        trustPolicySha256: digest("2"),
        identity: legacyAIdentity,
      },
      selectedAInstance,
      { now },
    );
    const release = {
      version: targetVersion,
      commit: "a".repeat(40),
      buildInputDigest: `sha256:${digest("3")}`,
      development: false,
    };
    const artifactDigests = {
      application: digest("4"),
      dependencies: digest("5"),
      signer: digest("6"),
      updaterBundle: digest("7"),
    };
    let productJournal: Record<string, unknown> | null = {
      schemaVersion: 7,
      transactionId,
      version: targetVersion,
      phase: "active",
      previousVersion,
      selectionDigest: legacyAReceipt.selectionDigest,
      targetControllerReceipt: legacyAReceipt,
      targetReleaseIdentity: release,
      artifactDigests,
      legacyAdoption: null,
      journalSha256: digest("8"),
    };
    let rootTransaction: Record<string, unknown> | null =
      supervisorTesting.rootProductTransactionRecord({
        request: selectionRequest,
        phase: "active",
        previousVersion,
        previousControllerIdentity: previous.identity,
        previousControllerGenerationVersion: previousVersion,
        targetControllerReceipt: legacyAReceipt,
        targetReleaseIdentity: release,
        artifactDigests,
        targetJournalSha256: productJournal.journalSha256,
        selectionDigest: legacyAReceipt.selectionDigest,
        recoveryAttempts: 8,
        now,
      }) as unknown as Record<string, unknown>;
    const stableRecoveryIdentity = supervisorTesting.recoveryIdentityDigest(
      null,
      rootTransaction,
      productJournal,
    );
    expect(
      supervisorTesting.recoveryIdentityDigest(
        null,
        {
          ...rootTransaction,
          recoveryAttempts: Number(rootTransaction.recoveryAttempts) + 1,
          lastErrorClass: "RECOVERY_FAILED",
          updatedAt: "2026-08-02T11:59:59.000Z",
        },
        productJournal,
      ),
    ).toBe(stableRecoveryIdentity);
    expect(
      supervisorTesting.recoveryIdentityDigest(
        null,
        { ...rootTransaction, phase: "committing" },
        productJournal,
      ),
    ).not.toBe(stableRecoveryIdentity);
    expect(
      supervisorTesting.recoveryIdentityDigest(
        null,
        { ...rootTransaction, durableCommitDecision: true },
        productJournal,
      ),
    ).not.toBe(stableRecoveryIdentity);
    expect(
      supervisorTesting.recoveryIdentityDigest(
        null,
        {
          ...rootTransaction,
          targetControllerReceipt: {
            ...(rootTransaction.targetControllerReceipt as Record<string, unknown>),
            controllerServerSha256: digest("e"),
          },
        },
        productJournal,
      ),
    ).not.toBe(stableRecoveryIdentity);
    expect(
      supervisorTesting.recoveryIdentityDigest(null, rootTransaction, {
        ...productJournal,
        phase: "committing",
      }),
    ).not.toBe(stableRecoveryIdentity);
    const state = pendingState(rootTransaction, productJournal);
    const protectedStatePath = path.join(root, "user-state", "wallet-mining-network.json");
    await fs.mkdir(path.dirname(protectedStatePath), { recursive: true });
    await fs.writeFile(
      protectedStatePath,
      `${JSON.stringify({ wallet: "agent", miningActions: 40_841, network: "sat" })}\n`,
    );
    const stateBefore = sha256(await fs.readFile(protectedStatePath, "utf8"));

    const recoveryBInstance = randomUUID();
    const recoveryBSelectionRequest = supervisorRequest(
      "updateController",
      transactionId,
      recoveryControllerVersion,
    );
    const recoveryBReceipt = supervisorTesting.createControllerSelectionReceipt(
      recoveryBSelectionRequest,
      {
        releaseCommit: "b".repeat(40),
        targetManifestSha256: digest("9"),
        trustPolicySha256: digest("2"),
        identity: recoveryB.identity,
      },
      recoveryBInstance,
      { now },
    );
    const recoveryCapabilities = Object.freeze({
      protocolVersion: 1,
      operations: Object.freeze(["recoverActive"]),
      journalSchemas: Object.freeze([7, 8]),
    });
    const calls: string[] = [];
    let legacyARecoveryCalls = 0;
    let recoveryCalls = 0;
    const recoveryAuthorizations: Record<string, unknown>[] = [];
    const requestController = vi.fn(async (request: Record<string, unknown>) => {
      if (request.op === "recoverActive") {
        const receipt = request.supervisorReceipt as Record<string, unknown> | undefined;
        if (receipt?.selectionDigest === legacyAReceipt.selectionDigest) {
          legacyARecoveryCalls += 1;
          throw new Error("legacy controller A must never receive recoverActive");
        }
        recoveryCalls += 1;
        expect(receipt).toBeUndefined();
        expect(request.recoveryControllerInstanceId).toBe(recoveryBInstance);
        const parsedWire = parseUpdateRequest(
          JSON.parse(JSON.stringify(request)) as Record<string, unknown>,
        );
        expect(parsedWire).toMatchObject({
          transactionId,
          version: targetVersion,
          recoveryControllerInstanceId: recoveryBInstance,
          recoveryAuthorization: {
            transactionId,
            version: targetVersion,
            expectedOutcome: "rolled-back",
            recoveryController: {
              version: recoveryControllerVersion,
              releaseCommit: "b".repeat(40),
              targetManifestSha256: digest("9"),
              serverSha256: recoveryB.identity.serverSha256,
              clientSha256: recoveryB.identity.clientSha256,
              trustPolicySha256: digest("2"),
              recoveryCapabilities: { journalSchemas: [7, 8] },
            },
          },
        });
        const authorization = request.recoveryAuthorization as {
          authorizationDigest: string;
          expectedOutcome: string;
          recoveryIdentityDigest: string;
          productJournalDigest: string;
          legacySelectionDigest: string;
          recoveryController: Record<string, unknown>;
        };
        recoveryAuthorizations.push(authorization as unknown as Record<string, unknown>);
        expect(authorization.recoveryIdentityDigest).toBe(stableRecoveryIdentity);
        expect(authorization.recoveryIdentityDigest).toMatch(/^[a-f0-9]{64}$/u);
        expect(authorization.productJournalDigest).toBe(digest("8"));
        expect(authorization.legacySelectionDigest).toBe(legacyAReceipt.selectionDigest);
        expect(authorization.recoveryController).toMatchObject({
          version: recoveryControllerVersion,
          releaseCommit: "b".repeat(40),
          targetManifestSha256: digest("9"),
          serverSha256: recoveryB.identity.serverSha256,
          clientSha256: recoveryB.identity.clientSha256,
          trustPolicySha256: digest("2"),
          recoveryCapabilities: {
            protocolVersion: 1,
            operations: ["recoverActive"],
            journalSchemas: [7, 8],
          },
        });
        expect(authorization.expectedOutcome).toBe("rolled-back");
        calls.push("recover-with-B");
        if (recoveryCalls <= 4) {
          return {
            ok: true,
            transactionId,
            version: targetVersion,
            phase: "rolled-back",
            recoveryControllerInstanceId: request.recoveryControllerInstanceId,
            recoveryAuthorizationDigest: digest("0"),
          };
        }
        productJournal = null;
        return {
          ok: true,
          transactionId,
          version: targetVersion,
          phase: "rolled-back",
          recoveryControllerInstanceId: request.recoveryControllerInstanceId,
          recoveryAuthorizationDigest: authorization.authorizationDigest,
        };
      }
      if (request.op === "releaseStatus") {
        return {
          ok: true,
          transactionId,
          version: targetVersion,
          phase: "rolled-back",
          healthy: true,
          release: null,
        };
      }
      throw new Error(`unexpected controller request ${String(request.op)}`);
    });
    const probeControllerIdentity = vi.fn(
      async (_request: unknown, _context: unknown, identity: { version: string }) => {
        calls.push(`probe-${identity.version}`);
        return randomUUID();
      },
    );
    const stageTrustedController = vi.fn(async (request: { version: string }) => {
      expect(request.version).toBe(recoveryControllerVersion);
      calls.push("stage-B");
      return {
        changed: false,
        supervisorChanged: false,
        trustChanged: false,
        releaseCommit: "b".repeat(40),
        targetManifestSha256: digest("9"),
        trustPolicySha256: digest("2"),
        identity: recoveryB.identity,
        previousGeneration: legacyA.generation,
        previousIdentity: legacyAIdentity,
      };
    });
    const probeRecoveryControllerIdentity = vi.fn(
      async (
        request: { version: string },
        _context: unknown,
        identity: { version: string; serverSha256: string; clientSha256: string },
      ) => {
        expect(request.version).toBe(recoveryControllerVersion);
        expect(identity).toEqual(recoveryB.identity);
        calls.push(`probe-recovery-${identity.version}`);
        return { controllerInstanceId: recoveryBInstance, recoveryCapabilities };
      },
    );
    const writeControllerSelectionReceipt = vi.fn(async () => recoveryBReceipt);
    let recoveryNow = now;
    const context = supervisorTesting.createContext(
      {
        profile: "protected-local",
        operatorUid: uid,
        operatorGid: gid,
        paths,
      },
      {
        rootUid: uid,
        rootGid: gid,
        operatorStateDirSha256: prefixedSha256(path.join(root, "legacy-fixture-state")),
        now: () => recoveryNow,
        stageTrustedController,
        probeRecoveryControllerIdentity,
        writeControllerSelectionReceipt,
        readSupervisorTransaction: async () => null,
        readRootProductTransaction: async () => rootTransaction,
        writeRootProductTransaction: async (_paths: unknown, value: Record<string, unknown>) => {
          rootTransaction = value;
          return value;
        },
        clearRootProductTransaction: async () => {
          if (productJournal !== null) {
            throw new Error("root journal cannot clear before the controller journal");
          }
          calls.push("clear-root");
          rootTransaction = null;
        },
        readControllerProductJournal: async () => productJournal,
        readProductVersion: async () => previousVersion,
        requestController,
        probeControllerIdentity,
        restartController: async () => calls.push("restart-controller"),
        waitForController: async () => calls.push("wait-controller"),
      },
    );

    const statusRequest = supervisorRequest("recoveryStatus", transactionId);
    const status = await supervisorTesting.handleSupervisorRequest(statusRequest, context, state);
    expect(status).toMatchObject({
      ok: true,
      phase: "recovery-pending",
      recovery: {
        state: "RECOVERY_PENDING",
        transactionId,
        targetVersion,
        phase: "active",
      },
    });
    await expect(
      supervisorTesting.handleSupervisorRequest(
        supervisorRequest("applyRelease", transactionId),
        context,
        state,
      ),
    ).rejects.toThrow("new product mutation is blocked");
    expect(requestController).not.toHaveBeenCalled();

    const wrongRecovery = supervisorRequest("recoverActive", transactionId, targetVersion, {
      recoveryDigest: digest("f"),
    });
    await expect(
      supervisorTesting.handleSupervisorRequest(wrongRecovery, context, state),
    ).rejects.toThrow("does not match the protected journal");
    expect(requestController).not.toHaveBeenCalled();

    const firstNonce = randomUUID();
    const firstRecovery = supervisorRequest("recoverActive", transactionId, targetVersion, {
      nonce: firstNonce,
      recoveryDigest: state.recovery.journalDigest,
    });
    await expect(
      supervisorTesting.handleSupervisorRequest(firstRecovery, context, state),
    ).rejects.toThrow("target controller did not complete the bound product recovery");
    expect(state.recovery).toMatchObject({ state: "RECOVERY_PENDING", transactionId });

    const replayedNonce = supervisorRequest("recoverActive", transactionId, targetVersion, {
      nonce: firstNonce,
      recoveryDigest: state.recovery.journalDigest,
    });
    await expect(
      supervisorTesting.handleSupervisorRequest(replayedNonce, context, state),
    ).rejects.toThrow("nonce was already consumed");

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(
        supervisorTesting.handleSupervisorRequest(
          supervisorRequest("recoverActive", transactionId, targetVersion, {
            nonce: randomUUID(),
            recoveryDigest: state.recovery.journalDigest,
          }),
          context,
          state,
        ),
      ).rejects.toThrow("target controller did not complete the bound product recovery");
    }
    recoveryNow += 10 * 60_000;
    const retry = supervisorRequest("recoverActive", transactionId, targetVersion, {
      nonce: randomUUID(),
      recoveryDigest: state.recovery.journalDigest,
    });
    await expect(
      supervisorTesting.handleSupervisorRequest(retry, context, state),
    ).resolves.toMatchObject({
      ok: true,
      action: "rolled-back",
      recovery: { state: "READY" },
    });
    expect(rootTransaction).toBeNull();
    expect(productJournal).toBeNull();
    expect(await fs.realpath(paths.currentLink)).toBe(previous.generation);
    expect(JSON.parse(await fs.readFile(paths.controllerVersionPath, "utf8"))).toEqual(
      previous.identity,
    );
    expect(sha256(await fs.readFile(protectedStatePath, "utf8"))).toBe(stateBefore);
    await expect(
      fs.access(path.join(paths.supervisorStateDir, "explicit-recovery-attempt.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      supervisorTesting.handleSupervisorRequest(statusRequest, context, state),
    ).resolves.toMatchObject({ recovery: { state: "READY" }, phase: "ready" });
    expect(calls).toContain("recover-with-B");
    expect(legacyARecoveryCalls).toBe(0);
    expect(recoveryCalls).toBe(5);
    expect(recoveryAuthorizations).toHaveLength(5);
    expect(new Set(recoveryAuthorizations.map((entry) => entry.authorizationDigest))).toEqual(
      new Set([recoveryAuthorizations[0]?.authorizationDigest]),
    );
    expect(recoveryAuthorizations.at(-1)?.authorizationDigest).toBe(
      recoveryAuthorizations[0]?.authorizationDigest,
    );
    const durableAuthorization = recoveryAuthorizations[0];
    const expectedAuthorization = {
      transactionId: durableAuthorization.transactionId,
      version: durableAuthorization.version,
      recoveryIdentityDigest: durableAuthorization.recoveryIdentityDigest,
      productJournalDigest: durableAuthorization.productJournalDigest,
      legacySelectionDigest: durableAuthorization.legacySelectionDigest,
      expectedOutcome: durableAuthorization.expectedOutcome,
      recoveryController: durableAuthorization.recoveryController,
      recoveryEpoch: durableAuthorization.recoveryEpoch,
    };
    expect(() =>
      supervisorTesting.assertRecoveryAuthorizationBinding(
        durableAuthorization,
        expectedAuthorization,
      ),
    ).not.toThrow();
    for (const changed of [
      { recoveryIdentityDigest: digest("d") },
      { productJournalDigest: digest("e") },
      { expectedOutcome: "committed" },
      {
        recoveryController: {
          ...(durableAuthorization.recoveryController as Record<string, unknown>),
          serverSha256: digest("f"),
        },
      },
    ]) {
      expect(() =>
        supervisorTesting.assertRecoveryAuthorizationBinding(durableAuthorization, {
          ...expectedAuthorization,
          ...changed,
        }),
      ).toThrow("recovery controller authorization changed across retry");
    }
    expect(stageTrustedController).toHaveBeenCalledTimes(5);
    expect(probeRecoveryControllerIdentity).toHaveBeenCalledTimes(5);
    expect(probeRecoveryControllerIdentity).toHaveBeenLastCalledWith(
      expect.objectContaining({ version: recoveryControllerVersion }),
      context,
      recoveryB.identity,
    );
    expect(writeControllerSelectionReceipt).toHaveBeenCalledTimes(5);
    expect(probeControllerIdentity).toHaveBeenLastCalledWith(
      expect.any(Object),
      context,
      previous.identity,
    );
    expect(calls.at(-1)).toBe("clear-root");
  });

  it("rejects a live recovery-controller process mismatch before mutation", async () => {
    const transactionId = randomUUID();
    const runningInstance = randomUUID();
    const wrongInstance = randomUUID();
    const selectionRequest = supervisorRequest("updateController", transactionId);
    const selectionReceipt = supervisorTesting.createControllerSelectionReceipt(
      selectionRequest,
      {
        releaseCommit: "a".repeat(40),
        targetManifestSha256: digest("d"),
        trustPolicySha256: digest("e"),
        identity: {
          version: targetVersion,
          serverSha256: digest("b"),
          clientSha256: digest("c"),
        },
      },
      runningInstance,
      { now },
    );
    const recovery = Object.freeze({
      state: "RECOVERY_PENDING",
      transactionId,
      targetVersion,
      phase: "active",
      durableCommitDecision: false,
      journalDigest: digest("a"),
      recoveryIdentityDigest: digest("f"),
      legacySelectionDigest: selectionReceipt.selectionDigest,
      journalSchemaVersion: 7,
      lastErrorClass: null,
    });
    const authorizedAt = Date.now() - 10 * 60_000;
    const authorizationUnsigned = {
      schemaVersion: 3,
      transactionId,
      version: targetVersion,
      recoveryIdentityDigest: recovery.recoveryIdentityDigest,
      productJournalDigest: recovery.journalDigest,
      legacySelectionDigest: selectionReceipt.selectionDigest,
      expectedOutcome: "rolled-back",
      recoveryController: {
        version: targetVersion,
        releaseCommit: selectionReceipt.releaseCommit,
        targetManifestSha256: selectionReceipt.targetManifestSha256,
        serverSha256: digest("b"),
        clientSha256: digest("c"),
        trustPolicySha256: selectionReceipt.trustPolicySha256,
        protocolCapabilities: selectionReceipt.protocolCapabilities,
        recoveryCapabilities: {
          protocolVersion: 1,
          operations: ["recoverActive"],
          journalSchemas: [7, 8],
        },
      },
      allowedOperation: "recoverActive",
      recoveryEpoch: randomUUID(),
      authorizedAt: new Date(authorizedAt).toISOString(),
    };
    const recoveryAuthorization = {
      ...authorizationUnsigned,
      authorizationDigest: sha256(canonical(authorizationUnsigned)),
    };
    const context = {
      supervised: true,
      runningControllerVersion: targetVersion,
      runningControllerIdentity: {
        version: targetVersion,
        serverSha256: digest("b"),
        clientSha256: digest("c"),
      },
      controllerInstanceId: runningInstance,
    } as unknown as Parameters<typeof controllerTesting.dispatchUpdateRequest>[1];
    const request = parseUpdateRequest({
      schemaVersion: 2,
      op: "recoverActive",
      transactionId,
      version: targetVersion,
      recoveryDigest: recovery.journalDigest,
      recoveryControllerInstanceId: wrongInstance,
      recoveryAuthorization,
    });

    await expect(
      controllerTesting.dispatchUpdateRequest(request, context, { recovery }),
    ).rejects.toThrow("process identity is mismatched");
  });
});
