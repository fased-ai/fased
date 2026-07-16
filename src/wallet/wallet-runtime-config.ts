import fs from "node:fs";
import path from "node:path";
import type { FasedAgentConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import type {
  WalletChain,
  WalletExecutionMode,
  WalletAuthMode,
  WalletRuntimeMode,
  WalletRuntimeKind,
  WalletProviderId,
  WalletToolAccessMode,
} from "../config/types.wallet.js";

export const DEFAULT_WALLET_RUNTIME_PORT = 19444;
export const DEFAULT_WALLET_RUNTIME_HOST = "127.0.0.1";
export const DEFAULT_WALLET_RUNTIME_VERSION = "0.1.1";
export const DEFAULT_WALLET_RUNTIME_SOURCE_REF = "v0.2.30";

export type ResolvedWalletPolicyCaps = {
  maxPerTx: bigint;
  maxDaily: bigint;
};

export type ResolvedWalletTokenPolicyCap = {
  maxPerTx: bigint;
  maxDaily: bigint;
};

export type ResolvedWalletPolicyConfig = {
  capsEnabled: boolean;
  directSigning: boolean;
  skillsEnabled: boolean;
  solana: {
    allowPrograms: string[];
    caps: ResolvedWalletPolicyCaps;
    tokenCaps: Record<string, ResolvedWalletTokenPolicyCap>;
  };
};

export type ResolvedWalletToolAccessConfig = {
  mode: WalletToolAccessMode;
  allowAgents: string[];
  allowSkills: string[];
  denySkills: string[];
  allowSources: string[];
};

export type ResolvedWalletRuntimeConfig = {
  enabled: boolean;
  mode: WalletRuntimeMode;
  runtime: WalletRuntimeKind;
  execution: {
    mode: WalletExecutionMode;
  };
  chains: WalletChain[];
  service: {
    host: string;
    port: number;
  };
  install: {
    enabled: boolean;
    version: string;
  };
  external: {
    kind: "docker" | "custom";
  };
  auth: {
    mode: WalletAuthMode;
    bootstrapUrl?: string;
  };
  source: {
    ref: string;
  };
  stack: {
    rootDir: string;
    composePath: string;
    envPath: string;
    projectName: string;
  };
  policy: ResolvedWalletPolicyConfig;
  toolAccess: ResolvedWalletToolAccessConfig;
};

export type ResolvedWalletPolicy = ResolvedWalletPolicyConfig;
export type ResolvedWalletToolAccess = ResolvedWalletToolAccessConfig;

export type WalletStatePaths = {
  rootDir: string;
  keysPath: string;
  dailyUsagePath: string;
  sendApprovalsPath: string;
  auditLogPath: string;
  sidecarPidPath: string;
  sidecarLogPath: string;
  sidecarMetaPath: string;
  stackRootDir: string;
  stackComposePath: string;
  stackEnvPath: string;
};

const DEFAULT_POLICY_CAPS = {
  solana: {
    maxPerTx: "1000000000",
    maxDaily: "5000000000",
  },
} as const;

function normalizeChainList(chains: WalletChain[] | undefined): WalletChain[] {
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

function parsePositiveBigInt(raw: string | undefined, fallback: string): bigint {
  const input = raw?.trim() || fallback;
  try {
    const value = BigInt(input);
    return value >= 0n ? value : BigInt(fallback);
  } catch {
    return BigInt(fallback);
  }
}

function normalizeSolanaTokenCaps(raw: unknown): Record<string, ResolvedWalletTokenPolicyCap> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const out: Record<string, ResolvedWalletTokenPolicyCap> = {};
  for (const [mintRaw, capRaw] of Object.entries(raw as Record<string, unknown>)) {
    const mint = mintRaw.trim();
    if (!mint || !capRaw || typeof capRaw !== "object" || Array.isArray(capRaw)) {
      continue;
    }
    const cap = capRaw as Record<string, unknown>;
    out[mint] = {
      maxPerTx: parsePositiveBigInt(
        typeof cap.maxPerTx === "string" ? cap.maxPerTx : undefined,
        "0",
      ),
      maxDaily: parsePositiveBigInt(
        typeof cap.maxDaily === "string" ? cap.maxDaily : undefined,
        "0",
      ),
    };
  }
  return out;
}

export function resolveWalletStatePaths(env: NodeJS.ProcessEnv = process.env): WalletStatePaths {
  const rootDir = path.join(resolveStateDir(env), "wallet");
  const stackRootDir = path.join(rootDir, "wallet-stack");
  return {
    rootDir,
    keysPath: path.join(rootDir, "wallet-keys.json"),
    dailyUsagePath: path.join(rootDir, "policy-usage.json"),
    sendApprovalsPath: path.join(rootDir, "wallet-send-approvals.json"),
    auditLogPath: path.join(rootDir, "wallet-audit.jsonl"),
    sidecarPidPath: path.join(rootDir, "wallet-service.pid"),
    sidecarLogPath: path.join(rootDir, "wallet-service.log"),
    sidecarMetaPath: path.join(rootDir, "wallet-service.meta.json"),
    stackRootDir,
    stackComposePath: path.join(stackRootDir, "docker-compose.yml"),
    stackEnvPath: path.join(stackRootDir, ".env"),
  };
}

export function ensureWalletStateDir(env: NodeJS.ProcessEnv = process.env): WalletStatePaths {
  const paths = resolveWalletStatePaths(env);
  fs.mkdirSync(paths.rootDir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(paths.rootDir, 0o700);
  } catch {
    // best effort; Windows and some filesystems may ignore chmod.
  }
  return paths;
}

export function resolveLocalSignerSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = String(env.FASED_WALLET_LOCAL_SIGNER_SOCKET ?? "").trim();
  if (explicit) {
    return path.resolve(explicit);
  }
  return path.join(ensureWalletStateDir(env).rootDir, "local-signer.sock");
}

