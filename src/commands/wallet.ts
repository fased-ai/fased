import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  scryptSync,
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { loadConfig, type FasedAgentConfig, writeConfigFile } from "../config/config.js";
import type { WalletChain, WalletProviderId, WalletRuntimeKind } from "../config/types.wallet.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { startLocalSocketSignerBroker } from "../wallet/local-socket-signer-broker.js";
import { readWalletApprovalAuthSnapshot } from "../wallet/wallet-approval-auth.js";
import { buildWalletCanaryReport, runWalletProviderCanaryReport } from "../wallet/wallet-canary.js";
import {
  deleteWalletCustodyCeremony,
  initializeWalletCustodyCeremony,
  listSplitKeyWalletCustodyStatuses,
  lockWalletCustodyUnlockSessions,
  readWalletCustodyStatus,
  recoverWalletCustodyPassphrase,
} from "../wallet/wallet-custody.js";
import {
  listWalletInboundEvents,
  pollWalletInboundEvents,
  reconcileWalletInboundEvents,
  type WalletInboundStatus,
} from "../wallet/wallet-inbound-events.js";
import { applyWalletPolicyConfig, resolveWalletRoleForId } from "../wallet/wallet-policy.js";
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
  resolveLocalSignerBackendSocketPath,
  resolveLocalSignerMaterialRootDir,
  resolveLocalSignerSidecarPaths,
  resolveLocalSignerSocketPath,
  resolveWalletRuntimeConfig,
} from "../wallet/wallet-runtime-config.js";
import {
  readWalletProviderSecretStatus,
  saveWalletProviderSecret,
} from "../wallet/wallet-secrets-store.js";
import {
  readWalletStatusSnapshot,
  resolveWalletConfigForRuntime,
} from "../wallet/wallet-status.js";
import { restartLocalSocketSigner, resolveSignerdBinaryPath } from "../wizard/onboarding.wallet.js";

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
  privateKey?: string;
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
  showPrivateKeyOnce?: boolean;
  confirmPrivateKeyPrint?: string;
  role?: string;
  noProviderIdUpdate?: boolean;
  force?: boolean;
  enableLimitOrders?: boolean;
  disableLimitOrders?: boolean;
  jupiterApiKey?: string;
  jupiterTriggerApiBaseUrl?: string;
};

export type WalletLimitOrdersOptions = {
  enable?: boolean;
  disable?: boolean;
  jupiterApiKey?: string;
  jupiterTriggerApiBaseUrl?: string;
  nonInteractive?: boolean;
  json?: boolean;
};

export type WalletStatusOptions = {
  json?: boolean;
};

export type WalletRotateKeysOptions = {
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

export type WalletCustodyInitOptions = {
  json?: boolean;
  force?: boolean;
  deviceShare?: string;
  walletId?: string;
};

export type WalletCustodyLockOptions = {
  json?: boolean;
  host?: string;
  walletId?: string;
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
  out?: string;
  rpcUrl?: string;
  passphrase?: string;
  chain?: WalletChain;
  walletId?: string;
  showPrivateKeyOnce?: boolean;
  confirmPrivateKeyPrint?: string;
  force?: boolean;
  name?: string;
  role?: string;
  skipProviderConfig?: boolean;
  providerIdForRegistry?: WalletProviderId;
  suppressExtraLogs?: boolean;
};

export type WalletKeystoreImportOptions = {
  json?: boolean;
  out?: string;
  rpcUrl?: string;
  passphrase?: string;
  privateKey?: string;
  chain?: WalletChain;
  walletId?: string;
  force?: boolean;
  name?: string;
  role?: string;
  skipProviderConfig?: boolean;
  providerIdForRegistry?: WalletProviderId;
  suppressExtraLogs?: boolean;
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
  out?: string;
  length?: number;
  force?: boolean;
};

export type WalletKeystorePassphraseRotateOptions = {
  json?: boolean;
  file?: string;
  oldPassphrase?: string;
  newPassphrase?: string;
};

export type WalletKeystoreExportOptions = {
  json?: boolean;
  out?: string;
  includeSecret?: boolean;
  confirmIncludeSecret?: string;
};

export type WalletProviderConfigureOptions = {
  providerId: "turnkey" | "privy" | "alchemy";
  json?: boolean;
  rpcUrl?: string;
  values?: string[];
};

const PRIVATE_KEY_PRINT_CONFIRMATION = "SHOW PRIVATE KEY";
const KEYSTORE_EXPORT_CONFIRMATION = "EXPORT KEYSTORE";

function normalizeDangerousConfirmation(value: string | undefined): string {
  return String(value ?? "").trim();
}

function requirePrivateKeyPrintConfirmation(value: string | undefined): void {
  if (normalizeDangerousConfirmation(value) !== PRIVATE_KEY_PRINT_CONFIRMATION) {
    throw new Error(
      `Printing a private key requires explicit confirmation. Re-run with confirmation text "${PRIVATE_KEY_PRINT_CONFIRMATION}".`,
    );
  }
}

function requireKeystoreSecretExportConfirmation(value: string | undefined): void {
  if (normalizeDangerousConfirmation(value) !== KEYSTORE_EXPORT_CONFIRMATION) {
    throw new Error(
      `Including encrypted keystore material requires explicit confirmation. Re-run with confirmation text "${KEYSTORE_EXPORT_CONFIRMATION}".`,
    );
  }
}

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

export type WalletSignerBrokerOptions = {
  socketPath?: string;
  backendSocketPath?: string;
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

export function resolveLegacyLocalSignerEmbeddedScope(params: {
  cfg: FasedAgentConfig;
  env: NodeJS.ProcessEnv;
  chain: WalletChain;
  walletId?: string;
}) {
  const effectiveEnv = { ...params.env, ...params.cfg.env?.vars };
  const walletId = params.walletId?.trim() || undefined;
  const keystorePath = resolveEmbeddedKeystorePathForChain(
    effectiveEnv,
    params.chain,
    undefined,
    walletId,
  );
  const rpcUrl = resolveRpcUrlForChain(effectiveEnv, params.chain, walletId);
  return { effectiveEnv, keystorePath, rpcUrl };
}

export function createLegacyLocalSignerEmbeddedAdapter(params: {
  cfg: FasedAgentConfig;
  env: NodeJS.ProcessEnv;
  chain: WalletChain;
  walletId?: string;
}) {
  const { effectiveEnv, keystorePath, rpcUrl } = resolveLegacyLocalSignerEmbeddedScope(params);
  const scopedEnv = {
    ...effectiveEnv,
    FASED_WALLET_KEYSTORE_PATH: keystorePath,
    FASED_WALLET_EMBEDDED_KEYSTORE_RPC_URL: rpcUrl,
    FASED_WALLET_RPC_URL: rpcUrl,
  };
  const scopedCfg: FasedAgentConfig = {
    ...params.cfg,
    wallet: {
      ...params.cfg.wallet,
      keystore: {
        ...params.cfg.wallet?.keystore,
        path: keystorePath,
      },
    },
  };
  return createWalletProviderAdapter({
    cfg: scopedCfg,
    wallet: {
      ...resolveWalletConfigForRuntime(scopedCfg, scopedEnv),
      chains: [params.chain],
    },
    env: scopedEnv,
    providerIdOverride: "embedded-keystore",
  });
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
};

function parseWalletProviderId(input: string | undefined) {
  switch ((input ?? "").trim()) {
    case "embedded-keystore":
    case "local-socket-signer":
    case "alchemy":
    case "turnkey":
    case "privy":
      return input as "embedded-keystore" | "local-socket-signer" | "alchemy" | "turnkey" | "privy";
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
    `${command} is no longer supported. Use \`fased wallet keystore ...\` or hosted providers (turnkey/privy/alchemy).`,
  );
}

function resolveEmbeddedKeystorePath(env: NodeJS.ProcessEnv, explicit?: string): string {
  const custom = explicit?.trim() || String(env.FASED_WALLET_KEYSTORE_PATH ?? "").trim();
  if (custom) {
    return path.resolve(custom);
  }
  const paths = ensureWalletStateDir(env);
  return path.join(paths.rootDir, "keystore.v1.enc");
}

function normalizeWalletIdForFilename(walletId?: string): string | undefined {
  const raw = String(walletId ?? "")
    .trim()
    .toLowerCase();
  if (!raw) {
    return undefined;
  }
  return raw.replace(/[^a-z0-9_-]+/g, "-");
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
const JUPITER_TRIGGER_API_BASE_URL_ENV = "FASED_JUPITER_TRIGGER_API_BASE_URL";

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
    throw new Error(
      "Use either --enable or --disable for Jupiter wallet-action support, not both.",
    );
  }
  const env = process.env;
  let cfg = loadConfig();
  if (options.disable) {
    cfg = setConfigEnvVar(cfg, JUPITER_API_KEY_ENV, undefined);
    cfg = setConfigEnvVar(cfg, JUPITER_TRIGGER_API_BASE_URL_ENV, undefined);
    await writeConfigFile(cfg, { envSnapshotForRestore: process.env });
    delete env[JUPITER_API_KEY_ENV];
    delete env[JUPITER_TRIGGER_API_BASE_URL_ENV];
    if (options.json) {
      runtime.log(JSON.stringify({ ok: true, enabled: false }, null, 2));
    } else {
      runtime.log(
        "Jupiter wallet-action support disabled. Other approved wallet actions can still use the normal wallet flow.",
      );
    }
    return;
  }

  const existingKey = resolveConfiguredJupiterApiKey(cfg, env);
  const existingBaseUrl = String(
    env[JUPITER_TRIGGER_API_BASE_URL_ENV] ??
      cfg.env?.vars?.[JUPITER_TRIGGER_API_BASE_URL_ENV] ??
      "",
  ).trim();
  let shouldEnable =
    options.enable === true ||
    Boolean(options.jupiterApiKey?.trim()) ||
    Boolean(options.jupiterTriggerApiBaseUrl?.trim());
  if (!shouldEnable && !options.nonInteractive) {
    const answer = await promptCliText(
      "Enable Jupiter support for policy-gated Agent wallet actions? [y/N]",
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
          ? "Jupiter wallet-action support already configured."
          : "Jupiter wallet-action support not configured.",
      );
    }
    return;
  }

  let apiKey = String(options.jupiterApiKey ?? "").trim() || existingKey;
  if (!apiKey && !options.nonInteractive) {
    apiKey = await promptCliSecret("Jupiter API key");
  }
  if (!apiKey) {
    throw new Error(
      "Jupiter wallet-action support requires a Jupiter API key. Pass --jupiter-api-key or set FASED_JUPITER_API_KEY.",
    );
  }

  const triggerApiBaseUrl =
    String(options.jupiterTriggerApiBaseUrl ?? "").trim() || existingBaseUrl;
  cfg = setConfigEnvVar(cfg, JUPITER_API_KEY_ENV, apiKey);
  if (triggerApiBaseUrl) {
    cfg = setConfigEnvVar(cfg, JUPITER_TRIGGER_API_BASE_URL_ENV, triggerApiBaseUrl);
    env[JUPITER_TRIGGER_API_BASE_URL_ENV] = triggerApiBaseUrl;
  }
  await writeConfigFile(cfg, { envSnapshotForRestore: process.env });
  env[JUPITER_API_KEY_ENV] = apiKey;

  if (options.json) {
    runtime.log(
      JSON.stringify(
        {
          ok: true,
          enabled: true,
          jupiterApiKeyConfigured: true,
          triggerApiBaseUrl: triggerApiBaseUrl || undefined,
        },
        null,
        2,
      ),
    );
    return;
  }
  runtime.log("Jupiter wallet-action support enabled for Agent wallet actions.");
  runtime.log(`Stored ${JUPITER_API_KEY_ENV} in local config env vars.`);
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

function collectLocalSignerExportEnv(
  cfg: FasedAgentConfig,
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  const effectiveEnv = { ...env, ...cfg.env?.vars };
  const exportablePrefixes = [
    "FASED_WALLET_SOLANA_KEYSTORE_PATH",
    "FASED_WALLET_SOLANA_RPC_URL",
    "FASED_WALLET_RPC_URL",
    "FASED_WALLET_EMBEDDED_KEYSTORE_RPC_URL",
  ];
  const out: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(effectiveEnv)) {
    if (!exportablePrefixes.some((prefix) => key === prefix || key.startsWith(`${prefix}__`))) {
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

function keystoreEnvKeyFor(chain: WalletChain, walletId?: string): string {
  void chain;
  const suffix = walletIdEnvSuffix(walletId);
  if (suffix) {
    return `FASED_WALLET_SOLANA_KEYSTORE_PATH__${suffix}`;
  }
  return "FASED_WALLET_SOLANA_KEYSTORE_PATH";
}

function rpcEnvKeyFor(chain: WalletChain, walletId?: string): string {
  void chain;
  const suffix = walletIdEnvSuffix(walletId);
  if (suffix) {
    return `FASED_WALLET_SOLANA_RPC_URL__${suffix}`;
  }
  return "FASED_WALLET_SOLANA_RPC_URL";
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
  return scopedOrChain || String(env.FASED_WALLET_EMBEDDED_KEYSTORE_RPC_URL ?? "").trim();
}

function defaultKeystoreFilenameFor(chain: WalletChain, walletId?: string): string {
  void chain;
  const normalized = normalizeWalletIdForFilename(walletId);
  if (!normalized || normalized === "default") {
    return "keystore-solana.v1.enc";
  }
  return `keystore-solana-${normalized}.v1.enc`;
}

function resolveEmbeddedKeystorePathForChain(
  env: NodeJS.ProcessEnv,
  chain: WalletChain,
  explicit?: string,
  walletId?: string,
): string {
  const explicitPath = explicit?.trim();
  if (explicitPath) {
    return path.resolve(explicitPath);
  }
  const suffix = walletIdEnvSuffix(walletId);
  const perChainEnvKey = "FASED_WALLET_SOLANA_KEYSTORE_PATH";
  const perWalletEnvKey = suffix ? `FASED_WALLET_SOLANA_KEYSTORE_PATH__${suffix}` : undefined;
  const scopedPath = perWalletEnvKey ? String(env[perWalletEnvKey] ?? "").trim() : "";
  if (scopedPath) {
    return path.resolve(scopedPath);
  }
  const normalizedWalletId = normalizeWalletIdForFilename(walletId);
  if (normalizedWalletId && normalizedWalletId !== "default") {
    return path.join(
      resolveLocalSignerMaterialRootDir(env),
      defaultKeystoreFilenameFor(chain, walletId),
    );
  }
  const genericPath =
    String(env[perChainEnvKey] ?? "").trim() || String(env.FASED_WALLET_KEYSTORE_PATH ?? "").trim();
  if (genericPath) {
    return path.resolve(genericPath);
  }
  return path.join(
    resolveLocalSignerMaterialRootDir(env),
    defaultKeystoreFilenameFor(chain, walletId),
  );
}

type SolanaKeystoreEnvelopeV1 = {
  kind: "fased-solana-keypair";
  version: 1;
  kdf: "scrypt";
  cipher: "aes-256-gcm";
  salt: string;
  iv: string;
  authTag: string;
  ciphertext: string;
  publicKey: string;
};

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ED25519_PKCS8_SEED_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function decodeBase58(input: string): Uint8Array {
  const text = input.trim();
  if (!text) {
    return new Uint8Array();
  }
  let num = 0n;
  for (const ch of text) {
    const idx = BASE58_ALPHABET.indexOf(ch);
    if (idx < 0) {
      throw new Error(`invalid base58 character: ${ch}`);
    }
    num = num * 58n + BigInt(idx);
  }
  const bytes: number[] = [];
  while (num > 0n) {
    bytes.push(Number(num % 256n));
    num /= 256n;
  }
  bytes.reverse();
  let leadingZeros = 0;
  for (const ch of text) {
    if (ch === "1") {
      leadingZeros += 1;
    } else {
      break;
    }
  }
  return Uint8Array.from([...Array.from({ length: leadingZeros }, () => 0), ...bytes]);
}

function encodeBase58(input: Uint8Array): string {
  if (input.length === 0) {
    return "";
  }
  let num = 0n;
  for (const b of input) {
    num = (num << 8n) + BigInt(b);
  }
  let encoded = "";
  while (num > 0n) {
    const idx = Number(num % 58n);
    encoded = BASE58_ALPHABET[idx] + encoded;
    num /= 58n;
  }
  let leadingZeros = 0;
  for (const b of input) {
    if (b === 0) {
      leadingZeros += 1;
    } else {
      break;
    }
  }
  return `${"1".repeat(leadingZeros)}${encoded}`;
}

function deriveEd25519PublicKeyFromSeed(seed: Uint8Array): Uint8Array {
  if (seed.length !== 32) {
    throw new Error(`invalid Ed25519 seed length: ${seed.length} (expected 32)`);
  }
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_SEED_PREFIX, Buffer.from(seed)]),
    format: "der",
    type: "pkcs8",
  });
  const spki = Buffer.from(createPublicKey(privateKey).export({ format: "der", type: "spki" }));
  if (
    spki.length !== ED25519_SPKI_PREFIX.length + 32 ||
    !spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    throw new Error("failed to derive Ed25519 public key");
  }
  return Uint8Array.from(spki.subarray(ED25519_SPKI_PREFIX.length));
}

