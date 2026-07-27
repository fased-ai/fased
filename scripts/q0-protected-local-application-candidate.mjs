#!/usr/bin/env node

import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const INSTANCE_PATTERN = /^[a-f0-9]{16}$/u;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  const operation = argv[0];
  if (!new Set(["activate", "restore", "run"]).has(operation)) {
    fail(
      "usage: q0-protected-local-application-candidate.mjs activate|restore|run [--instance <id>] [--source-root <path>]",
    );
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
      fail(`unsupported Q0 application candidate argument: ${key}`);
    }
  }
  if (instanceId && !INSTANCE_PATTERN.test(instanceId)) {
    fail("--instance must be 16 lowercase hexadecimal characters");
  }
  if (new Set(["activate", "run"]).has(operation) && !sourceRoot) {
    fail(`${operation} requires --source-root`);
  }
  return { operation, instanceId, sourceRoot };
}

async function resolveInstanceId(requested) {
  if (requested) {
    return requested;
  }
  const localRoot = "/opt/fased/local";
  const entries = await fsp.readdir(localRoot, { withFileTypes: true }).catch(() => []);
  const matches = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !INSTANCE_PATTERN.test(entry.name)) {
      continue;
    }
    const currentLink = path.join(localRoot, entry.name, "application", "current");
    const stat = await fsp.lstat(currentLink).catch(() => null);
    if (stat?.isSymbolicLink()) {
      matches.push(entry.name);
    }
  }
  if (matches.length !== 1) {
    fail(
      `could not select one protected Local instance automatically (found ${matches.length}); pass --instance`,
    );
  }
  return matches[0];
}

