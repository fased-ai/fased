#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer, __testing as controllerTesting } from "./fased-host-updater.mjs";
import {
  parseSupervisorRequest,
  startSupervisor,
  __testing as supervisorTesting,
} from "./fased-lifecycle-supervisor.mjs";

const previousVersion = "1.2.2";
const targetVersion = "1.2.3";
const operatorUid = 1000;
const operatorGid = 1000;
const gatewayUid = 1001;
const configGid = 1002;
const evidenceDigest = (character) => `sha256:${character.repeat(64)}`;
const sha256Text = (value) => createHash("sha256").update(value).digest("hex");

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

async function runExistingControllerGenerationTransitionFixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fased-controller-transition-"));
  const stateDir = path.join(root, "operator", ".fased");
  const controllerStateDir = path.join(root, "controller-state");
  const releasesDir = path.join(root, "controller", "releases");
  const currentLink = path.join(root, "controller", "current");
  const controllerVersionPath = path.join(controllerStateDir, "controller-version.json");
  const applicationRelease = path.join(root, "application", "releases", "v1.2.0");
  const applicationCurrent = path.join(root, "application", "current");
  const incompleteUpdater = path.join(stateDir, "updater", "fased-managed-updater.mjs");
  const targetSupervisorPath = fileURLToPath(
    new URL("./fased-lifecycle-supervisor.mjs", import.meta.url),
  );
  const supervisorPath = path.join(root, "supervisor", "fased-lifecycle-supervisor.mjs");
  const targetServerPath = fileURLToPath(new URL("./fased-host-updater.mjs", import.meta.url));
  const targetClientPath = fileURLToPath(new URL("./fased-host-updaterctl.mjs", import.meta.url));
  const paths = {
    publicSocketPath: path.join(root, "run", "request.sock"),
    privateSocketPath: path.join(root, "run", "controller.sock"),
    stateDir: controllerStateDir,
    supervisorStateDir: path.join(controllerStateDir, "supervisor"),
    releasesDir,
    currentLink,
    controllerVersionPath,
    rollbackFloorPath: path.join(controllerStateDir, "supervisor", "rollback-floor"),
    trustedRootPath: path.join(controllerStateDir, "supervisor", "trusted-root.json"),
    trustStatePath: path.join(controllerStateDir, "supervisor", "trust-state.json"),
    supervisorTransactionPath: path.join(
      controllerStateDir,
      "supervisor",
      "controller-transaction.json",
    ),
    channelPath: path.join(root, "channel"),
    supervisorPath,
    controllerUnit: "fixture-controller.service",
    supervisorUnit: "fixture-supervisor.service",
  };

  try {
    const previousServer = "previous-controller-server\n";
    const previousClient = "previous-controller-client\n";
    const previousIdentity = {
      schemaVersion: 1,
      version: previousVersion,
      serverSha256: sha256Text(previousServer),
      clientSha256: sha256Text(previousClient),
    };
    const previousGeneration = path.join(releasesDir, `v${previousVersion}`);
    await Promise.all([
      fsp.mkdir(previousGeneration, { recursive: true, mode: 0o755 }),
      fsp.mkdir(applicationRelease, { recursive: true, mode: 0o755 }),
      fsp.mkdir(path.dirname(incompleteUpdater), { recursive: true, mode: 0o700 }),
      fsp.mkdir(path.dirname(paths.channelPath), { recursive: true, mode: 0o755 }),
      fsp.mkdir(path.dirname(supervisorPath), { recursive: true, mode: 0o755 }),
    ]);
    await Promise.all([
      fsp.writeFile(path.join(previousGeneration, "fased-host-updater.mjs"), previousServer, {
        mode: 0o644,
      }),
      fsp.writeFile(path.join(previousGeneration, "fased-host-updaterctl.mjs"), previousClient, {
        mode: 0o644,
      }),
      fsp.writeFile(path.join(applicationRelease, "package.json"), '{"version":"1.2.0"}\n'),
      fsp.writeFile(incompleteUpdater, 'import "./missing-support.mjs";\n', { mode: 0o700 }),
      fsp.writeFile(paths.channelPath, "beta\n"),
      fsp.writeFile(supervisorPath, "previous-lifecycle-supervisor\n", { mode: 0o755 }),
      fsp.mkdir(path.dirname(controllerVersionPath), { recursive: true, mode: 0o700 }),
    ]);
    await Promise.all([
      fsp.symlink(previousGeneration, currentLink, "dir"),
      fsp.symlink(applicationRelease, applicationCurrent, "dir"),
      fsp.writeFile(controllerVersionPath, `${JSON.stringify(previousIdentity, null, 2)}\n`, {
        mode: 0o600,
      }),
    ]);
    const applicationDigest = sha256Text(await fsp.readFile(incompleteUpdater, "utf8"));

    const targetSupervisor = await fsp.readFile(targetSupervisorPath, "utf8");
    const targetServer = await fsp.readFile(targetServerPath, "utf8");
    const targetClient = await fsp.readFile(targetClientPath, "utf8");
    const verifier = "fixture-evidence-verifier\n";
    const metadata = {
      schemaVersion: 1,
      role: "fased-lifecycle-targets",
      rootPolicy: supervisorTesting.INITIAL_LIFECYCLE_ROOT_ENVELOPE,
      release: { version: targetVersion, tag: `v${targetVersion}`, commit: "a".repeat(40) },
      validity: {
        issuedAt: "2026-07-28T00:00:00.000Z",
        expiresAt: "2027-07-28T00:00:00.000Z",
      },
      policy: {
        channels: ["beta", "stable"],
        platforms: ["linux-arm64", "linux-x64"],
        supervisorProtocol: 1,
        controllerProtocol: 2,
      },
      targets: {
        bootstrap: { asset: "install.sh", sha256: "d".repeat(64) },
        supervisor: {
          asset: "fased-lifecycle-supervisor.mjs",
          sha256: sha256Text(targetSupervisor),
        },
        controllerServer: {
          asset: "fased-host-updater.mjs",
          sha256: sha256Text(targetServer),
        },
        controllerClient: {
          asset: "fased-host-updaterctl.mjs",
          sha256: sha256Text(targetClient),
        },
        evidenceVerifier: {
          asset: "fased-privileged-release-evidence.mjs",
          sha256: sha256Text(verifier),
        },
      },
      evidence: {
        provenance: {
          asset: "fased-privileged-provenance-v1.intoto.json",
          sha256: "f".repeat(64),
        },
        sbom: { asset: "fased-privileged-sbom-v1.spdx.json", sha256: "1".repeat(64) },
        vex: { asset: "fased-privileged-vex-v1.openvex.json", sha256: "2".repeat(64) },
      },
    };
    const downloads = new Map([
      ["fased-lifecycle-trust-v1.json", `${JSON.stringify(metadata)}\n`],
      ["fased-lifecycle-trust-v1.json.attestation.json", "{}\n"],
      ["fased-lifecycle-supervisor.mjs", targetSupervisor],
      ["fased-host-updater.mjs", targetServer],
      ["fased-host-updaterctl.mjs", targetClient],
      ["fased-privileged-release-evidence.mjs", verifier],
      ["fased-hosted-release-v2.json", "{}\n"],
      ["fased-privileged-provenance-v1.intoto.json", "{}\n"],
      ["fased-privileged-provenance-v1.intoto.json.attestation.json", "{}\n"],
      ["fased-privileged-sbom-v1.spdx.json", "{}\n"],
      ["fased-privileged-vex-v1.openvex.json", "{}\n"],
    ]);
    const previousSupervisorDigest = sha256Text(await fsp.readFile(supervisorPath, "utf8"));
    let restartCount = 0;
    const context = supervisorTesting.createContext(
      {
        profile: "protected-local",
        instanceId: "0123456789abcdef",
        operatorUid,
        operatorGid,
        paths,
      },
      {
        rootUid: 0,
        rootGid: 0,
        platform: "linux-x64",
        now: () => Date.parse("2026-07-30T00:00:00.000Z"),
        verifyMetadata: async () => undefined,
        verifyReleaseEvidence: async () => undefined,
        selfCheckController: async () => undefined,
        runningSupervisorDigest: previousSupervisorDigest,
        download: async (url, destination) => {
          const name = url.slice(url.lastIndexOf("/") + 1);
          const body = downloads.get(name);
          assert.notEqual(body, undefined, `unexpected fixture asset ${name}`);
          await fsp.writeFile(destination, body);
        },
        restartController: async () => {
          restartCount += 1;
          if (restartCount === 1) {
            throw new Error("injected target controller restart failure");
          }
        },
        waitForController: async () => undefined,
        probeControllerIdentity: async (request) => {
          const selected = await fsp.realpath(currentLink);
          const identity = JSON.parse(await fsp.readFile(controllerVersionPath, "utf8"));
          assert.equal(selected, path.join(releasesDir, `v${request.version}`));
          assert.equal(identity.version, request.version);
          return "44444444-4444-4444-8444-444444444444";
        },
      },
    );
    const state = { controllerInstanceId: "33333333-3333-4333-8333-333333333333" };
    const transitionRequest = () =>
      parseSupervisorRequest({
        schemaVersion: 2,
        op: "updateController",
        transactionId: randomUUID(),
        version: targetVersion,
      });

    await assert.rejects(
      supervisorTesting.handleSupervisorRequest(transitionRequest(), context, state),
      /controller promotion failed and was restored: injected target controller restart failure/u,
    );
    assert.equal(await fsp.realpath(currentLink), previousGeneration);
    assert.deepEqual(
      JSON.parse(await fsp.readFile(controllerVersionPath, "utf8")),
      previousIdentity,
    );
    assert.equal(fs.existsSync(paths.supervisorTransactionPath), false);
    assert.equal(sha256Text(await fsp.readFile(supervisorPath, "utf8")), previousSupervisorDigest);
    assert.equal(await fsp.realpath(applicationCurrent), applicationRelease);
    assert.equal(sha256Text(await fsp.readFile(incompleteUpdater, "utf8")), applicationDigest);

    const retried = await supervisorTesting.handleSupervisorRequest(
      transitionRequest(),
      context,
      state,
    );
    assert.equal(retried.ok, true);
    assert.equal(retried.controllerChanged, true);
    assert.equal(await fsp.realpath(currentLink), path.join(releasesDir, `v${targetVersion}`));
    assert.equal(
      JSON.parse(await fsp.readFile(controllerVersionPath, "utf8")).version,
      targetVersion,
    );
    assert.equal(
      sha256Text(await fsp.readFile(supervisorPath, "utf8")),
      sha256Text(targetSupervisor),
    );
    context.runningSupervisorDigest = sha256Text(targetSupervisor);
    assert.equal(await fsp.realpath(applicationCurrent), applicationRelease);
    assert.equal(sha256Text(await fsp.readFile(incompleteUpdater, "utf8")), applicationDigest);

    const idempotent = await supervisorTesting.handleSupervisorRequest(
      transitionRequest(),
      context,
      state,
    );
    assert.equal(idempotent.ok, true);
    assert.equal(idempotent.controllerChanged, false);
    assert.equal(idempotent.supervisorChanged, false);
    assert.equal(restartCount, 3);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
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
  const activeControllerRoot = path.join(
    controllerPaths.controllerReleasesDir,
    `v${targetVersion}`,
  );
  const historicalControllerCandidate = path.join(
    controllerPaths.controllerReleasesDir,
    `v${previousVersion}.q0.${"a".repeat(12)}`,
  );

  await Promise.all([
    fsp.mkdir(controllerStateDir, { recursive: true, mode: 0o700 }),
    fsp.mkdir(path.dirname(signerPath), { recursive: true, mode: 0o755 }),
    fsp.mkdir(path.dirname(signerStateDBPath), { recursive: true, mode: 0o700 }),
    fsp.mkdir(path.dirname(signerUnitPath), { recursive: true, mode: 0o755 }),
    fsp.mkdir(identityDir, { recursive: true, mode: 0o700 }),
    fsp.mkdir(activeControllerRoot, { recursive: true, mode: 0o755 }),
    fsp.mkdir(historicalControllerCandidate, { recursive: true, mode: 0o755 }),
  ]);
  for (const generation of [activeControllerRoot, historicalControllerCandidate]) {
    await Promise.all([
      fsp.writeFile(path.join(generation, "fased-host-updater.mjs"), "fixture server\n", {
        mode: 0o644,
      }),
      fsp.writeFile(path.join(generation, "fased-host-updaterctl.mjs"), "fixture client\n", {
        mode: 0o644,
      }),
    ]);
  }
  await fsp.symlink(activeControllerRoot, controllerPaths.controllerCurrentLink, "dir");
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
      stageControllerRelease: async () => {
        const error = new Error("supervised controller attempted forbidden controller staging");
        error.code = "EROFS";
        throw error;
      },
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
        signerIsolation: { ok: true, evidenceDigest: evidenceDigest("8") },
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
    historicalControllerCandidate,
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
    assert.equal(fs.existsSync(fixture.historicalControllerCandidate), false);
    const applied = await socketRequest(
      fixture.publicSocketPath,
      "applyRelease",
      fixture.transactionId,
    );
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.phase, "committed");
    assert.equal(applied.schemaMigration?.applied, true);
    assert.match(applied.schemaMigration?.planDigest || "", /^sha256:[a-f0-9]{64}$/u);
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
  const fixture = await createRootFixture({ crashPhase: "schema-ready" });
  try {
    const failed = await socketRequest(
      fixture.publicSocketPath,
      "applyRelease",
      fixture.transactionId,
    );
    assert.equal(failed.ok, false);
    assert.match(failed.error, /fixture crash after schema-ready/u);
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
await runExistingControllerGenerationTransitionFixture();
process.stdout.write(
  `${JSON.stringify({
    schemaVersion: 1,
    fixture: "root-capable-supervisor-controller-update",
    cases: [
      "commit-replay",
      "cold-crash-rollback-retry",
      "existing-supervisor-and-controller-a-to-b-rollback-retry-idempotence",
    ],
    ownerInstallationTouched: false,
    freshInfrastructureCreated: false,
    result: "PASS",
  })}\n`,
);
