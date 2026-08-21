import { createRequire } from "node:module";
import { resolveEffectiveMessagesConfig, resolveHumanDelayConfig } from "../../agents/identity.js";
import { createMemoryGetTool, createMemorySearchTool } from "../../agents/tools/memory-tool.js";
import {
  chunkByNewline,
  chunkMarkdownText,
  chunkMarkdownTextWithMode,
  chunkText,
  chunkTextWithMode,
  resolveChunkMode,
  resolveTextChunkLimit,
} from "../../auto-reply/chunk.js";
import {
  hasControlCommand,
  isControlCommandMessage,
  shouldComputeCommandAuthorized,
} from "../../auto-reply/command-detection.js";
import { shouldHandleTextCommands } from "../../auto-reply/commands-policy.js";
import { withReplyDispatcher } from "../../auto-reply/dispatch.js";
import {
  formatAgentEnvelope,
  formatInboundEnvelope,
  resolveEnvelopeFormatOptions,
} from "../../auto-reply/envelope.js";
import {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "../../auto-reply/inbound-debounce.js";
import { dispatchReplyFromConfig } from "../../auto-reply/reply/dispatch-from-config.js";
import { finalizeInboundContext } from "../../auto-reply/reply/inbound-context.js";
import {
  buildMentionRegexes,
  matchesMentionPatterns,
  matchesMentionWithExplicit,
} from "../../auto-reply/reply/mentions.js";
import { dispatchReplyWithBufferedBlockDispatcher } from "../../auto-reply/reply/provider-dispatcher.js";
import { createReplyDispatcherWithTyping } from "../../auto-reply/reply/reply-dispatcher.js";
import { removeAckReactionAfterReply, shouldAckReaction } from "../../channels/ack-reactions.js";
import { resolveCommandAuthorizedFromAuthorizers } from "../../channels/command-gating.js";
import { discordMessageActions } from "../../channels/plugins/actions/discord.js";
import { signalMessageActions } from "../../channels/plugins/actions/signal.js";
import { telegramMessageActions } from "../../channels/plugins/actions/telegram.js";
import { createWhatsAppLoginTool } from "../../channels/plugins/agent-tools/whatsapp-login.js";
import { recordInboundSession } from "../../channels/session.js";
import { registerMemoryCli } from "../../cli/memory-cli.js";
import { loadConfig, writeConfigFile } from "../../config/config.js";
import {
  resolveChannelGroupPolicy,
  resolveChannelGroupRequireMention,
} from "../../config/group-policy.js";
import { resolveMarkdownTableMode } from "../../config/markdown-tables.js";
import { resolveStateDir } from "../../config/paths.js";
import {
  readSessionUpdatedAt,
  recordSessionMetaFromInbound,
  resolveStorePath,
  updateLastRoute,
} from "../../config/sessions.js";
import { shouldLogVerbose } from "../../globals.js";
import { monitorIMessageProvider } from "../../imessage/monitor.js";
import { probeIMessage } from "../../imessage/probe.js";
import { sendMessageIMessage } from "../../imessage/send.js";
import { getChannelActivity, recordChannelActivity } from "../../infra/channel-activity.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { getChildLogger } from "../../logging.js";
import { normalizeLogLevel } from "../../logging/levels.js";
import { convertMarkdownTables } from "../../markdown/tables.js";
import { isVoiceCompatibleAudio } from "../../media/audio.js";
import { mediaKindFromMime } from "../../media/constants.js";
import { fetchRemoteMedia } from "../../media/fetch.js";
import { getImageMetadata, resizeToJpeg } from "../../media/image-ops.js";
import { detectMime } from "../../media/mime.js";
import { saveMediaBuffer } from "../../media/store.js";
import { buildPairingReply } from "../../pairing/pairing-messages.js";
import {
  readChannelAllowFromStore,
  upsertChannelPairingRequest,
} from "../../pairing/pairing-store.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { resolveAgentRoute } from "../../routing/resolve-route.js";
import { monitorSignalProvider } from "../../signal/index.js";
import { probeSignal } from "../../signal/probe.js";
import { sendMessageSignal } from "../../signal/send.js";
import {
  auditTelegramGroupMembership,
  collectTelegramUnmentionedGroupIds,
} from "../../telegram/audit.js";
import { resolveTelegramToken } from "../../telegram/token.js";
import { textToSpeechTelephony } from "../../tts/tts.js";
import { getActiveWebListener } from "../../web/active-listener.js";
import {
  getWebAuthAgeMs,
  logoutWeb,
  logWebSelfId,
  readWebSelfId,
  webAuthExists,
} from "../../web/auth-store.js";
import { loadWebMedia } from "../../web/media.js";
import { formatNativeDependencyHint } from "./native-deps.js";
import { createRuntimeHelpers, type PluginRuntimeOptions } from "./scoped.js";
import type { PluginRuntime } from "./types.js";

let cachedVersion: string | null = null;

function lineComponentRequired(): never {
  throw new Error("LINE managed component is not installed");
}

const unavailableLineRuntime: PluginRuntime["channel"]["line"] = {
  listLineAccountIds: () => lineComponentRequired(),
  resolveDefaultLineAccountId: () => lineComponentRequired(),
  resolveLineAccount: () => lineComponentRequired(),
  normalizeAccountId: () => lineComponentRequired(),
  probeLineBot: () => lineComponentRequired(),
  sendMessageLine: () => lineComponentRequired(),
  pushMessageLine: () => lineComponentRequired(),
  pushMessagesLine: () => lineComponentRequired(),
  pushFlexMessage: () => lineComponentRequired(),
  pushTemplateMessage: () => lineComponentRequired(),
  pushLocationMessage: () => lineComponentRequired(),
  pushTextMessageWithQuickReplies: () => lineComponentRequired(),
  createQuickReplyItems: () => lineComponentRequired(),
  buildTemplateMessageFromPayload: () => lineComponentRequired(),
  monitorLineProvider: () => lineComponentRequired(),
};

function resolveVersion(): string {
  if (cachedVersion) {
    return cachedVersion;
  }
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../../../package.json") as { version?: string };
    cachedVersion = pkg.version ?? "unknown";
    return cachedVersion;
  } catch {
    cachedVersion = "unknown";
    return cachedVersion;
  }
}

