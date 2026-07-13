import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { ChannelsStatusSnapshot } from "../types.ts";
import { renderChannels } from "./channels.ts";
import type { ChannelsProps } from "./channels.types.ts";

function normalizeText(node: Element | DocumentFragment): string {
  return node.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

function createSnapshot(): ChannelsStatusSnapshot {
  return {
    ts: 1_700_000_000,
    channelOrder: ["telegram", "discord"],
    channelLabels: { telegram: "Telegram", discord: "Discord" },
    channelDetailLabels: {},
    channelSetup: {
      telegram: {
        title: "Telegram",
        detail: "BotFather token.",
        notes: [
          "1) Open Telegram and chat with @BotFather",
          "2) Run /newbot or /mybots",
          "3) Copy the token, then DM the bot once before starting",
        ],
        fields: [
          {
            label: "Bot token",
            path: ["channels", "telegram", "botToken"],
            placeholder: "123456:ABC...",
            kind: "password",
          },
          {
            label: "Token file",
            path: ["channels", "telegram", "tokenFile"],
            placeholder: "/run/secrets/telegram-token",
          },
        ],
      },
      discord: {
        title: "Discord",
        detail: "Discord bot token.",
        notes: [
          "1) Discord Developer Portal -> Applications -> New Application",
          "2) Bot -> Add Bot -> Reset Token -> copy token",
          "3) OAuth2 -> URL Generator -> scope bot -> invite to your server",
          "Tip: enable Message Content Intent if you need message text.",
        ],
        fields: [
          {
            label: "Bot token",
            path: ["channels", "discord", "token"],
            placeholder: "Bot token",
            kind: "password",
          },
        ],
        access: {
          kind: "discord-channels",
          label: "Discord channels",
          note: "Allowlist Discord server channels, open all channels, or block channel messages.",
          placeholder: "My Server/#general, guildId/channelId, #support",
        },
      },
      signal: {
        title: "Signal",
        detail: "signal-cli account.",
        notes: [
          "Install signal-cli if it is missing.",
          "Set the Signal bot number in E.164 format.",
          'Link device with: signal-cli link -n "FasedAgent"',
          "Scan the QR in Signal -> Linked Devices.",
        ],
        fields: [
          {
            label: "Signal number",
            path: ["channels", "signal", "account"],
            placeholder: "+15551234567",
          },
          {
            label: "CLI path",
            path: ["channels", "signal", "cliPath"],
            placeholder: "signal-cli",
          },
        ],
      },
      imessage: {
        title: "iMessage",
        detail: "macOS imsg bridge.",
        notes: [
          "This is still a work in progress.",
          "Ensure FasedAgent has Full Disk Access to the Messages DB.",
          "Grant Automation permission for Messages when prompted.",
          "List chats with: imsg chats --limit 20",
        ],
        fields: [
          {
            label: "CLI path",
            path: ["channels", "imessage", "cliPath"],
            placeholder: "imsg",
          },
        ],
      },
      whatsapp: {
        title: "WhatsApp",
        detail: "WhatsApp Web QR link.",
        notes: [
          "Scan the QR with WhatsApp on your phone.",
          "Credentials are stored under the WhatsApp account credential directory for future runs.",
        ],
        fields: [],
        access: { kind: "whatsapp-dm" },
      },
      irc: {
        title: "IRC",
        detail: "Server and nick.",
        notes: [
          "Enter the IRC server host and the bot nick to use on that network.",
          "Channels are comma-separated, for example #fased, #ops.",
        ],
        fields: [
          {
            label: "Server host",
            path: ["channels", "irc", "host"],
            placeholder: "irc.libera.chat",
          },
          { label: "Nick", path: ["channels", "irc", "nick"], placeholder: "fased-bot" },
          {
            label: "Channels",
            path: ["channels", "irc", "channels"],
            placeholder: "#fased, #ops",
            kind: "list",
          },
          { label: "Port", path: ["channels", "irc", "port"], placeholder: "6697", kind: "number" },
        ],
        access: {
          kind: "irc-channels",
          label: "IRC channels",
          note: "Allowlist IRC channels, open all channels, or block channel messages.",
          placeholder: "#fased, #ops",
        },
      },
      googlechat: {
        title: "Google Chat",
        detail: "Chat API webhook.",
        notes: [
          "Create a Google Chat app in Google Cloud, enable the Chat API, and create a service account JSON key.",
          "Use the gateway webhook URL or webhook path for inbound Chat events.",
          "Set the audience to the app URL or Google Cloud project number used by the Chat app.",
        ],
        fields: [
          {
            label: "Service account file",
            path: ["channels", "googlechat", "serviceAccountFile"],
            placeholder: "/run/secrets/google-chat-service-account.json",
          },
          {
            label: "Webhook path",
            path: ["channels", "googlechat", "webhookPath"],
            placeholder: "/googlechat",
          },
          {
            label: "Webhook URL",
            path: ["channels", "googlechat", "webhookUrl"],
            placeholder: "https://agent.example.com/googlechat",
          },
          {
            label: "Audience type",
            path: ["channels", "googlechat", "audienceType"],
            kind: "select",
            options: [
              { label: "App URL", value: "app-url" },
              { label: "Project number", value: "project-number" },
            ],
          },
          {
            label: "Audience",
            path: ["channels", "googlechat", "audience"],
            placeholder: "https://agent.example.com/googlechat or 123456789012",
          },
          {
            label: "Bot user",
            path: ["channels", "googlechat", "botUser"],
            placeholder: "users/123456789012345678901",
          },
        ],
      },
      feishu: {
        title: "Feishu",
        detail: "App credentials.",
        notes: [
          "1) Go to Feishu Open Platform (open.feishu.cn)",
          "2) Create a self-built app",
          "3) Get App ID and App Secret from Credentials page",
          "4) Enable required permissions: im:message, im:chat, contact:user.base:readonly",
          "5) Publish the app or add it to a test group",
          "Tip: you can also set FEISHU_APP_ID / FEISHU_APP_SECRET env vars.",
        ],
        fields: [
          {
            label: "App ID",
            path: ["channels", "feishu", "appId"],
            placeholder: "cli_xxxxx",
          },
          {
            label: "App Secret",
            path: ["channels", "feishu", "appSecret"],
            placeholder: "App Secret",
            kind: "password",
          },
          {
            label: "Domain",
            path: ["channels", "feishu", "domain"],
            kind: "select",
            options: [
              { label: "Feishu (China)", value: "feishu" },
              { label: "Lark (International)", value: "lark" },
            ],
          },
          {
            label: "Connection mode",
            path: ["channels", "feishu", "connectionMode"],
            kind: "select",
            options: [
              { label: "WebSocket", value: "websocket" },
              { label: "Webhook", value: "webhook" },
            ],
          },
          {
            label: "Verification token",
            path: ["channels", "feishu", "verificationToken"],
            placeholder: "Required for webhook mode",
            kind: "password",
          },
          {
            label: "Group allowlist",
            path: ["channels", "feishu", "groupAllowFrom"],
            placeholder: "oc_xxxxx, oc_yyyyy",
            kind: "list",
          },
        ],
      },
      slack: {
        title: "Slack",
        detail: "Socket Mode tokens.",
        notes: [
          "1) Slack API -> Create App -> From scratch",
          "2) Add Socket Mode and create the app-level token (xapp-...)",
          "3) OAuth & Permissions -> install app to workspace (xoxb- bot token)",
          "4) Enable Event Subscriptions for message events",
          "5) App Home -> enable the Messages tab for DMs",
        ],
        fields: [
          {
            label: "Bot token",
            path: ["channels", "slack", "botToken"],
            placeholder: "xoxb-...",
            kind: "password",
          },
          {
            label: "App token",
            path: ["channels", "slack", "appToken"],
            placeholder: "xapp-...",
            kind: "password",
          },
        ],
        access: {
          kind: "slack-channels",
          label: "Slack channels",
          note: "Allowlist Slack channels, open all channels, or block channel messages.",
          placeholder: "#general, #private, C123",
        },
      },
    },
    channels: {
      telegram: {
        configured: true,
        running: true,
        connected: true,
        tokenSource: "env",
        mode: "polling",
        probe: { ok: true, status: 200 },
      },
      discord: {
        configured: true,
        running: false,
        connected: false,
        tokenSource: "config",
      },
    },
    channelAccounts: {
      telegram: [
        {
          accountId: "ops",
          name: "Ops Bot",
          configured: true,
          running: true,
          connected: true,
          dmPolicy: "allowlist",
          allowUnmentionedGroups: false,
          tokenSource: "env",
          probe: { bot: { username: "fased_ops_bot" } },
        },
      ],
      discord: [
        {
          accountId: "guild",
          name: "Guild Bot",
          configured: true,
          running: false,
          connected: false,
          dmPolicy: "pairing",
          allowUnmentionedGroups: false,
          tokenSource: "config",
        },
      ],
    },
    channelDefaultAccountId: { telegram: "ops", discord: "guild" },
  };
}

function createProps(overrides: Partial<ChannelsProps> = {}): ChannelsProps {
  return {
    connected: true,
    loading: false,
    snapshot: createSnapshot(),
    lastError: null,
    lastSuccessAt: 1_700_000_000,
    channelRuntimeBusy: {},
    whatsappMessage: null,
    whatsappQrDataUrl: null,
    whatsappConnected: null,
    whatsappBusy: false,
    configSchema: {
      type: "object",
      properties: {
        channels: {
          type: "object",
          properties: {
            telegram: { type: "object", properties: {} },
            discord: { type: "object", properties: {} },
            signal: {
              type: "object",
              properties: {
                enabled: { type: "boolean" },
                account: { type: "string" },
              },
            },
          },
        },
        bindings: { type: "array" },
      },
    },
    configSchemaLoading: false,
    configForm: {
      bindings: [
        { agentId: "support", match: { channel: "telegram", accountId: "ops" } },
        {
          agentId: "research",
          match: { channel: "telegram", accountId: "ops", peer: { kind: "topic", id: "market" } },
        },
        {
          agentId: "research",
          match: { channel: "discord", accountId: "guild", peer: { kind: "channel", id: "dev" } },
        },
      ],
      channels: {
        telegram: { dmPolicy: "allowlist", requireMention: true },
        discord: {
          groupPolicy: "allowlist",
          guilds: { "*": { channels: { general: { allow: true } } } },
          requireMention: true,
        },
      },
    },
    configUiHints: {},
    configSaving: false,
    configFormDirty: false,
    activeView: "accounts",
    nostrProfileFormState: null,
    nostrProfileAccountId: null,
    onViewChange: () => undefined,
    agentsList: {
      defaultId: "main",
      mainKey: "main",
      scope: "workspace",
      agents: [
        { id: "main", name: "Main" },
        { id: "support", name: "Support" },
        { id: "research", name: "Research" },
      ],
    },
    notice: null,
    onRefresh: () => undefined,
    onChannelEnable: () => undefined,
    onChannelStart: () => undefined,
    onChannelStop: () => undefined,
    onChannelInstall: () => undefined,
    onChannelLogout: () => undefined,
    channelQrLogin: {},
    onChannelQrStart: () => undefined,
    onChannelQrWait: () => undefined,
    onWhatsAppStart: () => undefined,
    onWhatsAppWait: () => undefined,
    onWhatsAppLogout: () => undefined,
    onConfigPatch: () => undefined,
    onConfigRemove: () => undefined,
    onConfigSave: () => undefined,
    onConfigReload: () => undefined,
    onNostrProfileEdit: () => undefined,
    onNostrProfileCancel: () => undefined,
    onNostrProfileFieldChange: () => undefined,
    onNostrProfileSave: () => undefined,
    onNostrProfileImport: () => undefined,
    onNostrProfileToggleAdvanced: () => undefined,
    ...overrides,
  };
}

describe("renderChannels", () => {
  it("renders channel rows with status, clear action, and routes", () => {
    const container = document.createElement("div");

    render(renderChannels(createProps()), container);

    const text = normalizeText(container);
    expect(text).toContain("Telegram");
    expect(text).toContain("Discord");
    expect(text).not.toContain("@wallet");
    expect(text).not.toContain("@trade");
    expect(text).not.toContain("@offers");
    expect(text).not.toContain("@mining");
    expect(text).toContain("Route to Agent");
    expect(text).toContain("Support (support)");
    expect(text).toContain("Specific routes");
    expect(text).toContain("Ops Bot -> Research (research)");
    expect(text).toContain("topic market");
    expect(text).toContain("Guild Bot -> Research (research)");
    expect(text).toContain("channel dev");
    expect(text).toContain(
      "Edit topic, thread, guild, or peer-specific routes in Advanced Config bindings.",
    );
    expect(text).toContain("Setup fields");
    expect(text).not.toContain("Unsupported type");
    expect(text).toContain("Start");
    expect(text).toContain("Stop");
    expect(text).toContain("Probe");
    expect(text).not.toContain("ok ·");
    expect(container.querySelector('[aria-label="Clear credentials"]')).not.toBeNull();
  });

  it("shows onboarding-style signup fields for unconfigured channels", () => {
    const container = document.createElement("div");
    const onConfigPatch = vi.fn();
    const snapshot = createSnapshot();
    snapshot.channels.discord = { configured: false, running: false, connected: false };
    snapshot.channelAccounts.discord = [];

    render(renderChannels(createProps({ snapshot, onConfigPatch })), container);

    const discordCard = container.querySelector('[data-channel-card="discord"]');
    expect(discordCard).not.toBeNull();
    const text = normalizeText(discordCard!);
    expect(text).toContain("Discord");
    expect(text).toContain("Bot token");
    expect(text).not.toContain("OAuth2 -> URL Generator -> scope bot -> invite to your server");
    expect(text).toContain("Discord channels access");
    expect(text).toContain("Discord channels allowlist");
    expect(text).toContain("Connect");
    expect(text).not.toContain("Discord DM access");
    expect(text).not.toContain("DM policy");
    expect(text).not.toContain("Route to Agent");
    expect(text).not.toContain("Connect setup");
    expect(text).not.toContain("plugin missing");
    expect(text).not.toContain("install required");
    const discordNotes = discordCard!.querySelector<HTMLElement>(".channel-signup-notes");
    expect(discordNotes?.getAttribute("data-tooltip")).toContain(
      "OAuth2 -> URL Generator -> scope bot -> invite to your server",
    );

    const tokenInput = discordCard!.querySelector<HTMLInputElement>(
      'input[placeholder="Bot token"]',
    );
    expect(tokenInput).not.toBeNull();
    tokenInput!.value = "discord-token";
    tokenInput!.dispatchEvent(new Event("input", { bubbles: true }));

    expect(onConfigPatch).toHaveBeenCalledWith(["channels", "discord", "enabled"], true);
    expect(onConfigPatch).toHaveBeenCalledWith(["channels", "discord", "token"], "discord-token");
  });

  it("shows external npm catalog channels as install-only cards", () => {
    const container = document.createElement("div");
    const onChannelInstall = vi.fn();
    const snapshot = createSnapshot();
    snapshot.channelOrder = ["discord"];
    snapshot.channels.discord = {
      configured: false,
      running: false,
      connected: false,
      catalogOnly: true,
      delivery: "official-addon",
      install: { npmSpec: "@fased/discord" },
    };
    snapshot.channelAccounts.discord = [];

    render(
      renderChannels(createProps({ snapshot, onChannelInstall }), { showDebug: false }),
      container,
    );

    const text = normalizeText(container);
    expect(text).toContain("Discord");
    expect(text).toContain("Install");
    expect(text).toContain("Install the channel plugin, then restart the gateway.");
    expect(text).toContain("fased plugins install @fased/discord");
    expect(text).not.toContain("Bot token");
    expect(text).not.toContain("Reload");
    const discordCard = container.querySelector('[data-channel-card="discord"]');
    expect(discordCard).not.toBeNull();
    Array.from(discordCard!.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.trim() === "Install")
      ?.click();
    expect(onChannelInstall).toHaveBeenCalledWith("discord");
  });

  it("requires bundled local channel installation before setup", () => {
    const container = document.createElement("div");
    const onChannelInstall = vi.fn();
    const snapshot = createSnapshot();
    snapshot.channelOrder = ["feishu"];
    snapshot.channelLabels = { feishu: "Feishu" };
    snapshot.channelDetailLabels = { feishu: "Feishu/Lark" };
    snapshot.channelMeta = [{ id: "feishu", label: "Feishu", detailLabel: "Feishu/Lark" }];
    snapshot.channels = {
      feishu: {
        configured: false,
        running: false,
        connected: false,
        catalogOnly: true,
        delivery: "official-addon",
        install: { localPath: "extensions/feishu", defaultChoice: "local" },
      } as never,
    };
    snapshot.channelAccounts = { feishu: [] };

    render(renderChannels(createProps({ snapshot, onChannelInstall })), container);

    const feishuCard = container.querySelector('[data-channel-card="feishu"]');
    expect(feishuCard).not.toBeNull();
    const text = normalizeText(feishuCard!);
    expect(text).toContain("Install");
    expect(text).toContain("Install the channel plugin, then restart the gateway.");
    expect(text).not.toContain("App ID");
    expect(text).toContain("fased plugins install extensions/feishu");
    expect(text).not.toContain("@fased/feishu");
    expect(
      feishuCard!.querySelector<HTMLButtonElement>('[aria-label="Enable channel"]'),
    ).toBeNull();
    Array.from(feishuCard!.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.trim() === "Install")
      ?.click();
    expect(onChannelInstall).toHaveBeenCalledWith("feishu");
  });

  it("shows restart-required state after a channel plugin is installed but not loaded", () => {
    const container = document.createElement("div");
    const onChannelInstall = vi.fn();
    const snapshot = createSnapshot();
    snapshot.channelOrder = ["discord"];
    snapshot.channels.discord = {
      configured: false,
      running: false,
      connected: false,
      catalogOnly: true,
      delivery: "official-addon",
      pendingRestart: true,
      install: { npmSpec: "@fased/discord" },
    } as never;
    snapshot.channelAccounts.discord = [];

    render(renderChannels(createProps({ snapshot, onChannelInstall })), container);

    const text = normalizeText(container);
    expect(text).toContain("Restart required");
    expect(text).toContain("Installed. Restart the gateway");
    expect(text).not.toContain("plugin missing");
    expect(container.querySelector('[aria-label="Install channel plugin"]')).toBeNull();
  });

  it("blocks catalog-only setup when no install source exists", () => {
    const container = document.createElement("div");
    const onChannelEnable = vi.fn();
    const onConfigPatch = vi.fn();
    const snapshot = createSnapshot();
    snapshot.channelOrder = ["signal"];
    snapshot.channelMeta = [{ id: "signal", label: "Signal", detailLabel: "Signal REST" }];
    snapshot.channelLabels = { signal: "Signal" };
    snapshot.channelDetailLabels = { signal: "Signal REST" };
    snapshot.channels = {
      signal: {
        configured: false,
        running: false,
        connected: false,
        catalogOnly: true,
        delivery: "external-prerequisite",
      } as never,
    };
    snapshot.channelAccounts = { signal: [] };

    render(renderChannels(createProps({ snapshot, onChannelEnable, onConfigPatch })), container);

    const signalCard = container.querySelector('[data-channel-card="signal"]');
    expect(signalCard).not.toBeNull();
    const text = normalizeText(signalCard!);
    expect(text).toContain("External prerequisite");
    expect(text).not.toContain("Signal number");
    expect(text).not.toContain("CLI path");
    expect(text).not.toContain("Install signal-cli if it is missing.");
    expect(text).not.toContain("plugin disabled");
    expect(text).not.toContain("plugin missing");
    expect(text).not.toContain("Route to Agent");
    expect(text).not.toContain("Connect");
    const enable = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === "Enable",
    );
    expect(enable).toBeUndefined();
    expect(onChannelEnable).not.toHaveBeenCalled();

    expect(onConfigPatch).not.toHaveBeenCalled();
  });

  it("mirrors Telegram onboarding by enabling the channel when saving a bot token", () => {
    const container = document.createElement("div");
    const onConfigPatch = vi.fn();
    const snapshot = createSnapshot();
    snapshot.channelOrder = ["telegram"];
    snapshot.channels.telegram = { configured: false, running: false, connected: false };
    snapshot.channelAccounts.telegram = [];

    render(renderChannels(createProps({ snapshot, onConfigPatch })), container);

    const telegramCard = container.querySelector('[data-channel-card="telegram"]');
    expect(telegramCard).not.toBeNull();
    const text = normalizeText(telegramCard!);
    expect(text).not.toContain("Open Telegram and chat with @BotFather");
    expect(text).toContain("Bot token");
    expect(text).toContain("Connect");
    expect(text).not.toContain("Enable");
    const telegramNotes = telegramCard!.querySelector<HTMLElement>(".channel-signup-notes");
    expect(telegramNotes?.getAttribute("data-tooltip")).toContain(
      "Open Telegram and chat with @BotFather",
    );

    const tokenInput = container.querySelector<HTMLInputElement>(
      'input[placeholder="123456:ABC..."]',
    );
    expect(tokenInput).not.toBeNull();
    tokenInput!.value = "123456:ABC";
    tokenInput!.dispatchEvent(new Event("input", { bubbles: true }));

    expect(onConfigPatch).toHaveBeenCalledWith(["channels", "telegram", "enabled"], true);
    expect(onConfigPatch).toHaveBeenCalledWith(["channels", "telegram", "botToken"], "123456:ABC");
  });

  it("mirrors IRC onboarding without repeating the channel name in setup copy", () => {
    const container = document.createElement("div");
    const onConfigPatch = vi.fn();
    const snapshot = createSnapshot();
    snapshot.channelOrder = ["irc"];
    snapshot.channelLabels = { irc: "IRC" };
    snapshot.channelDetailLabels = { irc: "IRC" };
    snapshot.channelMeta = [{ id: "irc", label: "IRC", detailLabel: "IRC" }];
    snapshot.channels = {
      irc: { configured: false, running: false, connected: false, catalogOnly: false } as never,
    };
    snapshot.channelAccounts = { irc: [] };

    render(renderChannels(createProps({ snapshot, onConfigPatch })), container);

    const ircCard = container.querySelector('[data-channel-card="irc"]');
    expect(ircCard).not.toBeNull();
    const text = normalizeText(ircCard!);
    expect(text).toContain("Server and nick.");
    expect(text).not.toContain("IRC IRC");
    expect(text).toContain("Server host");
    expect(text).toContain("Nick");
    expect(text).toContain("Channels");
    expect(text).toContain("IRC channels access");
    expect(text).toContain("IRC channels allowlist");
    expect(text).toContain("Connect");
    expect(text).not.toContain("Enter the IRC server host");
    const notes = ircCard!.querySelector<HTMLElement>(".channel-signup-notes");
    expect(notes?.getAttribute("data-tooltip")).toContain("Enter the IRC server host");

    const hostInput = ircCard!.querySelector<HTMLInputElement>(
      'input[placeholder="irc.libera.chat"]',
    );
    expect(hostInput).not.toBeNull();
    hostInput!.value = "irc.libera.chat";
    hostInput!.dispatchEvent(new Event("input", { bubbles: true }));

    expect(onConfigPatch).toHaveBeenCalledWith(["channels", "irc", "enabled"], true);
    expect(onConfigPatch).toHaveBeenCalledWith(["channels", "irc", "host"], "irc.libera.chat");

    const allowlist = Array.from(
      ircCard!.querySelectorAll<HTMLInputElement>('input[placeholder="#fased, #ops"]'),
    ).at(-1);
    expect(allowlist).not.toBeNull();
    allowlist!.value = "#fased, ops";
    allowlist!.dispatchEvent(new Event("input", { bubbles: true }));

    expect(onConfigPatch).toHaveBeenCalledWith(["channels", "irc", "groups"], {
      "#fased": {},
      "#ops": {},
    });
  });

  it("mirrors Google Chat onboarding without repeating the channel name in setup copy", () => {
    const container = document.createElement("div");
    const onConfigPatch = vi.fn();
    const snapshot = createSnapshot();
    snapshot.channelOrder = ["googlechat"];
    snapshot.channelLabels = { googlechat: "Google Chat" };
    snapshot.channelDetailLabels = { googlechat: "Google Chat" };
    snapshot.channelMeta = [{ id: "googlechat", label: "Google Chat", detailLabel: "Google Chat" }];
    snapshot.channels = {
      googlechat: {
        configured: false,
        running: false,
        connected: false,
        catalogOnly: false,
      } as never,
    };
    snapshot.channelAccounts = { googlechat: [] };

    render(renderChannels(createProps({ snapshot, onConfigPatch })), container);

    const googleChatCard = container.querySelector('[data-channel-card="googlechat"]');
    expect(googleChatCard).not.toBeNull();
    const text = normalizeText(googleChatCard!);
    expect(text).toContain("Chat API webhook.");
    expect(text).not.toContain("Google Chat Google Chat");
    expect(text).toContain("Service account file");
    expect(text).toContain("Webhook path");
    expect(text).toContain("Webhook URL");
    expect(text).toContain("Audience type");
    expect(text).toContain("Audience");
    expect(text).toContain("Bot user");
    expect(text).toContain("Connect");
    expect(text).not.toContain("Create a Google Chat app in Google Cloud");
    const notes = googleChatCard!.querySelector<HTMLElement>(".channel-signup-notes");
    expect(notes?.getAttribute("data-tooltip")).toContain("Create a Google Chat app");

    const serviceAccountInput = googleChatCard!.querySelector<HTMLInputElement>(
      'input[placeholder="/run/secrets/google-chat-service-account.json"]',
    );
    expect(serviceAccountInput).not.toBeNull();
    serviceAccountInput!.value = "/run/secrets/google-chat.json";
    serviceAccountInput!.dispatchEvent(new Event("input", { bubbles: true }));

    expect(onConfigPatch).toHaveBeenCalledWith(["channels", "googlechat", "enabled"], true);
    expect(onConfigPatch).toHaveBeenCalledWith(
      ["channels", "googlechat", "serviceAccountFile"],
      "/run/secrets/google-chat.json",
    );
  });

  it("mirrors Slack onboarding without generic DM setup", () => {
    const container = document.createElement("div");
    const onConfigPatch = vi.fn();
    const snapshot = createSnapshot();
    snapshot.channelOrder = ["slack"];
    snapshot.channelLabels = { slack: "Slack" };
    snapshot.channelDetailLabels = { slack: "Slack Bot" };
    snapshot.channelMeta = [{ id: "slack", label: "Slack", detailLabel: "Slack Bot" }];
    snapshot.channels = {
      slack: {
        configured: false,
        running: false,
        connected: false,
        catalogOnly: false,
        install: { localPath: "extensions/slack", defaultChoice: "local" },
      } as never,
    };
    snapshot.channelAccounts = { slack: [] };

    render(renderChannels(createProps({ snapshot, onConfigPatch })), container);

    const slackCard = container.querySelector('[data-channel-card="slack"]');
    expect(slackCard).not.toBeNull();
    const text = normalizeText(slackCard!);
    expect(text).toContain("Socket Mode tokens.");
    expect(text).not.toContain("Slack Slack Bot");
    expect(text).toContain("Bot token");
    expect(text).toContain("App token");
    expect(text).toContain("Slack channels access");
    expect(text).toContain("Slack channels allowlist");
    expect(text).toContain("Save");
    expect(text).not.toContain("Install");
    expect(text).not.toContain("OAuth & Permissions -> install app to workspace");
    expect(text).not.toContain("Slack DM access");
    expect(text).not.toContain("DM policy");
    expect(text).not.toContain("Route to Agent");
    const notes = slackCard!.querySelector<HTMLElement>(".channel-signup-notes");
    expect(notes?.getAttribute("data-tooltip")).toContain("Slack API -> Create App");

    const botToken = slackCard!.querySelector<HTMLInputElement>('input[placeholder="xoxb-..."]');
    expect(botToken).not.toBeNull();
    botToken!.value = "xoxb-test";
    botToken!.dispatchEvent(new Event("input", { bubbles: true }));

    expect(onConfigPatch).toHaveBeenCalledWith(["channels", "slack", "enabled"], true);
    expect(onConfigPatch).toHaveBeenCalledWith(["channels", "slack", "botToken"], "xoxb-test");
  });

  it("mirrors Microsoft Teams onboarding with channel access controls", () => {
    const container = document.createElement("div");
    const onConfigPatch = vi.fn();
    const snapshot = createSnapshot();
    snapshot.channelOrder = ["msteams"];
    snapshot.channelLabels = { msteams: "Microsoft Teams" };
    snapshot.channelDetailLabels = { msteams: "Microsoft Teams" };
    snapshot.channelMeta = [
      { id: "msteams", label: "Microsoft Teams", detailLabel: "Microsoft Teams" },
    ];
    snapshot.channelSetup = {
      msteams: {
        title: "Microsoft Teams",
        detail: "Bot Framework app credentials.",
        notes: [
          "1) Azure Bot registration -> get App ID and Tenant ID",
          "2) Add a client secret (App Password)",
          "3) Set webhook URL and messaging endpoint",
        ],
        fields: [
          {
            label: "App ID",
            path: ["channels", "msteams", "appId"],
            placeholder: "Azure Bot App ID",
          },
          {
            label: "App Password",
            path: ["channels", "msteams", "appPassword"],
            placeholder: "Client secret",
            kind: "password",
          },
          {
            label: "Tenant ID",
            path: ["channels", "msteams", "tenantId"],
            placeholder: "Azure AD tenant ID",
          },
        ],
        access: {
          kind: "msteams-channels",
          label: "MS Teams channels",
          note: "Allowlist Teams channels, open all channels, or block channel messages.",
          placeholder: "Team Name/Channel Name, teamId/conversationId",
        },
      },
    };
    snapshot.channels = {
      msteams: {
        configured: false,
        running: false,
        connected: false,
        catalogOnly: false,
        install: { localPath: "extensions/msteams", defaultChoice: "local" },
      } as never,
    };
    snapshot.channelAccounts = { msteams: [] };

    render(
      renderChannels(
        createProps({
          snapshot,
          onConfigPatch,
          configForm: {
            channels: {
              msteams: {
                groupPolicy: "allowlist",
                teams: { "Existing Team": { channels: { General: {} } } },
              },
            },
          } as never,
        }),
      ),
      container,
    );

    const teamsCard = container.querySelector('[data-channel-card="msteams"]');
    expect(teamsCard).not.toBeNull();
    const text = normalizeText(teamsCard!);
    expect(text).toContain("Bot Framework app credentials.");
    expect(text).not.toContain("Microsoft Teams Microsoft Teams");
    expect(text).toContain("App ID");
    expect(text).toContain("App Password");
    expect(text).toContain("Tenant ID");
    expect(text).toContain("MS Teams channels access");
    expect(text).toContain("MS Teams channels allowlist");
    expect(text).toContain("Connect");
    expect(text).toContain("Save");
    expect(text).not.toContain("Install");
    expect(text).not.toContain("Enable this channel, then restart the gateway.");
    expect(text).not.toContain("Azure Bot registration");
    expect(text).not.toContain("DM policy");
    expect(text).not.toContain("Route to Agent");
    const notes = teamsCard!.querySelector<HTMLElement>(".channel-signup-notes");
    expect(notes?.getAttribute("data-tooltip")).toContain("Azure Bot registration");

    const appId = teamsCard!.querySelector<HTMLInputElement>(
      'input[placeholder="Azure Bot App ID"]',
    );
    expect(appId).not.toBeNull();
    appId!.value = "app-1";
    appId!.dispatchEvent(new Event("input", { bubbles: true }));

    expect(onConfigPatch).toHaveBeenCalledWith(["channels", "msteams", "enabled"], true);
    expect(onConfigPatch).toHaveBeenCalledWith(["channels", "msteams", "appId"], "app-1");

    const allowlist = teamsCard!.querySelector<HTMLInputElement>(
      'input[placeholder="Team Name/Channel Name, teamId/conversationId"]',
    );
    expect(allowlist).not.toBeNull();
    expect(allowlist!.value).toBe("Existing Team/General");
    allowlist!.value = "Ops/General";
    allowlist!.dispatchEvent(new Event("input", { bubbles: true }));

    expect(onConfigPatch).toHaveBeenCalledWith(["channels", "msteams", "teams"], {
      Ops: { channels: { General: {} } },
    });
  });

  it("mirrors Nostr onboarding with local enable and DM controls", () => {
    const container = document.createElement("div");
    const onChannelInstall = vi.fn();
    const onConfigPatch = vi.fn();
    const snapshot = createSnapshot();
    snapshot.channelOrder = ["nostr"];
    snapshot.channelLabels = { nostr: "Nostr" };
    snapshot.channelDetailLabels = { nostr: "Nostr" };
    snapshot.channelMeta = [{ id: "nostr", label: "Nostr", detailLabel: "Nostr" }];
    snapshot.channelSetup = {
      nostr: {
        title: "Nostr",
        detail: "Nostr private key and relays.",
        notes: [
          "Use an existing Nostr private key or generate one with nak key generate.",
          "Private key formats: nsec... or 64-character hex.",
          "Use 2-3 WebSocket relays for redundancy.",
        ],
        fields: [
          {
            label: "Private key",
            path: ["channels", "nostr", "privateKey"],
            placeholder: "nsec1... or 64-character hex",
            kind: "password",
          },
          {
            label: "Relays",
            path: ["channels", "nostr", "relays"],
            placeholder: "wss://relay.damus.io, wss://relay.primal.net",
            kind: "list",
          },
        ],
        dmPolicy: {
          label: "Nostr",
          policyKey: "channels.nostr.dmPolicy",
          allowFromKey: "channels.nostr.allowFrom",
        },
      },
    };
    snapshot.channels = {
      nostr: {
        configured: false,
        running: false,
        connected: false,
        catalogOnly: false,
        install: { localPath: "extensions/nostr", defaultChoice: "local" },
      } as never,
    };
    snapshot.channelAccounts = { nostr: [] };

    render(renderChannels(createProps({ snapshot, onChannelInstall, onConfigPatch })), container);

    const nostrCard = container.querySelector('[data-channel-card="nostr"]');
    expect(nostrCard).not.toBeNull();
    const text = normalizeText(nostrCard!);
    expect(text).toContain("Connect");
    expect(text).not.toContain("Enable this channel, then restart the gateway.");
    expect(text).toContain("Private key");
    expect(text).toContain("Relays");
    expect(text).toContain("DM access");
    expect(text).toContain("DM policy");
    expect(text).not.toContain("Use an existing Nostr private key");
    expect(text).not.toContain("fased plugins install extensions/nostr");
    const notes = nostrCard!.querySelector<HTMLElement>(".channel-signup-notes");
    expect(notes?.getAttribute("data-tooltip")).toContain("nak key generate");
    expect(nostrCard!.querySelector<HTMLButtonElement>('[aria-label="Enable channel"]')).toBeNull();
    expect(onChannelInstall).not.toHaveBeenCalled();

    const privateKey = nostrCard!.querySelector<HTMLInputElement>(
      'input[placeholder="nsec1... or 64-character hex"]',
    );
    expect(privateKey).not.toBeNull();
    privateKey!.value = "nsec1test";
    privateKey!.dispatchEvent(new Event("input", { bubbles: true }));

    expect(onConfigPatch).toHaveBeenCalledWith(["channels", "nostr", "enabled"], true);
    expect(onConfigPatch).toHaveBeenCalledWith(["channels", "nostr", "privateKey"], "nsec1test");
  });

  it("mirrors Mattermost onboarding with local enable and bot credentials", () => {
    const container = document.createElement("div");
    const onChannelInstall = vi.fn();
    const onConfigPatch = vi.fn();
    const snapshot = createSnapshot();
    snapshot.channelOrder = ["mattermost"];
    snapshot.channelLabels = { mattermost: "Mattermost" };
    snapshot.channelDetailLabels = { mattermost: "Mattermost" };
    snapshot.channelMeta = [{ id: "mattermost", label: "Mattermost", detailLabel: "Mattermost" }];
    snapshot.channelSetup = {
      mattermost: {
        title: "Mattermost",
        detail: "Bot token and server URL.",
        notes: [
          "1) Mattermost System Console -> Integrations -> Bot Accounts",
          "2) Create a bot and copy its token",
          "3) Use your server base URL, for example https://chat.example.com",
          "Tip: the bot must be a member of any channel you want it to monitor.",
        ],
        fields: [
          {
            label: "Bot token",
            path: ["channels", "mattermost", "botToken"],
            placeholder: "Mattermost bot token",
            kind: "password",
          },
          {
            label: "Base URL",
            path: ["channels", "mattermost", "baseUrl"],
            placeholder: "https://chat.example.com",
          },
        ],
      },
    };
    snapshot.channels = {
      mattermost: {
        configured: false,
        running: false,
        connected: false,
        catalogOnly: false,
        install: { localPath: "extensions/mattermost", defaultChoice: "local" },
      } as never,
    };
    snapshot.channelAccounts = { mattermost: [] };

    render(renderChannels(createProps({ snapshot, onChannelInstall, onConfigPatch })), container);

    const mattermostCard = container.querySelector('[data-channel-card="mattermost"]');
    expect(mattermostCard).not.toBeNull();
    const text = normalizeText(mattermostCard!);
    expect(text).toContain("Connect");
    expect(text).toContain("Bot token");
    expect(text).toContain("Base URL");
    expect(text).toContain("Save");
    expect(text).not.toContain("Install");
    expect(text).not.toContain("Enable this channel, then restart the gateway.");
    expect(text).not.toContain("Mattermost System Console");
    expect(text).not.toContain("fased plugins install extensions/mattermost");
    const notes = mattermostCard!.querySelector<HTMLElement>(".channel-signup-notes");
    expect(notes?.getAttribute("data-tooltip")).toContain("Mattermost System Console");
    expect(
      mattermostCard!.querySelector<HTMLButtonElement>('[aria-label="Enable channel"]'),
    ).toBeNull();
    expect(onChannelInstall).not.toHaveBeenCalled();

    const tokenInput = mattermostCard!.querySelector<HTMLInputElement>(
      'input[placeholder="Mattermost bot token"]',
    );
    expect(tokenInput).not.toBeNull();
    tokenInput!.value = "mattermost-token";
    tokenInput!.dispatchEvent(new Event("input", { bubbles: true }));

    expect(onConfigPatch).toHaveBeenCalledWith(["channels", "mattermost", "enabled"], true);
    expect(onConfigPatch).toHaveBeenCalledWith(
      ["channels", "mattermost", "botToken"],
      "mattermost-token",
    );
  });

  it("mirrors Nextcloud Talk onboarding with local enable and bot secret", () => {
    const container = document.createElement("div");
    const onChannelInstall = vi.fn();
    const onConfigPatch = vi.fn();
    const snapshot = createSnapshot();
    snapshot.channelOrder = ["nextcloud-talk"];
    snapshot.channelLabels = { "nextcloud-talk": "Nextcloud Talk" };
    snapshot.channelDetailLabels = { "nextcloud-talk": "Nextcloud Talk" };
    snapshot.channelMeta = [
      { id: "nextcloud-talk", label: "Nextcloud Talk", detailLabel: "Nextcloud Talk" },
    ];
    snapshot.channelSetup = {
      "nextcloud-talk": {
        title: "Nextcloud Talk",
        detail: "Bot webhook URL and shared secret.",
        notes: [
          "1) SSH into your Nextcloud server",
          '2) Run: ./occ talk:bot:install "FasedAgent" "<shared-secret>" "<webhook-url>" --feature reaction',
          "3) Copy the shared secret you used in the command",
          "4) Enable the bot in your Nextcloud Talk room settings",
        ],
        fields: [
          {
            label: "Instance URL",
            path: ["channels", "nextcloud-talk", "baseUrl"],
            placeholder: "https://cloud.example.com",
          },
          {
            label: "Bot secret",
            path: ["channels", "nextcloud-talk", "botSecret"],
            placeholder: "Shared secret",
            kind: "password",
          },
        ],
        dmPolicy: {
          label: "Nextcloud Talk",
          policyKey: "channels.nextcloud-talk.dmPolicy",
          allowFromKey: "channels.nextcloud-talk.allowFrom",
        },
      },
    };
    snapshot.channels = {
      "nextcloud-talk": {
        configured: false,
        running: false,
        connected: false,
        catalogOnly: false,
        install: { localPath: "extensions/nextcloud-talk", defaultChoice: "local" },
      } as never,
    };
    snapshot.channelAccounts = { "nextcloud-talk": [] };

    render(renderChannels(createProps({ snapshot, onChannelInstall, onConfigPatch })), container);

    const nextcloudCard = container.querySelector('[data-channel-card="nextcloud-talk"]');
    expect(nextcloudCard).not.toBeNull();
    const text = normalizeText(nextcloudCard!);
    expect(text).toContain("Connect");
    expect(text).toContain("Instance URL");
    expect(text).toContain("Bot secret");
    expect(text).toContain("DM access");
    expect(text).toContain("Save");
    expect(text).not.toContain("Install");
    expect(text).not.toContain("Enable this channel, then restart the gateway.");
    expect(text).not.toContain("SSH into your Nextcloud server");
    expect(text).not.toContain("fased plugins install extensions/nextcloud-talk");
    const notes = nextcloudCard!.querySelector<HTMLElement>(".channel-signup-notes");
    expect(notes?.getAttribute("data-tooltip")).toContain("talk:bot:install");
    expect(
      nextcloudCard!.querySelector<HTMLButtonElement>('[aria-label="Enable channel"]'),
    ).toBeNull();
    expect(onChannelInstall).not.toHaveBeenCalled();

    const urlInput = nextcloudCard!.querySelector<HTMLInputElement>(
      'input[placeholder="https://cloud.example.com"]',
    );
    expect(urlInput).not.toBeNull();
    urlInput!.value = "https://cloud.example.com";
    urlInput!.dispatchEvent(new Event("input", { bubbles: true }));

    expect(onConfigPatch).toHaveBeenCalledWith(["channels", "nextcloud-talk", "enabled"], true);
    expect(onConfigPatch).toHaveBeenCalledWith(
      ["channels", "nextcloud-talk", "baseUrl"],
      "https://cloud.example.com",
    );
  });

  it("mirrors BlueBubbles onboarding with local setup fields", () => {
    const container = document.createElement("div");
    const onChannelInstall = vi.fn();
    const onConfigPatch = vi.fn();
    const snapshot = createSnapshot();
    snapshot.channelOrder = ["bluebubbles"];
    snapshot.channelLabels = { bluebubbles: "BlueBubbles" };
    snapshot.channelDetailLabels = { bluebubbles: "BlueBubbles" };
    snapshot.channelMeta = [
      { id: "bluebubbles", label: "BlueBubbles", detailLabel: "BlueBubbles" },
    ];
    snapshot.channelSetup = {
      bluebubbles: {
        title: "BlueBubbles",
        detail: "Server URL, password, and webhook path.",
        notes: [
          "Find the server URL in BlueBubbles Server -> Connection.",
          "Find the password in BlueBubbles Server -> Settings.",
          "Configure the webhook in BlueBubbles Server -> Settings -> Webhooks.",
        ],
        fields: [
          {
            label: "Server URL",
            path: ["channels", "bluebubbles", "serverUrl"],
            placeholder: "http://192.168.1.100:1234",
          },
          {
            label: "Password",
            path: ["channels", "bluebubbles", "password"],
            placeholder: "BlueBubbles server password",
            kind: "password",
          },
          {
            label: "Webhook path",
            path: ["channels", "bluebubbles", "webhookPath"],
            placeholder: "/bluebubbles-webhook",
          },
        ],
        dmPolicy: {
          label: "BlueBubbles",
          policyKey: "channels.bluebubbles.dmPolicy",
          allowFromKey: "channels.bluebubbles.allowFrom",
        },
      },
    };
    snapshot.channels = {
      bluebubbles: {
        configured: false,
        running: false,
        connected: false,
        catalogOnly: false,
        install: { localPath: "extensions/bluebubbles", defaultChoice: "local" },
      } as never,
    };
    snapshot.channelAccounts = { bluebubbles: [] };

    render(renderChannels(createProps({ snapshot, onChannelInstall, onConfigPatch })), container);

    const blueBubblesCard = container.querySelector('[data-channel-card="bluebubbles"]');
    expect(blueBubblesCard).not.toBeNull();
    const text = normalizeText(blueBubblesCard!);
    expect(text).toContain("Connect");
    expect(text).toContain("Server URL");
    expect(text).toContain("Password");
    expect(text).toContain("Webhook path");
    expect(text).toContain("DM access");
    expect(text).toContain("Save");
    expect(text).not.toContain("Install");
    expect(text).not.toContain("Enable this channel, then restart the gateway.");
    expect(text).not.toContain("Find the server URL in BlueBubbles Server");
    expect(text).not.toContain("fased plugins install extensions/bluebubbles");
    const notes = blueBubblesCard!.querySelector<HTMLElement>(".channel-signup-notes");
    expect(notes?.getAttribute("data-tooltip")).toContain("BlueBubbles Server");
    expect(
      blueBubblesCard!.querySelector<HTMLButtonElement>('[aria-label="Enable channel"]'),
    ).toBeNull();
    expect(onChannelInstall).not.toHaveBeenCalled();

    const serverUrl = blueBubblesCard!.querySelector<HTMLInputElement>(
      'input[placeholder="http://192.168.1.100:1234"]',
    );
    expect(serverUrl).not.toBeNull();
    serverUrl!.value = "http://192.168.1.100:1234";
    serverUrl!.dispatchEvent(new Event("input", { bubbles: true }));

    expect(onConfigPatch).toHaveBeenCalledWith(["channels", "bluebubbles", "enabled"], true);
    expect(onConfigPatch).toHaveBeenCalledWith(
      ["channels", "bluebubbles", "serverUrl"],
      "http://192.168.1.100:1234",
    );
  });

  it("mirrors LINE onboarding with local setup fields", () => {
    const container = document.createElement("div");
    const onChannelInstall = vi.fn();
    const onConfigPatch = vi.fn();
    const snapshot = createSnapshot();
    snapshot.channelOrder = ["line"];
    snapshot.channelLabels = { line: "LINE" };
    snapshot.channelDetailLabels = { line: "LINE Bot" };
    snapshot.channelMeta = [{ id: "line", label: "LINE", detailLabel: "LINE Bot" }];
    snapshot.channelSetup = {
      line: {
        title: "LINE",
        detail: "Messaging API token, secret, and webhook path.",
        notes: [
          "LINE Developers Console -> Provider -> Messaging API channel.",
          "Copy the channel access token and channel secret.",
          "Enable Use webhook and set the webhook URL to your gateway plus /line/webhook.",
        ],
        fields: [
          {
            label: "Channel access token",
            path: ["channels", "line", "channelAccessToken"],
            placeholder: "LINE channel access token",
            kind: "password",
          },
          {
            label: "Channel secret",
            path: ["channels", "line", "channelSecret"],
            placeholder: "LINE channel secret",
            kind: "password",
          },
          {
            label: "Webhook path",
            path: ["channels", "line", "webhookPath"],
            placeholder: "/line/webhook",
          },
        ],
        dmPolicy: {
          label: "LINE",
          policyKey: "channels.line.dmPolicy",
          allowFromKey: "channels.line.allowFrom",
        },
      },
    };
    snapshot.channels = {
      line: {
        configured: false,
        running: false,
        connected: false,
        catalogOnly: false,
        install: { localPath: "extensions/line", defaultChoice: "local" },
      } as never,
    };
    snapshot.channelAccounts = { line: [] };

    render(renderChannels(createProps({ snapshot, onChannelInstall, onConfigPatch })), container);

    const lineCard = container.querySelector('[data-channel-card="line"]');
    expect(lineCard).not.toBeNull();
    const text = normalizeText(lineCard!);
    expect(text).toContain("Connect");
    expect(text).toContain("Channel access token");
    expect(text).toContain("Channel secret");
    expect(text).toContain("Webhook path");
    expect(text).toContain("DM access");
    expect(text).toContain("Save");
    expect(text).not.toContain("Install");
    expect(text).not.toContain("Enable this channel, then restart the gateway.");
    expect(text).not.toContain("LINE Developers Console");
    expect(text).not.toContain("fased plugins install extensions/line");
    const notes = lineCard!.querySelector<HTMLElement>(".channel-signup-notes");
    expect(notes?.getAttribute("data-tooltip")).toContain("LINE Developers Console");
    expect(lineCard!.querySelector<HTMLButtonElement>('[aria-label="Enable channel"]')).toBeNull();
    expect(onChannelInstall).not.toHaveBeenCalled();

    const token = lineCard!.querySelector<HTMLInputElement>(
      'input[placeholder="LINE channel access token"]',
    );
    expect(token).not.toBeNull();
    token!.value = "line-token";
    token!.dispatchEvent(new Event("input", { bubbles: true }));

    expect(onConfigPatch).toHaveBeenCalledWith(["channels", "line", "enabled"], true);
    expect(onConfigPatch).toHaveBeenCalledWith(
      ["channels", "line", "channelAccessToken"],
      "line-token",
    );
  });

  it("mirrors Synology Chat onboarding with local webhook setup fields", () => {
    const container = document.createElement("div");
    const onChannelInstall = vi.fn();
    const onConfigPatch = vi.fn();
    const snapshot = createSnapshot();
    snapshot.channelOrder = ["synology-chat"];
    snapshot.channelLabels = { "synology-chat": "Synology Chat" };
    snapshot.channelDetailLabels = { "synology-chat": "Synology Chat (Webhook)" };
    snapshot.channelMeta = [
      {
        id: "synology-chat",
        label: "Synology Chat",
        detailLabel: "Synology Chat (Webhook)",
      },
    ];
    snapshot.channelSetup = {
      "synology-chat": {
        title: "Synology Chat",
        detail: "Incoming webhook URL, outgoing token, and allowlisted users.",
        notes: [
          "Create an incoming webhook in Synology Chat and copy its URL.",
          "Create an outgoing webhook with a secret token.",
          "Point the outgoing webhook URL to your gateway plus /webhook/synology.",
        ],
        fields: [
          {
            label: "Outgoing token",
            path: ["channels", "synology-chat", "token"],
            placeholder: "Synology outgoing webhook token",
            kind: "password",
          },
          {
            label: "Incoming webhook URL",
            path: ["channels", "synology-chat", "incomingUrl"],
            placeholder: "https://nas.example.com/webapi/entry.cgi?...",
            kind: "password",
          },
          {
            label: "Webhook path",
            path: ["channels", "synology-chat", "webhookPath"],
            placeholder: "/webhook/synology",
          },
          {
            label: "DM policy",
            path: ["channels", "synology-chat", "dmPolicy"],
            kind: "select",
            options: [
              { value: "allowlist", label: "Allowlist" },
              { value: "open", label: "Open" },
              { value: "disabled", label: "Disabled" },
            ],
          },
          {
            label: "Allowed user IDs",
            path: ["channels", "synology-chat", "allowedUserIds"],
            placeholder: "123456, 987654",
            kind: "list",
          },
          {
            label: "Rate limit/min",
            path: ["channels", "synology-chat", "rateLimitPerMinute"],
            placeholder: "30",
            kind: "number",
          },
        ],
      },
    };
    snapshot.channels = {
      "synology-chat": {
        configured: false,
        running: false,
        connected: false,
        catalogOnly: false,
        install: { localPath: "extensions/synology-chat", defaultChoice: "local" },
      } as never,
    };
    snapshot.channelAccounts = { "synology-chat": [] };

    render(renderChannels(createProps({ snapshot, onChannelInstall, onConfigPatch })), container);

    const synologyCard = container.querySelector('[data-channel-card="synology-chat"]');
    expect(synologyCard).not.toBeNull();
    const text = normalizeText(synologyCard!);
    expect(text).toContain("Connect");
    expect(text).toContain("Outgoing token");
    expect(text).toContain("Incoming webhook URL");
    expect(text).toContain("Webhook path");
    expect(text).toContain("DM policy");
    expect(text).toContain("Allowed user IDs");
    expect(text).toContain("Rate limit/min");
    expect(text).toContain("Save");
    expect(text).not.toContain("Install");
    expect(text).not.toContain("Enable this channel, then restart the gateway.");
    expect(text).not.toContain("Create an incoming webhook in Synology Chat");
    expect(text).not.toContain("fased plugins install extensions/synology-chat");
    const notes = synologyCard!.querySelector<HTMLElement>(".channel-signup-notes");
    expect(notes?.getAttribute("data-tooltip")).toContain("Synology Chat");
    expect(
      synologyCard!.querySelector<HTMLButtonElement>('[aria-label="Enable channel"]'),
    ).toBeNull();
    expect(onChannelInstall).not.toHaveBeenCalled();

    const token = synologyCard!.querySelector<HTMLInputElement>(
      'input[placeholder="Synology outgoing webhook token"]',
    );
    expect(token).not.toBeNull();
    token!.value = "synology-token";
    token!.dispatchEvent(new Event("input", { bubbles: true }));

    expect(onConfigPatch).toHaveBeenCalledWith(["channels", "synology-chat", "enabled"], true);
    expect(onConfigPatch).toHaveBeenCalledWith(
      ["channels", "synology-chat", "token"],
      "synology-token",
    );
  });

  it("mirrors Tlon onboarding with local Urbit setup fields", () => {
    const container = document.createElement("div");
    const onChannelInstall = vi.fn();
    const onConfigPatch = vi.fn();
    const snapshot = createSnapshot();
    snapshot.channelOrder = ["tlon"];
    snapshot.channelLabels = { tlon: "Tlon" };
    snapshot.channelDetailLabels = { tlon: "Tlon (Urbit)" };
    snapshot.channelMeta = [{ id: "tlon", label: "Tlon", detailLabel: "Tlon (Urbit)" }];
    snapshot.channelSetup = {
      tlon: {
        title: "Tlon",
        detail: "Urbit ship URL, login code, groups, and DM allowlist.",
        notes: [
          "You need your Urbit ship URL and login code.",
          "Example URL: https://your-ship-host.",
          "Example ship: ~sampel-palnet.",
          "Private or LAN ship URLs require explicit private-network approval.",
        ],
        fields: [
          {
            label: "Ship name",
            path: ["channels", "tlon", "ship"],
            placeholder: "~sampel-palnet",
          },
          {
            label: "Ship URL",
            path: ["channels", "tlon", "url"],
            placeholder: "https://your-ship-host",
          },
          {
            label: "Login code",
            path: ["channels", "tlon", "code"],
            placeholder: "lidlut-tabwed-pillex-ridrup",
            kind: "password",
          },
          {
            label: "Allow private network",
            path: ["channels", "tlon", "allowPrivateNetwork"],
            kind: "boolean",
          },
          {
            label: "Group channels",
            path: ["channels", "tlon", "groupChannels"],
            placeholder: "chat/~host-ship/general, chat/~host-ship/support",
            kind: "list",
          },
          {
            label: "DM allowlist",
            path: ["channels", "tlon", "dmAllowlist"],
            placeholder: "~zod, ~nec",
            kind: "list",
          },
          {
            label: "Auto-discover groups",
            path: ["channels", "tlon", "autoDiscoverChannels"],
            kind: "boolean",
          },
        ],
      },
    };
    snapshot.channels = {
      tlon: {
        configured: false,
        running: false,
        connected: false,
        catalogOnly: false,
        install: { localPath: "extensions/tlon", defaultChoice: "local" },
      } as never,
    };
    snapshot.channelAccounts = { tlon: [] };

    render(
      renderChannels(
        createProps({
          snapshot,
          onChannelInstall,
          onConfigPatch,
          configForm: {
            channels: {
              tlon: {
                allowPrivateNetwork: false,
                autoDiscoverChannels: true,
              },
            },
          } as never,
        }),
      ),
      container,
    );

    const tlonCard = container.querySelector('[data-channel-card="tlon"]');
    expect(tlonCard).not.toBeNull();
    const text = normalizeText(tlonCard!);
    expect(text).toContain("Connect");
    expect(text).toContain("Ship name");
    expect(text).toContain("Ship URL");
    expect(text).toContain("Login code");
    expect(text).toContain("Allow private network");
    expect(text).toContain("Group channels");
    expect(text).toContain("DM allowlist");
    expect(text).toContain("Auto-discover groups");
    expect(text).toContain("Save");
    expect(text).not.toContain("Install");
    expect(text).not.toContain("Enable this channel, then restart the gateway.");
    expect(text).not.toContain("You need your Urbit ship URL");
    expect(text).not.toContain("fased plugins install extensions/tlon");
    const notes = tlonCard!.querySelector<HTMLElement>(".channel-signup-notes");
    expect(notes?.getAttribute("data-tooltip")).toContain("Urbit ship URL");
    expect(tlonCard!.querySelector<HTMLButtonElement>('[aria-label="Enable channel"]')).toBeNull();
    expect(onChannelInstall).not.toHaveBeenCalled();

    const ship = tlonCard!.querySelector<HTMLInputElement>('input[placeholder="~sampel-palnet"]');
    expect(ship).not.toBeNull();
    ship!.value = "~sampel-palnet";
    ship!.dispatchEvent(new Event("input", { bubbles: true }));

    const code = tlonCard!.querySelector<HTMLInputElement>(
      'input[placeholder="lidlut-tabwed-pillex-ridrup"]',
    );
    expect(code?.type).toBe("password");

    const allowPrivate = tlonCard!.querySelector<HTMLSelectElement>("select");
    expect(allowPrivate).not.toBeNull();
    allowPrivate!.value = "true";
    allowPrivate!.dispatchEvent(new Event("change", { bubbles: true }));

    expect(onConfigPatch).toHaveBeenCalledWith(["channels", "tlon", "enabled"], true);
    expect(onConfigPatch).toHaveBeenCalledWith(["channels", "tlon", "ship"], "~sampel-palnet");
    expect(onConfigPatch).toHaveBeenCalledWith(["channels", "tlon", "allowPrivateNetwork"], true);
  });

  it("mirrors Zalo onboarding with local bot API setup fields", () => {
    const container = document.createElement("div");
    const onChannelInstall = vi.fn();
    const onConfigPatch = vi.fn();
    const snapshot = createSnapshot();
    snapshot.channelOrder = ["zalo"];
    snapshot.channelLabels = { zalo: "Zalo" };
    snapshot.channelDetailLabels = { zalo: "Zalo (Bot API)" };
    snapshot.channelMeta = [{ id: "zalo", label: "Zalo", detailLabel: "Zalo (Bot API)" }];
    snapshot.channelSetup = {
      zalo: {
        title: "Zalo",
        detail: "Bot API token with optional webhook mode.",
        notes: [
          "Open Zalo Bot Platform at https://bot.zaloplatforms.com.",
          "Create a bot and copy its token.",
          "Use webhook mode only when you have an HTTPS webhook URL and secret.",
          "You can also set ZALO_BOT_TOKEN for the default account.",
        ],
        fields: [
          {
            label: "Bot token",
            path: ["channels", "zalo", "botToken"],
            placeholder: "123456789:abc-xyz",
            kind: "password",
          },
          {
            label: "Token file",
            path: ["channels", "zalo", "tokenFile"],
            placeholder: "/run/secrets/zalo-token",
          },
          {
            label: "Webhook URL",
            path: ["channels", "zalo", "webhookUrl"],
            placeholder: "https://gateway.example.com/zalo-webhook",
          },
          {
            label: "Webhook secret",
            path: ["channels", "zalo", "webhookSecret"],
            placeholder: "8-256 character secret",
            kind: "password",
          },
          {
            label: "Webhook path",
            path: ["channels", "zalo", "webhookPath"],
            placeholder: "/zalo-webhook",
          },
        ],
        dmPolicy: {
          label: "Zalo",
          policyKey: "channels.zalo.dmPolicy",
          allowFromKey: "channels.zalo.allowFrom",
        },
      },
    };
    snapshot.channels = {
      zalo: {
        configured: false,
        running: false,
        connected: false,
        catalogOnly: false,
        install: { localPath: "extensions/zalo", defaultChoice: "local" },
      } as never,
    };
    snapshot.channelAccounts = { zalo: [] };

    render(renderChannels(createProps({ snapshot, onChannelInstall, onConfigPatch })), container);

    const zaloCard = container.querySelector('[data-channel-card="zalo"]');
    expect(zaloCard).not.toBeNull();
    const text = normalizeText(zaloCard!);
    expect(text).toContain("Connect");
    expect(text).toContain("Bot token");
    expect(text).toContain("Token file");
    expect(text).toContain("Webhook URL");
    expect(text).toContain("Webhook secret");
    expect(text).toContain("Webhook path");
    expect(text).toContain("DM access");
    expect(text).toContain("Save");
    expect(text).not.toContain("Install");
    expect(text).not.toContain("Enable this channel, then restart the gateway.");
    expect(text).not.toContain("Open Zalo Bot Platform");
    expect(text).not.toContain("fased plugins install extensions/zalo");
    const notes = zaloCard!.querySelector<HTMLElement>(".channel-signup-notes");
    expect(notes?.getAttribute("data-tooltip")).toContain("Zalo Bot Platform");
    expect(zaloCard!.querySelector<HTMLButtonElement>('[aria-label="Enable channel"]')).toBeNull();
    expect(onChannelInstall).not.toHaveBeenCalled();

    const token = zaloCard!.querySelector<HTMLInputElement>(
      'input[placeholder="123456789:abc-xyz"]',
    );
    expect(token).not.toBeNull();
    expect(token?.type).toBe("password");
    token!.value = "123456789:abc-xyz";
    token!.dispatchEvent(new Event("input", { bubbles: true }));

    const webhookSecret = zaloCard!.querySelector<HTMLInputElement>(
      'input[placeholder="8-256 character secret"]',
    );
    expect(webhookSecret?.type).toBe("password");

    expect(onConfigPatch).toHaveBeenCalledWith(["channels", "zalo", "enabled"], true);
    expect(onConfigPatch).toHaveBeenCalledWith(
      ["channels", "zalo", "botToken"],
      "123456789:abc-xyz",
    );
  });

  it("mirrors Zalo Personal onboarding with local QR profile and group access", () => {
    const container = document.createElement("div");
    const onChannelInstall = vi.fn();
    const onConfigPatch = vi.fn();
    const onChannelQrStart = vi.fn();
    const onChannelQrWait = vi.fn();
    const snapshot = createSnapshot();
    snapshot.channelOrder = ["zalouser"];
    snapshot.channelLabels = { zalouser: "Zalo Personal" };
    snapshot.channelDetailLabels = { zalouser: "Zalo (Personal Account)" };
    snapshot.channelMeta = [
      { id: "zalouser", label: "Zalo Personal", detailLabel: "Zalo (Personal Account)" },
    ];
    snapshot.channelSetup = {
      zalouser: {
        title: "Zalo Personal",
        detail: "Personal Zalo account through zca-cli QR login.",
        notes: [
          "Install zca-cli and make sure the zca binary is in PATH.",
          "Use QR login to link a personal Zalo account.",
          "Profile defaults to default; use another profile for multiple accounts.",
        ],
        fields: [
          {
            label: "ZCA profile",
            path: ["channels", "zalouser", "profile"],
            placeholder: "default",
          },
        ],
        qrLogin: {
          startLabel: "Show QR",
          waitLabel: "Wait for scan",
          alt: "Zalo Personal QR",
        },
        access: {
          kind: "zalouser-groups",
          label: "Zalo groups",
          note: "Allowlist Zalo groups, open all groups, or block group messages.",
          placeholder: "Family, Work, 123456789",
        },
        dmPolicy: {
          label: "Zalo Personal",
          policyKey: "channels.zalouser.dmPolicy",
          allowFromKey: "channels.zalouser.allowFrom",
        },
      },
    };
    snapshot.channels = {
      zalouser: {
        configured: false,
        running: false,
        connected: false,
        catalogOnly: false,
        install: { localPath: "extensions/zalouser", defaultChoice: "local" },
      } as never,
    };
    snapshot.channelAccounts = { zalouser: [] };

    render(
      renderChannels(
        createProps({
          snapshot,
          onChannelInstall,
          onConfigPatch,
          onChannelQrStart,
          onChannelQrWait,
          channelQrLogin: {
            zalouser: {
              message: "Scan QR code with Zalo app",
              qrDataUrl: "data:image/png;base64,zalo",
              connected: null,
            },
          },
          configForm: {
            channels: {
              zalouser: {
                groupPolicy: "allowlist",
                groups: { Family: { allow: true } },
              },
            },
          } as never,
        }),
      ),
      container,
    );

    const zalouserCard = container.querySelector('[data-channel-card="zalouser"]');
    expect(zalouserCard).not.toBeNull();
    const text = normalizeText(zalouserCard!);
    expect(text).toContain("Connect");
    expect(text).toContain("Personal Zalo account through zca-cli QR login.");
    expect(text).toContain("ZCA profile");
    expect(text).toContain("Scan QR code with Zalo app");
    expect(text).toContain("Show QR");
    expect(text).toContain("Wait for scan");
    expect(text).toContain("Zalo groups access");
    expect(text).toContain("Zalo groups allowlist");
    expect(text).toContain("DM access");
    expect(text).toContain("Save");
    expect(text).not.toContain("Install");
    expect(text).not.toContain("Enable this channel, then restart the gateway.");
    expect(text).not.toContain("Install zca-cli");
    expect(text).not.toContain("fased plugins install extensions/zalouser");
    const notes = zalouserCard!.querySelector<HTMLElement>(".channel-signup-notes");
    expect(notes?.getAttribute("data-tooltip")).toContain("zca-cli");
    expect(
      zalouserCard!.querySelector<HTMLButtonElement>('[aria-label="Enable channel"]'),
    ).toBeNull();
    expect(onChannelInstall).not.toHaveBeenCalled();
    expect(container.querySelector("img[alt='Zalo Personal QR']")).not.toBeNull();

    Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.trim() === "Show QR")
      ?.click();
    expect(onChannelQrStart).toHaveBeenCalledWith("zalouser", false);

    Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.trim() === "Wait for scan")
      ?.click();
    expect(onChannelQrWait).toHaveBeenCalledWith("zalouser");

    const profile = zalouserCard!.querySelector<HTMLInputElement>('input[placeholder="default"]');
    expect(profile).not.toBeNull();
    profile!.value = "work";
    profile!.dispatchEvent(new Event("input", { bubbles: true }));

    expect(onConfigPatch).toHaveBeenCalledWith(["channels", "zalouser", "enabled"], true);
    expect(onConfigPatch).toHaveBeenCalledWith(["channels", "zalouser", "profile"], "work");

    const groups = zalouserCard!.querySelector<HTMLInputElement>(
      'input[placeholder="Family, Work, 123456789"]',
    );
    expect(groups).not.toBeNull();
    expect(groups!.value).toBe("Family");
    groups!.value = "Work, 123456789";
    groups!.dispatchEvent(new Event("input", { bubbles: true }));

    expect(onConfigPatch).toHaveBeenCalledWith(["channels", "zalouser", "groups"], {
      Work: { allow: true },
      "123456789": { allow: true },
    });
  });

  it("mirrors Matrix onboarding with local enable, auth fields, and room access", () => {
    const container = document.createElement("div");
    const onChannelInstall = vi.fn();
    const onConfigPatch = vi.fn();
    const snapshot = createSnapshot();
    snapshot.channelOrder = ["matrix"];
    snapshot.channelLabels = { matrix: "Matrix" };
    snapshot.channelDetailLabels = { matrix: "Matrix" };
    snapshot.channelMeta = [{ id: "matrix", label: "Matrix", detailLabel: "Matrix" }];
    snapshot.channelSetup = {
      matrix: {
        title: "Matrix",
        detail: "Homeserver and Matrix bot credentials.",
        notes: [
          "Matrix requires a homeserver URL.",
          "Use an access token or a password.",
          "With access token, user ID can be fetched automatically.",
        ],
        fields: [
          {
            label: "Homeserver URL",
            path: ["channels", "matrix", "homeserver"],
            placeholder: "https://matrix.example.org",
          },
          {
            label: "Access token",
            path: ["channels", "matrix", "accessToken"],
            placeholder: "Matrix access token",
            kind: "password",
          },
          {
            label: "User ID",
            path: ["channels", "matrix", "userId"],
            placeholder: "@bot:example.org",
          },
          {
            label: "Password",
            path: ["channels", "matrix", "password"],
            placeholder: "Required only for password login",
            kind: "password",
          },
          {
            label: "Device name",
            path: ["channels", "matrix", "deviceName"],
            placeholder: "FasedAgent Gateway",
          },
        ],
        access: {
          kind: "matrix-rooms",
          label: "Matrix rooms",
          note: "Allowlist Matrix rooms, open all rooms, or block room messages.",
          placeholder: "!roomId:server, #alias:server, Project Room",
        },
        dmPolicy: {
          label: "Matrix",
          policyKey: "channels.matrix.dm.policy",
          allowFromKey: "channels.matrix.dm.allowFrom",
        },
      },
    };
    snapshot.channels = {
      matrix: {
        configured: false,
        running: false,
        connected: false,
        catalogOnly: false,
        install: { localPath: "extensions/matrix", defaultChoice: "local" },
      } as never,
    };
    snapshot.channelAccounts = { matrix: [] };

    render(
      renderChannels(
        createProps({
          snapshot,
          onChannelInstall,
          onConfigPatch,
          configForm: {
            channels: {
              matrix: {
                groupPolicy: "allowlist",
                groups: { "!existing:example.org": { allow: true } },
              },
            },
          } as never,
        }),
      ),
      container,
    );

    const matrixCard = container.querySelector('[data-channel-card="matrix"]');
    expect(matrixCard).not.toBeNull();
    const text = normalizeText(matrixCard!);
    expect(text).toContain("Connect");
    expect(text).toContain("Homeserver URL");
    expect(text).toContain("Access token");
    expect(text).toContain("User ID");
    expect(text).toContain("Password");
    expect(text).toContain("Device name");
    expect(text).toContain("Matrix rooms access");
    expect(text).toContain("Matrix rooms allowlist");
    expect(text).toContain("DM access");
    expect(text).toContain("Save");
    expect(text).not.toContain("Install");
    expect(text).not.toContain("Enable this channel, then restart the gateway.");
    expect(text).not.toContain("Matrix requires a homeserver URL.");
    expect(text).not.toContain("fased plugins install extensions/matrix");
    const notes = matrixCard!.querySelector<HTMLElement>(".channel-signup-notes");
    expect(notes?.getAttribute("data-tooltip")).toContain("Matrix requires a homeserver URL");
    expect(
      matrixCard!.querySelector<HTMLButtonElement>('[aria-label="Enable channel"]'),
    ).toBeNull();
    expect(onChannelInstall).not.toHaveBeenCalled();

    const homeserver = matrixCard!.querySelector<HTMLInputElement>(
      'input[placeholder="https://matrix.example.org"]',
    );
    expect(homeserver).not.toBeNull();
    homeserver!.value = "https://matrix.example.org";
    homeserver!.dispatchEvent(new Event("input", { bubbles: true }));

    expect(onConfigPatch).toHaveBeenCalledWith(["channels", "matrix", "enabled"], true);
    expect(onConfigPatch).toHaveBeenCalledWith(
      ["channels", "matrix", "homeserver"],
      "https://matrix.example.org",
    );

    const rooms = matrixCard!.querySelector<HTMLInputElement>(
      'input[placeholder="!roomId:server, #alias:server, Project Room"]',
    );
    expect(rooms).not.toBeNull();
    expect(rooms!.value).toBe("!existing:example.org");
    rooms!.value = "!ops:example.org";
    rooms!.dispatchEvent(new Event("input", { bubbles: true }));

    expect(onConfigPatch).toHaveBeenCalledWith(["channels", "matrix", "groups"], {
      "!ops:example.org": { allow: true },
    });
  });

  it("mirrors Feishu onboarding with generic DM policy controls", () => {
    const container = document.createElement("div");
    const onConfigPatch = vi.fn();
    const snapshot = createSnapshot();
    snapshot.channelOrder = ["feishu"];
    snapshot.channelLabels = { feishu: "Feishu" };
    snapshot.channelDetailLabels = { feishu: "Feishu/Lark" };
    snapshot.channelMeta = [{ id: "feishu", label: "Feishu", detailLabel: "Feishu/Lark" }];
    snapshot.channelSetup = {
      ...snapshot.channelSetup,
      feishu: {
        ...snapshot.channelSetup!.feishu,
        dmPolicy: {
          label: "Feishu",
          policyKey: "channels.feishu.dmPolicy",
          allowFromKey: "channels.feishu.allowFrom",
        },
      },
    };
    snapshot.channels = {
      feishu: {
        configured: false,
        running: false,
        connected: false,
        catalogOnly: false,
      } as never,
    };
    snapshot.channelAccounts = { feishu: [] };

    render(renderChannels(createProps({ snapshot, onConfigPatch })), container);

    const feishuCard = container.querySelector('[data-channel-card="feishu"]');
    expect(feishuCard).not.toBeNull();
    const text = normalizeText(feishuCard!);
    expect(text).toContain("App credentials.");
    expect(text).not.toContain("Feishu Feishu/Lark");
    expect(text).toContain("App ID");
    expect(text).toContain("App Secret");
    expect(text).toContain("Domain");
    expect(text).toContain("Connection mode");
    expect(text).toContain("Group allowlist");
    expect(text).toContain("DM policy");
    expect(text).toContain("Connect");
    expect(text).not.toContain("Feishu Open Platform");
    expect(text).not.toContain("Route to Agent");
    const notes = feishuCard!.querySelector<HTMLElement>(".channel-signup-notes");
    expect(notes?.getAttribute("data-tooltip")).toContain("Feishu Open Platform");

    const appId = feishuCard!.querySelector<HTMLInputElement>('input[placeholder="cli_xxxxx"]');
    expect(appId).not.toBeNull();
    appId!.value = "cli_test";
    appId!.dispatchEvent(new Event("input", { bubbles: true }));

    expect(onConfigPatch).toHaveBeenCalledWith(["channels", "feishu", "enabled"], true);
    expect(onConfigPatch).toHaveBeenCalledWith(["channels", "feishu", "appId"], "cli_test");

    const policySelect = feishuCard!.querySelector<HTMLSelectElement>(
      ".channel-dm-card select.input",
    );
    expect(policySelect).not.toBeNull();
    policySelect!.value = "open";
    policySelect!.dispatchEvent(new Event("change", { bubbles: true }));

    expect(onConfigPatch).toHaveBeenCalledWith(["channels", "feishu", "dmPolicy"], "open");
    expect(onConfigPatch).toHaveBeenCalledWith(["channels", "feishu", "allowFrom"], ["*"]);
  });

  it("mirrors iMessage onboarding without exposing raw advanced config", () => {
    const container = document.createElement("div");
    const onConfigPatch = vi.fn();
    const snapshot = createSnapshot();
    snapshot.channelOrder = ["imessage"];
    snapshot.channelLabels = { imessage: "iMessage" };
    snapshot.channelDetailLabels = { imessage: "iMessage" };
    snapshot.channelMeta = [{ id: "imessage", label: "iMessage", detailLabel: "iMessage" }];
    snapshot.channels = {
      imessage: {
        configured: false,
        running: false,
        connected: false,
        catalogOnly: false,
      } as never,
    };
    snapshot.channelAccounts = { imessage: [] };

    render(renderChannels(createProps({ snapshot, onConfigPatch })), container);

    const imessageCard = container.querySelector('[data-channel-card="imessage"]');
    expect(imessageCard).not.toBeNull();
    const text = normalizeText(imessageCard!);
    expect(text).toContain("macOS imsg bridge.");
    expect(text).not.toContain("iMessage iMessage");
    expect(text).toContain("CLI path");
    expect(text).toContain("Connect");
    expect(text).not.toContain("Full Disk Access");
    expect(text).not.toContain("Messages DB");
    expect(text).not.toContain("Route to Agent");
    expect(text).not.toContain("DM policy");
    expect(text).toContain("Save");
    expect(text).not.toContain("Install");
    const notes = imessageCard!.querySelector<HTMLElement>(".channel-signup-notes");
    expect(notes?.getAttribute("data-tooltip")).toContain("Full Disk Access");
    expect(notes?.getAttribute("data-tooltip")).toContain("imsg chats --limit 20");

    const cliPathInput = imessageCard!.querySelector<HTMLInputElement>('input[placeholder="imsg"]');
    expect(cliPathInput).not.toBeNull();
    cliPathInput!.value = "/usr/local/bin/imsg";
    cliPathInput!.dispatchEvent(new Event("input", { bubbles: true }));

    expect(onConfigPatch).toHaveBeenCalledWith(["channels", "imessage", "enabled"], true);
    expect(onConfigPatch).toHaveBeenCalledWith(
      ["channels", "imessage", "cliPath"],
      "/usr/local/bin/imsg",
    );
  });

  it("keeps WhatsApp first-run setup focused on QR linking", () => {
    const container = document.createElement("div");
    const onWhatsAppStart = vi.fn();
    const onWhatsAppWait = vi.fn();
    const onConfigPatch = vi.fn();
    const snapshot = createSnapshot();
    snapshot.channelOrder = ["whatsapp"];
    snapshot.channelLabels = { whatsapp: "WhatsApp" };
    snapshot.channels = {
      whatsapp: { configured: false, linked: false, running: false, connected: false } as never,
    };
    snapshot.channelAccounts = { whatsapp: [] };
    snapshot.channelDefaultAccountId = { whatsapp: "default" };

    render(
      renderChannels(
        createProps({
          snapshot,
          whatsappQrDataUrl: "data:image/png;base64,abc",
          whatsappMessage: "Scan this QR in WhatsApp.",
          onWhatsAppStart,
          onWhatsAppWait,
          onConfigPatch,
        }),
      ),
      container,
    );

    const whatsappCard = container.querySelector('[data-channel-card="whatsapp"]');
    expect(whatsappCard).not.toBeNull();
    const text = normalizeText(whatsappCard!);
    expect(text).toContain("Web QR link.");
    expect(text).not.toContain("WhatsApp WhatsApp Web QR link.");
    expect(text).not.toContain("Scan the QR with WhatsApp on your phone.");
    expect(text).not.toContain(
      "Credentials are stored under the WhatsApp account credential directory for future runs.",
    );
    const whatsappNotes = whatsappCard!.querySelector<HTMLElement>(".channel-signup-notes");
    expect(whatsappNotes?.getAttribute("data-tooltip")).toContain(
      "Scan the QR with WhatsApp on your phone.",
    );
    expect(whatsappNotes?.getAttribute("data-tooltip")).toContain(
      "Credentials are stored under the WhatsApp account credential directory for future runs.",
    );
    expect(text).toContain("Scan this QR in WhatsApp.");
    expect(text).not.toContain("Scan a QR from WhatsApp Linked Devices.");
    expect(text).toContain("Show QR");
    expect(text).toContain("Wait for scan");
    expect(text).toContain("WhatsApp DM access");
    expect(text).toContain("Phone setup");
    expect(text).not.toContain("Route to Agent");
    expect(text).not.toContain("Configured");
    expect(container.querySelector("img[alt='WhatsApp QR']")).not.toBeNull();

    Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.trim() === "Show QR")
      ?.click();
    expect(onWhatsAppStart).toHaveBeenCalledWith(false);

    Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.trim() === "Wait for scan")
      ?.click();
    expect(onWhatsAppWait).toHaveBeenCalledTimes(1);

    const phoneSetup = Array.from(container.querySelectorAll<HTMLSelectElement>("select")).find(
      (select) => select.value === "separate",
    );
    expect(phoneSetup).not.toBeNull();
    phoneSetup!.value = "personal";
    phoneSetup!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onConfigPatch).toHaveBeenCalledWith(["channels", "whatsapp", "selfChatMode"], true);
    expect(onConfigPatch).toHaveBeenCalledWith(["channels", "whatsapp", "dmPolicy"], "allowlist");
  });

  it("renders onboarding-style Discord channel access controls", () => {
    const container = document.createElement("div");
    const onConfigPatch = vi.fn();

    render(renderChannels(createProps({ onConfigPatch })), container);

    const text = normalizeText(container);
    expect(text).toContain("Discord channels access");
    expect(text).toContain("Discord channels allowlist");
    expect(text).not.toContain("Discord DM access");
    expect(text).not.toContain("Telegram DM access");
    expect(
      Array.from(container.querySelectorAll<HTMLInputElement>("input")).some(
        (input) => input.placeholder === "My Server/#general, guildId/channelId, #support",
      ),
    ).toBe(true);
    const policySelect = Array.from(container.querySelectorAll<HTMLSelectElement>("select")).find(
      (select) => select.value === "allowlist",
    );
    expect(policySelect).not.toBeNull();
    policySelect!.value = "open";
    policySelect!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onConfigPatch).toHaveBeenCalledWith(["channels", "discord", "groupPolicy"], "open");
  });

  it("returns WhatsApp to QR setup when config remains but the account is not linked", () => {
    const container = document.createElement("div");
    const snapshot = createSnapshot();
    snapshot.channelOrder = ["whatsapp"];
    snapshot.channelLabels = { whatsapp: "WhatsApp" };
    snapshot.channels = {
      whatsapp: {
        configured: true,
        linked: false,
        running: false,
        connected: false,
      } as never,
    };
    snapshot.channelAccounts = {
      whatsapp: [
        {
          accountId: "default",
          configured: true,
          linked: false,
          running: false,
          connected: false,
        },
      ],
    };

    render(renderChannels(createProps({ snapshot })), container);

    const text = normalizeText(container);
    expect(text).toContain("Show QR");
    expect(text).toContain("Connect");
    expect(text).not.toContain("Route to Agent");
    expect(text).not.toContain("Logout");
    expect(container.querySelector('[aria-label="Clear credentials"]')).toBeNull();
    const enable = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === "Enable",
    );
    expect(enable).toBeUndefined();
    expect(container.querySelector(".chip-warn")?.textContent ?? "").not.toContain("Enable");
  });

  it("does not render unsupported cards for empty channel schemas", () => {
    const container = document.createElement("div");

    render(
      renderChannels(
        createProps({
          configForm: { bindings: [] },
          configSchema: {
            type: "object",
            properties: {
              channels: {
                type: "object",
                properties: {
                  telegram: {},
                  discord: {},
                },
              },
              bindings: { type: "array" },
            },
          },
        }),
      ),
      container,
    );

    const text = normalizeText(container);
    expect(text).not.toContain("Unsupported type");
    expect(text).toContain("No setup fields for this channel.");
  });

  it("patches simple channel account routes through existing bindings config", () => {
    const container = document.createElement("div");
    const onConfigPatch = vi.fn();
    const onConfigSave = vi.fn();

    render(
      renderChannels(
        createProps({
          configFormDirty: true,
          onConfigPatch,
          onConfigSave,
        }),
      ),
      container,
    );

    const routeSelect = container.querySelector<HTMLSelectElement>(
      'select[data-test-id="channel-route-telegram-ops"]',
    );
    expect(routeSelect).not.toBeNull();
    expect(routeSelect?.value).toBe("support");

    routeSelect!.value = "research";
    routeSelect!.dispatchEvent(new Event("change", { bubbles: true }));

    expect(onConfigPatch).toHaveBeenCalledWith(
      ["bindings"],
      expect.arrayContaining([
        { agentId: "research", match: { channel: "telegram", accountId: "ops" } },
      ]),
    );
    const nextBindings = onConfigPatch.mock.calls[0]?.[1] as unknown[];
    expect(nextBindings).toContainEqual({
      agentId: "research",
      match: { channel: "telegram", accountId: "ops", peer: { kind: "topic", id: "market" } },
    });
    expect(nextBindings).toContainEqual({
      agentId: "research",
      match: { channel: "discord", accountId: "guild", peer: { kind: "channel", id: "dev" } },
    });
    expect(nextBindings).not.toContainEqual({
      agentId: "support",
      match: { channel: "telegram", accountId: "ops" },
    });

    container
      .querySelector<HTMLButtonElement>('button[data-test-id="channel-routes-save"]')
      ?.click();
    expect(onConfigSave).toHaveBeenCalledTimes(1);
  });

  it("moves global message behavior into the channels message tab", () => {
    const container = document.createElement("div");
    const onViewChange = vi.fn();
    const onConfigPatch = vi.fn();
    const onConfigRemove = vi.fn();
    const onConfigSave = vi.fn();

    render(
      renderChannels(
        createProps({
          activeView: "messages",
          configFormDirty: true,
          configForm: {
            messages: {
              responsePrefix: "[Fased]",
              ackReaction: "👀",
              ackReactionScope: "direct",
              inbound: { debounceMs: 300 },
              groupChat: { mentionPatterns: ["@fased"], historyLimit: 8 },
              tts: { auto: "tagged", mode: "final", provider: "edge", maxTextLength: 1200 },
            },
          },
          onViewChange,
          onConfigPatch,
          onConfigRemove,
          onConfigSave,
        }),
      ),
      container,
    );

    const text = normalizeText(container);
    expect(text).toContain("Behavior");
    expect(text).toContain("Reply Behavior");
    expect(text).toContain("Ack And Status Reactions");
    expect(text).toContain("Inbound Debounce");
    expect(text).toContain("Group Mention Behavior");
    expect(text).toContain("TTS And Voice");
    expect(text).not.toContain("Route to Agent");

    const prefix = container.querySelector<HTMLInputElement>('input[placeholder="none"]');
    expect(prefix?.value).toBe("[Fased]");
    prefix!.value = "[Ops]";
    prefix!.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onConfigPatch).toHaveBeenCalledWith(["messages", "responsePrefix"], "[Ops]");

    const ack = Array.from(container.querySelectorAll<HTMLInputElement>("input")).find(
      (input) => input.value === "👀",
    );
    ack!.value = "";
    ack!.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onConfigRemove).toHaveBeenCalledWith(["messages", "ackReaction"]);

    container.querySelector<HTMLButtonElement>(".channel-message-actions .btn.primary")?.click();
    expect(onConfigSave).toHaveBeenCalledTimes(1);
  });

  it("shows message behavior inside embedded Agent channels", () => {
    const container = document.createElement("div");
    render(
      renderChannels(
        createProps({
          activeView: "messages",
          configForm: {
            messages: {
              responsePrefix: "[Agent]",
              ackReactionScope: "direct",
            },
          },
        }),
        { embedded: true, showDebug: false },
      ),
      container,
    );

    const text = normalizeText(container);
    expect(text).toContain("Accounts");
    expect(text).toContain("Behavior");
    expect(text).toContain("Reply Behavior");
    expect(text).not.toContain("Debug snapshot");
    expect(container.querySelector<HTMLInputElement>('input[placeholder="none"]')?.value).toBe(
      "[Agent]",
    );
  });

  it("moves command policy into the channels command access tab", () => {
    const container = document.createElement("div");
    const onConfigPatch = vi.fn();
    const onConfigRemove = vi.fn();
    const onConfigSave = vi.fn();

    render(
      renderChannels(
        createProps({
          activeView: "commands",
          configFormDirty: true,
          configForm: {
            commands: {
              text: true,
              native: false,
              nativeSkills: "auto",
              useAccessGroups: true,
              ownerAllowFrom: ["telegram:123"],
              allowFrom: { "*": ["telegram:123"] },
            },
          },
          onConfigPatch,
          onConfigRemove,
          onConfigSave,
        }),
      ),
      container,
    );

    const text = normalizeText(container);
    expect(text).toContain("Access");
    expect(text).toContain("Command Behavior");
    expect(text).toContain("Command Access");
    expect(text).not.toContain("Reply Behavior");

    const selects = Array.from(container.querySelectorAll<HTMLSelectElement>("select"));
    expect(selects[0]?.value).toBe("on");
    selects[0].value = "off";
    selects[0].dispatchEvent(new Event("change", { bubbles: true }));
    expect(onConfigPatch).toHaveBeenCalledWith(["commands", "text"], false);

    expect(selects[1]?.value).toBe("off");
    selects[1].value = "auto";
    selects[1].dispatchEvent(new Event("change", { bubbles: true }));
    expect(onConfigRemove).toHaveBeenCalledWith(["commands", "native"]);

    const ownerAllowlist = Array.from(
      container.querySelectorAll<HTMLTextAreaElement>("textarea"),
    ).find((textarea) => textarea.value.includes("telegram:123"));
    ownerAllowlist!.value = "discord:user:456";
    ownerAllowlist!.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onConfigPatch).toHaveBeenCalledWith(
      ["commands", "ownerAllowFrom"],
      ["discord:user:456"],
    );

    const allowFrom = Array.from(container.querySelectorAll<HTMLTextAreaElement>("textarea")).find(
      (textarea) => textarea.value.includes('"*"'),
    );
    allowFrom!.value = '{"discord":["user:456"]}';
    allowFrom!.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onConfigPatch).toHaveBeenCalledWith(["commands", "allowFrom"], {
      discord: ["user:456"],
    });

    container.querySelector<HTMLButtonElement>(".channel-message-actions .btn.primary")?.click();
    expect(onConfigSave).toHaveBeenCalledTimes(1);
  });

  it("moves session routing into the channels sessions tab", () => {
    const container = document.createElement("div");
    const onConfigPatch = vi.fn();
    const onConfigRemove = vi.fn();
    const onConfigSave = vi.fn();

    render(
      renderChannels(
        createProps({
          activeView: "sessions",
          configFormDirty: true,
          configForm: {
            session: {
              dmScope: "per-channel-peer",
              identityLinks: {
                "person:alex": ["telegram:123"],
              },
              threadBindings: {
                enabled: true,
                idleHours: 24,
              },
              resetByType: {
                direct: {
                  mode: "idle",
                  idleMinutes: 60,
                },
              },
            },
          },
          onConfigPatch,
          onConfigRemove,
          onConfigSave,
        }),
      ),
      container,
    );

    const text = normalizeText(container);
    expect(text).toContain("Sessions");
    expect(text).toContain("Session Routing");
    expect(text).toContain("Thread Sessions");
    expect(text).toContain("Reset Rules");
    expect(text).not.toContain("Route to Agent");

    const dmScope = Array.from(container.querySelectorAll<HTMLSelectElement>("select")).find(
      (select) => select.value === "per-channel-peer",
    );
    dmScope!.value = "per-account-channel-peer";
    dmScope!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onConfigPatch).toHaveBeenCalledWith(["session", "dmScope"], "per-account-channel-peer");

    const identityLinks = container.querySelector<HTMLTextAreaElement>("textarea");
    identityLinks!.value = '{"person:sam":["discord:456"]}';
    identityLinks!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onConfigPatch).toHaveBeenCalledWith(["session", "identityLinks"], {
      "person:sam": ["discord:456"],
    });

    const idleMinutes = Array.from(container.querySelectorAll<HTMLInputElement>("input")).find(
      (input) => input.value === "60",
    );
    idleMinutes!.value = "120";
    idleMinutes!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onConfigPatch).toHaveBeenCalledWith(
      ["session", "resetByType", "direct", "idleMinutes"],
      120,
    );

    Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Save session routing"))
      ?.click();
    expect(onConfigSave).toHaveBeenCalledTimes(1);
  });

  it("moves web-client runtime settings into the channels web runtime tab", () => {
    const container = document.createElement("div");
    const onConfigPatch = vi.fn();
    const onConfigRemove = vi.fn();
    const onConfigSave = vi.fn();

    render(
      renderChannels(
        createProps({
          activeView: "web",
          configFormDirty: true,
          configForm: {
            web: {
              enabled: true,
              heartbeatSeconds: 45,
              reconnect: {
                initialMs: 500,
                maxMs: 10000,
                factor: 2,
                jitter: 0.1,
                maxAttempts: 5,
              },
            },
          },
          onConfigPatch,
          onConfigRemove,
          onConfigSave,
        }),
      ),
      container,
    );

    const text = normalizeText(container);
    expect(text).toContain("Web Client Runtime");
    expect(text).toContain("Reconnect Policy");

    const runtime = container.querySelector<HTMLSelectElement>('select[aria-label="Runtime"]');
    expect(runtime?.value).toBe("on");
    runtime!.value = "off";
    runtime!.dispatchEvent(new Event("change"));
    expect(onConfigPatch).toHaveBeenCalledWith(["web", "enabled"], false);

    const heartbeat = container.querySelector<HTMLInputElement>(
      'input[aria-label="Heartbeat seconds"]',
    );
    expect(heartbeat?.value).toBe("45");
    heartbeat!.value = "";
    heartbeat!.dispatchEvent(new Event("input"));
    expect(onConfigRemove).toHaveBeenCalledWith(["web", "heartbeatSeconds"]);

    const maxMs = container.querySelector<HTMLInputElement>('input[aria-label="Max ms"]');
    expect(maxMs?.value).toBe("10000");
    maxMs!.value = "20000";
    maxMs!.dispatchEvent(new Event("input"));
    expect(onConfigPatch).toHaveBeenCalledWith(["web", "reconnect", "maxMs"], 20000);

    Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Save web runtime"))
      ?.click();
    expect(onConfigSave).toHaveBeenCalledTimes(1);
  });
});
