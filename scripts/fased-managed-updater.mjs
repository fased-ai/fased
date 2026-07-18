#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
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
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { readHostedReleaseManifestV2, verifyManifestArtifact } from "./hosted-release-manifest.mjs";
import {
  assertManagedRuntime,
  atomicSymlink,
  atomicWriteJson,
  buildManagedInstallManifest,
  copyExecutable,
  readHostedRuntimeMetadata,
  readHostedReleaseBinding,
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
const LOCAL_SIGNER_TRANSACTION_SCHEMA_VERSION = 1;
const LOCAL_SIGNER_TRANSACTION_PHASES = new Set([
  "staging",
  "quiesced",
  "snapshotted",
  "prepared",
  "activating",
  "candidate-active",
  "committing",
  "rolling-back",
]);
const LOCAL_SIGNER_REQUIRED_FEATURES = [
  "failClosedPolicies",
  "policyHashes",
  "durableCaps",
  "atomicIdempotency",
  "ambiguousBroadcastReconciliation",
  "signerOwnedKeys",
  "typedSolanaTransactions",
  "atomicMultiAssetCaps",
  "signerControlledNativeFeeCaps",
];

export const PRE_V2_HOSTING_MIGRATION_MESSAGE = [
  "This hosted installation needs the one-time signer-v2 security migration before it can update.",
  "From a VPS provider console or a root SSH session, run:",
  "Follow the manual release-asset and GitHub attestation procedure at https://docs.fased.ai/install/vps#advanced-verify-the-bootstrap-first, then run the verified tagged install.sh with --repair-hosting --release vX.Y.Z.",
  "Never run /home/app/fased/install.sh with sudo or as root.",
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
  const gh = ["/usr/bin/gh", "/usr/local/bin/gh", "/opt/homebrew/bin/gh"].find((candidate) =>
    fs.existsSync(candidate),
  );
  if (!gh) {
    throw new Error(
      "GitHub CLI with `gh attestation verify` is required for exact tagged Fased release assets.",
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
        PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
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

async function downloadManifestBoundAsset({
  releaseUrl,
  artifact,
  destinationDir,
  timeoutMs,
  officialVersion,
}) {
  const destination = path.join(destinationDir, artifact.asset);
  await downloadToFile(`${releaseUrl}/${artifact.asset}`, destination, timeoutMs);
  await verifyManifestArtifact(destination, artifact);
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
  manifestArtifact,
}) {
  const dependencyRoot = path.join(
    paths.stateDir,
    "install-cache",
    "hosted-dependencies",
    manifestArtifact ? `${dependencyHash}-${manifestArtifact.sha256}` : dependencyHash,
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
  const assetName =
    manifestArtifact?.asset || `fased-hosted-deps-linux-${arch}-${dependencyHash}.tar.gz`;
  const archive = manifestArtifact
    ? await downloadManifestBoundAsset({
        releaseUrl,
        artifact: manifestArtifact,
        destinationDir: temporaryRoot,
        timeoutMs,
        officialVersion,
      })
    : await downloadVerifiedAsset({
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

function parseSignerReleaseIdentity(value, expectedVersion) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("signer release identity is missing");
  }
  if (Object.keys(value).toSorted().join(",") !== "buildInputDigest,commit,development,version") {
    throw new Error("signer release identity contains unsupported fields");
  }
  if (
    (expectedVersion !== undefined && value.version !== expectedVersion) ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(value.version || "") ||
    !/^[a-f0-9]{40}$/.test(value.commit || "") ||
    !/^sha256:[a-f0-9]{64}$/.test(value.buildInputDigest || "") ||
    value.development !== false
  ) {
    throw new Error("signer release identity is development, malformed, or mismatched");
  }
  return Object.freeze({
    version: value.version,
    commit: value.commit,
    buildInputDigest: value.buildInputDigest,
    development: false,
  });
}

function signerReleaseIdentitiesEqual(left, right) {
  return (
    left?.version === right?.version &&
    left?.commit === right?.commit &&
    left?.buildInputDigest === right?.buildInputDigest &&
    left?.development === false &&
    right?.development === false
  );
}

function canonicalReleaseJSON(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalReleaseJSON(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonicalReleaseJSON(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
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
        if (response.release !== undefined) {
          response.release = parseSignerReleaseIdentity(response.release, version);
        } else if (
          new Set(["prepareRelease", "activateRelease", "authorizeGatewayRelease"]).has(operation)
        ) {
          fail(new Error(`host updater ${operation} response omitted signer release identity`));
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

async function refreshGateway(
  runtimeRoot,
  manifest,
  timeoutMs,
  allowInactiveHosted = false,
  expectedSignerRelease,
  hostedServiceAlreadyRestarted = false,
) {
  const cli = path.join(runtimeRoot, "fased.mjs");
  const env = {
    ...process.env,
    FASED_STATE_DIR: manifest.stateDir,
    FASED_CONFIG_PATH: manifest.configPath,
    FASED_MANAGED_INSTALL_MANIFEST: path.join(manifest.stateDir, "install.json"),
    FASED_MANAGED_RUNTIME_ROOT: runtimeRoot,
    FASED_RUNTIME_SOURCE: "managed-package",
  };
  if (manifest.profile === "hosting" && !hostedServiceAlreadyRestarted) {
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
          expectedSignerRelease,
          manifest.runtime.activeVersion,
          manifest.release?.signer?.capabilities,
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

async function probeHostedSignerCompatibility(
  socketPath,
  timeoutMs = 5000,
  expectedRelease,
  expectedVersion = expectedRelease?.version,
  expectedCapabilities,
) {
  const requiredFeatures = [
    "failClosedPolicies",
    "policyHashes",
    "durableCaps",
    "atomicIdempotency",
    "ambiguousBroadcastReconciliation",
    "signerOwnedKeys",
    "typedSolanaTransactions",
    "atomicMultiAssetCaps",
    "signerControlledNativeFeeCaps",
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
  let signerRelease = null;
  try {
    signerRelease = parseSignerReleaseIdentity(result?.release, expectedVersion);
  } catch {
    signerRelease = null;
  }
  const releaseMatches =
    signerRelease !== null &&
    (expectedRelease === undefined || signerReleaseIdentitiesEqual(signerRelease, expectedRelease));
  const capabilitiesMatch =
    expectedCapabilities === undefined ||
    canonicalReleaseJSON(result?.capabilities) === canonicalReleaseJSON(expectedCapabilities);
  if (
    response?.ok !== true ||
    result?.ready !== true ||
    result?.keystoreType !== "signer-owned-v2" ||
    protocol?.current !== 2 ||
    protocol?.min > 2 ||
    protocol?.max < 2 ||
    result?.capabilities?.nativeFeeReservationLamports !== 5_000_000 ||
    missing.length > 0 ||
    !policiesValid ||
    !releaseMatches ||
    !capabilitiesMatch
  ) {
    throw new Error(
      `hosted Gateway-to-signer compatibility check failed${missing.length ? `; missing ${missing.join(",")}` : ""}${result?.capabilities?.nativeFeeReservationLamports !== 5_000_000 ? "; invalid native fee reservation" : ""}${!releaseMatches ? "; signer release identity mismatch" : ""}${!capabilitiesMatch ? "; signer capability contract mismatch" : ""}`,
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
  const signerRelease =
    value.signerRelease == null
      ? null
      : parseSignerReleaseIdentity(value.signerRelease, targetVersion);
  return {
    ...value,
    transactionId: value.transactionId.toLowerCase(),
    targetVersion,
    previousVersion,
    targetRoot,
    previousRoot,
    signerRelease,
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

function hostedTransactionOperations(paths, timeoutMs, options = {}) {
  const targetServiceAlreadyRestarted = options.targetServiceAlreadyRestarted === true;
  return {
    activateApplication: async (journal) => await activateHostedApplication(paths, journal),
    restoreApplication: async (journal) => {
      await restoreHostedApplication(paths, journal);
      await updateStableComponents(paths, journal.previousRoot, true);
    },
    quiesceGateway: async () => await quiesceHostedGateway(timeoutMs),
    signerRequest: async (operation, journal) => {
      const response = await requestHostedSignerTransactionWithRetry(
        operation,
        journal.transactionId,
        journal.targetVersion,
        timeoutMs,
      );
      if (response.release) {
        const manifestSignerRelease = journal.nextManifest?.release?.signer?.release;
        const applicationCommit = journal.nextManifest?.release?.commit;
        if (
          (manifestSignerRelease &&
            !signerReleaseIdentitiesEqual(manifestSignerRelease, response.release)) ||
          (applicationCommit && applicationCommit !== response.release.commit)
        ) {
          throw new Error(
            "attested hosted application and native signer release identities do not match",
          );
        }
        if (
          journal.signerRelease &&
          !signerReleaseIdentitiesEqual(journal.signerRelease, response.release)
        ) {
          throw new Error("root updater changed signer release identity during the transaction");
        }
        journal.signerRelease ??= response.release;
      }
      return response;
    },
    verifyGateway: async (journal) =>
      await refreshGateway(
        journal.targetRoot,
        journal.nextManifest,
        timeoutMs,
        true,
        journal.signerRelease,
        targetServiceAlreadyRestarted,
      ),
    refreshPrevious: async (journal) =>
      await refreshGateway(
        journal.previousRoot,
        journal.previousManifest,
        timeoutMs,
        true,
        journal.previousManifest?.signer?.release,
      ),
    finalizeApplication: async (journal) => {
      if (!journal.signerRelease) {
        throw new Error("cannot commit a hosted runtime without signer release identity");
      }
      journal.nextManifest = {
        ...journal.nextManifest,
        signer: { release: journal.signerRelease },
      };
      await atomicWriteJson(paths.manifestPath, journal.nextManifest, 0o600);
      await syncManagedActivation(paths);
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

async function runHostedTransactionControl(action, timeoutMs = DEFAULT_TIMEOUT_MS, options = {}) {
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
        await refreshGateway(
          currentRoot,
          manifest,
          timeoutMs,
          true,
          manifest.signer?.release,
          options.targetServiceAlreadyRestarted === true,
        );
        return { action: "verified-current" };
      }
      return { action: "none" };
    }
    const operations = hostedTransactionOperations(paths, timeoutMs, options);
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
    if (journal.phase === "gateway-verified" || journal.phase === "signer-active") {
      return await coordinateHostedReleaseTransaction(journal, operations);
    }
    return await rollbackHostedReleaseTransaction(journal, operations);
  } finally {
    await releaseLock();
  }
}

function parseHostedTransactionArgs(argv) {
  const action = argv[1] || "recover";
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let targetServiceAlreadyRestarted = false;
  const seen = new Set();
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (seen.has(argument)) {
      throw new Error(`hosted-transaction received duplicate option ${argument}`);
    }
    seen.add(argument);
    if (argument === "--root-restarted") {
      targetServiceAlreadyRestarted = true;
      continue;
    }
    if (argument === "--timeout") {
      const seconds = argv[index + 1] || "";
      if (!/^\d+$/.test(seconds)) {
        throw new Error("--timeout must be a positive integer (seconds)");
      }
      timeoutMs = Number.parseInt(seconds, 10) * 1000;
      index += 1;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
        throw new Error("--timeout must be a positive integer (seconds)");
      }
      continue;
    }
    throw new Error("hosted-transaction accepts only --timeout <seconds> and --root-restarted");
  }
  if (targetServiceAlreadyRestarted && action !== "finalize") {
    throw new Error("--root-restarted is valid only with hosted-transaction finalize");
  }
  return { action, timeoutMs, targetServiceAlreadyRestarted };
}

async function updateStableComponents(paths, runtimeRoot, durable = false) {
  const scripts = path.join(runtimeRoot, "scripts");
  const stablePaths = [
    paths.launcherPath,
    paths.serviceLauncherPath,
    path.join(paths.updaterDir, "managed-runtime-layout.mjs"),
    path.join(paths.updaterDir, "hosted-release-manifest.mjs"),
    paths.updaterPath,
  ];
  await copyExecutable(path.join(scripts, "fased-managed-launcher.sh"), stablePaths[0]);
  await copyExecutable(path.join(scripts, "fased-managed-service.sh"), stablePaths[1]);
  await copyExecutable(path.join(scripts, "managed-runtime-layout.mjs"), stablePaths[2]);
  await copyExecutable(path.join(scripts, "hosted-release-manifest.mjs"), stablePaths[3]);
  await copyExecutable(path.join(scripts, "fased-managed-updater.mjs"), stablePaths[4]);
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

function resolveLocalSignerPaths(overrides = {}) {
  const managed = resolveManagedRuntimePaths({ stateDir: overrides.stateDir });
  const stateDir = managed.stateDir;
  const materialDir = path.resolve(
    overrides.materialDir ||
      process.env.FASED_WALLET_SIGNER_STATE_DIR ||
      path.join(stateDir, "wallet"),
  );
  const explicitBinary = String(
    overrides.binaryPath || process.env.FASED_WALLET_LOCAL_SIGNER_BIN || "",
  ).trim();
  const binDir = path.resolve(
    overrides.binDir ||
      process.env.FASED_LOCAL_SIGNER_BIN_DIR ||
      (explicitBinary ? path.dirname(explicitBinary) : path.join(stateDir, "bin")),
  );
  const binaryPath = path.resolve(explicitBinary || path.join(binDir, "fased-signerd"));
  const policyTemplateDir = path.resolve(
    process.env.FASED_LOCAL_SIGNER_POLICY_TEMPLATE_DIR ||
      path.join(path.dirname(binDir), "share", "signer-policies"),
  );
  const socketPath = path.resolve(
    overrides.socketPath ||
      process.env.FASED_WALLET_LOCAL_SIGNER_SOCKET ||
      path.join(materialDir, "local-signer.sock"),
  );
  const controlSocketPath = path.resolve(
    overrides.controlSocketPath ||
      process.env.FASED_WALLET_LOCAL_SIGNER_CONTROL_SOCKET ||
      path.join(materialDir, "local-signer-control.sock"),
  );
  const stateDbPath = path.resolve(
    overrides.stateDbPath ||
      process.env.FASED_WALLET_LOCAL_SIGNER_STATE_DB ||
      path.join(materialDir, "signerd-v2.db"),
  );
  const masterKeyPath = path.resolve(
    overrides.masterKeyPath ||
      process.env.FASED_WALLET_LOCAL_SIGNER_MASTER_KEY ||
      path.join(materialDir, "signerd-v2.master.key"),
  );
  const socketBase = path.basename(socketPath).endsWith(".sock")
    ? path.basename(socketPath).slice(0, -5)
    : path.basename(socketPath);
  const pidPath = path.join(path.dirname(socketPath), `${socketBase}.pid`);
  const auditPath = path.join(path.dirname(socketPath), `${socketBase}.audit.jsonl`);
  const updateRoot = path.join(stateDir, "signer-update");
  const resolved = {
    stateDir,
    materialDir,
    binDir,
    binaryPath,
    enrollmentPath: path.join(binDir, "fased-signer-enroll"),
    policyHelperPath: path.join(binDir, "fased-signer-owner-policy.mjs"),
    policyLauncherPath: path.join(binDir, "fased-signer-policy"),
    policyTemplatePaths: [
      "README.md",
      "agent.json.template",
      "mining.json.template",
      "vault.json.template",
      "network.json.template",
    ].map((name) => path.join(policyTemplateDir, name)),
    releaseManifestPath: path.join(binDir, "fased-signerd-release.json"),
    socketPath,
    controlSocketPath,
    stateDbPath,
    masterKeyPath,
    pidPath,
    legacyPidPath: `${socketPath}.pid`,
    auditPath,
    logPath: path.join(materialDir, "local-signer.log"),
    signerEnvPath: path.join(materialDir, "signer.env"),
    updateRoot,
    journalPath: path.join(updateRoot, "transaction.json"),
    transactionsDir: path.join(updateRoot, "transactions"),
  };
  for (const [label, candidate] of [
    ["signer socket", socketPath],
    ["signer control socket", controlSocketPath],
    ["signer state database", stateDbPath],
    ["signer master key", masterKeyPath],
    ["signer PID file", pidPath],
    ["signer audit log", auditPath],
  ]) {
    const relative = path.relative(materialDir, candidate);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(
        `${label} must be inside the Local signer state directory for transactional updates`,
      );
    }
  }
  if (materialDir === path.parse(materialDir).root || materialDir === stateDir) {
    throw new Error("Local signer state directory is too broad for transactional snapshot/restore");
  }
  return resolved;
}

function parseSignerVersionOutput(raw, expectedVersion) {
  const match =
    /^fased-signerd ([^\s]+) commit=([^\s]+) buildInputDigest=([^\s]+) development=(true|false)\s*$/.exec(
      String(raw || ""),
    );
  if (!match) {
    throw new Error("fased-signerd --version returned a malformed release identity");
  }
  const identity = {
    version: match[1],
    commit: match[2],
    buildInputDigest: match[3],
    development: match[4] === "true",
  };
  if (expectedVersion !== undefined && identity.version !== expectedVersion) {
    throw new Error(
      `signer binary version ${identity.version} does not match target ${expectedVersion}`,
    );
  }
  if (
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z.-]+)?$/.test(
      identity.version,
    ) ||
    !/^[a-f0-9]{40}$/.test(identity.commit) ||
    !/^sha256:[a-f0-9]{64}$/.test(identity.buildInputDigest) ||
    identity.development
  ) {
    throw new Error("fased-signerd release identity is not an exact production identity");
  }
  return Object.freeze(identity);
}

function parseSignerReleaseManifest(value, expectedVersion) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).toSorted().join(",") !==
      "buildInputDigest,commit,development,schemaVersion,version" ||
    value.schemaVersion !== 1
  ) {
    throw new Error("fased-signerd-release.json is malformed or contains unsupported fields");
  }
  return parseSignerVersionOutput(
    `fased-signerd ${value.version} commit=${value.commit} buildInputDigest=${value.buildInputDigest} development=${String(value.development)}`,
    expectedVersion,
  );
}

function signerIdentitiesEqual(left, right) {
  return (
    left?.version === right?.version &&
    left?.commit === right?.commit &&
    left?.buildInputDigest === right?.buildInputDigest &&
    left?.development === false &&
    right?.development === false
  );
}

async function readSignerBinaryIdentity(binaryPath, expectedVersion) {
  const result = await runFile(binaryPath, ["--version"], { timeoutMs: 10_000 });
  if (!result.ok) {
    throw new Error(`could not execute candidate fased-signerd: ${result.stderr.trim()}`);
  }
  return parseSignerVersionOutput(result.stdout, expectedVersion);
}

async function copyDownloadSource(source, destination, timeoutMs) {
  const parsed = new URL(source);
  if (parsed.protocol === "file:") {
    const sourcePath = fileURLToPath(parsed);
    const sourceStat = await fsp.lstat(sourcePath);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
      throw new Error(`Local signer release asset is not a regular file: ${sourcePath}`);
    }
    await fsp.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await fsp.copyFile(sourcePath, destination);
    await fsp.chmod(destination, 0o600);
    return;
  }
  await downloadToFile(source, destination, timeoutMs);
}

function checksumEntry(checksums, assetName) {
  for (const line of String(checksums || "").split(/\r?\n/)) {
    const match = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(line.trim());
    if (match && match[2] === assetName) {
      return match[1].toLowerCase();
    }
  }
  throw new Error(`fased-signerd-checksums.txt has no exact entry for ${assetName}`);
}

async function downloadVerifiedLocalSignerRelease({ targetVersion, timeoutMs, transactionDir }) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(targetVersion)) {
    throw new Error("Local signer update requires an exact canonical release version");
  }
  const { assetName } = resolveLocalSignerAsset(process.platform, process.arch);
  const base = String(process.env.FASED_LOCAL_SIGNER_BASE_URL || DEFAULT_RELEASE_BASE_URL).replace(
    /\/$/,
    "",
  );
  const official = base === DEFAULT_RELEASE_BASE_URL;
  if (!official && process.env.FASED_LOCAL_SIGNER_ALLOW_UNATTESTED !== "1") {
    throw new Error(
      "A custom signer release source is allowed only for an explicit trusted-source test with FASED_LOCAL_SIGNER_ALLOW_UNATTESTED=1.",
    );
  }
  const flat = !official && process.env.FASED_LOCAL_SIGNER_FLAT_RELEASE === "1";
  const releaseUrl = flat ? base : `${base}/v${targetVersion}`;
  const manifestName = "fased-signerd-release.json";
  const checksumName = "fased-signerd-checksums.txt";
  const candidatePath = path.join(transactionDir, assetName);
  const manifestPath = path.join(transactionDir, manifestName);
  const checksumsPath = path.join(transactionDir, checksumName);
  await Promise.all([
    copyDownloadSource(`${releaseUrl}/${assetName}`, candidatePath, timeoutMs),
    copyDownloadSource(`${releaseUrl}/${manifestName}`, manifestPath, timeoutMs),
    copyDownloadSource(`${releaseUrl}/${checksumName}`, checksumsPath, timeoutMs),
  ]);
  const checksums = await fsp.readFile(checksumsPath, "utf8");
  for (const [name, filePath] of [
    [assetName, candidatePath],
    [manifestName, manifestPath],
  ]) {
    const expected = checksumEntry(checksums, name);
    const actual = await sha256File(filePath);
    if (expected !== actual) {
      throw new Error(`Checksum mismatch for ${name}`);
    }
  }
  if (official) {
    await verifyOfficialAsset(candidatePath, targetVersion, timeoutMs);
    await verifyOfficialAsset(manifestPath, targetVersion, timeoutMs);
  }
  const manifestIdentity = parseSignerReleaseManifest(
    JSON.parse(await fsp.readFile(manifestPath, "utf8")),
    targetVersion,
  );
  await fsp.chmod(candidatePath, 0o700);
  const binaryIdentity = await readSignerBinaryIdentity(candidatePath, targetVersion);
  if (!signerIdentitiesEqual(binaryIdentity, manifestIdentity)) {
    throw new Error("candidate signer binary and release manifest identities do not match");
  }
  return { candidatePath, manifestPath, identity: binaryIdentity, official, assetName };
}

function resolveLocalSignerAsset(platformRaw, archRaw) {
  const platform = platformRaw === "darwin" ? "darwin" : platformRaw;
  if (platform !== "linux" && platform !== "darwin") {
    throw new Error(
      platformRaw === "win32"
        ? "Native Windows is unsupported. Install and run Fased inside WSL2."
        : `fased-signerd has no supported asset for ${platformRaw}`,
    );
  }
  const arch = archRaw === "x64" ? "amd64" : archRaw;
  if (arch !== "amd64" && arch !== "arm64") {
    throw new Error(`fased-signerd has no supported asset for ${archRaw}`);
  }
  const assetName = `fased-signerd-${platform}-${arch}`;
  return { platform, arch, assetName };
}

function isPathInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function fsyncDirectoryTree(root) {
  const directories = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    directories.push(current);
    const entries = await fsp.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
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

async function createOwnerOnlySnapshot(sourceRoot, destinationRoot, excludedPaths = []) {
  const excluded = new Set(excludedPaths.map((value) => path.resolve(value)));
  const sourceExists = await fsp
    .lstat(sourceRoot)
    .then((stat) => stat.isDirectory() && !stat.isSymbolicLink())
    .catch(() => false);
  await fsp.rm(destinationRoot, { recursive: true, force: true });
  await fsp.mkdir(destinationRoot, { recursive: true, mode: 0o700 });
  const files = [];
  if (sourceExists) {
    const pending = [{ source: sourceRoot, relative: "" }];
    while (pending.length > 0) {
      const current = pending.pop();
      const entries = await fsp.readdir(current.source, { withFileTypes: true });
      for (const entry of entries) {
        const sourcePath = path.join(current.source, entry.name);
        if (excluded.has(path.resolve(sourcePath))) {
          continue;
        }
        const relative = path.join(current.relative, entry.name);
        const destinationPath = path.join(destinationRoot, relative);
        const stat = await fsp.lstat(sourcePath);
        if (stat.isSymbolicLink()) {
          throw new Error(`Local signer state contains an unsafe symlink: ${sourcePath}`);
        }
        if (stat.isDirectory()) {
          await fsp.mkdir(destinationPath, { recursive: true, mode: 0o700 });
          pending.push({ source: sourcePath, relative });
          continue;
        }
        if (!stat.isFile()) {
          throw new Error(`Local signer state contains an unsupported file: ${sourcePath}`);
        }
        await fsp.mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
        await fsp.copyFile(sourcePath, destinationPath);
        await fsp.chmod(destinationPath, 0o600);
        files.push({
          path: relative.split(path.sep).join("/"),
          size: stat.size,
          sha256: await sha256File(destinationPath),
        });
      }
    }
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  const manifest = { schemaVersion: 1, sourceExisted: sourceExists, files };
  const manifestPath = path.join(destinationRoot, ".snapshot.json");
  await atomicWriteJson(manifestPath, manifest, 0o600);
  await fsyncDirectoryTree(destinationRoot);
  return manifest;
}

async function verifyOwnerOnlySnapshot(snapshotRoot) {
  const manifest = JSON.parse(
    await fsp.readFile(path.join(snapshotRoot, ".snapshot.json"), "utf8"),
  );
  if (
    manifest?.schemaVersion !== 1 ||
    typeof manifest.sourceExisted !== "boolean" ||
    !Array.isArray(manifest.files)
  ) {
    throw new Error("Local signer state snapshot manifest is invalid");
  }
  const seen = new Set();
  for (const entry of manifest.files) {
    if (
      !entry ||
      typeof entry.path !== "string" ||
      entry.path.includes("\\") ||
      path.posix.isAbsolute(entry.path) ||
      entry.path.split("/").some((part) => !part || part === "." || part === "..") ||
      seen.has(entry.path) ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      !/^[a-f0-9]{64}$/.test(entry.sha256 || "")
    ) {
      throw new Error("Local signer state snapshot contains an invalid entry");
    }
    seen.add(entry.path);
    const filePath = path.join(snapshotRoot, ...entry.path.split("/"));
    const stat = await fsp.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.size) {
      throw new Error(`Local signer state snapshot file is invalid: ${entry.path}`);
    }
    if ((stat.mode & 0o077) !== 0 || (await sha256File(filePath)) !== entry.sha256) {
      throw new Error(`Local signer state snapshot verification failed: ${entry.path}`);
    }
  }
  return manifest;
}

async function restoreOwnerOnlySnapshot(snapshotRoot, destinationRoot) {
  const manifest = await verifyOwnerOnlySnapshot(snapshotRoot);
  await fsp.rm(destinationRoot, { recursive: true, force: true });
  if (!manifest.sourceExisted) {
    await fsp.mkdir(path.dirname(destinationRoot), { recursive: true, mode: 0o700 });
    await fsyncManagedPath(path.dirname(destinationRoot));
    return;
  }
  await fsp.mkdir(destinationRoot, { recursive: true, mode: 0o700 });
  for (const entry of manifest.files) {
    const sourcePath = path.join(snapshotRoot, ...entry.path.split("/"));
    const destinationPath = path.join(destinationRoot, ...entry.path.split("/"));
    await fsp.mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
    await fsp.copyFile(sourcePath, destinationPath);
    await fsp.chmod(destinationPath, 0o600);
  }
  await fsyncDirectoryTree(destinationRoot);
}

async function readProcessCommand(pid) {
  if (process.platform === "linux") {
    const raw = await fsp.readFile(`/proc/${pid}/cmdline`).catch(() => null);
    if (raw) {
      return raw.toString("utf8").replaceAll("\0", " ").trim();
    }
  }
  const result = await runFile("ps", ["-p", String(pid), "-o", "command="], {
    timeoutMs: 5_000,
  });
  return result.ok ? result.stdout.trim() : "";
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function requireExactSignerPid(pid, binaryPath) {
  if (!Number.isSafeInteger(pid) || pid <= 1 || !processIsAlive(pid)) {
    return false;
  }
  const command = await readProcessCommand(pid);
  const expected = path.resolve(binaryPath);
  if (!command.includes("fased-signerd") || !command.includes(expected)) {
    throw new Error(
      `PID ${pid} is not the exact Local signer executable ${expected}; refusing to signal it`,
    );
  }
  return true;
}

async function resolveRunningSignerPid(paths) {
  const pids = new Set();
  for (const pidPath of new Set([paths.pidPath, paths.legacyPidPath])) {
    try {
      const pid = Number.parseInt((await fsp.readFile(pidPath, "utf8")).trim(), 10);
      if (await requireExactSignerPid(pid, paths.binaryPath)) {
        pids.add(pid);
      } else {
        await fsp.rm(pidPath, { force: true });
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }
  if (pids.size > 1) {
    throw new Error("Multiple Local signer PIDs were recorded; refusing an ambiguous update");
  }
  if (pids.size === 0) {
    const socketExists = await fsp
      .lstat(paths.socketPath)
      .then((stat) => stat.isSocket())
      .catch(() => false);
    if (socketExists) {
      throw new Error("Local signer socket exists without a verifiable exact PID; repair manually");
    }
    return null;
  }
  return [...pids][0];
}

async function stopExactSigner(paths, explicitPid) {
  const pid = explicitPid ?? (await resolveRunningSignerPid(paths));
  if (pid !== null) {
    await requireExactSignerPid(pid, paths.binaryPath);
    process.kill(pid, "SIGTERM");
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && processIsAlive(pid)) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (processIsAlive(pid)) {
      await requireExactSignerPid(pid, paths.binaryPath);
      process.kill(pid, "SIGKILL");
    }
    const killedDeadline = Date.now() + 3_000;
    while (Date.now() < killedDeadline && processIsAlive(pid)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (processIsAlive(pid)) {
      throw new Error(`Local signer PID ${pid} did not stop; refusing to copy live state`);
    }
  }
  await Promise.all([
    fsp.rm(paths.socketPath, { force: true }),
    fsp.rm(paths.controlSocketPath, { force: true }),
    fsp.rm(paths.pidPath, { force: true }),
    fsp.rm(paths.legacyPidPath, { force: true }),
  ]);
  const stillRunning = await resolveRunningSignerPid(paths);
  if (stillRunning !== null) {
    throw new Error("Local signer remained active after stop; refusing an online state snapshot");
  }
}

async function loadSignerEnvironment(paths) {
  const env = { ...process.env };
  const raw = await fsp.readFile(paths.signerEnvPath, "utf8").catch(() => "");
  const locationKeys = new Set([
    "FASED_WALLET_LOCAL_SIGNER_SOCKET",
    "FASED_WALLET_LOCAL_SIGNER_CONTROL_SOCKET",
    "FASED_WALLET_LOCAL_SIGNER_STATE_DB",
    "FASED_WALLET_LOCAL_SIGNER_MASTER_KEY",
    "FASED_WALLET_SIGNER_STATE_DIR",
    "FASED_WALLET_LOCAL_SIGNER_BIN",
  ]);
  const commandPattern =
    /^"(?:[^"\\]|\\[\\"$`])*" --socket "\$FASED_WALLET_LOCAL_SIGNER_SOCKET" --control-socket "\$FASED_WALLET_LOCAL_SIGNER_CONTROL_SOCKET" --state-db "\$FASED_WALLET_LOCAL_SIGNER_STATE_DB" --master-key "\$FASED_WALLET_LOCAL_SIGNER_MASTER_KEY"$/u;
  const decodeValue = (rawValue) => {
    if (rawValue.length < 2 || rawValue[0] !== '"' || rawValue.at(-1) !== '"') {
      throw new Error("Local signer environment values must use generated double-quote syntax");
    }
    let value = "";
    for (let index = 1; index < rawValue.length - 1; index += 1) {
      const current = rawValue[index];
      if (current !== "\\") {
        value += current;
        continue;
      }
      const escaped = rawValue[index + 1];
      if (!escaped || !new Set(["\\", '"', "$", "`"]).has(escaped)) {
        throw new Error("Local signer environment contains an unsupported escape");
      }
      value += escaped;
      index += 1;
    }
    return value;
  };
  for (const rawLine of raw.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    if (!line.startsWith("export ")) {
      if (commandPattern.test(line)) {
        continue;
      }
      throw new Error("Local signer environment file contains an invalid line");
    }
    const assignment = line.slice("export ".length);
    const separator = assignment.indexOf("=");
    if (separator <= 0) {
      throw new Error("Local signer environment file contains an invalid line");
    }
    const key = assignment.slice(0, separator);
    if (!/^[A-Z][A-Z0-9_]*$/u.test(key)) {
      throw new Error("Local signer environment file contains an invalid key");
    }
    const value = decodeValue(assignment.slice(separator + 1));
    if (
      key === "FASED_WALLET_CHAINS" ||
      key === "FASED_WALLET_WEBAUTHN_RP_ID" ||
      key === "FASED_WALLET_WEBAUTHN_ORIGINS" ||
      key.startsWith("FASED_WALLET_LOCAL_SIGNER_RATE_") ||
      key === "FASED_WALLET_LOCAL_SIGNER_AUDIT_MAX_BYTES" ||
      key === "FASED_WALLET_SOLANA_CONFIRM_TIMEOUT_MS" ||
      key === "FASED_WALLET_SOLANA_WRITE_RPC_TIMEOUT_MS"
    ) {
      env[key] = value;
    } else if (locationKeys.has(key)) {
      if (!path.isAbsolute(value)) {
        throw new Error(`Local signer environment path ${key} must be absolute`);
      }
    } else {
      throw new Error(`Local signer environment file contains unsupported key ${key}`);
    }
  }
  delete env.FASED_WALLET_SOLANA_KEYSTORE_PATH;
  delete env.FASED_WALLET_EVM_KEYSTORE_PATH;
  delete env.FASED_WALLET_PASSPHRASE;
  delete env.FASED_WALLET_PASSPHRASE_FILE;
  return env;
}

async function probeLocalSignerHealth(
  socketPath,
  expectedIdentity,
  timeoutMs = 8_000,
  expectedReadOnly,
) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await new Promise((resolve, reject) => {
        const socket = net.createConnection({ path: socketPath });
        socket.setEncoding("utf8");
        socket.setTimeout(Math.min(2_000, timeoutMs));
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
            fail(new Error("Local signer health response is too large"));
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
            reject(error);
          }
        });
        socket.once("timeout", () => fail(new Error("Local signer health timed out")));
        socket.once("error", fail);
      });
      const result = response?.result;
      const release = parseSignerReleaseManifest(
        { schemaVersion: 1, ...result?.release },
        expectedIdentity.version,
      );
      const features = new Set(result?.capabilities?.features || []);
      const missing = LOCAL_SIGNER_REQUIRED_FEATURES.filter((feature) => !features.has(feature));
      const policies = result?.policies;
      const policiesValid =
        Array.isArray(policies) &&
        policies.every(
          (policy) =>
            typeof policy?.walletId === "string" &&
            policy.walletId.length > 0 &&
            Number.isSafeInteger(policy.version) &&
            policy.version > 0 &&
            /^sha256:[a-f0-9]{64}$/.test(policy.hash || ""),
        );
      const networks = result?.network?.wallets;
      const networkValid =
        typeof result?.network?.ready === "boolean" &&
        Array.isArray(networks) &&
        networks.every(
          (network) =>
            typeof network?.walletId === "string" &&
            network.walletId.length > 0 &&
            typeof network.configured === "boolean" &&
            Number.isSafeInteger(network.version) &&
            network.version >= 0 &&
            typeof network.ready === "boolean" &&
            (!network.configured || /^sha256:[a-f0-9]{64}$/.test(network.hash || "")),
        );
      if (
        response?.ok !== true ||
        result?.ready !== true ||
        result?.keystoreType !== "signer-owned-v2" ||
        result?.capabilities?.protocol?.current !== 2 ||
        result?.capabilities?.protocol?.min > 2 ||
        result?.capabilities?.protocol?.max < 2 ||
        result?.capabilities?.nativeFeeReservationLamports !== 5_000_000 ||
        result?.schema?.ready !== true ||
        (expectedReadOnly !== undefined && result?.readOnly !== expectedReadOnly) ||
        missing.length > 0 ||
        !policiesValid ||
        !networkValid ||
        !signerIdentitiesEqual(release, expectedIdentity)
      ) {
        throw new Error(
          `Local signer failed protocol-v2 compatibility${missing.length ? `; missing ${missing.join(",")}` : ""}${expectedReadOnly !== undefined && result?.readOnly !== expectedReadOnly ? `; expected readOnly=${String(expectedReadOnly)}` : ""}`,
        );
      }
      return result;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(
    `Local signer did not become exactly healthy: ${lastError?.message || "timeout"}`,
  );
}

function localSignerStateInvariant(health) {
  return JSON.stringify({
    policies: [...(health?.policies || [])].toSorted((left, right) =>
      left.walletId.localeCompare(right.walletId),
    ),
    network: {
      ready: health?.network?.ready,
      wallets: [...(health?.network?.wallets || [])].toSorted((left, right) =>
        left.walletId.localeCompare(right.walletId),
      ),
    },
  });
}

async function startSignerProcess(paths, binaryPath = paths.binaryPath, readOnly = false) {
  await fsp.mkdir(paths.materialDir, { recursive: true, mode: 0o700 });
  const log = await fsp.open(paths.logPath, "a", 0o600);
  const child = spawn(
    binaryPath,
    [
      "-socket",
      paths.socketPath,
      "-control-socket",
      paths.controlSocketPath,
      "-state-db",
      paths.stateDbPath,
      "-master-key",
      paths.masterKeyPath,
      "-pid-file",
      paths.pidPath,
      "-audit-log",
      paths.auditPath,
      ...(readOnly ? ["-read-only"] : []),
    ],
    {
      detached: true,
      stdio: ["ignore", log.fd, log.fd],
      env: await loadSignerEnvironment(paths),
    },
  );
  child.unref();
  await log.close();
  if (!Number.isSafeInteger(child.pid) || child.pid <= 1) {
    throw new Error("Could not start the exact Local signer candidate");
  }
  return child.pid;
}

async function copyStandaloneFile(source, destination, mode) {
  await fsp.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await fsp.copyFile(source, destination);
  await fsp.chmod(destination, mode);
  await fsyncManagedPath(destination);
  await fsyncManagedPath(path.dirname(destination));
}

async function atomicInstallSignerBinary(paths, candidatePath, manifestPath) {
  await fsp.mkdir(paths.binDir, { recursive: true, mode: 0o700 });
  const candidateTemporary = `${paths.binaryPath}.candidate-${process.pid}-${Date.now()}`;
  await copyStandaloneFile(candidatePath, candidateTemporary, 0o700);
  await fsp.rename(candidateTemporary, paths.binaryPath);
  await fsyncManagedPath(paths.binDir);
  const releaseTemporary = `${paths.releaseManifestPath}.candidate-${process.pid}-${Date.now()}`;
  await copyStandaloneFile(manifestPath, releaseTemporary, 0o600);
  await fsp.rename(releaseTemporary, paths.releaseManifestPath);
  const enrollTemporary = `${paths.enrollmentPath}.candidate-${process.pid}-${Date.now()}`;
  await fsp.rm(enrollTemporary, { force: true });
  await fsp.link(paths.binaryPath, enrollTemporary);
  await fsp.rename(enrollTemporary, paths.enrollmentPath);
  await fsyncManagedPath(paths.binDir);
}

async function snapshotStandaloneFile(source, destination) {
  try {
    const stat = await fsp.lstat(source);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Signer installation path is not a regular file: ${source}`);
    }
    await copyStandaloneFile(source, destination, 0o600);
    return { existed: true, sha256: await sha256File(destination) };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { existed: false, sha256: null };
    }
    throw error;
  }
}

async function restoreStandaloneFile(snapshot, destination, executable = false) {
  if (!snapshot.existed) {
    await fsp.rm(destination, { force: true });
    await fsyncManagedPath(path.dirname(destination)).catch((error) => {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    });
    return;
  }
  if ((await sha256File(snapshot.path)) !== snapshot.sha256) {
    throw new Error(`Signer rollback snapshot was tampered: ${snapshot.path}`);
  }
  const temporary = `${destination}.rollback-${process.pid}-${Date.now()}`;
  await copyStandaloneFile(snapshot.path, temporary, executable ? 0o700 : 0o600);
  await fsp.rename(temporary, destination);
  await fsyncManagedPath(path.dirname(destination));
}

function validateLocalSignerJournal(paths, value) {
  if (
    !value ||
    typeof value !== "object" ||
    value.schemaVersion !== LOCAL_SIGNER_TRANSACTION_SCHEMA_VERSION ||
    !LOCAL_SIGNER_TRANSACTION_PHASES.has(value.phase) ||
    !TRANSACTION_ID_PATTERN.test(value.transactionId || "") ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(value.targetVersion || "") ||
    path.resolve(value.transactionDir || "") !==
      path.join(paths.transactionsDir, value.transactionId) ||
    !isPathInside(paths.updateRoot, value.transactionDir)
  ) {
    throw new Error("Local signer update journal is invalid");
  }
  return value;
}

async function readLocalSignerJournal(paths) {
  try {
    return validateLocalSignerJournal(
      paths,
      JSON.parse(await fsp.readFile(paths.journalPath, "utf8")),
    );
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeLocalSignerJournal(paths, journal, phase = journal.phase) {
  const next = validateLocalSignerJournal(paths, {
    ...journal,
    schemaVersion: LOCAL_SIGNER_TRANSACTION_SCHEMA_VERSION,
    phase,
    updatedAt: new Date().toISOString(),
  });
  await atomicWriteJson(paths.journalPath, next, 0o600);
  await fsyncManagedPath(paths.journalPath);
  await fsyncManagedPath(paths.updateRoot);
  if (process.env.FASED_TEST_LOCAL_SIGNER_CRASH_AFTER_PHASE === phase) {
    process.exit(97);
  }
  return next;
}

async function removeLocalSignerJournal(paths) {
  await fsp.rm(paths.journalPath, { force: true });
  await fsyncManagedPath(paths.updateRoot);
}

async function hasLegacyLocalSignerMaterial(paths) {
  const stateDbExists = await fsp
    .lstat(paths.stateDbPath)
    .then((stat) => stat.isFile() && !stat.isSymbolicLink())
    .catch(() => false);
  if (stateDbExists) {
    return false;
  }
  const entries = await fsp.readdir(paths.materialDir, { withFileTypes: true }).catch(() => []);
  return entries.some(
    (entry) =>
      entry.isFile() &&
      !entry.isSymbolicLink() &&
      (entry.name === "wallet-keys.json" ||
        /^keystore-(?:solana|evm)(?:-[A-Za-z0-9_-]+)?\.v1\.enc$/u.test(entry.name)),
  );
}

async function prepareLocalSignerTransaction({
  targetVersion,
  expectedCommit,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  deferCommit = false,
  confirmDowngrade,
  paths = resolveLocalSignerPaths(),
}) {
  const existingJournal = await readLocalSignerJournal(paths);
  if (existingJournal) {
    throw new Error(
      `An unfinished Local signer transaction already exists (${existingJournal.transactionId}, phase=${existingJournal.phase}). Recover it first.`,
    );
  }
  await fsp.mkdir(paths.transactionsDir, { recursive: true, mode: 0o700 });
  if (await hasLegacyLocalSignerMaterial(paths)) {
    throw new Error(
      [
        "A pre-v2 Local wallet must complete the one-time native signer migration before Fased can update.",
        "No process was stopped and no installed file or wallet state was changed.",
        "Run `fased wallet setup --mode local-signer-import` for the signer-only import command, then `fased wallet finalize-legacy-migration --wallet-id <wallet-id>` after verifying the exact public address.",
        "The passphrase must remain in an owner-only file read by fased-signerd; never put it in the Gateway, UI, argv, or an environment variable.",
      ].join(" "),
    );
  }
  const transactionId = randomUUID();
  const transactionDir = path.join(paths.transactionsDir, transactionId);
  await fsp.mkdir(transactionDir, { recursive: true, mode: 0o700 });
  const release = await downloadVerifiedLocalSignerRelease({
    targetVersion,
    timeoutMs,
    transactionDir,
  });
  if (expectedCommit && release.identity.commit !== expectedCommit) {
    throw new Error(
      "Local signer release commit does not match the exact application release commit",
    );
  }
  let previousIdentity = null;
  try {
    previousIdentity = await readSignerBinaryIdentity(paths.binaryPath);
  } catch (error) {
    if (error?.code !== "ENOENT" && !String(error.message).includes("could not execute")) {
      throw error;
    }
  }
  if (previousIdentity && compareVersions(previousIdentity.version, targetVersion) === 1) {
    if (confirmDowngrade !== targetVersion) {
      throw new Error(
        `Refusing signer downgrade ${previousIdentity.version} -> ${targetVersion}. Re-run only with --confirm-downgrade ${targetVersion} after reviewing the rollback boundary.`,
      );
    }
  }
  const runningPid = await resolveRunningSignerPid(paths);
  let previousHealth = null;
  if (runningPid !== null) {
    if (!previousIdentity) {
      throw new Error("The active Local signer has no verifiable production release identity");
    }
    previousHealth = await probeLocalSignerHealth(paths.socketPath, previousIdentity, 5_000);
  }
  let journal = {
    schemaVersion: LOCAL_SIGNER_TRANSACTION_SCHEMA_VERSION,
    transactionId,
    transactionDir,
    targetVersion,
    targetIdentity: release.identity,
    previousIdentity,
    previousHealthPolicies: previousHealth?.policies || null,
    previousHealthInvariant: previousHealth ? localSignerStateInvariant(previousHealth) : null,
    previousWasRunning: runningPid !== null,
    legacyMigrationRequired: false,
    deferCommit: deferCommit,
    phase: "staging",
    createdAt: new Date().toISOString(),
  };
  journal = await writeLocalSignerJournal(paths, journal, "staging");
  await stopExactSigner(paths, runningPid);
  journal = await writeLocalSignerJournal(paths, journal, "quiesced");
  const snapshotDir = path.join(transactionDir, "snapshot");
  const materialSnapshotDir = path.join(snapshotDir, "material");
  await createOwnerOnlySnapshot(paths.materialDir, materialSnapshotDir, [
    paths.socketPath,
    paths.controlSocketPath,
    paths.pidPath,
    paths.legacyPidPath,
    paths.logPath,
  ]);
  const binarySnapshotPath = path.join(snapshotDir, "fased-signerd.previous");
  const releaseSnapshotPath = path.join(snapshotDir, "fased-signerd-release.previous.json");
  const enrollmentSnapshotPath = path.join(snapshotDir, "fased-signer-enroll.previous");
  const binarySnapshot = await snapshotStandaloneFile(paths.binaryPath, binarySnapshotPath);
  const releaseSnapshot = await snapshotStandaloneFile(
    paths.releaseManifestPath,
    releaseSnapshotPath,
  );
  const enrollmentSnapshot = await snapshotStandaloneFile(
    paths.enrollmentPath,
    enrollmentSnapshotPath,
  );
  const auxiliarySnapshots = [];
  const auxiliaryDestinations = [
    { destination: paths.policyHelperPath, executable: true },
    { destination: paths.policyLauncherPath, executable: true },
    ...paths.policyTemplatePaths.map((destination) => ({ destination, executable: false })),
  ];
  for (const [index, entry] of auxiliaryDestinations.entries()) {
    const snapshotPath = path.join(
      snapshotDir,
      "auxiliary",
      `${index}-${path.basename(entry.destination)}.previous`,
    );
    auxiliarySnapshots.push({
      ...entry,
      ...(await snapshotStandaloneFile(entry.destination, snapshotPath)),
      path: snapshotPath,
    });
  }
  journal = {
    ...journal,
    snapshot: {
      materialDir: materialSnapshotDir,
      binary: { ...binarySnapshot, path: binarySnapshotPath },
      releaseManifest: { ...releaseSnapshot, path: releaseSnapshotPath },
      enrollment: { ...enrollmentSnapshot, path: enrollmentSnapshotPath },
      auxiliary: auxiliarySnapshots,
    },
    candidatePath: release.candidatePath,
    candidateManifestPath: release.manifestPath,
  };
  journal = await writeLocalSignerJournal(paths, journal, "snapshotted");

  const preflightMaterial = path.join(transactionDir, "preflight", "material");
  await restoreOwnerOnlySnapshot(materialSnapshotDir, preflightMaterial);
  const translate = (source) =>
    path.join(preflightMaterial, path.relative(paths.materialDir, source));
  const preflightRuntime = await fsp.mkdtemp(path.join(os.tmpdir(), "fased-signerd-preflight-"));
  await fsp.chmod(preflightRuntime, 0o700);
  const preflightPaths = {
    ...paths,
    binaryPath: release.candidatePath,
    materialDir: preflightMaterial,
    socketPath: path.join(preflightRuntime, "app.sock"),
    controlSocketPath: path.join(preflightRuntime, "control.sock"),
    stateDbPath: translate(paths.stateDbPath),
    masterKeyPath: translate(paths.masterKeyPath),
    pidPath: path.join(preflightRuntime, "signer.pid"),
    legacyPidPath: path.join(preflightRuntime, "legacy.pid"),
    auditPath: path.join(preflightMaterial, "preflight.audit.jsonl"),
    logPath: path.join(preflightMaterial, "preflight.log"),
    signerEnvPath: translate(paths.signerEnvPath),
  };
  const preflightPid = await startSignerProcess(preflightPaths, release.candidatePath, true);
  try {
    const candidateHealth = await probeLocalSignerHealth(
      preflightPaths.socketPath,
      release.identity,
      10_000,
      true,
    );
    if (
      journal.previousHealthInvariant &&
      localSignerStateInvariant(candidateHealth) !== journal.previousHealthInvariant
    ) {
      throw new Error(
        "Candidate signer preflight did not preserve exact wallet, policy, and network hashes",
      );
    }
  } finally {
    await stopExactSigner(preflightPaths, preflightPid).catch(() => undefined);
    await fsp.rm(preflightRuntime, { recursive: true, force: true });
  }
  journal = await writeLocalSignerJournal(paths, journal, "prepared");
  return journal;
}

async function activateLocalSignerTransaction(paths = resolveLocalSignerPaths()) {
  let journal = await readLocalSignerJournal(paths);
  if (!journal || journal.phase !== "prepared") {
    throw new Error("Local signer transaction is not prepared for activation");
  }
  journal = await writeLocalSignerJournal(paths, journal, "activating");
  await stopExactSigner(paths);
  await atomicInstallSignerBinary(paths, journal.candidatePath, journal.candidateManifestPath);
  const stateExists = await fsp
    .lstat(paths.stateDbPath)
    .then((stat) => stat.isFile())
    .catch(() => false);
  const shouldStart =
    !journal.legacyMigrationRequired &&
    (journal.previousWasRunning || stateExists || process.env.FASED_LOCAL_SIGNER_START === "1");
  if (shouldStart) {
    const pid = await startSignerProcess(paths, paths.binaryPath, true);
    try {
      const health = await probeLocalSignerHealth(
        paths.socketPath,
        journal.targetIdentity,
        15_000,
        true,
      );
      if (
        journal.previousHealthInvariant &&
        localSignerStateInvariant(health) !== journal.previousHealthInvariant
      ) {
        throw new Error(
          "Activated signer did not preserve exact wallet, policy, and network hashes",
        );
      }
    } catch (error) {
      await stopExactSigner(paths, pid).catch(() => undefined);
      throw error;
    }
  } else {
    const exact = await readSignerBinaryIdentity(paths.binaryPath, journal.targetVersion);
    if (!signerIdentitiesEqual(exact, journal.targetIdentity)) {
      throw new Error("Activated Local signer binary identity changed during the switch");
    }
  }
  journal = await writeLocalSignerJournal(
    paths,
    { ...journal, candidateShouldRun: shouldStart },
    "candidate-active",
  );
  return journal;
}

async function commitLocalSignerTransaction(paths = resolveLocalSignerPaths()) {
  let journal = await readLocalSignerJournal(paths);
  if (!journal || !new Set(["candidate-active", "committing"]).has(journal.phase)) {
    throw new Error("Local signer transaction has not passed candidate health verification");
  }
  if (journal.phase !== "committing") {
    journal = await writeLocalSignerJournal(paths, journal, "committing");
  }
  const exact = await readSignerBinaryIdentity(paths.binaryPath, journal.targetVersion);
  if (!signerIdentitiesEqual(exact, journal.targetIdentity)) {
    throw new Error("Local signer commit identity no longer matches the verified candidate");
  }
  if (journal.candidateShouldRun) {
    await stopExactSigner(paths);
    await startSignerProcess(paths);
    const health = await probeLocalSignerHealth(paths.socketPath, exact, 15_000, false);
    if (
      journal.previousHealthInvariant &&
      localSignerStateInvariant(health) !== journal.previousHealthInvariant
    ) {
      throw new Error("Committed signer did not preserve exact wallet, policy, and network hashes");
    }
  }
  const committedMarker = path.join(journal.transactionDir, "committed.json");
  await atomicWriteJson(
    committedMarker,
    { schemaVersion: 1, committedAt: new Date().toISOString(), identity: exact },
    0o600,
  );
  await fsyncManagedPath(committedMarker);
  await fsyncManagedPath(journal.transactionDir);
  await removeLocalSignerJournal(paths);
  const transactions = await fsp.readdir(paths.transactionsDir, { withFileTypes: true });
  for (const entry of transactions) {
    if (entry.isDirectory() && entry.name !== journal.transactionId) {
      await fsp.rm(path.join(paths.transactionsDir, entry.name), {
        recursive: true,
        force: true,
      });
    }
  }
  await fsyncManagedPath(paths.transactionsDir);
  return {
    action: "committed",
    identity: exact,
    legacyMigrationRequired: journal.legacyMigrationRequired === true,
  };
}

async function rollbackLocalSignerTransaction(paths = resolveLocalSignerPaths(), originalError) {
  let journal = await readLocalSignerJournal(paths);
  if (!journal) {
    return { action: "none" };
  }
  if (journal.phase === "committing") {
    throw new Error(
      "Local signer has a durable commit decision; rollback is refused and recovery must finish forward",
    );
  }
  if (journal.phase !== "rolling-back") {
    journal = await writeLocalSignerJournal(paths, journal, "rolling-back");
  }
  await stopExactSigner(paths).catch(async (error) => {
    if (journal.phase === "staging") {
      return;
    }
    throw error;
  });
  if (journal.snapshot) {
    await restoreOwnerOnlySnapshot(journal.snapshot.materialDir, paths.materialDir);
    await fsp.mkdir(paths.binDir, { recursive: true, mode: 0o700 });
    await restoreStandaloneFile(journal.snapshot.binary, paths.binaryPath, true);
    await restoreStandaloneFile(journal.snapshot.releaseManifest, paths.releaseManifestPath, false);
    await restoreStandaloneFile(journal.snapshot.enrollment, paths.enrollmentPath, true);
    for (const entry of journal.snapshot.auxiliary || []) {
      await restoreStandaloneFile(entry, entry.destination, entry.executable === true);
    }
    await fsyncManagedPath(paths.binDir);
    if (journal.previousWasRunning && journal.snapshot.binary.existed) {
      const previousIdentity = await readSignerBinaryIdentity(paths.binaryPath);
      if (
        journal.previousIdentity &&
        !signerIdentitiesEqual(previousIdentity, journal.previousIdentity)
      ) {
        throw new Error("Rollback restored a different Local signer binary identity");
      }
      await startSignerProcess(paths);
      if (journal.previousIdentity) {
        await probeLocalSignerHealth(paths.socketPath, journal.previousIdentity, 15_000);
      }
    }
  } else if (journal.previousWasRunning) {
    await startSignerProcess(paths);
  }
  await removeLocalSignerJournal(paths);
  await fsp.rm(journal.transactionDir, { recursive: true, force: true });
  await fsyncManagedPath(paths.updateRoot);
  if (originalError) {
    const error = new Error(`Local signer update rolled back exactly: ${originalError.message}`, {
      cause: originalError,
    });
    error.code = "LOCAL_SIGNER_UPDATE_ROLLED_BACK";
    throw error;
  }
  return { action: "rolled-back" };
}

async function recoverLocalSignerTransaction(paths = resolveLocalSignerPaths()) {
  const journal = await readLocalSignerJournal(paths);
  if (!journal) {
    return { action: "none" };
  }
  if (journal.phase === "committing") {
    return await commitLocalSignerTransaction(paths);
  }
  if (journal.phase === "candidate-active" && !journal.deferCommit) {
    return await commitLocalSignerTransaction(paths);
  }
  return await rollbackLocalSignerTransaction(paths);
}

async function runLocalSignerTransaction(options, pathOverrides = {}) {
  const paths = resolveLocalSignerPaths(pathOverrides);
  await fsp.mkdir(paths.updateRoot, { recursive: true, mode: 0o700 });
  const releaseLock = await acquireUpdateLock(paths.updateRoot);
  try {
    if (options.action === "status") {
      return { action: "status", journal: await readLocalSignerJournal(paths) };
    }
    if (options.action === "verify") {
      const journal = await readLocalSignerJournal(paths);
      const identity = await readSignerBinaryIdentity(
        paths.binaryPath,
        options.targetVersion || undefined,
      );
      if (options.expectedCommit && identity.commit !== options.expectedCommit) {
        throw new Error(
          "Running Local signer commit does not match the exact application release commit",
        );
      }
      await probeLocalSignerHealth(
        paths.socketPath,
        identity,
        Math.min(options.timeoutMs, 15_000),
        journal?.phase === "candidate-active",
      );
      return { action: "verified", identity };
    }
    if (options.action === "recover") {
      return await recoverLocalSignerTransaction(paths);
    }
    if (options.action === "rollback") {
      return await rollbackLocalSignerTransaction(paths);
    }
    if (options.action === "commit") {
      return await commitLocalSignerTransaction(paths);
    }
    if (options.action === "activate") {
      return await activateLocalSignerTransaction(paths);
    }
    if (options.action === "prepare") {
      return await prepareLocalSignerTransaction({ ...options, paths });
    }
    if (options.action !== "install") {
      throw new Error(`Unsupported Local signer transaction action: ${options.action}`);
    }
    await recoverLocalSignerTransaction(paths);
    try {
      await prepareLocalSignerTransaction({ ...options, paths });
      const journal = await activateLocalSignerTransaction(paths);
      if (options.deferCommit) {
        return { action: "candidate-active", identity: journal.targetIdentity };
      }
      return await commitLocalSignerTransaction(paths);
    } catch (error) {
      if (await readLocalSignerJournal(paths)) {
        return await rollbackLocalSignerTransaction(paths, error);
      }
      throw error;
    }
  } finally {
    await releaseLock();
  }
}

function parseLocalSignerTransactionArgs(argv) {
  const action = argv[1] || "install";
  if (
    !new Set([
      "install",
      "prepare",
      "activate",
      "verify",
      "commit",
      "rollback",
      "recover",
      "status",
    ]).has(action)
  ) {
    throw new Error(
      "local-signer requires install, prepare, activate, verify, commit, rollback, recover, or status",
    );
  }
  const options = {
    action,
    targetVersion: null,
    expectedCommit: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    deferCommit: false,
    confirmDowngrade: null,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--version") {
      options.targetVersion = String(argv[++index] || "").replace(/^v/, "");
    } else if (token === "--expected-commit") {
      options.expectedCommit = String(argv[++index] || "")
        .trim()
        .toLowerCase();
    } else if (token === "--timeout") {
      options.timeoutMs = Number.parseInt(argv[++index] || "", 10) * 1000;
    } else if (token === "--defer-commit") {
      options.deferCommit = true;
    } else if (token === "--confirm-downgrade") {
      options.confirmDowngrade = String(argv[++index] || "").replace(/^v/, "");
    } else {
      throw new Error(`Unsupported Local signer transaction option: ${token}`);
    }
  }
  if (
    new Set(["install", "prepare", "verify"]).has(action) &&
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(options.targetVersion || "")
  ) {
    throw new Error(`local-signer ${action} requires --version X.Y.Z`);
  }
  if (options.expectedCommit !== null && !/^[a-f0-9]{40}$/.test(options.expectedCommit)) {
    throw new Error("--expected-commit must be one exact 40-character Git commit");
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("--timeout must be a positive integer (seconds)");
  }
  return options;
}

function localPairedUpdateJournalPath(paths) {
  return path.join(paths.stateDir, "local-paired-update-transaction.json");
}

function validateLocalPairedUpdateJournal(paths, value) {
  if (
    !value ||
    typeof value !== "object" ||
    value.schemaVersion !== 1 ||
    !new Set(["prepared", "signer-active", "app-active", "gateway-verified"]).has(value.phase) ||
    !TRANSACTION_ID_PATTERN.test(value.transactionId || "") ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(value.targetVersion || "") ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(value.previousVersion || "") ||
    value.nextManifest?.runtime?.activeVersion !== value.targetVersion ||
    value.previousManifest?.runtime?.activeVersion !== value.previousVersion ||
    value.nextManifest?.profile === "hosting" ||
    value.previousManifest?.profile === "hosting"
  ) {
    throw new Error("Local paired app/signer update journal is invalid");
  }
  return {
    ...value,
    targetRoot: managedReleaseRoot(paths, value.targetRoot, "targetRoot"),
    previousRoot: managedReleaseRoot(paths, value.previousRoot, "previousRoot"),
  };
}

async function readLocalPairedUpdateJournal(paths) {
  try {
    return validateLocalPairedUpdateJournal(
      paths,
      JSON.parse(await fsp.readFile(localPairedUpdateJournalPath(paths), "utf8")),
    );
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeLocalPairedUpdateJournal(paths, journal, phase = journal.phase) {
  const next = validateLocalPairedUpdateJournal(paths, {
    ...journal,
    schemaVersion: 1,
    phase,
    updatedAt: new Date().toISOString(),
  });
  const journalPath = localPairedUpdateJournalPath(paths);
  await atomicWriteJson(journalPath, next, 0o600);
  await fsyncManagedPath(journalPath);
  await fsyncManagedPath(paths.stateDir);
  if (process.env.FASED_TEST_LOCAL_PAIRED_CRASH_AFTER_PHASE === phase) {
    process.exit(98);
  }
  return next;
}

async function removeLocalPairedUpdateJournal(paths) {
  await fsp.rm(localPairedUpdateJournalPath(paths), { force: true });
  await fsyncManagedPath(paths.stateDir);
}

async function localSignerIsInstalledOrConfigured(signerPaths) {
  for (const candidate of [signerPaths.binaryPath, signerPaths.stateDbPath]) {
    if (
      await fsp
        .lstat(candidate)
        .then((stat) => stat.isFile() && !stat.isSymbolicLink())
        .catch(() => false)
    ) {
      return true;
    }
  }
  if (await hasLegacyLocalSignerMaterial(signerPaths)) {
    return true;
  }
  const registryPath = path.join(signerPaths.materialDir, "provider-registry.v1.json");
  try {
    const registry = JSON.parse(await fsp.readFile(registryPath, "utf8"));
    return (registry.wallets || []).some((wallet) => wallet?.providerId === "local-socket-signer");
  } catch {
    return false;
  }
}

async function restoreLocalPairedApplication(paths, journal) {
  await atomicSymlink(journal.previousRoot, paths.currentLink);
  await replaceCompatibilityLink(paths);
  await atomicWriteJson(paths.manifestPath, journal.previousManifest, 0o600);
  await syncManagedActivation(paths);
  await updateStableComponents(paths, journal.previousRoot, true);
}

async function rollbackLocalPairedUpdate(paths, journal, timeoutMs, originalError = null) {
  const failures = [];
  try {
    await restoreLocalPairedApplication(paths, journal);
  } catch (error) {
    failures.push(`application restore: ${error.message}`);
  }
  try {
    await runLocalSignerTransaction({ action: "rollback" }, { stateDir: paths.stateDir });
  } catch (error) {
    failures.push(`signer restore: ${error.message}`);
  }
  if (failures.length === 0) {
    try {
      await refreshGateway(
        journal.previousRoot,
        journal.previousManifest,
        timeoutMs,
        false,
        journal.previousManifest?.signer?.release,
      );
    } catch (error) {
      failures.push(`previous Gateway refresh: ${error.message}`);
    }
  }
  if (failures.length > 0) {
    const error = new Error(
      `Local paired update recovery is incomplete (${failures.join("; ")}). Re-run fased update after correcting the failure.`,
      { cause: originalError || undefined },
    );
    error.code = "LOCAL_PAIRED_ROLLBACK_INCOMPLETE";
    throw error;
  }
  await removeLocalPairedUpdateJournal(paths);
  if (originalError) {
    const error = new Error(
      `Update rolled back the exact Local app and signer after health verification failed: ${originalError.message}`,
      { cause: originalError },
    );
    error.code = "LOCAL_PAIRED_UPDATE_ROLLED_BACK";
    throw error;
  }
  return { action: "rolled-back" };
}

async function recoverLocalPairedUpdate(paths, timeoutMs) {
  const journal = await readLocalPairedUpdateJournal(paths);
  if (!journal) {
    await runLocalSignerTransaction({ action: "recover" }, { stateDir: paths.stateDir });
    return { recovered: false };
  }
  if (journal.phase === "gateway-verified") {
    let signer;
    try {
      signer = await runLocalSignerTransaction({ action: "commit" }, { stateDir: paths.stateDir });
    } catch (error) {
      if (!String(error?.message || "").includes("has not passed candidate health")) {
        throw error;
      }
      const signerPaths = resolveLocalSignerPaths({ stateDir: paths.stateDir });
      const identity = await readSignerBinaryIdentity(
        signerPaths.binaryPath,
        journal.targetVersion,
      );
      if (!signerIdentitiesEqual(identity, journal.nextManifest?.signer?.release)) {
        throw new Error("Local paired recovery found no signer journal and a mismatched binary", {
          cause: error,
        });
      }
      await probeLocalSignerHealth(signerPaths.socketPath, identity, Math.min(timeoutMs, 15_000));
      signer = { identity };
    }
    const nextManifest = {
      ...journal.nextManifest,
      signer: { release: signer.identity },
    };
    await atomicWriteJson(paths.manifestPath, nextManifest, 0o600);
    await syncManagedActivation(paths);
    await updateStableComponents(paths, journal.targetRoot, true);
    await removeLocalPairedUpdateJournal(paths);
    return { recovered: true, action: "committed" };
  }
  return {
    recovered: true,
    ...(await rollbackLocalPairedUpdate(paths, journal, timeoutMs)),
  };
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
    } else {
      await measureStage(timings, "interrupted Local app/signer transaction recovery", () =>
        recoverLocalPairedUpdate(paths, options.timeoutMs),
      );
      existingManifest = readManagedInstallManifest(paths.manifestPath);
      if (!existingManifest) {
        throw new Error("Managed installation manifest is invalid after Local update recovery.");
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
          await refreshGateway(
            currentRoot,
            existingManifest,
            options.timeoutMs,
            false,
            existingManifest.signer?.release,
          );
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
      let unifiedRelease = null;
      let unifiedReleasePath = null;
      if (existingManifest.profile === "hosting") {
        unifiedReleasePath = path.join(temporaryRoot, "fased-hosted-release-v2.json");
        await measureStage(timings, "unified release manifest", async () => {
          await downloadToFile(
            `${releaseUrl}/fased-hosted-release-v2.json`,
            unifiedReleasePath,
            options.timeoutMs,
          );
          if (officialVersion) {
            await verifyOfficialAsset(unifiedReleasePath, officialVersion, options.timeoutMs);
          }
          unifiedRelease = (
            await readHostedReleaseManifestV2(unifiedReleasePath, { version: targetVersion })
          ).manifest;
        });
      }
      const appArtifact = unifiedRelease?.application?.linux?.[arch]?.artifact;
      const assetName =
        appArtifact?.asset || `fased-hosted-app-linux-${arch}-v${targetVersion}.tar.gz`;
      const archive = await measureStage(timings, "application download and checksum", () =>
        appArtifact
          ? downloadManifestBoundAsset({
              releaseUrl,
              artifact: appArtifact,
              destinationDir: temporaryRoot,
              timeoutMs: options.timeoutMs,
              officialVersion,
            })
          : downloadVerifiedAsset({
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
      if (unifiedReleasePath) {
        await fsp.copyFile(
          unifiedReleasePath,
          path.join(stagedRoot, ".fased-hosted-release-v2.json"),
        );
      }
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
          manifestArtifact: unifiedRelease?.application?.linux?.[arch]?.dependencies,
        }),
      );
      await fsp.symlink(nodeModules, path.join(stagedRoot, "node_modules"), "dir");
      await assertManagedRuntime(stagedRoot, targetVersion);
      const hostedRelease = await readHostedReleaseBinding(stagedRoot, metadata, targetVersion);
      if (existingManifest.profile === "hosting" && !hostedRelease) {
        throw new Error("Maintained Hosting update omitted its attested unified release binding.");
      }
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
        hostedRelease,
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
        const signerPaths = resolveLocalSignerPaths({ stateDir: paths.stateDir });
        const pairSigner =
          Boolean(previousRoot) && (await localSignerIsInstalledOrConfigured(signerPaths));
        if (pairSigner) {
          let pairedJournal = await writeLocalPairedUpdateJournal(paths, {
            schemaVersion: 1,
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
          try {
            const signer = await measureStage(timings, "Local signer prepare and preflight", () =>
              runLocalSignerTransaction(
                {
                  action: "install",
                  targetVersion,
                  timeoutMs: options.timeoutMs,
                  deferCommit: true,
                },
                { stateDir: paths.stateDir },
              ),
            );
            pairedJournal.nextManifest = {
              ...pairedJournal.nextManifest,
              signer: { release: signer.identity },
            };
            pairedJournal = await writeLocalPairedUpdateJournal(
              paths,
              pairedJournal,
              "signer-active",
            );
            await measureStage(timings, "paired runtime activation", async () => {
              if (path.resolve(previousRoot) !== path.resolve(releaseRoot)) {
                await atomicSymlink(previousRoot, paths.previousLink);
              }
              await atomicSymlink(releaseRoot, paths.currentLink);
              await replaceCompatibilityLink(paths);
              await atomicWriteJson(paths.manifestPath, pairedJournal.nextManifest, 0o600);
              await syncManagedActivation(paths);
            });
            activated = true;
            pairedJournal = await writeLocalPairedUpdateJournal(paths, pairedJournal, "app-active");
            await measureStage(timings, "paired Gateway and signer health", async () => {
              await refreshGateway(releaseRoot, pairedJournal.nextManifest, options.timeoutMs);
              await probeLocalSignerHealth(
                signerPaths.socketPath,
                pairedJournal.nextManifest.signer.release,
                Math.min(options.timeoutMs, 15_000),
              );
            });
            pairedJournal = await writeLocalPairedUpdateJournal(
              paths,
              pairedJournal,
              "gateway-verified",
            );
            const committed = await runLocalSignerTransaction(
              { action: "commit" },
              { stateDir: paths.stateDir },
            );
            if (
              !signerIdentitiesEqual(committed.identity, pairedJournal.nextManifest.signer.release)
            ) {
              throw new Error("Committed signer identity changed after paired health verification");
            }
            await measureStage(timings, "paired updater commit cleanup", async () => {
              await atomicWriteJson(paths.manifestPath, pairedJournal.nextManifest, 0o600);
              await syncManagedActivation(paths);
              await updateStableComponents(paths, releaseRoot, true);
              await cleanupReleases(paths, [releaseRoot, previousRoot]);
              await removeLocalPairedUpdateJournal(paths);
            });
          } catch (error) {
            if (pairedJournal.phase === "gateway-verified") {
              const pending = new Error(
                `The Local Gateway and signer passed exact health, but commit cleanup is pending: ${error.message}. Re-run fased update to finish forward recovery.`,
                { cause: error },
              );
              pending.code = "LOCAL_PAIRED_COMMIT_PENDING";
              throw pending;
            }
            activated = false;
            return await rollbackLocalPairedUpdate(paths, pairedJournal, options.timeoutMs, error);
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
            throw new Error(
              `Update rolled back after health verification failed: ${error.message}`,
              { cause: error },
            );
          }

          await measureStage(timings, "updater and rollback cleanup", async () => {
            await updateStableComponents(paths, releaseRoot);
            await cleanupReleases(paths, [releaseRoot, previousRoot]);
          });
        }
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
  if (argv[0] === "local-signer") {
    const result = await runLocalSignerTransaction(parseLocalSignerTransactionArgs(argv));
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
    return;
  }
  if (argv[0] === "hosted-transaction") {
    const { action, timeoutMs, targetServiceAlreadyRestarted } = parseHostedTransactionArgs(argv);
    const result = await runHostedTransactionControl(action, timeoutMs, {
      targetServiceAlreadyRestarted,
    });
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
  activateLocalSignerTransaction,
  commitLocalSignerTransaction,
  createOwnerOnlySnapshot,
  downloadVerifiedLocalSignerRelease,
  loadSignerEnvironment,
  parseLocalSignerTransactionArgs,
  parseHostedTransactionArgs,
  parseSignerReleaseManifest,
  parseSignerVersionOutput,
  prepareLocalSignerTransaction,
  probeLocalSignerHealth,
  readLocalSignerJournal,
  recoverLocalSignerTransaction,
  resolveLocalSignerAsset,
  resolveLocalSignerPaths,
  restoreOwnerOnlySnapshot,
  rollbackLocalSignerTransaction,
  runLocalSignerTransaction,
  runHostedTransactionControl,
  validateHostedTransactionJournal,
};
