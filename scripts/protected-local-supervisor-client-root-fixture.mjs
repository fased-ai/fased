#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MANAGED_UPDATER_SUPPORT_FILES } from "./fased-managed-updater-core.mjs";
import { __testing as bootstrapTesting } from "./protected-local-bootstrap.mjs";
import { buildProtectedLocalLayout } from "./protected-local-layout.mjs";

if (typeof process.getuid !== "function" || process.getuid() !== 0) {
  throw new Error("supervisor client traversal fixture requires root or a root user namespace");
}

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = fs.mkdtempSync(
  path.join(process.env.TMPDIR || os.tmpdir(), "fased-supervisor-client-traversal-"),
);

try {
  fs.chmodSync(fixtureRoot, 0o755);
  const supervisorDirectory = path.join(fixtureRoot, "supervisor");
  const clientDirectory = path.join(fixtureRoot, "libexec");
  const privateClient = path.join(supervisorDirectory, "fased-host-updaterctl.mjs");
  const supervisorClient = path.join(clientDirectory, "fased-host-updaterctl.mjs");
  fs.mkdirSync(supervisorDirectory, { mode: 0o700 });
  fs.mkdirSync(clientDirectory, { mode: 0o755 });
  fs.copyFileSync(path.join(sourceRoot, "scripts", "fased-host-updaterctl.mjs"), privateClient);
  fs.copyFileSync(path.join(sourceRoot, "scripts", "fased-host-updaterctl.mjs"), supervisorClient);
  fs.chmodSync(privateClient, 0o755);
  fs.chmodSync(supervisorClient, 0o755);

  const runAsOperator = () =>
    spawnSync(process.execPath, [supervisorClient, "--self-check"], {
      encoding: "utf8",
      uid: 1000,
      gid: 1000,
    });

  const privateBlocked = spawnSync(process.execPath, [privateClient, "--self-check"], {
    encoding: "utf8",
    uid: 1000,
    gid: 1000,
  });
  assert.notEqual(
    privateBlocked.status,
    0,
    "0700 private supervisor directory unexpectedly allowed operator traversal",
  );

  const allowed = runAsOperator();
  assert.equal(allowed.status, 0, allowed.stderr || allowed.stdout);
  assert.deepEqual(JSON.parse(allowed.stdout), {
    schemaVersion: 1,
    protocolVersion: 2,
    role: "client",
  });

  assert.equal(fs.statSync(supervisorDirectory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(clientDirectory).mode & 0o777, 0o755);

  const privateRelease = path.join(fixtureRoot, "private-release");
  const privateScripts = path.join(privateRelease, "scripts");
  fs.mkdirSync(privateScripts, { recursive: true, mode: 0o700 });
  fs.chmodSync(privateRelease, 0o700);
  let sourceOwnerUid = null;
  for (const name of MANAGED_UPDATER_SUPPORT_FILES) {
    fs.copyFileSync(path.join(sourceRoot, "scripts", name), path.join(privateScripts, name));
    fs.chmodSync(path.join(privateScripts, name), 0o644);
    const info = fs.lstatSync(path.join(privateScripts, name));
    assert.equal(info.isFile(), true);
    assert.equal(info.isSymbolicLink(), false);
    assert.equal(info.nlink, 1);
    sourceOwnerUid ??= info.uid;
    assert.equal(info.uid, sourceOwnerUid);
    assert.equal(info.mode & 0o022, 0);
  }
  const layout = buildProtectedLocalLayout("0123456789abcdef", {
    runtimeRoot: path.join(fixtureRoot, "run"),
    stateRoot: path.join(fixtureRoot, "state"),
    installRoot: path.join(fixtureRoot, "install"),
  });
  fs.mkdirSync(layout.installDir, { recursive: true, mode: 0o755 });
  const stagedAdoption = await bootstrapTesting.prepareLegacyManagedUpdateAdoptionBundle(
    privateRelease,
    layout,
    { sourceOwnerUid },
  );
  const importModuleAsOperator = (modulePath) =>
    spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `await import(${JSON.stringify(pathToFileURL(modulePath).href)})`,
      ],
      { encoding: "utf8", uid: 1000, gid: 1000 },
    );
  const privateAdoptionBlocked = importModuleAsOperator(
    path.join(privateScripts, "fased-managed-updater-core.mjs"),
  );
  assert.notEqual(
    privateAdoptionBlocked.status,
    0,
    "0700 attested release tree unexpectedly allowed operator module loading",
  );
  const stagedAdoptionAllowed = importModuleAsOperator(
    path.join(stagedAdoption.sourceRoot, "scripts", "fased-managed-updater-core.mjs"),
  );
  assert.equal(
    stagedAdoptionAllowed.status,
    0,
    stagedAdoptionAllowed.stderr || stagedAdoptionAllowed.stdout,
  );
  await stagedAdoption.cleanup();
  assert.equal(fs.existsSync(stagedAdoption.sourceRoot), false);
  assert.equal(fs.statSync(privateRelease).mode & 0o777, 0o700);

  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: 1,
      fixture: "protected-local-supervisor-client-traversal",
      crossUidExecution: true,
      privateImplementationBlocked: true,
      privateDirectoryNeverOpened: true,
      privateAdoptionModuleBlocked: true,
      stagedAdoptionModuleLoaded: true,
      stagedAdoptionCleaned: true,
      ownerInstallationTouched: false,
      freshInfrastructureCreated: false,
      result: "PASS",
    })}\n`,
  );
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
