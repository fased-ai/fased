import { loadConfig, type FasedAgentConfig } from "../config/config.js";
import type { WalletProviderId } from "../config/types.wallet.js";
import { readWalletApprovalAuthSnapshot } from "./wallet-approval-auth.js";
import { resolveWalletPolicyConfig } from "./wallet-policy.js";
import { readWalletProviderRegistry } from "./wallet-provider-registry.js";
import {
  createWalletProviderAdapter,
  resolveWalletProviderId,
} from "./wallet-provider-resolver.js";
import {
  redactWalletDiagnosticText,
  walletDiagnosticErrorMessage,
  walletDiagnosticErrorString,
} from "./wallet-redaction.js";
import {
  ensureWalletStateDir,
  resolveWalletRuntimeConfig,
  resolveWalletStatePaths,
  type ResolvedWalletRuntimeConfig,
} from "./wallet-runtime-config.js";

export type WalletStatusSnapshot = {
  managedMode: boolean;
  provider: {
    id: WalletProviderId;
  };
  enabled: boolean;
  mode: "managed" | "external";
  runtime: "external-docker" | "external-custom";
  settlement: {
    class: "real-chain";
    realChainReady: boolean;
    summary: string;
  };
  chains: Array<"solana">;
  wallets?: Array<{
    id: string;
    name: string;
    providerId: WalletProviderId;
    addresses?: { solana?: string };
    balances?: { solana?: string };
    readiness: {
      keystore: boolean;
      rpc: boolean;
      api?: boolean;
      ata?: boolean;
    };
  }>;
  service: {
    host: string;
    port: number;
    healthy: boolean;
    pid?: number;
    runtime?: string;
    startedAt?: string;
  };
  stack?: {
    configured: boolean;
    composePath: string;
    envPath: string;
    runningServices: number;
    healthy: boolean;
  };
  policy: {
    executionMode: "manual" | "autonomous";
    capsEnabled: boolean;
    directSigning: boolean;
    skillsEnabled: boolean;
    toolAccessMode: "owner-only" | "allowlist" | "all";
    allowAgents: string[];
    solana: {
      allowPrograms: string[];
      maxPerTx: string;
      maxDaily: string;
    };
  };
  approvalAuth: {
    mode: "none" | "webauthn";
    ready: boolean;
    passkeyCount: number;
    notes: string[];
    passkeys: Array<{
      id: string;
      label: string;
      createdAt: string;
      lastUsedAt?: string;
    }>;
    statePath: string;
  };
  addresses?: {
    solana?: string;
  };
  paths: {
    rootDir: string;
    keysPath: string;
    pidPath: string;
  };
  checkedAt: string;
  startupState: "healthy" | "degraded" | "unreachable";
  authState: "ok" | "required" | "mismatch" | "unknown";
  authMode: "jwt-bootstrap" | "static-token-compat";
  authSource: "bootstrap" | "secret" | "env" | "stack-env" | "none";
  authBootstrap: {
    endpoint?: string;
    lastError?: string;
    lastSuccessAt?: string;
    expiresAt?: string;
  };
  error?: string;
};