const sendMessageWhatsAppLazy: PluginRuntime["channel"]["whatsapp"]["sendMessageWhatsApp"] = async (
  ...args
) => {
  const { sendMessageWhatsApp } = await loadWebOutbound();
  return sendMessageWhatsApp(...args);
};

const sendPollWhatsAppLazy: PluginRuntime["channel"]["whatsapp"]["sendPollWhatsApp"] = async (
  ...args
) => {
  const { sendPollWhatsApp } = await loadWebOutbound();
  return sendPollWhatsApp(...args);
};

const loginWebLazy: PluginRuntime["channel"]["whatsapp"]["loginWeb"] = async (...args) => {
  const { loginWeb } = await loadWebLogin();
  return loginWeb(...args);
};

const startWebLoginWithQrLazy: PluginRuntime["channel"]["whatsapp"]["startWebLoginWithQr"] = async (
  ...args
) => {
  const { startWebLoginWithQr } = await loadWebLoginQr();
  return startWebLoginWithQr(...args);
};

const waitForWebLoginLazy: PluginRuntime["channel"]["whatsapp"]["waitForWebLogin"] = async (
  ...args
) => {
  const { waitForWebLogin } = await loadWebLoginQr();
  return waitForWebLogin(...args);
};

const monitorWebChannelLazy: PluginRuntime["channel"]["whatsapp"]["monitorWebChannel"] = async (
  ...args
) => {
  const { monitorWebChannel } = await loadWebChannel();
  return monitorWebChannel(...args);
};

const handleWhatsAppActionLazy: PluginRuntime["channel"]["whatsapp"]["handleWhatsAppAction"] =
  async (...args) => {
    const { handleWhatsAppAction } = await loadWhatsAppActions();
    return handleWhatsAppAction(...args);
  };

const auditDiscordChannelPermissionsLazy: PluginRuntime["channel"]["discord"]["auditChannelPermissions"] =
  async (...args) => {
    const { auditDiscordChannelPermissions } = await import("../../discord/audit.js");
    return auditDiscordChannelPermissions(...args);
  };

const listDiscordDirectoryGroupsLiveLazy: PluginRuntime["channel"]["discord"]["listDirectoryGroupsLive"] =
  async (...args) => {
    const { listDiscordDirectoryGroupsLive } = await import("../../discord/directory-live.js");
    return listDiscordDirectoryGroupsLive(...args);
  };

