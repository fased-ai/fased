#!/usr/bin/env -S node --import tsx

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
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
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as tar from "tar";

type PackageJson = {
  version?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

type SignerReleaseIdentity = {
  version: string;
  commit: string;
  buildInputDigest: string;
  development: false;
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

function signerAssetName(): string {
  const os = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : "";
  const arch = process.arch === "x64" ? "amd64" : process.arch === "arm64" ? "arm64" : "";
  if (!os || !arch) {
    throw new Error(`packed signer smoke does not support ${process.platform}/${process.arch}`);
  }
  return `fased-signerd-${os}-${arch}`;
}

function buildLocalSignerRelease(tempRoot: string): string {
  const releaseRoot = path.join(tempRoot, "signer-release");
  mkdirSync(releaseRoot, { recursive: true });
  const assetName = signerAssetName();
  const assetPath = path.join(releaseRoot, assetName);
  const packageVersion = String(
    (JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as PackageJson)
      .version ?? "",
  );
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  const identityScript = path.join(repoRoot, "scripts", "fased-signerd-build-identity.mjs");
  const identityEnv = {
    ...process.env,
    FASED_SIGNER_BUILD_VERSION: packageVersion,
    FASED_SIGNER_BUILD_COMMIT: commit,
    FASED_SIGNER_BUILD_DEVELOPMENT: "false",
  };
  const identity = JSON.parse(
    execFileSync(process.execPath, [identityScript, "--json"], {
      cwd: repoRoot,
      env: identityEnv,
      encoding: "utf8",
    }),
  ) as SignerReleaseIdentity;
  const ldflags = execFileSync(process.execPath, [identityScript, "--ldflags"], {
    cwd: repoRoot,
    env: identityEnv,
    encoding: "utf8",
  }).trim();
  execFileSync(
    "go",
    [
      "build",
      "-buildvcs=false",
      "-trimpath",
      `-ldflags=-buildid= ${ldflags}`,
      "-o",
      assetPath,
      ".",
    ],
    {
      cwd: path.join(repoRoot, "tools", "fased-signerd"),
      env: process.env,
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  const manifestName = "fased-signerd-release.json";
  const manifestPath = path.join(releaseRoot, manifestName);
  writeFileSync(manifestPath, `${JSON.stringify({ schemaVersion: 1, ...identity }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  const assetDigest = createHash("sha256").update(readFileSync(assetPath)).digest("hex");
  const manifestDigest = createHash("sha256").update(readFileSync(manifestPath)).digest("hex");
  writeFileSync(
    path.join(releaseRoot, "fased-signerd-checksums.txt"),
    `${assetDigest}  ${assetName}\n${manifestDigest}  ${manifestName}\n`,
    {
      encoding: "utf8",
      mode: 0o600,
    },
  );
  return releaseRoot;
}

function stopPackedSigner(stateDir: string): void {
  const pidPath = path.join(stateDir, "wallet", "local-signer.pid");
  try {
    const pid = Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10);
    if (Number.isSafeInteger(pid) && pid > 1) {
      process.kill(pid, "SIGTERM");
    }
  } catch {
    // The command may have failed before the signer started.
  }
}

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

function formatGatewayOutput(stdout: string[], stderr: string[]): string {
  return `--- stdout ---\n${stdout.join("")}\n--- stderr ---\n${stderr.join("")}`;
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  return await new Promise<number>((resolve, reject) => {
    const onError = (error: Error) => {
      server.close();
      reject(error);
    };
    server.once("error", onError);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("packed Gateway smoke could not reserve a loopback TCP port"));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve(port);
        }
      });
    });
  });
}

async function waitForGatewayReady(params: {
  child: ReturnType<typeof spawn>;
  stdout: string[];
  stderr: string[];
  port: number;
  timeoutMs: number;
}): Promise<void> {
  const readyNeedle = `listening on ws://127.0.0.1:${params.port}`;
  const deadline = Date.now() + params.timeoutMs;
  while (Date.now() < deadline) {
    if (`${params.stdout.join("")}\n${params.stderr.join("")}`.includes(readyNeedle)) {
      return;
    }
    if (params.child.exitCode !== null || params.child.signalCode !== null) {
      throw new Error(
        `packed Gateway exited before readiness (code=${String(params.child.exitCode)}, signal=${String(params.child.signalCode)})\n${formatGatewayOutput(params.stdout, params.stderr)}`,
      );
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `packed Gateway did not become ready within ${params.timeoutMs}ms\n${formatGatewayOutput(params.stdout, params.stderr)}`,
  );
}

async function waitForGatewayExit(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error(`packed Gateway did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      resolve({ code, signal });
    };
    child.once("exit", onExit);
  });
}

async function runPackedGateway(coreRoot: string, env: NodeJS.ProcessEnv): Promise<void> {
  const port = await reserveLoopbackPort();
  const stdout: string[] = [];
  const stderr: string[] = [];
  const child = spawn(
    process.execPath,
    [
      path.join(coreRoot, "fased.mjs"),
      "gateway",
      "run",
      "--allow-unconfigured",
      "--bind",
      "loopback",
      "--port",
      String(port),
      "--token",
      "packed-core-smoke-token",
    ],
    {
      cwd: coreRoot,
      env: {
        ...env,
        FASED_DISABLE_BONJOUR: "1",
        FASED_NO_RESPAWN: "1",
        FASED_SKIP_BROWSER_CONTROL_SERVER: "1",
        FASED_SKIP_CANVAS_HOST: "1",
        FASED_SKIP_CRON: "1",
        FASED_SKIP_GMAIL_WATCHER: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => stdout.push(String(chunk)));
  child.stderr?.on("data", (chunk) => stderr.push(String(chunk)));

  let exitResult: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let shutdownError: Error | undefined;
  try {
    await waitForGatewayReady({ child, stdout, stderr, port, timeoutMs: 30_000 });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
    try {
      exitResult = await waitForGatewayExit(child, 15_000);
    } catch (error) {
      child.kill("SIGKILL");
      await waitForGatewayExit(child, 5_000).catch(() => undefined);
      shutdownError = new Error(
        `${error instanceof Error ? error.message : String(error)}\n${formatGatewayOutput(stdout, stderr)}`,
        { cause: error },
      );
    }
  }

  if (shutdownError) {
    throw shutdownError;
  }
  if (!exitResult) {
    throw new Error(
      `packed Gateway exit status was not observed\n${formatGatewayOutput(stdout, stderr)}`,
    );
  }
  if (exitResult.code !== 0 && !(exitResult.code === null && exitResult.signal === "SIGTERM")) {
    throw new Error(
      `packed Gateway shutdown failed (code=${String(exitResult.code)}, signal=${String(exitResult.signal)})\n${formatGatewayOutput(stdout, stderr)}`,
    );
  }
}

function importPackedMain(coreRoot: string, env: NodeJS.ProcessEnv): void {
  const mainUrl = pathToFileURL(path.join(coreRoot, "dist", "index.js")).href;
  try {
    execFileSync(process.execPath, ["--import", mainUrl, "--eval", "", "packed-main-smoke"], {
      cwd: coreRoot,
      env,
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (error) {
    const stderr =
      error && typeof error === "object" && "stderr" in error ? String(error.stderr) : "";
    throw new Error(`packed core main import failed: ${stderr}`, { cause: error });
  }
}

async function main() {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "fased-packed-core-smoke-"));
  let stateDir = "";
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
    stateDir = path.join(tempRoot, "state");
    mkdirSync(home, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    const configPath = path.join(stateDir, "fased.json");
    writeFileSync(configPath, "{}\n", { encoding: "utf8", mode: 0o600 });
    const signerReleaseRoot = buildLocalSignerRelease(tempRoot);
    const env = {
      ...process.env,
      HOME: home,
      FASED_STATE_DIR: stateDir,
      FASED_CONFIG_PATH: configPath,
      FASED_DISABLE_CONFIG_CACHE: "1",
      FASED_LOCAL_SIGNER_BASE_URL: pathToFileURL(signerReleaseRoot).href,
      FASED_LOCAL_SIGNER_VERSION: "",
      FASED_LOCAL_SIGNER_LATEST_TAG: "",
      FASED_LOCAL_SIGNER_ALLOW_UNATTESTED: "1",
      FASED_LOCAL_SIGNER_FLAT_RELEASE: "1",
      NO_COLOR: "1",
    };

    const version = runCore(coreRoot, env, ["--version"]).trim();
    if (!packageJson.version || version !== packageJson.version) {
      throw new Error(`packed version mismatch: expected ${packageJson.version}, got ${version}`);
    }
    importPackedMain(coreRoot, env);
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
    await runPackedGateway(coreRoot, env);
    const walletCreateRaw = runCore(coreRoot, env, [
      "wallet",
      "setup",
      "--mode",
      "local-signer-create",
      "--chain",
      "solana",
      "--wallet-id",
      "packed-smoke-agent",
      "--role",
      "agent",
      "--rpc-url",
      "http://127.0.0.1:8899",
      "--non-interactive",
      "--no-doctor",
      "--json",
    ]);
    const walletCreate = JSON.parse(walletCreateRaw) as {
      ok?: unknown;
      provider?: unknown;
      walletId?: unknown;
      address?: unknown;
      policyState?: unknown;
    };
    if (
      walletCreate.ok !== true ||
      walletCreate.provider !== "local-socket-signer" ||
      walletCreate.walletId !== "packed-smoke-agent" ||
      typeof walletCreate.address !== "string" ||
      walletCreate.address.length === 0 ||
      walletCreate.policyState !== "locked"
    ) {
      throw new Error(`packed core signer-owned wallet creation failed:\n${walletCreateRaw}`);
    }
    const enrollmentLauncher = path.join(home, ".fased", "bin", "fased-signer-enroll");
    if (!existsSync(enrollmentLauncher) || (statSync(enrollmentLauncher).mode & 0o111) === 0) {
      throw new Error("packed signer install did not include the executable enrollment launcher");
    }
    const signerBinary = path.join(home, ".fased", "bin", "fased-signerd");
    const signerStats = statSync(signerBinary);
    const enrollmentStats = statSync(enrollmentLauncher);
    if (signerStats.dev !== enrollmentStats.dev || signerStats.ino !== enrollmentStats.ino) {
      throw new Error("packed signer enrollment launcher is not the attested signer hardlink");
    }
    const policyLauncher = path.join(home, ".fased", "bin", "fased-signer-policy");
    const policyHelper = path.join(home, ".fased", "bin", "fased-signer-owner-policy.mjs");
    const policyTemplates = path.join(home, ".fased", "share", "signer-policies");
    if (
      !existsSync(policyLauncher) ||
      (statSync(policyLauncher).mode & 0o111) === 0 ||
      !existsSync(policyHelper) ||
      (statSync(policyHelper).mode & 0o077) !== 0
    ) {
      throw new Error("packed signer install did not include private Local policy tooling");
    }
    for (const role of ["agent", "mining", "vault"]) {
      const template = path.join(policyTemplates, `${role}.json.template`);
      if (!existsSync(template) || !readFileSync(template, "utf8").includes("REPLACE_WITH_")) {
        throw new Error(`packed signer install is missing inactive ${role} policy template`);
      }
    }
    const policyHelp = execFileSync(policyLauncher, ["--help"], { env, encoding: "utf8" });
    if (!policyHelp.includes("fased-signer-policy --initial-install")) {
      throw new Error("packed signer policy launcher did not expose the fixed-profile owner help");
    }
    for (const dependency of optionalChannelDependencies) {
      if (existsSync(path.join(coreNodeModules, ...dependency.split("/")))) {
        throw new Error(`wallet creation pulled optional channel dependency ${dependency}`);
      }
    }

    console.log(
      `packed-core-smoke: ${version} imports, starts its Gateway, and creates a locked native-signer wallet without optional channels; capabilities, wallet, SAT, Fased Network, and plugin checks passed.`,
    );
  } finally {
    if (stateDir) {
      stopPackedSigner(stateDir);
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

await main();
