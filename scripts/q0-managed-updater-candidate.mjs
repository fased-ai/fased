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
    launcherPath: path.join(stateDir, "bin", "fased"),
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
  const sourceLauncherPath = path.join(sourceRoot, "scripts", "fased-managed-launcher.sh");
  const [installedStat, installedLauncherStat] = await Promise.all([
    exactOwnedFile(paths.updaterPath, uid),
    exactOwnedFile(paths.launcherPath, uid),
    exactOwnedFile(sourcePath, uid),
    exactOwnedFile(sourceLauncherPath, uid),
  ]);
  const [originalBytes, candidateBytes, originalLauncherBytes, candidateLauncherBytes] =
    await Promise.all([
      fsp.readFile(paths.updaterPath),
      fsp.readFile(sourcePath),
      fsp.readFile(paths.launcherPath),
      fsp.readFile(sourceLauncherPath),
    ]);
  const originalSha256 = sha256(originalBytes);
  const candidateSha256 = sha256(candidateBytes);
  const originalLauncherSha256 = sha256(originalLauncherBytes);
  const candidateLauncherSha256 = sha256(candidateLauncherBytes);
  if (originalSha256 === candidateSha256 && originalLauncherSha256 === candidateLauncherSha256) {
    fail("installed managed control plane already matches the Q0 candidate");
  }
  await atomicWrite(
    paths.backupPath,
    `${JSON.stringify(
      {
        schemaVersion: 2,
        updater: {
          originalBase64: originalBytes.toString("base64"),
          originalSha256,
          candidateSha256,
          mode: installedStat.mode & 0o777,
        },
        launcher: {
          originalBase64: originalLauncherBytes.toString("base64"),
          originalSha256: originalLauncherSha256,
          candidateSha256: candidateLauncherSha256,
          mode: installedLauncherStat.mode & 0o777,
        },
      },
      null,
      2,
    )}\n`,
    0o600,
  );
  try {
    await atomicWrite(paths.updaterPath, candidateBytes, installedStat.mode & 0o777);
    await atomicWrite(
      paths.launcherPath,
      candidateLauncherBytes,
      installedLauncherStat.mode & 0o777,
    );
  } catch (error) {
    await atomicWrite(paths.updaterPath, originalBytes, installedStat.mode & 0o777).catch(
      () => undefined,
    );
    await atomicWrite(
      paths.launcherPath,
      originalLauncherBytes,
      installedLauncherStat.mode & 0o777,
    ).catch(() => undefined);
    await fsp.rm(paths.backupPath, { force: true });
    throw error;
  }
  process.stdout.write(
    "Q0 managed launcher/updater candidate active; run the normal update command now.\n",
  );
}

async function restore(paths, uid) {
  await exactOwnedFile(paths.backupPath, uid);
  const backup = JSON.parse(await fsp.readFile(paths.backupPath, "utf8"));
  if (backup?.schemaVersion !== 2) {
    fail("Q0 managed-updater backup is invalid");
  }
  for (const [label, targetPath] of [
    ["updater", paths.updaterPath],
    ["launcher", paths.launcherPath],
  ]) {
    const entry = backup[label];
    if (
      typeof entry?.originalBase64 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(entry.originalSha256 || "") ||
      !/^[a-f0-9]{64}$/u.test(entry.candidateSha256 || "") ||
      !Number.isSafeInteger(entry.mode)
    ) {
      fail(`Q0 managed ${label} backup is invalid`);
    }
    const originalBytes = Buffer.from(entry.originalBase64, "base64");
    if (sha256(originalBytes) !== entry.originalSha256) {
      fail(`Q0 managed ${label} backup digest is invalid`);
    }
    await exactOwnedFile(targetPath, uid);
    const currentBytes = await fsp.readFile(targetPath);
    const currentSha256 = sha256(currentBytes);
    if (currentSha256 === entry.candidateSha256) {
      await atomicWrite(targetPath, originalBytes, entry.mode);
    } else if (currentSha256 !== entry.originalSha256) {
      fail(`installed managed ${label} changed outside the Q0 candidate transaction`);
    }
  }
  await fsp.rm(paths.backupPath, { force: true });
  await fsyncDirectory(path.dirname(paths.backupPath));
  process.stdout.write("Official managed launcher/updater restored after Q0.\n");
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
