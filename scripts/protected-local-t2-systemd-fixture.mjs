#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { buildProtectedLocalLayout } from "./protected-local-layout.mjs";
import { buildProtectedLocalServicePlan } from "./protected-local-service-plan.mjs";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const selfPath = fileURLToPath(import.meta.url);
const previousVersion = "1.2.2";
const targetVersion = "1.2.3";
const instancePattern = /^[a-f0-9]{16}$/u;

function fail(message) {
  throw new Error(message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(filePath) {
  return sha256(await fsp.readFile(filePath));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: options.timeout ?? 30_000,
    env: options.env ?? process.env,
    cwd: options.cwd,
    uid: options.uid,
    gid: options.gid,
  });
  if (result.error) {
    if (options.allowFailure) {
      return result;
    }
    throw result.error;
  }
  if (!options.allowFailure && result.status !== 0) {
    fail(
      `${command} ${args.join(" ")} failed (${result.status}): ${result.stderr || result.stdout}`,
    );
  }
  return result;
}

function systemctl(...args) {
  return run("/usr/bin/systemctl", args, { timeout: 30_000 });
}

async function waitFor(check, message, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  fail(message);
}

async function waitForSocket(socketPath) {
  await waitFor(async () => {
    try {
      const info = await fsp.lstat(socketPath);
      return info.isSocket() && !info.isSymbolicLink();
    } catch {
      return false;
    }
  }, `T2 socket did not become ready: ${socketPath}`);
}

async function waitForService(unit) {
  await waitFor(
    () =>
      run("/usr/bin/systemctl", ["is-active", "--quiet", unit], { allowFailure: true }).status ===
      0,
    `T2 systemd unit did not become active: ${unit}`,
  );
}

