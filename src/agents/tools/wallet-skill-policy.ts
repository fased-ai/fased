import path from "node:path";
import type { FasedAgentConfig } from "../../config/config.js";
import type { ResolvedWalletRuntimeConfig } from "../../wallet/wallet-runtime-config.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agent-scope.js";
import { readClawHubSkillOrigin } from "../skills-clawhub.js";

const DEFAULT_WALLET_ACTION_REGISTRIES = ["https://clawhub.com"];
const LOCAL_WALLET_ACTION_SOURCE = "local";

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

function normalizeList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out = value.map((entry) => String(entry).trim()).filter(Boolean);
  return out.length > 0 ? out : undefined;
}

function normalizeRegistryUrl(value: string | undefined): string | null {
  const raw = value?.trim();
  if (!raw) {
    return null;
  }
  try {
    const url = new URL(raw);
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString().replace(/\/+$/, "");
  } catch {
    return raw.replace(/\/+$/, "");
  }
}

function normalizeRegistryList(values: unknown): string[] {
  const rawList = Array.isArray(values) ? values : DEFAULT_WALLET_ACTION_REGISTRIES;
  const registries = rawList
    .map((entry) => normalizeRegistryUrl(String(entry)))
    .filter((entry): entry is string => Boolean(entry));
  return registries.length > 0 ? registries : DEFAULT_WALLET_ACTION_REGISTRIES;
}

function readSkillsMarketplaceAllowRegistries(cfg: FasedAgentConfig | undefined): string[] {
  const raw = cfg?.skills?.marketplace?.allowRegistries;
  return normalizeRegistryList(raw);
}

function normalizeSkillPathId(skillId: string): string | null {
  const id = skillId.trim();
  if (!id || id.includes("/") || id.includes("\\") || id.includes("..")) {
    return null;
  }
  return id;
}