const listDiscordDirectoryPeersLiveLazy: PluginRuntime["channel"]["discord"]["listDirectoryPeersLive"] =
  async (...args) => {
    const { listDiscordDirectoryPeersLive } = await import("../../discord/directory-live.js");
    return listDiscordDirectoryPeersLive(...args);
  };

const probeDiscordLazy: PluginRuntime["channel"]["discord"]["probeDiscord"] = async (...args) => {
  const { probeDiscord } = await import("../../discord/probe.js");
  return probeDiscord(...args);
};

const resolveDiscordChannelAllowlistLazy: PluginRuntime["channel"]["discord"]["resolveChannelAllowlist"] =
  async (...args) => {
    const { resolveDiscordChannelAllowlist } = await import("../../discord/resolve-channels.js");
    return resolveDiscordChannelAllowlist(...args);
  };

const resolveDiscordUserAllowlistLazy: PluginRuntime["channel"]["discord"]["resolveUserAllowlist"] =
  async (...args) => {
    const { resolveDiscordUserAllowlist } = await import("../../discord/resolve-users.js");
    return resolveDiscordUserAllowlist(...args);
  };

const sendMessageDiscordLazy: PluginRuntime["channel"]["discord"]["sendMessageDiscord"] = async (
  ...args
) => {
  const { sendMessageDiscord } = await import("../../discord/send.js");
  return sendMessageDiscord(...args);
};

const sendPollDiscordLazy: PluginRuntime["channel"]["discord"]["sendPollDiscord"] = async (
  ...args
) => {
  const { sendPollDiscord } = await import("../../discord/send.js");
  return sendPollDiscord(...args);
};

const monitorDiscordProviderLazy: PluginRuntime["channel"]["discord"]["monitorDiscordProvider"] =
  async (...args) => {
    const { monitorDiscordProvider } = await import("../../discord/monitor.js");
    return monitorDiscordProvider(...args);
  };

const listSlackDirectoryGroupsLiveLazy: PluginRuntime["channel"]["slack"]["listDirectoryGroupsLive"] =
  async (...args) => {
    const { listSlackDirectoryGroupsLive } = await import("../../slack/directory-live.js");
    return listSlackDirectoryGroupsLive(...args);
  };

const listSlackDirectoryPeersLiveLazy: PluginRuntime["channel"]["slack"]["listDirectoryPeersLive"] =
  async (...args) => {
    const { listSlackDirectoryPeersLive } = await import("../../slack/directory-live.js");
    return listSlackDirectoryPeersLive(...args);
  };

const probeSlackLazy: PluginRuntime["channel"]["slack"]["probeSlack"] = async (...args) => {
  const { probeSlack } = await import("../../slack/probe.js");
  return probeSlack(...args);
};

const resolveSlackChannelAllowlistLazy: PluginRuntime["channel"]["slack"]["resolveChannelAllowlist"] =
  async (...args) => {
    const { resolveSlackChannelAllowlist } = await import("../../slack/resolve-channels.js");
    return resolveSlackChannelAllowlist(...args);
  };

const resolveSlackUserAllowlistLazy: PluginRuntime["channel"]["slack"]["resolveUserAllowlist"] =
  async (...args) => {
    const { resolveSlackUserAllowlist } = await import("../../slack/resolve-users.js");
    return resolveSlackUserAllowlist(...args);
  };

const sendMessageSlackLazy: PluginRuntime["channel"]["slack"]["sendMessageSlack"] = async (
  ...args
) => {
  const { sendMessageSlack } = await import("../../slack/send.js");
  return sendMessageSlack(...args);
};

const monitorSlackProviderLazy: PluginRuntime["channel"]["slack"]["monitorSlackProvider"] = async (
  ...args
) => {
  const { monitorSlackProvider } = await import("../../slack/index.js");
  return monitorSlackProvider(...args);
};

const handleSlackActionLazy: PluginRuntime["channel"]["slack"]["handleSlackAction"] = async (
  ...args
) => {
  const { handleSlackAction } = await import("../../agents/tools/slack-actions.js");
  return handleSlackAction(...args);
};

const probeTelegramLazy: PluginRuntime["channel"]["telegram"]["probeTelegram"] = async (
  ...args
) => {
  const { probeTelegram } = await import("../../telegram/probe.js");
  return probeTelegram(...args);
};

