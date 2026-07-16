#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
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
const RELEASE_REPOSITORY = "fased-ai/fased";
const RELEASE_WORKFLOW = "fased-ai/fased/.github/workflows/hosted-runtime-release.yml";
const HOST_UPDATER_SOCKET = "/run/fased-host-updater/request.sock";
const HOST_UPDATER_SCHEMA_VERSION = 2;
const HOSTED_TRANSACTION_SCHEMA_VERSION = 1;
const HOSTED_TRANSACTION_PHASES = new Set([
  "prepared",
  "quiescing",
  "signer-preactivated",
  "app-active",
  "signer-active",
  "gateway-verified",
  "rolling-back",
  "rollback-ready",
]);
const TRANSACTION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const PRE_V2_HOSTING_MIGRATION_MESSAGE = [
  "This hosted installation needs the one-time signer-v2 security migration before it can update.",
  "From a VPS provider console or a root SSH session, run:",
  "curl -fsSL https://raw.githubusercontent.com/fased-ai/fased/main/install.sh | bash -s -- --repair-hosting",
  "The current Gateway, signer, wallets, and persistent state were left unchanged.",
].join(" ");

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

async function verifyOfficialAsset(assetPath, version, timeoutMs) {
  const gh = ["/usr/bin/gh", "/usr/local/bin/gh"].find((candidate) => fs.existsSync(candidate));
  if (!gh) {
    throw new Error(
      "GitHub CLI with attestation verification is required; rerun ./install.sh --repair-hosting as root.",
    );
  }
  const result = await runFile(
    gh,
    [
      "attestation",
      "verify",
      assetPath,
      "--repo",
      RELEASE_REPOSITORY,
      "--signer-workflow",
      RELEASE_WORKFLOW,
      "--source-ref",
      `refs/tags/v${version}`,
      "--deny-self-hosted-runners",
    ],
    {
      env: {
        HOME: process.env.HOME,
        PATH: "/usr/local/bin:/usr/bin:/bin",
        GH_PROMPT_DISABLED: "1",
      },
      timeoutMs,
    },
  );
  if (!result.ok) {
    throw new Error(`Release attestation verification failed: ${result.stderr.trim()}`);
  }
}

