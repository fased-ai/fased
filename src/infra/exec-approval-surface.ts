import { isGatewayMessageChannel, normalizeMessageChannel } from "../utils/message-channel.js";

export type ExecApprovalInitiatingSurfaceState =
  | {
      kind: "active";
      channel?: string;
      channelLabel?: string;
      accountId?: string;
    }
  | {
      kind: "disabled";
      channel?: string;
      channelLabel?: string;
      accountId?: string;
    }
  | {
      kind: "unsupported";
      channel?: string;
      channelLabel?: string;
      accountId?: string;
    };

type ExecApprovalDmConfig = {
  enabled?: boolean;
  approvers?: Array<string | number>;
  target?: "dm" | "channel" | "both";
};

type DiscordExecApprovalConfigLike = {
  execApprovals?: ExecApprovalDmConfig;
  accounts?: Record<string, { execApprovals?: ExecApprovalDmConfig } | undefined>;
};

type ConfigLike = {
  channels?: {
    discord?: DiscordExecApprovalConfigLike;
  };
};

function hasEnabledDmRoute(config?: ExecApprovalDmConfig): boolean {
  const target = config?.target ?? "channel";
  return Boolean(
    config?.enabled === true &&
    (config.approvers?.length ?? 0) > 0 &&
    (target === "dm" || target === "both"),
  );
}

export function hasConfiguredExecApprovalDmRoute(config: ConfigLike): boolean {
  const discord = config.channels?.discord;
  if (!discord) {
    return false;
  }
  if (hasEnabledDmRoute(discord.execApprovals)) {
    return true;
  }
  return Object.values(discord.accounts ?? {}).some((account) =>
    hasEnabledDmRoute(account?.execApprovals),
  );
}

export function resolveExecApprovalInitiatingSurfaceState(params: {
  channel?: string | null;
  accountId?: string | null;
}): ExecApprovalInitiatingSurfaceState {
  const channel = normalizeMessageChannel(params.channel);
  const accountId = params.accountId?.trim() || undefined;
  const channelLabel = channel ? channel[0]?.toUpperCase() + channel.slice(1) : undefined;
  if (!channel) {
    return { kind: "active", ...(accountId ? { accountId } : {}) };
  }
  if (!isGatewayMessageChannel(channel)) {
    return {
      kind: "unsupported",
      channel,
      channelLabel,
      ...(accountId ? { accountId } : {}),
    };
  }
  return {
    kind: "active",
    channel,
    channelLabel,
    ...(accountId ? { accountId } : {}),
  };
}
