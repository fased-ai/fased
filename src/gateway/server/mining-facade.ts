import { loadConfig, resolveGatewayPort, type FasedAgentConfig } from "../../config/config.js";
import {
  readWalletProviderRegistry,
  resolveWalletUserRole,
  type WalletProviderRegistry,
} from "../../wallet/wallet-provider-registry.js";
import { callGatewayScoped } from "../call.js";

export type GatewayMiningMethod =
  | "sat.claimBacklog"
  | "sat.claimCycleRewards"
  | "sat.clearMiningHistory"
  | "sat.depositMinerCapital"
  | "sat.finalizeEpoch"
  | "sat.getMainnetSyncStatus"
  | "sat.getMinerProfile"
  | "sat.getMiningHistory"
  | "sat.getMiningReadiness"
  | "sat.getMiningRecovery"
  | "sat.getMiningStatus"
  | "sat.getMiningWalletAttachment"
  | "sat.initMinerCapital"
  | "sat.listMiningWallets"
  | "sat.miningCrank"
  | "sat.republishEpochRoots"
  | "sat.resolveDispute"
  | "sat.setActiveCommit"
  | "sat.setMinerProfile"
  | "sat.startMining"
  | "sat.stopMining"
  | "sat.submitParticipation"
  | "sat.syncMainnet"
  | "sat.topUpRegistryReserve"
  | "sat.withdrawMinerCapital";

export type GatewayMiningFacade = {
  call<T>(
    method: GatewayMiningMethod,
    params?: unknown,
    options?: { timeoutMs?: number },
  ): Promise<T>;
  readStatusPayload(): Promise<Record<string, unknown>>;
  readConfiguredWalletId(config: FasedAgentConfig): string | undefined;
  resolveWalletConflict(walletId: string | undefined): string | null;
};

type GatewayMiningFacadeDependencies = {
  env: NodeJS.ProcessEnv;
  loadConfig: typeof loadConfig;
  resolvePort: typeof resolveGatewayPort;
  callGateway: typeof callGatewayScoped;
  readRegistry: (env: NodeJS.ProcessEnv) => WalletProviderRegistry;
  resolveRole: typeof resolveWalletUserRole;
};

function readConfiguredWalletId(config: FasedAgentConfig): string | undefined {
  const miningConfig = config.plugins?.entries?.["sat-mining"]?.config;
  if (!miningConfig || typeof miningConfig !== "object" || Array.isArray(miningConfig)) {
    return undefined;
  }
  const walletId = (miningConfig as { walletId?: unknown }).walletId;
  return typeof walletId === "string" ? walletId.trim() || undefined : undefined;
}

export function createGatewayMiningFacade(
  overrides: Partial<GatewayMiningFacadeDependencies> = {},
): GatewayMiningFacade {
  const dependencies: GatewayMiningFacadeDependencies = {
    env: process.env,
    loadConfig,
    resolvePort: resolveGatewayPort,
    callGateway: callGatewayScoped,
    readRegistry: readWalletProviderRegistry,
    resolveRole: resolveWalletUserRole,
    ...overrides,
  };

  const call: GatewayMiningFacade["call"] = async (method, params, options) => {
    const config = dependencies.loadConfig();
    const token =
      config.gateway?.auth?.mode === "token" && typeof config.gateway.auth.token === "string"
        ? config.gateway.auth.token.trim() || undefined
        : undefined;
    return await dependencies.callGateway({
      url: `ws://localhost:${dependencies.resolvePort(config, dependencies.env)}`,
      token,
      config,
      method,
      params,
      scopes: ["operator.admin"],
      deviceAuth: "disabled",
      timeoutMs: typeof options?.timeoutMs === "number" ? options.timeoutMs : 15_000,
    });
  };

  return {
    call,
    readStatusPayload: async () => {
      const result = await call<{ payload?: unknown }>("sat.getMiningStatus");
      return result.payload && typeof result.payload === "object" && !Array.isArray(result.payload)
        ? (result.payload as Record<string, unknown>)
        : {};
    },
    readConfiguredWalletId,
    resolveWalletConflict: (walletId) => {
      const normalizedWalletId = walletId?.trim();
      if (!normalizedWalletId) {
        return null;
      }
      const activeMiningWalletId = readConfiguredWalletId(dependencies.loadConfig());
      if (activeMiningWalletId && activeMiningWalletId !== normalizedWalletId) {
        return `SAT Mining already uses ${activeMiningWalletId}. Archive that singleton wallet before attaching a replacement.`;
      }
      const registry = dependencies.readRegistry(dependencies.env);
      const wallet = registry.wallets.find((entry) => entry.id === normalizedWalletId);
      const otherMiningWallet = registry.wallets.find(
        (entry) => entry.id !== normalizedWalletId && dependencies.resolveRole(entry) === "mining",
      );
      if (otherMiningWallet) {
        return `SAT Mining already has the singleton wallet ${otherMiningWallet.id}. Archive it before attaching a replacement.`;
      }
      if (!wallet) {
        return "SAT Mining requires an existing dedicated Mining wallet.";
      }
      const purpose = dependencies.resolveRole(wallet);
      if (normalizedWalletId === registry.defaultWalletId || purpose === "agent") {
        return "SAT Mining must use a dedicated Mining wallet. Create a new Mining wallet instead of reusing an Agent wallet.";
      }
      if (purpose && purpose !== "mining") {
        return `SAT Mining must use a Mining wallet. ${wallet.name ?? normalizedWalletId} is a ${purpose} wallet; create a new Mining wallet instead.`;
      }
      return null;
    },
  };
}
