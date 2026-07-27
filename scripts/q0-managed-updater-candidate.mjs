#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  const operation = argv[0];
  if (!new Set(["activate", "restore"]).has(operation)) {
    fail("usage: q0-managed-updater-candidate.mjs activate|restore [--source-root <path>]");
  }
  let sourceRoot = "";
  for (let index = 1; index < argv.length; index += 1) {
    if (argv[index] === "--source-root" && argv[index + 1]) {
      sourceRoot = path.resolve(argv[index + 1]);
      index += 1;
    } else {
      fail(`unsupported Q0 managed-updater candidate argument: ${argv[index]}`);
    }
  }
  if (operation === "activate" && !sourceRoot) {
    fail("activate requires --source-root");
  }
  return { operation, sourceRoot };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fsyncDirectory(directory) {
  const handle = await fsp.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicWrite(targetPath, content, mode) {
  const temporaryPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  const handle = await fsp.open(temporaryPath, "wx", mode);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.chmod(temporaryPath, mode);
  await fsp.rename(temporaryPath, targetPath);
  await fsyncDirectory(path.dirname(targetPath));
}

async function exactOwnedFile(filePath, expectedUid) {
  const stat = await fsp.lstat(filePath);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.uid !== expectedUid ||
    (stat.mode & 0o022) !== 0
  ) {
    fail(`Q0 managed-updater file is unsafe: ${filePath}`);
  }
  return stat;
}

function candidatePaths() {
  const stateDir = path.join(os.homedir(), ".fased");
  const updaterDir = path.join(stateDir, "updater");
  return {
    stateDir,
    updaterPath: path.join(updaterDir, "fased-managed-updater.mjs"),
    backupPath: path.join(updaterDir, "q0-managed-updater-backup.json"),
    transactionPath: path.join(stateDir, "hosted-update-transaction.json"),
  };
}

async function activate(paths, sourceRoot, uid) {
  if (fs.existsSync(paths.backupPath)) {
    fail("a Q0 managed-updater candidate is already active; restore it before retrying");
  }
  if (fs.existsSync(paths.transactionPath)) {
    fail("cannot inject a Q0 managed-updater candidate while a release transaction is active");
  }
  const sourcePath = path.join(sourceRoot, "scripts", "fased-managed-updater.mjs");
  const [installedStat] = await Promise.all([
    exactOwnedFile(paths.updaterPath, uid),
    exactOwnedFile(sourcePath, uid),
  ]);
  const [originalBytes, candidateBytes] = await Promise.all([
    fsp.readFile(paths.updaterPath),
    fsp.readFile(sourcePath),
  ]);
  const originalSha256 = sha256(originalBytes);
  const candidateSha256 = sha256(candidateBytes);
  if (originalSha256 === candidateSha256) {
    fail("installed managed updater already matches the Q0 candidate");
  }
  await atomicWrite(
    paths.backupPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        originalBase64: originalBytes.toString("base64"),
        originalSha256,
        candidateSha256,
        mode: installedStat.mode & 0o777,
      },
      null,
      2,
    )}\n`,
    0o600,
  );
  try {
    await atomicWrite(paths.updaterPath, candidateBytes, installedStat.mode & 0o777);
  } catch (error) {
    await fsp.rm(paths.backupPath, { force: true });
    throw error;
  }
  process.stdout.write("Q0 managed-updater candidate active; run the normal update command now.\n");
}

async function restore(paths, uid) {
  await exactOwnedFile(paths.backupPath, uid);
  const backup = JSON.parse(await fsp.readFile(paths.backupPath, "utf8"));
  if (
    backup?.schemaVersion !== 1 ||
    typeof backup.originalBase64 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(backup.originalSha256 || "") ||
    !/^[a-f0-9]{64}$/u.test(backup.candidateSha256 || "") ||
    !Number.isSafeInteger(backup.mode)
  ) {
    fail("Q0 managed-updater backup is invalid");
  }
  const originalBytes = Buffer.from(backup.originalBase64, "base64");
  if (sha256(originalBytes) !== backup.originalSha256) {
    fail("Q0 managed-updater backup digest is invalid");
  }
  await exactOwnedFile(paths.updaterPath, uid);
  const currentBytes = await fsp.readFile(paths.updaterPath);
  const currentSha256 = sha256(currentBytes);
  if (currentSha256 === backup.candidateSha256) {
    await atomicWrite(paths.updaterPath, originalBytes, backup.mode);
  } else if (currentSha256 !== backup.originalSha256) {
    fail("installed managed updater changed outside the Q0 candidate transaction");
  }
  await fsp.rm(paths.backupPath, { force: true });
  await fsyncDirectory(path.dirname(paths.backupPath));
  process.stdout.write("Official managed updater restored after Q0.\n");
}

const uid = typeof process.getuid === "function" ? process.getuid() : -1;
if (uid <= 0) {
  fail("Q0 managed-updater candidate harness must run as the non-root Local operator");
}
const options = parseArguments(process.argv.slice(2));
const paths = candidatePaths();
if (options.operation === "activate") {
  await activate(paths, options.sourceRoot, uid);
} else {
  await restore(paths, uid);
}
