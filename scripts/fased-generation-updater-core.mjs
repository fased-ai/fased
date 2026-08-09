#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { generationLifecycle, runGenerationUpdate } from "./generation-updater.mjs";

const DEFAULT_RELEASE_BASE_URL = "https://github.com/fased-ai/fased/releases/download";
const DEFAULT_REGISTRY = "https://registry.npmjs.org";
const DEFAULT_TIMEOUT_MS = 20 * 60_000;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;
const HASH = /^[a-f0-9]{64}$/u;
const INSTANCE = /^[a-z0-9][a-z0-9-]{0,63}$/u;

export const MANAGED_UPDATER_SUPPORT_FILES = Object.freeze([
  "fased-generation-updater-core.mjs",
  "generation-updater.mjs",
  "hosted-release-manifest.mjs",
  "lifecycle-trust-crypto.mjs",
  "lifecycle-trust-policy.mjs",
  "lifecycle-trust-root.mjs",
  "lifecycle-trust-runtime.mjs",
  "managed-runtime-layout.mjs",
]);

function parseArgs(argv) {
  if (argv[0] !== "update") {
    return Object.freeze({ mode: "legacy", argv });
  }
  if (argv[1] && !argv[1].startsWith("-") && argv[1] !== "status") {
    return Object.freeze({ mode: "legacy", argv });
  }
  const status = argv[1] === "status";
  const tokens = status ? argv.slice(2) : argv.slice(1);
  const options = {
    status,
    dryRun: false,
    json: false,
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
    } else if (token === "--timeout") {
      const seconds = Number.parseInt(tokens[index + 1] || "", 10);
      if (!Number.isSafeInteger(seconds) || seconds <= 0) {
        throw new Error("--timeout must be a positive integer (seconds)");
      }
      options.timeoutMs = seconds * 1000;
      index += 1;
    } else if (token === "--channel") {
      options.channel = String(tokens[index + 1] || "").trim();
      options.channelExplicit = true;
      index += 1;
    } else if (token === "--tag") {
      options.tag = String(tokens[index + 1] || "").trim();
      index += 1;
    } else if (
      token === "--yes" ||
      token === "--safe-fallback" ||
      token === "--restart" ||
      token === "--verbose"
    ) {
      // Accepted compatibility flags do not alter the atomic generation transaction.
    } else if (token === "--no-restart") {
      throw new Error("Managed generation updates require restart and health verification");
    } else {
      throw new Error(`Unsupported managed generation update option: ${token}`);
    }
  }
  if (options.channelExplicit && options.channel === "dev") {
    return Object.freeze({ mode: "legacy", argv });
  }
  if (options.channelExplicit && !new Set(["stable", "beta"]).has(options.channel)) {
    throw new Error('--channel must be "stable" or "beta" for a managed installation');
  }
  return Object.freeze({ mode: "generation", options: Object.freeze(options) });
}

function configuredChannel(options) {
  if (options.channelExplicit) {
    return options.channel;
  }
  return "stable";
}

