#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const INSTANCE_PATTERN = /^[a-f0-9]{16}$/u;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;
const SERVER_NAME = "fased-host-updater.mjs";
const CLIENT_NAME = "fased-host-updaterctl.mjs";

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  const operation = argv[0];
  if (!new Set(["activate", "restore"]).has(operation)) {
    fail("usage: q0-protected-local-controller-candidate.mjs activate|restore --instance <id>");
  }
  let instanceId = "";
  let sourceRoot = "";
  for (let index = 1; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === "--instance" && value) {
      instanceId = value;
      index += 1;
    } else if (key === "--source-root" && value) {
      sourceRoot = path.resolve(value);
      index += 1;
    } else {
      fail(`unsupported Q0 controller candidate argument: ${key}`);
    }
  }
  if (!INSTANCE_PATTERN.test(instanceId)) {
    fail("--instance must be 16 lowercase hexadecimal characters");
  }
  if (operation === "activate" && !sourceRoot) {
    fail("activate requires --source-root");
  }
  return { operation, instanceId, sourceRoot };
}

async function sha256(filePath) {
  const bytes = await fsp.readFile(filePath);
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

async function atomicSymlink(target, linkPath) {
  const temporaryPath = `${linkPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fsp.symlink(target, temporaryPath, "dir");
    await fsp.rename(temporaryPath, linkPath);
    await fsyncDirectory(path.dirname(linkPath));
  } finally {
    await fsp.rm(temporaryPath, { force: true });
  }
}

async function exactRegularFile(filePath, { allowOperatorOwned = false } = {}) {
  const stat = await fsp.lstat(filePath);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    (!allowOperatorOwned && stat.uid !== 0) ||
    (stat.mode & 0o022) !== 0
  ) {
    fail(`Q0 controller candidate file is unsafe: ${filePath}`);
  }
  return stat;
}

async function runSystemctl(...args) {
  await execFileAsync("/usr/bin/systemctl", args, {
    env: { PATH: "/usr/bin:/bin" },
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });
}

async function waitForController({ serviceName, socketPath, unitPath, requireCorrectedPolicy }) {
  let lastError = "controller did not start";
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      await runSystemctl("is-active", "--quiet", serviceName);
      const socket = await fsp.lstat(socketPath);
      const unit = await fsp.readFile(unitPath, "utf8");
      if (!socket.isSocket()) {
        fail("controller request path is not a socket");
      }
      if (requireCorrectedPolicy && /^RestrictSUIDSGID=/mu.test(unit)) {
        fail("controller service policy did not remove the set-ID restriction");
      }
      return;
    } catch (error) {
      lastError = error.message;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  fail(`Q0 controller candidate did not become ready: ${lastError}`);
}

function layout(instanceId) {
  const installRoot = `/opt/fased/local/${instanceId}`;
  const controllerState = `/var/lib/fased-local/${instanceId}/controller`;
  return {
    installRoot,
    releasesDir: `${installRoot}/controller/releases`,
    currentLink: `${installRoot}/controller/current`,
    identityPath: `${controllerState}/controller-version.json`,
    journalPath: `${controllerState}/active-signer-transaction.json`,
    backupPath: `${controllerState}/q0-controller-candidate.json`,
    unitPath: `/etc/systemd/system/fased-local-controller-${instanceId}.service`,
    serviceName: `fased-local-controller-${instanceId}.service`,
    socketPath: `/run/fased-local-controller/${instanceId}/request.sock`,
  };
}

async function readIdentity(identityPath) {
  await exactRegularFile(identityPath);
  const bytes = await fsp.readFile(identityPath);
  const identity = JSON.parse(bytes);
  if (
    identity?.schemaVersion !== 1 ||
    !VERSION_PATTERN.test(identity.version || "") ||
    !/^[a-f0-9]{64}$/u.test(identity.serverSha256 || "") ||
    !/^[a-f0-9]{64}$/u.test(identity.clientSha256 || "")
  ) {
    fail("installed controller identity is invalid");
  }
  return { bytes, identity };
}

async function selfCheck(sourcePath, role) {
  const { stdout } = await execFileAsync(process.execPath, [sourcePath, "--self-check"], {
    env: { HOME: "/root", PATH: "/usr/bin:/bin" },
    timeout: 30_000,
    maxBuffer: 64 * 1024,
  });
  const result = JSON.parse(stdout);
  if (result?.schemaVersion !== 1 || result?.protocolVersion !== 2 || result?.role !== role) {
    fail(`Q0 ${role} controller self-check is incompatible`);
  }
}

async function restoreCandidate(paths, backup, { removeBackup = true } = {}) {
  await runSystemctl("stop", paths.serviceName).catch(() => undefined);
  await atomicSymlink(backup.originalRoot, paths.currentLink);
  await atomicWrite(
    paths.identityPath,
    Buffer.from(backup.identityBase64, "base64"),
    backup.identityMode,
  );
  await runSystemctl("daemon-reload");
  await runSystemctl("start", paths.serviceName);
  await waitForController({
    serviceName: paths.serviceName,
    socketPath: paths.socketPath,
    unitPath: paths.unitPath,
    requireCorrectedPolicy: false,
  });
  if (removeBackup) {
    await fsp.rm(paths.backupPath, { force: true });
    await fsp.rm(backup.candidateRoot, { recursive: true, force: true });
    await fsyncDirectory(path.dirname(paths.backupPath));
    await fsyncDirectory(paths.releasesDir);
  }
}

async function activateCandidate(paths, sourceRoot) {
  if (fs.existsSync(paths.backupPath)) {
    fail("a Q0 controller candidate is already active; restore it before retrying");
  }
  if (fs.existsSync(paths.journalPath)) {
    fail("cannot inject a Q0 controller candidate while a release transaction is active");
  }
  await exactRegularFile(paths.unitPath);
  const sourceServer = path.join(sourceRoot, "scripts", SERVER_NAME);
  const sourceClient = path.join(sourceRoot, "scripts", CLIENT_NAME);
  await Promise.all([
    exactRegularFile(sourceServer, { allowOperatorOwned: true }),
    exactRegularFile(sourceClient, { allowOperatorOwned: true }),
    selfCheck(sourceServer, "server"),
    selfCheck(sourceClient, "client"),
  ]);
  const { bytes: identityBytes, identity } = await readIdentity(paths.identityPath);
  const originalRoot = await fsp.realpath(paths.currentLink);
  const expectedOriginalRoot = path.join(paths.releasesDir, `v${identity.version}`);
  if (originalRoot !== expectedOriginalRoot) {
    fail("installed controller is not at its exact official generation");
  }
  const originalServer = path.join(originalRoot, SERVER_NAME);
  const originalClient = path.join(originalRoot, CLIENT_NAME);
  await Promise.all([exactRegularFile(originalServer), exactRegularFile(originalClient)]);
  if (
    (await sha256(originalServer)) !== identity.serverSha256 ||
    (await sha256(originalClient)) !== identity.clientSha256
  ) {
    fail("installed controller generation does not match its immutable identity");
  }
  const [serverSha256, clientSha256] = await Promise.all([
    sha256(sourceServer),
    sha256(sourceClient),
  ]);
  const candidateRoot = path.join(
    paths.releasesDir,
    `v${identity.version}.q0.${serverSha256.slice(0, 12)}`,
  );
  const stagingRoot = `${candidateRoot}.tmp-${process.pid}`;
  await fsp.rm(stagingRoot, { recursive: true, force: true });
  await fsp.mkdir(stagingRoot, { mode: 0o755 });
  await Promise.all([
    fsp.copyFile(sourceServer, path.join(stagingRoot, SERVER_NAME)),
    fsp.copyFile(sourceClient, path.join(stagingRoot, CLIENT_NAME)),
  ]);
  await Promise.all([
    fsp.chmod(path.join(stagingRoot, SERVER_NAME), 0o755),
    fsp.chmod(path.join(stagingRoot, CLIENT_NAME), 0o755),
  ]);
  await fsp.chown(stagingRoot, 0, 0);
  await Promise.all([
    fsp.chown(path.join(stagingRoot, SERVER_NAME), 0, 0),
    fsp.chown(path.join(stagingRoot, CLIENT_NAME), 0, 0),
  ]);
  await fsp.rm(candidateRoot, { recursive: true, force: true });
  await fsp.rename(stagingRoot, candidateRoot);
  await fsyncDirectory(paths.releasesDir);
  const identityStat = await fsp.lstat(paths.identityPath);
  const backup = {
    schemaVersion: 1,
    originalRoot,
    candidateRoot,
    identityBase64: identityBytes.toString("base64"),
    identityMode: identityStat.mode & 0o777,
  };
  await atomicWrite(paths.backupPath, `${JSON.stringify(backup, null, 2)}\n`, 0o600);
  try {
    await atomicSymlink(candidateRoot, paths.currentLink);
    await atomicWrite(
      paths.identityPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          version: identity.version,
          serverSha256,
          clientSha256,
        },
        null,
        2,
      )}\n`,
      identityStat.mode & 0o777,
    );
    await runSystemctl("restart", paths.serviceName);
    await waitForController({
      serviceName: paths.serviceName,
      socketPath: paths.socketPath,
      unitPath: paths.unitPath,
      requireCorrectedPolicy: true,
    });
  } catch (error) {
    await restoreCandidate(paths, backup).catch((rollbackError) => {
      const failure = new Error(
        "Q0 controller candidate activation failed and rollback is incomplete",
        { cause: error },
      );
      failure.rollbackError = rollbackError;
      throw failure;
    });
    throw error;
  }
  process.stdout.write(
    `Q0 controller candidate active for ${paths.serviceName}; run the normal managed update now.\n`,
  );
}

async function restoreFromBackup(paths) {
  await exactRegularFile(paths.backupPath);
  const backup = JSON.parse(await fsp.readFile(paths.backupPath, "utf8"));
  if (
    backup?.schemaVersion !== 1 ||
    path.dirname(backup.originalRoot || "") !== paths.releasesDir ||
    path.dirname(backup.candidateRoot || "") !== paths.releasesDir ||
    typeof backup.identityBase64 !== "string" ||
    !Number.isSafeInteger(backup.identityMode)
  ) {
    fail("Q0 controller candidate backup is invalid");
  }
  await restoreCandidate(paths, backup);
  process.stdout.write(`Official controller restored for ${paths.serviceName}.\n`);
}

if (typeof process.getuid !== "function" || process.getuid() !== 0) {
  fail("Q0 protected Local controller candidate harness must run as root");
}
const options = parseArguments(process.argv.slice(2));
const paths = layout(options.instanceId);
if (options.operation === "activate") {
  await activateCandidate(paths, options.sourceRoot);
} else {
  await restoreFromBackup(paths);
}
