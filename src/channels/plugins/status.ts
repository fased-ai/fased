import type { FasedAgentConfig } from "../../config/config.js";
import { projectSafeChannelAccountSnapshotFields } from "../account-snapshot-fields.js";
import type { ChannelAccountSnapshot, ChannelPlugin } from "./types.js";

// Channel docking: status snapshots flow through plugin.status hooks here.
export async function buildChannelAccountSnapshot<ResolvedAccount>(params: {
  plugin: ChannelPlugin<ResolvedAccount>;
  cfg: FasedAgentConfig;
  accountId: string;
  runtime?: ChannelAccountSnapshot;
  probe?: unknown;
  audit?: unknown;
}): Promise<ChannelAccountSnapshot> {
  const account = params.plugin.config.resolveAccount(params.cfg, params.accountId);
  if (params.plugin.status?.buildAccountSnapshot) {
    return await params.plugin.status.buildAccountSnapshot({
      account,
      cfg: params.cfg,
      runtime: params.runtime,
      probe: params.probe,
      audit: params.audit,
    });
  }
  const enabled = params.plugin.config.isEnabled
    ? params.plugin.config.isEnabled(account, params.cfg)
    : account && typeof account === "object"
      ? (account as { enabled?: boolean }).enabled
      : undefined;
  const configured = params.plugin.config.isConfigured
    ? await params.plugin.config.isConfigured(account, params.cfg)
    : undefined;
  return {
    accountId: params.accountId,
    ...projectSafeChannelAccountSnapshotFields(account),
    enabled,
    configured,
  };
}