async function downloadVerifiedAsset({
  releaseUrl,
  assetName,
  destinationDir,
  timeoutMs,
  officialVersion,
}) {
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
  if (officialVersion) {
    await verifyOfficialAsset(destination, officialVersion, timeoutMs);
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
  officialVersion,
}) {
  const dependencyRoot = path.join(
    paths.stateDir,
    "install-cache",
    "hosted-dependencies",
    dependencyHash,
  );
  const nodeModules = path.join(dependencyRoot, "node_modules");
  const durabilityMarker = path.join(dependencyRoot, ".fased-durable-v1");
  const dependencyExists = await fsp
    .access(nodeModules)
    .then(() => true)
    .catch(() => false);
  if (dependencyExists) {
    try {
      await fsp.access(durabilityMarker);
      return nodeModules;
    } catch {
      await fsyncManagedReleaseTree(dependencyRoot);
      await fsp.writeFile(durabilityMarker, "durable-v1\n", { mode: 0o600 });
      await fsyncManagedPath(durabilityMarker);
      await fsyncManagedPath(dependencyRoot);
      return nodeModules;
    }
  }
  const assetName = `fased-hosted-deps-linux-${arch}-${dependencyHash}.tar.gz`;
  const archive = await downloadVerifiedAsset({
    releaseUrl,
    assetName,
    destinationDir: temporaryRoot,
    timeoutMs,
    officialVersion,
  });
  await assertArchiveSafe(archive, "node_modules");
  const staging = `${dependencyRoot}.staging-${process.pid}-${Date.now()}`;
  await fsp.rm(staging, { recursive: true, force: true });
  await extractArchive(archive, staging, timeoutMs);
  await fsp.access(path.join(staging, "node_modules"));
  await fsyncManagedReleaseTree(staging);
  const stagingMarker = path.join(staging, ".fased-durable-v1");
  await fsp.writeFile(stagingMarker, "durable-v1\n", { mode: 0o600 });
  await fsyncManagedPath(stagingMarker);
  await fsyncManagedPath(staging);
  await fsp.mkdir(path.dirname(dependencyRoot), { recursive: true });
  try {
    await fsp.rename(staging, dependencyRoot);
  } catch (error) {
    if (error?.code !== "EEXIST" && error?.code !== "ENOTEMPTY") {
      throw error;
    }
    await fsp.rm(staging, { recursive: true, force: true });
  }
  await fsyncManagedPath(path.dirname(dependencyRoot));
  await fsp.access(nodeModules);
  try {
    await fsp.access(durabilityMarker);
  } catch {
    await fsyncManagedReleaseTree(dependencyRoot);
    await fsp.writeFile(durabilityMarker, "durable-v1\n", { mode: 0o600 });
    await fsyncManagedPath(durabilityMarker);
    await fsyncManagedPath(dependencyRoot);
  }
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

function hostedUpdaterError(error, ambiguous = Boolean(error?.hostUpdaterAmbiguous)) {
  const message = error instanceof Error ? error.message : String(error);
  let normalized;
  if (
    /unsupported|schema|transactionId|request contains unsupported fields|updater is unavailable|ENOENT|ECONNREFUSED|closed before|invalid response/i.test(
      message,
    )
  ) {
    normalized = new Error(PRE_V2_HOSTING_MIGRATION_MESSAGE, { cause: error });
  } else {
    normalized = error instanceof Error ? error : new Error(message);
  }
  normalized.hostUpdaterAmbiguous = ambiguous;
  return normalized;
}

async function requestHostedSignerTransaction(
  operation,
  transactionId,
  version,
  timeoutMs,
  socketPath = process.env.FASED_HOST_UPDATER_SOCKET || HOST_UPDATER_SOCKET,
) {
  if (
    !new Set([
      "prepareRelease",
      "activateRelease",
      "authorizeGatewayRelease",
      "gateGatewayRelease",
      "commitRelease",
      "rollbackRelease",
    ]).has(operation)
  ) {
    throw new Error(`unsupported host updater operation: ${operation}`);
  }
  if (!TRANSACTION_ID_PATTERN.test(transactionId)) {
    throw new Error("host updater transaction ID must be a UUIDv4");
  }
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs);
    let body = "";
    let settled = false;
    let requestSent = false;
    const fail = (error, ambiguous = requestSent) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      reject(hostedUpdaterError(error, ambiguous));
    };
    socket.once("connect", () => {
      requestSent = true;
      socket.write(
        `${JSON.stringify({
          schemaVersion: HOST_UPDATER_SCHEMA_VERSION,
          op: operation,
          transactionId,
          version,
        })}\n`,
      );
    });
    socket.on("data", (chunk) => {
      body += chunk;
      const newline = body.indexOf("\n");
      if (newline < 0 || settled) {
        return;
      }
      try {
        const response = JSON.parse(body.slice(0, newline));
        if (
          !response?.ok ||
          response.transactionId !== transactionId ||
          response.version !== version
        ) {
          const explicitPreV2Rejection =
            response?.ok === false &&
            /unsupported|schema|transactionId|request contains unsupported fields/i.test(
              response?.error || "",
            );
          fail(
            new Error(response?.error || `host updater rejected ${operation}`),
            !explicitPreV2Rejection,
          );
          return;
        }
        settled = true;
        socket.destroy();
        resolve(response);
      } catch (error) {
        fail(
          new Error(`host updater returned an invalid response: ${error.message}`, {
            cause: error,
          }),
        );
      }
    });
    socket.once("timeout", () => fail(new Error(`host updater timed out during ${operation}`)));
    socket.once("error", (error) =>
      fail(
        new Error(`root-managed signer updater is unavailable (${error.message})`, {
          cause: error,
        }),
      ),
    );
    socket.once("close", () => {
      if (!settled) {
        fail(new Error("host updater closed before returning a response"));
      }
    });
  });
}

async function requestHostedSignerTransactionWithRetry(
  operation,
  transactionId,
  version,
  timeoutMs,
  socketPath,
) {
  let lastError;
  let sawAmbiguousFailure = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await requestHostedSignerTransaction(
        operation,
        transactionId,
        version,
        timeoutMs,
        socketPath,
      );
    } catch (error) {
      lastError = error;
      sawAmbiguousFailure ||= error?.hostUpdaterAmbiguous === true;
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }
  if (lastError) {
    lastError.hostUpdaterAmbiguous = sawAmbiguousFailure;
  }
  throw lastError;
}

