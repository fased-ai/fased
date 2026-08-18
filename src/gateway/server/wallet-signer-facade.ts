import type { WalletSignerDoctorReport } from "../../commands/wallet.js";
import type { FasedAgentConfig } from "../../config/config.js";
import type { WalletProviderId } from "../../config/types.wallet.js";
import {
  readWalletProviderRegistry,
  type WalletProviderRegistry,
} from "../../wallet/wallet-provider-registry.js";
import { resolveWalletProviderId } from "../../wallet/wallet-provider-resolver.js";
import { readWalletStatusSnapshot, type WalletStatusSnapshot } from "../../wallet/wallet-status.js";

type WalletChainEntry = {
  walletId: string;
  rpcConfigured: boolean;
  decryptReady: boolean;
};

export type GatewayWalletStatusResult = {
  status: Record<string, unknown>;
};

export type GatewaySignerDoctorResult = {
  report: {
    ok: boolean;
    socketPath: string;
    pidPath: string;
    auditPath: string;
    running: boolean;
    checks: WalletSignerDoctorReport["checks"];
  };
  chainWallets: {
    solana: Array<{
      walletId: string;
      keystoreReady: boolean;
      decryptReady: boolean;
      rpcConfigured: boolean;
      keystoreDetail?: string;
      rpcDetail?: string;
    }>;
  };
};

export type GatewayWalletSignerFacade = {
  readStatus(params: {
    config: FasedAgentConfig;
    env: NodeJS.ProcessEnv;
    registryEnv?: NodeJS.ProcessEnv;
    walletId?: string;
  }): Promise<GatewayWalletStatusResult>;
  readSignerDoctor(params: {
    config: FasedAgentConfig;
    env: NodeJS.ProcessEnv;
  }): Promise<GatewaySignerDoctorResult>;
};

type GatewayWalletSignerFacadeDependencies = {
  readStatusSnapshot: typeof readWalletStatusSnapshot;
  readRegistry: (env: NodeJS.ProcessEnv) => WalletProviderRegistry;
  resolveProviderId: typeof resolveWalletProviderId;
  restartLocalSigner: (env: NodeJS.ProcessEnv) => Promise<void>;
  collectSignerDoctor: (
    env: NodeJS.ProcessEnv,
    options: { config: FasedAgentConfig },
  ) => Promise<WalletSignerDoctorReport>;
};

function formatLamportsToSol(raw: string): string {
  try {
    const lamports = BigInt(raw);
    const base = 10n ** 9n;
    const whole = lamports / base;
    const frac = (lamports % base).toString().padStart(9, "0").replace(/0+$/, "");
    return frac ? `${whole.toString()}.${frac} SOL` : `${whole.toString()} SOL`;
  } catch {
    return "invalid";
  }
}

function normalizeWalletIdForEnvSuffix(walletId?: string): string | undefined {
  const raw = String(walletId ?? "")
    .trim()
    .toLowerCase();
  if (!raw) {
    return undefined;
  }
  const normalized = raw.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized || undefined;
}

function walletIdsMatchForStatus(left?: string, right?: string): boolean {
  const normalizedLeft = String(left ?? "")
    .trim()
    .toLowerCase();
  const normalizedRight = String(right ?? "")
    .trim()
    .toLowerCase();
  if (!normalizedLeft || !normalizedRight) {
    return false;
  }
  return (
    normalizedLeft === normalizedRight ||
    normalizeWalletIdForEnvSuffix(normalizedLeft) === normalizeWalletIdForEnvSuffix(normalizedRight)
  );
}

function findWalletChainEntry<T extends { walletId: string }>(
  entries: T[] | undefined,
  walletId: string,
): T | undefined {
  return (entries ?? []).find((entry) => walletIdsMatchForStatus(entry.walletId, walletId));
}

function providerMode(providerId: WalletProviderId): {
  activeSignerMode: "local-native-signer" | "hosted-provider";
  providerSummary: {
    id: WalletProviderId;
    label: string;
    category: "hosted-provider" | "local-signer";
    signerMode: "local-native-signer" | "hosted-provider";
  };
} {
  const activeSignerMode =
    providerId === "turnkey" || providerId === "privy" || providerId === "alchemy"
      ? ("hosted-provider" as const)
      : ("local-native-signer" as const);
  const label =
    providerId === "local-socket-signer"
      ? "Local signer socket"
      : providerId === "turnkey"
        ? "Turnkey"
        : providerId === "privy"
          ? "Privy"
          : providerId === "alchemy"
            ? "Alchemy"
            : providerId;
  return {
    activeSignerMode,
    providerSummary: {
      id: providerId,
      label,
      category: activeSignerMode === "hosted-provider" ? "hosted-provider" : "local-signer",
      signerMode: activeSignerMode,
    },
  };
}