async function readRequesterSkillOrigin(params: {
  cfg?: FasedAgentConfig;
  requesterAgentId?: string | null;
  requesterSkillId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ registry: string; slug: string } | null> {
  const skillPathId = normalizeSkillPathId(params.requesterSkillId);
  if (!skillPathId) {
    return null;
  }
  const cfg = params.cfg ?? {};
  const agentIds = [
    params.requesterAgentId?.trim() || resolveDefaultAgentId(cfg),
    resolveDefaultAgentId(cfg),
  ].filter(Boolean);
  const workspaces = [
    ...new Set(agentIds.map((agentId) => resolveAgentWorkspaceDir(cfg, agentId))),
  ];
  for (const workspaceDir of workspaces) {
    const origin = await readClawHubSkillOrigin(path.join(workspaceDir, "skills", skillPathId));
    if (origin) {
      return {
        registry: origin.registry,
        slug: origin.slug,
      };
    }
  }
  return null;
}

export function readSkillWalletActionPermissions(
  cfg: FasedAgentConfig | undefined,
  skillId: string | null | undefined,
): WalletSkillPermissionConfig | null {
  const id = skillId?.trim();
  if (!id) {
    return null;
  }
  const raw = cfg?.skills?.entries?.[id]?.config?.walletActions;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const value = raw as Record<string, unknown>;
  return {
    actions: normalizeList(value.actions),
    roles: normalizeList(value.roles),
    walletIds: normalizeList(value.walletIds),
    chains: normalizeList(value.chains),
    registries: normalizeList(value.registries),
    inputMints: normalizeList(value.inputMints),
    outputMints: normalizeList(value.outputMints),
    maxAmount:
      typeof value.maxAmount === "string" ? value.maxAmount.trim() || undefined : undefined,
    maxSlippageBps:
      typeof value.maxSlippageBps === "number" && Number.isFinite(value.maxSlippageBps)
        ? Math.floor(value.maxSlippageBps)
        : undefined,
    autonomous: typeof value.autonomous === "boolean" ? value.autonomous : undefined,
    cron: typeof value.cron === "boolean" ? value.cron : undefined,
  };
}

export function enforceWalletSkillAccessEnabled(params: {
  wallet: ResolvedWalletRuntimeConfig;
  requesterSkillId?: string | null;
}): void {
  const skillId = params.requesterSkillId?.trim();
  if (!skillId) {
    return;
  }
  if (!params.wallet.policy.skillsEnabled) {
    throw new Error("wallet_action_skill_wallet_disabled");
  }
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
  const skillId = params.requesterSkillId?.trim() || null;
  if (!skillId) {
    return;
  }
  if (!normalizeSkillPathId(skillId)) {
    throw new Error("wallet_action_skill_invalid_id");
  }
  const permissions = params.permissions;
  if (!permissions) {
    if (params.requireManifest || params.autonomous || params.scheduled) {
      throw new Error("wallet_action_skill_manifest_required");
    }
    return;
  }
  if (!permissions.actions?.length) {
    throw new Error("wallet_action_skill_actions_required");
  }
  if (!permissions.actions.includes(params.action)) {
    throw new Error("wallet_action_skill_action_not_allowed");
  }
  if (params.role) {
    if (!permissions.roles?.length) {
      throw new Error("wallet_action_skill_roles_required");
    }
    if (!permissions.roles.includes(params.role)) {
      throw new Error("wallet_action_skill_role_not_allowed");
    }
  }
  if (!permissions.walletIds?.length) {
    throw new Error("wallet_action_skill_wallet_required");
  }
  if (!params.walletId || !permissions.walletIds.includes(params.walletId)) {
    throw new Error("wallet_action_skill_wallet_not_allowed");
  }
  if (params.chain) {
    if (!permissions.chains?.length) {
      throw new Error("wallet_action_skill_chains_required");
    }
    if (!permissions.chains.includes(params.chain)) {
      throw new Error("wallet_action_skill_chain_not_allowed");
    }
  }
  if (params.inputMint) {
    if (!permissions.inputMints?.length) {
      throw new Error("wallet_action_skill_input_mints_required");
    }
    if (!permissions.inputMints.includes(params.inputMint)) {
      throw new Error("wallet_action_skill_input_mint_not_allowed");
    }
  }
  if (params.outputMint) {
    if (!permissions.outputMints?.length) {
      throw new Error("wallet_action_skill_output_mints_required");
    }
    if (!permissions.outputMints.includes(params.outputMint)) {
      throw new Error("wallet_action_skill_output_mint_not_allowed");
    }
  }
  if (params.amount) {
    if (!permissions.maxAmount) {
      throw new Error("wallet_action_skill_amount_cap_required");
    }
    if (BigInt(params.amount) > BigInt(permissions.maxAmount)) {
      throw new Error("wallet_action_skill_amount_cap_exceeded");
    }
  }
  if (params.slippageBps !== undefined) {
    if (permissions.maxSlippageBps === undefined) {
      throw new Error("wallet_action_skill_slippage_cap_required");
    }
    if (params.slippageBps > permissions.maxSlippageBps) {
      throw new Error("wallet_action_skill_slippage_cap_exceeded");
    }
  }
  if (params.autonomous && permissions.autonomous !== true) {
    throw new Error("wallet_action_skill_autonomous_not_allowed");
  }
  if (params.scheduled && permissions.cron !== true) {
    throw new Error("wallet_action_skill_cron_not_allowed");
  }

  const origin = await readRequesterSkillOrigin({
    cfg: params.cfg,
    requesterAgentId: params.requesterAgentId,
    requesterSkillId: skillId,
    env: params.env,
  });
  if (!origin) {
    const allowedSources = normalizeRegistryList(permissions.registries);
    if (!allowedSources.includes(LOCAL_WALLET_ACTION_SOURCE)) {
      throw new Error("wallet_action_skill_local_source_not_allowed");
    }
    return;
  }
  const allowedRegistries = normalizeRegistryList(
    permissions.registries ?? readSkillsMarketplaceAllowRegistries(params.cfg),
  );
  const registry = normalizeRegistryUrl(origin.registry);
  if (!registry || !allowedRegistries.includes(registry)) {
    throw new Error("wallet_action_skill_registry_not_allowlisted");
  }
}
