import type { FasedAgentConfig } from "../../config/config.js";
import type { ResolvedWalletRuntimeConfig } from "../../wallet/wallet-runtime-config.js";

/**
 * Legacy shape retained only so old configuration can be decoded and removed.
 * Skill files no longer receive wallet authority from this data.
 */
export type WalletSkillPermissionConfig = {
  actions?: string[];
  roles?: string[];
  walletIds?: string[];
  chains?: string[];
  registries?: string[];
  inputMints?: string[];
  outputMints?: string[];
  maxAmount?: string;
  maxSlippageBps?: number;
  autonomous?: boolean;
  cron?: boolean;
};

export type WalletSkillActionName =
  | "prepare"
  | "send"
  | "plan"
  | "quote"
  | "swap"
  | "schedule_plan"
  | "schedule_send"
  | "limit_order"
  | "limit_cancel"
  | "limit_history";

export function readSkillWalletActionPermissions(
  _cfg: FasedAgentConfig | undefined,
  _skillId: string | null | undefined,
): WalletSkillPermissionConfig | null {
  return null;
}

function denySkillWalletAuthority(skillId: string | null | undefined): void {
  if (skillId?.trim()) {
    throw new Error("wallet_action_skill_authority_removed");
  }
}

export function enforceWalletSkillAccessEnabled(params: {
  wallet: ResolvedWalletRuntimeConfig;
  requesterSkillId?: string | null;
}): void {
  denySkillWalletAuthority(params.requesterSkillId);
}

export async function enforceWalletSkillPolicy(params: {
  cfg?: FasedAgentConfig;
  permissions: WalletSkillPermissionConfig | null;
  requesterAgentId?: string | null;
  requesterSkillId?: string | null;
  action: WalletSkillActionName;
  role?: "agent";
  walletId?: string;
  chain?: "solana";
  inputMint?: string;
  outputMint?: string;
  amount?: string;
  slippageBps?: number;
  autonomous: boolean;
  scheduled: boolean;
  requireManifest: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  denySkillWalletAuthority(params.requesterSkillId);
}
