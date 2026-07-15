#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  assertManagedRuntime,
  atomicSymlink,
  atomicWriteJson,
  buildManagedInstallManifest,
  copyExecutable,
  readHostedRuntimeMetadata,
  readManagedInstallManifest,
  readPackageVersion,
  resolveLinkTarget,
  resolveManagedRuntimePaths,
} from "./managed-runtime-layout.mjs";

const execFileAsync = promisify(execFile);
const DEFAULT_RELEASE_BASE_URL = "https://github.com/fased-ai/fased/releases/download";
const DEFAULT_REGISTRY = "https://registry.npmjs.org";
const DEFAULT_TIMEOUT_MS = 20 * 60_000;

async function measureStage(timings, name, operation) {
  const startedAt = Date.now();
  try {
    return await operation();
  } finally {
    timings.push({ name, durationMs: Date.now() - startedAt });
  }
}

function formatDuration(durationMs) {
  return durationMs < 1000 ? `${durationMs}ms` : `${(durationMs / 1000).toFixed(2)}s`;
}

function parseArgs(argv) {
  if (argv[0] !== "update") {
    return { delegate: true, args: argv };
  }
  if (argv[1] && !argv[1].startsWith("-") && argv[1] !== "status") {
    return { delegate: true, args: argv };
  }
  const status = argv[1] === "status";
  const tokens = status ? argv.slice(2) : argv.slice(1);
  const options = {
    status,
    dryRun: false,
    json: false,
    restart: true,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    channel: null,
    channelExplicit: false,
    tag: null,
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--json") {
      options.json = true;
    } else if (token === "--dry-run") {
      options.dryRun = true;
    } else if (token === "--no-restart") {
      options.restart = false;
    } else if (token === "--restart") {
      options.restart = true;
    } else if (token === "--timeout") {
      const value = Number.parseInt(tokens[index + 1] || "", 10);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error("--timeout must be a positive integer (seconds)");
      }
      options.timeoutMs = value * 1000;
      index += 1;
    } else if (token === "--channel") {
      options.channel = String(tokens[index + 1] || "").trim();
      options.channelExplicit = true;
      index += 1;
    } else if (token === "--tag") {
      options.tag = String(tokens[index + 1] || "").trim();
      index += 1;
    } else if (token === "--yes" || token === "--safe-fallback") {
      // Compatibility flags do not change the managed artifact transaction.
    } else {
      throw new Error(`Unsupported managed update option: ${token}`);
    }
  }
  if (options.channelExplicit && options.channel === "dev") {
    return { delegate: true, args: argv };
  }
  if (options.channelExplicit && !new Set(["stable", "beta"]).has(options.channel)) {
    throw new Error('--channel must be "stable" or "beta" for a managed installation');
  }
  return { delegate: false, options };
}

function compareVersions(left, right) {
  const parse = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
      String(value || "").trim(),
    );
    return match
      ? {
          core: match.slice(1, 4).map(Number),
          prerelease: match[4]?.split(".") ?? [],
        }
      : null;
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) {
    return left === right ? 0 : null;
  }
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) {
      return a.core[index] < b.core[index] ? -1 : 1;
    }
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined || rightPart === undefined) {
      return leftPart === rightPart ? 0 : leftPart === undefined ? -1 : 1;
    }
    if (leftPart === rightPart) {
      continue;
    }
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      return Number(leftPart) < Number(rightPart) ? -1 : 1;
    }
    if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    }
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function resolveArchitecture() {
  if (process.platform !== "linux") {
    throw new Error(`Managed release artifacts are not available for ${process.platform}.`);
  }
  if (process.arch === "x64") {
    return "x64";
  }
  if (process.arch === "arm64") {
    return "arm64";
  }
  throw new Error(`Managed release artifacts are not available for ${process.arch}.`);
}

