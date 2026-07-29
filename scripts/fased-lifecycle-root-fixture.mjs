#!/usr/bin/env node

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { startServer, __testing as controllerTesting } from "./fased-host-updater.mjs";
import { startSupervisor, __testing as supervisorTesting } from "./fased-lifecycle-supervisor.mjs";

const previousVersion = "1.2.2";
const targetVersion = "1.2.3";
const operatorUid = 1000;
const operatorGid = 1000;
const gatewayUid = 1001;
const configGid = 1002;
const evidenceDigest = (character) => `sha256:${character.repeat(64)}`;

function signerRelease(version) {
  return {
    version,
    commit: "a".repeat(40),
    buildInputDigest: evidenceDigest("b"),
    development: false,
  };
}

async function socketRequest(socketPath, op, transactionId) {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    socket.setEncoding("utf8");
    socket.setTimeout(10_000);
    let body = "";
    let settled = false;
    const fail = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      reject(error);
    };
    socket.once("connect", () => {
      socket.write(
        `${JSON.stringify({
          schemaVersion: 2,
          op,
          transactionId,
          version: targetVersion,
        })}\n`,
      );
    });
    socket.on("data", (chunk) => {
      body += chunk;
      if (body.length > 64 * 1024) {
        fail(new Error("fixture lifecycle response exceeded its bound"));
        return;
      }
      const newline = body.indexOf("\n");
      if (newline < 0 || settled) {
        return;
      }
      try {
        settled = true;
        const response = JSON.parse(body.slice(0, newline));
        socket.destroy();
        resolve(response);
      } catch (error) {
        fail(
          new Error(`fixture lifecycle response is invalid: ${error.message}`, { cause: error }),
        );
      }
    });
    socket.once("timeout", () => fail(new Error(`fixture lifecycle ${op} timed out`)));
    socket.once("error", fail);
    socket.once("close", () => {
      if (!settled) {
        fail(new Error(`fixture lifecycle ${op} closed without a response`));
      }
    });
  });
}

async function writeOwnedFile(filePath, contents, uid, gid, mode) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, contents, { mode });
  await fsp.chown(filePath, uid, gid);
  await fsp.chmod(filePath, mode);
}