function layout(instanceId) {
  const installRoot = `/opt/fased/local/${instanceId}`;
  const controllerState = `/var/lib/fased-local/${instanceId}/controller`;
  return {
    releasesDir: `${installRoot}/application/releases`,
    currentLink: `${installRoot}/application/current`,
    backupPath: `${controllerState}/q0-application-candidate.json`,
    signerJournalPath: `${controllerState}/active-signer-transaction.json`,
    gatewayGatePath: `${controllerState}/gateway-update-gate`,
    bootstrapJournalPath: `/var/lib/fased-local/${instanceId}/bootstrap-transaction.json`,
    serviceName: `fased-gateway-${instanceId}.service`,
  };
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

async function atomicSymlink(target, linkPath, owner) {
  const temporaryPath = `${linkPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fsp.symlink(target, temporaryPath, "dir");
    await fsp.lchown(temporaryPath, owner.uid, owner.gid);
    await fsp.rename(temporaryPath, linkPath);
    await fsyncDirectory(path.dirname(linkPath));
  } finally {
    await fsp.rm(temporaryPath, { force: true });
  }
}

async function exactDirectory(directory, label) {
  const stat = await fsp.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0) {
    fail(`Q0 ${label} directory is unsafe: ${directory}`);
  }
  return stat;
}

async function exactRegularFile(filePath, label, { expectedUid } = {}) {
  const stat = await fsp.lstat(filePath);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    (expectedUid !== undefined && stat.uid !== expectedUid) ||
    (stat.mode & 0o022) !== 0
  ) {
    fail(`Q0 ${label} file is unsafe: ${filePath}`);
  }
  return stat;
}

async function validateCandidateDist(directory) {
  await exactDirectory(directory, "candidate dist");
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    const entries = await fsp.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      const stat = await fsp.lstat(entryPath);
      if (stat.isSymbolicLink()) {
        fail(`Q0 candidate dist contains an unsafe entry: ${entryPath}`);
      }
      if (stat.isDirectory()) {
        pending.push(entryPath);
      } else if (!stat.isFile() || stat.nlink !== 1) {
        fail(`Q0 candidate dist contains an unsupported entry: ${entryPath}`);
      }
    }
  }
}

async function hardenCandidateDist(root) {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    const stat = await fsp.lstat(current);
    if (stat.isSymbolicLink()) {
      fail(`Q0 candidate dist contains an unsafe entry: ${current}`);
    }
    if (stat.isDirectory()) {
      await fsp.chmod(current, 0o755);
      for (const entry of await fsp.readdir(current)) {
        pending.push(path.join(current, entry));
      }
      continue;
    }
    if (!stat.isFile() || stat.nlink !== 1) {
      fail(`Q0 candidate dist contains an unsupported entry: ${current}`);
    }
    await fsp.chmod(current, 0o644);
  }
}

async function runSystemctl(...args) {
  return await execFileAsync("/usr/bin/systemctl", args, {
    env: { PATH: "/usr/bin:/bin" },
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });
}

async function readHealth(port = 18789) {
  return await new Promise((resolve, reject) => {
    const request = http.get(
      {
        hostname: "127.0.0.1",
        port,
        path: "/healthz",
        timeout: 1_000,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          try {
            resolve({
              statusCode: response.statusCode,
              payload: JSON.parse(body),
            });
          } catch {
            reject(new Error("Gateway health response is invalid"));
          }
        });
      },
    );
    request.once("timeout", () => request.destroy(new Error("Gateway health timed out")));
    request.once("error", reject);
  });
}

async function readMiningHistory(port = 18789) {
  return await new Promise((resolve, reject) => {
    const request = http.get(
      {
        hostname: "127.0.0.1",
        port,
        path: "/api/mining/history?window=all&activityWindow=all",
        timeout: 60_000,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
          if (body.length > 8 * 1024 * 1024) {
            request.destroy(new Error("Mining history response exceeded the Q0 size limit"));
          }
        });
        response.on("end", () => {
          try {
            const payload = JSON.parse(body);
            if (response.statusCode !== 200 || payload?.ok !== true) {
              fail(
                `Mining history failed through the installed Gateway (status=${response.statusCode ?? "unknown"} body=${body.slice(0, 512)})`,
              );
            }
            resolve(payload);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.once("timeout", () =>
      request.destroy(new Error("Mining history Q0 request timed out")),
    );
    request.once("error", reject);
  });
}

async function waitForGateway({ serviceName, expectedRoot, expectedVersion }) {
  let lastError = "Gateway did not start";
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      await runSystemctl("is-active", "--quiet", serviceName);
      const { stdout } = await runSystemctl("show", "--property=MainPID", "--value", serviceName);
      const pid = Number(stdout.trim());
      if (!Number.isSafeInteger(pid) || pid <= 1) {
        fail("Gateway service MainPID is invalid");
      }
      const processRoot = await fsp.realpath(`/proc/${pid}/cwd`);
      if (processRoot !== expectedRoot) {
        fail(`Gateway process is running from ${processRoot}, expected ${expectedRoot}`);
      }
      const health = await readHealth();
      if (
        health.statusCode !== 200 ||
        health.payload?.version !== expectedVersion ||
        health.payload?.runtimeSource !== "managed-package"
      ) {
        fail(
          `Gateway health identity is mismatched (status=${health.statusCode ?? "unknown"} version=${health.payload?.version ?? "unknown"} runtimeSource=${health.payload?.runtimeSource ?? "unknown"})`,
        );
      }
      return;
    } catch (error) {
      lastError = error.message;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  fail(`Q0 protected application candidate did not become ready: ${lastError}`);
}

async function readReleaseIdentity(releaseRoot) {
  const [packageBytes, buildBytes] = await Promise.all([
    fsp.readFile(path.join(releaseRoot, "package.json"), "utf8"),
    fsp.readFile(path.join(releaseRoot, "dist", "build-info.json"), "utf8"),
  ]);
  const packageJson = JSON.parse(packageBytes);
  const buildInfo = JSON.parse(buildBytes);
  if (
    !VERSION_PATTERN.test(packageJson?.version || "") ||
    buildInfo?.version !== packageJson.version ||
    !COMMIT_PATTERN.test(buildInfo?.commit || "")
  ) {
    fail(`Q0 protected application identity is invalid: ${releaseRoot}`);
  }
  return {
    version: packageJson.version,
    commit: buildInfo.commit,
  };
}

async function sourceCommit(sourceRoot) {
  const { stdout } = await execFileAsync(
    "/usr/bin/git",
    ["-c", `safe.directory=${sourceRoot}`, "-C", sourceRoot, "rev-parse", "HEAD"],
    {
      env: { HOME: "/root", PATH: "/usr/bin:/bin" },
      timeout: 30_000,
      maxBuffer: 64 * 1024,
    },
  );
  const commit = stdout.trim();
  if (!COMMIT_PATTERN.test(commit)) {
    fail("Q0 source commit is invalid");
  }
  return commit;
}

async function lchownTree(root, owner) {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    const stat = await fsp.lstat(current);
    await fsp.lchown(current, owner.uid, owner.gid);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      continue;
    }
    for (const entry of await fsp.readdir(current)) {
      pending.push(path.join(current, entry));
    }
  }
}

async function resolveOperator(serviceName) {
  const unitPath = `/etc/systemd/system/${serviceName}`;
  const unit = await fsp.readFile(unitPath, "utf8");
  const home = unit.match(/^Environment=HOME=(\/[^\r\n]+)$/mu)?.[1] ?? "";
  if (!path.isAbsolute(home)) {
    fail("Q0 protected Gateway unit does not declare an absolute operator HOME");
  }
  const homeStat = await fsp.lstat(home);
  const { stdout } = await execFileAsync("/usr/bin/getent", ["passwd", String(homeStat.uid)], {
    env: { PATH: "/usr/bin:/bin" },
    timeout: 30_000,
    maxBuffer: 64 * 1024,
  });
  const username = stdout.split(":")[0]?.trim() ?? "";
  if (!username || username === "root") {
    fail("Q0 protected Gateway operator identity is invalid");
  }
  return { home, username };
}

async function runSignerDoctor({ candidateRoot, serviceName }) {
  const operator = await resolveOperator(serviceName);
  const { stdout } = await execFileAsync(
    "/usr/bin/runuser",
    [
      "-u",
      operator.username,
      "--",
      "/usr/bin/env",
      `HOME=${operator.home}`,
      `FASED_STATE_DIR=${path.join(operator.home, ".fased")}`,
      `FASED_CONFIG_PATH=${path.join(operator.home, ".fased", "fased.json")}`,
      "PATH=/usr/local/bin:/usr/bin:/bin",
      "/usr/bin/node-22",
      path.join(candidateRoot, "fased.mjs"),
      "wallet",
      "signer",
      "doctor",
      "--json",
    ],
    {
      env: { HOME: "/root", PATH: "/usr/bin:/bin" },
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  const result = JSON.parse(stdout);
  if (result?.ok !== true) {
    fail("Signer Doctor failed through the installed candidate");
  }
  return result;
}

async function runPluginDoctor({ candidateRoot, serviceName }) {
  const operator = await resolveOperator(serviceName);
  const { stdout } = await execFileAsync(
    "/usr/bin/runuser",
    [
      "-u",
      operator.username,
      "--",
      "/usr/bin/env",
      `HOME=${operator.home}`,
      `FASED_STATE_DIR=${path.join(operator.home, ".fased")}`,
      `FASED_CONFIG_PATH=${path.join(operator.home, ".fased", "fased.json")}`,
      "PATH=/usr/local/bin:/usr/bin:/bin",
      "/usr/bin/node-22",
      path.join(candidateRoot, "fased.mjs"),
      "plugins",
      "doctor",
      "--json",
    ],
    {
      env: { HOME: "/root", PATH: "/usr/bin:/bin" },
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  const result = JSON.parse(stdout);
  if (result?.ok !== true) {
    fail("Plugin Doctor failed through the installed candidate");
  }
  return result;
}

async function restoreCandidate(paths, backup, { removeBackup = true } = {}) {
  await runSystemctl("stop", paths.serviceName).catch(() => undefined);
  await atomicSymlink(backup.originalRoot, paths.currentLink, backup.linkOwner);
  await runSystemctl("start", paths.serviceName);
  await waitForGateway({
    serviceName: paths.serviceName,
    expectedRoot: backup.originalRoot,
    expectedVersion: backup.version,
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
    fail("a Q0 protected application candidate is already active; restore it before retrying");
  }
  for (const activePath of [
    paths.signerJournalPath,
    paths.gatewayGatePath,
    paths.bootstrapJournalPath,
  ]) {
    if (fs.existsSync(activePath)) {
      fail(
        `cannot inject a Q0 protected application candidate while this path exists: ${activePath}`,
      );
    }
  }
  await exactDirectory(paths.releasesDir, "application releases");
  const linkStat = await fsp.lstat(paths.currentLink);
  if (!linkStat.isSymbolicLink()) {
    fail("Q0 protected application current path is not a symlink");
  }
  const originalRoot = await fsp.realpath(paths.currentLink);
  if (path.dirname(originalRoot) !== paths.releasesDir) {
    fail("Q0 protected application current release escaped its release root");
  }
  const originalOwner = await exactDirectory(originalRoot, "official application");
  const officialIdentity = await readReleaseIdentity(originalRoot);
  const distRoot = path.join(sourceRoot, "dist");
  await validateCandidateDist(distRoot);
  const commit = await sourceCommit(sourceRoot);
  const candidateIdentity = await readReleaseIdentity(sourceRoot);
  if (
    candidateIdentity.version !== officialIdentity.version ||
    candidateIdentity.commit !== commit
  ) {
    fail("Q0 candidate build identity does not match the checked-out source");
  }
  const candidateRoot = path.join(
    paths.releasesDir,
    `v${officialIdentity.version}.q0-app.${commit.slice(0, 12)}`,
  );
  const stagingRoot = `${candidateRoot}.tmp-${process.pid}`;
  await fsp.rm(stagingRoot, { recursive: true, force: true });
  await fsp.rm(candidateRoot, { recursive: true, force: true });
  await fsp.mkdir(stagingRoot, { mode: 0o755 });
  try {
    await execFileAsync(
      "/usr/bin/cp",
      ["--archive", "--reflink=auto", `${originalRoot}/.`, stagingRoot],
      {
        env: { PATH: "/usr/bin:/bin" },
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
      },
    );
    await fsp.rm(path.join(stagingRoot, "dist"), { recursive: true, force: true });
    await execFileAsync(
      "/usr/bin/cp",
      ["--archive", "--reflink=auto", distRoot, path.join(stagingRoot, "dist")],
      {
        env: { PATH: "/usr/bin:/bin" },
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
      },
    );
    await Promise.all([
      fsp.rm(path.join(stagingRoot, ".fased-hosted-release-v2.json"), { force: true }),
      fsp.rm(path.join(stagingRoot, ".fased-hosting-bundle-verified"), { force: true }),
    ]);
    await hardenCandidateDist(path.join(stagingRoot, "dist"));
    await atomicWrite(
      path.join(stagingRoot, ".fased-q0-application-candidate.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          version: candidateIdentity.version,
          commit,
        },
        null,
        2,
      )}\n`,
      0o644,
    );
    await lchownTree(stagingRoot, {
      uid: originalOwner.uid,
      gid: originalOwner.gid,
    });
    await fsp.rename(stagingRoot, candidateRoot);
    await fsyncDirectory(paths.releasesDir);
  } catch (error) {
    await fsp.rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
  const backup = {
    schemaVersion: 1,
    originalRoot,
    candidateRoot,
    version: officialIdentity.version,
    commit,
    linkOwner: { uid: linkStat.uid, gid: linkStat.gid },
  };
  await atomicWrite(paths.backupPath, `${JSON.stringify(backup, null, 2)}\n`, 0o600);
  try {
    await atomicSymlink(candidateRoot, paths.currentLink, backup.linkOwner);
    await runSystemctl("restart", paths.serviceName);
    await waitForGateway({
      serviceName: paths.serviceName,
      expectedRoot: candidateRoot,
      expectedVersion: candidateIdentity.version,
    });
  } catch (error) {
    await restoreCandidate(paths, backup).catch((rollbackError) => {
      const failure = new Error(
        "Q0 protected application activation failed and rollback is incomplete",
        { cause: error },
      );
      failure.rollbackError = rollbackError;
      throw failure;
    });
    throw error;
  }
  process.stdout.write(
    `Q0 protected application candidate ${commit.slice(0, 12)} is active for ${paths.serviceName}.\n`,
  );
  return backup;
}

