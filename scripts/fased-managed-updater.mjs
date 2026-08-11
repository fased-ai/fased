#!/usr/bin/env node

import { spawn } from "node:child_process";
import { constants, realpathSync } from "node:fs";
import fsp from "node:fs/promises";
import { fileURLToPath } from "node:url";

const FIXED_BOOTSTRAP = "/opt/fased/lifecycle/bootstrap-v1/fased-bootstrap";

async function requireFixedBootstrap(path = FIXED_BOOTSTRAP, expectedUid = 0) {
  const before = await fsp.lstat(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    before.uid !== expectedUid ||
    (before.mode & 0o777) !== 0o555
  ) {
    throw new Error("The fixed lifecycle update client is unsafe; rerun the public installer.");
  }
  const handle = await fsp.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.uid !== expectedUid ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      throw new Error("The fixed lifecycle update client changed while opening.");
    }
  } finally {
    await handle.close();
  }
  return path;
}

export async function run(argv = process.argv.slice(2), { bootstrapPath = FIXED_BOOTSTRAP } = {}) {
  const bootstrap = await requireFixedBootstrap(bootstrapPath);
  const lifecycleArgs = argv[0] === "update" ? argv.slice(1) : argv;
  const invocation = fixedInvocation(bootstrap, lifecycleArgs, process.getuid?.() ?? -1);
  await new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      stdio: "inherit",
      env: {
        HOME: process.env.HOME,
        LANG: process.env.LANG || "C.UTF-8",
        LC_ALL: process.env.LC_ALL || "C.UTF-8",
        PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      },
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`Fixed lifecycle update client stopped by ${signal}.`));
      } else if (code !== 0) {
        reject(new Error(`Fixed lifecycle update client failed with exit code ${code}.`));
      } else {
        resolve();
      }
    });
  });
}

function fixedInvocation(bootstrap, argv, uid) {
  return uid === 0
    ? { command: bootstrap, args: ["update", ...argv] }
    : { command: "/usr/bin/sudo", args: [bootstrap, "update", ...argv] };
}

function isMainModule(entrypoint, moduleUrl, realpath = realpathSync) {
  if (!entrypoint) {
    return false;
  }
  try {
    return realpath(entrypoint) === realpath(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isMainModule(process.argv[1], import.meta.url)) {
  run().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

export const __testing = { FIXED_BOOTSTRAP, fixedInvocation, isMainModule, requireFixedBootstrap };