async function createRootFixture({ crashPhase = null } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fased-root-update-"));
  const controllerStateDir = path.join(root, "controller-state");
  const signerPath = path.join(root, "signer", "fased-signerd");
  const signerStateDBPath = path.join(root, "signer-state", "state.db");
  const signerUnitPath = path.join(root, "systemd", "fased-signerd.service");
  const privateSocketPath = path.join(root, "run", "controller.sock");
  const publicSocketPath = path.join(root, "run", "request.sock");
  const stateDir = path.join(root, "operator", ".fased");
  const identityDir = path.join(stateDir, "identity");
  const configPath = path.join(stateDir, "fased.json");
  const deviceAuthPath = path.join(identityDir, "device-auth.json");
  const unknownPath = path.join(stateDir, "owner-private.txt");
  const controllerPaths = {
    socketPath: privateSocketPath,
    stateDir: controllerStateDir,
    controllerReleasesDir: path.join(root, "controller", "releases"),
    controllerCurrentLink: path.join(root, "controller", "current"),
    controllerVersionPath: path.join(controllerStateDir, "controller-version.json"),
    signerPath,
    signerStateDBPath,
    signerUnitPath,
    versionPath: path.join(controllerStateDir, "signer-version"),
    channelPath: path.join(root, "channel"),
    journalPath: path.join(controllerStateDir, "active-signer-transaction.json"),
    rollbackFloorPath: path.join(controllerStateDir, "rollback-floor"),
    gatewayGatePath: path.join(controllerStateDir, "gateway-update-gate"),
    signerGatePath: path.join(root, "signer-gate", "active"),
    transactionsDir: path.join(controllerStateDir, "transactions"),
  };
  const supervisorPaths = {
    publicSocketPath,
    privateSocketPath,
    stateDir: controllerStateDir,
    supervisorStateDir: path.join(controllerStateDir, "supervisor"),
    releasesDir: controllerPaths.controllerReleasesDir,
    currentLink: controllerPaths.controllerCurrentLink,
    controllerVersionPath: controllerPaths.controllerVersionPath,
    rollbackFloorPath: path.join(controllerStateDir, "supervisor", "rollback-floor"),
    trustedRootPath: path.join(controllerStateDir, "supervisor", "trusted-root.json"),
    trustStatePath: path.join(controllerStateDir, "supervisor", "trust-state.json"),
    supervisorTransactionPath: path.join(
      controllerStateDir,
      "supervisor",
      "controller-transaction.json",
    ),
    channelPath: controllerPaths.channelPath,
    supervisorPath: path.join(root, "supervisor", "fased-lifecycle-supervisor.mjs"),
    controllerUnit: "fixture-controller.service",
    supervisorUnit: "fixture-supervisor.service",
  };

  await Promise.all([
    fsp.mkdir(controllerStateDir, { recursive: true, mode: 0o700 }),
    fsp.mkdir(path.dirname(signerPath), { recursive: true, mode: 0o755 }),
    fsp.mkdir(path.dirname(signerStateDBPath), { recursive: true, mode: 0o700 }),
    fsp.mkdir(path.dirname(signerUnitPath), { recursive: true, mode: 0o755 }),
    fsp.mkdir(identityDir, { recursive: true, mode: 0o700 }),
  ]);
  await fsp.chown(path.join(root, "operator"), operatorUid, operatorGid);
  await fsp.chmod(path.join(root, "operator"), 0o700);
  await fsp.chown(stateDir, operatorUid, operatorGid);
  await fsp.chmod(stateDir, 0o700);
  await fsp.chown(identityDir, operatorUid, operatorGid);
  await fsp.chmod(identityDir, 0o700);
  await Promise.all([
    writeOwnedFile(
      configPath,
      '{"fixtureSecret":"preserve-config"}\n', // pragma: allowlist secret
      operatorUid,
      operatorGid,
      0o600,
    ),
    writeOwnedFile(
      deviceAuthPath,
      '{"fixtureSecret":"preserve-device-auth"}\n', // pragma: allowlist secret
      operatorUid,
      operatorGid,
      0o600,
    ),
    writeOwnedFile(unknownPath, "preserve-private\n", operatorUid, operatorGid, 0o600),
    fsp.writeFile(signerPath, "previous-signer\n", { mode: 0o755 }),
    fsp.writeFile(signerStateDBPath, "preserve-signer-state\n", { mode: 0o600 }),
    fsp.writeFile(signerUnitPath, "ExecStart=previous-signer\n", { mode: 0o644 }),
    fsp.writeFile(controllerPaths.versionPath, `${previousVersion}\n`, { mode: 0o600 }),
  ]);

  const topology = Object.freeze({
    schemaVersion: 1,
    profile: "hosting",
    managedApplication: false,
    instanceId: null,
    stateDir,
    configPath,
    operator: Object.freeze({
      name: "fc",
      uid: operatorUid,
      gid: operatorGid,
      home: path.join(root, "operator"),
    }),
    gateway: Object.freeze({
      user: "fixture-gateway",
      uid: gatewayUid,
      unitPath: path.join(root, "systemd", "fased-gateway.service"),
    }),
    configGroup: Object.freeze({
      name: "fixture-config",
      gid: configGid,
    }),
    services: Object.freeze({
      gateway: "fixture-gateway.service",
      signer: "fixture-signer.service",
    }),
    capabilities: Object.freeze({
      lifecycleControllerProtocol: 2,
      signerProtocol: Object.freeze({ current: 2, min: 2, max: 2 }),
      declaredStateRegistry: 1,
    }),
    stateSchemas: Object.freeze({
      managedInstall: null,
      walletRegistry: null,
      signer: 2,
      mining: 1,
      federation: 2,
    }),
  });

  let activeSignerVersion = previousVersion;
  let gatewayStarts = 0;
  let signerStarts = 0;
  let injectedCrash = false;
  const createControllerContext = (selectedCrashPhase = null) =>
    controllerTesting.createTransactionContext({
      paths: controllerPaths,
      rootUid: 0,
      supervised: true,
      runningControllerVersion: targetVersion,
      controllerInstanceId: "33333333-3333-4333-8333-333333333333",
      historicalQ0TestStateDir: path.join(root, "historical-q0"),
      assertReleaseAllowed: async () => undefined,
      stageControllerRelease: async () => ({ changed: false }),
      stageCandidate: async (version, candidatePath) => {
        await fsp.writeFile(candidatePath, `signer-${version}\n`, { mode: 0o755 });
        return {
          release: signerRelease(version),
          binding: {
            manifestDigest: evidenceDigest("1"),
            signerArtifactDigest: evidenceDigest("2"),
            capabilitiesDigest: evidenceDigest("3"),
            releaseCommit: "a".repeat(40),
          },
        };
      },
      discoverApplicationTopology: async () => topology,
      stopSigner: async () => undefined,
      startSignerV2: async ({ expectedRelease }) => {
        signerStarts += 1;
        activeSignerVersion = expectedRelease.version;
        return {
          release: expectedRelease,
          invariant: "preserved-signer-state",
        };
      },
      startPreviousSigner: async () => {
        activeSignerVersion = previousVersion;
      },
      reloadUnits: async () => undefined,
      applyServiceBoundary: async () => undefined,
      restoreServiceBoundary: async () => undefined,
      startGateway: async () => {
        gatewayStarts += 1;
      },
      stopGateway: async () => undefined,
      restartGateway: async () => undefined,
      verifyGateway: async (version) => ({
        version,
        runtimeSource: "managed-package",
      }),
      probeSigner: async () => signerRelease(activeSignerVersion),
      probeSignerState: async () => ({
        release: signerRelease(activeSignerVersion),
        invariant: "preserved-signer-state",
      }),
      probeApplicationHealth: async () => ({
        wallet: { ok: true, evidenceDigest: evidenceDigest("4") },
        mining: { ok: true, evidenceDigest: evidenceDigest("5") },
        network: { ok: true, evidenceDigest: evidenceDigest("6") },
        plugins: { ok: true, evidenceDigest: evidenceDigest("7") },
      }),
      onDurablePhase: async (phase) => {
        if (!injectedCrash && selectedCrashPhase && phase === selectedCrashPhase) {
          injectedCrash = true;
          const error = new Error(`fixture crash after ${phase}`);
          error.code = "FASED_TEST_CRASH";
          throw error;
        }
      },
    });

  const controllerConfiguration = Object.freeze({
    profile: "hosting",
    instanceId: null,
    paths: controllerPaths,
    signerServiceName: "fixture-signer.service",
    gatewayServiceName: "fixture-gateway.service",
    signerApplicationSocketPath: path.join(root, "run", "signer.sock"),
    supervised: true,
    socketUid: 0,
    socketGid: 0,
  });
  const supervisorConfiguration = Object.freeze({
    profile: "hosting",
    instanceId: null,
    operatorUid: 0,
    operatorGid: 0,
    paths: supervisorPaths,
  });
  const supervisorContext = supervisorTesting.createContext(supervisorConfiguration, {
    rootUid: 0,
    rootGid: 0,
    stageTrustedController: async () => ({ changed: false }),
  });

  let controller = await startServer({
    configuration: controllerConfiguration,
    context: createControllerContext(crashPhase),
  });
  const supervisor = await startSupervisor({
    configuration: supervisorConfiguration,
    context: supervisorContext,
  });

  return {
    root,
    paths: controllerPaths,
    supervisorPaths,
    publicSocketPath,
    configPath,
    deviceAuthPath,
    unknownPath,
    stateDir,
    transactionId: randomUUID(),
    get gatewayStarts() {
      return gatewayStarts;
    },
    get signerStarts() {
      return signerStarts;
    },
    get injectedCrash() {
      return injectedCrash;
    },
    async restartController() {
      await controller.close();
      controller = await startServer({
        configuration: controllerConfiguration,
        context: createControllerContext(),
      });
    },
    async close() {
      await supervisor.close();
      await controller.close();
      await fsp.rm(root, { recursive: true, force: true });
    },
  };
}

