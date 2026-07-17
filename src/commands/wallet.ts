import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { loadConfig, type FasedAgentConfig, writeConfigFile } from "../config/config.js";
import type { WalletChain, WalletRuntimeKind } from "../config/types.wallet.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import {
  hasLegacyEmbeddedKeystoreConfig,
  hasLegacyEmbeddedKeystoreMaterialHint,
  throwLegacyEmbeddedKeystoreMigrationRequired,
} from "../wallet/legacy-embedded-keystore.js";
import { createLockedSignerOwnedWallet } from "../wallet/local-socket-signer-lifecycle.js";
import { normalizeNativeSignerWalletId } from "../wallet/native-signer-wallet-id.js";
import {
  callLocalSocketSigner,
  probeLocalSocketSignerHealth,
  requireLocalSocketSignerPath,
  type LocalSocketSignerHealthProbe,
} from "../wallet/providers/local-socket-signer-adapter.js";
import { configureSignerOwnedWalletNetwork } from "../wallet/signer-network-admin.js";
import { buildWalletCanaryReport, runWalletProviderCanaryReport } from "../wallet/wallet-canary.js";
import {
  listWalletInboundEvents,
  pollWalletInboundEvents,
  reconcileWalletInboundEvents,
  type WalletInboundStatus,
} from "../wallet/wallet-inbound-events.js";
import { buildWalletProviderCapabilityMatrix } from "../wallet/wallet-provider-capabilities.js";
import {
  normalizeWalletUserRole,
  readWalletProviderRegistry,
  resolveWalletUserRole,
  setDefaultWallet,
  setNamedWalletRole,
  setWalletProviderEnabled,
  upsertNamedWallet,
} from "../wallet/wallet-provider-registry.js";
import {
  createWalletProviderAdapter,
  resolveWalletProviderId,
} from "../wallet/wallet-provider-resolver.js";
import { redactWalletDiagnosticText } from "../wallet/wallet-redaction.js";
import {
  ensureWalletStateDir,
  isLocalSignerExternallyManaged,
  resolveLocalSignerControlSocketPath,
  resolveLocalSignerMasterKeyPath,
  resolveLocalSignerSidecarPaths,
  resolveLocalSignerSocketPath,
  resolveLocalSignerStateDbPath,
} from "../wallet/wallet-runtime-config.js";
import {
  readWalletProviderSecretStatus,
  saveWalletProviderSecret,
} from "../wallet/wallet-secrets-store.js";
import {
  readWalletStatusSnapshot,
  resolveWalletConfigForRuntime,
} from "../wallet/wallet-status.js";
import {
  installSignerdBinary,
  restartLocalSocketSigner,
  resolveSignerdBinaryPath,
  writeLocalSignerEnvFile as writeManagedLocalSignerEnvFile,
} from "../wizard/onboarding.wallet.js";

export type WalletSetupOptions = {
  managed?: boolean;
  json?: boolean;
  mode?:
    | "embedded"
    | "embedded-create"
    | "embedded-import"
    | "local-signer-create"
    | "local-signer-import"
    | "local-signer"
    | "turnkey"
    | "alchemy"
    | "privy";
  chain?: WalletChain;
  walletId?: string;
  walletName?: string;
  apiKey?: string;
  rpcUrl?: string;
  noDoctor?: boolean;
  noSignerHints?: boolean;
  nonInteractive?: boolean;
  turnkeyApiPublicKey?: string;
  turnkeyApiPrivateKey?: string;
  turnkeyOrganizationId?: string;
  turnkeyPolicyId?: string;
  turnkeyBaseUrl?: string;
  role?: string;
  noProviderIdUpdate?: boolean;
  force?: boolean;
  enableLimitOrders?: boolean;
  disableLimitOrders?: boolean;
  jupiterApiKey?: string;
};

export type WalletLimitOrdersOptions = {
  enable?: boolean;
  disable?: boolean;
  jupiterApiKey?: string;
  nonInteractive?: boolean;
  json?: boolean;
};

export type WalletStatusOptions = {
  json?: boolean;
};

export type WalletRotateKeysOptions = {
  json?: boolean;
};

export type WalletLegacyMigrationFinalizeOptions = {
  walletId: string;
  walletName?: string;
  json?: boolean;
};

export type WalletStackOptions = {
  json?: boolean;
  tail?: number;
};

export type WalletMigrateOptions = {
  from: string;
  to: string;
  json?: boolean;
};

export type WalletCanaryOptions = {
  json?: boolean;
  requireRealChain?: boolean;
  executeRecoveryDrill?: boolean;
  executeProviderE2E?: boolean;
  executeLiveSend?: boolean;
  providers?: string[];
};

export type WalletInboundPollOptions = {
  json?: boolean;
  providerId?: string;
  walletId?: string;
  walletName?: string;
  chain?: "solana" | "all";
};

export type WalletInboundListOptions = {
  json?: boolean;
  providerId?: string;
  walletId?: string;
  chain?: "solana";
  status?: WalletInboundStatus | "all";
  limit?: number;
};

export type WalletInboundReconcileOptions = {
  json?: boolean;
};

export type WalletKeystoreInitOptions = {
  json?: boolean;
  chain?: WalletChain;
  walletId?: string;
};

export type WalletKeystoreImportOptions = {
  json?: boolean;
  chain?: WalletChain;
  walletId?: string;
};

export type WalletKeystoreStatusOptions = {
  json?: boolean;
  walletId?: string;
  chain?: WalletChain;
};

export type WalletKeystoreValidateOptions = {
  json?: boolean;
  expectChainId?: number;
  chain?: WalletChain;
  walletId?: string;
};

export type WalletKeystorePassphraseInitOptions = {
  json?: boolean;
};

export type WalletKeystorePassphraseRotateOptions = {
  json?: boolean;
};

export type WalletKeystoreExportOptions = {
  json?: boolean;
};

export type WalletProviderConfigureOptions = {
  providerId: "turnkey" | "privy" | "alchemy";
  json?: boolean;
  rpcUrl?: string;
  values?: string[];
};

export type WalletRoleSetOptions = {
  walletId: string;
  role: string;
  primary?: boolean;
  json?: boolean;
};

export type WalletPolicyProfileApplyOptions = {
  json?: boolean;
  profile: "autonomous-strict" | "autonomous-moderate" | "manual-owner";
  allowSkills?: string[];
  allowSources?: string[];
};

export type WalletSignerServeOptions = {
  socketPath?: string;
  readOnly?: boolean;
  pidFile?: string;
  auditLog?: string;
};

function resolveConfiguredMiningWalletId(cfg: FasedAgentConfig): string | undefined {
  const config = cfg.plugins?.entries?.["sat-mining"]?.config;
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return undefined;
  }
  const walletId = (config as { walletId?: unknown }).walletId;
  return typeof walletId === "string" ? walletId.trim() || undefined : undefined;
}

function normalizeWalletRoleForCli(value: string | undefined): "agent" | "vault" | undefined {
  const role = normalizeWalletUserRole(value);
  return role === "agent" || role === "vault" ? role : undefined;
}

export function createLegacyLocalSignerEmbeddedAdapter(): never {
  throwLegacyEmbeddedKeystoreMigrationRequired("legacy embedded adapter construction requested");
}

export type WalletSignerDoctorOptions = {
  json?: boolean;
  socketPath?: string;
  config?: FasedAgentConfig;
  checkRpc?: boolean;
};

export type WalletSignerDoctorReport = {
  ok: boolean;
  socketPath: string;
  pidPath: string;
  auditPath: string;
  checks: Array<{ check: string; ok: boolean; detail?: string }>;
  signer?: {
    jupiter?: { triggerConfigured: boolean };
    webAuthn?: {
      configured: boolean;
      credentialCount: number;
      credentialVersion: number;
      ready: boolean;
    };
  };
};

function parseWalletProviderId(input: string | undefined) {
  switch ((input ?? "").trim()) {
    case "embedded-keystore":
      throwLegacyEmbeddedKeystoreMigrationRequired("legacy wallet provider requested");
    case "local-socket-signer":
    case "alchemy":
    case "turnkey":
      return input as "local-socket-signer" | "alchemy" | "turnkey";
    case "privy":
      throw new Error("Privy wallet creation and signing are unavailable.");
    default:
      return undefined;
  }
}

function parseCredentialPairs(values: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of values ?? []) {
    const text = String(raw ?? "").trim();
    if (!text) {
      continue;
    }
    const idx = text.indexOf("=");
    if (idx <= 0 || idx === text.length - 1) {
      throw new Error(`invalid credential pair (expected key=value): ${text}`);
    }
    const key = text.slice(0, idx).trim();
    const value = text.slice(idx + 1).trim();
    if (!key || !value) {
      throw new Error(`invalid credential pair (expected key=value): ${text}`);
    }
    out[key] = value;
  }
  return out;
}

function normalizeStringList(values: string[] | undefined): string[] {
  return (values ?? []).map((v) => String(v).trim()).filter(Boolean);
}

function isWalletRuntime(value: string): value is WalletRuntimeKind {
  return value === "external-docker" || value === "external-custom";
}

function throwLegacyDockerSignerRemoved(command: string): never {
  throw new Error(
    `${command} is no longer supported. Use the native fased-signerd, Wallet Standard hardware custody, or Turnkey.`,
  );
}

