#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { __testing as bootstrapTesting } from "./protected-local-bootstrap.mjs";

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
  const supervisorClient = path.join(supervisorDirectory, "fased-host-updaterctl.mjs");
  fs.mkdirSync(supervisorDirectory, { mode: 0o700 });
  fs.copyFileSync(path.join(sourceRoot, "scripts", "fased-host-updaterctl.mjs"), supervisorClient);
  fs.chmodSync(supervisorClient, 0o755);

  const runAsOperator = () =>
    spawnSync(process.execPath, [supervisorClient, "--self-check"], {
      encoding: "utf8",
      uid: 1000,
      gid: 1000,
    });

  const blocked = runAsOperator();
  assert.notEqual(blocked.status, 0, "0700 supervisor directory unexpectedly allowed traversal");

  const snapshot = await bootstrapTesting.captureProtectedLocalSupervisorClientDirectory({
    supervisorClient,
  });
  assert.equal(snapshot.mode, 0o700);
  await bootstrapTesting.setProtectedLocalSupervisorClientDirectoryMode(snapshot, 0o755);

  const allowed = runAsOperator();
  assert.equal(allowed.status, 0, allowed.stderr || allowed.stdout);
  assert.deepEqual(JSON.parse(allowed.stdout), {
    schemaVersion: 1,
    protocolVersion: 2,
    role: "client",
  });

  await bootstrapTesting.setProtectedLocalSupervisorClientDirectoryMode(snapshot, snapshot.mode);
  assert.equal(fs.statSync(supervisorDirectory).mode & 0o777, 0o700);

  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: 1,
      fixture: "protected-local-supervisor-client-traversal",
      crossUidExecution: true,
      rollbackModeRestored: true,
      ownerInstallationTouched: false,
      freshInfrastructureCreated: false,
      result: "PASS",
    })}\n`,
  );
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