async function readGatewayWalletStatus(
  params: {
    config: FasedAgentConfig;
    env: NodeJS.ProcessEnv;
    registryEnv?: NodeJS.ProcessEnv;
    walletId?: string;
  },
  dependencies: GatewayWalletSignerFacadeDependencies,
): Promise<GatewayWalletStatusResult> {
  const configuredProviderId = dependencies.resolveProviderId(params.config, params.env);
  let snapshot = await dependencies.readStatusSnapshot({
    config: params.config,
    env: params.env,
    walletId: params.walletId,
  });
  if (configuredProviderId === "local-socket-signer" && !snapshot.service.healthy) {
    try {
      await dependencies.restartLocalSigner(params.env);
      snapshot = await dependencies.readStatusSnapshot({
        config: params.config,
        env: params.env,
        walletId: params.walletId,
      });
    } catch {
      // Keep the original unhealthy snapshot; signer doctor provides deeper detail.
    }
  }

  const { activeSignerMode, providerSummary } = providerMode(configuredProviderId);
  const status: Record<string, unknown> = {
    ...snapshot,
    configuredProviderId,
    activeSignerMode,
    providerSummary,
  };
  const registry = dependencies.readRegistry(params.registryEnv ?? params.env);
  const snapshotWithChains = snapshot as WalletStatusSnapshot & {
    chainWallets?: { solana?: WalletChainEntry[] };
  };
  status.capabilities = {
    canEditPolicy: true,
    canSend: true,
    canSetupWallets: false,
    canEditProviders: false,
    canEditRpc: false,
  };
  status.policyDisplay = {
    solana: {
      maxPerTx: {
        raw: snapshot.policy.solana.maxPerTx,
        human: formatLamportsToSol(snapshot.policy.solana.maxPerTx),
      },
      maxDaily: {
        raw: snapshot.policy.solana.maxDaily,
        human: formatLamportsToSol(snapshot.policy.solana.maxDaily),
      },
    },
  };
  status.wallets = registry.wallets.map((wallet) => {
    const liveWallet = snapshot.wallets?.find((entry) => entry.id === wallet.id);
    const solana = findWalletChainEntry(snapshotWithChains.chainWallets?.solana, wallet.id);
    const readiness = liveWallet?.readiness ?? {
      keystore: Boolean(solana?.decryptReady ?? false),
      rpc: Boolean(solana?.rpcConfigured),
      ready: false,
    };
    return {
      id: wallet.id,
      walletId: wallet.id,
      name: wallet.name,
      providerId: wallet.providerId,
      provider: wallet.providerId,
      addresses: wallet.addresses,
      readiness,
      chains: wallet.addresses?.solana ? ["solana"] : [],
      rpcConfigured: readiness.rpc,
      health: readiness.ready ? "ok" : "degraded",
    };
  });
  if (configuredProviderId === "local-socket-signer") {
    status.providerAuthMode = snapshot.authMode;
    status.providerAuthSource = snapshot.authSource;
    status.providerAuthDetails = snapshot.authBootstrap
      ? {
          endpoint: snapshot.authBootstrap.endpoint,
          lastError: snapshot.authBootstrap.lastError,
          lastSuccessAt: snapshot.authBootstrap.lastSuccessAt,
          expiresAt: snapshot.authBootstrap.expiresAt,
        }
      : undefined;
  }
  delete status.authMode;
  delete status.authSource;
  delete status.authBootstrap;
  return { status };
}

async function readGatewaySignerDoctor(
  params: { config: FasedAgentConfig; env: NodeJS.ProcessEnv },
  dependencies: GatewayWalletSignerFacadeDependencies,
): Promise<GatewaySignerDoctorResult> {
  const doctor = await dependencies.collectSignerDoctor(params.env, { config: params.config });
  const registry = dependencies.readRegistry(params.env);
  const walletIds = registry.wallets
    .filter((wallet) => wallet.addresses?.solana && wallet.id.trim())
    .map((wallet) => wallet.id.trim().toLowerCase())
    .filter((walletId, index, all) => all.indexOf(walletId) === index)
    .toSorted();
  const lookupWalletCheck = (prefix: string, walletId: string) =>
    doctor.checks.find((entry) => {
      const check = String(entry.check ?? "");
      const expectedPrefix = `${prefix}.solana.`;
      return (
        check.startsWith(expectedPrefix) &&
        walletIdsMatchForStatus(check.slice(expectedPrefix.length), walletId)
      );
    });

  return {
    report: {
      ok: doctor.ok,
      socketPath: doctor.socketPath,
      pidPath: doctor.pidPath,
      auditPath: doctor.auditPath,
      running: doctor.checks.find((entry) => entry.check === "socket.health")?.ok ?? false,
      checks: doctor.checks,
    },
    chainWallets: {
      solana: walletIds.map((walletId) => ({
        walletId,
        keystoreReady: lookupWalletCheck("keystore.file", walletId)?.ok ?? false,
        decryptReady: lookupWalletCheck("keystore.decrypt", walletId)?.ok ?? false,
        rpcConfigured: lookupWalletCheck("rpc.configured", walletId)?.ok ?? false,
        keystoreDetail: lookupWalletCheck("keystore.file", walletId)?.detail,
        rpcDetail: lookupWalletCheck("rpc.configured", walletId)?.detail,
      })),
    },
  };
}

export function createGatewayWalletSignerFacade(
  overrides: Partial<GatewayWalletSignerFacadeDependencies> = {},
): GatewayWalletSignerFacade {
  const dependencies: GatewayWalletSignerFacadeDependencies = {
    readStatusSnapshot: readWalletStatusSnapshot,
    readRegistry: readWalletProviderRegistry,
    resolveProviderId: resolveWalletProviderId,
    restartLocalSigner: async (env) => {
      const { restartLocalSocketSigner } = await import("../../wizard/onboarding.wallet.js");
      await restartLocalSocketSigner(undefined, env);
    },
    collectSignerDoctor: async (env, options) => {
      const { collectWalletSignerDoctorReport } = await import("../../commands/wallet.js");
      return await collectWalletSignerDoctorReport(env, options);
    },
    ...overrides,
  };
  return {
    readStatus: async (params) => await readGatewayWalletStatus(params, dependencies),
    readSignerDoctor: async (params) => await readGatewaySignerDoctor(params, dependencies),
  };
}
