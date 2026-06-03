import { createAccountListHelpers } from "../channels/plugins/account-helpers.js";
import type { FasedAgentConfig } from "../config/config.js";
import type { IMessageAccountConfig } from "../config/types.js";
import { resolveAccountEntry } from "../routing/account-lookup.js";
import { normalizeAccountId } from "../routing/session-key.js";

export type ResolvedIMessageAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  config: IMessageAccountConfig;
  configured: boolean;
};

const { listAccountIds, resolveDefaultAccountId } = createAccountListHelpers("imessage");
export const listIMessageAccountIds = listAccountIds;
export const resolveDefaultIMessageAccountId = resolveDefaultAccountId;

function resolveAccountConfig(
  cfg: FasedAgentConfig,
  accountId: string,
): IMessageAccountConfig | undefined {
  return resolveAccountEntry(cfg.channels?.imessage?.accounts, accountId);
}

function mergeIMessageAccountConfig(
  cfg: FasedAgentConfig,
  accountId: string,
): IMessageAccountConfig {
  const { accounts: _ignored, ...base } = (cfg.channels?.imessage ??
    {}) as IMessageAccountConfig & { accounts?: unknown };
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account };
}

export function resolveIMessageAccount(params: {
  cfg: FasedAgentConfig;
  accountId?: string | null;
}): ResolvedIMessageAccount {
  const accountId = normalizeAccountId(params.accountId);
  const baseEnabled = params.cfg.channels?.imessage?.enabled !== false;
  const merged = mergeIMessageAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const configured = Boolean(merged.cliPath?.trim() || merged.dbPath?.trim());
  return {
    accountId,
    enabled: baseEnabled && accountEnabled,
    name: merged.name?.trim() || undefined,
    config: merged,
    configured,
  };
}

export function listEnabledIMessageAccounts(cfg: FasedAgentConfig): ResolvedIMessageAccount[] {
  return listIMessageAccountIds(cfg)
    .map((accountId) => resolveIMessageAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