async function restoreFromBackup(paths) {
  await exactRegularFile(paths.backupPath, "application candidate backup", {
    expectedUid: 0,
  });
  const backup = JSON.parse(await fsp.readFile(paths.backupPath, "utf8"));
  if (
    backup?.schemaVersion !== 1 ||
    path.dirname(backup.originalRoot || "") !== paths.releasesDir ||
    path.dirname(backup.candidateRoot || "") !== paths.releasesDir ||
    !VERSION_PATTERN.test(backup.version || "") ||
    !COMMIT_PATTERN.test(backup.commit || "") ||
    !Number.isSafeInteger(backup.linkOwner?.uid) ||
    !Number.isSafeInteger(backup.linkOwner?.gid)
  ) {
    fail("Q0 protected application candidate backup is invalid");
  }
  await restoreCandidate(paths, backup);
  process.stdout.write(`Official protected application restored for ${paths.serviceName}.\n`);
}

async function runCandidate(paths, sourceRoot) {
  if (fs.existsSync(paths.backupPath)) {
    await restoreFromBackup(paths);
  }
  let activated = false;
  let testError;
  try {
    const backup = await activateCandidate(paths, sourceRoot);
    activated = true;
    await Promise.all([
      readMiningHistory(),
      runSignerDoctor({
        candidateRoot: backup.candidateRoot,
        serviceName: paths.serviceName,
      }),
      runPluginDoctor({
        candidateRoot: backup.candidateRoot,
        serviceName: paths.serviceName,
      }),
    ]);
  } catch (error) {
    testError = error;
  }
  if (activated) {
    try {
      await restoreFromBackup(paths);
    } catch (restoreError) {
      const failure = new Error("Q0 protected application verification rollback is incomplete", {
        cause: testError ?? restoreError,
      });
      failure.rollbackError = restoreError;
      throw failure;
    }
  }
  if (testError) {
    throw testError;
  }
  process.stdout.write(
    "Q0 PASS: protected Mining history, signer diagnostics, and plugin diagnostics passed; official application restored.\n",
  );
}

if (typeof process.getuid !== "function" || process.getuid() !== 0) {
  fail("Q0 protected Local application candidate harness must run as root");
}
const options = parseArguments(process.argv.slice(2));
const paths = layout(await resolveInstanceId(options.instanceId));
if (options.operation === "activate") {
  await activateCandidate(paths, options.sourceRoot);
} else if (options.operation === "run") {
  await runCandidate(paths, options.sourceRoot);
} else {
  await restoreFromBackup(paths);
}