async function assertCommittedFixture(fixture) {
  assert.equal(await fsp.readFile(fixture.paths.versionPath, "utf8"), `${targetVersion}\n`);
  assert.equal(await fsp.readFile(fixture.paths.signerPath, "utf8"), `signer-${targetVersion}\n`);
  assert.equal(
    await fsp.readFile(fixture.paths.signerStateDBPath, "utf8"),
    "preserve-signer-state\n",
  );
  assert.equal(
    await fsp.readFile(fixture.configPath, "utf8"),
    '{"fixtureSecret":"preserve-config"}\n', // pragma: allowlist secret
  );
  assert.equal(
    await fsp.readFile(fixture.deviceAuthPath, "utf8"),
    '{"fixtureSecret":"preserve-device-auth"}\n', // pragma: allowlist secret
  );
  assert.equal(await fsp.readFile(fixture.unknownPath, "utf8"), "preserve-private\n");
  assert.equal((await fsp.stat(fixture.stateDir)).mode & 0o7777, 0o2770);
  assert.equal((await fsp.stat(fixture.stateDir)).uid, operatorUid);
  assert.equal((await fsp.stat(fixture.stateDir)).gid, configGid);
  const unknown = await fsp.stat(fixture.unknownPath);
  assert.equal(unknown.mode & 0o7777, 0o600);
  assert.equal(unknown.uid, operatorUid);
  assert.equal(unknown.gid, operatorGid);
  assert.equal(fs.existsSync(fixture.paths.journalPath), false);
  assert.equal(fs.existsSync(fixture.paths.gatewayGatePath), false);
  assert.equal(fs.existsSync(fixture.paths.signerGatePath), false);

  const receiptPath = path.join(
    fixture.supervisorPaths.supervisorStateDir,
    "receipts",
    `${fixture.transactionId}.json`,
  );
  const receiptText = await fsp.readFile(receiptPath, "utf8");
  assert.equal(receiptText.includes("preserve-config"), false);
  assert.equal(receiptText.includes("preserve-device-auth"), false);
  assert.equal(receiptText.includes("preserve-private"), false);
  const receipt = JSON.parse(receiptText);
  assert.equal(typeof receipt.recordedAt, "string");
  assert.equal(Number.isNaN(Date.parse(receipt.recordedAt)), false);
  delete receipt.recordedAt;
  assert.deepEqual(receipt, {
    schemaVersion: 1,
    transactionId: fixture.transactionId,
    operation: "applyRelease",
    version: targetVersion,
    outcome: "committed",
    controllerChanged: false,
    phase: "committed",
    release: signerRelease(targetVersion),
  });
}