export async function readWalletStatusSnapshot(params?: {
  config?: FasedAgentConfig;
  env?: NodeJS.ProcessEnv;
  walletId?: string;
}): Promise<WalletStatusSnapshot> {
  const env = params?.env ?? process.env;
  const cfg = params?.config ?? loadConfig();
  const effectiveEnv = { ...env, ...cfg.env?.vars };
  const providerId = resolveWalletProviderId(cfg, effectiveEnv);
  const providerRegistry = readWalletProviderRegistry(effectiveEnv);
  const localSignerSetupPending =
    providerId === "local-socket-signer" &&
    !providerRegistry.wallets.some((wallet) => wallet.providerId === "local-socket-signer");
  const runtimeConfig = resolveWalletRuntimeConfig(cfg, effectiveEnv);
  const resolved = resolveWalletPolicyConfig(cfg, effectiveEnv, params?.walletId);
  const gatewayMode = (effectiveEnv.FASED_GATEWAY_MODE ?? "").trim().toLowerCase();
  const managedMode = gatewayMode === "managed";
  const paths = ensureWalletStateDir(effectiveEnv);
  const statePaths = resolveWalletStatePaths(effectiveEnv);
  const approvalAuth = readWalletApprovalAuthSnapshot(effectiveEnv, cfg);
  const checkedAt = new Date().toISOString();

  let providerHealth: { ok: boolean; details?: string } = {
    ok: false,
    details: "provider health probe unavailable",
  };
  let addresses: { solana?: string } | undefined;
  let addressProbeError: string | undefined;
  try {
    const provider = createWalletProviderAdapter({
      cfg,
      wallet: runtimeConfig,
      env: effectiveEnv,
      providerIdOverride: providerId,
    });
    providerHealth = await provider.health();
    if (providerHealth.ok) {
      try {
        const got = await provider.getAddresses();
        if (got.solana) {
          addresses = got;
        }
      } catch (err) {
        addressProbeError = walletDiagnosticErrorMessage(err);
      }
    }
  } catch (err) {
    providerHealth = { ok: false, details: walletDiagnosticErrorString(err) };
  }

  const serviceHealthy = Boolean(providerHealth.ok || localSignerSetupPending);
  const authState: WalletStatusSnapshot["authState"] = serviceHealthy ? "ok" : "required";
  const startupState: WalletStatusSnapshot["startupState"] = serviceHealthy
    ? "healthy"
    : "degraded";

  const snapshot: WalletStatusSnapshot = {
    managedMode,
    provider: { id: providerId },
    enabled: resolved.enabled,
    mode: resolved.mode,
    runtime: resolved.runtime,
    settlement: {
      class: "real-chain",
      realChainReady: serviceHealthy,
      summary:
        "Real-chain settlement depends on the configured wallet provider and RPC connectivity.",
    },
    chains: resolved.chains,
    service: {
      host: resolved.service.host,
      port: resolved.service.port,
      healthy: serviceHealthy,
    },
    policy: {
      executionMode: resolved.execution.mode,
      capsEnabled: resolved.policy.capsEnabled,
      directSigning: resolved.policy.directSigning,
      skillsEnabled: resolved.policy.skillsEnabled,
      toolAccessMode: resolved.toolAccess.mode,
      allowAgents: resolved.toolAccess.allowAgents,
      solana: {
        allowPrograms: resolved.policy.solana.allowPrograms,
        maxPerTx: resolved.policy.solana.caps.maxPerTx.toString(),
        maxDaily: resolved.policy.solana.caps.maxDaily.toString(),
      },
    },
    approvalAuth,
    addresses,
    paths: {
      rootDir: paths.rootDir,
      keysPath: statePaths.keysPath,
      pidPath: statePaths.sidecarPidPath,
    },
    checkedAt,
    startupState,
    authState,
    authMode: "static-token-compat",
    authSource: "none",
    authBootstrap: {},
  };

  if (!resolved.enabled) {
    return snapshot;
  }
  if (!serviceHealthy) {
    snapshot.error =
      (providerHealth.details ? redactWalletDiagnosticText(providerHealth.details) : "") ||
      `${providerId} provider is unhealthy or missing credentials`;
  } else if (addressProbeError) {
    snapshot.error = `address probe warning: ${addressProbeError}`;
  }
  return snapshot;
}

export function summarizeWalletStatus(status: WalletStatusSnapshot): string {
  if (!status.enabled) {
    return "disabled";
  }
  return status.service.healthy ? "healthy" : "unhealthy";
}

export function resolveWalletConfigForRuntime(
  cfg: FasedAgentConfig,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedWalletRuntimeConfig {
  return resolveWalletRuntimeConfig(cfg, env);
}