export function resolveLocalSignerSidecarPaths(socketPath: string): {
  pidPath: string;
  auditPath: string;
} {
  const resolvedSocketPath = path.resolve(socketPath);
  const socketDir = path.dirname(resolvedSocketPath);
  const socketName = path.basename(resolvedSocketPath);
  const sidecarBaseName = socketName.endsWith(".sock")
    ? socketName.slice(0, -".sock".length)
    : socketName;
  return {
    pidPath: path.join(socketDir, `${sidecarBaseName}.pid`),
    auditPath: path.join(socketDir, `${sidecarBaseName}.audit.jsonl`),
  };
}

export function resolveLocalSignerMaterialRootDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = String(env.FASED_WALLET_SIGNER_STATE_DIR ?? "").trim();
  if (explicit) {
    return path.resolve(explicit);
  }
  return ensureWalletStateDir(env).rootDir;
}

export function resolveLocalSignerBackendSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolveLocalSignerSocketPath(env);
}

export function resolveLocalSignerControlSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = String(env.FASED_WALLET_LOCAL_SIGNER_CONTROL_SOCKET ?? "").trim();
  if (explicit) {
    return path.resolve(explicit);
  }
  return path.join(resolveLocalSignerMaterialRootDir(env), "local-signer-control.sock");
}

export function resolveLocalSignerStateDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = String(env.FASED_WALLET_LOCAL_SIGNER_STATE_DB ?? "").trim();
  if (explicit) {
    return path.resolve(explicit);
  }
  return path.join(resolveLocalSignerMaterialRootDir(env), "signerd-v2.db");
}

export function resolveLocalSignerMasterKeyPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = String(env.FASED_WALLET_LOCAL_SIGNER_MASTER_KEY ?? "").trim();
  if (explicit) {
    return path.resolve(explicit);
  }
  return path.join(resolveLocalSignerMaterialRootDir(env), "signerd-v2.master.key");
}

export function resolveLocalSignerRunAsUser(
  _env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return undefined;
}

function parseRuntime(value: string | undefined): WalletRuntimeKind | null {
  switch (value) {
    case "external-docker":
    case "external-custom":
      return value;
    default:
      return null;
  }
}

function resolveRuntime(params: {
  explicitRuntime: string | undefined;
  legacyMode: WalletRuntimeMode;
  providerId: WalletProviderId;
  externalKind: "docker" | "custom" | undefined;
}): WalletRuntimeKind {
  const parsed = parseRuntime(params.explicitRuntime);
  if (parsed) {
    return parsed;
  }
  if (params.legacyMode === "external") {
    return params.externalKind === "docker" ? "external-docker" : "external-custom";
  }
  return "external-docker";
}

function inferDefaultWalletProviderId(env: NodeJS.ProcessEnv): WalletProviderId | null {
  if (String(env.FASED_WALLET_LOCAL_SIGNER_SOCKET ?? "").trim()) {
    return "local-socket-signer";
  }
  for (const key of Object.keys(env)) {
    if (
      key === "FASED_WALLET_SOLANA_KEYSTORE_PATH" ||
      key === "FASED_WALLET_PASSPHRASE_FILE" ||
      key.startsWith("FASED_WALLET_SOLANA_KEYSTORE_PATH__")
    ) {
      if (String(env[key] ?? "").trim()) {
        return "local-socket-signer";
      }
    }
  }
  return null;
}

