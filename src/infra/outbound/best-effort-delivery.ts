import {
  isDeliverableMessageChannel,
  normalizeMessageChannel,
} from "../../utils/message-channel.js";

export type ExternalBestEffortDeliveryTarget = {
  deliver: boolean;
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number;
};

export function resolveExternalBestEffortDeliveryTarget(params: {
  channel?: string | null;
  to?: string | null;
  accountId?: string | null;
  threadId?: string | number | null;
}): ExternalBestEffortDeliveryTarget {
  const channel = normalizeMessageChannel(params.channel);
  const to = params.to?.trim();
  if (!channel || !to || !isDeliverableMessageChannel(channel)) {
    return { deliver: false };
  }
  return {
    deliver: true,
    channel,
    to,
    ...(params.accountId?.trim() ? { accountId: params.accountId.trim() } : {}),
    ...(params.threadId !== undefined && params.threadId !== null
      ? { threadId: params.threadId }
      : {}),
  };
}
