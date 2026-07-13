#!/usr/bin/env -S node --import tsx

import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as tar from "tar";

type PackageJson = {
  version?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const optionalChannels = ["discord", "slack", "telegram", "whatsapp"] as const;
const optionalRuntimeExtensions = [
  "runtime-browser",
  "runtime-local-memory",
  "runtime-media",
  "runtime-openai",
  "runtime-speech",
] as const;
const optionalChannelDependencies = [
  "@buape/carbon",
  "@discordjs/opus",
  "@discordjs/voice",
  "@grammyjs/runner",
  "@grammyjs/transformer-throttler",
  "@slack/bolt",
  "@slack/web-api",
  "@snazzah/davey",
  "@whiskeysockets/baileys",
  "discord-api-types",
  "grammy",
  "opusscript",
] as const;
const optionalRuntimeDependencies = [
  "@mozilla/readability",
  "@napi-rs/canvas",
  "@openai/codex",
  "file-type",
  "linkedom",
  "node-edge-tts",
  "pdfjs-dist",
  "playwright-core",
  "sharp",
  "sqlite-vec",
] as const;

let invocationIndex = 0;

function runCore(coreRoot: string, env: NodeJS.ProcessEnv, args: string[]): string {
  const outputRoot = env.FASED_STATE_DIR;
  if (!outputRoot) {
    throw new Error("packed core smoke requires FASED_STATE_DIR");
  }
  const invocation = invocationIndex++;
  const stdoutPath = path.join(outputRoot, `smoke-${invocation}.stdout`);
  const stderrPath = path.join(outputRoot, `smoke-${invocation}.stderr`);
  const stdoutFd = openSync(stdoutPath, "w");
  const stderrFd = openSync(stderrPath, "w");
  try {
    execFileSync(process.execPath, [path.join(coreRoot, "fased.mjs"), ...args], {
      cwd: coreRoot,
      env,
      stdio: ["ignore", stdoutFd, stderrFd],
    });
  } catch (error) {
    const stderr = readFileSync(stderrPath, "utf8");
    throw new Error(`packed core command failed (${args.join(" ")}): ${stderr}`, {
      cause: error,
    });
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }
  return readFileSync(stdoutPath, "utf8");
}

async function main() {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "fased-packed-core-smoke-"));
  try {
    const npmCache = path.join(tempRoot, "npm-cache");
    execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", tempRoot], {
      cwd: repoRoot,
      env: { ...process.env, NPM_CONFIG_CACHE: npmCache },
      stdio: ["ignore", "ignore", "pipe"],
    });
    const archiveName = readdirSync(tempRoot).find((entry) => entry.endsWith(".tgz"));
    if (!archiveName) {
      throw new Error("npm pack did not return an archive filename");
    }

    await tar.x({ file: path.join(tempRoot, archiveName), cwd: tempRoot });
    const coreRoot = path.join(tempRoot, "core");
    renameSync(path.join(tempRoot, "package"), coreRoot);

    const packageJson = JSON.parse(
      readFileSync(path.join(coreRoot, "package.json"), "utf8"),
    ) as PackageJson;
    const installedDependencies = {
      ...packageJson.dependencies,
      ...packageJson.optionalDependencies,
    };
    for (const dependency of optionalChannelDependencies) {
      if (installedDependencies[dependency]) {
        throw new Error(`core package still owns optional channel dependency ${dependency}`);
      }
    }
    for (const dependency of optionalRuntimeDependencies) {
      if (installedDependencies[dependency]) {
        throw new Error(`core package still owns optional runtime dependency ${dependency}`);
      }
    }
    for (const channelId of optionalChannels) {
      if (existsSync(path.join(coreRoot, "extensions", channelId))) {
        throw new Error(`core package still ships optional channel extension ${channelId}`);
      }
    }
    for (const directory of optionalRuntimeExtensions) {
      if (existsSync(path.join(coreRoot, "extensions", directory))) {
        throw new Error(`core package still ships optional runtime extension ${directory}`);
      }
    }

    const coreNodeModules = path.join(coreRoot, "node_modules");
    mkdirSync(coreNodeModules, { recursive: true });
    for (const dependency of Object.keys(packageJson.dependencies ?? {})) {
      const segments = dependency.split("/");
      const source = path.join(repoRoot, "node_modules", ...segments);
      if (!existsSync(source)) {
        throw new Error(`release dependency is not installed locally: ${dependency}`);
      }
      const target = path.join(coreNodeModules, ...segments);
      mkdirSync(path.dirname(target), { recursive: true });
      symlinkSync(realpathSync(source), target, process.platform === "win32" ? "junction" : "dir");
    }

    const home = path.join(tempRoot, "home");
    const stateDir = path.join(tempRoot, "state");
    mkdirSync(home, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    const env = {
      ...process.env,
      HOME: home,
      FASED_STATE_DIR: stateDir,
      NO_COLOR: "1",
    };

    const version = runCore(coreRoot, env, ["--version"]).trim();
    if (!packageJson.version || version !== packageJson.version) {
      throw new Error(`packed version mismatch: expected ${packageJson.version}, got ${version}`);
    }
    const componentsRaw = runCore(coreRoot, env, ["components", "--json"]);
    const components = JSON.parse(componentsRaw) as {
      summary?: { coreIncluded?: unknown; optionalInstalled?: unknown; errors?: unknown };
    };
    if (
      components.summary?.coreIncluded !== 5 ||
      components.summary.optionalInstalled !== 0 ||
      components.summary.errors !== 0
    ) {
      throw new Error(`packed core capability catalog failed:\n${componentsRaw}`);
    }
    const doctor = runCore(coreRoot, env, ["plugins", "doctor"]);
    if (!doctor.includes("No plugin issues detected.")) {
      throw new Error(`packed core plugin doctor failed:\n${doctor}`);
    }
    const satInfo = runCore(coreRoot, env, ["plugins", "info", "sat-mining"]);
    if (!satInfo.includes("id: sat-mining") || !satInfo.includes("Status: loaded")) {
      throw new Error(`packed core SAT plugin readiness failed:\n${satInfo}`);
    }
    const federationInfo = runCore(coreRoot, env, ["plugins", "info", "fased-federation"]);
    if (
      !federationInfo.includes("id: fased-federation") ||
      federationInfo.includes("Status: error")
    ) {
      throw new Error(`packed core Fased Network plugin discovery failed:\n${federationInfo}`);
    }
    const walletStatusRaw = runCore(coreRoot, env, ["wallet", "status", "--json"]);
    const walletStatus = JSON.parse(walletStatusRaw) as { ok?: unknown; status?: unknown };
    if (walletStatus.ok !== true || !walletStatus.status) {
      throw new Error(`packed core wallet CLI failed:\n${walletStatusRaw}`);
    }

    console.log(
      `packed-core-smoke: ${version} starts without optional channels; capabilities, wallet, SAT, Fased Network, and plugin checks passed.`,
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

await main();
