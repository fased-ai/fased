#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: 1,
      fixture: "protected-local-supervisor-client-traversal",
      crossUidExecution: true,
      privateImplementationBlocked: true,
      privateDirectoryNeverOpened: true,
      ownerInstallationTouched: false,
      freshInfrastructureCreated: false,
      result: "PASS",
    })}\n`,
  );
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