async function socketRequest(socketPath, op, transactionId, version) {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    socket.setEncoding("utf8");
    socket.setTimeout(20_000);
    let body = "";
    let settled = false;
    const failRequest = (error) => {
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
          schemaVersion: 3,
          op,
          transactionId,
          nonce: randomUUID(),
          version,
          clientCapabilities: { protocolVersion: 2, requestSchema: 3 },
        })}\n`,
      );
    });
    socket.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > 64 * 1024) {
        failRequest(new Error("T2 supervisor response exceeded its bound"));
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
        failRequest(error);
      }
    });
    socket.once("timeout", () => failRequest(new Error(`T2 ${op} request timed out`)));
    socket.once("error", failRequest);
    socket.once("close", () => {
      if (!settled) {
        failRequest(new Error(`T2 ${op} request closed without a response`));
      }
    });
  });
}

function operatorIdentity() {
  const info = fs.statSync(sourceRoot);
  if (info.uid <= 0 || info.gid <= 0) {
    fail("T2 requires the checkout to belong to its non-root operator");
  }
  const passwd = run("/usr/bin/getent", ["passwd", String(info.uid)]).stdout.trim();
  const fields = passwd.split(":");
  const home = fields[5];
  if (
    fields.length < 7 ||
    !/^[A-Za-z_][A-Za-z0-9_.-]{0,30}$/u.test(fields[0]) ||
    !path.isAbsolute(home) ||
    path.resolve(home) !== home
  ) {
    fail("T2 could not resolve the checkout owner account");
  }
  return Object.freeze({ user: fields[0], uid: info.uid, gid: info.gid, home });
}

async function createRootFixtureRoot(instanceId) {
  const parent = "/var/lib";
  const parentInfo = await fsp.lstat(parent);
  if (
    !parentInfo.isDirectory() ||
    parentInfo.isSymbolicLink() ||
    parentInfo.uid !== 0 ||
    (parentInfo.mode & 0o022) !== 0
  ) {
    fail("T2 fixture parent must be a root-owned non-writable real directory");
  }
  const fixtureRoot = await fsp.mkdtemp(path.join(parent, `.fased-t2-${instanceId}-`));
  try {
    await fsp.chmod(fixtureRoot, 0o700);
    const info = await fsp.lstat(fixtureRoot);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== 0 ||
      (info.mode & 0o077) !== 0
    ) {
      fail("T2 fixture root is not an exclusive root-owned directory");
    }
    return fixtureRoot;
  } catch (error) {
    await fsp.rm(fixtureRoot, { recursive: true, force: true });
    throw error;
  }
}

async function writeOwnedFile(filePath, contents, uid, gid, mode) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fsp.writeFile(filePath, contents, { mode });
  await fsp.chown(filePath, uid, gid);
  await fsp.chmod(filePath, mode);
}

async function requestAsOperator(operator, socketPath, op, transactionId, version) {
  const result = run(
    "/usr/bin/node",
    [selfPath, "request", socketPath, op, transactionId, version],
    { uid: operator.uid, gid: operator.gid, timeout: 30_000 },
  );
  return JSON.parse(result.stdout);
}

async function requestMain() {
  const [, , , socketPath, op, transactionId, version] = process.argv;
  const response = await socketRequest(socketPath, op, transactionId, version);
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

async function runFixture() {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) {
    fail("minimal T2 generated-unit fixture must run as root");
  }
  if (!fs.existsSync("/run/systemd/system") || !fs.existsSync("/usr/bin/systemctl")) {
    fail("minimal T2 generated-unit fixture requires the current host systemd manager");
  }

  const startedAt = Date.now();
  const operator = operatorIdentity();
  const instanceId = sha256(`${process.pid}:${randomUUID()}`).slice(0, 16);
  assert.match(instanceId, instancePattern);
  const layout = buildProtectedLocalLayout(instanceId);
  const appRoot = path.join(operator.home, ".fased-t2", instanceId);
  const appStateDir = path.join(appRoot, ".fased");
  const applicationRelease = path.join(layout.applicationReleasesDir, `v${previousVersion}`);
  const t2Lib = path.join(layout.installDir, "t2-lib");
  const channelRoot = `/etc/fased/local/${instanceId}`;
  const controllerDropIn = `/etc/systemd/system/${layout.controllerUnit}.d`;
  const supervisorDropIn = `/etc/systemd/system/${layout.supervisorUnit}.d`;
  const registryOverride = path.join(supervisorDropIn, "90-t2-registry.conf");
  const failureScript = `/usr/local/libexec/fased-t2-controller-fail-${instanceId}`;
  const failureOverride = path.join(controllerDropIn, "99-t2-fail-once.conf");
  const failureMarker = path.join(layout.controllerStateDir, "t2-fail-once");
  const forbiddenStageMarker = path.join(layout.supervisorStateDir, "t2-forbidden-stage");
  const fixturePath = path.join(layout.controllerStateDir, "t2-fixture.json");
  const productIdentityPath = path.join(layout.controllerStateDir, "controller-version.json");
  const supervisorIdentityPath = path.join(layout.supervisorStateDir, "controller-version.json");
  const productVersionPath = path.join(layout.controllerStateDir, "signer-version");
  const supervisorTransactionPath = path.join(
    layout.supervisorStateDir,
    "controller-transaction.json",
  );
  const rootProductTransactionPath = path.join(
    layout.supervisorStateDir,
    "product-transaction.json",
  );
  const publicSocket = `/run/fased-local-controller/${instanceId}/request.sock`;
  const privateSocket = `/run/fased-local-controller-worker/${instanceId}/controller.sock`;
  const gatewayUid = 61001;
  const signerUid = 61002;
  const gatewayGid = 62001;
  const configGid = 62002;
  const plan = buildProtectedLocalServicePlan({
    instanceId,
    operatorUid: operator.uid,
    operatorUser: operator.user,
    operatorHome: operator.home,
    appStateDir,
    repoDir: layout.applicationCurrentLink,
    gatewayUid,
    signerUid,
    gatewayGid,
    operatorGid: operator.gid,
    nodeBinary: "/usr/bin/node",
  });
  const installedUnits = [plan.files.controllerUnit, plan.files.supervisorUnit];
  const fixedPaths = [
    layout.installDir,
    layout.stateDir,
    channelRoot,
    controllerDropIn,
    supervisorDropIn,
    failureScript,
    `/run/fased-local/${instanceId}`,
    `/run/fased-local-controller/${instanceId}`,
    `/run/fased-local-controller-worker/${instanceId}`,
    ...installedUnits.map((unit) => unit.path),
  ];
  for (const fixedPath of fixedPaths) {
    if (fs.existsSync(fixedPath)) {
      fail(`T2 refuses to overwrite an existing path: ${fixedPath}`);
    }
  }
  const fixtureRoot = await createRootFixtureRoot(instanceId);
  const fixtureHome = path.join(fixtureRoot, "operator-home");
  const physicalAppRoot = path.join(fixtureHome, ".fased-t2", instanceId);
  const physicalAppStateDir = path.join(physicalAppRoot, ".fased");
  const registryRoot = path.join(fixtureRoot, "registry");
  const registryPath = path.join(registryRoot, "instances.json");
  let cleanupStarted = false;

  const cleanup = async () => {
    if (cleanupStarted) {
      return;
    }
    cleanupStarted = true;
    for (const unit of [layout.supervisorUnit, layout.controllerUnit]) {
      run("/usr/bin/systemctl", ["stop", unit], { allowFailure: true, timeout: 20_000 });
      run("/usr/bin/systemctl", ["reset-failed", unit], { allowFailure: true });
    }
    try {
      await Promise.all([
        ...installedUnits.map((unit) => fsp.rm(unit.path, { force: true })),
        fsp.rm(controllerDropIn, { recursive: true, force: true }),
        fsp.rm(supervisorDropIn, { recursive: true, force: true }),
        fsp.rm(failureScript, { force: true }),
        fsp.rm(layout.installDir, { recursive: true, force: true }),
        fsp.rm(layout.stateDir, { recursive: true, force: true }),
        fsp.rm(fixtureRoot, { recursive: true, force: true }),
        fsp.rm(channelRoot, { recursive: true, force: true }),
        fsp.rm(`/run/fased-local/${instanceId}`, { recursive: true, force: true }),
        fsp.rm(`/run/fased-local-controller/${instanceId}`, { recursive: true, force: true }),
        fsp.rm(`/run/fased-local-controller-worker/${instanceId}`, {
          recursive: true,
          force: true,
        }),
      ]);
    } finally {
      run("/usr/bin/systemctl", ["daemon-reload"], { allowFailure: true });
    }
  };

  const onSignal = (signal) => {
    void cleanup().finally(() => process.kill(process.pid, signal));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    const previousGeneration = path.join(
      layout.installDir,
      "controller",
      "releases",
      `v${previousVersion}`,
    );
    const targetGeneration = path.join(
      layout.installDir,
      "controller",
      "releases",
      `v${targetVersion}`,
    );
    await Promise.all([
      fsp.mkdir(previousGeneration, { recursive: true, mode: 0o755 }),
      fsp.mkdir(targetGeneration, { recursive: true, mode: 0o755 }),
      fsp.mkdir(t2Lib, { recursive: true, mode: 0o755 }),
      fsp.mkdir(layout.supervisorStateDir, { recursive: true, mode: 0o700 }),
      fsp.mkdir(layout.signerStateDir, { recursive: true, mode: 0o700 }),
      fsp.mkdir(applicationRelease, { recursive: true, mode: 0o755 }),
      fsp.mkdir(physicalAppStateDir, { recursive: true, mode: 0o700 }),
      fsp.mkdir(registryRoot, { recursive: true, mode: 0o700 }),
      fsp.mkdir(controllerDropIn, { recursive: true, mode: 0o755 }),
      fsp.mkdir(supervisorDropIn, { recursive: true, mode: 0o755 }),
      fsp.mkdir(channelRoot, { recursive: true, mode: 0o755 }),
      fsp.mkdir(path.dirname(failureScript), { recursive: true, mode: 0o755 }),
    ]);
    await Promise.all([
      fsp.writeFile(
        registryPath,
        `${JSON.stringify(
          {
            schemaVersion: 1,
            instances: [
              {
                instanceId,
                operatorUid: operator.uid,
                operatorUser: operator.user,
                profile: "t2-generated-unit",
                stateDir: appStateDir,
                createdAt: new Date().toISOString(),
              },
            ],
          },
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      ),
      fsp.writeFile(
        registryOverride,
        `[Service]\nBindReadOnlyPaths=${registryRoot}:/var/lib/fased-local-registry ${fixtureHome}:${operator.home}\n`,
        { mode: 0o644 },
      ),
      fsp.writeFile(
        path.join(controllerDropIn, "90-t2-home.conf"),
        `[Service]\nBindPaths=${fixtureHome}:${operator.home}\n`,
        { mode: 0o644 },
      ),
    ]);

    const controllerWorker = path.join(
      sourceRoot,
      "scripts",
      "protected-local-t2-controller-worker.mjs",
    );
    const supervisorWorker = path.join(
      sourceRoot,
      "scripts",
      "protected-local-t2-supervisor-worker.mjs",
    );
    const controllerClient = path.join(sourceRoot, "scripts", "fased-host-updaterctl.mjs");
    for (const generation of [previousGeneration, targetGeneration]) {
      await Promise.all([
        fsp.copyFile(controllerWorker, path.join(generation, "fased-host-updater.mjs")),
        fsp.copyFile(controllerClient, path.join(generation, "fased-host-updaterctl.mjs")),
      ]);
      await Promise.all([
        fsp.chown(path.join(generation, "fased-host-updater.mjs"), 0, 0),
        fsp.chown(path.join(generation, "fased-host-updaterctl.mjs"), 0, 0),
        fsp.chmod(path.join(generation, "fased-host-updater.mjs"), 0o644),
        fsp.chmod(path.join(generation, "fased-host-updaterctl.mjs"), 0o644),
      ]);
    }
    await Promise.all([
      fsp.copyFile(
        path.join(sourceRoot, "scripts", "fased-host-updater.mjs"),
        path.join(t2Lib, "fased-host-updater-production.mjs"),
      ),
      fsp.copyFile(
        path.join(sourceRoot, "scripts", "fased-lifecycle-supervisor.mjs"),
        path.join(t2Lib, "fased-lifecycle-supervisor-production.mjs"),
      ),
      fsp.mkdir(path.dirname(layout.supervisorBinary), { recursive: true, mode: 0o700 }),
    ]);
    await fsp.copyFile(supervisorWorker, layout.supervisorBinary);
    await fsp.chmod(layout.supervisorBinary, 0o755);
    await Promise.all([
      fsp.writeFile(path.join(layout.installDir, "signer-owner"), "T2 fixture\n", { mode: 0o644 }),
      fsp.writeFile(path.join(layout.installDir, "operator-socket-finalize"), "#!/bin/true\n", {
        mode: 0o755,
      }),
      fsp.writeFile(
        path.join(applicationRelease, "package.json"),
        `${JSON.stringify({ version: previousVersion })}\n`,
        { mode: 0o644 },
      ),
      fsp.writeFile(path.join(applicationRelease, "t2-runtime"), "preserve-runtime\n", {
        mode: 0o644,
      }),
    ]);
    await fsp.symlink(
      previousGeneration,
      path.join(layout.installDir, "controller", "current"),
      "dir",
    );
    await fsp.symlink(applicationRelease, layout.applicationCurrentLink, "dir");

    const previousIdentity = Object.freeze({
      schemaVersion: 1,
      version: previousVersion,
      serverSha256: await sha256File(path.join(previousGeneration, "fased-host-updater.mjs")),
      clientSha256: await sha256File(path.join(previousGeneration, "fased-host-updaterctl.mjs")),
    });
    const releaseCommit = run("/usr/bin/git", ["rev-parse", "HEAD"], {
      cwd: sourceRoot,
    }).stdout.trim();
    assert.match(releaseCommit, /^[a-f0-9]{40}$/u);
    const fixture = Object.freeze({
      schemaVersion: 1,
      instanceId,
      previousVersion,
      targetVersion,
      releaseCommit,
      targetManifestSha256: sha256(`t2:${releaseCommit}:${targetVersion}`),
      operatorUser: operator.user,
      operatorUid: operator.uid,
      operatorGid: operator.gid,
      operatorHome: operator.home,
      appStateDir,
      gatewayUid,
      configGid,
      forbiddenStageMarker,
    });
    await Promise.all([
      fsp.writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`, { mode: 0o600 }),
      fsp.writeFile(productIdentityPath, `${JSON.stringify(previousIdentity, null, 2)}\n`, {
        mode: 0o600,
      }),
      fsp.writeFile(supervisorIdentityPath, `${JSON.stringify(previousIdentity, null, 2)}\n`, {
        mode: 0o600,
      }),
      fsp.writeFile(productVersionPath, `${previousVersion}\n`, { mode: 0o600 }),
      fsp.writeFile(path.join(channelRoot, "update-channel"), "beta\n", { mode: 0o600 }),
    ]);

    const preservedPaths = Object.freeze({
      walletRegistry: path.join(physicalAppStateDir, "wallet", "provider-registry.v1.json"),
      policyRpc: path.join(physicalAppStateDir, "wallet", "wallet-policy-state.v1.json"),
      signerDatabase: path.join(layout.signerStateDir, "state.db"),
      signerMasterKey: path.join(layout.signerStateDir, "master.key"),
      miningLedger: path.join(
        physicalAppStateDir,
        "sat-mining",
        "wallets",
        "agent",
        "mining.sqlite",
      ),
      networkIdentity: path.join(physicalAppStateDir, "federation", "access-token.json"),
      pluginState: path.join(physicalAppStateDir, "extensions", "t2-plugin-state.json"),
    });
    await Promise.all([
      writeOwnedFile(
        path.join(physicalAppStateDir, "fased.json"),
        '{"gateway":{"mode":"local"}}\n',
        operator.uid,
        operator.gid,
        0o600,
      ),
      writeOwnedFile(
        preservedPaths.walletRegistry,
        '{"schemaVersion":1,"wallets":[{"id":"agent","handle":"@wallet:agent"}]}\n',
        operator.uid,
        operator.gid,
        0o600,
      ),
      writeOwnedFile(
        preservedPaths.policyRpc,
        '{"schemaVersion":1,"rpc":"fixture-rpc","policy":"agent"}\n',
        operator.uid,
        operator.gid,
        0o600,
      ),
      writeOwnedFile(preservedPaths.signerDatabase, "preserve-signer-state\n", 0, 0, 0o600),
      writeOwnedFile(preservedPaths.signerMasterKey, "preserve-master-key\n", 0, 0, 0o600),
      writeOwnedFile(
        preservedPaths.networkIdentity,
        '{"schemaVersion":1,"handle":"@fased:t2"}\n',
        operator.uid,
        operator.gid,
        0o600,
      ),
      writeOwnedFile(
        preservedPaths.pluginState,
        '{"schemaVersion":1,"enabled":["t2"]}\n',
        operator.uid,
        operator.gid,
        0o600,
      ),
    ]);
    await fsp.mkdir(path.dirname(preservedPaths.miningLedger), { recursive: true, mode: 0o700 });
    const mining = new DatabaseSync(preservedPaths.miningLedger);
    try {
      mining.exec(
        "CREATE TABLE mining_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);" +
          "INSERT INTO mining_meta(key,value) VALUES('schema_version','1'),('history_revision','7');",
      );
    } finally {
      mining.close();
    }
    await fsp.chown(preservedPaths.miningLedger, operator.uid, operator.gid);
    await fsp.chmod(preservedPaths.miningLedger, 0o600);
    const beforeDigests = Object.freeze(
      Object.fromEntries(
        await Promise.all(
          Object.entries(preservedPaths).map(async ([name, filePath]) => [
            name,
            await sha256File(filePath),
          ]),
        ),
      ),
    );

    for (const unit of installedUnits) {
      await fsp.writeFile(unit.path, unit.content, { mode: unit.mode });
      await fsp.chmod(unit.path, unit.mode);
    }
    systemctl("daemon-reload");
    systemctl("start", layout.controllerUnit);
    await waitForService(layout.controllerUnit);
    await waitForSocket(privateSocket);
    systemctl("start", layout.supervisorUnit);
    await waitForService(layout.supervisorUnit);
    await waitForSocket(publicSocket);
    const socketInfo = await fsp.stat(publicSocket);
    assert.equal(socketInfo.uid, operator.uid);
    assert.equal(socketInfo.gid, operator.gid);
    assert.equal(socketInfo.mode & 0o777, 0o600);

    await fsp.writeFile(
      failureScript,
      `#!/usr/bin/env bash\nset -euo pipefail\nmarker=${failureMarker}\nif [[ -f "$marker" ]]; then rm -f -- "$marker"; exit 72; fi\n`,
      { mode: 0o755 },
    );
    await fsp.writeFile(failureOverride, `[Service]\nExecStartPre=${failureScript}\n`, {
      mode: 0o644,
    });
    await fsp.writeFile(failureMarker, "fail once\n", { mode: 0o600 });
    systemctl("daemon-reload");
    const transactionId = randomUUID();
    const failed = await requestAsOperator(
      operator,
      publicSocket,
      "updateController",
      transactionId,
      targetVersion,
    );
    assert.equal(failed.ok, false, JSON.stringify(failed));
    assert.match(failed.error, /controller promotion failed and was restored/u);
    await waitForService(layout.controllerUnit);
    await waitForService(layout.supervisorUnit);
    assert.equal(
      await fsp.realpath(path.join(layout.installDir, "controller", "current")),
      previousGeneration,
    );
    assert.equal(
      JSON.parse(await fsp.readFile(supervisorIdentityPath, "utf8")).version,
      previousVersion,
    );
    assert.equal(fs.existsSync(supervisorTransactionPath), false);
    assert.equal(fs.existsSync(rootProductTransactionPath), false);
    assert.equal(fs.existsSync(failureMarker), false);

    await Promise.all([
      fsp.rm(failureOverride, { force: true }),
      fsp.rm(failureScript, { force: true }),
    ]);
    systemctl("daemon-reload");
    run("/usr/bin/systemctl", ["reset-failed", layout.controllerUnit], { allowFailure: true });
    const applied = await requestAsOperator(
      operator,
      publicSocket,
      "updateController",
      transactionId,
      targetVersion,
    );
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.controllerChanged, true);
    const idempotent = await requestAsOperator(
      operator,
      publicSocket,
      "updateController",
      transactionId,
      targetVersion,
    );
    assert.equal(idempotent.ok, true, JSON.stringify(idempotent));
    assert.equal(idempotent.controllerChanged, false);
    await waitForService(layout.controllerUnit);
    assert.equal(
      await fsp.realpath(path.join(layout.installDir, "controller", "current")),
      targetGeneration,
    );
    assert.equal(
      JSON.parse(await fsp.readFile(supervisorIdentityPath, "utf8")).version,
      targetVersion,
    );
    assert.equal(fs.existsSync(supervisorTransactionPath), false);
    assert.equal(fs.existsSync(forbiddenStageMarker), false);

    const receiptPath = path.join(
      layout.supervisorStateDir,
      "controller-selections",
      transactionId,
      `${idempotent.selectionDigest}.json`,
    );
    const receipt = JSON.parse(await fsp.readFile(receiptPath, "utf8"));
    assert.equal(receipt.transactionId, transactionId);
    assert.equal(receipt.version, targetVersion);
    assert.equal(receipt.releaseCommit, releaseCommit);
    assert.equal(receipt.selectionDigest, idempotent.selectionDigest);
    assert.deepEqual(receipt.protocolCapabilities, {
      controllerProtocol: 2,
      requestSchema: 2,
      supervisorProtocol: 1,
    });

    const controllerPid = Number(
      systemctl("show", "--property=MainPID", "--value", layout.controllerUnit).stdout.trim(),
    );
    assert.ok(Number.isSafeInteger(controllerPid) && controllerPid > 1);
    for (const forbiddenPath of [
      path.join(layout.installDir, "controller", "t2-forbidden-write"),
      path.join(controllerDropIn, "t2-forbidden.conf"),
      path.join(supervisorDropIn, "t2-forbidden.conf"),
      path.join(layout.supervisorStateDir, "t2-forbidden-state"),
    ]) {
      const denied = run(
        "/usr/bin/nsenter",
        ["--target", String(controllerPid), "--mount", "--", "/usr/bin/touch", forbiddenPath],
        { allowFailure: true },
      );
      assert.notEqual(denied.status, 0, `controller unexpectedly wrote ${forbiddenPath}`);
      assert.equal(fs.existsSync(forbiddenPath), false);
    }

    for (const [name, filePath] of Object.entries(preservedPaths)) {
      assert.equal(await sha256File(filePath), beforeDigests[name], `${name} changed during T2`);
    }

    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: 1,
        fixture: "protected-local-t2-generated-unit",
        instanceId,
        controllerTransition: `${previousVersion}->${targetVersion}`,
        generatedUnits: [layout.controllerUnit, layout.supervisorUnit],
        operatorSocketAuthorized: true,
        injectedRestartRollback: true,
        sameCommandRetry: true,
        idempotentSelection: true,
        workerWriteIsolation: true,
        receiptBinding: true,
        criticalStatePreserved: Object.keys(preservedPaths),
        ownerInstallationTouched: false,
        freshProductInstallationCreated: false,
        packageBootstrapRun: false,
        durationMs: Date.now() - startedAt,
        result: "PASS",
      })}\n`,
    );
  } catch (error) {
    for (const unit of [layout.supervisorUnit, layout.controllerUnit]) {
      const journal = run("/usr/bin/journalctl", ["-u", unit, "-n", "80", "--no-pager"], {
        allowFailure: true,
      });
      const output = `${journal.stdout ?? ""}${journal.stderr ?? ""}`.trim();
      if (output) {
        process.stderr.write(`\n--- ${unit} journal ---\n${output}\n`);
      }
    }
    throw error;
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    await cleanup();
  }
}

if (process.argv[2] === "request") {
  await requestMain();
} else if (process.argv[2] === "--self-check") {
  process.stdout.write(
    '{"schemaVersion":1,"fixture":"protected-local-t2-generated-unit","freshProductInstallationCreated":false}\n',
  );
} else {
  runFixture().catch((error) => {
    process.stderr.write(`protected-local-t2-systemd: ${error.message}\n`);
    process.exitCode = 1;
  });
}