async function readGoLifecycleSelection(env = process.env) {
  const profile = env.FASED_LIFECYCLE_PROFILE;
  const instance = env.FASED_LIFECYCLE_INSTANCE;
  if (!new Set(["protected-local", "hosting"]).has(profile) || !INSTANCE.test(instance ?? "")) {
    throw new Error("Go lifecycle launcher identity is missing or invalid");
  }
  const installRoot = profile === "hosting" ? "/opt/fased" : `/opt/fased/local/${instance}`;
  const lifecycleRoot =
    profile === "hosting"
      ? "/var/lib/fased-lifecycled"
      : `/var/lib/fased-local/${instance}/lifecycle`;
  const config = path.join(lifecycleRoot, "platform.json");
  const runtimeRoot = path.join(installRoot, "current", "payload", "runtime");
  if (
    env.FASED_RUNTIME_SOURCE !== "go-lifecycle" ||
    env.FASED_LIFECYCLE_INSTALL_ROOT !== installRoot ||
    env.FASED_LIFECYCLE_CONFIG !== config ||
    env.FASED_MANAGED_RUNTIME_ROOT !== runtimeRoot
  ) {
    throw new Error("Go lifecycle launcher paths do not match the canonical platform identity");
  }
  const currentRoot = await fsp.realpath(path.join(installRoot, "current"));
  const generationsRoot = await fsp.realpath(path.join(installRoot, "generations"));
  if (currentRoot === generationsRoot || !currentRoot.startsWith(`${generationsRoot}${path.sep}`)) {
    throw new Error("Go lifecycle current pointer escaped its immutable generation store");
  }
  const inventoryPath = path.join(currentRoot, "inventory.json");
  const inventoryInfo = await fsp.lstat(inventoryPath);
  if (
    !inventoryInfo.isFile() ||
    inventoryInfo.isSymbolicLink() ||
    inventoryInfo.size > 16 * 1024 * 1024
  ) {
    throw new Error("Go lifecycle current generation inventory is unsafe");
  }
  const inventory = JSON.parse(await fsp.readFile(inventoryPath, "utf8"));
  if (
    inventory?.schemaVersion !== 3 ||
    !VERSION.test(inventory?.version ?? "") ||
    !HASH.test(inventory?.dependency?.hash ?? "")
  ) {
    throw new Error("Go lifecycle current generation inventory is malformed");
  }
  const dependencyRoot = path.join(
    installRoot,
    "dependencies",
    inventory.dependency.hash,
    "node_modules",
  );
  const dependencyInfo = await fsp.lstat(dependencyRoot);
  if (!dependencyInfo.isDirectory() || dependencyInfo.isSymbolicLink()) {
    throw new Error("Go lifecycle current dependency layer is unsafe");
  }
  return Object.freeze({
    profile,
    instance,
    installRoot,
    config,
    currentVersion: inventory.version,
    dependencyRoot,
  });
}

async function fetchJSON(url, timeoutMs) {
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
  const explicit = options.tag?.replace(/^@fased\/fased@/u, "").replace(/^v/u, "");
  if (explicit && VERSION.test(explicit)) {
    return explicit;
  }
  const registry = (process.env.npm_config_registry || DEFAULT_REGISTRY).replace(/\/+$/u, "");
  const payload = await fetchJSON(
    `${registry}/@fased%2ffased?fased_update=${Date.now()}`,
    options.timeoutMs,
  );
  const tag = explicit || (options.channel === "beta" ? "beta" : "latest");
  const version = payload?.["dist-tags"]?.[tag];
  if (typeof version !== "string" || !VERSION.test(version.trim())) {
    throw new Error(`npm dist-tag ${tag} did not resolve to a Fased version`);
  }
  return version.trim();
}

function architecture() {
  if (process.platform !== "linux" || !new Set(["x64", "arm64"]).has(process.arch)) {
    throw new Error(
      `Managed generation artifacts are unavailable for ${process.platform}/${process.arch}`,
    );
  }
  return process.arch;
}

async function download(url, destination, timeoutMs) {
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

function fixedExecutable(candidates, label, { rootOwned = false } = {}) {
  for (const candidate of candidates) {
    try {
      const resolved = fs.realpathSync(candidate);
      const info = fs.statSync(resolved);
      if (
        info.isFile() &&
        (info.mode & 0o111) !== 0 &&
        (!rootOwned || (info.uid === 0 && (info.mode & 0o022) === 0))
      ) {
        return resolved;
      }
    } catch {
      // Continue through the fixed system path allowlist.
    }
  }
  throw new Error(`${label} is unavailable in a trusted system path`);
}

async function runProcess(command, args, { timeoutMs, echoStderr = false } = {}) {
  return await new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["inherit", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const finish = (ok, code = null, signal = null, error = null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ ok, stdout, stderr: stderr || error?.message || "", code, signal, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs || DEFAULT_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (Buffer.byteLength(stdout) > 2 * 1024 * 1024) {
        child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      stderr += text;
      if (echoStderr) {
        process.stderr.write(text);
      }
      if (Buffer.byteLength(stderr) > 2 * 1024 * 1024) {
        child.kill("SIGKILL");
      }
    });
    child.once("error", (error) => finish(false, null, null, error));
    child.once("close", (code, signal) => finish(code === 0, code, signal));
  });
}