function normalizeSolanaSecretKey(secret: Uint8Array): Uint8Array {
  if (secret.length === 64) {
    return secret;
  }
  if (secret.length === 32) {
    const publicKey = deriveEd25519PublicKeyFromSeed(secret);
    return Uint8Array.from([...secret, ...publicKey]);
  }
  throw new Error(`invalid Solana secret key length: ${secret.length} (expected 32 or 64)`);
}

function solanaAddressFromSecretKey(secretKey: Uint8Array): string {
  if (secretKey.length !== 64) {
    throw new Error(`invalid Solana secret key length: ${secretKey.length} (expected 64)`);
  }
  return encodeBase58(secretKey.slice(32));
}

async function callRpcMethod(
  rpcUrl: string,
  method: string,
  params: unknown[],
): Promise<Record<string, unknown>> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `${method}-${Date.now()}`,
      method,
      params,
    }),
  });
  if (!response.ok) {
    throw new Error(`rpc ${method} http ${response.status}`);
  }
  const payload = (await response.json()) as {
    result?: Record<string, unknown>;
    error?: { message?: string };
  };
  if (payload.error) {
    throw new Error(payload.error.message || `rpc ${method} error`);
  }
  if (!payload.result || typeof payload.result !== "object") {
    throw new Error(`rpc ${method} missing result`);
  }
  return payload.result;
}

function parseSolanaSecretKey(raw: string): Uint8Array {
  const text = raw.trim();
  if (!text) {
    throw new Error("missing Solana private key");
  }
  if (text.startsWith("[")) {
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error("invalid Solana key JSON");
    }
    const bytes = Uint8Array.from(
      parsed.map((v) => {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 0 || n > 255) {
          throw new Error("invalid Solana secret key byte");
        }
        return n;
      }),
    );
    return normalizeSolanaSecretKey(bytes);
  }
  const normalized = text.replace(/^0x/i, "");
  if (/^[0-9a-fA-F]+$/.test(normalized) && normalized.length % 2 === 0) {
    const bytes = Uint8Array.from(Buffer.from(normalized, "hex"));
    if (bytes.length === 32 || bytes.length === 64) {
      return normalizeSolanaSecretKey(bytes);
    }
  }
  try {
    const bytes = Uint8Array.from(Buffer.from(text, "base64"));
    if (bytes.length === 32 || bytes.length === 64) {
      return normalizeSolanaSecretKey(bytes);
    }
  } catch {}
  try {
    const bytes = Uint8Array.from(Buffer.from(text, "base64url"));
    if (bytes.length === 32 || bytes.length === 64) {
      return normalizeSolanaSecretKey(bytes);
    }
  } catch {}
  try {
    const bytes = decodeBase58(text);
    if (bytes.length === 64) {
      return normalizeSolanaSecretKey(bytes);
    }
  } catch {}
  throw new Error(
    "Unsupported Solana secret key format. Use JSON byte array [32/64 bytes], base64/base64url, base58 (64-byte secret), or hex.",
  );
}

function encryptSolanaKeypairEnvelope(params: {
  secretKey: Uint8Array;
  passphrase: string;
  publicKey: string;
}): SolanaKeystoreEnvelopeV1 {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(params.passphrase, salt, 32);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(params.secretKey)), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    kind: "fased-solana-keypair",
    version: 1,
    kdf: "scrypt",
    cipher: "aes-256-gcm",
    salt: salt.toString("base64url"),
    iv: iv.toString("base64url"),
    authTag: authTag.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    publicKey: params.publicKey,
  };
}

function parseSolanaKeystoreEnvelope(raw: string): SolanaKeystoreEnvelopeV1 | null {
  try {
    const parsed = JSON.parse(raw) as Partial<SolanaKeystoreEnvelopeV1>;
    if (
      parsed.kind !== "fased-solana-keypair" ||
      parsed.version !== 1 ||
      parsed.kdf !== "scrypt" ||
      parsed.cipher !== "aes-256-gcm"
    ) {
      return null;
    }
    if (
      typeof parsed.salt !== "string" ||
      typeof parsed.iv !== "string" ||
      typeof parsed.authTag !== "string" ||
      typeof parsed.ciphertext !== "string" ||
      typeof parsed.publicKey !== "string"
    ) {
      return null;
    }
    return parsed as SolanaKeystoreEnvelopeV1;
  } catch {
    return null;
  }
}

function decryptSolanaKeypairEnvelope(
  envelope: SolanaKeystoreEnvelopeV1,
  passphrase: string,
): Uint8Array {
  const salt = Buffer.from(envelope.salt, "base64url");
  const iv = Buffer.from(envelope.iv, "base64url");
  const authTag = Buffer.from(envelope.authTag, "base64url");
  const ciphertext = Buffer.from(envelope.ciphertext, "base64url");
  const key = scryptSync(passphrase, salt, 32);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  if (plaintext.length !== 64) {
    throw new Error(`invalid decrypted Solana secret key length: ${plaintext.length}`);
  }
  return Uint8Array.from(plaintext);
}

function detectEmbeddedKeystoreType(raw: string): "solana-envelope" | "unknown" {
  if (parseSolanaKeystoreEnvelope(raw)) {
    return "solana-envelope";
  }
  return "unknown";
}

function resolveKeystorePassphrase(
  optionsPassphrase: string | undefined,
  env: NodeJS.ProcessEnv,
): string {
  if (optionsPassphrase?.trim()) {
    return optionsPassphrase.trim();
  }
  const file = String(env.FASED_WALLET_PASSPHRASE_FILE ?? "").trim();
  if (file && fs.existsSync(file)) {
    return fs.readFileSync(file, "utf8").trim();
  }
  const managedFile = path.join(resolveLocalSignerMaterialRootDir(env), "passphrase");
  if (fs.existsSync(managedFile)) {
    return fs.readFileSync(managedFile, "utf8").trim();
  }
  return String(env.FASED_WALLET_PASSPHRASE ?? "").trim();
}