const sendMessageTelegramLazy: PluginRuntime["channel"]["telegram"]["sendMessageTelegram"] = async (
  ...args
) => {
  const { sendMessageTelegram } = await import("../../telegram/send.js");
  return sendMessageTelegram(...args);
};

const sendPollTelegramLazy: PluginRuntime["channel"]["telegram"]["sendPollTelegram"] = async (
  ...args
) => {
  const { sendPollTelegram } = await import("../../telegram/send.js");
  return sendPollTelegram(...args);
};

const monitorTelegramProviderLazy: PluginRuntime["channel"]["telegram"]["monitorTelegramProvider"] =
  async (...args) => {
    const { monitorTelegramProvider } = await import("../../telegram/monitor.js");
    return monitorTelegramProvider(...args);
  };

let webOutboundPromise: Promise<typeof import("../../web/outbound.js")> | null = null;
let webLoginPromise: Promise<typeof import("../../web/login.js")> | null = null;
let webLoginQrPromise: Promise<typeof import("../../web/login-qr.js")> | null = null;
let webChannelPromise: Promise<typeof import("../../channels/web/index.js")> | null = null;
let whatsappActionsPromise: Promise<
  typeof import("../../agents/tools/whatsapp-actions.js")
> | null = null;

function loadWebOutbound() {
  webOutboundPromise ??= import("../../web/outbound.js");
  return webOutboundPromise;
}

function loadWebLogin() {
  webLoginPromise ??= import("../../web/login.js");
  return webLoginPromise;
}

function loadWebLoginQr() {
  webLoginQrPromise ??= import("../../web/login-qr.js");
  return webLoginQrPromise;
}

function loadWebChannel() {
  webChannelPromise ??= import("../../channels/web/index.js");
  return webChannelPromise;
}

function loadWhatsAppActions() {
  whatsappActionsPromise ??= import("../../agents/tools/whatsapp-actions.js");
  return whatsappActionsPromise;
}

export function createPluginRuntime(options: PluginRuntimeOptions = {}): PluginRuntime {
  return {
    version: resolveVersion(),
    config: createRuntimeConfig(),
    system: createRuntimeSystem(),
    media: createRuntimeMedia(),
    tts: { textToSpeechTelephony },
    tools: createRuntimeTools(),
    channel: createRuntimeChannel(),
    logging: createRuntimeLogging(),
    state: { resolveStateDir },
    helpers: createRuntimeHelpers(options),
  };
}

function createRuntimeConfig(): PluginRuntime["config"] {
  return {
    loadConfig,
    writeConfigFile,
  };
}

function createRuntimeSystem(): PluginRuntime["system"] {
  return {
    enqueueSystemEvent,
    runCommandWithTimeout,
    formatNativeDependencyHint,
  };
}

function createRuntimeMedia(): PluginRuntime["media"] {
  return {
    loadWebMedia,
    detectMime,
    mediaKindFromMime,
    isVoiceCompatibleAudio,
    getImageMetadata,
    resizeToJpeg,
  };
}

function createRuntimeTools(): PluginRuntime["tools"] {
  return {
    createMemoryGetTool,
    createMemorySearchTool,
    registerMemoryCli,
  };
}

