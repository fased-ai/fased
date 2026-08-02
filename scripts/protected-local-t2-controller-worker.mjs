#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const instancePattern = /^[a-f0-9]{16}$/u;

function fail(message) {
  throw new Error(message);
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function sha256File(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

async function main() {
  const instanceId = String(argument("--protected-local-instance") ?? "").trim();
  if (!instancePattern.test(instanceId)) {
    fail("T2 controller worker requires an exact Protected Local instance ID");
  }

  const runningPath = fs.realpathSync(process.argv[1]);
  const versionMatch = /\/controller\/releases\/v([^/]+)\/fased-host-updater\.mjs$/u.exec(
    runningPath,
  );
  if (!versionMatch) {
    fail("T2 controller worker is outside an immutable controller generation");
  }
  const runningVersion = versionMatch[1];
  const installRoot = `/opt/fased/local/${instanceId}`;
  const fixturePath = `/var/lib/fased-local/${instanceId}/controller/t2-fixture.json`;
  const fixture = JSON.parse(await fsp.readFile(fixturePath, "utf8"));
  if (
    fixture?.schemaVersion !== 1 ||
    fixture.instanceId !== instanceId ||
    ![fixture.previousVersion, fixture.targetVersion].includes(runningVersion)
  ) {
    fail("T2 controller fixture identity is invalid");
  }

  const product = await import(
    pathToFileURL(path.join(installRoot, "t2-lib", "fased-host-updater-production.mjs")).href
  );
  const base = product.protectedLocalControllerConfiguration(instanceId);
  const privateSocketPath = `/run/fased-local-controller-worker/${instanceId}/controller.sock`;
  const configuration = Object.freeze({
    ...base,
    supervised: true,
    socketUid: 0,
    socketGid: 0,
    paths: Object.freeze({ ...base.paths, socketPath: privateSocketPath }),
  });
  const clientPath = path.join(path.dirname(runningPath), "fased-host-updaterctl.mjs");
  const runningIdentity = Object.freeze({
    version: runningVersion,
    serverSha256: sha256File(runningPath),
    clientSha256: sha256File(clientPath),
  });
  const topology = Object.freeze({
    schemaVersion: 1,
    profile: "protected-local",
    managedApplication: true,
    instanceId,
    stateDir: fixture.appStateDir,
    configPath: path.join(fixture.appStateDir, "fased.json"),
    operator: Object.freeze({
      name: fixture.operatorUser,
      uid: fixture.operatorUid,
      gid: fixture.operatorGid,
      home: fixture.operatorHome,
    }),
    gateway: Object.freeze({
      user: `fsgw-${instanceId}`,
      uid: fixture.gatewayUid,
      unitPath: `/etc/systemd/system/fased-gateway-${instanceId}.service`,
    }),
    configGroup: Object.freeze({
      name: `fscf-${instanceId}`,
      gid: fixture.configGid,
    }),
    services: Object.freeze({
      gateway: `fased-gateway-${instanceId}.service`,
      signer: `fased-signerd-${instanceId}.service`,
    }),
    gatewayLauncherPath: path.join(installRoot, "gateway-launch"),
    capabilities: Object.freeze({
      lifecycleControllerProtocol: 2,
      signerProtocol: Object.freeze({ current: 2, min: 2, max: 2 }),
      declaredStateRegistry: 1,
    }),
    stateSchemas: Object.freeze({
      managedInstall: 2,
      walletRegistry: 1,
      signer: 2,
      mining: 1,
      federation: 2,
    }),
  });

  const context = product.__testing.createTransactionContext({
    paths: configuration.paths,
    protectedLocalInstanceId: instanceId,
    signerServiceName: configuration.signerServiceName,
    gatewayServiceName: configuration.gatewayServiceName,
    signerApplicationSocketPath: configuration.signerApplicationSocketPath,
    supervised: true,
    controllerConfiguration: configuration,
    runningControllerVersion: runningVersion,
    controllerInstanceId: randomUUID(),
    runningControllerIdentity: runningIdentity,
    historicalQ0TestStateDir: path.join(installRoot, "t2-no-q0"),
    assertReleaseAllowed: async () => undefined,
    discoverApplicationTopology: async () => topology,
    recoverInterruptedTransaction: async () => undefined,
    stageControllerRelease: async () => {
      await fsp.writeFile(fixture.forbiddenStageMarker, "called\n", { mode: 0o600 });
      const error = new Error("supervised T2 controller attempted forbidden staging");
      error.code = "EROFS";
      throw error;
    },
  });
  const running = await product.startServer({ configuration, context });
  if (running.restartRequired) {
    process.exitCode = 75;
    return;
  }
  await new Promise((resolve, reject) => {
    running.server.once("close", resolve);
    running.server.once("error", reject);
  });
}

main().catch((error) => {
  process.stderr.write(`protected-local-t2-controller: ${error.message}\n`);
  process.exitCode = 1;
});