async function fetchJson(url, timeoutMs) {
  const response = await fetch(url, {
    headers: { accept: "application/json", "cache-control": "no-cache" },
    signal: AbortSignal.timeout(Math.min(timeoutMs, 15_000)),
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}): ${url}`);
  }
  return await response.json();
}

async function resolveTargetVersion(options) {
  const explicit = options.tag?.replace(/^@fased\/fased@/, "").replace(/^v/, "");
  if (explicit && /^\d+\.\d+\.\d+(?:[-+].*)?$/.test(explicit)) {
    return explicit;
  }
  const registry = (process.env.npm_config_registry || DEFAULT_REGISTRY).replace(/\/$/, "");
  const payload = await fetchJson(
    `${registry}/@fased%2ffased?fased_update=${Date.now()}`,
    options.timeoutMs,
  );
  const tag = explicit || (options.channel === "beta" ? "beta" : "latest");
  const version = payload?.["dist-tags"]?.[tag];
  if (typeof version !== "string" || !version.trim()) {
    throw new Error(`npm dist-tag ${tag} did not resolve to a Fased version.`);
  }
  return version.trim();
}

async function resolveConfiguredChannel(options, configPath) {
  if (options.channelExplicit) {
    try {
      const config = JSON.parse(await fsp.readFile(configPath, "utf8"));
      config.update = { ...config.update, channel: options.channel };
      await atomicWriteJson(configPath, config, 0o600);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw new Error(`Could not persist update channel: ${error.message}`, { cause: error });
      }
    }
    return options.channel;
  }
  try {
    const config = JSON.parse(await fsp.readFile(configPath, "utf8"));
    const stored = String(config?.update?.channel || "").trim();
    if (new Set(["stable", "beta", "dev"]).has(stored)) {
      return stored;
    }
  } catch {
    // Missing or invalid config uses the stable channel.
  }
  return "stable";
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest("hex");
}

async function fetchText(url, timeoutMs) {
  const response = await fetch(url, {
    headers: { "cache-control": "no-cache" },
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`Download failed (${response.status}): ${url}`);
  }
  return await response.text();
}

async function downloadToFile(url, destination, timeoutMs) {
  const response = await fetch(url, {
    headers: { "cache-control": "no-cache" },
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed (${response.status}): ${url}`);
  }
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  await pipeline(
    Readable.fromWeb(response.body),
    fs.createWriteStream(destination, { mode: 0o600 }),
  );
}

async function downloadVerifiedAsset({ releaseUrl, assetName, destinationDir, timeoutMs }) {
  const checksum = await fetchText(`${releaseUrl}/${assetName}.sha256`, timeoutMs);
  const expected = checksum
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .find((parts) => parts[1]?.replace(/^\*/, "") === assetName)?.[0]
    ?.toLowerCase();
  if (!expected || !/^[a-f0-9]{64}$/.test(expected)) {
    throw new Error(`Release checksum is invalid for ${assetName}.`);
  }
  const destination = path.join(destinationDir, assetName);
  await downloadToFile(`${releaseUrl}/${assetName}`, destination, timeoutMs);
  const actual = await sha256File(destination);
  if (actual !== expected) {
    throw new Error(`Checksum mismatch for ${assetName}.`);
  }
  return destination;
}

async function runFile(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeoutMs || DEFAULT_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      encoding: "utf8",
    });
    return { ok: true, stdout: result.stdout || "", stderr: result.stderr || "" };
  } catch (error) {
    return {
      ok: false,
      stdout: error?.stdout || "",
      stderr: error?.stderr || error?.message || String(error),
    };
  }
}

function archiveEntryIsSafe(entry, allowedRoot) {
  const normalized = String(entry || "").replace(/\/+$/, "");
  if (!normalized || normalized.includes("\\") || path.posix.isAbsolute(normalized)) {
    return false;
  }
  const parts = normalized.split("/");
  if (parts[0] !== allowedRoot) {
    return false;
  }
  return parts.every((part) => part !== "" && part !== "." && part !== "..");
}

