import type { FasedAgentConfig } from "../config/config.js";
import type { WalletProviderId } from "../config/types.wallet.js";
import { resolveWalletRoleForId } from "./wallet-policy.js";
import {
  readWalletProviderRegistry,
  resolveWalletSelection,
  type WalletResolvedSelection,
} from "./wallet-provider-registry.js";

export type WalletActionSelectionErrorCode =
  | "wallet_role_not_allowed"
  | "wallet_handle_required"
  | "wallet_not_found"
  | "wallet_ambiguous";

export class WalletActionSelectionError extends Error {
  readonly code: WalletActionSelectionErrorCode;

  constructor(code: WalletActionSelectionErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "WalletActionSelectionError";
    this.code = code;
  }
}

export function parseWalletHandle(value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw) {
    return undefined;
  }
  const prefix = "@wallet:";
  if (!raw.toLowerCase().startsWith(prefix)) {
    throw new WalletActionSelectionError(
      "wallet_handle_required",
      "wallet handle must use @wallet:<walletId>",
    );
  }
  const walletId = raw.slice(prefix.length).trim();
  if (!walletId || !/^[a-zA-Z0-9_-]+$/.test(walletId)) {
    throw new WalletActionSelectionError("wallet_not_found", `wallet not found: ${raw}`);
  }
  return walletId;
}

export type AgentWalletSelection = WalletResolvedSelection & {
  walletId: string;
  walletName: string;
  providerId: WalletProviderId;
  role: "agent";
  walletHandle: string;
};

export type WalletActionSelectionRole = "agent";

export type WalletActionSelection = WalletResolvedSelection & {
  walletId: string;
  walletName: string;
  providerId: WalletProviderId;
  role: WalletActionSelectionRole;
  walletHandle: string;
};

export function resolveWalletActionSelection(params: {
  config?: FasedAgentConfig;
  env?: NodeJS.ProcessEnv;
  walletHandle?: string;
  walletId?: string;
  walletName?: string;
  providerId?: WalletProviderId;
  agentId?: string;
  skillWalletId?: string;
  allowedRoles?: WalletActionSelectionRole[];
}): WalletActionSelection {
  const env = params.env ?? process.env;
  const allowedRoles = params.allowedRoles?.length ? params.allowedRoles : ["agent"];
  const handleWalletId = parseWalletHandle(params.walletHandle);
  const explicitWalletId = handleWalletId ?? params.walletId?.trim();
  const displayNameHint = params.walletName?.trim();
  const registry = readWalletProviderRegistry(env);

  if (!explicitWalletId && displayNameHint) {
    throw new WalletActionSelectionError(
      "wallet_handle_required",
      "walletName is display-only for risky wallet actions; use @wallet:<walletId>",
    );
  }

  let selection: WalletResolvedSelection;
  try {
    if (explicitWalletId) {
      selection = resolveWalletSelection({
        walletId: explicitWalletId,
        providerId: params.providerId,
        env,
      });
    } else {
      selection = resolveWalletSelection({
        agentId: params.agentId,
        skillWalletId: params.skillWalletId,
        env,
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "wallet selection failed";
    if (message.includes("ambiguous")) {
      throw new WalletActionSelectionError("wallet_ambiguous", message);
    }
    throw new WalletActionSelectionError("wallet_not_found", message);
  }

  if (!selection.walletId) {
    throw new WalletActionSelectionError(
      "wallet_handle_required",
      "Select an Agent wallet: use an explicit wallet, skill override, Agent assignment, or Default Agent wallet fallback",
    );
  }

  const wallet = registry.wallets.find((entry) => entry.id === selection.walletId);
  if (!wallet) {
    throw new WalletActionSelectionError(
      "wallet_not_found",
      `wallet not found: ${selection.walletId}`,
    );
  }
  if (params.providerId && wallet.providerId !== params.providerId) {
    throw new WalletActionSelectionError(
      "wallet_not_found",
      `wallet ${wallet.name} (${wallet.id}) belongs to provider ${wallet.providerId}, not ${params.providerId}`,
    );
  }

  const role = resolveWalletRoleForId({
    walletId: wallet.id,
    cfg: params.config,
    env,
  });
  if (!allowedRoles.includes(role as WalletActionSelectionRole)) {
    throw new WalletActionSelectionError(
      "wallet_role_not_allowed",
      `wallet ${wallet.name} (${wallet.id}) is ${role}; allowed wallet roles: ${allowedRoles.join(", ")}`,
    );
  }

  return {
    walletId: wallet.id,
    walletName: wallet.name,
    providerId: wallet.providerId,
    source: selection.source,
    role: role as WalletActionSelectionRole,
    walletHandle: `@wallet:${wallet.id}`,
  };
}

export function resolveAgentWalletSelection(params: {
  config?: FasedAgentConfig;
  env?: NodeJS.ProcessEnv;
  walletHandle?: string;
  walletId?: string;
  walletName?: string;
  providerId?: WalletProviderId;
  agentId?: string;
  skillWalletId?: string;
}): AgentWalletSelection {
  const selection = resolveWalletActionSelection({
    ...params,
    allowedRoles: ["agent"],
  });
  return {
    ...selection,
    role: "agent",
  };
}