async function verifyOfficialAsset({ assetPath, version, timeoutMs, bundlePath }) {
  const gh = fixedExecutable(["/usr/bin/gh", "/usr/local/bin/gh"], "GitHub CLI");
  const result = await runProcess(
    gh,
    [
      "attestation",
      "verify",
      assetPath,
      "--repo",
      "fased-ai/fased",
      "--bundle",
      bundlePath,
      "--signer-workflow",
      "fased-ai/fased/.github/workflows/hosted-runtime-release.yml",
      "--source-ref",
      `refs/tags/v${version}`,
      "--deny-self-hosted-runners",
    ],
    { timeoutMs },
  );
  if (!result.ok) {
    throw new Error(`Release attestation verification failed: ${result.stderr.trim()}`);
  }
}

function print(value, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(value)}\n`);
    return;
  }
  if (value.outcome === "ALREADY_CURRENT") {
    console.log(`Already current: ${value.version}`);
  } else if (value.outcome === "UPDATE_AVAILABLE") {
    console.log(`Update available: ${value.currentVersion} -> ${value.version}`);
  } else if (value.outcome === "STATUS") {
    console.log(`Fased ${value.currentVersion} (${value.profile}, ${value.owner})`);
  } else {
    console.log(`Updated Fased to ${value.version}`);
  }
}

export async function run(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  if (parsed.mode === "legacy") {
    throw new Error("The managed updater accepts only update and update status commands");
  }
  const selection = await readGoLifecycleSelection();
  const options = { ...parsed.options, channel: configuredChannel(parsed.options) };
  const lifecycle = generationLifecycle(selection);
  if (!lifecycle) {
    throw new Error(
      "Go lifecycle supervisor is unavailable or unsafe; verified repair is required",
    );
  }
  if (options.status) {
    print(
      {
        outcome: "STATUS",
        currentVersion: selection.currentVersion,
        profile: selection.profile,
        channel: options.channel,
        owner: "go-lifecycle",
      },
      options.json,
    );
    return;
  }
  const targetVersion = await resolveTargetVersion(options);
  if (targetVersion === selection.currentVersion) {
    print(
      {
        outcome: "ALREADY_CURRENT",
        currentVersion: selection.currentVersion,
        version: targetVersion,
        profile: selection.profile,
      },
      options.json,
    );
    return;
  }
  if (options.dryRun) {
    print(
      {
        outcome:
          targetVersion === selection.currentVersion ? "ALREADY_CURRENT" : "UPDATE_AVAILABLE",
        currentVersion: selection.currentVersion,
        version: targetVersion,
        profile: selection.profile,
      },
      options.json,
    );
    return;
  }
  const sudoPath = fixedExecutable(["/usr/bin/sudo", "/bin/sudo"], "sudo", {
    rootOwned: true,
  });
  const result = await runGenerationUpdate({
    lifecycle,
    version: targetVersion,
    timeoutMs: options.timeoutMs,
    baseUrl: process.env.FASED_HOSTED_ARTIFACT_BASE_URL || DEFAULT_RELEASE_BASE_URL,
    architecture: architecture(),
    download,
    verifyOfficialAsset,
    runAdministrator: async (command, args, runOptions) =>
      await runProcess(command, args, { ...runOptions, echoStderr: true }),
    sudoPath,
    dependencyRoot: selection.dependencyRoot,
  });
  print({ ...result, currentVersion: selection.currentVersion }, options.json);
}

export const __testing = Object.freeze({
  configuredChannel,
  parseArgs,
  readGoLifecycleSelection,
});