function normalizeWalletIdForEnvSuffix(walletId?: string): string | undefined {
  const raw = String(walletId ?? "")
    .trim()
    .toLowerCase();
  if (!raw) {
    return undefined;
  }
  // Keep shell-safe env var identifiers for per-wallet suffixes.
  return raw.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function walletIdEnvSuffix(walletId?: string): string | undefined {
  const normalized = normalizeWalletIdForEnvSuffix(walletId);
  return normalized ? normalized.toUpperCase() : undefined;
}

function setConfigEnvVar(
  cfg: FasedAgentConfig,
  key: string,
  value: string | undefined,
): FasedAgentConfig {
  const nextVars = { ...cfg.env?.vars } as Record<string, string>;
  const trimmed = value?.trim();
  if (!trimmed) {
    delete nextVars[key];
  } else {
    nextVars[key] = trimmed;
  }
  return {
    ...cfg,
    env: {
      ...cfg.env,
      vars: nextVars,
    },
  };
}

const JUPITER_API_KEY_ENV = "FASED_JUPITER_API_KEY";
const LEGACY_JUPITER_TRIGGER_API_BASE_URL_ENV = "FASED_JUPITER_TRIGGER_API_BASE_URL";

function resolveConfiguredJupiterApiKey(cfg: FasedAgentConfig, env: NodeJS.ProcessEnv): string {
  return String(
    env[JUPITER_API_KEY_ENV] ??
      cfg.env?.vars?.[JUPITER_API_KEY_ENV] ??
      env.JUPITER_API_KEY ??
      cfg.env?.vars?.JUPITER_API_KEY ??
      "",
  ).trim();
}

async function promptCliText(question: string, fallback = ""): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question}${fallback ? ` [${fallback}]` : ""}: `);
    return answer.trim() || fallback;
  } finally {
    rl.close();
  }
}

async function promptCliSecret(question: string, fallback = ""): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return await promptCliText(question, fallback);
  }
  const stdin = process.stdin;
  const stdout = process.stdout;
  stdout.write(`${question}${fallback ? " [hidden default]" : ""}: `);
  stdin.setRawMode?.(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  let value = "";
  try {
    await new Promise<void>((resolve, reject) => {
      const onData = (chunk: string) => {
        for (const ch of chunk) {
          if (ch === "\r" || ch === "\n") {
            stdout.write("\n");
            stdin.off("data", onData);
            resolve();
            return;
          }
          if (ch === "\u0003") {
            stdout.write("\n");
            stdin.off("data", onData);
            reject(new Error("Interrupted"));
            return;
          }
          if (ch === "\u007f" || ch === "\b") {
            if (value.length > 0) {
              value = value.slice(0, -1);
              stdout.write("\b \b");
            }
            continue;
          }
          value += ch;
          stdout.write("*");
        }
      };
      stdin.on("data", onData);
    });
  } finally {
    stdin.setRawMode?.(false);
    stdin.pause();
  }
  return value.trim() || fallback;
}

export async function walletLimitOrdersConfigureCommand(
  runtime: RuntimeEnv = defaultRuntime,
  options: WalletLimitOrdersOptions = {},
) {
  if (options.enable && options.disable) {
    throw new Error("Use either --enable or --disable for Jupiter Swap API access, not both.");
  }
  const env = process.env;
  let cfg = loadConfig();
  if (options.disable) {
    cfg = setConfigEnvVar(cfg, JUPITER_API_KEY_ENV, undefined);
    cfg = setConfigEnvVar(cfg, LEGACY_JUPITER_TRIGGER_API_BASE_URL_ENV, undefined);
    await writeConfigFile(cfg, { envSnapshotForRestore: process.env });
    delete env[JUPITER_API_KEY_ENV];
    delete env[LEGACY_JUPITER_TRIGGER_API_BASE_URL_ENV];
    if (options.json) {
      runtime.log(JSON.stringify({ ok: true, enabled: false }, null, 2));
    } else {
      runtime.log(
        "Gateway Jupiter Swap API access disabled. Signer-owned Trigger configuration is unchanged.",
      );
    }
    return;
  }

  const existingKey = resolveConfiguredJupiterApiKey(cfg, env);
  let shouldEnable = options.enable === true || Boolean(options.jupiterApiKey?.trim());
  if (!shouldEnable && !options.nonInteractive) {
    const answer = await promptCliText(
      "Enable Gateway Jupiter Swap API access? Trigger credentials remain signer-owned. [y/N]",
      existingKey ? "y" : "n",
    );
    shouldEnable = answer.trim().toLowerCase().startsWith("y");
  }
  if (!shouldEnable) {
    if (options.json) {
      runtime.log(
        JSON.stringify(
          { ok: true, enabled: Boolean(existingKey), configured: Boolean(existingKey) },
          null,
          2,
        ),
      );
    } else {
      runtime.log(
        existingKey
          ? "Gateway Jupiter Swap API access already configured."
          : "Gateway Jupiter Swap API access not configured.",
      );
    }
    return;
  }

  let apiKey = String(options.jupiterApiKey ?? "").trim() || existingKey;
  if (!apiKey && !options.nonInteractive) {
    apiKey = await promptCliSecret("Jupiter Swap API key");
  }
  if (!apiKey) {
    throw new Error(
      "Jupiter swap crafting requires an API key. Pass --jupiter-api-key or set FASED_JUPITER_API_KEY.",
    );
  }

  cfg = setConfigEnvVar(cfg, JUPITER_API_KEY_ENV, apiKey);
  cfg = setConfigEnvVar(cfg, LEGACY_JUPITER_TRIGGER_API_BASE_URL_ENV, undefined);
  await writeConfigFile(cfg, { envSnapshotForRestore: process.env });
  env[JUPITER_API_KEY_ENV] = apiKey;
  delete env[LEGACY_JUPITER_TRIGGER_API_BASE_URL_ENV];

  if (options.json) {
    runtime.log(
      JSON.stringify(
        {
          ok: true,
          enabled: true,
          jupiterApiKeyConfigured: true,
          scope: "gateway-jupiter-swap-only",
          triggerCredentials: "signer-owned",
        },
        null,
        2,
      ),
    );
    return;
  }
  runtime.log("Gateway Jupiter Swap API access enabled for Agent wallet swap crafting.");
  runtime.log(`Stored ${JUPITER_API_KEY_ENV} in local config env vars for swaps only.`);
  runtime.log(
    "Jupiter Trigger credentials and production API routing are owned by fased-signerd and are not configured in Gateway.",
  );
}

function normalizeWalletChainsForSigner(chains: WalletChain[] | undefined): WalletChain[] {
  const out = new Set<WalletChain>();
  for (const chain of chains ?? []) {
    if (chain === "solana") {
      out.add(chain);
    }
  }
  if (out.size === 0) {
    out.add("solana");
  }
  return [...out];
}

function resolveLocalSignerChainsEnvValue(cfg: FasedAgentConfig, env: NodeJS.ProcessEnv): string {
  const explicit = String(
    env.FASED_WALLET_CHAINS ?? cfg.env?.vars?.FASED_WALLET_CHAINS ?? "",
  ).trim();
  if (explicit) {
    const normalized = explicit
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter((value): value is WalletChain => value === "solana");
    if (normalized.length > 0) {
      return [...new Set(normalized)].join(",");
    }
  }
  return normalizeWalletChainsForSigner(cfg.wallet?.runtime?.chains).join(",");
}

function rpcEnvKeyFor(chain: WalletChain, walletId?: string): string {
  void chain;
  const suffix = walletIdEnvSuffix(walletId);
  if (suffix) {
    return `FASED_WALLET_SOLANA_RPC_URL__${suffix}`;
  }
  return "FASED_WALLET_SOLANA_RPC_URL";
}

function fallbackRpcEnvKeyFor(walletId?: string): string {
  const suffix = walletIdEnvSuffix(walletId);
  return suffix
    ? `FASED_WALLET_SOLANA_WRITE_RPC_FALLBACK_URL__${suffix}`
    : "FASED_WALLET_SOLANA_WRITE_RPC_FALLBACK_URL";
}

function resolveRpcUrlForChain(
  env: NodeJS.ProcessEnv,
  chain: WalletChain,
  walletId?: string,
  explicit?: string,
): string {
  const explicitValue = explicit?.trim();
  if (explicitValue) {
    return explicitValue;
  }
  const suffix = walletIdEnvSuffix(walletId);
  const perWalletKey = suffix ? `FASED_WALLET_SOLANA_RPC_URL__${suffix}` : undefined;
  const perChainKey = "FASED_WALLET_SOLANA_RPC_URL";
  const scopedOrChain =
    (perWalletKey ? String(env[perWalletKey] ?? "").trim() : "") ||
    String(env[perChainKey] ?? "").trim();
  void chain;
  return scopedOrChain || String(env.FASED_WALLET_RPC_URL ?? "").trim();
}

function ensureLocalSignerProviderConfig(
  cfg: FasedAgentConfig,
  env: NodeJS.ProcessEnv,
  socketPath?: string,
): FasedAgentConfig {
  const effectiveSocketPath = socketPath?.trim() || resolveLocalSignerSocketPath(env);
  let nextCfg = setConfigEnvVar(cfg, "FASED_WALLET_LOCAL_SIGNER_SOCKET", effectiveSocketPath);
  const hosted =
    String(env.FASED_HOST_PROFILE ?? "")
      .trim()
      .toLowerCase() === "hosting";
  if (hosted) {
    for (const key of [
      "FASED_WALLET_LOCAL_SIGNER_BACKEND_SOCKET",
      "FASED_WALLET_LOCAL_SIGNER_CONTROL_SOCKET",
      "FASED_WALLET_LOCAL_SIGNER_STATE_DB",
      "FASED_WALLET_LOCAL_SIGNER_MASTER_KEY",
      "FASED_WALLET_LOCAL_SIGNER_RUN_AS_USER",
      "FASED_WALLET_LOCAL_SIGNER_BIN",
      "FASED_WALLET_SIGNER_STATE_DIR",
      "FASED_WALLET_PASSPHRASE_FILE",
    ]) {
      nextCfg = setConfigEnvVar(nextCfg, key, undefined);
    }
  }
  const controlSocketPath = resolveLocalSignerControlSocketPath(env);
  const stateDbPath = resolveLocalSignerStateDbPath(env);
  const masterKeyPath = resolveLocalSignerMasterKeyPath(env);
  nextCfg = setConfigEnvVar(nextCfg, "FASED_WALLET_LOCAL_SIGNER_BACKEND_SOCKET", undefined);
  if (!hosted) {
    nextCfg = setConfigEnvVar(
      nextCfg,
      "FASED_WALLET_LOCAL_SIGNER_CONTROL_SOCKET",
      controlSocketPath,
    );
    nextCfg = setConfigEnvVar(nextCfg, "FASED_WALLET_LOCAL_SIGNER_STATE_DB", stateDbPath);
    nextCfg = setConfigEnvVar(nextCfg, "FASED_WALLET_LOCAL_SIGNER_MASTER_KEY", masterKeyPath);
  }
  nextCfg = setConfigEnvVar(
    nextCfg,
    "FASED_WALLET_CHAINS",
    resolveLocalSignerChainsEnvValue(nextCfg, env),
  );
  return {
    ...nextCfg,
    wallet: {
      ...cfg.wallet,
      provider: {
        ...cfg.wallet?.provider,
        id: "local-socket-signer",
      },
      runtime: {
        ...cfg.wallet?.runtime,
        enabled: true,
        mode: "external",
        runtime: "external-custom",
      },
    },
  };
}

async function configureLocalSignerMode(
  runtime: RuntimeEnv,
  options: WalletSetupOptions,
  env: NodeJS.ProcessEnv,
) {
  const cfg = loadConfig();
  const socketPath = resolveLocalSignerSocketPath(env);
  const nextCfg = ensureLocalSignerProviderConfig(cfg, env, socketPath);
  if (!options.noProviderIdUpdate) {
    await writeConfigFile(nextCfg);
  }
  if (options.noSignerHints) {
    return;
  }
  runtime.log("Signer mode: local native signer");
  runtime.log(`Signer socket: ${socketPath}`);
  const effectiveEnv = { ...env, ...nextCfg.env?.vars };
  const hosted =
    String(env.FASED_HOST_PROFILE ?? "")
      .trim()
      .toLowerCase() === "hosting";
  if (!hosted) {
    const signerEnvPath = writeManagedLocalSignerEnvFile({ config: nextCfg, env: effectiveEnv });
    runtime.log(`Signer environment written: ${signerEnvPath} (mode 600)`);
    runtime.log(`Start signer with the generated same-user signer environment.`);
  } else {
    runtime.log("Signer lifecycle is owned by the root-managed fased-signerd service.");
  }
  runtime.log("");
  runtime.log("Then verify:");
  runtime.log("  fased wallet signer doctor --json");
  if (!options.noDoctor) {
    try {
      await walletSignerDoctorCommand(runtime, { json: Boolean(options.json) });
    } catch (err) {
      const message =
        `Signer doctor not ready yet (${err instanceof Error ? err.message : String(err)}). ` +
        "Start fased-signerd, then rerun `fased wallet signer doctor --json`.";
      if (options.nonInteractive) {
        throw new Error(message, { cause: err });
      }
      runtime.log(message);
    }
  }
}

function findNativeSignerWalletIdCollision(
  wallets: ReturnType<typeof readWalletProviderRegistry>["wallets"],
  friendlyWalletId: string,
  signerWalletId: string,
) {
  return wallets.find((entry) => {
    if (entry.id === friendlyWalletId || entry.providerId !== "local-socket-signer") {
      return false;
    }
    const signerWalletIdMetadata = entry.metadata?.signerWalletId;
    const registeredSignerWalletId =
      typeof signerWalletIdMetadata === "string" ? signerWalletIdMetadata.trim() : "";
    return (registeredSignerWalletId || normalizeNativeSignerWalletId(entry.id)) === signerWalletId;
  });
}

async function createSignerOwnedWalletForSetup(params: {
  runtime: RuntimeEnv;
  options: WalletSetupOptions;
  env: NodeJS.ProcessEnv;
  chain: WalletChain;
  walletId?: string;
  rpcUrl: string;
  role: "agent" | "mining" | "vault";
}) {
  if (params.chain !== "solana") {
    throw new Error("fased-signerd protocol v2 currently supports Solana wallet creation only");
  }
  const walletId = params.walletId?.trim() || params.role;
  let cfg = ensureLocalSignerProviderConfig(loadConfig(), params.env);
  cfg = setConfigEnvVar(cfg, rpcEnvKeyFor(params.chain, walletId), params.rpcUrl);
  await writeConfigFile(cfg);

  const mergedEnv = { ...params.env, ...cfg.env?.vars } as NodeJS.ProcessEnv;
  const socketPath = resolveLocalSignerSocketPath(mergedEnv);
  const hosted =
    String(mergedEnv.FASED_HOST_PROFILE ?? "")
      .trim()
      .toLowerCase() === "hosting";
  const expectedSignerWalletId = normalizeNativeSignerWalletId(walletId);
  const existingSignerIdCollision = findNativeSignerWalletIdCollision(
    readWalletProviderRegistry(params.env).wallets,
    walletId,
    expectedSignerWalletId,
  );
  if (existingSignerIdCollision) {
    throw new Error(
      `native signer wallet ID ${expectedSignerWalletId} is already registered as ${existingSignerIdCollision.id}; choose a distinct wallet ID`,
    );
  }
  if (!hosted) {
    writeManagedLocalSignerEnvFile({ config: cfg, env: mergedEnv });
    const signerBinPath = resolveSignerdBinaryPath(mergedEnv);
    if (!fs.existsSync(signerBinPath)) {
      installSignerdBinary(signerBinPath);
    }
    await restartLocalSocketSigner(undefined, mergedEnv);
  }

  let result;
  try {
    result = await createLockedSignerOwnedWallet({
      socketPath,
      walletId,
      role: params.role,
      allowExisting: Boolean(params.options.force),
    });
  } catch (error) {
    if (hosted) {
      throw new Error(
        `root-managed hosted signer wallet creation failed: ${error instanceof Error ? error.message : String(error)}. Repair only from the provider root console with the exact tagged, attested Hosting release; never run the app checkout with sudo.`,
        { cause: error },
      );
    }
    throw error;
  }

  const signerWalletId = String(result.wallet.walletId ?? "").trim();
  if (
    !signerWalletId ||
    signerWalletId !== expectedSignerWalletId ||
    (result.policy.walletId && result.policy.walletId !== signerWalletId)
  ) {
    throw new Error(
      `native signer returned an unexpected wallet ID; requested=${walletId} expected=${expectedSignerWalletId} returned=${signerWalletId || "missing"}`,
    );
  }
  const signerIdCollision = findNativeSignerWalletIdCollision(
    readWalletProviderRegistry(params.env).wallets,
    walletId,
    signerWalletId,
  );
  if (signerIdCollision) {
    throw new Error(
      `native signer wallet ID ${signerWalletId} is already registered as ${signerIdCollision.id}; choose a distinct wallet ID`,
    );
  }

  const fallbackRpcUrl = String(
    mergedEnv[fallbackRpcEnvKeyFor(walletId)] ??
      mergedEnv.FASED_WALLET_SOLANA_RPC_FALLBACK_URL ??
      "",
  ).trim();
  const network = configureSignerOwnedWalletNetwork({
    walletId: signerWalletId,
    primaryRpcUrl: params.rpcUrl,
    fallbackRpcUrl: fallbackRpcUrl || undefined,
    env: mergedEnv,
    signerBinPath: hosted ? undefined : resolveSignerdBinaryPath(mergedEnv),
    controlSocketPath: hosted ? undefined : resolveLocalSignerControlSocketPath(mergedEnv),
  });

  await writeConfigFile(cfg);

  const wallet = upsertNamedWallet({
    walletId,
    name: params.options.walletName || "Wallet",
    providerId: "local-socket-signer",
    addresses: { solana: result.wallet.publicKey },
    metadata: {
      role: params.role,
      purpose: params.role,
      keyAuthority: "signer-owned-v2",
      signerWalletId,
      policyHash: result.policy.hash,
      policyVersion: result.policy.version,
      policyState: "locked",
      networkHash: network.hash,
      networkVersion: network.version,
      networkReady: network.ready,
    },
    env: params.env,
  });
  if (params.role === "agent") {
    setDefaultWallet({ walletId: wallet.id, env: params.env });
  }

  if (params.options.json) {
    params.runtime.log(
      JSON.stringify(
        {
          ok: true,
          provider: "local-socket-signer",
          chain: params.chain,
          walletId: wallet.id,
          signerWalletId,
          address: result.wallet.publicKey,
          policyHash: result.policy.hash,
          policyVersion: result.policy.version,
          policyState: "locked",
          networkVersion: network.version,
          networkReady: network.ready,
          ...(network.rootAdminRequired
            ? { networkActivation: "root-admin-required", rootCommand: network.rootCommand }
            : {}),
        },
        null,
        2,
      ),
    );
  } else {
    params.runtime.log(`Signer wallet ID: ${signerWalletId}`);
    params.runtime.log(`${params.chain.toUpperCase()} address: ${result.wallet.publicKey}`);
    if (!params.options.noSignerHints) {
      params.runtime.log(
        "Signer-owned wallet created with a deny-all policy. Configure explicit operations, destinations, assets, and positive caps before sending.",
      );
      if (network.rootAdminRequired && network.rootCommand) {
        params.runtime.log(
          "Hosted wallet remains fail-closed until a root administrator activates its RPC network from a root-owned file:",
        );
        params.runtime.log(network.rootCommand);
      }
    }
  }
  return result;
}

export async function walletSetupCommand(
  runtime: RuntimeEnv = defaultRuntime,
  options: WalletSetupOptions = {},
) {
  const env = process.env;
  const interactive = !options.nonInteractive;
  const currentConfig = loadConfig();
  const currentRegistry = readWalletProviderRegistry(env);
  if (
    hasLegacyEmbeddedKeystoreConfig(currentConfig, {
      ...env,
      ...currentConfig.env?.vars,
    }) ||
    hasLegacyEmbeddedKeystoreMaterialHint({ ...env, ...currentConfig.env?.vars }) ||
    currentRegistry.providers["embedded-keystore"]?.enabled ||
    currentRegistry.wallets.some((wallet) => wallet.providerId === "embedded-keystore")
  ) {
    throwLegacyEmbeddedKeystoreMigrationRequired("legacy wallet setup state detected");
  }
  if (options.role && !normalizeWalletUserRole(options.role)) {
    throw new Error("wallet role must be agent, mining, or vault");
  }

  const configureLimitOrdersIfRequested = async () => {
    if (!options.enableLimitOrders && !options.disableLimitOrders && !options.jupiterApiKey) {
      return;
    }
    await walletLimitOrdersConfigureCommand(runtime, {
      enable: Boolean(options.enableLimitOrders || options.jupiterApiKey),
      disable: Boolean(options.disableLimitOrders),
      jupiterApiKey: options.jupiterApiKey,
      nonInteractive: options.nonInteractive,
      json: options.json,
    });
  };

  const prompt = async (question: string, fallback = ""): Promise<string> => {
    if (!interactive) {
      return fallback;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await rl.question(`${question}${fallback ? ` [${fallback}]` : ""}: `);
      return answer.trim() || fallback;
    } finally {
      rl.close();
    }
  };
  const promptSecret = async (question: string, fallback = ""): Promise<string> => {
    if (!interactive) {
      return fallback;
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      return await prompt(question, fallback);
    }
    const stdin = process.stdin;
    const stdout = process.stdout;
    stdout.write(`${question}${fallback ? " [hidden default]" : ""}: `);
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    try {
      await new Promise<void>((resolve, reject) => {
        const onData = (chunk: string) => {
          for (const ch of chunk) {
            if (ch === "\r" || ch === "\n") {
              stdout.write("\n");
              stdin.off("data", onData);
              resolve();
              return;
            }
            if (ch === "\u0003") {
              stdout.write("\n");
              stdin.off("data", onData);
              reject(new Error("Interrupted"));
              return;
            }
            if (ch === "\u007f" || ch === "\b") {
              if (value.length > 0) {
                value = value.slice(0, -1);
                stdout.write("\b \b");
              }
              continue;
            }
            value += ch;
            stdout.write("*");
          }
        };
        stdin.on("data", onData);
      });
    } finally {
      stdin.setRawMode?.(false);
      stdin.pause();
    }
    return value.trim() || fallback;
  };

  let mode = options.mode;
  if (!mode) {
    runtime.log("Wallet setup modes:");
    runtime.log("  local-signer-create  Create a signer-owned Solana wallet (default)");
    runtime.log("  local-signer-import  Show the native signer-only import command");
    runtime.log("  turnkey          Configure hosted provider (Turnkey)");
    runtime.log("  alchemy          Configure hosted provider (Alchemy)");
    const picked = await prompt("Choose wallet setup mode", "local-signer-create");
    mode =
      picked === "local-signer-create" ||
      picked === "local-signer-import" ||
      picked === "local-signer" ||
      picked === "turnkey" ||
      picked === "alchemy"
        ? picked
        : "local-signer-create";
  }

  if (mode === "embedded" || mode === "embedded-create" || mode === "embedded-import") {
    throwLegacyEmbeddedKeystoreMigrationRequired(`wallet setup mode ${mode} is unavailable`);
  }
  if (
    mode !== "local-signer-create" &&
    mode !== "local-signer-import" &&
    mode !== "local-signer" &&
    mode !== "turnkey" &&
    mode !== "alchemy" &&
    mode !== "privy"
  ) {
    throw new Error(
      `Unsupported wallet setup mode: ${String(mode)}. ` +
        "Use one of: local-signer-create, local-signer-import, local-signer, turnkey, alchemy. Privy is unavailable.",
    );
  }

  if (mode === "local-signer-create") {
    const chain = options.chain ?? "solana";
    const walletId =
      options.walletId ??
      ((await prompt("Wallet id (optional, e.g. agent/mining/vault)", "")).trim() || undefined);
    const rpcUrlFallback = resolveRpcUrlForChain(env, chain, walletId, options.rpcUrl);
    const rpcUrl = (
      await prompt(
        `${chain.toUpperCase()} RPC URL (required for balances/readiness/send)`,
        rpcUrlFallback,
      )
    ).trim();
    if (!rpcUrl) {
      throw new Error(
        `${chain.toUpperCase()} RPC URL is required for self-hosted wallet setup. ` +
          "Pass --rpc-url or set FASED_WALLET_<CHAIN>_RPC_URL.",
      );
    }
    const role =
      normalizeWalletUserRole(options.role) ??
      (walletId?.trim().toLowerCase() === "mining"
        ? "mining"
        : walletId?.trim().toLowerCase() === "vault"
          ? "vault"
          : "agent");
    await createSignerOwnedWalletForSetup({
      runtime,
      options,
      env,
      chain,
      walletId,
      rpcUrl,
      role,
    });
    if (!options.noSignerHints && !options.json) {
      runtime.log("Signer-owned wallet created in fased-signerd.");
    }
    await configureLimitOrdersIfRequested();
    return;
  }

  if (mode === "local-signer-import") {
    throw new Error(
      "Wallet import is native-signer-only. For a Solana CLI keypair, run `fased-signerd admin wallet import --control-socket <absolute-control.sock> --wallet-id <wallet-id> --locked-role <agent|mining|vault> < /absolute/path/to/solana-keypair.json`. For an old Fased encrypted keystore, use `wallet import-legacy` with owner-only keystore/passphrase file paths. Normal Fased Node, Gateway, and UI paths do not accept wallet private keys or passphrases. Local runs both processes under one OS account and is not a hard compromise boundary; Hosting uses a separate signer account for OS isolation.",
    );
  }

  if (mode === "local-signer") {
    await configureLocalSignerMode(runtime, options, env);
    await configureLimitOrdersIfRequested();
    return;
  }

  if (mode === "turnkey" || mode === "alchemy" || mode === "privy") {
    const providerId = mode;
    runtime.log(`${providerId} (hosted provider) setup`);
    runtime.log("This configures encrypted local provider credentials.");
    if (providerId === "turnkey") {
      runtime.log("Turnkey readiness validation will run after save.");
    }
    if (providerId === "privy") {
      throw new Error(
        "Privy wallet creation and signing are not implemented. Fased will not save credentials for an unavailable provider.",
      );
    }
    if (providerId === "alchemy") {
      const apiKey = (
        options.apiKey ??
        env.ALCHEMY_API_KEY ??
        (await prompt(`${providerId} API key`, ""))
      ).trim();
      if (!apiKey) {
        throw new Error(`${providerId} setup requires API key.`);
      }
      await walletProviderConfigureCommand(runtime, {
        providerId,
        values: [`apiKey=${apiKey}`],
        json: Boolean(options.json),
      });
      runtime.log("See docs: docs/plugins/crypto/wallet-production-flow.md");
      return;
    }

    const apiPublicKey = (
      options.turnkeyApiPublicKey ??
      env.TURNKEY_API_PUBLIC_KEY ??
      env.FASED_WALLET_TURNKEY_API_PUBLIC_KEY ??
      (await prompt("Turnkey API public key", ""))
    ).trim();
    const apiPrivateKey = (
      options.turnkeyApiPrivateKey ??
      env.TURNKEY_API_PRIVATE_KEY ??
      env.FASED_WALLET_TURNKEY_API_PRIVATE_KEY ??
      (await promptSecret("Turnkey API private key", ""))
    ).trim();
    const organizationId = (
      options.turnkeyOrganizationId ??
      env.TURNKEY_ORGANIZATION_ID ??
      env.FASED_WALLET_TURNKEY_ORGANIZATION_ID ??
      (await prompt("Turnkey organization ID", ""))
    ).trim();
    const policyId = (
      options.turnkeyPolicyId ??
      env.TURNKEY_POLICY_ID ??
      env.FASED_WALLET_TURNKEY_POLICY_ID ??
      (await prompt("Turnkey policy ID for this dedicated API user", ""))
    ).trim();
    const baseUrl = (
      options.turnkeyBaseUrl ??
      env.TURNKEY_BASE_URL ??
      env.FASED_WALLET_TURNKEY_BASE_URL ??
      (await prompt("Turnkey base URL (optional)", ""))
    ).trim();
    const turnkeyRpcUrl = (
      options.rpcUrl ??
      env.FASED_WALLET_TURNKEY_RPC_URL ??
      env.FASED_WALLET_SOLANA_RPC_URL ??
      (await prompt("Solana RPC URL", ""))
    ).trim();
    if (!apiPublicKey || !apiPrivateKey || !organizationId || !policyId || !turnkeyRpcUrl) {
      throw new Error(
        "Turnkey setup requires a dedicated API public/private key, organization ID, policy ID, and Solana RPC URL. " +
          "Pass --turnkey-api-public-key, --turnkey-api-private-key, --turnkey-organization-id, " +
          "--turnkey-policy-id, and --rpc-url for non-interactive use.",
      );
    }
    const values = [
      `apiPublicKey=${apiPublicKey}`,
      `apiPrivateKey=${apiPrivateKey}`,
      `organizationId=${organizationId}`,
      `policyId=${policyId}`,
      `rpcUrl=${turnkeyRpcUrl}`,
    ];
    if (baseUrl) {
      values.push(`baseUrl=${baseUrl}`);
    }
    await walletProviderConfigureCommand(runtime, {
      providerId: "turnkey",
      values,
      json: Boolean(options.json),
    });
    runtime.log("");
    runtime.log("Turnkey validation:");
    try {
      const cfg = loadConfig();
      const wallet = resolveWalletConfigForRuntime(cfg, process.env);
      const provider = createWalletProviderAdapter({
        cfg,
        wallet,
        env: process.env ?? process.env,
        providerIdOverride: "turnkey",
      });
      const caps = buildWalletProviderCapabilityMatrix(provider);
      const health = await provider.health();
      runtime.log(
        `  Health: ${health.ok ? "ok" : "fail"}${health.details ? ` — ${health.details}` : ""}`,
      );
      runtime.log(
        `  Chains: ${caps.supportedChains.join(", ") || "(none)"} · prepare=${String(caps.operations.prepare)} send=${String(caps.operations.send)}`,
      );
      runtime.log(
        `  Ready: ${health.ok && caps.operations.prepare && caps.operations.send ? "yes" : "needs fixes"}`,
      );
      if (!health.ok || !caps.operations.prepare || !caps.operations.send) {
        runtime.log(
          "  Turnkey is not ready. Verify the dedicated API user's policy scope, organization/policy IDs, RPC URL, and connectivity.",
        );
      }
      if (
        options.nonInteractive &&
        !(health.ok && caps.operations.prepare && caps.operations.send)
      ) {
        throw new Error("Turnkey provider is not ready after configuration.");
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      if (options.nonInteractive) {
        throw new Error(
          `Turnkey validation failed in non-interactive mode: ${detail}. ` +
            "Fix credentials/connectivity and rerun.",
          { cause: err },
        );
      }
      runtime.log(`  Validation failed: ${detail}`);
    }
    runtime.log("See docs: docs/plugins/crypto/wallet-production-flow.md");
    return;
  }
}

export async function walletRoleSetCommand(
  runtime: RuntimeEnv = defaultRuntime,
  options: WalletRoleSetOptions,
) {
  const walletId = options.walletId.trim();
  const role = normalizeWalletRoleForCli(options.role);
  if (!walletId) {
    throw new Error("walletId is required");
  }
  if (!role) {
    throw new Error("role must be agent or vault");
  }
  const cfg = loadConfig();
  const activeMiningWalletId = resolveConfiguredMiningWalletId(cfg);
  if (activeMiningWalletId === walletId) {
    throw new Error(
      "This wallet is the singleton SAT mining wallet. Delete and recreate @wallet:mining before changing its Agent/Vault role.",
    );
  }
  const currentRegistry = readWalletProviderRegistry(process.env);
  const existingWallet = currentRegistry.wallets.find((entry) => entry.id === walletId);
  if (!existingWallet) {
    throw new Error("walletId does not exist");
  }
  const currentRole =
    resolveWalletUserRole(existingWallet) ??
    (currentRegistry.defaultWalletId === walletId ? "agent" : undefined);
  if (currentRole && currentRole !== role) {
    throw new Error(
      `Wallet purpose is permanent after creation. ${existingWallet.name} (${walletId}) is already ${currentRole}. Create a new wallet for ${role} use instead.`,
    );
  }
  const registry = setNamedWalletRole({ walletId, role, env: process.env });
  const wallet = registry.wallets.find((entry) => entry.id === walletId);
  if (role === "agent" && options.primary) {
    setDefaultWallet({ walletId, env: process.env });
  }
  const updatedRegistry = readWalletProviderRegistry(process.env);
  const primary = updatedRegistry.defaultWalletId === walletId;
  if (options.json) {
    runtime.log(
      JSON.stringify(
        {
          ok: true,
          walletId,
          walletName: wallet?.name,
          role,
          primary,
        },
        null,
        2,
      ),
    );
    return;
  }
  runtime.log(
    `${wallet?.name ?? walletId} (${walletId}) set to ${role === "agent" ? "Agent wallet" : "Vault wallet"}${primary ? " and primary Agent fallback" : ""}.`,
  );
}

export async function walletStatusCommand(
  runtime: RuntimeEnv = defaultRuntime,
  options: WalletStatusOptions = {},
) {
  const status = await readWalletStatusSnapshot();
  if (options.json) {
    runtime.log(JSON.stringify({ ok: true, status }, null, 2));
    return;
  }

  runtime.log(`Wallet: ${status.enabled ? "enabled" : "disabled"} (${status.mode})`);
  runtime.log(`Runtime source: ${status.runtime}`);
  runtime.log(
    `Service: ${status.service.host}:${status.service.port} healthy=${String(status.service.healthy)}`,
  );
  runtime.log(`Startup state: ${status.startupState}`);
  runtime.log(`Auth state: ${status.authState}`);
  runtime.log(`Auth mode: ${status.authMode}`);
  runtime.log(`Auth source: ${status.authSource}`);
  runtime.log(
    `Settlement: ${status.settlement.class} realChainReady=${String(status.settlement.realChainReady)}`,
  );
  runtime.log(`Execution mode: ${status.policy.executionMode}`);
  runtime.log(`Chains: ${status.chains.join(", ")}`);
  runtime.log(`Tool access: ${status.policy.toolAccessMode}`);
  runtime.log(`Automated execution: ${status.policy.directSigning ? "enabled" : "disabled"}`);
  runtime.log(
    `Approval auth: ${status.approvalAuth.mode} ready=${String(status.approvalAuth.ready)} passkeys=${status.approvalAuth.passkeyCount}`,
  );
  runtime.log(`State path: ${status.paths.rootDir}`);
  if (status.stack) {
    runtime.log(
      `Docker stack: configured=${String(status.stack.configured)} healthy=${String(status.stack.healthy)} runningServices=${status.stack.runningServices}`,
    );
  }
  if (status.addresses?.solana) {
    runtime.log(`Address: ${status.addresses.solana}`);
  }
  if (status.error) {
    runtime.log(`Status warning: ${status.error}`);
  }
}

export async function walletKeystoreInitCommand(
  runtime: RuntimeEnv = defaultRuntime,
  options: WalletKeystoreInitOptions = {},
): Promise<never> {
  void runtime;
  void options;
  throwLegacyEmbeddedKeystoreMigrationRequired("legacy keystore CLI command is unavailable");
}
export async function walletKeystoreImportCommand(
  runtime: RuntimeEnv = defaultRuntime,
  options: WalletKeystoreImportOptions = {},
): Promise<never> {
  void runtime;
  void options;
  throwLegacyEmbeddedKeystoreMigrationRequired("legacy keystore CLI command is unavailable");
}
export async function walletKeystoreStatusCommand(
  runtime: RuntimeEnv = defaultRuntime,
  options: WalletKeystoreStatusOptions = {},
): Promise<never> {
  void runtime;
  void options;
  throwLegacyEmbeddedKeystoreMigrationRequired("legacy keystore CLI command is unavailable");
}
export async function walletKeystoreValidateCommand(
  runtime: RuntimeEnv = defaultRuntime,
  options: WalletKeystoreValidateOptions = {},
): Promise<never> {
  void runtime;
  void options;
  throwLegacyEmbeddedKeystoreMigrationRequired("legacy keystore CLI command is unavailable");
}
export async function walletKeystorePassphraseInitCommand(
  runtime: RuntimeEnv = defaultRuntime,
  options: WalletKeystorePassphraseInitOptions = {},
): Promise<never> {
  void runtime;
  void options;
  throwLegacyEmbeddedKeystoreMigrationRequired("legacy keystore CLI command is unavailable");
}
export async function walletKeystorePassphraseRotateCommand(
  runtime: RuntimeEnv = defaultRuntime,
  options: WalletKeystorePassphraseRotateOptions = {},
): Promise<never> {
  void runtime;
  void options;
  throwLegacyEmbeddedKeystoreMigrationRequired("legacy keystore CLI command is unavailable");
}
export async function walletKeystoreExportCommand(
  runtime: RuntimeEnv = defaultRuntime,
  options: WalletKeystoreExportOptions = {},
): Promise<never> {
  void runtime;
  void options;
  throwLegacyEmbeddedKeystoreMigrationRequired("legacy keystore CLI command is unavailable");
}
export async function walletProviderConfigureCommand(
  runtime: RuntimeEnv,
  options: WalletProviderConfigureOptions,
): Promise<void> {
  const providerId = options.providerId;
  if (providerId === "privy") {
    throw new Error(
      "Privy wallet creation and signing are unavailable. No Privy credentials or provider selection were saved.",
    );
  }
  const cfg = loadConfig();
  const credentials = parseCredentialPairs(options.values);
  if (Object.keys(credentials).length === 0) {
    throw new Error("no credentials supplied; pass one or more --set key=value");
  }
  if (providerId === "turnkey") {
    const allowed = new Set([
      "apiPublicKey",
      "apiPrivateKey",
      "organizationId",
      "policyId",
      "baseUrl",
      "rpcUrl",
      "defaultSolanaAddress",
      "providerWalletId",
    ]);
    const unsupported = Object.keys(credentials).find((field) => !allowed.has(field));
    if (unsupported) {
      throw new Error(`unsupported Turnkey credential field: ${unsupported}`);
    }
    const missing = [
      "apiPublicKey",
      "apiPrivateKey",
      "organizationId",
      "policyId",
      "rpcUrl",
    ].filter((field) => !credentials[field]?.trim());
    if (missing.length > 0) {
      throw new Error(`Turnkey credentials are incomplete; missing ${missing.join(", ")}`);
    }
  }
  const saved = saveWalletProviderSecret({ providerId, credentials }, process.env);

  let nextCfg: FasedAgentConfig = {
    ...cfg,
    wallet: {
      ...cfg.wallet,
      provider: {
        ...cfg.wallet?.provider,
        id: providerId,
      },
      runtime: {
        ...cfg.wallet?.runtime,
        enabled: true,
      },
    },
  };

  if (options.rpcUrl?.trim()) {
    const rpcUrl = options.rpcUrl.trim();
    nextCfg = {
      ...nextCfg,
      wallet: {
        ...nextCfg.wallet,
        keystore: nextCfg.wallet?.keystore,
      },
    };
    // For hosted providers, keep RPC hint in env/secret store usage path by setting env-backed rpc secret.
    // Avoid overloading provider credentials schema for chain/rpc metadata in config.
    saveWalletProviderSecret(
      {
        providerId,
        credentials: {
          ...saved.credentials,
          rpcUrl,
        },
      },
      process.env,
    );
  }

  await writeConfigFile(nextCfg, { envSnapshotForRestore: process.env });
  setWalletProviderEnabled({ providerId, enabled: true, env: process.env });
  const status = readWalletProviderSecretStatus(providerId, process.env);

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          providerId,
          configUpdated: true,
          secret: status,
          recommended: providerId === "turnkey",
        },
        null,
        2,
      ),
    );
    return;
  }

  const banner = providerId === "turnkey" ? " (recommended hosted signer)" : "";
  console.log(`Configured wallet provider credentials for ${providerId}${banner}.`);
  console.log(`Stored fields: ${status.fields.join(", ") || "(none)"}`);
  console.log(`Secrets path: ${status.path}`);
  console.log("Set wallet.provider.id and disabled wallet.runtime in config.");
}

export async function walletPolicyProfileApplyCommand(
  runtime: RuntimeEnv = defaultRuntime,
  options: WalletPolicyProfileApplyOptions,
): Promise<void> {
  const cfg = loadConfig();
  const allowSkills = normalizeStringList(options.allowSkills);
  const allowSources = normalizeStringList(options.allowSources);
  const profile = options.profile;
  const strict = profile === "autonomous-strict";
  const moderate = profile === "autonomous-moderate";
  const manual = profile === "manual-owner";
  const nextCfg: FasedAgentConfig = {
    ...cfg,
    wallet: {
      ...cfg.wallet,
      execution: {
        ...cfg.wallet?.execution,
        mode: manual ? "manual" : "autonomous",
      },
      approvalAuth: {
        ...cfg.wallet?.approvalAuth,
        mode: "none",
      },
      runtime: {
        ...cfg.wallet?.runtime,
        policy: {
          ...cfg.wallet?.runtime?.policy,
          directSigning: true,
          solana: {
            ...cfg.wallet?.runtime?.policy?.solana,
            maxPerTx: manual ? "100000000000" : moderate ? "5000000000" : "1000000000",
            maxDaily: manual ? "1000000000000" : moderate ? "20000000000" : "5000000000",
          },
        },
        toolAccess: {
          ...cfg.wallet?.runtime?.toolAccess,
          mode: manual ? "owner-only" : allowSkills.length > 0 ? "allowlist" : "owner-only",
          allowSkills: manual ? [] : allowSkills,
          allowSources: manual
            ? []
            : allowSources.length > 0
              ? allowSources
              : strict
                ? ["cron", "plugin"]
                : [],
        },
      },
    },
  };
  await writeConfigFile(nextCfg, { envSnapshotForRestore: process.env });
  const payload = {
    ok: true,
    profile,
    wallet: {
      execution: nextCfg.wallet?.execution,
      approvalAuth: nextCfg.wallet?.approvalAuth,
      runtime: nextCfg.wallet?.runtime,
    },
  };
  if (options.json) {
    runtime.log(JSON.stringify(payload, null, 2));
    return;
  }
  runtime.log(`Applied wallet policy profile: ${profile}`);
  runtime.log("Tx approval popups: disabled (approvalAuth.mode=none)");
  runtime.log(
    `Tool access mode: ${String(nextCfg.wallet?.runtime?.toolAccess?.mode ?? "owner-only")}`,
  );
}

export async function walletSignerServeCommand(
  runtime: RuntimeEnv = defaultRuntime,
  options: WalletSignerServeOptions = {},
): Promise<void> {
  const env = process.env ?? process.env;
  const socketPath =
    options.socketPath?.trim() ||
    String(env.FASED_WALLET_LOCAL_SIGNER_SOCKET ?? "").trim() ||
    path.join(ensureWalletStateDir(env).rootDir, "local-signer.sock");
  const explicit = String(env.FASED_WALLET_LOCAL_SIGNER_BIN ?? "").trim();
  const home = String(env.HOME ?? "").trim();
  const suggested =
    explicit || (home ? path.join(home, ".fased", "bin", "fased-signerd") : "") || "fased-signerd";
  void runtime;
  throw new Error(
    `legacy Node signer has been removed; run native Go signer instead: ${suggested} --socket "${socketPath}"${options.readOnly ? " --read-only" : ""}`,
  );
}

export async function collectWalletSignerDoctorReport(
  env: NodeJS.ProcessEnv = process.env,
  options: WalletSignerDoctorOptions = {},
): Promise<WalletSignerDoctorReport> {
  const cfg = options.config ?? loadConfig();
  const effectiveEnv = { ...env, ...cfg.env?.vars };

  const socketPath =
    options.socketPath?.trim() ||
    String(effectiveEnv.FASED_WALLET_LOCAL_SIGNER_SOCKET ?? "").trim() ||
    path.join(ensureWalletStateDir(effectiveEnv).rootDir, "local-signer.sock");
  const hostingSigner =
    String(effectiveEnv.FASED_HOST_PROFILE ?? "")
      .trim()
      .toLowerCase() === "hosting" || socketPath === "/run/fased-signerd/app.sock";
  const expectedSocketMode = hostingSigner ? 0o660 : 0o600;
  const { pidPath, auditPath } = resolveLocalSignerSidecarPaths(socketPath);
  const checks: Array<{ check: string; ok: boolean; detail?: string }> = [];

  const push = (check: string, ok: boolean, detail?: string) =>
    checks.push({
      check,
      ok,
      detail: detail ? redactWalletDiagnosticText(detail) : undefined,
    });

  const providerId = resolveWalletProviderId(cfg, effectiveEnv);
  const isLocalSigner = providerId === "local-socket-signer";
  const providerRegistry = readWalletProviderRegistry(effectiveEnv);
  const providerWallets = providerRegistry.wallets.filter(
    (entry) => entry.providerId === providerId,
  );
  const localSignerSetupPending = isLocalSigner && providerWallets.length === 0;
  let localSignerHealth: LocalSocketSignerHealthProbe | undefined;
  const isNotFoundError = (err: unknown): boolean =>
    (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

  if (isLocalSigner) {
    const externallyManaged = isLocalSignerExternallyManaged(effectiveEnv);
    try {
      const st = fs.statSync(socketPath);
      push("socket.exists", st.isSocket?.() ?? true, socketPath);
      try {
        const mode = st.mode & 0o777;
        push(
          "socket.mode",
          mode === expectedSocketMode,
          `mode=${mode.toString(8)} expected=${expectedSocketMode.toString(8)}`,
        );
      } catch {}
    } catch (err) {
      push(
        "socket.exists",
        localSignerSetupPending && isNotFoundError(err),
        localSignerSetupPending && isNotFoundError(err) ? "Configure" : String(err),
      );
    }

    if (externallyManaged) {
      push("pid.alive", true, "lifecycle=external; process health is verified over the socket");
    } else {
      try {
        const pidRaw = fs.readFileSync(pidPath, "utf8").trim();
        const pid = Number.parseInt(pidRaw, 10);
        if (Number.isFinite(pid) && pid > 1) {
          try {
            process.kill(pid, 0);
            push("pid.alive", true, `pid=${pid}`);
          } catch (err) {
            push("pid.alive", false, `pid=${pid} ${String(err)}`);
          }
        } else {
          push("pid.alive", false, "invalid pid file");
        }
      } catch (err) {
        push(
          "pid.alive",
          localSignerSetupPending && isNotFoundError(err),
          localSignerSetupPending && isNotFoundError(err) ? "Configure" : String(err),
        );
      }
    }

    if (externallyManaged) {
      push("audit.exists", true, "lifecycle=external; audit state is signer-owned");
    } else {
      try {
        const st = fs.statSync(auditPath);
        push("audit.exists", true, `bytes=${st.size}`);
      } catch (err) {
        push(
          "audit.exists",
          localSignerSetupPending && isNotFoundError(err),
          localSignerSetupPending && isNotFoundError(err) ? "Configure" : String(err),
        );
      }
    }

    if (localSignerSetupPending) {
      push("socket.health", true, "Configure");
    } else {
      try {
        localSignerHealth = await probeLocalSocketSignerHealth(socketPath);
        push("socket.health", localSignerHealth.ok, localSignerHealth.details);
      } catch (err) {
        push("socket.health", false, String(err));
      }
    }
  }
  const signerHealthy = checks.find((entry) => entry.check === "socket.health")?.ok === true;
  const registrySolanaWalletIds = providerWallets
    .filter((entry) => Boolean(entry.addresses?.solana))
    .map((entry) => entry.id.trim())
    .filter(Boolean)
    .toSorted();
  push(
    "wallets.configured.solana",
    true,
    registrySolanaWalletIds.length > 0 ? registrySolanaWalletIds.join(",") : "none",
  );

  const resolveChainRpcConfigured = (walletId: string): boolean => {
    const suffix = walletIdEnvSuffix(walletId);
    return Boolean(
      (suffix ? String(effectiveEnv[`FASED_WALLET_SOLANA_RPC_URL__${suffix}`] ?? "").trim() : "") ||
      String(effectiveEnv.FASED_WALLET_SOLANA_RPC_URL ?? "").trim() ||
      String(effectiveEnv.FASED_WALLET_RPC_URL ?? "").trim(),
    );
  };
  const signerNetworks = localSignerHealth?.network?.wallets ?? [];
  const networkForWallet = (walletId: string) =>
    signerNetworks.find(
      (entry) => entry.walletId.trim().toLowerCase() === walletId.trim().toLowerCase(),
    );
  if (isLocalSigner && registrySolanaWalletIds.length > 0) {
    const signerNetworkReady =
      localSignerHealth?.network?.ready === true &&
      registrySolanaWalletIds.every((walletId) => networkForWallet(walletId)?.ready === true);
    push(
      "rpc.configured.solana",
      signerNetworkReady,
      signerNetworkReady
        ? "signer-owned network ready"
        : localSignerHealth?.ok
          ? "signer-owned network pending"
          : "signer health unavailable",
    );
  }
  if (isLocalSigner && localSignerHealth?.ok && localSignerHealth.jupiter) {
    push(
      "jupiter.trigger.configured",
      true,
      localSignerHealth.jupiter.triggerConfigured
        ? "configured in native signer"
        : "not configured (optional; swaps and transfers remain available)",
    );
  }
  for (const walletId of registrySolanaWalletIds) {
    push(
      `keystore.file.solana.${walletId}`,
      signerHealthy,
      signerHealthy
        ? "signer-owned encrypted state; normal Fased Node key-handling path disabled (Local same-user isolation is not a hard boundary)"
        : "native signer is not healthy",
    );
    push(
      `keystore.decrypt.solana.${walletId}`,
      signerHealthy,
      signerHealthy
        ? "native signer handles decryption; normal Fased Node decryption path disabled (Local same-user isolation is not a hard boundary)"
        : "native signer is not healthy",
    );
    if (isLocalSigner) {
      const network = networkForWallet(walletId);
      push(
        `rpc.configured.solana.${walletId}`,
        network?.ready === true,
        network?.ready
          ? `signer-owned network ready (version=${network.version})`
          : network?.configured
            ? "signer-owned network is not ready"
            : "signer-owned network is not configured",
      );
    } else {
      const rpcConfigured = resolveChainRpcConfigured(walletId);
      push(
        `rpc.configured.solana.${walletId}`,
        rpcConfigured,
        rpcConfigured ? "configured" : "missing",
      );
    }
  }

  const ok = checks.every((c) => {
    if (c.ok) {
      return true;
    }
    if (c.check === "audit.exists") {
      return true;
    }
    if (options.checkRpc === false && c.check.startsWith("rpc.configured")) {
      return true;
    }
    return false;
  });
  const signer = localSignerHealth?.ok
    ? {
        ...(localSignerHealth.jupiter ? { jupiter: localSignerHealth.jupiter } : {}),
        ...(localSignerHealth.webAuthn
          ? {
              webAuthn: {
                configured: localSignerHealth.webAuthn.configured,
                credentialCount: localSignerHealth.webAuthn.credentialCount,
                credentialVersion: localSignerHealth.webAuthn.credentialVersion,
                ready: localSignerHealth.webAuthn.ready,
              },
            }
          : {}),
      }
    : undefined;
  return { ok, socketPath, pidPath, auditPath, checks, ...(signer ? { signer } : {}) };
}

export async function walletSignerDoctorCommand(
  runtime: RuntimeEnv = defaultRuntime,
  options: WalletSignerDoctorOptions = {},
): Promise<void> {
  const env = process.env ?? process.env;
  const payload = await collectWalletSignerDoctorReport(env, options);
  if (options.json) {
    runtime.log(JSON.stringify(payload, null, 2));
    return;
  }
  runtime.log(`Wallet signer doctor: ${payload.ok ? "PASS" : "FAIL"}`);
  for (const c of payload.checks) {
    runtime.log(`${c.ok ? "✓" : "✗"} ${c.check}${c.detail ? ` — ${c.detail}` : ""}`);
  }
}

export async function walletRotateKeysCommand(
  runtime: RuntimeEnv = defaultRuntime,
  options: WalletRotateKeysOptions = {},
): Promise<never> {
  void runtime;
  void options;
  throw new Error(
    "Gateway wallet key rotation was removed. For signer-owned encryption rotation, run `fased-signerd admin wallet reencrypt --control-socket <absolute-control.sock> --wallet-id <wallet-id>` as the signer/control-socket owner. Rotate Turnkey or hardware custody only in its provider/wallet authority surface.",
  );
}

function isLegacyWalletMaterialEnvKey(key: string): boolean {
  return (
    key === "FASED_WALLET_KEYSTORE_PATH" ||
    key === "FASED_WALLET_PASSPHRASE" ||
    key === "FASED_WALLET_PASSPHRASE_FILE" ||
    key === "FASED_WALLET_PRIVATE_KEY" ||
    key === "FASED_WALLET_SOLANA_KEYSTORE_PATH" ||
    key.startsWith("FASED_WALLET_SOLANA_KEYSTORE_PATH__")
  );
}

export async function walletLegacyMigrationFinalizeCommand(
  runtime: RuntimeEnv = defaultRuntime,
  options: WalletLegacyMigrationFinalizeOptions,
): Promise<void> {
  const walletId = options.walletId.trim();
  if (!walletId || !/^[a-zA-Z0-9_-]+$/.test(walletId)) {
    throw new Error("walletId must contain only letters, numbers, hyphens, or underscores");
  }
  const cfg = loadConfig();
  const effectiveEnv = { ...process.env, ...cfg.env?.vars } as NodeJS.ProcessEnv;
  const socketPath = requireLocalSocketSignerPath(effectiveEnv);
  const capabilities = await callLocalSocketSigner<{
    ready?: boolean;
    capabilities?: {
      protocol?: { current?: number };
      features?: string[];
    };
  }>(socketPath, { op: "v2.capabilities" });
  if (
    capabilities.ready !== true ||
    capabilities.capabilities?.protocol?.current !== 2 ||
    !capabilities.capabilities?.features?.includes("signerOwnedKeys")
  ) {
    throw new Error(
      "legacy migration finalization requires a ready protocol-v2 signer-owned wallet",
    );
  }
  const nativeWallet = await callLocalSocketSigner<{ walletId?: string; publicKey?: string }>(
    socketPath,
    { op: "v2.wallet.get", walletId },
  );
  const expectedSignerWalletId = normalizeNativeSignerWalletId(walletId);
  const signerWalletId = String(nativeWallet.walletId ?? "").trim();
  const publicKey = String(nativeWallet.publicKey ?? "").trim();
  if (!publicKey || signerWalletId !== expectedSignerWalletId) {
    throw new Error("protocol-v2 signer did not return the requested signer-owned wallet");
  }

  const registry = readWalletProviderRegistry(effectiveEnv);
  const legacyWallet = registry.wallets.find((wallet) => wallet.id === walletId);
  const signerIdCollision = findNativeSignerWalletIdCollision(
    registry.wallets,
    walletId,
    signerWalletId,
  );
  if (signerIdCollision) {
    throw new Error(
      `native signer wallet ID ${signerWalletId} is already registered as ${signerIdCollision.id}; refusing legacy migration finalization`,
    );
  }
  if (legacyWallet && legacyWallet.providerId !== "embedded-keystore") {
    if (legacyWallet.providerId !== "local-socket-signer") {
      throw new Error(
        `wallet ${walletId} is registered to ${legacyWallet.providerId}, not the legacy provider`,
      );
    }
    const registeredAddress = legacyWallet.addresses?.solana?.trim();
    if (registeredAddress && registeredAddress !== publicKey) {
      throw new Error(
        `signer public key mismatch for ${walletId}; registry=${registeredAddress} signer=${publicKey}`,
      );
    }
    const registeredSignerWalletId = legacyWallet.metadata?.signerWalletId;
    if (
      typeof registeredSignerWalletId === "string" &&
      registeredSignerWalletId.trim() &&
      registeredSignerWalletId.trim() !== signerWalletId
    ) {
      throw new Error(
        `signer wallet ID mismatch for ${walletId}; registry=${registeredSignerWalletId.trim()} signer=${signerWalletId}`,
      );
    }
  }
  const legacyAddress = legacyWallet?.addresses?.solana?.trim();
  if (legacyAddress && legacyAddress !== publicKey) {
    throw new Error(
      `signer public key mismatch for ${walletId}; registry=${legacyAddress} signer=${publicKey}`,
    );
  }

  upsertNamedWallet({
    walletId,
    name: options.walletName?.trim() || legacyWallet?.name || "Wallet",
    providerId: "local-socket-signer",
    addresses: { solana: publicKey },
    metadata: {
      ...legacyWallet?.metadata,
      keyAuthority: "signer-owned-v2",
      signerWalletId,
      migratedFromProviderId: "embedded-keystore",
      migratedAt: new Date().toISOString(),
    },
    env: effectiveEnv,
  });
  setWalletProviderEnabled({ providerId: "local-socket-signer", enabled: true, env: effectiveEnv });

  const afterRegistry = readWalletProviderRegistry(effectiveEnv);
  const remainingLegacyWallets = afterRegistry.wallets.filter(
    (wallet) => wallet.providerId === "embedded-keystore",
  );
  if (remainingLegacyWallets.length === 0) {
    setWalletProviderEnabled({
      providerId: "embedded-keystore",
      enabled: false,
      env: effectiveEnv,
    });
    const vars = { ...cfg.env?.vars };
    for (const key of Object.keys(vars)) {
      if (isLegacyWalletMaterialEnvKey(key)) {
        delete vars[key];
      }
    }
    for (const key of Object.keys(process.env)) {
      if (isLegacyWalletMaterialEnvKey(key)) {
        delete process.env[key];
      }
    }
    await writeConfigFile(
      {
        ...cfg,
        env: { ...cfg.env, vars },
        wallet: {
          ...cfg.wallet,
          provider: { ...cfg.wallet?.provider, id: "local-socket-signer" },
          keystore: undefined,
        },
      },
      { envSnapshotForRestore: process.env },
    );
  }

  const result = {
    ok: true,
    walletId,
    signerWalletId,
    publicKey,
    alreadyFinalized:
      legacyWallet?.providerId === "local-socket-signer" &&
      legacyWallet.addresses?.solana?.trim() === publicKey,
    remainingLegacyWalletIds: remainingLegacyWallets.map((wallet) => wallet.id),
  };
  if (options.json) {
    runtime.log(JSON.stringify(result, null, 2));
  } else {
    runtime.log(
      `Verified and finalized signer-owned migration for ${walletId}; signer wallet ID: ${signerWalletId} (${publicKey}).`,
    );
    if (remainingLegacyWallets.length > 0) {
      runtime.log(
        `Remaining legacy wallets: ${remainingLegacyWallets.map((wallet) => wallet.id).join(", ")}`,
      );
    }
  }
}

export async function walletStackInstallCommand(
  runtime: RuntimeEnv = defaultRuntime,
  options: WalletStackOptions = {},
) {
  throwLegacyDockerSignerRemoved("wallet stack install");
  void runtime;
  void options;
}

export async function walletStackUpCommand(
  runtime: RuntimeEnv = defaultRuntime,
  options: WalletStackOptions = {},
) {
  throwLegacyDockerSignerRemoved("wallet stack up");
  void runtime;
  void options;
}

export async function walletStackDownCommand(
  runtime: RuntimeEnv = defaultRuntime,
  options: WalletStackOptions = {},
) {
  throwLegacyDockerSignerRemoved("wallet stack down");
  void runtime;
  void options;
}

export async function walletStackStatusCommand(
  runtime: RuntimeEnv = defaultRuntime,
  options: WalletStackOptions = {},
) {
  throwLegacyDockerSignerRemoved("wallet stack status");
  void runtime;
  void options;
}

export async function walletStackValidateCommand(
  runtime: RuntimeEnv = defaultRuntime,
  options: WalletStackOptions = {},
) {
  throwLegacyDockerSignerRemoved("wallet stack validate");
  void runtime;
  void options;
}

export async function walletStackLogsCommand(
  runtime: RuntimeEnv = defaultRuntime,
  options: WalletStackOptions = {},
) {
  throwLegacyDockerSignerRemoved("wallet stack logs");
  void runtime;
  void options;
}

export async function walletMigrateCommand(
  runtime: RuntimeEnv = defaultRuntime,
  options: WalletMigrateOptions,
) {
  if (!isWalletRuntime(options.from) || !isWalletRuntime(options.to)) {
    throw new Error(
      "wallet migrate requires --from and --to values in external-docker|external-custom",
    );
  }
  const cfg = loadConfig();
  const current = resolveWalletConfigForRuntime(cfg, process.env);
  if (current.runtime !== options.from) {
    throw new Error(
      `wallet migrate expected current runtime=${options.from}, got ${current.runtime}`,
    );
  }

  cfg.wallet = cfg.wallet ?? {};
  cfg.wallet.runtime = cfg.wallet.runtime ?? {};
  cfg.wallet.runtime.runtime = options.to;
  cfg.wallet.runtime.mode = "external";
  if (options.to === "external-docker") {
    cfg.wallet.runtime.external = { ...cfg.wallet.runtime.external, kind: "docker" };
  } else if (options.to === "external-custom") {
    cfg.wallet.runtime.external = { ...cfg.wallet.runtime.external, kind: "custom" };
  }

  await writeConfigFile(cfg);
  const resolved = resolveWalletConfigForRuntime(cfg, process.env);
  if (options.json) {
    runtime.log(
      JSON.stringify(
        {
          ok: true,
          from: options.from,
          to: options.to,
          mode: resolved.mode,
          runtime: resolved.runtime,
          stack: resolved.stack,
        },
        null,
        2,
      ),
    );
  } else {
    runtime.log(`Wallet runtime migrated: ${options.from} -> ${options.to}`);
    runtime.log(`Mode: ${resolved.mode}`);
    runtime.log(`Runtime: ${resolved.runtime}`);
  }
}

export async function walletCanaryCommand(
  runtime: RuntimeEnv = defaultRuntime,
  options: WalletCanaryOptions = {},
) {
  const cfg = loadConfig();
  const resolved = resolveWalletConfigForRuntime(cfg, process.env);
  const statusBefore = await readWalletStatusSnapshot({ config: cfg });
  const parity = null;
  const report = buildWalletCanaryReport({
    status: statusBefore,
    requireRealChain: options.requireRealChain ?? true,
    parity,
  });

  const recovery = {
    attempted: Boolean(options.executeRecoveryDrill),
    ok: true,
    steps: [] as Array<{ step: string; ok: boolean; detail?: string }>,
    finalHealth: statusBefore.service.healthy,
  };

  if (options.executeRecoveryDrill) {
    recovery.ok = false;
    recovery.steps.push({
      step: "recovery_drill.removed",
      ok: false,
      detail: "Legacy Docker signer recovery drill has been removed",
    });
  }

  const output = {
    ok: report.ok && recovery.ok,
    canary: report,
    recoveryDrill: recovery,
    providerE2E: null as Awaited<ReturnType<typeof runWalletProviderCanaryReport>> | null,
  };

  if (options.executeProviderE2E) {
    const requestedProviders = (options.providers ?? [])
      .map((entry) => entry.trim())
      .filter(Boolean);
    const allowed = new Set(["alchemy", "turnkey"]);
    const providers = requestedProviders.filter((entry) => allowed.has(entry)) as Array<
      "alchemy" | "turnkey"
    >;
    const providerE2E = await runWalletProviderCanaryReport({
      cfg,
      wallet: resolved,
      env: process.env,
      providers: providers.length > 0 ? providers : undefined,
      executeLiveSend: options.executeLiveSend,
    });
    output.providerE2E = providerE2E;
    output.ok = output.ok && providerE2E.ok;
  }

  if (options.json) {
    runtime.log(JSON.stringify(output, null, 2));
  } else {
    runtime.log(
      `Canary: ${report.ok ? "PASS" : "FAIL"} (requireRealChain=${String(report.requireRealChain)})`,
    );
    for (const check of report.checks) {
      runtime.log(
        `${check.ok ? "PASS" : "FAIL"} [${check.required ? "required" : "optional"}] ${check.id}: ${check.message}`,
      );
    }
    if (options.executeRecoveryDrill) {
      runtime.log(`Recovery drill: ${recovery.ok ? "PASS" : "FAIL"}`);
      for (const step of recovery.steps) {
        runtime.log(
          `${step.ok ? "PASS" : "FAIL"} ${step.step}${step.detail ? ` - ${step.detail}` : ""}`,
        );
      }
    } else {
      runtime.log(
        "Recovery drill not executed. Re-run with --execute-recovery-drill on canary host.",
      );
    }
    if (output.providerE2E) {
      runtime.log(
        `Provider E2E: ${output.providerE2E.ok ? "PASS" : "FAIL"} (liveSend=${String(output.providerE2E.executeLiveSend)})`,
      );
      for (const provider of output.providerE2E.providers) {
        runtime.log(`Provider ${provider.providerId}: ${provider.ok ? "PASS" : "FAIL"}`);
        for (const step of provider.steps) {
          runtime.log(
            `  ${step.ok ? "PASS" : "FAIL"} [${step.required ? "required" : "optional"}] ${step.id}: ${step.message}`,
          );
        }
      }
    } else {
      runtime.log(
        "Provider E2E not executed. Re-run with --execute-provider-e2e (optionally --execute-live-send).",
      );
    }
  }

  if (!output.ok) {
    throw new Error("wallet canary checks failed");
  }
}

export async function walletInboundPollCommand(
  runtime: RuntimeEnv = defaultRuntime,
  options: WalletInboundPollOptions = {},
) {
  const cfg = loadConfig();
  const wallet = resolveWalletConfigForRuntime(cfg, process.env);
  const chain: "solana" | "all" = options.chain === "solana" ? options.chain : "all";
  const result = await pollWalletInboundEvents({
    cfg,
    wallet,
    env: process.env,
    providerId: parseWalletProviderId(options.providerId),
    walletId: options.walletId?.trim() || undefined,
    walletName: options.walletName?.trim() || undefined,
    chain,
    actor: "wallet-cli",
  });
  if (options.json) {
    runtime.log(JSON.stringify(result, null, 2));
    return;
  }
  runtime.log(`Inbound poll provider: ${result.providerId}`);
  runtime.log(`Checked at: ${result.checkedAt}`);
  runtime.log(`Detected events: ${result.detected.length}`);
  runtime.log(`Reconciled: ${result.reconciliation.reconciled}`);
  if (result.walletId || result.walletName) {
    runtime.log(
      `Wallet scope: ${result.walletName ?? "unnamed"} (${result.walletId ?? "default"})`,
    );
  }
}

export async function walletInboundListCommand(
  runtime: RuntimeEnv = defaultRuntime,
  options: WalletInboundListOptions = {},
) {
  const events = listWalletInboundEvents({
    env: process.env,
    providerId: parseWalletProviderId(options.providerId),
    walletId: options.walletId?.trim() || undefined,
    chain: options.chain === "solana" ? options.chain : undefined,
    status:
      options.status === "all" ||
      options.status === "detected" ||
      options.status === "confirmed" ||
      options.status === "reconciled" ||
      options.status === "ignored"
        ? options.status
        : "all",
    limit: options.limit,
  });
  if (options.json) {
    runtime.log(JSON.stringify({ ok: true, events }, null, 2));
    return;
  }
  runtime.log(`Inbound events: ${events.length}`);
  for (const event of events) {
    runtime.log(
      `${event.observedAt} ${event.providerId} ${event.chain} ${event.kind}/${event.direction} status=${event.status} amount=${event.amount ?? "n/a"} tx=${event.txHash ?? "n/a"}`,
    );
  }
}

export async function walletInboundReconcileCommand(
  runtime: RuntimeEnv = defaultRuntime,
  options: WalletInboundReconcileOptions = {},
) {
  const result = reconcileWalletInboundEvents({ env: process.env });
  if (options.json) {
    runtime.log(JSON.stringify({ ok: true, result }, null, 2));
    return;
  }
  runtime.log(`Inbound reconciliation examined: ${result.examined}`);
  runtime.log(`Inbound reconciliation matched: ${result.reconciled}`);
  if (result.lastReconciledAt) {
    runtime.log(`Last reconciled at: ${result.lastReconciledAt}`);
  }
}
