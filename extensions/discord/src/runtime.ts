import type { PluginRuntime } from "fased/plugin-sdk/discord";
import { discordMessageActions } from "../../../src/channels/plugins/actions/discord.js";
import { auditDiscordChannelPermissions } from "../../../src/discord/audit.js";
import {
  listDiscordDirectoryGroupsLive,
  listDiscordDirectoryPeersLive,
} from "../../../src/discord/directory-live.js";
import { monitorDiscordProvider } from "../../../src/discord/monitor.js";
import { probeDiscord } from "../../../src/discord/probe.js";
import { resolveDiscordChannelAllowlist } from "../../../src/discord/resolve-channels.js";
import { resolveDiscordUserAllowlist } from "../../../src/discord/resolve-users.js";
import { sendMessageDiscord, sendPollDiscord } from "../../../src/discord/send.js";

let runtime: PluginRuntime | null = null;

export function setDiscordRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getDiscordRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Discord runtime not initialized");
  }
  return {
    ...runtime,
    channel: {
      ...runtime.channel,
      discord: Object.assign(
        {
          messageActions: discordMessageActions,
          auditChannelPermissions: auditDiscordChannelPermissions,
          listDirectoryGroupsLive: listDiscordDirectoryGroupsLive,
          listDirectoryPeersLive: listDiscordDirectoryPeersLive,
          probeDiscord,
          resolveChannelAllowlist: resolveDiscordChannelAllowlist,
          resolveUserAllowlist: resolveDiscordUserAllowlist,
          sendMessageDiscord,
          sendPollDiscord,
          monitorDiscordProvider,
        },
        runtime.channel.discord,
      ),
    },
  };
}