export function resolveWalletRuntimeConfig(
  cfg: FasedAgentConfig,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedWalletRuntimeConfig {
  const gatewayMode = (env.FASED_GATEWAY_MODE ?? "").trim().toLowerCase();
  const managedProfile = gatewayMode === "managed";
  const walletRuntime = cfg.wallet?.runtime;
  const providerId: WalletProviderId =
    cfg.wallet?.provider?.id ?? inferDefaultWalletProviderId(env) ?? "local-socket-signer";
  const enabled = walletRuntime?.enabled ?? managedProfile;
  const legacyMode: WalletRuntimeMode = walletRuntime?.mode === "external" ? "external" : "managed";
  const runtime = resolveRuntime({
    explicitRuntime: walletRuntime?.runtime,
    legacyMode,
    providerId,
    externalKind: walletRuntime?.external?.kind,
  });
  const mode: WalletRuntimeMode = "external";
  const chains = normalizeChainList(walletRuntime?.chains);
  const host = walletRuntime?.service?.host?.trim() || DEFAULT_WALLET_RUNTIME_HOST;
  const port =
    typeof walletRuntime?.service?.port === "number" &&
    Number.isFinite(walletRuntime.service.port) &&
    walletRuntime.service.port > 0 &&
    walletRuntime.service.port <= 65535
      ? Math.floor(walletRuntime.service.port)
      : DEFAULT_WALLET_RUNTIME_PORT;
  const installEnabled = walletRuntime?.install?.enabled ?? managedProfile;
  const installVersion = walletRuntime?.install?.version?.trim() || DEFAULT_WALLET_RUNTIME_VERSION;
  const paths = resolveWalletStatePaths(env);
  const externalKind: "docker" | "custom" =
    walletRuntime?.external?.kind === "custom" || runtime === "external-custom"
      ? "custom"
      : "docker";
  const authModeRaw = walletRuntime?.auth?.mode;
  const authMode: WalletAuthMode =
    authModeRaw === "jwt-bootstrap" || authModeRaw === "static-token-compat"
      ? authModeRaw
      : "static-token-compat";
  const bootstrapUrl =
    walletRuntime?.auth?.bootstrapUrl?.trim() ||
    String(env.FASED_WALLET_AUTH_BOOTSTRAP_URL ?? "").trim() ||
    undefined;
  const sourceRef =
    walletRuntime?.source?.ref?.trim() ||
    String(env.FASED_WALLET_SOURCE_REF ?? "").trim() ||
    DEFAULT_WALLET_RUNTIME_SOURCE_REF;
  const toolAccessModeRaw = walletRuntime?.toolAccess?.mode;
  const toolAccessMode: WalletToolAccessMode =
    toolAccessModeRaw === "all" || toolAccessModeRaw === "allowlist"
      ? toolAccessModeRaw
      : "owner-only";
  const allowAgents = (walletRuntime?.toolAccess?.allowAgents ?? [])
    .map((value: unknown) => String(value).trim())
    .filter(Boolean);
  const allowSkills = (walletRuntime?.toolAccess?.allowSkills ?? [])
    .map((value: unknown) => String(value).trim())
    .filter(Boolean);
  const denySkills = (walletRuntime?.toolAccess?.denySkills ?? [])
    .map((value: unknown) => String(value).trim())
    .filter(Boolean);
  const allowSources = (walletRuntime?.toolAccess?.allowSources ?? [])
    .map((value: unknown) => String(value).trim().toLowerCase())
    .filter(Boolean);

  return {
    enabled,
    mode,
    runtime,
    execution: {
      mode:
        cfg.wallet?.execution?.mode === "autonomous" ||
        (cfg.wallet?.execution?.mode !== "manual" &&
          (walletRuntime?.policy?.directSigning ?? false))
          ? "autonomous"
          : "manual",
    },
    chains,
    service: { host, port },
    install: { enabled: installEnabled, version: installVersion },
    external: { kind: externalKind },
    auth: { mode: authMode, bootstrapUrl },
    source: { ref: sourceRef },
    stack: {
      rootDir: paths.stackRootDir,
      composePath: paths.stackComposePath,
      envPath: paths.stackEnvPath,
      projectName: "fased-wallet",
    },
    policy: {
      capsEnabled:
        typeof walletRuntime?.policy?.capsEnabled === "boolean"
          ? walletRuntime.policy.capsEnabled
          : true,
      directSigning: walletRuntime?.policy?.directSigning ?? false,
      skillsEnabled: walletRuntime?.policy?.skillsEnabled === true,
      solana: {
        allowPrograms: (walletRuntime?.policy?.solana?.allowPrograms ?? [])
          .map((value: unknown) => String(value).trim())
          .filter(Boolean),
        caps: {
          maxPerTx: parsePositiveBigInt(
            walletRuntime?.policy?.solana?.maxPerTx,
            DEFAULT_POLICY_CAPS.solana.maxPerTx,
          ),
          maxDaily: parsePositiveBigInt(
            walletRuntime?.policy?.solana?.maxDaily,
            DEFAULT_POLICY_CAPS.solana.maxDaily,
          ),
        },
        tokenCaps: normalizeSolanaTokenCaps(walletRuntime?.policy?.solana?.tokenCaps),
      },
    },
    toolAccess: {
      mode: toolAccessMode,
      allowAgents,
      allowSkills,
      denySkills,
      allowSources,
    },
  };
}

export function resolveWalletRuntimeProviderId(
  cfg: FasedAgentConfig,
  env: NodeJS.ProcessEnv = process.env,
): WalletProviderId {
  return cfg.wallet?.provider?.id ?? inferDefaultWalletProviderId(env) ?? "local-socket-signer";
}