export async function authorizePreactivatedHostedGateway({
  transactionId,
  targetVersion,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  return await requestHostedSignerTransactionWithRetry(
    "authorizeGatewayRelease",
    transactionId,
    targetVersion,
    timeoutMs,
  );
}

async function restartHostedGateway() {
  const systemctl = fs.existsSync("/usr/bin/systemctl") ? "/usr/bin/systemctl" : "/bin/systemctl";
  const shown = await runFile(systemctl, [
    "show",
    "fased-gateway.service",
    "--property",
    "MainPID",
    "--value",
  ]);
  const pid = Number.parseInt(shown.stdout.trim(), 10);
  if (!shown.ok || !Number.isSafeInteger(pid) || pid <= 1) {
    throw new Error(`Hosted Gateway MainPID unavailable: ${shown.stderr.trim()}`);
  }
  const status = await fsp.readFile(`/proc/${pid}/status`, "utf8");
  const ownerUid = Number.parseInt(status.match(/^Uid:\s+(\d+)/m)?.[1] ?? "", 10);
  const currentUid = typeof process.getuid === "function" ? process.getuid() : -1;
  if (!Number.isSafeInteger(ownerUid) || ownerUid !== currentUid) {
    throw new Error("Hosted Gateway process is not owned by the Fased app account.");
  }
  process.kill(pid, "SIGTERM");
}

async function quiesceHostedGateway(timeoutMs = 30_000) {
  const systemctl = fs.existsSync("/usr/bin/systemctl") ? "/usr/bin/systemctl" : "/bin/systemctl";
  const deadline = Date.now() + Math.min(timeoutMs, 30_000);
  let signaledPid = null;
  while (Date.now() < deadline) {
    const shown = await runFile(systemctl, [
      "show",
      "fased-gateway.service",
      "--property",
      "MainPID",
      "--value",
    ]);
    if (!shown.ok) {
      throw new Error(`Hosted Gateway state is unavailable: ${shown.stderr.trim()}`);
    }
    const pid = Number.parseInt(shown.stdout.trim(), 10);
    if (!Number.isSafeInteger(pid) || pid <= 1) {
      return;
    }
    if (pid !== signaledPid) {
      let status;
      try {
        status = await fsp.readFile(`/proc/${pid}/status`, "utf8");
      } catch (error) {
        if (error?.code === "ENOENT") {
          continue;
        }
        throw error;
      }
      const ownerUid = Number.parseInt(status.match(/^Uid:\s+(\d+)/m)?.[1] ?? "", 10);
      const currentUid = typeof process.getuid === "function" ? process.getuid() : -1;
      if (!Number.isSafeInteger(ownerUid) || ownerUid !== currentUid) {
        throw new Error("Hosted Gateway process is not owned by the Fased app account.");
      }
      process.kill(pid, "SIGTERM");
      signaledPid = pid;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Hosted Gateway did not quiesce before the app/signer switch.");
}

async function refreshGateway(runtimeRoot, manifest, timeoutMs, allowInactiveHosted = false) {
  const cli = path.join(runtimeRoot, "fased.mjs");
  const env = {
    ...process.env,
    FASED_STATE_DIR: manifest.stateDir,
    FASED_CONFIG_PATH: manifest.configPath,
    FASED_MANAGED_INSTALL_MANIFEST: path.join(manifest.stateDir, "install.json"),
    FASED_MANAGED_RUNTIME_ROOT: runtimeRoot,
    FASED_RUNTIME_SOURCE: "managed-package",
  };
  if (manifest.profile === "hosting") {
    try {
      await restartHostedGateway();
    } catch (error) {
      if (!allowInactiveHosted || !error.message.includes("MainPID unavailable")) {
        throw error;
      }
    }
  } else {
    const installed = await runFile(process.execPath, [cli, "gateway", "install", "--force"], {
      env,
      timeoutMs,
    });
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
      if (manifest.profile === "hosting") {
        await probeHostedSignerCompatibility(
          process.env.FASED_WALLET_LOCAL_SIGNER_SOCKET || "/run/fased-signerd/app.sock",
          Math.min(timeoutMs, 5000),
        );
      }
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `Gateway did not report runtime v${manifest.runtime.activeVersion}: ${JSON.stringify(last?.payload || last?.error || null)}`,
  );
}

async function probeHostedSignerCompatibility(socketPath, timeoutMs = 5000) {
  const requiredFeatures = [
    "failClosedPolicies",
    "policyHashes",
    "durableCaps",
    "atomicIdempotency",
    "ambiguousBroadcastReconciliation",
    "signerOwnedKeys",
    "typedSolanaTransactions",
  ];
  const socketStat = await fsp.lstat(socketPath).catch((error) => {
    throw new Error(`hosted signer socket is unavailable to the app account: ${error.message}`, {
      cause: error,
    });
  });
  const socketMode = socketStat.mode & 0o777;
  if (socketStat.isSymbolicLink() || !socketStat.isSocket() || (socketMode & 0o007) !== 0) {
    throw new Error("hosted signer socket must be a non-world-accessible Unix socket");
  }
  const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (currentUid !== null && socketStat.uid !== currentUid) {
    const groups = new Set([
      ...(typeof process.getgid === "function" ? [process.getgid()] : []),
      ...(typeof process.getgroups === "function" ? process.getgroups() : []),
    ]);
    if ((socketMode & 0o020) === 0 || !groups.has(socketStat.gid)) {
      throw new Error("hosted signer socket group is not accessible to the app account");
    }
  }
  const response = await new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs);
    let body = "";
    let settled = false;
    const fail = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      reject(error);
    };
    socket.once("connect", () => socket.write(`${JSON.stringify({ op: "health" })}\n`));
    socket.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > 1024 * 1024) {
        fail(new Error("hosted signer health response is too large"));
        return;
      }
      const newline = body.indexOf("\n");
      if (newline < 0 || settled) {
        return;
      }
      settled = true;
      socket.destroy();
      try {
        resolve(JSON.parse(body.slice(0, newline)));
      } catch (error) {
        reject(new Error("hosted signer health response is invalid", { cause: error }));
      }
    });
    socket.once("timeout", () => fail(new Error("hosted signer health probe timed out")));
    socket.once("error", (error) =>
      fail(new Error(`hosted signer socket is unavailable to the app account: ${error.message}`)),
    );
  });
  const result = response?.result;
  const protocol = result?.capabilities?.protocol;
  const features = new Set(result?.capabilities?.features || []);
  const missing = requiredFeatures.filter((feature) => !features.has(feature));
  const policies = result?.policies;
  const policyIds = new Set();
  const policiesValid =
    Array.isArray(policies) &&
    policies.every((policy) => {
      const walletId = String(policy?.walletId || "").trim();
      const valid =
        walletId.length > 0 &&
        !policyIds.has(walletId) &&
        Number.isSafeInteger(policy?.version) &&
        policy.version > 0 &&
        /^sha256:[a-f0-9]{64}$/.test(policy?.hash || "");
      policyIds.add(walletId);
      return valid;
    });
  if (
    response?.ok !== true ||
    result?.ready !== true ||
    result?.keystoreType !== "signer-owned-v2" ||
    protocol?.current !== 2 ||
    protocol?.min > 2 ||
    protocol?.max < 2 ||
    missing.length > 0 ||
    !policiesValid
  ) {
    throw new Error(
      `hosted Gateway-to-signer compatibility check failed${missing.length ? `; missing ${missing.join(",")}` : ""}`,
    );
  }
  return response;
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

