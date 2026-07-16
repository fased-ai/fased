import { execSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FasedAgentConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import type {
  WalletChain,
  WalletRuntimeConfig,
  WalletRuntimeMode,
  WalletRuntimeKind,
  WalletProviderId,
} from "../config/types.wallet.js";
import { VERSION } from "../version.js";
import { callLocalSocketSigner } from "../wallet/providers/local-socket-signer-adapter.js";
import { applyWalletPolicyConfig, resolveWalletRoleForId } from "../wallet/wallet-policy.js";
import {
  WALLET_PROVIDER_IDS,
  readWalletProviderRegistry,
  setWalletProvidersEnabled,
} from "../wallet/wallet-provider-registry.js";
import { resolveWalletProviderId } from "../wallet/wallet-provider-resolver.js";
import {
  ensureWalletStateDir,
  resolveLocalSignerBackendSocketPath,
  resolveLocalSignerMaterialRootDir,
  resolveLocalSignerRunAsUser,
  resolveLocalSignerSidecarPaths,
  resolveLocalSignerSocketPath,
  resolveWalletRuntimeConfig,
} from "../wallet/wallet-runtime-config.js";
import type { HostSetupProfile, WizardFlow } from "./onboarding.types.js";
import type { WizardPrompter } from "./prompts.js";

export function resolveSignerdBinaryPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = String(env.FASED_WALLET_LOCAL_SIGNER_BIN ?? "").trim();
  if (explicit) {
    return path.resolve(explicit);
  }
  return path.join(env.HOME ?? "/root", ".fased/bin/fased-signerd");
}

function resolveAppOwnedSignerdStagingPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.HOME ?? "/root", ".fased/bin/fased-signerd");
}
const INSTALL_SCRIPT_RELURLS = [
  "../../scripts/install-fased-signerd.sh",
  "../scripts/install-fased-signerd.sh",
];
const BUILD_SCRIPT_RELURLS = [
  "../../scripts/build-fased-signerd.sh",
  "../scripts/build-fased-signerd.sh",
];
const BROKER_CLI_RELPATHS = ["../entry.js", "../../dist/entry.js"];
const DEFAULT_SIGNER_RELEASE_DOWNLOAD_BASE = "https://github.com/fased-ai/fased/releases/download";
const SIGNER_MAINTENANCE_HELPER = "/usr/local/sbin/fased-signer-maintenance";
const SIGNER_ISOLATION_HELPER = "/usr/local/sbin/fased-signer-isolation";

function runCommand(params: {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  capture?: boolean;
}): string {
  const child = spawnSync(params.command, params.args, {
    env: params.env,
    encoding: "utf8",
    stdio: params.capture ? ["ignore", "pipe", "pipe"] : "ignore",
  });
  if (child.status !== 0) {
    const stderr = typeof child.stderr === "string" ? child.stderr.trim() : "";
    const stdout = typeof child.stdout === "string" ? child.stdout.trim() : "";
    throw new Error(
      stderr || stdout || `${params.command} exited with status ${child.status ?? -1}`,
    );
  }
  return typeof child.stdout === "string" ? child.stdout : "";
}

function isSignerdRunning(socketPath: string): boolean {
  try {
    fs.statSync(socketPath);
    return true;
  } catch {
    return false;
  }
}

async function isSignerdHealthy(socketPath: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 750);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function readFileTail(filePath: string, maxLines = 20): string | undefined {
  try {
    const text = fs.readFileSync(filePath, "utf8").trim();
    if (!text) {
      return undefined;
    }
    return text.split("\n").slice(-maxLines).join("\n");
  } catch {
    return undefined;
  }
}

async function waitForSignerdHealthy(socketPath: string, deadlineMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(1_000, deadlineMs);
  while (Date.now() < deadline) {
    if (isSignerdRunning(socketPath) && (await isSignerdHealthy(socketPath))) {
      return true;
    }
    await sleep(500);
  }
  return isSignerdRunning(socketPath) && (await isSignerdHealthy(socketPath));
}

function resolveSignerdLogPath(params: {
  appSocketPath: string;
  materialDir: string;
  runAsUser?: string;
}): string {
  return params.runAsUser
    ? path.join(path.dirname(params.appSocketPath), "local-signer.log")
    : path.join(params.materialDir, "local-signer.log");
}

function buildSignerdReadinessError(params: {
  appSocketPath: string;
  backendSocketPath: string;
  binPath: string;
  materialDir: string;
  readyTimeoutMs: number;
  runAsUser?: string;
}): Error {
  const signerLogPath = resolveSignerdLogPath({
    appSocketPath: params.appSocketPath,
    materialDir: params.materialDir,
    runAsUser: params.runAsUser,
  });
  const brokerLogPath = path.join(path.dirname(params.appSocketPath), "local-signer-broker.log");
  const logDetails: string[] = [];
  const signerLogTail = readFileTail(signerLogPath);
  if (signerLogTail) {
    logDetails.push(`Signer log tail (${signerLogPath}):\n${signerLogTail}`);
  }
  const brokerLogTail =
    params.backendSocketPath !== params.appSocketPath ? readFileTail(brokerLogPath) : undefined;
  if (brokerLogTail) {
    logDetails.push(`Broker log tail (${brokerLogPath}):\n${brokerLogTail}`);
  }
  return new Error(
    [
      `fased-signerd did not become ready within ${Math.round(params.readyTimeoutMs / 1000)}s.`,
      `Check logs: ${signerLogPath}${params.backendSocketPath !== params.appSocketPath ? `, ${brokerLogPath}` : ""}`,
      `Run manually: ${params.binPath} -socket ${params.backendSocketPath}`,
      ...logDetails,
    ].join("\n"),
  );
}

function normalizeSignerChains(raw: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const value of raw) {
    const normalized = String(value).trim().toLowerCase();
    if (normalized === "solana") {
      out.add(normalized);
    }
  }
  if (out.size === 0) {
    out.add("solana");
  }
  return [...out];
}

function resolveSignerChainsEnvValue(
  cfg: ReturnType<typeof loadConfig>,
  env: NodeJS.ProcessEnv,
): string {
  const explicit = String(
    env.FASED_WALLET_CHAINS ?? cfg.env?.vars?.FASED_WALLET_CHAINS ?? "",
  ).trim();
  if (explicit) {
    return normalizeSignerChains(explicit.split(",")).join(",");
  }
  return normalizeSignerChains(cfg.wallet?.runtime?.chains ?? []).join(",");
}

async function readSignerdHealth(socketPath: string): Promise<{ ok: boolean; chains: string[] }> {
  try {
    const details = await callLocalSocketSigner<{ chains?: string[] }>(socketPath, {
      op: "health",
    });
    return {
      ok: true,
      chains: normalizeSignerChains(details?.chains ?? []),
    };
  } catch {
    return { ok: false, chains: [] };
  }
}

