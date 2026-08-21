import type { PluginRuntime } from "fased/plugin-sdk/slack";
import { handleSlackAction } from "../../../src/agents/tools/slack-actions.js";
import {
  listSlackDirectoryGroupsLive,
  listSlackDirectoryPeersLive,
} from "../../../src/slack/directory-live.js";
import { monitorSlackProvider } from "../../../src/slack/index.js";
import { probeSlack } from "../../../src/slack/probe.js";
import { resolveSlackChannelAllowlist } from "../../../src/slack/resolve-channels.js";
import { resolveSlackUserAllowlist } from "../../../src/slack/resolve-users.js";
import { sendMessageSlack } from "../../../src/slack/send.js";

let runtime: PluginRuntime | null = null;

export function setSlackRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getSlackRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Slack runtime not initialized");
  }
  return {
    ...runtime,
    channel: {
      ...runtime.channel,
      slack: Object.assign(
        {
          listDirectoryGroupsLive: listSlackDirectoryGroupsLive,
          listDirectoryPeersLive: listSlackDirectoryPeersLive,
          probeSlack,
          resolveChannelAllowlist: resolveSlackChannelAllowlist,
          resolveUserAllowlist: resolveSlackUserAllowlist,
          sendMessageSlack,
          monitorSlackProvider,
          handleSlackAction,
        },
        runtime.channel.slack,
      ),
    },
  };
}
