#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

function fail(message) {
  throw new Error(message);
}

function sha256File(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

async function assertGeneration(generationRoot) {
  const info = await fsp.lstat(generationRoot);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0) {
    fail("T2 controller generation is not a root-owned real directory");
  }
  const entries = (await fsp.readdir(generationRoot)).toSorted();
  if (entries.join(",") !== "fased-host-updater.mjs,fased-host-updaterctl.mjs") {
    fail("T2 controller generation has unexpected contents");
  }
  for (const name of entries) {
    const target = path.join(generationRoot, name);
    const targetInfo = await fsp.lstat(target);
    if (
      !targetInfo.isFile() ||
      targetInfo.isSymbolicLink() ||
      targetInfo.uid !== 0 ||
      targetInfo.nlink !== 1 ||
      (targetInfo.mode & 0o022) !== 0
    ) {
      fail("T2 controller generation target is mutable or untrusted");
    }
  }
}

async function main() {
  const productPath = path.join(
    path.dirname(process.argv[1]),
    "..",
    "t2-lib",
    "fased-lifecycle-supervisor-production.mjs",
  );
  const product = await import(pathToFileURL(productPath).href);
  const configuration = product.parseSupervisorConfiguration(process.argv.slice(2));
  const fixturePath = path.join(configuration.paths.stateDir, "t2-fixture.json");
  const fixture = JSON.parse(await fsp.readFile(fixturePath, "utf8"));
  if (
    fixture?.schemaVersion !== 1 ||
    fixture.instanceId !== configuration.instanceId ||
    fixture.targetVersion === fixture.previousVersion
  ) {
    fail("T2 supervisor fixture identity is invalid");
  }

  const supervisorDigest = sha256File(fs.realpathSync(process.argv[1]));
  const initialState = product.__testing.initialLifecycleTrustState();
  const trusted = Object.freeze({
    persisted: false,
    envelope: product.__testing.INITIAL_LIFECYCLE_ROOT_ENVELOPE,
    root: product.__testing.EMBEDDED_LIFECYCLE_ROOT,
    state: initialState,
  });
  const context = product.__testing.createContext(configuration, {
    runningSupervisorDigest: supervisorDigest,
    stageTrustedController: async (request) => {
      if (request.version !== fixture.targetVersion) {
        fail("T2 requested target does not match the fixed fixture target");
      }
      const previousGeneration = await fsp.realpath(configuration.paths.currentLink);
      const targetGeneration = path.join(
        configuration.paths.releasesDir,
        `v${fixture.targetVersion}`,
      );
      await Promise.all([assertGeneration(previousGeneration), assertGeneration(targetGeneration)]);
      const previousIdentity = JSON.parse(
        await fsp.readFile(configuration.paths.controllerVersionPath, "utf8"),
      );
      const identity = Object.freeze({
        schemaVersion: 1,
        version: fixture.targetVersion,
        serverSha256: sha256File(path.join(targetGeneration, "fased-host-updater.mjs")),
        clientSha256: sha256File(path.join(targetGeneration, "fased-host-updaterctl.mjs")),
      });
      const targetAlreadySelected =
        previousGeneration === targetGeneration &&
        previousIdentity.version === fixture.targetVersion;
      return Object.freeze({
        changed: !targetAlreadySelected,
        identity,
        generationRoot: targetGeneration,
        previousGeneration,
        previousIdentity,
        releaseCommit: fixture.releaseCommit,
        targetManifestSha256: fixture.targetManifestSha256,
        supervisorChanged: false,
        previousSupervisorDigest: supervisorDigest,
        targetSupervisorDigest: supervisorDigest,
        previousSupervisorGeneration: fs.realpathSync(process.argv[1]),
        targetSupervisorGeneration: fs.realpathSync(process.argv[1]),
        trusted,
        candidateRoot: trusted.root,
        trustState: initialState,
        trustChanged: false,
      });
    },
  });
  const running = await product.startSupervisor({ configuration, context });
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
  process.stderr.write(`protected-local-t2-supervisor: ${error.message}\n`);
  process.exitCode = 1;
});