async function assertArchiveSafe(archivePath, allowedRoot) {
  const listed = await runFile("tar", ["-tzf", archivePath], { timeoutMs: 120_000 });
  if (!listed.ok) {
    throw new Error(`Could not inspect release archive: ${listed.stderr.trim()}`);
  }
  for (const entry of listed.stdout.split(/\r?\n/).filter(Boolean)) {
    if (archiveEntryIsSafe(entry, allowedRoot)) {
      continue;
    }
    throw new Error(`Unsafe release archive entry: ${entry}`);
  }
}

async function extractArchive(archivePath, destination, timeoutMs) {
  await fsp.mkdir(destination, { recursive: true });
  const result = await runFile("tar", ["-xzf", archivePath, "-C", destination], { timeoutMs });
  if (!result.ok) {
    throw new Error(`Release extraction failed: ${result.stderr.trim()}`);
  }
}

async function ensureDependencyLayer({
  dependencyHash,
  releaseUrl,
  arch,
  paths,
  temporaryRoot,
  timeoutMs,
}) {
  const dependencyRoot = path.join(
    paths.stateDir,
    "install-cache",
    "hosted-dependencies",
    dependencyHash,
  );
  const nodeModules = path.join(dependencyRoot, "node_modules");
  try {
    await fsp.access(nodeModules);
    return nodeModules;
  } catch {
    // Download and activate below.
  }
  const assetName = `fased-hosted-deps-linux-${arch}-${dependencyHash}.tar.gz`;
  const archive = await downloadVerifiedAsset({
    releaseUrl,
    assetName,
    destinationDir: temporaryRoot,
    timeoutMs,
  });
  await assertArchiveSafe(archive, "node_modules");
  const staging = `${dependencyRoot}.staging-${process.pid}-${Date.now()}`;
  await fsp.rm(staging, { recursive: true, force: true });
  await extractArchive(archive, staging, timeoutMs);
  await fsp.access(path.join(staging, "node_modules"));
  await fsp.mkdir(path.dirname(dependencyRoot), { recursive: true });
  try {
    await fsp.rename(staging, dependencyRoot);
  } catch (error) {
    if (error?.code !== "EEXIST" && error?.code !== "ENOTEMPTY") {
      throw error;
    }
    await fsp.rm(staging, { recursive: true, force: true });
  }
  await fsp.access(nodeModules);
  return nodeModules;
}

async function smokeRuntime(runtimeRoot, timeoutMs) {
  const temporaryHome = await fsp.mkdtemp(path.join(os.tmpdir(), "fased-managed-smoke-"));
  const env = {
    ...process.env,
    HOME: temporaryHome,
    FASED_STATE_DIR: path.join(temporaryHome, ".fased"),
    FASED_CONFIG_PATH: path.join(temporaryHome, ".fased", "fased.json"),
    FASED_RUNTIME_SOURCE: "managed-package",
  };
  try {
    for (const args of [["--version"], ["plugins", "doctor"]]) {
      const result = await runFile(
        process.execPath,
        [path.join(runtimeRoot, "fased.mjs"), ...args],
        {
          env,
          timeoutMs,
        },
      );
      if (!result.ok) {
        throw new Error(`Staged runtime smoke failed: ${(result.stderr || result.stdout).trim()}`);
      }
    }
  } finally {
    await fsp.rm(temporaryHome, { recursive: true, force: true });
  }
}

function readGatewayEndpoint(configPath) {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return {
      port: Number.isInteger(config?.gateway?.port) ? config.gateway.port : 18789,
      tls: config?.gateway?.tls?.enabled === true,
    };
  } catch {
    return { port: 18789, tls: false };
  }
}