function resolvePassphraseFilePath(env: NodeJS.ProcessEnv, explicit?: string): string {
  const provided = explicit?.trim() || String(env.FASED_WALLET_PASSPHRASE_FILE ?? "").trim();
  if (provided) {
    return path.resolve(provided);
  }
  return path.join(resolveLocalSignerMaterialRootDir(env), "passphrase");
}

function resolveLocalSignerPassphraseSource(
  env: NodeJS.ProcessEnv,
):
  | { kind: "file"; path: string; value: string }
  | { kind: "value"; value: string }
  | { kind: "none" } {
  const configuredFile = String(env.FASED_WALLET_PASSPHRASE_FILE ?? "").trim();
  const candidates = [
    configuredFile ? path.resolve(configuredFile) : "",
    path.join(resolveLocalSignerMaterialRootDir(env), "passphrase"),
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

function renderLocalSignerPassphraseEnvLines(env: NodeJS.ProcessEnv): string[] {
  if (String(env.FASED_WALLET_LOCAL_SIGNER_RUN_AS_USER ?? "").trim()) {
    const file =
      String(env.FASED_WALLET_PASSPHRASE_FILE ?? "").trim() ||
      path.join(resolveLocalSignerMaterialRootDir(env), "passphrase");
    return [`export FASED_WALLET_PASSPHRASE_FILE="${file.replaceAll('"', '\\"')}"`];
  }
  const source = resolveLocalSignerPassphraseSource(env);
  if (source.kind === "file") {
    return [`export FASED_WALLET_PASSPHRASE_FILE="${source.path.replaceAll('"', '\\"')}"`];
  }
  if (source.kind === "value") {
    return [`export FASED_WALLET_PASSPHRASE="${source.value.replaceAll('"', '\\"')}"`];
  }
  return [];
}

function ensureLocalSignerPassphraseForSetup(runtime: RuntimeEnv, env: NodeJS.ProcessEnv): string {
  const existing = resolveLocalSignerPassphraseSource(env);
  if (existing.kind === "file") {
    env.FASED_WALLET_PASSPHRASE_FILE = existing.path;
    delete env.FASED_WALLET_PASSPHRASE;
    return existing.value;
  }
  if (existing.kind === "value") {
    env.FASED_WALLET_PASSPHRASE = existing.value;
    delete env.FASED_WALLET_PASSPHRASE_FILE;
    return existing.value;
  }
  const generated = randomBytes(24).toString("base64url");
  const passphraseFile = path.join(resolveLocalSignerMaterialRootDir(env), "passphrase");
  writePassphraseFile(passphraseFile, generated);
  env.FASED_WALLET_PASSPHRASE_FILE = passphraseFile;
  delete env.FASED_WALLET_PASSPHRASE;
  runtime.log("No wallet passphrase configured. Creating a managed signer passphrase file (0600).");
  return generated;
}

function ensureLocalSignerPassphraseFileForCustodyDisable(params: {
  cfg: FasedAgentConfig;
  env: NodeJS.ProcessEnv;
}): { passphrase: string; passphraseFile: string; cfg: FasedAgentConfig } {
  const effectiveEnv = { ...params.env, ...params.cfg.env?.vars } as NodeJS.ProcessEnv;
  const existing = resolveLocalSignerPassphraseSource(effectiveEnv);
  let passphrase = "";
  let passphraseFile = "";
  if (existing.kind === "file") {
    passphrase = existing.value;
    passphraseFile = existing.path;
  } else {
    passphrase =
      existing.kind === "value" && existing.value.trim()
        ? existing.value.trim()
        : randomBytes(24).toString("base64url");
    passphraseFile = resolvePassphraseFilePath(effectiveEnv);
    writePassphraseFile(passphraseFile, passphrase);
  }
  let nextCfg = setConfigEnvVar(params.cfg, "FASED_WALLET_PASSPHRASE_FILE", passphraseFile);
  nextCfg = setConfigEnvVar(nextCfg, "FASED_WALLET_PASSPHRASE", undefined);
  return { passphrase, passphraseFile, cfg: nextCfg };
}

function writePassphraseFile(filePath: string, passphrase: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${passphrase}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {}
}

type LocalSignerKeystoreTarget = {
  chain: WalletChain;
  walletId?: string;
  path: string;
  label: string;
};

function walletIdsMatchForEnvSuffix(left: string | undefined, right: string | undefined): boolean {
  const normalizedLeft = (left?.trim() || "default").toLowerCase();
  const normalizedRight = (right?.trim() || "default").toLowerCase();
  return (
    normalizedLeft === normalizedRight ||
    normalizeWalletIdForEnvSuffix(normalizedLeft) === normalizeWalletIdForEnvSuffix(normalizedRight)
  );
}

function normalizeCustodyWalletId(walletId?: string): string {
  return normalizeWalletIdForEnvSuffix(walletId?.trim() || "default") || "default";
}

function parseCustodyWalletSet(env: NodeJS.ProcessEnv): Set<string> {
  const out = new Set<string>();
  for (const part of String(env.FASED_WALLET_CUSTODY_WALLETS ?? "").split(",")) {
    if (!part.trim()) {
      continue;
    }
    const normalized = normalizeCustodyWalletId(part);
    if (normalized) {
      out.add(normalized);
    }
  }
  return out;
}

function formatCustodyWalletSet(values: Set<string>): string {
  return [...values].filter(Boolean).toSorted().join(",");
}

function collectLocalSignerKeystoreTargets(
  cfg: FasedAgentConfig,
  env: NodeJS.ProcessEnv,
): LocalSignerKeystoreTarget[] {
  const effectiveEnv = { ...env, ...cfg.env?.vars };
  const targets = new Map<string, LocalSignerKeystoreTarget>();
  const materialRoot = resolveLocalSignerMaterialRootDir(effectiveEnv);

  const addTarget = (chain: WalletChain, rawPath: string | undefined, walletId?: string) => {
    const candidate = rawPath?.trim();
    if (!candidate) {
      return;
    }
    const resolved = path.resolve(candidate);
    if (!fs.existsSync(resolved)) {
      return;
    }
    const existing = targets.get(resolved);
    if (existing) {
      return;
    }
    targets.set(resolved, {
      chain,
      walletId,
      path: resolved,
      label: walletId ? `${chain}.${walletId}` : `${chain}.default`,
    });
  };

  const addDefaultChainTarget = (chain: WalletChain) => {
    addTarget(chain, resolveEmbeddedKeystorePathForChain(effectiveEnv, chain), "default");
  };

  addDefaultChainTarget("solana");

  for (const [key, rawValue] of Object.entries(effectiveEnv)) {
    const value = String(rawValue ?? "").trim();
    if (!value) {
      continue;
    }
    if (key.startsWith("FASED_WALLET_SOLANA_KEYSTORE_PATH__")) {
      addTarget(
        "solana",
        value,
        key.slice("FASED_WALLET_SOLANA_KEYSTORE_PATH__".length).toLowerCase(),
      );
    }
  }

  if (fs.existsSync(materialRoot)) {
    for (const entry of fs.readdirSync(materialRoot, { withFileTypes: true })) {
      if (!entry.isFile()) {
        continue;
      }
      const name = entry.name;
      let chain: WalletChain | null = null;
      let walletId: string | undefined;
      if (/^keystore-solana(?:-(.+))?\.v1\.enc$/i.test(name)) {
        chain = "solana";
        walletId = /^keystore-solana-(.+)\.v1\.enc$/i.exec(name)?.[1];
      }
      if (!chain) {
        continue;
      }
      addTarget(chain, path.join(materialRoot, name), walletId);
    }
  }

  return [...targets.values()].toSorted((left, right) => left.label.localeCompare(right.label));
}

async function reencryptLocalSignerKeystore(params: {
  target: LocalSignerKeystoreTarget;
  oldPassphrase: string;
  newPassphrase: string;
}) {
  const raw = fs.readFileSync(params.target.path, "utf8");
  const detected = detectEmbeddedKeystoreType(raw);
  if (detected === "solana-envelope") {
    const envelope = parseSolanaKeystoreEnvelope(raw);
    if (!envelope) {
      throw new Error(`invalid Solana keystore envelope: ${params.target.path}`);
    }
    const secretKey = decryptSolanaKeypairEnvelope(envelope, params.oldPassphrase);
    const nextEnvelope = encryptSolanaKeypairEnvelope({
      secretKey,
      passphrase: params.newPassphrase,
      publicKey: envelope.publicKey,
    });
    fs.writeFileSync(params.target.path, `${JSON.stringify(nextEnvelope, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    return;
  }
  throw new Error(`unsupported keystore format for ${params.target.path}`);
}

function clearConfiguredSignerPassphrase(cfg: FasedAgentConfig): FasedAgentConfig {
  let nextCfg = setConfigEnvVar(cfg, "FASED_WALLET_PASSPHRASE", undefined);
  nextCfg = setConfigEnvVar(nextCfg, "FASED_WALLET_PASSPHRASE_FILE", undefined);
  return nextCfg;
}

function removeLocalSignerPassphraseFileIfManaged(env: NodeJS.ProcessEnv): {
  removed: boolean;
  path?: string;
} {
  const configured = String(env.FASED_WALLET_PASSPHRASE_FILE ?? "").trim();
  if (!configured) {
    return { removed: false };
  }
  const resolved = path.resolve(configured);
  const materialRoot = resolveLocalSignerMaterialRootDir(env);
  const withinMaterialRoot =
    resolved === materialRoot || resolved.startsWith(`${materialRoot}${path.sep}`);
  if (!withinMaterialRoot || !fs.existsSync(resolved)) {
    return { removed: false, path: resolved };
  }
  fs.rmSync(resolved, { force: true });
  return { removed: true, path: resolved };
}

function writeLocalSignerEnvFile(cfg: FasedAgentConfig, env: NodeJS.ProcessEnv) {
  const effectiveEnv = { ...env, ...cfg.env?.vars };
  const socketPath = resolveLocalSignerSocketPath(effectiveEnv);
  const backendSocketPath = resolveLocalSignerBackendSocketPath(effectiveEnv);
  const materialRoot = resolveLocalSignerMaterialRootDir(effectiveEnv);
  const signerBinPath = resolveSignerdBinaryPath(effectiveEnv);
  const signerEnvPath = path.resolve(ensureWalletStateDir(env).rootDir, "signer.env");
  const custodyKeys = [
    "FASED_WALLET_CUSTODY_MODE",
    "FASED_WALLET_CUSTODY_WALLETS",
    "FASED_WALLET_CUSTODY_PASSKEY_CEREMONY",
    "FASED_WALLET_CUSTODY_EPHEMERAL_RECONSTRUCTION",
    "FASED_WALLET_CUSTODY_PHASE2_COMPLETE",
  ] as const;
  const custodyEnvLines = custodyKeys
    .map((key) => [key, String(effectiveEnv[key] ?? "").trim()] as const)
    .filter(([, value]) => Boolean(value))
    .map(([key, value]) => `export ${key}="${value}"`);
  const signerEnvLines = [
    `export FASED_WALLET_LOCAL_SIGNER_SOCKET="${socketPath}"`,
    ...(backendSocketPath !== socketPath
      ? [`export FASED_WALLET_LOCAL_SIGNER_BACKEND_SOCKET="${backendSocketPath}"`]
      : []),
    ...(materialRoot !== ensureWalletStateDir(env).rootDir
      ? [`export FASED_WALLET_SIGNER_STATE_DIR="${materialRoot}"`]
      : []),
    `export FASED_WALLET_CHAINS="${resolveLocalSignerChainsEnvValue(cfg, effectiveEnv)}"`,
    ...renderLocalSignerPassphraseEnvLines(effectiveEnv),
    ...Object.entries({
      ...collectLocalSignerExportEnv(cfg, effectiveEnv),
      ...collectLocalSignerPolicyExportEnv(cfg, effectiveEnv),
    })
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `export ${key}="${value.replaceAll('"', '\\"')}"`),
    ...custodyEnvLines,
    "",
    `"${signerBinPath}" --socket "\${FASED_WALLET_LOCAL_SIGNER_BACKEND_SOCKET:-$FASED_WALLET_LOCAL_SIGNER_SOCKET}"`,
  ];
  fs.mkdirSync(path.dirname(signerEnvPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(signerEnvPath, `${signerEnvLines.join("\n")}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function ensureEmbeddedProviderConfig(
  cfg: FasedAgentConfig,
  params: { keystorePath: string; rpcUrl?: string; chain?: WalletChain; walletId?: string },
): FasedAgentConfig {
  let nextCfg = ensureWalletMaterialConfig(cfg, params);
  const chain = params.chain ?? "solana";
  const nextChains = new Set<WalletChain>(nextCfg.wallet?.keystore?.chainSupport ?? []);
  nextChains.add(chain);
  nextCfg = {
    ...nextCfg,
    wallet: {
      ...nextCfg.wallet,
      provider: {
        ...nextCfg.wallet?.provider,
        id: "embedded-keystore",
      },
      keystore: {
        ...nextCfg.wallet?.keystore,
        enabled: true,
        path: params.keystorePath,
        chainSupport: nextChains.size > 0 ? [...nextChains] : ["solana"],
      },
      runtime: {
        ...cfg.wallet?.runtime,
        enabled: false,
      },
    },
  };
  return nextCfg;
}

function ensureWalletMaterialConfig(
  cfg: FasedAgentConfig,
  params: { keystorePath: string; rpcUrl?: string; chain?: WalletChain; walletId?: string },
): FasedAgentConfig {
  const chain = params.chain ?? "solana";
  let nextCfg = setConfigEnvVar(
    cfg,
    keystoreEnvKeyFor(chain, params.walletId),
    params.keystorePath,
  );
  if (params.rpcUrl?.trim()) {
    nextCfg = setConfigEnvVar(nextCfg, rpcEnvKeyFor(chain, params.walletId), params.rpcUrl);
  }
  return nextCfg;
}

function ensureLocalSignerProviderConfig(
  cfg: FasedAgentConfig,
  env: NodeJS.ProcessEnv,
  socketPath?: string,
): FasedAgentConfig {
  const effectiveSocketPath = socketPath?.trim() || resolveLocalSignerSocketPath(env);
  let nextCfg = setConfigEnvVar(cfg, "FASED_WALLET_LOCAL_SIGNER_SOCKET", effectiveSocketPath);
  const backendSocketPath = resolveLocalSignerBackendSocketPath(env);
  if (backendSocketPath !== effectiveSocketPath) {
    nextCfg = setConfigEnvVar(
      nextCfg,
      "FASED_WALLET_LOCAL_SIGNER_BACKEND_SOCKET",
      backendSocketPath,
    );
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
  const backendSocketPath = resolveLocalSignerBackendSocketPath(env);
  const nextCfg = ensureLocalSignerProviderConfig(cfg, env, socketPath);
  if (!options.noProviderIdUpdate) {
    await writeConfigFile(nextCfg);
  }
  if (options.noSignerHints) {
    return;
  }
  runtime.log("Signer mode: local native signer");
  runtime.log(`Signer socket: ${socketPath}`);
  const signerEnvPath = path.resolve(ensureWalletStateDir(process.env).rootDir, "signer.env");
  const materialRoot = resolveLocalSignerMaterialRootDir(env);
  const effectiveEnv = { ...env, ...nextCfg.env?.vars };
  const signerBinPath = resolveSignerdBinaryPath(effectiveEnv);
  const signerEnvLines = [
    `export FASED_WALLET_LOCAL_SIGNER_SOCKET="${socketPath}"`,
    ...(backendSocketPath !== socketPath
      ? [`export FASED_WALLET_LOCAL_SIGNER_BACKEND_SOCKET="${backendSocketPath}"`]
      : []),
    ...(materialRoot !== ensureWalletStateDir(env).rootDir
      ? [`export FASED_WALLET_SIGNER_STATE_DIR="${materialRoot}"`]
      : []),
    `export FASED_WALLET_CHAINS="${resolveLocalSignerChainsEnvValue(nextCfg, env)}"`,
    ...renderLocalSignerPassphraseEnvLines(effectiveEnv),
    ...Object.entries({
      ...collectLocalSignerExportEnv(nextCfg, env),
      ...collectLocalSignerPolicyExportEnv(nextCfg, env),
    })
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `export ${key}="${value.replaceAll('"', '\\"')}"`),
    "",
    `"${signerBinPath}" --socket "\${FASED_WALLET_LOCAL_SIGNER_BACKEND_SOCKET:-$FASED_WALLET_LOCAL_SIGNER_SOCKET}"`,
  ];
  fs.mkdirSync(path.dirname(signerEnvPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(signerEnvPath, `${signerEnvLines.join("\n")}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  runtime.log("Recommended environment exports (set before starting fased-signerd):");
  for (const line of signerEnvLines.slice(0, Math.min(8, signerEnvLines.length - 2))) {
    runtime.log(`  ${line}`);
  }
  runtime.log(`Env file written: ${signerEnvPath} (mode 600)`);
  runtime.log(`  source "${signerEnvPath}"`);
  runtime.log("");
  runtime.log("Start signer:");
  runtime.log(`  "${signerBinPath}" --socket "$FASED_WALLET_LOCAL_SIGNER_SOCKET"`);
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

export async function walletSetupCommand(
  runtime: RuntimeEnv = defaultRuntime,
  options: WalletSetupOptions = {},
) {
  const env = process.env;
  const interactive = !options.nonInteractive;
  if (options.role && !normalizeWalletRoleForCli(options.role)) {
    throw new Error(
      "wallet role must be agent or vault. Use the Mining page/command for SAT mining.",
    );
  }

  const configureLimitOrdersIfRequested = async () => {
    if (
      !options.enableLimitOrders &&
      !options.disableLimitOrders &&
      !options.jupiterApiKey &&
      !options.jupiterTriggerApiBaseUrl
    ) {
      return;
    }
    await walletLimitOrdersConfigureCommand(runtime, {
      enable: Boolean(options.enableLimitOrders || options.jupiterApiKey),
      disable: Boolean(options.disableLimitOrders),
      jupiterApiKey: options.jupiterApiKey,
      jupiterTriggerApiBaseUrl: options.jupiterTriggerApiBaseUrl,
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
    runtime.log("  embedded-create  Create a new self-hosted wallet (default)");
    runtime.log("  embedded-import  Import an existing Solana key (advanced)");
    runtime.log("  turnkey          Configure hosted provider (Turnkey)");
    runtime.log("  alchemy          Configure hosted provider (Alchemy)");
    runtime.log("  privy            Configure hosted provider (Privy)");
    const picked = await prompt("Choose wallet setup mode", "embedded-create");
    mode =
      picked === "embedded" ||
      picked === "embedded-create" ||
      picked === "embedded-import" ||
      picked === "local-signer-create" ||
      picked === "local-signer-import" ||
      picked === "local-signer" ||
      picked === "turnkey" ||
      picked === "alchemy" ||
      picked === "privy"
        ? picked
        : "embedded-create";
  }

  if (mode === "embedded") {
    mode = "embedded-create";
  }
  if (
    mode !== "embedded-create" &&
    mode !== "embedded-import" &&
    mode !== "local-signer-create" &&
    mode !== "local-signer-import" &&
    mode !== "local-signer" &&
    mode !== "turnkey" &&
    mode !== "alchemy" &&
    mode !== "privy"
  ) {
    throw new Error(
      `Unsupported wallet setup mode: ${String(mode)}. ` +
        "Use one of: embedded-create, embedded-import, local-signer-create, local-signer-import, local-signer, turnkey, alchemy, privy.",
    );
  }

  if (mode === "embedded-create") {
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
    const showPrivateKeyOnce =
      typeof options.showPrivateKeyOnce === "boolean"
        ? options.showPrivateKeyOnce
        : !options.nonInteractive &&
          (
            await prompt(
              "Show private key once for backup now? (dangerous, shoulder-surf risk) [y/N]",
              "n",
            )
          )
            .trim()
            .toLowerCase()
            .startsWith("y");
    if (showPrivateKeyOnce && typeof options.showPrivateKeyOnce === "boolean") {
      requirePrivateKeyPrintConfirmation(options.confirmPrivateKeyPrint);
    }
    const privateKeyPrintConfirmation = showPrivateKeyOnce
      ? (options.confirmPrivateKeyPrint ??
        (typeof options.showPrivateKeyOnce === "boolean"
          ? undefined
          : PRIVATE_KEY_PRINT_CONFIRMATION))
      : undefined;

    if (!String(env.FASED_WALLET_PASSPHRASE_FILE ?? env.FASED_WALLET_PASSPHRASE ?? "").trim()) {
      runtime.log("No wallet passphrase configured. Creating a local passphrase file (0600)...");
      await walletKeystorePassphraseInitCommand(runtime, { force: false, json: false });
    }

    await walletKeystoreInitCommand(runtime, {
      chain,
      walletId,
      name: options.walletName,
      rpcUrl,
      showPrivateKeyOnce,
      confirmPrivateKeyPrint: privateKeyPrintConfirmation,
      force: Boolean(options.force),
      json: Boolean(options.json),
      role: options.role,
    });
    if (!options.noSignerHints) {
      runtime.log("Embedded wallet created.");
    }
    await configureLimitOrdersIfRequested();
    return;
  }

  if (mode === "embedded-import") {
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
    const privateKey =
      options.privateKey ?? (await prompt("Paste Solana private key (base58/json/base64/hex)"));
    if (!privateKey) {
      throw new Error(
        "Import mode requires a private key. " +
          "Pass --private-key (and optional --wallet-id) or set FASED_WALLET_PRIVATE_KEY for non-interactive runs.",
      );
    }
    if (!String(env.FASED_WALLET_PASSPHRASE_FILE ?? env.FASED_WALLET_PASSPHRASE ?? "").trim()) {
      runtime.log("No wallet passphrase configured. Creating a local passphrase file (0600)...");
      await walletKeystorePassphraseInitCommand(runtime, { force: false, json: false });
    }
    await walletKeystoreImportCommand(runtime, {
      chain,
      walletId,
      name: options.walletName,
      privateKey,
      rpcUrl,
      json: Boolean(options.json),
      role: options.role,
    });
    if (!options.noSignerHints) {
      runtime.log("Embedded wallet imported.");
    }
    await configureLimitOrdersIfRequested();
    return;
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
    const showPrivateKeyOnce =
      typeof options.showPrivateKeyOnce === "boolean"
        ? options.showPrivateKeyOnce
        : !options.nonInteractive &&
          (
            await prompt(
              "Show private key once for backup now? (dangerous, shoulder-surf risk) [y/N]",
              "n",
            )
          )
            .trim()
            .toLowerCase()
            .startsWith("y");
    if (showPrivateKeyOnce && typeof options.showPrivateKeyOnce === "boolean") {
      requirePrivateKeyPrintConfirmation(options.confirmPrivateKeyPrint);
    }
    const privateKeyPrintConfirmation = showPrivateKeyOnce
      ? (options.confirmPrivateKeyPrint ??
        (typeof options.showPrivateKeyOnce === "boolean"
          ? undefined
          : PRIVATE_KEY_PRINT_CONFIRMATION))
      : undefined;

    ensureLocalSignerPassphraseForSetup(runtime, env);

    await walletKeystoreInitCommand(runtime, {
      chain,
      walletId,
      name: options.walletName,
      rpcUrl,
      showPrivateKeyOnce,
      confirmPrivateKeyPrint: privateKeyPrintConfirmation,
      force: Boolean(options.force),
      json: Boolean(options.json),
      skipProviderConfig: true,
      providerIdForRegistry: "local-socket-signer",
      suppressExtraLogs: Boolean(options.noSignerHints),
      role: options.role,
    });
    await configureLocalSignerMode(runtime, options, env);
    if (!options.noSignerHints) {
      runtime.log("Self-hosted wallet created for local native signer.");
    }
    await configureLimitOrdersIfRequested();
    return;
  }

  if (mode === "local-signer-import") {
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
    const privateKey =
      options.privateKey ?? (await prompt("Paste Solana private key (base58/json/base64/hex)"));
    if (!privateKey) {
      throw new Error(
        "Import mode requires a private key. " +
          "Pass --private-key (and optional --wallet-id) or set FASED_WALLET_PRIVATE_KEY for non-interactive runs.",
      );
    }
    ensureLocalSignerPassphraseForSetup(runtime, env);
    await walletKeystoreImportCommand(runtime, {
      chain,
      walletId,
      name: options.walletName,
      privateKey,
      rpcUrl,
      json: Boolean(options.json),
      force: Boolean(options.force),
      skipProviderConfig: true,
      providerIdForRegistry: "local-socket-signer",
      suppressExtraLogs: Boolean(options.noSignerHints),
      role: options.role,
    });
    await configureLocalSignerMode(runtime, options, env);
    if (!options.noSignerHints) {
      runtime.log("Self-hosted wallet imported for local native signer.");
    }
    await configureLimitOrdersIfRequested();
    return;
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
        options.privateKey ??
        env[providerId === "alchemy" ? "ALCHEMY_API_KEY" : "PRIVY_API_KEY"] ??
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
) {
  const env = process.env;
  if (options.role && !normalizeWalletRoleForCli(options.role)) {
    throw new Error(
      "wallet role must be agent or vault. Use the Mining page/command for SAT mining.",
    );
  }
  const passphrase = resolveKeystorePassphrase(options.passphrase, env);
  if (!passphrase) {
    throw new Error(
      "Missing keystore passphrase. Set FASED_WALLET_PASSPHRASE(_FILE) or pass --passphrase.",
    );
  }
  if (options.showPrivateKeyOnce) {
    requirePrivateKeyPrintConfirmation(options.confirmPrivateKeyPrint);
  }
  const chain = options.chain ?? "solana";
  const outPath = resolveEmbeddedKeystorePathForChain(env, chain, options.out, options.walletId);
  if (fs.existsSync(outPath) && !options.force) {
    throw new Error(`Keystore already exists: ${outPath}`);
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true, mode: 0o700 });
  let addressOut = "";
  let privateKeyOut = "";
  const seed = randomBytes(32);
  const publicKeyBytes = deriveEd25519PublicKeyFromSeed(seed);
  const secretKey = Uint8Array.from([...seed, ...publicKeyBytes]);
  const publicKey = encodeBase58(publicKeyBytes);
  const envelope = encryptSolanaKeypairEnvelope({
    secretKey,
    passphrase,
    publicKey,
  });
  fs.writeFileSync(outPath, `${JSON.stringify(envelope, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  addressOut = publicKey;
  privateKeyOut = Buffer.from(secretKey).toString("base64");
  try {
    fs.chmodSync(outPath, 0o600);
  } catch {}

  const cfg = options.skipProviderConfig
    ? ensureWalletMaterialConfig(loadConfig(), {
        keystorePath: outPath,
        rpcUrl: options.rpcUrl,
        chain,
        walletId: options.walletId,
      })
    : ensureEmbeddedProviderConfig(loadConfig(), {
        keystorePath: outPath,
        rpcUrl: options.rpcUrl,
        chain,
        walletId: options.walletId,
      });
  await writeConfigFile(cfg);

  if (options.json) {
    const payload: Record<string, unknown> = {
      ok: true,
      provider: options.providerIdForRegistry ?? "embedded-keystore",
      chain,
      keystorePath: outPath,
      address: addressOut,
      warning: "Store the passphrase securely; it is not stored in fased config.",
    };
    if (options.showPrivateKeyOnce) {
      payload.privateKey = privateKeyOut;
      payload.warning =
        "Private key shown once in JSON output; move to offline backup immediately.";
    }
    runtime.log(JSON.stringify(payload, null, 2));
    return;
  }
  runtime.log(`${chain.toUpperCase()} address: ${addressOut}`);
  if (options.showPrivateKeyOnce) {
    runtime.log(`PRIVATE KEY (shown once): ${privateKeyOut}`);
  }
  if (options.skipProviderConfig && !options.suppressExtraLogs) {
    runtime.log(`Self-hosted signer keystore created: ${outPath}`);
  }

  // Register the wallet in the provider registry so it shows up in the UI
  try {
    const role = normalizeWalletRoleForCli(options.role);
    const wallet = upsertNamedWallet({
      walletId: options.walletId?.trim() || undefined,
      name: options.name || "Wallet",
      providerId: options.providerIdForRegistry ?? "embedded-keystore",
      addresses: {
        solana: addressOut,
      },
      metadata: role ? { role, purpose: role } : undefined,
      env,
    });
    if (role === "agent") {
      setDefaultWallet({ walletId: wallet.id, env });
    }
  } catch (err) {
    runtime.log(
      `Warning: failed to register wallet in UI registry: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function walletKeystoreImportCommand(
  runtime: RuntimeEnv = defaultRuntime,
  options: WalletKeystoreImportOptions = {},
) {
  const env = process.env;
  if (options.role && !normalizeWalletRoleForCli(options.role)) {
    throw new Error(
      "wallet role must be agent or vault. Use the Mining page/command for SAT mining.",
    );
  }
  const passphrase = resolveKeystorePassphrase(options.passphrase, env);
  if (!passphrase) {
    throw new Error(
      "Missing keystore passphrase. Set FASED_WALLET_PASSPHRASE(_FILE) or pass --passphrase.",
    );
  }
  const chain = options.chain ?? "solana";
  const privateKey = (options.privateKey ?? String(env.FASED_WALLET_PRIVATE_KEY ?? "")).trim();
  if (!privateKey) {
    throw new Error("Missing private key. Pass --private-key or set FASED_WALLET_PRIVATE_KEY.");
  }
  const outPath = resolveEmbeddedKeystorePathForChain(env, chain, options.out, options.walletId);
  if (fs.existsSync(outPath) && !options.force) {
    throw new Error(`Keystore already exists: ${outPath}`);
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true, mode: 0o700 });
  let addressOut = "";
  const secretKey = parseSolanaSecretKey(privateKey);
  const publicKey = solanaAddressFromSecretKey(secretKey);
  const envelope = encryptSolanaKeypairEnvelope({ secretKey, passphrase, publicKey });
  fs.writeFileSync(outPath, `${JSON.stringify(envelope, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  addressOut = publicKey;
  try {
    fs.chmodSync(outPath, 0o600);
  } catch {}

  const cfg = options.skipProviderConfig
    ? ensureWalletMaterialConfig(loadConfig(), {
        keystorePath: outPath,
        rpcUrl: options.rpcUrl,
        chain,
        walletId: options.walletId,
      })
    : ensureEmbeddedProviderConfig(loadConfig(), {
        keystorePath: outPath,
        rpcUrl: options.rpcUrl,
        chain,
        walletId: options.walletId,
      });
  await writeConfigFile(cfg);

  if (options.json) {
    runtime.log(
      JSON.stringify(
        {
          ok: true,
          provider: options.providerIdForRegistry ?? "embedded-keystore",
          chain,
          keystorePath: outPath,
          address: addressOut,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (!options.skipProviderConfig || !options.suppressExtraLogs) {
    runtime.log(
      options.skipProviderConfig
        ? `Self-hosted signer keystore imported: ${outPath}`
        : `Embedded keystore imported: ${outPath}`,
    );
  }
  runtime.log(`${chain.toUpperCase()} address: ${addressOut}`);
  if (options.walletId) {
    runtime.log(
      `Signer env hint: export FASED_WALLET_SOLANA_KEYSTORE_PATH__${walletIdEnvSuffix(options.walletId)}="${outPath}"`,
    );
  }
  if (!options.skipProviderConfig) {
    runtime.log("Configured wallet.provider.id=embedded-keystore and disabled wallet.runtime.");
  }

  // Register the wallet in the provider registry so it shows up in the UI
  try {
    const role = normalizeWalletRoleForCli(options.role);
    const wallet = upsertNamedWallet({
      walletId: options.walletId?.trim() || undefined,
      name: options.name || "Wallet",
      providerId: options.providerIdForRegistry ?? "embedded-keystore",
      addresses: {
        solana: addressOut,
      },
      metadata: role ? { role, purpose: role } : undefined,
      env,
    });
    if (role === "agent") {
      setDefaultWallet({ walletId: wallet.id, env });
    }
  } catch (err) {
    runtime.log(
      `Warning: failed to register wallet in UI registry: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function walletKeystoreStatusCommand(
  runtime: RuntimeEnv = defaultRuntime,
  options: WalletKeystoreStatusOptions = {},
) {
  const env = process.env;
  const cfg = loadConfig();
  const chain = options.chain ?? "solana";
  const keystorePath = resolveEmbeddedKeystorePathForChain(
    env,
    chain,
    cfg.wallet?.keystore?.path,
    options.walletId,
  );
  const exists = fs.existsSync(keystorePath);
  const providerId = cfg.wallet?.provider?.id;
  let address: string | undefined;
  let unlocked = false;
  let error: string | undefined;
  let detectedType: "solana-envelope" | "unknown" | "missing" = "missing";
  if (exists) {
    const passphrase = resolveKeystorePassphrase(undefined, env);
    const raw = fs.readFileSync(keystorePath, "utf8");
    detectedType = detectEmbeddedKeystoreType(raw);
    if (passphrase) {
      try {
        if (detectedType === "solana-envelope") {
          const envelope = parseSolanaKeystoreEnvelope(raw);
          if (!envelope) {
            throw new Error("invalid Solana keystore envelope");
          }
          decryptSolanaKeypairEnvelope(envelope, passphrase);
          address = envelope.publicKey;
          unlocked = true;
        } else {
          throw new Error("unsupported Solana keystore envelope");
        }
      } catch (err) {
        error = String(err);
      }
    }
  }
  const payload = {
    ok: true,
    provider: providerId,
    keystore: {
      path: keystorePath,
      exists,
      type: detectedType,
      unlocked,
      address,
      passphraseConfigured: Boolean(
        String(env.FASED_WALLET_PASSPHRASE_FILE ?? "").trim() ||
        String(env.FASED_WALLET_PASSPHRASE ?? "").trim(),
      ),
      rpcUrlConfigured: Boolean(
        String(env.FASED_WALLET_EMBEDDED_KEYSTORE_RPC_URL ?? "").trim() ||
        String(env.FASED_WALLET_RPC_URL ?? "").trim(),
      ),
      providerReady:
        Boolean(providerId === "embedded-keystore") &&
        exists &&
        Boolean(
          String(env.FASED_WALLET_EMBEDDED_KEYSTORE_RPC_URL ?? "").trim() ||
          String(env.FASED_WALLET_RPC_URL ?? "").trim(),
        ),
      error,
    },
  };
  if (options.json) {
    runtime.log(JSON.stringify(payload, null, 2));
    return;
  }
  runtime.log(`Provider: ${String(providerId ?? "unset")}`);
  runtime.log(`Keystore: ${keystorePath} (${exists ? "exists" : "missing"})`);
  runtime.log(`Type: ${detectedType}`);
  runtime.log(`Unlocked: ${unlocked ? "yes" : "no"}`);
  runtime.log(
    `RPC URL configured: ${
      payload.keystore.rpcUrlConfigured
        ? "yes"
        : "no (set FASED_WALLET_[EMBEDDED_KEYSTORE_]RPC_URL)"
    }`,
  );
  if (address) {
    runtime.log(`Address: ${address}`);
  }
  if (error) {
    runtime.log(`Error: ${error}`);
  }
}

export async function walletKeystoreValidateCommand(
  runtime: RuntimeEnv = defaultRuntime,
  options: WalletKeystoreValidateOptions = {},
) {
  const env = process.env;
  const cfg = loadConfig();
  const chainForPath = options.chain ?? "solana";
  const keystorePath = resolveEmbeddedKeystorePathForChain(
    env,
    chainForPath,
    cfg.wallet?.keystore?.path,
    options.walletId,
  );
  const passphrase = resolveKeystorePassphrase(undefined, env);
  const rpcUrl =
    String(env.FASED_WALLET_EMBEDDED_KEYSTORE_RPC_URL ?? "").trim() ||
    String(env.FASED_WALLET_RPC_URL ?? "").trim();
  const result: {
    ok: boolean;
    provider: string;
    checks: Array<{ id: string; ok: boolean; message: string }>;
    address?: string;
    chainId?: number;
    error?: string;
    chain?: WalletChain;
  } = {
    ok: false,
    provider: "embedded-keystore",
    checks: [],
  };

  let raw = "";
  let detectedType: "solana-envelope" | "unknown" | "missing" = "missing";
  if (!fs.existsSync(keystorePath)) {
    result.checks.push({ id: "keystore.exists", ok: false, message: `missing: ${keystorePath}` });
  } else {
    raw = fs.readFileSync(keystorePath, "utf8");
    detectedType = detectEmbeddedKeystoreType(raw);
    result.checks.push({
      id: "keystore.exists",
      ok: true,
      message: `${keystorePath} (${detectedType})`,
    });
  }
  if (!passphrase) {
    result.checks.push({
      id: "keystore.passphrase",
      ok: false,
      message: "missing passphrase (set FASED_WALLET_PASSPHRASE or FASED_WALLET_PASSPHRASE_FILE)",
    });
  } else {
    result.checks.push({ id: "keystore.passphrase", ok: true, message: "configured" });
  }
  if (!rpcUrl) {
    result.checks.push({
      id: "rpc.url",
      ok: false,
      message:
        "missing RPC URL (set FASED_WALLET_EMBEDDED_KEYSTORE_RPC_URL or FASED_WALLET_RPC_URL)",
    });
  } else {
    result.checks.push({ id: "rpc.url", ok: true, message: "configured" });
  }

  if (result.checks.some((check) => !check.ok)) {
    if (options.json) {
      runtime.log(JSON.stringify(result, null, 2));
      return;
    }
    for (const check of result.checks) {
      runtime.log(`${check.ok ? "✓" : "✗"} ${check.id}: ${check.message}`);
    }
    throw new Error("embedded keystore validation failed");
  }

  try {
    if (detectedType === "solana-envelope") {
      const envelope = parseSolanaKeystoreEnvelope(raw);
      if (!envelope) {
        throw new Error("invalid Solana keystore envelope");
      }
      const secretKey = decryptSolanaKeypairEnvelope(envelope, passphrase);
      const address = solanaAddressFromSecretKey(secretKey);
      result.chain = "solana";
      result.address = address;
      result.checks.push({
        id: "keystore.decrypt",
        ok: true,
        message: `unlocked (${address})`,
      });
      const latest = await callRpcMethod(rpcUrl, "getLatestBlockhash", [
        { commitment: "finalized" },
      ]);
      const latestValue = latest.value as { blockhash?: unknown } | undefined;
      const blockhash =
        latestValue && typeof latestValue === "object" && typeof latestValue.blockhash === "string"
          ? latestValue.blockhash
          : "unknown";
      result.checks.push({
        id: "rpc.connect",
        ok: true,
        message: `latestBlockhash=${String(blockhash).slice(0, 12)}…`,
      });
      const balance = await callRpcMethod(rpcUrl, "getBalance", [
        address,
        { commitment: "finalized" },
      ]);
      const balanceValue = balance.value;
      const lamports =
        typeof balanceValue === "number" || typeof balanceValue === "string"
          ? String(balanceValue)
          : "unknown";
      result.checks.push({
        id: "rpc.balance",
        ok: true,
        message: `lamports=${lamports}`,
      });
      result.ok = result.checks.every((check) => check.ok);
    } else {
      throw new Error("unsupported Solana keystore envelope");
    }
  } catch (err) {
    result.error = String(err);
    result.checks.push({
      id: "validate.error",
      ok: false,
      message: String(err),
    });
    result.ok = false;
  }

  if (options.json) {
    runtime.log(JSON.stringify(result, null, 2));
    return;
  }
  for (const check of result.checks) {
    runtime.log(`${check.ok ? "✓" : "✗"} ${check.id}: ${check.message}`);
  }
  if (!result.ok) {
    throw new Error("embedded keystore validation failed");
  }
}

export async function walletKeystorePassphraseInitCommand(
  runtime: RuntimeEnv = defaultRuntime,
  options: WalletKeystorePassphraseInitOptions = {},
) {
  const env = process.env ?? process.env;
  const outPath = resolvePassphraseFilePath(env, options.out);
  if (fs.existsSync(outPath) && !options.force) {
    throw new Error(`Passphrase file already exists: ${outPath} (use --force to overwrite)`);
  }
  const bytes =
    typeof options.length === "number" && Number.isFinite(options.length) && options.length >= 16
      ? Math.floor(options.length)
      : 24;
  const passphrase = randomBytes(bytes).toString("base64url");
  writePassphraseFile(outPath, passphrase);
  const payload = {
    ok: true,
    path: outPath,
    bytes,
    envExport: `export FASED_WALLET_PASSPHRASE_FILE=${outPath}`,
  };
  runtime.log(
    options.json
      ? JSON.stringify(payload, null, 2)
      : `Passphrase file written: ${outPath} (mode 600)`,
  );
  if (!options.json) {
    runtime.log(`Set env: export FASED_WALLET_PASSPHRASE_FILE=${outPath}`);
  }
}

export async function walletKeystorePassphraseRotateCommand(
  runtime: RuntimeEnv = defaultRuntime,
  options: WalletKeystorePassphraseRotateOptions = {},
) {
  const env = process.env ?? process.env;
  const cfg = loadConfig();
  const keystorePath = resolveEmbeddedKeystorePath(env, cfg.wallet?.keystore?.path);
  const passphraseFile = resolvePassphraseFilePath(env, options.file);
  if (!fs.existsSync(keystorePath)) {
    throw new Error(`Keystore missing: ${keystorePath}`);
  }
  const oldPassphrase =
    (
      options.oldPassphrase ??
      (fs.existsSync(passphraseFile) ? fs.readFileSync(passphraseFile, "utf8") : "")
    ).trim() || String(env.FASED_WALLET_PASSPHRASE ?? "").trim();
  if (!oldPassphrase) {
    throw new Error(
      "Missing old passphrase. Provide --old-passphrase or configure passphrase file/env.",
    );
  }
  const newPassphrase =
    (options.newPassphrase ?? "").trim() || randomBytes(24).toString("base64url");
  const raw = fs.readFileSync(keystorePath, "utf8");
  const detected = detectEmbeddedKeystoreType(raw);
  if (detected === "solana-envelope") {
    const envelope = parseSolanaKeystoreEnvelope(raw);
    if (!envelope) {
      throw new Error("Invalid Solana keystore envelope");
    }
    const secretKey = decryptSolanaKeypairEnvelope(envelope, oldPassphrase);
    const nextEnvelope = encryptSolanaKeypairEnvelope({
      secretKey,
      passphrase: newPassphrase,
      publicKey: envelope.publicKey,
    });
    fs.writeFileSync(keystorePath, `${JSON.stringify(nextEnvelope, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  } else {
    throw new Error("unsupported Solana keystore envelope");
  }
  writePassphraseFile(passphraseFile, newPassphrase);
  const payload = { ok: true, keystorePath, passphraseFile };
  runtime.log(
    options.json
      ? JSON.stringify(payload, null, 2)
      : `Rotated keystore passphrase and updated ${passphraseFile}`,
  );
}

export async function walletKeystoreExportCommand(
  runtime: RuntimeEnv = defaultRuntime,
  options: WalletKeystoreExportOptions = {},
) {
  if (options.includeSecret) {
    if (!options.json) {
      throw new Error("Including encrypted keystore material requires --json.");
    }
    requireKeystoreSecretExportConfirmation(options.confirmIncludeSecret);
  }
  const env = process.env ?? process.env;
  const cfg = loadConfig();
  const keystorePath = resolveEmbeddedKeystorePath(env, cfg.wallet?.keystore?.path);
  if (!fs.existsSync(keystorePath)) {
    throw new Error(`Keystore missing: ${keystorePath}`);
  }
  const raw = fs.readFileSync(keystorePath, "utf8");
  const detected = detectEmbeddedKeystoreType(raw);
  const outPath = options.out?.trim() ? path.resolve(options.out.trim()) : undefined;
  const payload: Record<string, unknown> = {
    ok: true,
    keystorePath,
    type: detected,
    exportedAt: new Date().toISOString(),
  };
  if (options.includeSecret) {
    payload.keystore = raw;
  }
  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(outPath, raw, { encoding: "utf8", mode: 0o600 });
    payload.outputPath = outPath;
  }
  if (!options.json && !outPath && !options.includeSecret) {
    runtime.log(`Keystore export info: type=${detected} path=${keystorePath}`);
    runtime.log(
      "Use --out <path> to write a backup copy, or --include-secret --json to print (dangerous).",
    );
    return;
  }
  runtime.log(JSON.stringify(payload, null, 2));
}

export async function walletProviderConfigureCommand(
  runtime: RuntimeEnv,
  options: WalletProviderConfigureOptions,
): Promise<void> {
  const providerId = options.providerId;
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
  if (providerId !== "privy") {
    setWalletProviderEnabled({ providerId, enabled: true, env: process.env });
  }
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

export async function walletSignerBrokerCommand(
  runtime: RuntimeEnv = defaultRuntime,
  options: WalletSignerBrokerOptions = {},
): Promise<void> {
  void runtime;
  const env = process.env ?? process.env;
  const socketPath = options.socketPath?.trim() || resolveLocalSignerSocketPath(env);
  const backendSocketPath =
    options.backendSocketPath?.trim() || resolveLocalSignerBackendSocketPath(env);
  const sidecarPaths = resolveLocalSignerSidecarPaths(socketPath);
  const pidFile = options.pidFile?.trim() || sidecarPaths.pidPath;
  const auditLog = options.auditLog?.trim() || sidecarPaths.auditPath;
  const broker = await startLocalSocketSignerBroker({
    socketPath,
    backendSocketPath,
    pidFile,
    auditLog,
    readOnly: Boolean(options.readOnly),
  });
  await new Promise<void>((resolve, reject) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
    process.once("uncaughtException", reject);
  }).finally(async () => {
    await broker.close();
  });
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
  const backendSocketPath = resolveLocalSignerBackendSocketPath(effectiveEnv);
  const expectedSocketMode = backendSocketPath !== socketPath ? 0o660 : 0o600;
  const { pidPath, auditPath } = resolveLocalSignerSidecarPaths(socketPath);
  const wallet = resolveWalletConfigForRuntime(cfg, effectiveEnv);
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
  const isNotFoundError = (err: unknown): boolean =>
    (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

  if (isLocalSigner) {
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

    if (localSignerSetupPending) {
      push("socket.health", true, "Configure");
    } else {
      try {
        const signerHealth = await createWalletProviderAdapter({
          cfg,
          wallet,
          env: effectiveEnv,
          providerIdOverride: "local-socket-signer",
        }).health();
        push("socket.health", signerHealth.ok, signerHealth.details);
      } catch (err) {
        push("socket.health", false, String(err));
      }
    }
  }
  const providerDefaultWallet = providerRegistry.defaultWalletId
    ? providerWallets.find((entry) => entry.id === providerRegistry.defaultWalletId)
    : undefined;

  const passphrase =
    String(effectiveEnv.FASED_WALLET_PASSPHRASE ?? "").trim() ||
    (() => {
      const p =
        String(effectiveEnv.FASED_WALLET_PASSPHRASE_FILE ?? "").trim() ||
        path.join(resolveLocalSignerMaterialRootDir(effectiveEnv), "passphrase");
      if (!p) {
        return "";
      }
      try {
        return fs.readFileSync(p, "utf8").trim();
      } catch {
        return "";
      }
    })();

  const inspectKeystore = (label: string, keystorePath: string) => {
    try {
      const raw = fs.readFileSync(keystorePath, "utf8");
      const kind = detectEmbeddedKeystoreType(raw);
      if (kind === "unknown") {
        push(
          `keystore.file.${label}`,
          false,
          `${keystorePath} type=unknown (expected fased-solana-keypair envelope)`,
        );
      } else {
        push(`keystore.file.${label}`, true, `${keystorePath} type=${kind}`);
      }
      if (!passphrase) {
        push(`keystore.passphrase.${label}`, false, "missing FASED_WALLET_PASSPHRASE(_FILE)");
      } else if (kind === "solana-envelope") {
        try {
          const envv = parseSolanaKeystoreEnvelope(raw);
          if (!envv) {
            throw new Error("invalid solana envelope");
          }
          void decryptSolanaKeypairEnvelope(envv, passphrase);
          push(`keystore.decrypt.${label}`, true, "solana envelope decrypt ok");
        } catch (err) {
          push(`keystore.decrypt.${label}`, false, String(err));
        }
      } else {
        push(`keystore.decrypt.${label}`, false, "unsupported keystore format");
      }
    } catch (err) {
      push(`keystore.file.${label}`, false, String(err));
    }
  };

  const listWalletIds = (prefix: string): string[] => {
    const out = new Set<string>();
    for (const [key, value] of Object.entries(effectiveEnv)) {
      if (!key.startsWith(prefix)) {
        continue;
      }
      if (typeof value !== "string" || !value.trim()) {
        continue;
      }
      const walletId = key.slice(prefix.length).trim().toLowerCase();
      if (walletId) {
        out.add(walletId);
      }
    }
    return [...out].toSorted();
  };
  const solanaWalletIds = listWalletIds("FASED_WALLET_SOLANA_KEYSTORE_PATH__");
  const registrySolanaWalletIds = providerWallets
    .filter((wallet) => Boolean(wallet.addresses?.solana))
    .map((wallet) => wallet.id.trim().toLowerCase())
    .filter(Boolean);
  const configuredSolanaWallets = new Set([...solanaWalletIds, ...registrySolanaWalletIds]);
  push(
    "wallets.configured.solana",
    true,
    configuredSolanaWallets.size
      ? [...configuredSolanaWallets].join(",")
      : "default-only (or fallback vars)",
  );

  const shouldInspectDefaultWallet = (): boolean => {
    const perChainKey = "FASED_WALLET_SOLANA_KEYSTORE_PATH";
    const explicitChainPath =
      String(effectiveEnv[perChainKey] ?? "").trim() ||
      String(effectiveEnv.FASED_WALLET_KEYSTORE_PATH ?? "").trim();
    if (explicitChainPath) {
      return true;
    }
    if (
      providerId !== "local-socket-signer" &&
      typeof cfg.wallet?.keystore?.path === "string" &&
      cfg.wallet.keystore.path.trim()
    ) {
      return true;
    }
    const defaultPath = resolveEmbeddedKeystorePathForChain(effectiveEnv, "solana");
    if (fs.existsSync(defaultPath)) {
      return true;
    }
    if (providerDefaultWallet?.addresses?.solana) {
      return true;
    }
    return false;
  };

  const solanaWalletSet = new Set<string>([
    ...(shouldInspectDefaultWallet() ? ["default"] : []),
    ...solanaWalletIds,
    ...registrySolanaWalletIds,
  ]);

  const resolveChainKeystorePath = (walletId: string): string => {
    const explicitFallback =
      providerId !== "local-socket-signer" && walletId === "default"
        ? cfg.wallet?.keystore?.path
        : undefined;
    return resolveEmbeddedKeystorePathForChain(effectiveEnv, "solana", explicitFallback, walletId);
  };

  for (const walletId of [...solanaWalletSet].toSorted()) {
    inspectKeystore(`solana.${walletId}`, resolveChainKeystorePath(walletId));
  }

  const resolveChainRpcUrl = (walletId: string): string => {
    const suffix = walletId.toUpperCase();
    const perWalletKey = `FASED_WALLET_SOLANA_RPC_URL__${suffix}`;
    const perChainKey = "FASED_WALLET_SOLANA_RPC_URL";
    return (
      String(effectiveEnv[perWalletKey] ?? "").trim() ||
      String(effectiveEnv[perChainKey] ?? "").trim() ||
      String(effectiveEnv.FASED_WALLET_EMBEDDED_KEYSTORE_RPC_URL ?? "").trim()
    );
  };
  const solanaRpcChecks = [...solanaWalletSet]
    .toSorted()
    .map((walletId) => resolveChainRpcUrl(walletId));
  const solanaRpcUrl = solanaRpcChecks.find(Boolean) ?? "";
  if (solanaWalletSet.size > 0 || String(effectiveEnv.FASED_WALLET_SOLANA_RPC_URL ?? "").trim()) {
    push("rpc.configured.solana", Boolean(solanaRpcUrl), solanaRpcUrl || "missing");
  }

  for (const walletId of [...solanaWalletSet].toSorted()) {
    const u = resolveChainRpcUrl(walletId);
    push(`rpc.configured.solana.${walletId}`, Boolean(u), u || "missing");
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
  return { ok, socketPath, pidPath, auditPath, checks };
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
) {
  const cfg = loadConfig();
  const resolved = resolveWalletConfigForRuntime(cfg, process.env);
  if (!resolved.enabled) {
    throw new Error("wallet is disabled");
  }
  const provider = createWalletProviderAdapter({
    cfg,
    wallet: resolved,
    env: process.env,
  });
  if (!provider.capabilities.supportsRotateKeys || !provider.rotateKeys) {
    throw new Error(`provider ${provider.id} does not support key rotation`);
  }
  const result = await provider.rotateKeys();
  if (options.json) {
    runtime.log(JSON.stringify(result, null, 2));
  } else {
    runtime.log("Wallet keys rotated.");
    if (result.addresses?.solana) {
      runtime.log(`Address: ${result.addresses.solana}`);
    }
  }
}

export async function initializeWalletCustodyForWallet(params: {
  walletId?: string;
  deviceShare?: string;
  force?: boolean;
  env?: NodeJS.ProcessEnv;
  cfg?: FasedAgentConfig;
}) {
  const env = params.env ?? process.env;
  const cfg = params.cfg ?? loadConfig();
  const walletCfg = resolveWalletConfigForRuntime(cfg, env);
  const providerId = resolveWalletProviderId(cfg, env);
  if (providerId !== "local-socket-signer") {
    throw new Error("split-key custody currently requires local-socket-signer");
  }
  const approvalAuth = readWalletApprovalAuthSnapshot(env, cfg);
  if (approvalAuth.mode !== "webauthn" || approvalAuth.passkeyCount < 1) {
    throw new Error(
      "split-key custody requires wallet approval auth mode=webauthn with at least one enrolled passkey",
    );
  }
  const oldPassphrase = resolveKeystorePassphrase(undefined, env);
  if (!oldPassphrase) {
    throw new Error(
      "split-key custody migration requires the current keystore passphrase to be configured before initialization",
    );
  }
  const allTargets = collectLocalSignerKeystoreTargets(cfg, env);
  const distinctWalletIds = [...new Set(allTargets.map((target) => target.walletId || "default"))];
  const requestedWalletId = params.walletId?.trim() || "";
  if (!requestedWalletId && distinctWalletIds.length > 1) {
    throw new Error(
      `multiple local-signer wallets found (${distinctWalletIds.join(", ")}); re-run with --wallet <walletId>`,
    );
  }
  const resolvedWalletId = requestedWalletId || distinctWalletIds[0] || "default";
  const registry = readWalletProviderRegistry(env);
  const registryWallet = registry.wallets.find((wallet) =>
    walletIdsMatchForEnvSuffix(wallet.id, resolvedWalletId),
  );
  const walletRole =
    resolveWalletUserRole(registryWallet) ??
    (walletIdsMatchForEnvSuffix(registry.defaultWalletId, resolvedWalletId) ? "agent" : undefined);
  if (walletRole !== "vault") {
    throw new Error(
      "split-key wallet security can only be enabled for Vault wallets. Agent wallets use automation, caps, and passkey-reviewed manual sends; Mining wallets use SAT mining/sweep policy. Create or select a Vault wallet before enabling wallet security.",
    );
  }
  const targets = allTargets.filter((target) =>
    walletIdsMatchForEnvSuffix(target.walletId, resolvedWalletId),
  );
  if (targets.length === 0) {
    throw new Error(
      `no self-hosted local-signer keystores were found to migrate for ${resolvedWalletId}`,
    );
  }

  const result = initializeWalletCustodyCeremony({
    env,
    force: Boolean(params.force),
    deviceShare: params.deviceShare,
    walletId: resolvedWalletId,
    wallet: walletCfg,
    cfg,
  });
  if (!result.ok) {
    throw new Error(result.message);
  }
  const recovered = recoverWalletCustodyPassphrase({
    env,
    deviceShare: result.deviceShare,
    walletId: resolvedWalletId,
  });
  if (!recovered.ok) {
    throw new Error(recovered.message);
  }
  for (const target of targets) {
    await reencryptLocalSignerKeystore({
      target,
      oldPassphrase,
      newPassphrase: recovered.passphrase,
    });
  }

  const custodyWallets = parseCustodyWalletSet({ ...env, ...cfg.env?.vars } as NodeJS.ProcessEnv);
  custodyWallets.add(normalizeCustodyWalletId(resolvedWalletId));
  const allSignerWalletsMigrated = allTargets.every((target) =>
    custodyWallets.has(normalizeCustodyWalletId(target.walletId)),
  );

  let nextCfg = allSignerWalletsMigrated ? clearConfiguredSignerPassphrase(cfg) : cfg;
  nextCfg = setConfigEnvVar(nextCfg, "FASED_WALLET_CUSTODY_MODE", "split-key");
  nextCfg = setConfigEnvVar(
    nextCfg,
    "FASED_WALLET_CUSTODY_WALLETS",
    formatCustodyWalletSet(custodyWallets),
  );
  nextCfg = setConfigEnvVar(nextCfg, "FASED_WALLET_CUSTODY_PASSKEY_CEREMONY", "1");
  nextCfg = setConfigEnvVar(nextCfg, "FASED_WALLET_CUSTODY_EPHEMERAL_RECONSTRUCTION", "1");
  nextCfg = setConfigEnvVar(nextCfg, "FASED_WALLET_CUSTODY_PHASE2_COMPLETE", "1");
  await writeConfigFile(nextCfg);

  process.env.FASED_WALLET_CUSTODY_MODE = "split-key";
  process.env.FASED_WALLET_CUSTODY_WALLETS = formatCustodyWalletSet(custodyWallets);
  process.env.FASED_WALLET_CUSTODY_PASSKEY_CEREMONY = "1";
  process.env.FASED_WALLET_CUSTODY_EPHEMERAL_RECONSTRUCTION = "1";
  process.env.FASED_WALLET_CUSTODY_PHASE2_COMPLETE = "1";
  let removedPassphraseFile: { removed: boolean; path?: string } = { removed: false };
  if (allSignerWalletsMigrated) {
    delete process.env.FASED_WALLET_PASSPHRASE;
    removedPassphraseFile = removeLocalSignerPassphraseFileIfManaged(env);
    delete process.env.FASED_WALLET_PASSPHRASE_FILE;
  }
  writeLocalSignerEnvFile(nextCfg, process.env);
  let signerRestarted = true;
  let signerRestartError: string | undefined;
  try {
    await restartLocalSocketSigner(undefined, process.env);
  } catch (err) {
    signerRestarted = false;
    signerRestartError = err instanceof Error ? err.message : String(err);
  }

  return {
    ok: true as const,
    scheme: result.scheme,
    statePath: result.statePath,
    walletId: result.walletId,
    role: result.role,
    deviceShare: result.deviceShare,
    recoveryShare: result.recoveryShare,
    secretBytes: result.secretBytes,
    updatedAt: result.updatedAt,
    migratedKeystores: targets.map((target) => ({
      chain: target.chain,
      walletId: target.walletId,
      path: target.path,
    })),
    walletProvider: providerId,
    executionMode: walletCfg.execution.mode,
    removedManagedPassphraseFile: removedPassphraseFile.removed,
    removedManagedPassphraseFilePath: removedPassphraseFile.path,
    signerRestarted,
    signerRestartError,
  };
}

export async function disableWalletCustodyForWallet(params: {
  walletId?: string;
  deviceShare?: string;
  recoveryShare?: string;
  env?: NodeJS.ProcessEnv;
  cfg?: FasedAgentConfig;
}) {
  const env = params.env ?? process.env;
  const cfg = params.cfg ?? loadConfig();
  const effectiveEnv = { ...env, ...cfg.env?.vars } as NodeJS.ProcessEnv;
  const walletCfg = resolveWalletConfigForRuntime(cfg, env);
  const providerId = resolveWalletProviderId(cfg, env);
  if (providerId !== "local-socket-signer") {
    throw new Error("wallet security disable currently requires local-socket-signer");
  }
  const requestedWalletId = params.walletId?.trim() || "";
  if (!requestedWalletId) {
    throw new Error("wallet id is required to disable wallet security");
  }
  const status = readWalletCustodyStatus({
    cfg,
    env: effectiveEnv,
    wallet: walletCfg,
    walletId: requestedWalletId,
  });
  if (status.mode === "single-key") {
    throw new Error(`wallet security is not enabled for ${requestedWalletId}`);
  }
  const resolvedWalletId = status.target.walletId || requestedWalletId;
  const allTargets = collectLocalSignerKeystoreTargets(cfg, env);
  const targets = allTargets.filter((target) =>
    walletIdsMatchForEnvSuffix(target.walletId, resolvedWalletId),
  );
  if (targets.length === 0) {
    throw new Error(`no local-signer keystore was found for ${resolvedWalletId}`);
  }
  const recovered = recoverWalletCustodyPassphrase({
    env: effectiveEnv,
    walletId: resolvedWalletId,
    deviceShare: params.deviceShare,
    recoveryShare: params.recoveryShare,
  });
  if (!recovered.ok) {
    throw new Error(recovered.message);
  }
  const passphraseSource = ensureLocalSignerPassphraseFileForCustodyDisable({ cfg, env });
  let nextCfg = passphraseSource.cfg;
  for (const target of targets) {
    await reencryptLocalSignerKeystore({
      target,
      oldPassphrase: recovered.passphrase,
      newPassphrase: passphraseSource.passphrase,
    });
  }

  const remainingCustodyWallets = new Set<string>();
  for (const walletStatus of listSplitKeyWalletCustodyStatuses({
    wallet: walletCfg,
    cfg,
    env: effectiveEnv,
  })) {
    if (!walletIdsMatchForEnvSuffix(walletStatus.target.walletId, resolvedWalletId)) {
      remainingCustodyWallets.add(normalizeCustodyWalletId(walletStatus.target.walletId));
    }
  }

  if (remainingCustodyWallets.size > 0) {
    nextCfg = setConfigEnvVar(nextCfg, "FASED_WALLET_CUSTODY_MODE", "split-key");
    nextCfg = setConfigEnvVar(
      nextCfg,
      "FASED_WALLET_CUSTODY_WALLETS",
      formatCustodyWalletSet(remainingCustodyWallets),
    );
    nextCfg = setConfigEnvVar(nextCfg, "FASED_WALLET_CUSTODY_PASSKEY_CEREMONY", "1");
    nextCfg = setConfigEnvVar(nextCfg, "FASED_WALLET_CUSTODY_EPHEMERAL_RECONSTRUCTION", "1");
    nextCfg = setConfigEnvVar(nextCfg, "FASED_WALLET_CUSTODY_PHASE2_COMPLETE", "1");
  } else {
    nextCfg = setConfigEnvVar(nextCfg, "FASED_WALLET_CUSTODY_MODE", undefined);
    nextCfg = setConfigEnvVar(nextCfg, "FASED_WALLET_CUSTODY_WALLETS", undefined);
    nextCfg = setConfigEnvVar(nextCfg, "FASED_WALLET_CUSTODY_PASSKEY_CEREMONY", undefined);
    nextCfg = setConfigEnvVar(nextCfg, "FASED_WALLET_CUSTODY_EPHEMERAL_RECONSTRUCTION", undefined);
    nextCfg = setConfigEnvVar(nextCfg, "FASED_WALLET_CUSTODY_PHASE2_COMPLETE", undefined);
  }
  await writeConfigFile(nextCfg);

  process.env.FASED_WALLET_PASSPHRASE_FILE = passphraseSource.passphraseFile;
  delete process.env.FASED_WALLET_PASSPHRASE;
  if (remainingCustodyWallets.size > 0) {
    process.env.FASED_WALLET_CUSTODY_MODE = "split-key";
    process.env.FASED_WALLET_CUSTODY_WALLETS = formatCustodyWalletSet(remainingCustodyWallets);
    process.env.FASED_WALLET_CUSTODY_PASSKEY_CEREMONY = "1";
    process.env.FASED_WALLET_CUSTODY_EPHEMERAL_RECONSTRUCTION = "1";
    process.env.FASED_WALLET_CUSTODY_PHASE2_COMPLETE = "1";
  } else {
    delete process.env.FASED_WALLET_CUSTODY_MODE;
    delete process.env.FASED_WALLET_CUSTODY_WALLETS;
    delete process.env.FASED_WALLET_CUSTODY_PASSKEY_CEREMONY;
    delete process.env.FASED_WALLET_CUSTODY_EPHEMERAL_RECONSTRUCTION;
    delete process.env.FASED_WALLET_CUSTODY_PHASE2_COMPLETE;
  }

  const deletedCeremony = deleteWalletCustodyCeremony({
    env: effectiveEnv,
    cfg,
    wallet: walletCfg,
    walletId: resolvedWalletId,
  });
  const locked = await lockWalletCustodyUnlockSessions({
    env: process.env,
    walletId: resolvedWalletId,
  });
  writeLocalSignerEnvFile(nextCfg, process.env);
  let signerRestarted = true;
  let signerRestartError: string | undefined;
  try {
    await restartLocalSocketSigner(undefined, process.env);
  } catch (err) {
    signerRestarted = false;
    signerRestartError = err instanceof Error ? err.message : String(err);
  }

  return {
    ok: true as const,
    walletId: resolvedWalletId,
    migratedKeystores: targets.map((target) => ({
      chain: target.chain,
      walletId: target.walletId,
      path: target.path,
    })),
    remainingCustodyWallets: formatCustodyWalletSet(remainingCustodyWallets),
    passphraseFile: passphraseSource.passphraseFile,
    custodyStateRemoved: deletedCeremony.removed,
    custodyStatePath: deletedCeremony.statePath,
    unlockSessionsCleared: locked.ok ? locked.removed : 0,
    unlockSessionClearError: locked.ok ? undefined : locked.message,
    signerRestarted,
    signerRestartError,
  };
}

export async function walletCustodyInitCommand(
  runtime: RuntimeEnv = defaultRuntime,
  options: WalletCustodyInitOptions = {},
) {
  const result = await initializeWalletCustodyForWallet({
    walletId: options.walletId,
    deviceShare: options.deviceShare,
    force: options.force,
    env: process.env,
  });

  if (options.json) {
    runtime.log(JSON.stringify(result, null, 2));
    return;
  }
  runtime.log("Wallet split-key custody ceremony initialized.");
  runtime.log(`Wallet: ${result.walletId}`);
  runtime.log(`Scheme: ${result.scheme}`);
  runtime.log(`State: ${result.statePath}`);
  runtime.log(`Secret bytes: ${result.secretBytes}`);
  runtime.log(`Migrated keystores: ${result.migratedKeystores.length}`);
  if (result.removedManagedPassphraseFile) {
    runtime.log(`Removed managed passphrase file: ${result.removedManagedPassphraseFilePath}`);
  } else if (result.removedManagedPassphraseFilePath) {
    runtime.log(
      `Passphrase file still exists outside signer state dir; remove it manually: ${result.removedManagedPassphraseFilePath}`,
    );
  }
  runtime.log("Signer env updated and local signer restarted in split-key custody mode.");
  runtime.log("Device share (store offline, never commit):");
  runtime.log(result.deviceShare);
  runtime.log(
    "Recovery share (store offline separately; use with host share if the device is lost):",
  );
  runtime.log(result.recoveryShare);
}

export async function walletCustodyLockCommand(
  runtime: RuntimeEnv = defaultRuntime,
  options: WalletCustodyLockOptions = {},
) {
  const result = await lockWalletCustodyUnlockSessions({
    env: process.env,
    host: options.host,
    walletId: options.walletId,
  });
  if (!result.ok) {
    throw new Error(result.message);
  }
  if (options.json) {
    runtime.log(JSON.stringify({ ok: true, result }, null, 2));
    return;
  }
  runtime.log(
    `Custody unlock sessions locked: removed=${result.removed} remaining=${result.remaining}${result.host ? ` host=${result.host}` : ""}${result.walletId ? ` wallet=${result.walletId}` : ""}`,
  );
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
    const allowed = new Set(["embedded-keystore", "alchemy", "turnkey", "privy"]);
    const providers = requestedProviders.filter((entry) => allowed.has(entry)) as Array<
      "embedded-keystore" | "alchemy" | "turnkey" | "privy"
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