async function runCommittedFixture() {
  const fixture = await createRootFixture();
  try {
    const controller = await socketRequest(
      fixture.publicSocketPath,
      "updateController",
      fixture.transactionId,
    );
    assert.equal(controller.ok, true);
    const applied = await socketRequest(
      fixture.publicSocketPath,
      "applyRelease",
      fixture.transactionId,
    );
    assert.equal(applied.ok, true);
    assert.equal(applied.phase, "committed");
    await assertCommittedFixture(fixture);

    const replay = await socketRequest(
      fixture.publicSocketPath,
      "applyRelease",
      fixture.transactionId,
    );
    assert.equal(replay.ok, true);
    assert.equal(replay.replayed, true);
    assert.equal(replay.changed, false);
    assert.equal(fixture.signerStarts, 1);
  } finally {
    await fixture.close();
  }
}

async function runCrashRecoveryFixture() {
  const fixture = await createRootFixture({ crashPhase: "state-reconciled" });
  try {
    const failed = await socketRequest(
      fixture.publicSocketPath,
      "applyRelease",
      fixture.transactionId,
    );
    assert.equal(failed.ok, false);
    assert.match(failed.error, /fixture crash after state-reconciled/u);
    assert.equal(fixture.injectedCrash, true);
    assert.equal(fs.existsSync(fixture.paths.journalPath), true);

    await fixture.restartController();
    assert.equal(fs.existsSync(fixture.paths.journalPath), false);
    assert.equal(await fsp.readFile(fixture.paths.versionPath, "utf8"), `${previousVersion}\n`);
    assert.equal(await fsp.readFile(fixture.paths.signerPath, "utf8"), "previous-signer\n");
    assert.equal((await fsp.stat(fixture.stateDir)).mode & 0o7777, 0o700);

    const retried = await socketRequest(
      fixture.publicSocketPath,
      "applyRelease",
      fixture.transactionId,
    );
    assert.equal(retried.ok, true);
    assert.equal(retried.phase, "committed");
    await assertCommittedFixture(fixture);
  } finally {
    await fixture.close();
  }
}

if (typeof process.getuid !== "function" || process.getuid() !== 0) {
  throw new Error("root-capable lifecycle fixture must run as root or inside its user namespace");
}

await runCommittedFixture();
await runCrashRecoveryFixture();
process.stdout.write(
  `${JSON.stringify({
    schemaVersion: 1,
    fixture: "root-capable-supervisor-controller-update",
    cases: ["commit-replay", "cold-crash-rollback-retry"],
    ownerInstallationTouched: false,
    freshInfrastructureCreated: false,
    result: "PASS",
  })}\n`,
);
