#!/usr/bin/env node

import fsp from "node:fs/promises";
import path from "node:path";

const AUTHORIZATION_PATH = "/etc/fased/testing/protected-local-artifact-source.json";
const BACKUP_PATH = "/etc/fased/testing/q0-protected-local-artifact-source-backup.json";
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const INSTANCE_PATTERN = /^[a-f0-9]{16}$/u;

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  const operation = argv[0];
  if (!new Set(["activate", "restore"]).has(operation)) {
    fail(
      "usage: q0-protected-local-artifact-authorization.mjs activate --base-url URL --version X.Y.Z --commit SHA --instance ID | restore",
    );
  }
  const options = { operation, baseUrl: "", version: "", commit: "", instanceId: "" };
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!value) {
      fail(`missing value for ${key || "argument"}`);
    }
    if (key === "--base-url") {
      options.baseUrl = value.replace(/\/$/, "");
    } else if (key === "--version") {
      options.version = value;
    } else if (key === "--commit") {
      options.commit = value;
    } else if (key === "--instance") {
      options.instanceId = value;
    } else {
      fail(`unsupported Q0 artifact authorization argument: ${key}`);
    }
  }
  if (
    operation === "activate" &&
    (!/^http:\/\/127\.0\.0\.1:\d+$/u.test(options.baseUrl) ||
      !VERSION_PATTERN.test(options.version) ||
      !COMMIT_PATTERN.test(options.commit) ||
      !INSTANCE_PATTERN.test(options.instanceId))
  ) {
    fail("Q0 artifact authorization requires an exact loopback URL, version, and commit");
  }
  return options;
}

async function fsyncDirectory(directory) {
  const handle = await fsp.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicWrite(filePath, content, mode) {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const handle = await fsp.open(temporaryPath, "wx", mode);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.chown(temporaryPath, 0, 0);
  await fsp.chmod(temporaryPath, mode);
  await fsp.rename(temporaryPath, filePath);
  await fsyncDirectory(path.dirname(filePath));
}

async function readExistingAuthorization() {
  try {
    const stat = await fsp.lstat(AUTHORIZATION_PATH);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.uid !== 0 ||
      (stat.mode & 0o022) !== 0
    ) {
      fail(`existing Q0 artifact authorization is unsafe: ${AUTHORIZATION_PATH}`);
    }
    return {
      exists: true,
      contentBase64: (await fsp.readFile(AUTHORIZATION_PATH)).toString("base64"),
      mode: stat.mode & 0o777,
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { exists: false };
    }
    throw error;
  }
}

async function activate(options) {
  try {
    await fsp.lstat(BACKUP_PATH);
    fail("a Q0 artifact authorization is already active");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  await fsp.mkdir(path.dirname(AUTHORIZATION_PATH), { recursive: true, mode: 0o755 });
  await fsp.chown(path.dirname(AUTHORIZATION_PATH), 0, 0);
  await fsp.chmod(path.dirname(AUTHORIZATION_PATH), 0o755);
  const previous = await readExistingAuthorization();
  await atomicWrite(
    BACKUP_PATH,
    `${JSON.stringify({ schemaVersion: 1, previous }, null, 2)}\n`,
    0o600,
  );
  try {
    await atomicWrite(
      AUTHORIZATION_PATH,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          baseUrl: options.baseUrl,
          protectedLocalInstance: options.instanceId,
          releaseVersion: options.version,
          releaseCommit: options.commit,
          forceSameVersionRepair: true,
        },
        null,
        2,
      )}\n`,
      0o444,
    );
  } catch (error) {
    await fsp.rm(BACKUP_PATH, { force: true });
    throw error;
  }
  process.stdout.write("Q0 Protected Local artifact source authorized.\n");
}

async function restore() {
  const backupStat = await fsp.lstat(BACKUP_PATH);
  if (
    !backupStat.isFile() ||
    backupStat.isSymbolicLink() ||
    backupStat.uid !== 0 ||
    (backupStat.mode & 0o022) !== 0
  ) {
    fail("Q0 artifact authorization backup is unsafe");
  }
  const backup = JSON.parse(await fsp.readFile(BACKUP_PATH, "utf8"));
  if (backup?.schemaVersion !== 1 || typeof backup.previous?.exists !== "boolean") {
    fail("Q0 artifact authorization backup is invalid");
  }
  if (backup.previous.exists) {
    const bytes = Buffer.from(backup.previous.contentBase64 || "", "base64");
    if (!Number.isSafeInteger(backup.previous.mode) || bytes.length === 0) {
      fail("Q0 artifact authorization backup is invalid");
    }
    await atomicWrite(AUTHORIZATION_PATH, bytes, backup.previous.mode);
  } else {
    await fsp.rm(AUTHORIZATION_PATH, { force: true });
  }
  await fsp.rm(BACKUP_PATH, { force: true });
  await fsyncDirectory(path.dirname(BACKUP_PATH));
  process.stdout.write("Q0 Protected Local artifact authorization restored.\n");
}

if (typeof process.getuid !== "function" || process.getuid() !== 0) {
  fail("Q0 Protected Local artifact authorization must run as root");
}

const options = parseArguments(process.argv.slice(2));
if (options.operation === "activate") {
  await activate(options);
} else {
  await restore();
}