function hostedTransactionJournalPath(paths) {
  return path.join(paths.stateDir, "hosted-update-transaction.json");
}

function managedReleaseRoot(paths, value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is missing from the hosted update journal`);
  }
  const resolved = path.resolve(value);
  const relative = path.relative(path.resolve(paths.releasesDir), resolved);
  if (
    !relative ||
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    relative.includes(path.sep)
  ) {
    throw new Error(`${label} is outside the managed releases directory`);
  }
  return resolved;
}

function validateHostedTransactionJournal(paths, value) {
  if (
    !value ||
    typeof value !== "object" ||
    value.schemaVersion !== HOSTED_TRANSACTION_SCHEMA_VERSION ||
    !HOSTED_TRANSACTION_PHASES.has(value.phase) ||
    !TRANSACTION_ID_PATTERN.test(value.transactionId || "")
  ) {
    throw new Error("hosted application update journal is invalid");
  }
  const targetVersion = String(value.targetVersion || "").trim();
  const previousVersion = String(value.previousVersion || "").trim();
  if (
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(targetVersion) ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(previousVersion)
  ) {
    throw new Error("hosted application update journal contains an invalid release version");
  }
  const targetRoot = managedReleaseRoot(paths, value.targetRoot, "targetRoot");
  const previousRoot = managedReleaseRoot(paths, value.previousRoot, "previousRoot");
  if (
    value.nextManifest?.profile !== "hosting" ||
    value.previousManifest?.profile !== "hosting" ||
    value.nextManifest?.runtime?.activeVersion !== targetVersion ||
    value.previousManifest?.runtime?.activeVersion !== previousVersion
  ) {
    throw new Error("hosted application update journal manifests do not match the transaction");
  }
  return {
    ...value,
    transactionId: value.transactionId.toLowerCase(),
    targetVersion,
    previousVersion,
    targetRoot,
    previousRoot,
  };
}

async function fsyncManagedPath(targetPath) {
  const handle = await fsp.open(targetPath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function fsyncManagedReleaseTree(rootPath) {
  const directories = [];
  const pending = [rootPath];
  while (pending.length > 0) {
    const current = pending.pop();
    directories.push(current);
    const directory = await fsp.opendir(current);
    for await (const entry of directory) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.isFile()) {
        await fsyncManagedPath(entryPath);
      }
    }
  }
  for (const directory of directories.toReversed()) {
    await fsyncManagedPath(directory);
  }
}

async function syncManagedActivation(paths) {
  await fsyncManagedPath(paths.manifestPath);
  await Promise.all([
    fsyncManagedPath(paths.stateDir),
    fsyncManagedPath(paths.runtimeDir),
    fsyncManagedPath(path.dirname(paths.compatibilityPackageRoot)),
  ]);
}

async function readHostedTransactionJournal(paths) {
  try {
    return validateHostedTransactionJournal(
      paths,
      JSON.parse(await fsp.readFile(hostedTransactionJournalPath(paths), "utf8")),
    );
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeHostedTransactionJournal(paths, journal) {
  const next = validateHostedTransactionJournal(paths, {
    ...journal,
    schemaVersion: HOSTED_TRANSACTION_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
  });
  const journalPath = hostedTransactionJournalPath(paths);
  await atomicWriteJson(journalPath, next, 0o600);
  await fsyncManagedPath(journalPath);
  await fsyncManagedPath(path.dirname(journalPath));
  return next;
}

async function removeHostedTransactionJournal(paths) {
  const journalPath = hostedTransactionJournalPath(paths);
  await fsp.rm(journalPath, { force: true });
  await fsyncManagedPath(path.dirname(journalPath));
}

async function activateHostedApplication(paths, journal) {
  if (path.resolve(journal.previousRoot) !== path.resolve(journal.targetRoot)) {
    await atomicSymlink(journal.previousRoot, paths.previousLink);
  }
  await atomicSymlink(journal.targetRoot, paths.currentLink);
  await replaceCompatibilityLink(paths);
  await atomicWriteJson(paths.manifestPath, journal.nextManifest, 0o600);
  await syncManagedActivation(paths);
}

async function restoreHostedApplication(paths, journal) {
  await atomicSymlink(journal.previousRoot, paths.currentLink);
  await replaceCompatibilityLink(paths);
  await atomicWriteJson(paths.manifestPath, journal.previousManifest, 0o600);
  await syncManagedActivation(paths);
}

async function rollbackHostedReleaseTransaction(journal, operations, originalError = null) {
  const failures = [];
  let gatewayQuiesced = false;
  let applicationRestored = false;
  let signerRestored = false;
  try {
    journal = await operations.writePhase(journal, "rolling-back");
  } catch (error) {
    failures.push(`journal: ${error.message}`);
  }
  try {
    await operations.quiesceGateway(journal);
    gatewayQuiesced = true;
  } catch (error) {
    failures.push(`Gateway quiesce: ${error.message}`);
  }
  if (gatewayQuiesced) {
    try {
      await operations.signerRequest("gateGatewayRelease", journal);
    } catch (error) {
      failures.push(`Gateway transaction gate: ${error.message}`);
    }
    if (failures.length === 0) {
      try {
        await operations.restoreApplication(journal);
        applicationRestored = true;
      } catch (error) {
        failures.push(`application restore: ${error.message}`);
      }
      if (applicationRestored) {
        try {
          await operations.signerRequest("rollbackRelease", journal);
          signerRestored = true;
        } catch (error) {
          failures.push(`signer rollback: ${error.message}`);
        }
      }
    }
  }
  if (applicationRestored && signerRestored) {
    try {
      journal = await operations.writePhase(journal, "rollback-ready");
      await operations.refreshPrevious(journal);
    } catch (error) {
      failures.push(`previous Gateway refresh: ${error.message}`);
    }
  } else {
    failures.push("previous Gateway refresh skipped until both app and signer are restored");
  }
  if (failures.length > 0) {
    const error = new Error(
      `Hosted update recovery is incomplete (${failures.join("; ")}). Re-run fased update after correcting the reported failure.`,
      { cause: originalError || undefined },
    );
    error.code = "HOSTED_ROLLBACK_INCOMPLETE";
    throw error;
  }
  await operations.removeJournal();
  if (originalError) {
    const error = new Error(
      `Update rolled back after coordinated health verification failed: ${originalError.message}`,
      { cause: originalError },
    );
    error.code = "HOSTED_UPDATE_ROLLED_BACK";
    throw error;
  }
  return { action: "rolled-back", journal };
}

async function coordinateHostedReleaseTransaction(journal, operations) {
  let durableCommitDecision = journal.phase === "gateway-verified";
  try {
    if (journal.phase === "prepared") {
      journal = await operations.writePhase(journal, "quiescing");
      await operations.quiesceGateway(journal);
      await operations.activateApplication(journal);
      journal = await operations.writePhase(journal, "app-active");
    }
    if (journal.phase === "app-active") {
      await operations.signerRequest("activateRelease", journal);
      journal = await operations.writePhase(journal, "signer-active");
    }
    if (journal.phase === "signer-preactivated") {
      await operations.quiesceGateway(journal);
      await operations.activateApplication(journal);
      journal = await operations.writePhase(journal, "signer-active");
    }
    if (journal.phase === "signer-active") {
      await operations.signerRequest("authorizeGatewayRelease", journal);
      await operations.verifyGateway(journal);
      journal = await operations.writePhase(journal, "gateway-verified");
      durableCommitDecision = true;
    }
    if (journal.phase !== "gateway-verified") {
      throw new Error(`cannot resume hosted update from phase ${journal.phase}`);
    }
    await operations.signerRequest("commitRelease", journal);
    await operations.finalizeApplication(journal);
    await operations.removeJournal();
    return { action: "committed", journal };
  } catch (error) {
    if (durableCommitDecision) {
      const pending = new Error(
        `The new Gateway and signer passed health verification, but final commit cleanup is pending: ${error.message}. Re-run fased update to finish the committed release; do not downgrade manually.`,
        { cause: error },
      );
      pending.code = "HOSTED_COMMIT_PENDING";
      throw pending;
    }
    return await rollbackHostedReleaseTransaction(journal, operations, error);
  }
}

function hostedTransactionOperations(paths, timeoutMs) {
  return {
    activateApplication: async (journal) => await activateHostedApplication(paths, journal),
    restoreApplication: async (journal) => {
      await restoreHostedApplication(paths, journal);
      await updateStableComponents(paths, journal.previousRoot, true);
    },
    quiesceGateway: async () => await quiesceHostedGateway(timeoutMs),
    signerRequest: async (operation, journal) =>
      await requestHostedSignerTransactionWithRetry(
        operation,
        journal.transactionId,
        journal.targetVersion,
        timeoutMs,
      ),
    verifyGateway: async (journal) =>
      await refreshGateway(journal.targetRoot, journal.nextManifest, timeoutMs, true),
    refreshPrevious: async (journal) =>
      await refreshGateway(journal.previousRoot, journal.previousManifest, timeoutMs, true),
    finalizeApplication: async (journal) => {
      await updateStableComponents(paths, journal.targetRoot, true);
      await cleanupReleases(paths, [journal.targetRoot, journal.previousRoot]);
    },
    writePhase: async (journal, phase) =>
      await writeHostedTransactionJournal(paths, { ...journal, phase }),
    removeJournal: async () => await removeHostedTransactionJournal(paths),
  };
}

export async function beginPreactivatedHostedTransaction({
  paths,
  transactionId,
  targetVersion,
  previousVersion,
  targetRoot,
  previousRoot,
  nextManifest,
  previousManifest,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const operations = hostedTransactionOperations(paths, timeoutMs);
  let journal = await readHostedTransactionJournal(paths);
  if (journal) {
    if (
      journal.transactionId !== transactionId.toLowerCase() ||
      journal.targetVersion !== targetVersion ||
      path.resolve(journal.targetRoot) !== path.resolve(targetRoot) ||
      path.resolve(journal.previousRoot) !== path.resolve(previousRoot)
    ) {
      throw new Error(
        `another hosted application transaction is unfinished (${journal.transactionId}, v${journal.targetVersion})`,
      );
    }
  } else {
    journal = await writeHostedTransactionJournal(paths, {
      schemaVersion: HOSTED_TRANSACTION_SCHEMA_VERSION,
      transactionId,
      targetVersion,
      previousVersion,
      targetRoot,
      previousRoot,
      nextManifest,
      previousManifest,
      phase: "prepared",
      createdAt: new Date().toISOString(),
    });
  }

  if (journal.phase === "prepared") {
    try {
      await operations.signerRequest("prepareRelease", journal);
    } catch (error) {
      if (error?.hostUpdaterAmbiguous !== true) {
        await operations.removeJournal();
      } else {
        try {
          await operations.signerRequest("rollbackRelease", journal);
          await operations.removeJournal();
        } catch {
          // Preserve the shared transaction ID for deterministic repair recovery.
        }
      }
      throw error;
    }
  }

  try {
    if (journal.phase === "prepared") {
      journal = await operations.writePhase(journal, "quiescing");
    }
    if (journal.phase === "quiescing") {
      await operations.quiesceGateway(journal);
      await operations.signerRequest("activateRelease", journal);
      journal = await operations.writePhase(journal, "signer-preactivated");
    }
    if (journal.phase === "signer-preactivated") {
      await operations.quiesceGateway(journal);
      await operations.activateApplication(journal);
      journal = await operations.writePhase(journal, "signer-active");
    }
    if (journal.phase === "app-active") {
      await operations.signerRequest("activateRelease", journal);
      journal = await operations.writePhase(journal, "signer-active");
    }
    if (journal.phase === "signer-active") {
      await operations.signerRequest("authorizeGatewayRelease", journal);
    }
    if (journal.phase !== "signer-active" && journal.phase !== "gateway-verified") {
      throw new Error(`cannot stage hosted repair from phase ${journal.phase}`);
    }
    return journal;
  } catch (error) {
    if (journal.phase === "gateway-verified") {
      const pending = new Error(
        `Hosted repair already made its durable commit decision: ${error.message}`,
        { cause: error },
      );
      pending.code = "HOSTED_COMMIT_PENDING";
      throw pending;
    }
    return await rollbackHostedReleaseTransaction(journal, operations, error);
  }
}

async function recoverHostedReleaseTransaction(paths, timeoutMs) {
  const journal = await readHostedTransactionJournal(paths);
  if (!journal) {
    return { recovered: false };
  }
  const operations = hostedTransactionOperations(paths, timeoutMs);
  if (journal.phase === "gateway-verified" || journal.phase === "signer-active") {
    return { recovered: true, ...(await coordinateHostedReleaseTransaction(journal, operations)) };
  }
  return {
    recovered: true,
    ...(await rollbackHostedReleaseTransaction(journal, operations)),
  };
}

async function runHostedTransactionControl(action, timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (!new Set(["finalize", "recover", "rollback"]).has(action)) {
    throw new Error("hosted-transaction requires finalize, recover, or rollback");
  }
  const paths = resolveManagedRuntimePaths();
  const releaseLock = await acquireUpdateLock(paths.stateDir);
  try {
    const journal = await readHostedTransactionJournal(paths);
    if (!journal) {
      if (action === "finalize") {
        const manifest = readManagedInstallManifest(paths.manifestPath);
        const currentRoot = await resolveLinkTarget(paths.currentLink);
        if (!manifest || manifest.profile !== "hosting" || !currentRoot) {
          throw new Error("hosted managed runtime is unavailable for final verification");
        }
        await refreshGateway(currentRoot, manifest, timeoutMs, true);
        return { action: "verified-current" };
      }
      return { action: "none" };
    }
    const operations = hostedTransactionOperations(paths, timeoutMs);
    if (action === "rollback") {
      if (journal.phase === "gateway-verified") {
        return await coordinateHostedReleaseTransaction(journal, operations);
      }
      return await rollbackHostedReleaseTransaction(journal, operations);
    }
    if (
      action === "finalize" &&
      !new Set(["signer-active", "gateway-verified"]).has(journal.phase)
    ) {
      throw new Error(`hosted repair cannot finalize from phase ${journal.phase}`);
    }
    return await recoverHostedReleaseTransaction(paths, timeoutMs);
  } finally {
    await releaseLock();
  }
}

async function updateStableComponents(paths, runtimeRoot, durable = false) {
  const scripts = path.join(runtimeRoot, "scripts");
  const stablePaths = [
    paths.launcherPath,
    paths.serviceLauncherPath,
    path.join(paths.updaterDir, "managed-runtime-layout.mjs"),
    paths.updaterPath,
  ];
  await copyExecutable(path.join(scripts, "fased-managed-launcher.sh"), stablePaths[0]);
  await copyExecutable(path.join(scripts, "fased-managed-service.sh"), stablePaths[1]);
  await copyExecutable(path.join(scripts, "managed-runtime-layout.mjs"), stablePaths[2]);
  await copyExecutable(path.join(scripts, "fased-managed-updater.mjs"), stablePaths[3]);
  if (!durable) {
    return;
  }
  for (const stablePath of stablePaths) {
    await fsyncManagedPath(stablePath);
  }
  for (const directory of new Set(stablePaths.map((value) => path.dirname(value)))) {
    await fsyncManagedPath(directory);
  }
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
  let existingManifest = readManagedInstallManifest(paths.manifestPath);
  if (!existingManifest) {
    throw new Error(
      "Managed installation manifest is missing; run the official repair installer once.",
    );
  }
  let currentRoot = await resolveLinkTarget(paths.currentLink);
  let currentVersion = currentRoot
    ? (await readPackageVersion(currentRoot)) || existingManifest.runtime.activeVersion
    : existingManifest.runtime.activeVersion;
  let targetVersion;

  if (options.status || options.dryRun) {
    targetVersion = await measureStage(timings, "release resolution", () =>
      resolveTargetVersion(options),
    );
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
    if (existingManifest.profile === "hosting") {
      await measureStage(timings, "interrupted hosted transaction recovery", () =>
        recoverHostedReleaseTransaction(paths, options.timeoutMs),
      );
      existingManifest = readManagedInstallManifest(paths.manifestPath);
      if (!existingManifest) {
        throw new Error("Managed installation manifest is invalid after hosted update recovery.");
      }
      currentRoot = await resolveLinkTarget(paths.currentLink);
      currentVersion = currentRoot
        ? (await readPackageVersion(currentRoot)) || existingManifest.runtime.activeVersion
        : existingManifest.runtime.activeVersion;
    }
    targetVersion = await measureStage(timings, "release resolution", () =>
      resolveTargetVersion(options),
    );
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
    const officialVersion = baseUrl === DEFAULT_RELEASE_BASE_URL ? targetVersion : null;
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
          officialVersion,
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
          officialVersion,
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
      if (existingManifest.profile === "hosting") {
        await measureStage(timings, "release durability", async () => {
          await fsyncManagedReleaseTree(releaseRoot);
          await fsyncManagedPath(paths.releasesDir);
        });
      }

      const nextManifest = buildManagedInstallManifest({
        paths,
        profile: existingManifest.profile,
        version: targetVersion,
        dependencyHash: metadata.dependencyHash,
        previousVersion: currentVersion,
      });
      if (existingManifest.profile === "hosting") {
        if (!previousRoot) {
          throw new Error("Hosted transactional update requires an active previous runtime.");
        }
        let journal = await writeHostedTransactionJournal(paths, {
          schemaVersion: HOSTED_TRANSACTION_SCHEMA_VERSION,
          transactionId: randomUUID(),
          targetVersion,
          previousVersion: currentVersion,
          targetRoot: releaseRoot,
          previousRoot,
          nextManifest,
          previousManifest,
          phase: "prepared",
          createdAt: new Date().toISOString(),
        });
        const operations = hostedTransactionOperations(paths, options.timeoutMs);
        try {
          await measureStage(timings, "root signer release preparation", () =>
            operations.signerRequest("prepareRelease", journal),
          );
        } catch (error) {
          if (error?.hostUpdaterAmbiguous !== true) {
            await operations.removeJournal();
          } else {
            try {
              await operations.signerRequest("rollbackRelease", journal);
              await operations.removeJournal();
            } catch {
              // Preserve the transaction ID for deterministic recovery if prepare was ambiguous.
            }
          }
          throw error;
        }
        try {
          await measureStage(timings, "coordinated activation and health", async () => {
            const result = await coordinateHostedReleaseTransaction(journal, operations);
            journal = result.journal;
          });
          activated = true;
        } catch (error) {
          if (error?.code === "HOSTED_COMMIT_PENDING") {
            activated = true;
          }
          throw error;
        }
      } else {
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
      }
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
  if (argv[0] === "hosted-transaction") {
    const action = argv[1] || "recover";
    let timeoutMs = DEFAULT_TIMEOUT_MS;
    if (argv.length > 2) {
      if (argv[2] !== "--timeout" || !/^\d+$/.test(argv[3] || "") || argv.length !== 4) {
        throw new Error("hosted-transaction accepts only --timeout <seconds>");
      }
      timeoutMs = Number.parseInt(argv[3], 10) * 1000;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
        throw new Error("--timeout must be a positive integer (seconds)");
      }
    }
    const result = await runHostedTransactionControl(action, timeoutMs);
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
    return;
  }
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
  authorizePreactivatedHostedGateway,
  beginPreactivatedHostedTransaction,
  coordinateHostedReleaseTransaction,
  hostedUpdaterError,
  probeGatewayIdentity,
  probeHostedSignerCompatibility,
  readHostedTransactionJournal,
  recoverHostedReleaseTransaction,
  requestHostedSignerTransaction,
  requestHostedSignerTransactionWithRetry,
  rollbackHostedReleaseTransaction,
  restartHostedGateway,
  runHostedTransactionControl,
  validateHostedTransactionJournal,
};
