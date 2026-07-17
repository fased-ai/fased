#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SIGNER_BINARY = "/opt/fased/signer/fased-signerd";
const FIXED_ARGS = [
  "admin",
  "migration",
  "hosted-v1",
  "--control-socket",
  "/run/fased-signerd/control.sock",
  "--policy-file",
  "/etc/fased/signer-migration-policies.json",
  "--app-home",
  "/home/app",
  "--legacy-signer-home",
  "/home/fased-signer",
  "--state-dir",
  "/var/lib/fased-signerd",
  "--marker-file",
  "/var/lib/fased-host-updater/signer-v1-migration.pending",
];

function fail(message) {
  throw new Error(message);
}

function resolvePhase(argv = process.argv) {
  if (argv.length !== 3 || !new Set(["prepare", "commit"]).has(argv[2])) {
    fail("usage: migrate-hosted-signer-v2.mjs {prepare|commit}");
  }
  return argv[2];
}

function run(phase) {
  const child = spawnSync(SIGNER_BINARY, [...FIXED_ARGS, "--phase", phase], {
    env: {
      HOME: "/var/lib/fased-host-updater",
      LANG: "C",
      LC_ALL: "C",
      PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
    },
    stdio: "inherit",
  });
  if (child.error) {
    fail("the verified native signer migration command could not be started");
  }
  if (child.status !== 0) {
    process.exitCode = child.status ?? 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run(resolvePhase());
}

export const __testing = { FIXED_ARGS, SIGNER_BINARY, resolvePhase };