async function probeGatewayIdentity(configPath, expectedVersion, timeoutMs = 5000) {
  const endpoint = readGatewayEndpoint(configPath);
  const client = endpoint.tls ? https : http;
  return await new Promise((resolve) => {
    const request = client.get(
      {
        hostname: "127.0.0.1",
        port: endpoint.port,
        path: "/healthz",
        timeout: timeoutMs,
        ...(endpoint.tls ? { rejectUnauthorized: false } : {}),
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          try {
            const payload = JSON.parse(body);
            resolve({
              ok:
                response.statusCode === 200 &&
                payload?.version === expectedVersion &&
                new Set(["managed-package", "packaged-runtime"]).has(payload?.runtimeSource),
              payload,
            });
          } catch (error) {
            resolve({ ok: false, error: error.message });
          }
        });
      },
    );
    request.on("timeout", () => request.destroy(new Error("Gateway probe timed out")));
    request.on("error", (error) => resolve({ ok: false, error: error.message }));
  });
}

async function refreshGateway(runtimeRoot, manifest, timeoutMs) {
  const cli = path.join(runtimeRoot, "fased.mjs");
  const env = {
    ...process.env,
    FASED_STATE_DIR: manifest.stateDir,
    FASED_CONFIG_PATH: manifest.configPath,
    FASED_MANAGED_INSTALL_MANIFEST: path.join(manifest.stateDir, "install.json"),
    FASED_MANAGED_RUNTIME_ROOT: runtimeRoot,
    FASED_RUNTIME_SOURCE: "managed-package",
  };
  const installArgs = [cli, "gateway", "install", "--force"];
  if (manifest.profile === "hosting") {
    installArgs.push("--system");
  }
  const installed = await runFile(process.execPath, installArgs, { env, timeoutMs });
  if (!installed.ok) {
    throw new Error(
      `Gateway service installation failed: ${(installed.stderr || installed.stdout).trim()}`,
    );
  }
  const restarted = await runFile(process.execPath, [cli, "gateway", "restart"], {
    env,
    timeoutMs,
  });
  if (!restarted.ok) {
    throw new Error(`Gateway restart failed: ${(restarted.stderr || restarted.stdout).trim()}`);
  }
  const deadline = Date.now() + Math.min(timeoutMs, 60_000);
  let last = null;
  while (Date.now() < deadline) {
    last = await probeGatewayIdentity(manifest.configPath, manifest.runtime.activeVersion, 3000);
    if (last.ok) {
      const plugins = await runFile(process.execPath, [cli, "plugins", "doctor"], {
        env,
        timeoutMs: Math.min(timeoutMs, 60_000),
      });
      if (!plugins.ok) {
        throw new Error(`Plugin verification failed: ${(plugins.stderr || plugins.stdout).trim()}`);
      }
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `Gateway did not report runtime v${manifest.runtime.activeVersion}: ${JSON.stringify(last?.payload || last?.error || null)}`,
  );
}

async function replaceCompatibilityLink(paths) {
  const target = paths.compatibilityPackageRoot;
  await fsp.mkdir(path.dirname(target), { recursive: true });
  try {
    const stat = await fsp.lstat(target);
    if (stat.isSymbolicLink()) {
      await fsp.rm(target, { force: true });
    } else {
      throw new Error(`Compatibility package root is not installer-owned: ${target}`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  await atomicSymlink(paths.currentLink, target);
}

async function updateStableComponents(paths, runtimeRoot) {
  const scripts = path.join(runtimeRoot, "scripts");
  await copyExecutable(path.join(scripts, "fased-managed-launcher.sh"), paths.launcherPath);
  await copyExecutable(path.join(scripts, "fased-managed-service.sh"), paths.serviceLauncherPath);
  await copyExecutable(
    path.join(scripts, "managed-runtime-layout.mjs"),
    path.join(paths.updaterDir, "managed-runtime-layout.mjs"),
  );
  await copyExecutable(path.join(scripts, "fased-managed-updater.mjs"), paths.updaterPath);
}

async function acquireUpdateLock(stateDir) {
  const lockPath = path.join(stateDir, "update.lock");
  await fsp.mkdir(stateDir, { recursive: true });
  try {
    const handle = await fsp.open(lockPath, "wx", 0o600);
    await handle.writeFile(
      `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
    );
    await handle.close();
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
    let active = false;
    try {
      const existing = JSON.parse(await fsp.readFile(lockPath, "utf8"));
      if (Number.isInteger(existing.pid)) {
        process.kill(existing.pid, 0);
        active = true;
      }
    } catch {
      active = false;
    }
    if (active) {
      throw new Error(`Another Fased update is already running (${lockPath}).`, {
        cause: error,
      });
    }
    await fsp.rm(lockPath, { force: true });
    return await acquireUpdateLock(stateDir);
  }
  return async () => await fsp.rm(lockPath, { force: true });
}

async function delegateToRuntime(args, paths) {
  const currentRoot = await resolveLinkTarget(paths.currentLink);
  if (!currentRoot) {
    throw new Error("Managed runtime is missing; run the official repair installer once.");
  }
  const result = await runFile(process.execPath, [path.join(currentRoot, "fased.mjs"), ...args], {
    env: {
      ...process.env,
      FASED_MANAGED_RUNTIME_ROOT: currentRoot,
      FASED_RUNTIME_SOURCE: "managed-package",
    },
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.ok ? 0 : 1;
}

async function cleanupReleases(paths, keepRoots) {
  const keep = new Set(keepRoots.filter(Boolean).map((value) => path.resolve(value)));
  const entries = await fsp.readdir(paths.releasesDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?(?:\.repair-\d+-\d+)?$/.test(
        entry.name,
      )
    ) {
      continue;
    }
    const target = path.join(paths.releasesDir, entry.name);
    if (!keep.has(path.resolve(target))) {
      await fsp.rm(target, { recursive: true, force: true });
    }
  }
}

async function updateManagedRuntime(options) {
  const commandStartedAt = Date.now();
  const timings = [];
  const paths = resolveManagedRuntimePaths();
  const existingManifest = readManagedInstallManifest(paths.manifestPath);
  if (!existingManifest) {
    throw new Error(
      "Managed installation manifest is missing; run the official repair installer once.",
    );
  }
  const currentRoot = await resolveLinkTarget(paths.currentLink);
  const currentVersion = currentRoot
    ? (await readPackageVersion(currentRoot)) || existingManifest.runtime.activeVersion
    : existingManifest.runtime.activeVersion;
  const targetVersion = await measureStage(timings, "release resolution", () =>
    resolveTargetVersion(options),
  );

  if (options.status || options.dryRun) {
    const available = compareVersions(currentVersion, targetVersion) === -1;
    const result = {
      install: `managed ${existingManifest.profile}`,
      currentVersion,
      targetVersion,
      available,
      dryRun: options.dryRun,
      updaterVersion: existingManifest.updater?.version || "unknown",
    };
    if (options.json) {
      console.log(JSON.stringify({ ok: true, ...result }));
    } else {
      console.log("Fased Agent update status\n");
      console.log(`Install: managed ${existingManifest.profile}`);
      console.log(`Current: ${currentVersion}`);
      console.log(`Target: ${targetVersion}`);
      console.log(available ? `Update available: ${targetVersion}` : "Update: current");
      if (options.dryRun && available) {
        console.log("Action: verified artifact transaction with Gateway health rollback");
      }
    }
    return;
  }

  const releaseLock = await acquireUpdateLock(paths.stateDir);
  try {
    const comparison = compareVersions(currentVersion, targetVersion);
    let repairCurrentFiles = false;
    if (comparison === 0) {
      try {
        if (!currentRoot) {
          throw new Error("current runtime link is missing");
        }
        await assertManagedRuntime(currentRoot, currentVersion);
      } catch {
        repairCurrentFiles = true;
      }
      if (!repairCurrentFiles) {
        const identity = await probeGatewayIdentity(
          existingManifest.configPath,
          currentVersion,
          2000,
        );
        if (!identity.ok && options.restart && currentRoot) {
          await refreshGateway(currentRoot, existingManifest, options.timeoutMs);
        } else if (!identity.ok && !options.restart) {
          throw new Error("Installed files are current, but Gateway runtime identity is stale.");
        }
        if (options.json) {
          console.log(JSON.stringify({ ok: true, alreadyCurrent: true, current: currentVersion }));
        } else {
          console.log(`Already current: ${currentVersion}`);
        }
        return;
      }
    }
    if (!repairCurrentFiles && comparison === 1) {
      throw new Error(
        `Refusing to downgrade managed runtime from ${currentVersion} to ${targetVersion} without an explicit release recovery workflow.`,
      );
    }
    if (!options.restart) {
      throw new Error(
        "Managed transactional updates require service restart and health verification.",
      );
    }

    const arch = resolveArchitecture();
    const baseUrl = (
      process.env.FASED_HOSTED_ARTIFACT_BASE_URL || DEFAULT_RELEASE_BASE_URL
    ).replace(/\/$/, "");
    const releaseUrl = `${baseUrl}/v${targetVersion}`;
    const updateCacheRoot = path.join(paths.stateDir, "install-cache");
    await fsp.mkdir(updateCacheRoot, { recursive: true });
    const temporaryRoot = await fsp.mkdtemp(
      path.join(updateCacheRoot, `managed-update-${targetVersion}-`),
    );
    let activated = false;
    let previousRoot = currentRoot;
    let previousManifest = existingManifest;
    try {
      const assetName = `fased-hosted-app-linux-${arch}-v${targetVersion}.tar.gz`;
      const archive = await measureStage(timings, "application download and checksum", () =>
        downloadVerifiedAsset({
          releaseUrl,
          assetName,
          destinationDir: temporaryRoot,
          timeoutMs: options.timeoutMs,
        }),
      );
      await measureStage(timings, "application archive verification", () =>
        assertArchiveSafe(archive, "package"),
      );
      const extracted = path.join(temporaryRoot, "extract");
      await measureStage(timings, "application extraction", () =>
        extractArchive(archive, extracted, options.timeoutMs),
      );
      const stagedRoot = path.join(extracted, "package");
      const metadata = await readHostedRuntimeMetadata(stagedRoot);
      if (!metadata) {
        throw new Error("Hosted app metadata is missing or invalid.");
      }
      const nodeModules = await measureStage(timings, "dependency layer", () =>
        ensureDependencyLayer({
          dependencyHash: metadata.dependencyHash,
          releaseUrl,
          arch,
          paths,
          temporaryRoot,
          timeoutMs: options.timeoutMs,
        }),
      );
      await fsp.symlink(nodeModules, path.join(stagedRoot, "node_modules"), "dir");
      await assertManagedRuntime(stagedRoot, targetVersion);
      await measureStage(timings, "staged runtime smoke", () =>
        smokeRuntime(stagedRoot, options.timeoutMs),
      );

      let releaseRoot = path.join(paths.releasesDir, targetVersion);
      if (repairCurrentFiles) {
        releaseRoot = path.join(
          paths.releasesDir,
          `${targetVersion}.repair-${Date.now()}-${process.pid}`,
        );
      }
      const releaseExists = await fsp
        .lstat(releaseRoot)
        .then(() => true)
        .catch(() => false);
      if (releaseExists) {
        try {
          await assertManagedRuntime(releaseRoot, targetVersion);
        } catch {
          await fsp.rm(releaseRoot, { recursive: true, force: true });
          await fsp.rename(stagedRoot, releaseRoot);
        }
      } else {
        await fsp.mkdir(paths.releasesDir, { recursive: true });
        await fsp.rename(stagedRoot, releaseRoot);
      }

      const nextManifest = buildManagedInstallManifest({
        paths,
        profile: existingManifest.profile,
        version: targetVersion,
        dependencyHash: metadata.dependencyHash,
        previousVersion: currentVersion,
      });
      await measureStage(timings, "runtime activation", async () => {
        if (previousRoot && path.resolve(previousRoot) !== path.resolve(releaseRoot)) {
          await atomicSymlink(previousRoot, paths.previousLink);
        }
        await atomicSymlink(releaseRoot, paths.currentLink);
        await replaceCompatibilityLink(paths);
        await atomicWriteJson(paths.manifestPath, nextManifest, 0o600);
      });
      activated = true;

      try {
        await measureStage(timings, "Gateway refresh and health", () =>
          refreshGateway(releaseRoot, nextManifest, options.timeoutMs),
        );
      } catch (error) {
        if (previousRoot) {
          await atomicSymlink(previousRoot, paths.currentLink);
          await replaceCompatibilityLink(paths);
          await atomicWriteJson(paths.manifestPath, previousManifest, 0o600);
          await refreshGateway(previousRoot, previousManifest, options.timeoutMs).catch(
            () => undefined,
          );
        }
        throw new Error(`Update rolled back after health verification failed: ${error.message}`, {
          cause: error,
        });
      }

      await measureStage(timings, "updater and rollback cleanup", async () => {
        await updateStableComponents(paths, releaseRoot);
        await cleanupReleases(paths, [releaseRoot, previousRoot]);
      });
      timings.push({ name: "total", durationMs: Date.now() - commandStartedAt });
      if (options.json) {
        console.log(
          JSON.stringify({
            ok: true,
            before: currentVersion,
            after: targetVersion,
            mode: repairCurrentFiles ? "managed-artifact-repair" : "managed-artifact-transaction",
            timings,
          }),
        );
      } else {
        console.log(
          repairCurrentFiles
            ? `Repaired Fased runtime ${targetVersion}`
            : `Updated Fased ${currentVersion} -> ${targetVersion}`,
        );
        console.log(
          repairCurrentFiles
            ? "Update mode: verified same-version artifact repair"
            : "Update mode: managed artifact transaction",
        );
        console.log("Gateway: verified");
        console.log("Timing:");
        for (const timing of timings) {
          console.log(`  ${timing.name}: ${formatDuration(timing.durationMs)}`);
        }
      }
    } finally {
      await fsp.rm(temporaryRoot, { recursive: true, force: true });
      if (!activated) {
        const active = readManagedInstallManifest(paths.manifestPath);
        if (active?.runtime?.activeVersion !== currentVersion && previousRoot) {
          await atomicSymlink(previousRoot, paths.currentLink).catch(() => undefined);
          await replaceCompatibilityLink(paths).catch(() => undefined);
          await atomicWriteJson(paths.manifestPath, previousManifest, 0o600).catch(() => undefined);
        }
      }
    }
  } finally {
    await releaseLock();
  }
}

export async function run(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  const paths = resolveManagedRuntimePaths();
  if (parsed.delegate) {
    await delegateToRuntime(parsed.args, paths);
    return;
  }
  const manifest = readManagedInstallManifest(paths.manifestPath);
  if (!manifest) {
    throw new Error(
      "Managed installation manifest is missing; run the official repair installer once.",
    );
  }
  parsed.options.channel = await resolveConfiguredChannel(parsed.options, manifest.configPath);
  if (parsed.options.channel === "dev") {
    await delegateToRuntime(
      parsed.options.status ? argv : ["update", "--channel", "dev", ...argv.slice(1)],
      paths,
    );
    return;
  }
  await updateManagedRuntime(parsed.options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await run();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

export const __testing = {
  compareVersions,
  parseArgs,
  resolveArchitecture,
  archiveEntryIsSafe,
  assertArchiveSafe,
  probeGatewayIdentity,
};
