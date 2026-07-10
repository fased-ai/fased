import type { TopLevelComponents } from "@buape/carbon";
import type { ChannelId } from "../../channels/plugins/types.js";
import type { FasedAgentConfig } from "../../config/config.js";

export type CrossContextComponentsBuilder = (message: string) => TopLevelComponents[];

export type CrossContextComponentsFactory = (params: {
  originLabel: string;
  message: string;
  cfg: FasedAgentConfig;
  accountId?: string | null;
}) => TopLevelComponents[];

export type ChannelMessageAdapter = {
  supportsComponentsV2: boolean;
  buildCrossContextComponents?: CrossContextComponentsFactory;
};

const DEFAULT_ADAPTER: ChannelMessageAdapter = {
  supportsComponentsV2: false,
};

export async function loadChannelMessageAdapter(
  channel: ChannelId,
): Promise<ChannelMessageAdapter> {
  if (channel === "discord") {
    const { discordChannelMessageAdapter } = await import("./channel-adapters.discord.js");
    return discordChannelMessageAdapter;
  }
  return DEFAULT_ADAPTER;
}
