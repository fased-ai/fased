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
import { callLocalSocketSigner } from "../wallet/providers/local-socket-signer-adapter.js";
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
} from "../wallet/wallet-runtime-config.js";
import type { HostSetupProfile, WizardFlow } from "./onboarding.types.js";
import type { WizardPrompter } from "./prompts.js";

function resolveSignerdBinaryPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = String(env.FASED_WALLET_LOCAL_SIGNER_BIN ?? "").trim();
  if (explicit) {
    return path.resolve(explicit);
  }
  return path.join(env.HOME ?? "/root", ".fased/bin/fased-signerd");
}

function resolveAppOwnedSignerdStagingPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.HOME ?? "/root", ".fased/bin/fased-signerd");
}
const INSTALL_SCRIPT_RELPATHS = [
  "scripts/install-fased-signerd.sh",
  "../scripts/install-fased-signerd.sh",
];
const BROKER_CLI_RELPATHS = ["./index.js", "../../dist/index.js"];

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
  for (const rel of INSTALL_SCRIPT_RELPATHS) {
    const abs = path.resolve(rel);
    if (fs.existsSync(abs)) {
      return abs;
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

function installSignerdBinary(binPath: string): void {
  const script = resolveInstallScript();
  if (!script) {
    throw new Error(
      `install-fased-signerd.sh not found. Cannot install fased-signerd.\n` +
        `Expected at one of: ${INSTALL_SCRIPT_RELPATHS.join(", ")}\n` +
        `Download manually from https://github.com/fased-ai/agent/releases`,
    );
  }
  const runAsUser = resolveLocalSignerRunAsUser(process.env);
  const stagingPath = resolveAppOwnedSignerdStagingPath(process.env);
  const installDir = path.dirname(runAsUser ? stagingPath : binPath);
  const localReleaseBaseUrl = resolveLocalSignerdReleaseBaseUrl(script);
  const installCmd = [
    `FASED_LOCAL_SIGNER_BIN_DIR="${installDir}"`,
    ...(localReleaseBaseUrl
      ? [`FASED_LOCAL_SIGNER_BASE_URL="${localReleaseBaseUrl}"`, 'FASED_LOCAL_SIGNER_LATEST_TAG=""']
      : []),
    `bash "${script}"`,
  ].join(" ");
  const verboseInstall =
    String(process.env.FASED_INSTALL_VERBOSE ?? "").trim() === "1" ||
    String(process.env.FASED_ONBOARD_VERBOSE ?? "").trim() === "1";
  try {
    execSync(installCmd, { stdio: verboseInstall ? "inherit" : "pipe" });
  } catch (err) {
    const stderr =
      err && typeof err === "object" && "stderr" in err
        ? String((err as { stderr?: Buffer | string }).stderr ?? "").trim()
        : "";
    const stdout =
      err && typeof err === "object" && "stdout" in err
        ? String((err as { stdout?: Buffer | string }).stdout ?? "").trim()
        : "";
    const detail = (stderr || stdout).split("\n").slice(-12).join("\n");
    throw new Error(detail || "fased-signerd install failed", { cause: err });
  }
  const installedPath = runAsUser ? stagingPath : binPath;
  if (!fs.existsSync(installedPath)) {
    throw new Error(
      `fased-signerd install script ran but binary not found at ${binPath}.\n` +
        `Check install script output above for errors.`,
    );
  }
  if (runAsUser && installedPath !== binPath) {
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
  if (!fs.existsSync(binPath)) {
    throw new Error(
      `fased-signerd install script completed but target binary not found at ${binPath}.\n` +
        `Check install script output above for errors.`,
    );
  }
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
      : passphraseSource.kind === "value"
        ? { FASED_WALLET_PASSPHRASE: passphraseSource.value }
        : {}),
  };
}

const LOCAL_SIGNER_EXPORTABLE_PREFIXES = [
  "FASED_WALLET_SOLANA_KEYSTORE_PATH",
  "FASED_WALLET_SOLANA_RPC_URL",
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
  const childEnv = resolveSignerChildEnv(materialDir, mergedEnv, cfg);
  const exportLines = Object.entries(collectLocalSignerExportEnv(childEnv))
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
    '"$HOME/.fased/bin/fased-signerd" --socket "${FASED_WALLET_LOCAL_SIGNER_BACKEND_SOCKET:-$FASED_WALLET_LOCAL_SIGNER_SOCKET}"',
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

function ensureIsolatedSignerPaths(
  materialDir: string,
  backendSocketPath: string,
  appSocketPath: string,
  runAsUser: string,
) {
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
  const logPath = path.join(materialDir, "local-signer.log");
  if (runAsUser && process.getuid?.() === 0) {
    throw new Error("signer isolation should not be started directly as root");
  }
  if (runAsUser) {
    ensureIsolatedSignerPaths(materialDir, backendSocketPath, appSocketPath, runAsUser);
    const envArgs = Object.entries(childEnv)
      .filter(([, value]) => typeof value === "string" && value.trim())
      .map(([key, value]) => `${key}=${value}`);
    try {
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
  if (runAsUser) {
    try {
      const rawPid = runCommand({
        command: "sudo",
        args: [
          "bash",
          "-lc",
          `if [ -f ${JSON.stringify(pidPath)} ]; then cat ${JSON.stringify(pidPath)}; fi`,
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
        args: ["bash", "-lc", `rm -f ${JSON.stringify(socketPath)} ${JSON.stringify(pidPath)}`],
      });
    } catch {}
    return;
  }
  try {
    const pid = Number.parseInt(fs.readFileSync(pidPath, "utf8").trim(), 10);
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
    fs.unlinkSync(socketPath);
  } catch {}
  try {
    fs.unlinkSync(pidPath);
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
              `${JSON.stringify(process.execPath)} ${JSON.stringify(brokerCli)} wallet signer broker --socket ${JSON.stringify(appSocketPath)} --backend-socket ${JSON.stringify(backendSocketPath)} --pid-file ${JSON.stringify(`${appSocketPath}.pid`)} --audit-log ${JSON.stringify(`${appSocketPath}.audit.jsonl`)} >> ${JSON.stringify(logPath)} 2>&1 &`,
            ].join("; "),
          ),
        ].join(" "),
        { stdio: "ignore" },
      );
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
      `${appSocketPath}.pid`,
      "--audit-log",
      `${appSocketPath}.audit.jsonl`,
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
  await new Promise<void>((resolve) => setTimeout(resolve, 1200));
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
  return targetPath;
}

const DEFAULT_WALLET_CHAINS: WalletChain[] = ["solana"];
const DEFAULT_WALLET_RUNTIME_HOST = "127.0.0.1";
const DEFAULT_WALLET_RUNTIME_PORT = 19444;
const DEFAULT_SOLANA_MAX_PER_TX = "1000000000";
const DEFAULT_SOLANA_MAX_DAILY = "5000000000";

function isManagedGatewayMode(flow: WizardFlow, env: NodeJS.ProcessEnv = process.env): boolean {
  const mode = (env.FASED_GATEWAY_MODE ?? "").trim().toLowerCase();
  if (mode === "managed") {
    return true;
  }
  if (mode === "local" || mode === "gateway") {
    return false;
  }
  return flow === "quickstart";
}

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
  return {
    ...base,
    wallet: {
      ...base.wallet,
      provider: {
        ...base.wallet?.provider,
        id:
          defaultProviderId ??
          normalizeProviderId(base.wallet?.provider?.id) ??
          "local-socket-signer",
      },
      runtime: {
        ...base.wallet?.runtime,
        ...walletRuntimeConfig,
      },
    },
  };
}

export async function configureWalletForOnboarding(params: {
  flow: WizardFlow;
  hostProfile?: HostSetupProfile;
  nextConfig: FasedAgentConfig;
  prompter: WizardPrompter;
}): Promise<FasedAgentConfig> {
  const { flow, prompter } = params;
  const managedMode = isManagedGatewayMode(flow);
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
  const defaultEnabled = current?.enabled ?? (flow === "quickstart" ? true : managedMode);

  const enabled =
    flow === "quickstart"
      ? true
      : await prompter.confirm({
          message: "Enable wallet integration?",
          initialValue: defaultEnabled,
        });

  if (!enabled) {
    setWalletProvidersEnabled({ enabledProviders: [], env: process.env });
    return applyWalletConfig(params.nextConfig, { enabled: false });
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

    // Install binary if not present — MANDATORY, not optional
    if (!fs.existsSync(binPath)) {
      if (!quietSignerNotes) {
        await prompter.note(
          [
            `fased-signerd not found at: ${binPath}`,
            "Downloading fased-signerd binary from GitHub releases...",
          ].join("\n"),
          "Local socket signer",
        );
      }
      installSignerdBinary(binPath);
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
      // Brief wait for socket to appear
      await new Promise<void>((resolve) => setTimeout(resolve, 1000));
      if (isSignerdRunning(socketPath) && (await isSignerdHealthy(socketPath))) {
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
        const signerLogPath = path.join(materialDir, "local-signer.log");
        const brokerLogPath = path.join(path.dirname(socketPath), "local-signer-broker.log");
        throw new Error(
          `fased-signerd did not start. Check logs: ${signerLogPath}${backendSocketPath !== socketPath ? `, ${brokerLogPath}` : ""}\n` +
            `Run manually: ${binPath} -socket ${backendSocketPath}`,
        );
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
        mode: nextConfig.wallet?.approvalAuth?.mode ?? "webauthn",
      },
    },
  };
}