function createRuntimeChannel(): PluginRuntime["channel"] {
  return {
    text: {
      chunkByNewline,
      chunkMarkdownText,
      chunkMarkdownTextWithMode,
      chunkText,
      chunkTextWithMode,
      resolveChunkMode,
      resolveTextChunkLimit,
      hasControlCommand,
      resolveMarkdownTableMode,
      convertMarkdownTables,
    },
    reply: {
      dispatchReplyWithBufferedBlockDispatcher,
      createReplyDispatcherWithTyping,
      resolveEffectiveMessagesConfig,
      resolveHumanDelayConfig,
      dispatchReplyFromConfig,
      withReplyDispatcher,
      finalizeInboundContext,
      formatAgentEnvelope,
      /** @deprecated Prefer `BodyForAgent` + structured user-context blocks (do not build plaintext envelopes for prompts). */
      formatInboundEnvelope,
      resolveEnvelopeFormatOptions,
    },
    routing: {
      resolveAgentRoute,
    },
    pairing: {
      buildPairingReply,
      readAllowFromStore: ({ channel, accountId, env }) =>
        readChannelAllowFromStore(channel, env, accountId),
      upsertPairingRequest: ({ channel, id, accountId, meta, env, pairingAdapter }) =>
        upsertChannelPairingRequest({
          channel,
          id,
          accountId,
          meta,
          env,
          pairingAdapter,
        }),
    },
    media: {
      fetchRemoteMedia,
      saveMediaBuffer,
    },
    activity: {
      record: recordChannelActivity,
      get: getChannelActivity,
    },
    session: {
      resolveStorePath,
      readSessionUpdatedAt,
      recordSessionMetaFromInbound,
      recordInboundSession,
      updateLastRoute,
    },
    mentions: {
      buildMentionRegexes,
      matchesMentionPatterns,
      matchesMentionWithExplicit,
    },
    reactions: {
      shouldAckReaction,
      removeAckReactionAfterReply,
    },
    groups: {
      resolveGroupPolicy: resolveChannelGroupPolicy,
      resolveRequireMention: resolveChannelGroupRequireMention,
    },
    debounce: {
      createInboundDebouncer,
      resolveInboundDebounceMs,
    },
    commands: {
      resolveCommandAuthorizedFromAuthorizers,
      isControlCommandMessage,
      shouldComputeCommandAuthorized,
      shouldHandleTextCommands,
    },
    discord: {
      messageActions: discordMessageActions,
      auditChannelPermissions: auditDiscordChannelPermissionsLazy,
      listDirectoryGroupsLive: listDiscordDirectoryGroupsLiveLazy,
      listDirectoryPeersLive: listDiscordDirectoryPeersLiveLazy,
      probeDiscord: probeDiscordLazy,
      resolveChannelAllowlist: resolveDiscordChannelAllowlistLazy,
      resolveUserAllowlist: resolveDiscordUserAllowlistLazy,
      sendMessageDiscord: sendMessageDiscordLazy,
      sendPollDiscord: sendPollDiscordLazy,
      monitorDiscordProvider: monitorDiscordProviderLazy,
    },
    slack: {
      listDirectoryGroupsLive: listSlackDirectoryGroupsLiveLazy,
      listDirectoryPeersLive: listSlackDirectoryPeersLiveLazy,
      probeSlack: probeSlackLazy,
      resolveChannelAllowlist: resolveSlackChannelAllowlistLazy,
      resolveUserAllowlist: resolveSlackUserAllowlistLazy,
      sendMessageSlack: sendMessageSlackLazy,
      monitorSlackProvider: monitorSlackProviderLazy,
      handleSlackAction: handleSlackActionLazy,
    },
    telegram: {
      auditGroupMembership: auditTelegramGroupMembership,
      collectUnmentionedGroupIds: collectTelegramUnmentionedGroupIds,
      probeTelegram: probeTelegramLazy,
      resolveTelegramToken,
      sendMessageTelegram: sendMessageTelegramLazy,
      sendPollTelegram: sendPollTelegramLazy,
      monitorTelegramProvider: monitorTelegramProviderLazy,
      messageActions: telegramMessageActions,
    },
    signal: {
      probeSignal,
      sendMessageSignal,
      monitorSignalProvider,
      messageActions: signalMessageActions,
    },
    imessage: {
      monitorIMessageProvider,
      probeIMessage,
      sendMessageIMessage,
    },
    whatsapp: {
      getActiveWebListener,
      getWebAuthAgeMs,
      logoutWeb,
      logWebSelfId,
      readWebSelfId,
      webAuthExists,
      sendMessageWhatsApp: sendMessageWhatsAppLazy,
      sendPollWhatsApp: sendPollWhatsAppLazy,
      loginWeb: loginWebLazy,
      startWebLoginWithQr: startWebLoginWithQrLazy,
      waitForWebLogin: waitForWebLoginLazy,
      monitorWebChannel: monitorWebChannelLazy,
      handleWhatsAppAction: handleWhatsAppActionLazy,
      createLoginTool: createWhatsAppLoginTool,
    },
    line: {
      ...unavailableLineRuntime,
    },
  };
}

function createRuntimeLogging(): PluginRuntime["logging"] {
  return {
    shouldLogVerbose,
    getChildLogger: (bindings, opts) => {
      const logger = getChildLogger(bindings, {
        level: opts?.level ? normalizeLogLevel(opts.level) : undefined,
      });
      return {
        debug: (message) => logger.debug?.(message),
        info: (message) => logger.info(message),
        warn: (message) => logger.warn(message),
        error: (message) => logger.error(message),
      };
    },
  };
}

export type { PluginRuntime } from "./types.js";
