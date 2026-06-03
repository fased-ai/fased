import { tlonOnboardingAdapter } from "../../../extensions/tlon/src/onboarding.js";
import { zaloOnboardingAdapter } from "../../../extensions/zalo/src/onboarding.js";
import { zalouserOnboardingAdapter } from "../../../extensions/zalouser/src/onboarding.js";
import { listChannelPlugins } from "../../channels/plugins/index.js";
import { blueBubblesOnboardingAdapter } from "../../channels/plugins/onboarding/bluebubbles.js";
import { discordOnboardingAdapter } from "../../channels/plugins/onboarding/discord.js";
import { googleChatOnboardingAdapter } from "../../channels/plugins/onboarding/googlechat.js";
import { imessageOnboardingAdapter } from "../../channels/plugins/onboarding/imessage.js";
import { ircOnboardingAdapter } from "../../channels/plugins/onboarding/irc.js";
import { lineOnboardingAdapter } from "../../channels/plugins/onboarding/line.js";
import { matrixOnboardingAdapter } from "../../channels/plugins/onboarding/matrix.js";
import { mattermostOnboardingAdapter } from "../../channels/plugins/onboarding/mattermost.js";
import { msteamsOnboardingAdapter } from "../../channels/plugins/onboarding/msteams.js";
import { nextcloudTalkOnboardingAdapter } from "../../channels/plugins/onboarding/nextcloud-talk.js";
import { nostrOnboardingAdapter } from "../../channels/plugins/onboarding/nostr.js";
import { signalOnboardingAdapter } from "../../channels/plugins/onboarding/signal.js";
import { slackOnboardingAdapter } from "../../channels/plugins/onboarding/slack.js";
import { synologyChatOnboardingAdapter } from "../../channels/plugins/onboarding/synology-chat.js";
import { telegramOnboardingAdapter } from "../../channels/plugins/onboarding/telegram.js";
import { whatsappOnboardingAdapter } from "../../channels/plugins/onboarding/whatsapp.js";
import type { ChannelChoice } from "../onboard-types.js";
import type { ChannelOnboardingAdapter } from "./types.js";

const BUILTIN_ONBOARDING_ADAPTERS: ChannelOnboardingAdapter[] = [
  telegramOnboardingAdapter,
  whatsappOnboardingAdapter,
  discordOnboardingAdapter,
  googleChatOnboardingAdapter,
  ircOnboardingAdapter,
  slackOnboardingAdapter,
  signalOnboardingAdapter,
  imessageOnboardingAdapter,
  msteamsOnboardingAdapter,
  nostrOnboardingAdapter,
  mattermostOnboardingAdapter,
  nextcloudTalkOnboardingAdapter,
  matrixOnboardingAdapter,
  blueBubblesOnboardingAdapter,
  lineOnboardingAdapter,
  synologyChatOnboardingAdapter,
  tlonOnboardingAdapter,
  zaloOnboardingAdapter,
  zalouserOnboardingAdapter,
];

const CHANNEL_ONBOARDING_ADAPTERS = () => {
  const fromRegistry = listChannelPlugins()
    .map((plugin) => (plugin.onboarding ? ([plugin.id, plugin.onboarding] as const) : null))
    .filter((entry): entry is readonly [ChannelChoice, ChannelOnboardingAdapter] => Boolean(entry));

  // Fall back to built-in adapters to keep onboarding working even when the plugin registry
  // fails to populate (see #25545).
  const fromBuiltins = BUILTIN_ONBOARDING_ADAPTERS.map(
    (adapter) => [adapter.channel, adapter] as const,
  );

  return new Map<ChannelChoice, ChannelOnboardingAdapter>([...fromBuiltins, ...fromRegistry]);
};

export function getChannelOnboardingAdapter(
  channel: ChannelChoice,
): ChannelOnboardingAdapter | undefined {
  return CHANNEL_ONBOARDING_ADAPTERS().get(channel);
}

export function listChannelOnboardingAdapters(): ChannelOnboardingAdapter[] {
  return Array.from(CHANNEL_ONBOARDING_ADAPTERS().values());
}

// Legacy aliases (pre-rename).
export const getProviderOnboardingAdapter = getChannelOnboardingAdapter;
export const listProviderOnboardingAdapters = listChannelOnboardingAdapters;