function resolveInstallScript(): string | null {
  for (const rel of INSTALL_SCRIPT_RELURLS) {
    const candidate = fileURLToPath(new URL(rel, import.meta.url));
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function resolveBuildScript(): string | null {
  for (const rel of BUILD_SCRIPT_RELURLS) {
    const candidate = fileURLToPath(new URL(rel, import.meta.url));
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function resolveBrokerCliPath(): string | null {
  for (const rel of BROKER_CLI_RELPATHS) {
    const candidate = fileURLToPath(new URL(rel, import.meta.url));
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function resolveLocalSignerdReleaseBaseUrl(installScriptPath: string): string | null {
  const repoRoot = path.resolve(path.dirname(installScriptPath), "..");
  const releaseDir = path.join(repoRoot, "dist-native", "release");
  const platform = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  const assetPath = path.join(releaseDir, `fased-signerd-${platform}-${arch}`);
  const checksumsPath = path.join(releaseDir, "fased-signerd-checksums.txt");
  if (!fs.existsSync(assetPath) || !fs.existsSync(checksumsPath)) {
    return null;
  }
  return `file://${releaseDir}`;
}

function resolveGoBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = String(env.FASED_GO_BIN ?? "").trim();
  if (explicit && fs.existsSync(explicit)) {
    return explicit;
  }
  if (fs.existsSync("/usr/local/go/bin/go")) {
    return "/usr/local/go/bin/go";
  }
  const child = spawnSync("bash", ["-lc", "command -v go || true"], {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const candidate = String(child.stdout ?? "")
    .trim()
    .split("\n")[0]
    ?.trim();
  return candidate || null;
}

function isGoModernEnough(goBin: string): boolean {
  const child = spawnSync(goBin, ["version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (child.status !== 0) {
    return false;
  }
  const match = String(child.stdout ?? "").match(/\bgo(\d+)\.(\d+)(?:\.(\d+))?\b/);
  if (!match) {
    return false;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3] ?? 0);
  return major > 1 || (major === 1 && (minor > 25 || (minor === 25 && patch >= 7)));
}

function hasExplicitSignerdAssetSource(env: NodeJS.ProcessEnv = process.env): boolean {
  const baseUrl = String(env.FASED_LOCAL_SIGNER_BASE_URL ?? "").trim();
  const version = String(env.FASED_LOCAL_SIGNER_VERSION ?? "").trim();
  const latestTag = String(env.FASED_LOCAL_SIGNER_LATEST_TAG ?? "").trim();
  if (baseUrl && baseUrl !== DEFAULT_SIGNER_RELEASE_DOWNLOAD_BASE) {
    return true;
  }
  if (version && version !== "latest") {
    return true;
  }
  if (latestTag && latestTag !== "latest") {
    return true;
  }
  return false;
}

function runScriptOrThrow(params: {
  script: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  verbose?: boolean;
  fallbackError: string;
}): void {
  const child = spawnSync("bash", [params.script, ...(params.args ?? [])], {
    env: params.env,
    encoding: "utf8",
    stdio: params.verbose ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  if (child.status === 0) {
    return;
  }
  const stderr = typeof child.stderr === "string" ? child.stderr.trim() : "";
  const stdout = typeof child.stdout === "string" ? child.stdout.trim() : "";
  const detail = (stderr || stdout).split("\n").slice(-12).join("\n");
  throw new Error(detail || params.fallbackError);
}

function copySignerdBinaryToTarget(params: {
  sourcePath: string;
  targetPath: string;
  runAsUser?: string;
}): void {
  const sourcePath = path.resolve(params.sourcePath);
  const targetPath = path.resolve(params.targetPath);
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`fased-signerd build completed but binary was not found at ${sourcePath}.`);
  }
  if (params.runAsUser) {
    if (
      runSignerIsolationHelper(params.runAsUser, ["install-binary", sourcePath, targetPath]) ===
      undefined
    ) {
      runCommand({
        command: "sudo",
        args: [
          "bash",
          "-lc",
          [
            "set -euo pipefail",
            `install -d -m 755 -o ${JSON.stringify(params.runAsUser)} -g ${JSON.stringify(params.runAsUser)} ${JSON.stringify(path.dirname(targetPath))}`,
            `install -m 755 -o ${JSON.stringify(params.runAsUser)} -g ${JSON.stringify(params.runAsUser)} ${JSON.stringify(sourcePath)} ${JSON.stringify(targetPath)}`,
          ].join("; "),
        ],
      });
    }
    return;
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);
  fs.chmodSync(targetPath, 0o755);
}

function buildSignerdBinaryFromSource(binPath: string): boolean {
  if (String(process.env.FASED_SKIP_NATIVE_SIGNER_BUILD ?? "").trim() === "1") {
    return false;
  }
  const script = resolveBuildScript();
  const goBin = resolveGoBinary(process.env);
  if (!script || !goBin || !isGoModernEnough(goBin)) {
    return false;
  }
  const verboseInstall =
    String(process.env.FASED_INSTALL_VERBOSE ?? "").trim() === "1" ||
    String(process.env.FASED_ONBOARD_VERBOSE ?? "").trim() === "1";
  runScriptOrThrow({
    script,
    env: { ...process.env, FASED_GO_BIN: goBin },
    verbose: verboseInstall,
    fallbackError: "fased-signerd source build failed",
  });
  const builtPath = path.resolve(path.dirname(script), "..", "dist-native", "fased-signerd");
  copySignerdBinaryToTarget({
    sourcePath: builtPath,
    targetPath: binPath,
    runAsUser: resolveLocalSignerRunAsUser(process.env),
  });
  return true;
}

function resolveSignerdAssetInstallEnv(installScript: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (hasExplicitSignerdAssetSource(env)) {
    return env;
  }
  const localReleaseBaseUrl = resolveLocalSignerdReleaseBaseUrl(installScript);
  if (localReleaseBaseUrl) {
    env.FASED_LOCAL_SIGNER_BASE_URL = localReleaseBaseUrl;
    env.FASED_LOCAL_SIGNER_VERSION = "";
    env.FASED_LOCAL_SIGNER_LATEST_TAG = "";
    return env;
  }
  const normalizedVersion = VERSION.trim().replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(normalizedVersion)) {
    throw new Error(`Cannot resolve a versioned fased-signerd asset for Fased ${VERSION}.`);
  }
  env.FASED_LOCAL_SIGNER_BASE_URL = DEFAULT_SIGNER_RELEASE_DOWNLOAD_BASE;
  env.FASED_LOCAL_SIGNER_VERSION = `v${normalizedVersion}`;
  env.FASED_LOCAL_SIGNER_LATEST_TAG = "";
  return env;
}

function installSignerdBinaryFromAsset(binPath: string): boolean {
  if (process.platform === "win32") {
    throw new Error(
      "The local socket signer requires Unix sockets. On Windows, install and run Fased inside WSL2.",
    );
  }
  if (process.platform !== "linux" && process.platform !== "darwin") {
    throw new Error(`No fased-signerd release asset is available for ${process.platform}.`);
  }
  const script = resolveInstallScript();
  if (!script) {
    return false;
  }
  const runAsUser = resolveLocalSignerRunAsUser(process.env);
  const stagingPath = resolveAppOwnedSignerdStagingPath(process.env);
  const installDir = path.dirname(runAsUser ? stagingPath : binPath);
  const verboseInstall =
    String(process.env.FASED_INSTALL_VERBOSE ?? "").trim() === "1" ||
    String(process.env.FASED_ONBOARD_VERBOSE ?? "").trim() === "1";
  runScriptOrThrow({
    script,
    env: {
      ...resolveSignerdAssetInstallEnv(script),
      FASED_LOCAL_SIGNER_BIN_DIR: installDir,
    },
    verbose: verboseInstall,
    fallbackError: "fased-signerd asset install failed",
  });
  const installedPath = runAsUser ? stagingPath : binPath;
  if (!fs.existsSync(installedPath)) {
    throw new Error(
      `fased-signerd install script ran but binary not found at ${binPath}.\n` +
        `Check install script output above for errors.`,
    );
  }
  if (runAsUser && installedPath !== binPath) {
    if (
      runSignerIsolationHelper(runAsUser, ["install-binary", installedPath, binPath]) === undefined
    ) {
      runCommand({
        command: "sudo",
        args: [
          "bash",
          "-lc",
          [
            "set -euo pipefail",
            `install -d -m 755 -o ${JSON.stringify(runAsUser)} -g ${JSON.stringify(runAsUser)} ${JSON.stringify(path.dirname(binPath))}`,
            `install -m 755 -o ${JSON.stringify(runAsUser)} -g ${JSON.stringify(runAsUser)} ${JSON.stringify(installedPath)} ${JSON.stringify(binPath)}`,
          ].join("; "),
        ],
      });
    }
  }
  if (!fs.existsSync(binPath)) {
    throw new Error(
      `fased-signerd install script completed but target binary not found at ${binPath}.\n` +
        `Check install script output above for errors.`,
    );
  }
  return true;
}

export function installSignerdBinary(binPath: string): void {
  const forceSourceBuild =
    String(process.env.FASED_BUILD_NATIVE_SIGNER_FROM_SOURCE ?? "").trim() === "1";
  if (forceSourceBuild) {
    if (buildSignerdBinaryFromSource(binPath)) {
      return;
    }
    throw new Error(
      "FASED_BUILD_NATIVE_SIGNER_FROM_SOURCE=1 requires a source checkout and Go >= 1.25.7.",
    );
  }

  let assetError: unknown;
  try {
    if (installSignerdBinaryFromAsset(binPath)) {
      return;
    }
  } catch (error) {
    assetError = error;
  }

  let sourceError: unknown;
  try {
    if (buildSignerdBinaryFromSource(binPath)) {
      return;
    }
  } catch (error) {
    sourceError = error;
  }

  const assetDetail = assetError instanceof Error ? assetError.message : undefined;
  const sourceDetail = sourceError instanceof Error ? sourceError.message : undefined;
  throw new Error(
    [
      `Automatic fased-signerd installation failed for ${process.platform}/${process.arch}.`,
      `Fased ${VERSION} normally downloads its matching prebuilt signer and verifies its SHA-256 checksum; Go is not required.`,
      assetDetail
        ? `Asset install: ${assetDetail}`
        : "The packaged signer installer was not found.",
      sourceDetail ? `Source fallback: ${sourceDetail}` : undefined,
      "Retry after checking GitHub release access, or set FASED_WALLET_LOCAL_SIGNER_BIN to a trusted existing binary.",
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n"),
  );
}

function hasScopedWalletEnvValue(env: NodeJS.ProcessEnv, prefix: string): boolean {
  return Object.entries(env).some(
    ([key, value]) =>
      key.startsWith(`${prefix}__`) && typeof value === "string" && value.trim().length > 0,
  );
}

function hasLocalSignerMaterialEnv(env: NodeJS.ProcessEnv): boolean {
  if (
    String(env.FASED_WALLET_LOCAL_SIGNER_SOCKET ?? "").trim() ||
    String(env.FASED_WALLET_LOCAL_SIGNER_BACKEND_SOCKET ?? "").trim() ||
    String(env.FASED_WALLET_SIGNER_STATE_DIR ?? "").trim() ||
    String(env.FASED_WALLET_PASSPHRASE_FILE ?? "").trim()
  ) {
    return true;
  }
  return Object.entries(env).some(([key, rawValue]) => {
    if (typeof rawValue !== "string" || rawValue.trim().length === 0) {
      return false;
    }
    return (
      key === "FASED_WALLET_SOLANA_KEYSTORE_PATH" ||
      key.startsWith("FASED_WALLET_SOLANA_KEYSTORE_PATH__")
    );
  });
}

function normalizeWalletIdForEnvSuffix(walletId: string): string | undefined {
  const normalized = walletId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || undefined;
}

function normalizeWalletIdForFilename(walletId: string): string | undefined {
  const normalized = walletId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || undefined;
}

function inferScopedSignerKeystoreEnv(
  materialDir: string,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const inferred: NodeJS.ProcessEnv = {};
  try {
    const registry = readWalletProviderRegistry(env);
    for (const wallet of registry.wallets) {
      if (wallet.providerId !== "local-socket-signer") {
        continue;
      }
      const envSuffix = normalizeWalletIdForEnvSuffix(wallet.id)?.toUpperCase();
      const fileSuffix = normalizeWalletIdForFilename(wallet.id);
      if (!envSuffix || !fileSuffix) {
        continue;
      }
      const solanaKey = `FASED_WALLET_SOLANA_KEYSTORE_PATH__${envSuffix}`;
      if (!String(env[solanaKey] ?? "").trim()) {
        const candidate = path.join(materialDir, `keystore-solana-${fileSuffix}.v1.enc`);
        if (fs.existsSync(candidate)) {
          inferred[solanaKey] = candidate;
        }
      }
    }
  } catch {}
  return inferred;
}

export function shouldSyncLocalSocketSignerFromConfig(params?: {
  config?: FasedAgentConfig;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const cfg = params?.config ?? loadConfig();
  if (cfg.wallet?.runtime?.enabled === false) {
    return false;
  }
  const mergedEnv = { ...(params?.env ?? process.env), ...cfg.env?.vars };
  if (resolveWalletProviderId(cfg, mergedEnv) === "local-socket-signer") {
    return true;
  }
  if (hasLocalSignerMaterialEnv(mergedEnv)) {
    return true;
  }
  try {
    const registry = readWalletProviderRegistry(mergedEnv);
    return registry.wallets.some((wallet) => wallet.providerId === "local-socket-signer");
  } catch {
    return false;
  }
}

function resolveLocalSignerPassphraseSource(
  materialDir: string,
  env: NodeJS.ProcessEnv,
):
  | { kind: "file"; path: string; value: string }
  | { kind: "value"; value: string }
  | { kind: "none" } {
  const configuredFile = String(env.FASED_WALLET_PASSPHRASE_FILE ?? "").trim();
  const candidates = [
    configuredFile ? path.resolve(configuredFile) : "",
    path.join(materialDir, "passphrase"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const value = fs.readFileSync(candidate, "utf8").trim();
      if (value) {
        return { kind: "file", path: candidate, value };
      }
    } catch {}
  }
  const explicit = String(env.FASED_WALLET_PASSPHRASE ?? "").trim();
  if (explicit) {
    return { kind: "value", value: explicit };
  }
  return { kind: "none" };
}

function resolveSignerChildEnv(
  materialDir: string,
  env: NodeJS.ProcessEnv = process.env,
  cfg: FasedAgentConfig = loadConfig(),
): NodeJS.ProcessEnv {
  const configEnv = cfg.env?.vars ?? {};
  const mergedEnv = { ...env, ...configEnv } as NodeJS.ProcessEnv;
  const inferredScopedEnv = inferScopedSignerKeystoreEnv(materialDir, mergedEnv);
  const signerEnv = { ...mergedEnv, ...inferredScopedEnv } as NodeJS.ProcessEnv;
  const hasScopedSolKeystore = hasScopedWalletEnvValue(
    signerEnv,
    "FASED_WALLET_SOLANA_KEYSTORE_PATH",
  );
  const childBaseEnv = { ...signerEnv } as NodeJS.ProcessEnv;
  if (hasScopedSolKeystore) {
    delete childBaseEnv.FASED_WALLET_SOLANA_KEYSTORE_PATH;
  }
  const explicitSolPath = String(signerEnv.FASED_WALLET_SOLANA_KEYSTORE_PATH ?? "").trim();
  const passphraseSource = resolveLocalSignerPassphraseSource(materialDir, signerEnv);
  const isolatedPassphraseFile = resolveLocalSignerRunAsUser(signerEnv)
    ? path.resolve(
        String(signerEnv.FASED_WALLET_PASSPHRASE_FILE ?? "").trim() ||
          path.join(materialDir, "passphrase"),
      )
    : "";
  const solPath = hasScopedSolKeystore
    ? ""
    : explicitSolPath || path.join(materialDir, "keystore-solana.v1.enc");
  const chains = resolveSignerChainsEnvValue(cfg, signerEnv);
  const chainSet = new Set(
    chains
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
  return {
    ...childBaseEnv,
    FASED_WALLET_CHAINS: chains,
    ...(chainSet.has("solana") && solPath ? { FASED_WALLET_SOLANA_KEYSTORE_PATH: solPath } : {}),
    ...(passphraseSource.kind === "file"
      ? {
          FASED_WALLET_PASSPHRASE_FILE: passphraseSource.path,
          FASED_WALLET_PASSPHRASE: undefined,
        }
      : isolatedPassphraseFile
        ? {
            FASED_WALLET_PASSPHRASE_FILE: isolatedPassphraseFile,
            FASED_WALLET_PASSPHRASE: undefined,
          }
        : passphraseSource.kind === "value"
          ? { FASED_WALLET_PASSPHRASE: passphraseSource.value }
          : {}),
  };
}

const LOCAL_SIGNER_EXPORTABLE_PREFIXES = [
  "FASED_WALLET_SOLANA_KEYSTORE_PATH",
  "FASED_WALLET_SOLANA_RPC_URL",
  "FASED_WALLET_SOLANA_WRITE_RPC_FALLBACK_URL",
  "FASED_WALLET_RPC_URL",
  "FASED_WALLET_EMBEDDED_KEYSTORE_RPC_URL",
  "FASED_WALLET_CUSTODY_MODE",
  "FASED_WALLET_CUSTODY_WALLETS",
  "FASED_WALLET_CUSTODY_PASSKEY_CEREMONY",
  "FASED_WALLET_CUSTODY_EPHEMERAL_RECONSTRUCTION",
  "FASED_WALLET_CUSTODY_PHASE2_COMPLETE",
] as const;

function collectLocalSignerExportEnv(childEnv: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(childEnv)) {
    if (
      !LOCAL_SIGNER_EXPORTABLE_PREFIXES.some(
        (prefix) => key === prefix || key.startsWith(`${prefix}__`),
      )
    ) {
      continue;
    }
    const value = String(rawValue ?? "").trim();
    if (!value) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

function walletPolicyEnvSuffix(walletId: string): string {
  return walletId
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function addLocalSignerPolicyEnv(
  out: Record<string, string>,
  params: {
    prefix: string;
    role: "agent" | "mining" | "vault";
    policy: ReturnType<typeof resolveWalletRuntimeConfig>["policy"];
  },
) {
  const key = (name: string) => `${name}${params.prefix}`;
  out[key("FASED_WALLET_LOCAL_SIGNER_ROLE")] = params.role;
  out[key("FASED_WALLET_LOCAL_SIGNER_DIRECT_SIGNING")] = params.policy.directSigning ? "1" : "0";
  out[key("FASED_WALLET_LOCAL_SIGNER_CAPS_ENABLED")] = params.policy.capsEnabled ? "1" : "0";
  out[key("FASED_WALLET_LOCAL_SIGNER_SOLANA_MAX_PER_TX")] =
    params.policy.solana.caps.maxPerTx.toString();
  out[key("FASED_WALLET_LOCAL_SIGNER_SOLANA_MAX_DAILY")] =
    params.policy.solana.caps.maxDaily.toString();
  if (params.policy.solana.allowPrograms.length > 0) {
    out[key("FASED_WALLET_LOCAL_SIGNER_SOLANA_ALLOW_PROGRAMS")] =
      params.policy.solana.allowPrograms.join(",");
  }
}

function collectLocalSignerPolicyExportEnv(
  cfg: FasedAgentConfig,
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  const out: Record<string, string> = {};
  const registry = readWalletProviderRegistry(env);
  const localSignerWallets = registry.wallets.filter(
    (wallet) => wallet.providerId === "local-socket-signer" && wallet.id.trim(),
  );
  if (localSignerWallets.length === 0) {
    return out;
  }
  const baseRuntime = resolveWalletRuntimeConfig(cfg, env);
  for (const wallet of localSignerWallets) {
    const role = resolveWalletRoleForId({ walletId: wallet.id, cfg, env });
    const runtime = applyWalletPolicyConfig({
      config: baseRuntime,
      cfg,
      env,
      walletId: wallet.id,
    });
    const suffix = walletPolicyEnvSuffix(wallet.id);
    if (!suffix) {
      continue;
    }
    addLocalSignerPolicyEnv(out, {
      prefix: `__${suffix}`,
      role,
      policy: runtime.policy,
    });
    if (registry.defaultWalletId === wallet.id || localSignerWallets.length === 1) {
      addLocalSignerPolicyEnv(out, {
        prefix: "",
        role,
        policy: runtime.policy,
      });
    }
  }
  return out;
}

export function renderLocalSignerEnvFile(params?: {
  config?: FasedAgentConfig;
  env?: NodeJS.ProcessEnv;
}): string {
  const cfg = params?.config ?? loadConfig();
  const mergedEnv = { ...(params?.env ?? process.env), ...cfg.env?.vars };
  const walletRoot = ensureWalletStateDir(mergedEnv).rootDir;
  const materialDir = resolveLocalSignerMaterialRootDir(mergedEnv);
  const socketPath = resolveLocalSignerSocketPath(mergedEnv);
  const backendSocketPath = resolveLocalSignerBackendSocketPath(mergedEnv);
  const signerBinPath = resolveSignerdBinaryPath(mergedEnv);
  const childEnv = resolveSignerChildEnv(materialDir, mergedEnv, cfg);
  const exportLines = Object.entries({
    ...collectLocalSignerExportEnv(childEnv),
    ...collectLocalSignerPolicyExportEnv(cfg, mergedEnv),
  })
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `export ${key}="${value.replaceAll('"', '\\"')}"`);
  const lines = [
    `export FASED_WALLET_LOCAL_SIGNER_SOCKET="${socketPath}"`,
    ...(backendSocketPath !== socketPath
      ? [`export FASED_WALLET_LOCAL_SIGNER_BACKEND_SOCKET="${backendSocketPath}"`]
      : []),
    ...(materialDir !== walletRoot
      ? [`export FASED_WALLET_SIGNER_STATE_DIR="${materialDir}"`]
      : []),
    `export FASED_WALLET_CHAINS="${String(childEnv.FASED_WALLET_CHAINS ?? "solana").trim() || "solana"}"`,
    ...(String(childEnv.FASED_WALLET_PASSPHRASE ?? "").trim()
      ? [
          `export FASED_WALLET_PASSPHRASE="${String(childEnv.FASED_WALLET_PASSPHRASE ?? "")
            .trim()
            .replaceAll('"', '\\"')}"`,
        ]
      : String(childEnv.FASED_WALLET_PASSPHRASE_FILE ?? "").trim()
        ? [
            `export FASED_WALLET_PASSPHRASE_FILE="${String(childEnv.FASED_WALLET_PASSPHRASE_FILE ?? "").trim()}"`,
          ]
        : []),
    ...exportLines,
    "",
    `"${signerBinPath}" --socket "\${FASED_WALLET_LOCAL_SIGNER_BACKEND_SOCKET:-$FASED_WALLET_LOCAL_SIGNER_SOCKET}"`,
  ];
  return `${lines.join("\n")}\n`;
}

export function writeLocalSignerEnvFile(params?: {
  config?: FasedAgentConfig;
  env?: NodeJS.ProcessEnv;
}): string {
  const cfg = params?.config ?? loadConfig();
  const mergedEnv = { ...(params?.env ?? process.env), ...cfg.env?.vars };
  const signerEnvPath = path.resolve(ensureWalletStateDir(mergedEnv).rootDir, "signer.env");
  fs.mkdirSync(path.dirname(signerEnvPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(signerEnvPath, renderLocalSignerEnvFile({ config: cfg, env: mergedEnv }), {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    fs.chmodSync(signerEnvPath, 0o600);
  } catch {}
  return signerEnvPath;
}

function resolveCurrentUnixUser(): string {
  const explicit = String(process.env.USER ?? process.env.LOGNAME ?? "").trim();
  if (explicit) {
    return explicit;
  }
  try {
    return execSync("id -un", { encoding: "utf8" }).trim() || "app";
  } catch {
    return "app";
  }
}

function runSignerIsolationHelper(
  runAsUser: string,
  args: string[],
  opts?: { capture?: boolean },
): string | undefined {
  const helperArgs = signerMaintenanceHelperArgs(runAsUser, args);
  if (!helperArgs) {
    return undefined;
  }
  try {
    return runCommand({
      command: "sudo",
      args: ["-n", "-E", ...helperArgs],
      capture: opts?.capture,
    });
  } catch (err) {
    if (err instanceof Error) {
      throw err;
    }
    throw new Error(String(err), { cause: err });
  }
}

function startSignerIsolationHelperBackground(
  runAsUser: string,
  args: string[],
  logPath: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const helperArgs = signerMaintenanceHelperArgs(runAsUser, args);
  if (!helperArgs) {
    return false;
  }
  const out = fs.openSync(logPath, "a", 0o600);
  const child = spawn("sudo", ["-n", "-E", ...helperArgs], {
    detached: true,
    stdio: ["ignore", out, out],
    env: { ...process.env, ...env },
  });
  child.unref();
  return true;
}

function signerMaintenanceHelperArgs(runAsUser: string, args: string[]): string[] | undefined {
  if (fs.existsSync(SIGNER_MAINTENANCE_HELPER)) {
    return [SIGNER_MAINTENANCE_HELPER, ...args];
  }
  if (fs.existsSync(SIGNER_ISOLATION_HELPER)) {
    return [SIGNER_ISOLATION_HELPER, resolveCurrentUnixUser(), runAsUser, ...args];
  }
  return undefined;
}

function ensureIsolatedSignerPaths(
  materialDir: string,
  backendSocketPath: string,
  appSocketPath: string,
  runAsUser: string,
) {
  const helperResult = runSignerIsolationHelper(runAsUser, [
    "prepare",
    materialDir,
    backendSocketPath,
    appSocketPath,
    resolveSignerdBinaryPath(process.env),
  ]);
  if (helperResult !== undefined) {
    return;
  }
  const appUser = resolveCurrentUnixUser();
  const signerWalletDir = path.dirname(materialDir);
  const signerRootDir = path.dirname(signerWalletDir);
  const commands = [
    `install -d -m 700 -o ${JSON.stringify(runAsUser)} -g ${JSON.stringify(runAsUser)} ${JSON.stringify(materialDir)}`,
    `install -d -m 700 -o ${JSON.stringify(runAsUser)} -g ${JSON.stringify(runAsUser)} ${JSON.stringify(path.dirname(backendSocketPath))}`,
  ];
  if (appSocketPath !== backendSocketPath) {
    commands.unshift(
      `install -d -m 710 -o ${JSON.stringify(runAsUser)} -g ${JSON.stringify(appUser)} ${JSON.stringify(signerRootDir)}`,
      `install -d -m 710 -o ${JSON.stringify(runAsUser)} -g ${JSON.stringify(appUser)} ${JSON.stringify(signerWalletDir)}`,
      `install -d -m 2770 -o ${JSON.stringify(runAsUser)} -g ${JSON.stringify(appUser)} ${JSON.stringify(path.dirname(appSocketPath))}`,
    );
  }
  runCommand({
    command: "sudo",
    args: ["bash", "-lc", ["set -euo pipefail", ...commands].join("; ")],
  });
}

function ensureLocalSignerPassphrase(): string {
  const materialDir = resolveLocalSignerMaterialRootDir(process.env);
  const runAsUser = resolveLocalSignerRunAsUser(process.env);
  const appSocketPath = resolveLocalSignerSocketPath(process.env);
  const backendSocketPath = resolveLocalSignerBackendSocketPath(process.env);
  if (runAsUser) {
    ensureIsolatedSignerPaths(materialDir, backendSocketPath, appSocketPath, runAsUser);
  }
  const existing = resolveLocalSignerPassphraseSource(materialDir, process.env);
  if (existing.kind === "file") {
    process.env.FASED_WALLET_PASSPHRASE_FILE = existing.path;
    delete process.env.FASED_WALLET_PASSPHRASE;
    return existing.value;
  }
  if (runAsUser) {
    const generated =
      existing.kind === "value" ? existing.value : randomBytes(24).toString("base64url");
    const stagingDir = ensureWalletStateDir(process.env).rootDir;
    const stagingPath = path.join(
      stagingDir,
      `.local-signer-passphrase-${process.pid}-${Date.now()}`,
    );
    fs.mkdirSync(path.dirname(stagingPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(stagingPath, `${generated}\n`, { encoding: "utf8", mode: 0o600 });
    try {
      fs.chmodSync(stagingPath, 0o600);
    } catch {}
    let passphrasePath = path.join(materialDir, "passphrase");
    try {
      const helperResult = runSignerIsolationHelper(
        runAsUser,
        ["install-passphrase", stagingPath, materialDir],
        {
          capture: true,
        },
      );
      if (helperResult === undefined) {
        runCommand({
          command: "sudo",
          args: [
            "bash",
            "-lc",
            [
              "set -euo pipefail",
              `test ! -e ${JSON.stringify(passphrasePath)}`,
              `install -d -m 700 -o ${JSON.stringify(runAsUser)} -g ${JSON.stringify(runAsUser)} ${JSON.stringify(materialDir)}`,
              `install -m 600 -o ${JSON.stringify(runAsUser)} -g ${JSON.stringify(runAsUser)} ${JSON.stringify(stagingPath)} ${JSON.stringify(passphrasePath)}`,
              `rm -f ${JSON.stringify(stagingPath)}`,
            ].join("; "),
          ],
        });
      } else {
        passphrasePath = helperResult.trim() || passphrasePath;
      }
      process.env.FASED_WALLET_PASSPHRASE = generated;
    } catch (err) {
      try {
        fs.rmSync(stagingPath, { force: true });
      } catch {}
      const detail = err instanceof Error ? err.message : String(err);
      if (!detail.includes("passphrase already exists")) {
        throw err;
      }
      delete process.env.FASED_WALLET_PASSPHRASE;
    }
    process.env.FASED_WALLET_PASSPHRASE_FILE = passphrasePath;
    return process.env.FASED_WALLET_PASSPHRASE ?? "";
  }
  if (existing.kind === "value") {
    process.env.FASED_WALLET_PASSPHRASE = existing.value;
    delete process.env.FASED_WALLET_PASSPHRASE_FILE;
    return existing.value;
  }
  const generated = randomBytes(24).toString("base64url");
  const passphraseFile = path.join(materialDir, "passphrase");
  fs.mkdirSync(path.dirname(passphraseFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(passphraseFile, `${generated}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(passphraseFile, 0o600);
  } catch {}
  process.env.FASED_WALLET_PASSPHRASE_FILE = passphraseFile;
  delete process.env.FASED_WALLET_PASSPHRASE;
  return generated;
}

function startSignerdBackground(
  binPath: string,
  socketPath: string,
  materialDir: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const runAsUser = resolveLocalSignerRunAsUser(env);
  const childEnv = resolveSignerChildEnv(materialDir, env);
  const appSocketPath = resolveLocalSignerSocketPath(env);
  const backendSocketPath = resolveLocalSignerBackendSocketPath(env);
  const { pidPath, auditPath } = resolveLocalSignerSidecarPaths(socketPath);
  const logPath = resolveSignerdLogPath({ appSocketPath, materialDir, runAsUser });
  if (runAsUser && process.getuid?.() === 0) {
    throw new Error("signer isolation should not be started directly as root");
  }
  if (runAsUser) {
    ensureIsolatedSignerPaths(materialDir, backendSocketPath, appSocketPath, runAsUser);
    const envArgs = Object.entries(childEnv)
      .filter(([, value]) => typeof value === "string" && value.trim())
      .map(([key, value]) => `${key}=${value}`);
    try {
      if (
        !startSignerIsolationHelperBackground(
          runAsUser,
          ["start-signerd", binPath, socketPath, pidPath, auditPath],
          logPath,
          childEnv,
        )
      ) {
        execSync(
          [
            "sudo",
            "-u",
            runAsUser,
            "-H",
            "env",
            ...envArgs.map((value) => JSON.stringify(value)),
            "bash",
            "-lc",
            JSON.stringify(
              [
                "set -euo pipefail",
                "umask 077",
                `${JSON.stringify(binPath)} -socket ${JSON.stringify(socketPath)} -pid-file ${JSON.stringify(pidPath)} -audit-log ${JSON.stringify(auditPath)} >> ${JSON.stringify(logPath)} 2>&1 &`,
              ].join("; "),
            ),
          ].join(" "),
          { stdio: "ignore" },
        );
      }
      return;
    } catch (err) {
      throw new Error(
        `failed to launch isolated signer as ${runAsUser}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }
  const out = fs.openSync(logPath, "a", 0o600);
  const err = fs.openSync(logPath, "a", 0o600);
  const child = spawn(
    binPath,
    ["-socket", socketPath, "-pid-file", pidPath, "-audit-log", auditPath],
    {
      detached: true,
      stdio: ["ignore", out, err],
      env: childEnv,
    },
  );
  child.unref();
}

function stopProcessBySocket(socketPath: string, runAsUser?: string): void {
  const { pidPath } = resolveLocalSignerSidecarPaths(socketPath);
  const legacyPidPath = `${socketPath}.pid`;
  const pidPaths = Array.from(new Set([pidPath, legacyPidPath]));
  if (runAsUser) {
    let stoppedWithHelper = false;
    for (const candidatePidPath of pidPaths) {
      const helperResult = runSignerIsolationHelper(runAsUser, [
        "stop",
        socketPath,
        candidatePidPath,
      ]);
      if (helperResult !== undefined) {
        stoppedWithHelper = true;
      }
    }
    if (stoppedWithHelper) {
      return;
    }
    for (const candidatePidPath of pidPaths) {
      try {
        const rawPid = runCommand({
          command: "sudo",
          args: [
            "bash",
            "-lc",
            `if [ -f ${JSON.stringify(candidatePidPath)} ]; then cat ${JSON.stringify(candidatePidPath)}; fi`,
          ],
          capture: true,
        }).trim();
        const pid = Number.parseInt(rawPid, 10);
        if (Number.isFinite(pid) && pid > 0) {
          runCommand({
            command: "sudo",
            args: [
              "bash",
              "-lc",
              `cmd=$(ps -p ${pid} -o command= 2>/dev/null || true); case "$cmd" in *fased-signerd*|*local-socket-signer-broker*) kill ${pid} >/dev/null 2>&1 || true ;; esac`,
            ],
          });
        }
      } catch {}
      try {
        runCommand({
          command: "sudo",
          args: [
            "bash",
            "-lc",
            `rm -f ${JSON.stringify(socketPath)} ${JSON.stringify(candidatePidPath)}`,
          ],
        });
      } catch {}
    }
    return;
  }
  for (const candidatePidPath of pidPaths) {
    try {
      const pid = Number.parseInt(fs.readFileSync(candidatePidPath, "utf8").trim(), 10);
      if (Number.isFinite(pid) && pid > 0) {
        try {
          const command = readProcessCommand(pid);
          if (isLocalSignerProcessCommand(command)) {
            process.kill(pid, "SIGTERM");
          }
        } catch {}
      }
    } catch {}
    try {
      fs.unlinkSync(candidatePidPath);
    } catch {}
  }
  try {
    fs.unlinkSync(socketPath);
  } catch {}
}

function readProcessCommand(pid: number): string {
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ").trim();
    if (cmdline) {
      return cmdline;
    }
  } catch {}
  try {
    return execSync(`ps -p ${pid} -o command=`, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function isLocalSignerProcessCommand(command: string): boolean {
  const lower = command.toLowerCase();
  return lower.includes("fased-signerd") || lower.includes("local-socket-signer-broker");
}

function startSignerBrokerBackground(
  appSocketPath: string,
  backendSocketPath: string,
  materialDir: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const brokerCli = resolveBrokerCliPath();
  if (!brokerCli) {
    const tried = BROKER_CLI_RELPATHS.map((rel) => fileURLToPath(new URL(rel, import.meta.url)));
    throw new Error(`wallet signer broker CLI not built. Tried: ${tried.join(", ")}`);
  }
  const logPath = path.join(path.dirname(appSocketPath), "local-signer-broker.log");
  const runAsUser = resolveLocalSignerRunAsUser(env);
  const { pidPath, auditPath } = resolveLocalSignerSidecarPaths(appSocketPath);
  if (runAsUser) {
    ensureIsolatedSignerPaths(materialDir, backendSocketPath, appSocketPath, runAsUser);
    const envArgs = Object.entries({
      ...env,
      FASED_WALLET_LOCAL_SIGNER_SOCKET: appSocketPath,
      FASED_WALLET_LOCAL_SIGNER_BACKEND_SOCKET: backendSocketPath,
    })
      .filter(([, value]) => typeof value === "string" && value.trim())
      .map(([key, value]) => `${key}=${value}`);
    try {
      if (
        !startSignerIsolationHelperBackground(
          runAsUser,
          [
            "start-broker",
            process.execPath,
            brokerCli,
            appSocketPath,
            backendSocketPath,
            pidPath,
            auditPath,
          ],
          logPath,
          {
            ...env,
            FASED_WALLET_LOCAL_SIGNER_SOCKET: appSocketPath,
            FASED_WALLET_LOCAL_SIGNER_BACKEND_SOCKET: backendSocketPath,
          },
        )
      ) {
        execSync(
          [
            "sudo",
            "-u",
            runAsUser,
            "-H",
            "env",
            ...envArgs.map((value) => JSON.stringify(value)),
            "bash",
            "-lc",
            JSON.stringify(
              [
                "set -euo pipefail",
                "umask 007",
                `${JSON.stringify(process.execPath)} ${JSON.stringify(brokerCli)} wallet signer broker --socket ${JSON.stringify(appSocketPath)} --backend-socket ${JSON.stringify(backendSocketPath)} --pid-file ${JSON.stringify(pidPath)} --audit-log ${JSON.stringify(auditPath)} >> ${JSON.stringify(logPath)} 2>&1 &`,
              ].join("; "),
            ),
          ].join(" "),
          { stdio: "ignore" },
        );
      }
      return;
    } catch (err) {
      throw new Error(
        `failed to launch isolated signer broker as ${runAsUser}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }
  const out = fs.openSync(logPath, "a", 0o600);
  const err = fs.openSync(logPath, "a", 0o600);
  const child = spawn(
    process.execPath,
    [
      brokerCli,
      "wallet",
      "signer",
      "broker",
      "--socket",
      appSocketPath,
      "--backend-socket",
      backendSocketPath,
      "--pid-file",
      pidPath,
      "--audit-log",
      auditPath,
    ],
    {
      detached: true,
      stdio: ["ignore", out, err],
      env: {
        ...env,
        FASED_WALLET_LOCAL_SIGNER_SOCKET: appSocketPath,
        FASED_WALLET_LOCAL_SIGNER_BACKEND_SOCKET: backendSocketPath,
      },
    },
  );
  child.unref();
}

export async function restartLocalSocketSigner(
  walletDir?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  void walletDir;
  const socketPath = resolveLocalSignerSocketPath(env);
  const backendSocketPath = resolveLocalSignerBackendSocketPath(env);
  const binPath = resolveSignerdBinaryPath(env);
  const materialDir = resolveLocalSignerMaterialRootDir(env);
  const runAsUser = resolveLocalSignerRunAsUser(env);
  if (!fs.existsSync(binPath)) {
    return;
  }
  stopProcessBySocket(socketPath, runAsUser);
  if (backendSocketPath !== socketPath) {
    stopProcessBySocket(backendSocketPath, runAsUser);
  }
  startSignerdBackground(binPath, backendSocketPath, materialDir, env);
  if (backendSocketPath !== socketPath) {
    startSignerBrokerBackground(socketPath, backendSocketPath, materialDir, env);
  }
  const readyTimeoutMs = runAsUser ? 20_000 : 8_000;
  if (!(await waitForSignerdHealthy(socketPath, readyTimeoutMs))) {
    throw buildSignerdReadinessError({
      appSocketPath: socketPath,
      backendSocketPath,
      binPath,
      materialDir,
      readyTimeoutMs,
      runAsUser,
    });
  }
}

export async function syncLocalSocketSignerFromConfig(params?: {
  config?: FasedAgentConfig;
  env?: NodeJS.ProcessEnv;
  restart?: boolean;
}): Promise<{ performed: boolean; restarted: boolean; signerEnvPath?: string }> {
  const cfg = params?.config ?? loadConfig();
  const mergedEnv = { ...(params?.env ?? process.env), ...cfg.env?.vars };
  if (!shouldSyncLocalSocketSignerFromConfig({ config: cfg, env: mergedEnv })) {
    return { performed: false, restarted: false };
  }
  const signerEnvPath = writeLocalSignerEnvFile({ config: cfg, env: mergedEnv });
  const binPath = resolveSignerdBinaryPath(mergedEnv);
  if (!fs.existsSync(binPath)) {
    installSignerdBinary(binPath);
  }
  if (params?.restart === false) {
    return { performed: true, restarted: false, signerEnvPath };
  }
  await restartLocalSocketSigner(undefined, mergedEnv);
  return { performed: true, restarted: true, signerEnvPath };
}

export function migrateLocalSignerKeystoreToMaterialDir(params: {
  keystorePath: string;
  force?: boolean;
}): string {
  const runAsUser = resolveLocalSignerRunAsUser(process.env);
  const materialDir = resolveLocalSignerMaterialRootDir(process.env);
  const sourcePath = path.resolve(params.keystorePath);
  if (!runAsUser) {
    return sourcePath;
  }
  const targetPath = path.join(materialDir, path.basename(sourcePath));
  if (targetPath === sourcePath) {
    return targetPath;
  }
  ensureIsolatedSignerPaths(
    materialDir,
    resolveLocalSignerBackendSocketPath(process.env),
    resolveLocalSignerSocketPath(process.env),
    runAsUser,
  );
  if (fs.existsSync(targetPath) && !params.force) {
    throw new Error(`Keystore already exists: ${targetPath}`);
  }
  if (
    runSignerIsolationHelper(runAsUser, ["copy-keystore", sourcePath, targetPath]) === undefined
  ) {
    runCommand({
      command: "sudo",
      args: [
        "bash",
        "-lc",
        [
          "set -euo pipefail",
          `install -D -m 600 -o ${JSON.stringify(runAsUser)} -g ${JSON.stringify(runAsUser)} ${JSON.stringify(sourcePath)} ${JSON.stringify(targetPath)}`,
          `rm -f ${JSON.stringify(sourcePath)}`,
        ].join("; "),
      ],
    });
  }
  return targetPath;
}

const DEFAULT_WALLET_CHAINS: WalletChain[] = ["solana"];
const DEFAULT_WALLET_RUNTIME_HOST = "127.0.0.1";
const DEFAULT_WALLET_RUNTIME_PORT = 19444;
const DEFAULT_SOLANA_MAX_PER_TX = "1000000000";
const DEFAULT_SOLANA_MAX_DAILY = "5000000000";

function splitCsvList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeChains(chains: WalletChain[] | undefined): WalletChain[] {
  const out = new Set<WalletChain>();
  for (const chain of chains ?? []) {
    if (chain === "solana") {
      out.add(chain);
    }
  }
  if (out.size === 0) {
    return [...DEFAULT_WALLET_CHAINS];
  }
  return [...out];
}

function normalizeProviderId(value: string | undefined): WalletProviderId | null {
  switch ((value ?? "").trim()) {
    case "embedded-keystore":
    case "local-socket-signer":
    case "alchemy":
    case "turnkey":
    case "privy":
      return value as WalletProviderId;
    default:
      return null;
  }
}

function providerLabel(providerId: WalletProviderId): string {
  switch (providerId) {
    case "embedded-keystore":
      return "Local wallet";
    case "local-socket-signer":
      return "Local native signer";
    case "alchemy":
      return "Alchemy";
    case "turnkey":
      return "Turnkey";
    case "privy":
      return "Privy";
    default:
      return providerId;
  }
}

export function applyWalletConfig(
  base: FasedAgentConfig,
  runtimeConfig: WalletRuntimeConfig & { defaultProviderId?: WalletProviderId },
): FasedAgentConfig {
  const { defaultProviderId, ...walletRuntimeConfig } = runtimeConfig;
  const providerId = defaultProviderId ?? normalizeProviderId(base.wallet?.provider?.id);
  const provider = {
    ...base.wallet?.provider,
    ...(providerId ? { id: providerId } : {}),
  };
  if (!providerId) {
    delete provider.id;
  }
  return {
    ...base,
    wallet: {
      ...base.wallet,
      provider,
      runtime: {
        ...base.wallet?.runtime,
        ...walletRuntimeConfig,
      },
    },
  };
}

function hasConfiguredWalletMaterial(params: {
  config: FasedAgentConfig;
  registry: ReturnType<typeof readWalletProviderRegistry>;
  env: NodeJS.ProcessEnv;
}): boolean {
  if (params.registry.wallets.length > 0) {
    return true;
  }
  const mergedEnv = { ...params.env, ...params.config.env?.vars };
  if (
    String(mergedEnv.FASED_WALLET_SOLANA_KEYSTORE_PATH ?? "").trim() ||
    hasScopedWalletEnvValue(mergedEnv, "FASED_WALLET_SOLANA_KEYSTORE_PATH")
  ) {
    return true;
  }
  try {
    const walletDir = ensureWalletStateDir(mergedEnv).rootDir;
    return fs
      .readdirSync(walletDir)
      .some(
        (entry) =>
          /^keystore-solana(?:-[A-Za-z0-9_-]+)?\.v1\.enc$/.test(entry) ||
          /^keystore-evm(?:-[A-Za-z0-9_-]+)?\.v1\.enc$/.test(entry),
      );
  } catch {
    return false;
  }
}

const LOCAL_SIGNER_ENV_KEYS = [
  "FASED_WALLET_LOCAL_SIGNER_SOCKET",
  "FASED_WALLET_LOCAL_SIGNER_BACKEND_SOCKET",
  "FASED_WALLET_SIGNER_STATE_DIR",
  "FASED_WALLET_LOCAL_SIGNER_RUN_AS_USER",
  "FASED_WALLET_LOCAL_SIGNER_BIN",
  "FASED_WALLET_PASSPHRASE_FILE",
] as const;

function clearLocalSignerEnv(base: FasedAgentConfig): FasedAgentConfig {
  for (const key of LOCAL_SIGNER_ENV_KEYS) {
    delete process.env[key];
  }
  const vars = { ...base.env?.vars };
  for (const key of LOCAL_SIGNER_ENV_KEYS) {
    delete vars[key];
  }
  return {
    ...base,
    env: {
      ...base.env,
      vars,
    },
  };
}

export async function configureWalletForOnboarding(params: {
  flow: WizardFlow;
  forceEnable?: boolean;
  hostProfile?: HostSetupProfile;
  nextConfig: FasedAgentConfig;
  prepareLocalSigner?: (params: { binPath: string }) => Promise<void>;
  prompter: WizardPrompter;
}): Promise<FasedAgentConfig> {
  const { flow, prompter } = params;
  const current = params.nextConfig.wallet?.runtime;
  const registry = readWalletProviderRegistry(process.env);
  const currentEnabledProviders = WALLET_PROVIDER_IDS.filter(
    (providerId) => registry.providers[providerId]?.enabled,
  );
  // New onboarding only exposes the local socket signer. Hosted providers remain available
  // in code/CLI for advanced recovery or legacy installs, but they are not part of the
  // normal primary setup surface.
  const onboardingProviderOptions = WALLET_PROVIDER_IDS.filter((providerId) =>
    ["local-socket-signer"].includes(providerId),
  );
  const currentChains = normalizeChains(current?.chains);
  const configuredWalletMaterial = hasConfiguredWalletMaterial({
    config: params.nextConfig,
    registry,
    env: process.env,
  });
  const defaultEnabled =
    current?.enabled === false ? false : Boolean(current?.enabled && configuredWalletMaterial);

  const enabled =
    params.forceEnable === true
      ? true
      : flow === "quickstart"
        ? defaultEnabled
        : await prompter.confirm({
            message: "Enable wallet integration?",
            initialValue: defaultEnabled,
          });

  if (!enabled) {
    setWalletProvidersEnabled({ enabledProviders: [], env: process.env });
    return applyWalletConfig(clearLocalSignerEnv(params.nextConfig), { enabled: false });
  }

  const enabledProviderDefaults =
    currentEnabledProviders.length > 0
      ? currentEnabledProviders.filter((p) => p === "local-socket-signer")
      : (["local-socket-signer"] as WalletProviderId[]);
  const strictQuickstart = flow === "quickstart";
  const cloudProviderOptions = onboardingProviderOptions;
  let enabledProviders: WalletProviderId[] = [];
  if (strictQuickstart) {
    enabledProviders = ["local-socket-signer"];
  } else {
    const selectedLocalProviders = await prompter.multiselect<WalletProviderId>({
      message:
        "Enable wallet backends (normal setup uses only the local socket signer for Agent, SAT Mining, and Vault wallets)",
      options: cloudProviderOptions.map((providerId) => ({
        value: providerId,
        label: providerLabel(providerId),
      })),
      initialValues: enabledProviderDefaults,
    });
    enabledProviders = cloudProviderOptions.filter((providerId) =>
      selectedLocalProviders.includes(providerId),
    );
  }
  if (enabledProviders.length === 0) {
    enabledProviders.push("local-socket-signer");
  }
  const defaultProvider: WalletProviderId = "local-socket-signer";
  setWalletProvidersEnabled({
    enabledProviders,
    env: process.env,
  });
  const runtimeSource: WalletRuntimeKind = "external-custom";
  const mode: WalletRuntimeMode = "external";

  const chains =
    flow === "quickstart"
      ? [...DEFAULT_WALLET_CHAINS]
      : await prompter.multiselect<WalletChain>({
          message: "Wallet chains",
          options: [{ value: "solana", label: "Solana" }],
          initialValues: currentChains,
        });

  const normalizedChains = normalizeChains(chains);
  const host = current?.service?.host?.trim() || DEFAULT_WALLET_RUNTIME_HOST;
  const port = current?.service?.port ?? DEFAULT_WALLET_RUNTIME_PORT;

  if (defaultProvider === "local-socket-signer") {
    const quietSignerNotes = flow === "quickstart";
    const socketPath = resolveLocalSignerSocketPath(process.env);
    const backendSocketPath = resolveLocalSignerBackendSocketPath(process.env);
    const materialDir = resolveLocalSignerMaterialRootDir(process.env);
    const binPath = resolveSignerdBinaryPath(process.env);
    const runAsUser = resolveLocalSignerRunAsUser(process.env);
    ensureLocalSignerPassphrase();

    if (!fs.existsSync(binPath)) {
      const signerInstallProgress = quietSignerNotes
        ? prompter.progress("Installing local wallet signer…")
        : undefined;
      if (!quietSignerNotes) {
        await prompter.note(
          [
            `fased-signerd not found at: ${binPath}`,
            `Downloading the checksum-verified signer for Fased ${VERSION}. Go is not required for a normal install.`,
          ].join("\n"),
          "Local socket signer",
        );
      }
      try {
        await params.prepareLocalSigner?.({ binPath });
        if (!fs.existsSync(binPath)) {
          installSignerdBinary(binPath);
        }
        signerInstallProgress?.stop("Local wallet signer installed.");
      } catch (error) {
        signerInstallProgress?.stop("Local wallet signer installation failed.");
        throw error;
      }
      if (!quietSignerNotes) {
        await prompter.note(`fased-signerd installed at: ${binPath}`, "Local socket signer");
      }
    }

    const socketExists = isSignerdRunning(socketPath);
    const socketHealthy = socketExists ? await isSignerdHealthy(socketPath) : false;
    const desiredSignerChains = normalizeSignerChains(
      String(resolveSignerChildEnv(materialDir, process.env).FASED_WALLET_CHAINS ?? "").split(","),
    );
    const healthDetails =
      socketExists && socketHealthy
        ? await readSignerdHealth(socketPath)
        : { ok: false, chains: [] };
    const missingSignerChains = desiredSignerChains.filter(
      (chain) => !healthDetails.chains.includes(chain),
    );
    if (socketExists && socketHealthy && missingSignerChains.length === 0) {
      process.env.FASED_WALLET_LOCAL_SIGNER_SOCKET = socketPath;
      if (backendSocketPath !== socketPath) {
        process.env.FASED_WALLET_LOCAL_SIGNER_BACKEND_SOCKET = backendSocketPath;
      }
      if (!quietSignerNotes) {
        await prompter.note(
          `fased-signerd already running at: ${socketPath}`,
          "Local socket signer",
        );
      }
    } else {
      if (socketExists && (!socketHealthy || missingSignerChains.length > 0)) {
        stopProcessBySocket(socketPath, runAsUser);
      }
      if (backendSocketPath !== socketPath) {
        stopProcessBySocket(backendSocketPath, runAsUser);
      }
      startSignerdBackground(binPath, backendSocketPath, materialDir);
      if (backendSocketPath !== socketPath) {
        startSignerBrokerBackground(socketPath, backendSocketPath, materialDir);
      }
      const readyTimeoutMs = runAsUser ? 20_000 : 8_000;
      if (await waitForSignerdHealthy(socketPath, readyTimeoutMs)) {
        if (!quietSignerNotes) {
          await prompter.note(
            [
              `fased-signerd started at: ${socketPath}`,
              "Keys are isolated in the Go signer process — not accessible to Node agent.",
            ].join("\n"),
            "Local socket signer",
          );
        }
        process.env.FASED_WALLET_LOCAL_SIGNER_SOCKET = socketPath;
        if (backendSocketPath !== socketPath) {
          process.env.FASED_WALLET_LOCAL_SIGNER_BACKEND_SOCKET = backendSocketPath;
        }
      } else {
        throw buildSignerdReadinessError({
          appSocketPath: socketPath,
          backendSocketPath,
          binPath,
          materialDir,
          readyTimeoutMs,
          runAsUser,
        });
      }
    }
  }

  const automationSigning =
    flow === "quickstart"
      ? (current?.policy?.directSigning ?? true)
      : await prompter.confirm({
          message: "Allow automated wallet execution from approved Agent tools?",
          initialValue: current?.policy?.directSigning ?? true,
        });
  const toolAccessMode =
    flow === "quickstart"
      ? (current?.toolAccess?.mode ?? "owner-only")
      : await prompter.select<"owner-only" | "allowlist" | "all">({
          message: "Wallet tool access scope",
          options: [
            { value: "owner-only", label: "Owner agent only (recommended)" },
            { value: "allowlist", label: "Allowlisted agents only" },
            { value: "all", label: "All agents" },
          ],
          initialValue: current?.toolAccess?.mode ?? "owner-only",
        });
  const allowAgents =
    toolAccessMode === "allowlist"
      ? splitCsvList(
          flow === "quickstart"
            ? (current?.toolAccess?.allowAgents ?? []).join(",")
            : await prompter.text({
                message: "Allowlisted agent IDs (comma separated)",
                placeholder: "agent-owner,agent-ops",
                initialValue: (current?.toolAccess?.allowAgents ?? []).join(","),
              }),
        )
      : [];

  const solanaAllowPrograms =
    flow === "quickstart"
      ? (current?.policy?.solana?.allowPrograms ?? []).map((item) => item.trim()).filter(Boolean)
      : splitCsvList(
          await prompter.text({
            message: "Solana program allowlist (comma separated, blank=any)",
            initialValue: (current?.policy?.solana?.allowPrograms ?? []).join(","),
          }),
        );
  const solanaMaxPerTx =
    flow === "quickstart"
      ? current?.policy?.solana?.maxPerTx?.trim() || DEFAULT_SOLANA_MAX_PER_TX
      : (
          await prompter.text({
            message: "Solana max per transaction (lamports)",
            initialValue: current?.policy?.solana?.maxPerTx?.trim() || DEFAULT_SOLANA_MAX_PER_TX,
          })
        ).trim() || DEFAULT_SOLANA_MAX_PER_TX;
  const solanaMaxDaily =
    flow === "quickstart"
      ? current?.policy?.solana?.maxDaily?.trim() || DEFAULT_SOLANA_MAX_DAILY
      : (
          await prompter.text({
            message: "Solana max daily spend (lamports)",
            initialValue: current?.policy?.solana?.maxDaily?.trim() || DEFAULT_SOLANA_MAX_DAILY,
          })
        ).trim() || DEFAULT_SOLANA_MAX_DAILY;

  const nextConfig = applyWalletConfig(params.nextConfig, {
    enabled: true,
    defaultProviderId: defaultProvider,
    mode,
    runtime: runtimeSource,
    external: {
      kind: (runtimeSource as string) === "external-docker" ? "docker" : "custom",
    },
    chains: normalizedChains,
    service: { host, port },
    policy: {
      directSigning: automationSigning,
      solana: {
        allowPrograms: solanaAllowPrograms,
        maxPerTx: solanaMaxPerTx,
        maxDaily: solanaMaxDaily,
      },
    },
    toolAccess: {
      mode: toolAccessMode,
      allowAgents,
    },
  });
  return {
    ...nextConfig,
    wallet: {
      ...nextConfig.wallet,
      execution: {
        ...nextConfig.wallet?.execution,
        mode: automationSigning ? "autonomous" : "manual",
      },
      approvalAuth: {
        ...nextConfig.wallet?.approvalAuth,
        mode: nextConfig.wallet?.approvalAuth?.mode ?? "none",
      },
    },
  };
}
