import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import { createChannelTestPluginBase } from "../test-utils/channel-plugins.js";
import { setRegistry } from "./server.agent.gateway-server-agent.mocks.js";
import { createRegistry } from "./server.e2e-registry-helpers.js";
import {
  connectOk,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
} from "./test-helpers.js";

let readConfigFileSnapshot: typeof import("../config/config.js").readConfigFileSnapshot;
let writeConfigFile: typeof import("../config/config.js").writeConfigFile;

installGatewayTestHooks({ scope: "suite" });

const createStubChannelPlugin = (params: {
  id: ChannelPlugin["id"];
  label: string;
  summary?: Record<string, unknown>;
  logoutCleared?: boolean;
}): ChannelPlugin => ({
  ...createChannelTestPluginBase({
    id: params.id,
    label: params.label,
    config: { isConfigured: async () => false },
  }),
  status: {
    buildChannelSummary: async () => ({
      configured: false,
      ...params.summary,
    }),
  },
  gateway: {
    logoutAccount: async () => ({
      cleared: params.logoutCleared ?? false,
      envToken: false,
    }),
  },
});

const telegramPlugin: ChannelPlugin = {
  ...createStubChannelPlugin({
    id: "telegram",
    label: "Telegram",
    summary: { tokenSource: "none", lastProbeAt: null },
    logoutCleared: true,
  }),
  gateway: {
    logoutAccount: async ({ cfg }) => {
      const nextTelegram = cfg.channels?.telegram ? { ...cfg.channels.telegram } : {};
      delete nextTelegram.botToken;
      await writeConfigFile({
        ...cfg,
        channels: {
          ...cfg.channels,
          telegram: nextTelegram,
        },
      });
      return { cleared: true, envToken: false, loggedOut: true };
    },
  },
};

const defaultRegistry = createRegistry([
  {
    pluginId: "whatsapp",
    source: "test",
    plugin: createStubChannelPlugin({ id: "whatsapp", label: "WhatsApp" }),
  },
  {
    pluginId: "telegram",
    source: "test",
    plugin: telegramPlugin,
  },
  {
    pluginId: "signal",
    source: "test",
    plugin: createStubChannelPlugin({
      id: "signal",
      label: "Signal",
      summary: { lastProbeAt: null },
    }),
  },
  {
    pluginId: "msteams",
    source: "test",
    plugin: createStubChannelPlugin({
      id: "msteams",
      label: "Microsoft Teams",
    }),
  },
  {
    pluginId: "matrix",
    source: "test",
    plugin: createStubChannelPlugin({
      id: "matrix",
      label: "Matrix",
    }),
  },
  {
    pluginId: "mattermost",
    source: "test",
    plugin: createStubChannelPlugin({
      id: "mattermost",
      label: "Mattermost",
    }),
  },
  {
    pluginId: "nextcloud-talk",
    source: "test",
    plugin: createStubChannelPlugin({
      id: "nextcloud-talk",
      label: "Nextcloud Talk",
    }),
  },
  {
    pluginId: "bluebubbles",
    source: "test",
    plugin: createStubChannelPlugin({
      id: "bluebubbles",
      label: "BlueBubbles",
    }),
  },
  {
    pluginId: "line",
    source: "test",
    plugin: createStubChannelPlugin({
      id: "line",
      label: "LINE",
    }),
  },
  {
    pluginId: "synology-chat",
    source: "test",
    plugin: createStubChannelPlugin({
      id: "synology-chat",
      label: "Synology Chat",
    }),
  },
  {
    pluginId: "tlon",
    source: "test",
    plugin: createStubChannelPlugin({
      id: "tlon",
      label: "Tlon",
    }),
  },
  {
    pluginId: "zalo",
    source: "test",
    plugin: createStubChannelPlugin({
      id: "zalo",
      label: "Zalo",
    }),
  },
  {
    pluginId: "zalouser",
    source: "test",
    plugin: createStubChannelPlugin({
      id: "zalouser",
      label: "Zalo Personal",
    }),
  },
]);

let server: Awaited<ReturnType<typeof startServerWithClient>>["server"];
let ws: Awaited<ReturnType<typeof startServerWithClient>>["ws"];

beforeAll(async () => {
  ({ readConfigFileSnapshot, writeConfigFile } = await import("../config/config.js"));
  setRegistry(defaultRegistry);
  const started = await startServerWithClient();
  server = started.server;
  ws = started.ws;
  await connectOk(ws);
});

afterAll(async () => {
  ws.close();
  await server.close();
});

describe("gateway server channels", () => {
  test("channels.status returns snapshot without probe", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", undefined);
    setRegistry(defaultRegistry);
    const res = await rpcReq<{
      channelOrder?: string[];
      channelSetup?: Record<
        string,
        { title?: string; fields?: unknown[]; access?: unknown; dmPolicy?: unknown }
      >;
      channels?: Record<
        string,
        {
          configured?: boolean;
          catalogOnly?: boolean;
          pendingRestart?: boolean;
          tokenSource?: string;
          probe?: unknown;
          lastProbeAt?: unknown;
          linked?: boolean;
        }
      >;
    }>(ws, "channels.status", { probe: false, timeoutMs: 2000 });
    expect(res.ok).toBe(true);
    const telegram = res.payload?.channels?.telegram;
    const signal = res.payload?.channels?.signal;
    expect(res.payload?.channels?.whatsapp).toBeTruthy();
    expect(res.payload?.channelOrder).toEqual(
      expect.arrayContaining(["telegram", "whatsapp", "discord", "irc", "googlechat", "slack"]),
    );
    expect(res.payload?.channels?.discord?.catalogOnly).toBe(true);
    expect(res.payload?.channelSetup?.discord?.title).toBe("Discord");
    expect(res.payload?.channelSetup?.discord?.fields).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: "Bot token" })]),
    );
    expect(res.payload?.channelSetup?.discord?.access).toEqual(
      expect.objectContaining({
        kind: "discord-channels",
        label: "Discord channels",
        placeholder: "My Server/#general, guildId/channelId, #support",
      }),
    );
    expect(res.payload?.channelSetup?.discord?.dmPolicy).toEqual(
      expect.objectContaining({
        policyKey: "channels.discord.dmPolicy",
        allowFromKey: "channels.discord.allowFrom",
      }),
    );
    expect(res.payload?.channelSetup?.telegram?.dmPolicy).toEqual(
      expect.objectContaining({
        policyKey: "channels.telegram.dmPolicy",
        allowFromKey: "channels.telegram.allowFrom",
      }),
    );
    expect(res.payload?.channelSetup?.telegram?.title).toBe("Telegram");
    expect(res.payload?.channelSetup?.irc?.title).toBe("IRC");
    expect(res.payload?.channelSetup?.irc?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Server host" }),
        expect.objectContaining({ label: "Nick" }),
      ]),
    );
    const ircFieldLabels = (res.payload?.channelSetup?.irc?.fields ?? []).map((field) =>
      typeof field === "object" && field && "label" in field
        ? String((field as { label?: unknown }).label)
        : "",
    );
    expect(ircFieldLabels).toEqual(["Server host", "Nick", "Channels", "Port"]);
    expect(ircFieldLabels).not.toContain("Server password");
    expect(res.payload?.channelSetup?.googlechat?.title).toBe("Google Chat");
    expect(res.payload?.channelSetup?.googlechat?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Service account file" }),
        expect.objectContaining({ label: "Webhook path" }),
      ]),
    );
    const googleChatFieldLabels = (res.payload?.channelSetup?.googlechat?.fields ?? []).map(
      (field) =>
        typeof field === "object" && field && "label" in field
          ? String((field as { label?: unknown }).label)
          : "",
    );
    expect(googleChatFieldLabels).toEqual([
      "Service account file",
      "Webhook path",
      "Webhook URL",
      "Audience type",
      "Audience",
      "Bot user",
    ]);
    expect(res.payload?.channelSetup?.slack?.title).toBe("Slack");
    expect(res.payload?.channelSetup?.slack?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Bot token" }),
        expect.objectContaining({ label: "App token" }),
      ]),
    );
    expect(res.payload?.channelSetup?.slack?.access).toEqual(
      expect.objectContaining({
        kind: "slack-channels",
        label: "Slack channels",
        placeholder: "#general, #private, C123",
      }),
    );
    expect(res.payload?.channelSetup?.signal?.title).toBe("Signal");
    expect(res.payload?.channelSetup?.signal?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Signal number" }),
        expect.objectContaining({ label: "CLI path" }),
      ]),
    );
    const signalFieldLabels = (res.payload?.channelSetup?.signal?.fields ?? []).map((field) =>
      typeof field === "object" && field && "label" in field
        ? String((field as { label?: unknown }).label)
        : "",
    );
    expect(signalFieldLabels).toEqual(["Signal number", "CLI path"]);
    expect(res.payload?.channelSetup?.imessage?.title).toBe("iMessage");
    expect(res.payload?.channelSetup?.imessage?.fields).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: "CLI path" })]),
    );
    const imessageFieldLabels = (res.payload?.channelSetup?.imessage?.fields ?? []).map((field) =>
      typeof field === "object" && field && "label" in field
        ? String((field as { label?: unknown }).label)
        : "",
    );
    expect(imessageFieldLabels).toEqual(["CLI path"]);
    expect(res.payload?.channelSetup?.msteams?.title).toBe("Microsoft Teams");
    expect(res.payload?.channelSetup?.msteams?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "App ID" }),
        expect.objectContaining({ label: "App Password" }),
        expect.objectContaining({ label: "Tenant ID" }),
      ]),
    );
    expect(res.payload?.channelSetup?.msteams?.access).toEqual(
      expect.objectContaining({
        kind: "msteams-channels",
        label: "MS Teams channels",
        placeholder: "Team Name/Channel Name, teamId/conversationId",
      }),
    );
    expect(res.payload?.channelSetup?.matrix?.title).toBe("Matrix");
    expect(res.payload?.channelSetup?.matrix?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Homeserver URL" }),
        expect.objectContaining({ label: "Access token" }),
        expect.objectContaining({ label: "User ID" }),
        expect.objectContaining({ label: "Password" }),
        expect.objectContaining({ label: "Device name" }),
      ]),
    );
    expect(res.payload?.channelSetup?.matrix?.access).toEqual(
      expect.objectContaining({
        kind: "matrix-rooms",
        label: "Matrix rooms",
        placeholder: "!roomId:server, #alias:server, Project Room",
      }),
    );
    expect(res.payload?.channelSetup?.mattermost?.title).toBe("Mattermost");
    expect(res.payload?.channelSetup?.mattermost?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Bot token" }),
        expect.objectContaining({ label: "Base URL" }),
      ]),
    );
    expect(res.payload?.channelSetup?.["nextcloud-talk"]?.title).toBe("Nextcloud Talk");
    expect(res.payload?.channelSetup?.["nextcloud-talk"]?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Instance URL" }),
        expect.objectContaining({ label: "Bot secret" }),
      ]),
    );
    expect(res.payload?.channelSetup?.bluebubbles?.title).toBe("BlueBubbles");
    expect(res.payload?.channelSetup?.bluebubbles?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Server URL" }),
        expect.objectContaining({ label: "Password" }),
        expect.objectContaining({ label: "Webhook path" }),
      ]),
    );
    expect(res.payload?.channelSetup?.bluebubbles?.dmPolicy).toEqual(
      expect.objectContaining({
        policyKey: "channels.bluebubbles.dmPolicy",
        allowFromKey: "channels.bluebubbles.allowFrom",
      }),
    );
    expect(res.payload?.channelSetup?.line?.title).toBe("LINE");
    expect(res.payload?.channelSetup?.line?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Channel access token" }),
        expect.objectContaining({ label: "Channel secret" }),
        expect.objectContaining({ label: "Webhook path" }),
      ]),
    );
    expect(res.payload?.channelSetup?.line?.dmPolicy).toEqual(
      expect.objectContaining({
        policyKey: "channels.line.dmPolicy",
        allowFromKey: "channels.line.allowFrom",
      }),
    );
    expect(res.payload?.channelSetup?.["synology-chat"]?.title).toBe("Synology Chat");
    expect(res.payload?.channelSetup?.["synology-chat"]?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Outgoing token" }),
        expect.objectContaining({ label: "Incoming webhook URL" }),
        expect.objectContaining({ label: "Webhook path" }),
        expect.objectContaining({ label: "DM policy" }),
        expect.objectContaining({ label: "Allowed user IDs" }),
        expect.objectContaining({ label: "Rate limit/min" }),
      ]),
    );
    expect(res.payload?.channelSetup?.tlon?.title).toBe("Tlon");
    expect(res.payload?.channelSetup?.tlon?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Ship name" }),
        expect.objectContaining({ label: "Ship URL" }),
        expect.objectContaining({ label: "Login code" }),
        expect.objectContaining({ label: "Allow private network" }),
        expect.objectContaining({ label: "Group channels" }),
        expect.objectContaining({ label: "DM allowlist" }),
        expect.objectContaining({ label: "Auto-discover groups" }),
      ]),
    );
    expect(res.payload?.channelSetup?.zalo?.title).toBe("Zalo");
    expect(res.payload?.channelSetup?.zalo?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Bot token" }),
        expect.objectContaining({ label: "Token file" }),
        expect.objectContaining({ label: "Webhook URL" }),
        expect.objectContaining({ label: "Webhook secret" }),
        expect.objectContaining({ label: "Webhook path" }),
      ]),
    );
    expect(res.payload?.channelSetup?.zalo?.dmPolicy).toEqual(
      expect.objectContaining({
        policyKey: "channels.zalo.dmPolicy",
        allowFromKey: "channels.zalo.allowFrom",
      }),
    );
    expect(res.payload?.channelSetup?.zalouser?.title).toBe("Zalo Personal");
    expect(res.payload?.channelSetup?.zalouser?.fields).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: "ZCA profile" })]),
    );
    expect(res.payload?.channelSetup?.zalouser?.access).toEqual(
      expect.objectContaining({
        kind: "zalouser-groups",
        label: "Zalo groups",
        placeholder: "Family, Work, 123456789",
      }),
    );
    expect(res.payload?.channelSetup?.zalouser?.dmPolicy).toEqual(
      expect.objectContaining({
        policyKey: "channels.zalouser.dmPolicy",
        allowFromKey: "channels.zalouser.allowFrom",
      }),
    );
    expect(res.payload?.channelSetup?.wecom).toBeUndefined();
    expect(telegram?.configured).toBe(false);
    expect(telegram?.tokenSource).toBe("none");
    expect(telegram?.probe).toBeUndefined();
    expect(telegram?.lastProbeAt).toBeNull();
    expect(signal?.configured).toBe(false);
    expect(signal?.probe).toBeUndefined();
    expect(signal?.lastProbeAt).toBeNull();
  });

  test("channels.status exposes binding peer as default account audience", async () => {
    setRegistry(defaultRegistry);
    await writeConfigFile({
      bindings: [
        {
          agentId: "main",
          match: {
            channel: "telegram",
            peer: { kind: "direct", id: "397848047" },
          },
        },
      ],
    });

    try {
      const res = await rpcReq<{
        channelAccounts?: Record<
          string,
          Array<{ accountId: string; audience?: string; audienceType?: string }>
        >;
      }>(ws, "channels.status", { probe: false, timeoutMs: 2000 });

      expect(res.ok).toBe(true);
      expect(res.payload?.channelAccounts?.telegram?.[0]).toEqual(
        expect.objectContaining({
          accountId: "default",
          audience: "397848047",
          audienceType: "direct",
        }),
      );
    } finally {
      await writeConfigFile({});
    }
  });

  test("channels.status marks installed catalog channels as restart-required", async () => {
    setRegistry(defaultRegistry);
    await writeConfigFile({
      plugins: {
        installs: {
          discord: {
            source: "npm",
            spec: "@fased/discord",
            installPath: "/tmp/fased-discord",
          },
        },
      },
    });

    const res = await rpcReq<{
      channels?: Record<string, { catalogOnly?: boolean; pendingRestart?: boolean }>;
    }>(ws, "channels.status", { probe: false, timeoutMs: 2000 });

    expect(res.ok).toBe(true);
    expect(res.payload?.channels?.discord?.catalogOnly).toBe(true);
    expect(res.payload?.channels?.discord?.pendingRestart).toBe(true);
  });

  test("channels.status marks enabled unloaded bundled channels as restart-required", async () => {
    setRegistry(defaultRegistry);
    await writeConfigFile({
      plugins: {
        entries: {
          discord: {
            enabled: true,
          },
        },
      },
    });

    const res = await rpcReq<{
      channels?: Record<string, { catalogOnly?: boolean; pendingRestart?: boolean }>;
    }>(ws, "channels.status", { probe: false, timeoutMs: 2000 });

    expect(res.ok).toBe(true);
    expect(res.payload?.channels?.discord?.catalogOnly).toBe(true);
    expect(res.payload?.channels?.discord?.pendingRestart).toBe(true);
  });

  test("channels.status marks configured unloaded channels as restart-required", async () => {
    setRegistry(defaultRegistry);
    await writeConfigFile({
      channels: {
        discord: {
          enabled: true,
          token: "discord-token",
        },
      },
    });

    const res = await rpcReq<{
      channels?: Record<string, { catalogOnly?: boolean; pendingRestart?: boolean }>;
    }>(ws, "channels.status", { probe: false, timeoutMs: 2000 });

    expect(res.ok).toBe(true);
    expect(res.payload?.channels?.discord?.catalogOnly).toBe(true);
    expect(res.payload?.channels?.discord?.pendingRestart).toBe(true);
  });

  test("channels.status ignores pending installs that are not in the active catalog", async () => {
    setRegistry(defaultRegistry);
    await writeConfigFile({
      plugins: {
        installs: {
          yuanbao: {
            source: "npm",
            spec: "fased-plugin-yuanbao@2.11.0",
            resolvedName: "fased-plugin-yuanbao",
            installPath: "/tmp/fased-yuanbao",
          },
        },
      },
    });

    const res = await rpcReq<{
      channels?: Record<string, { catalogOnly?: boolean; pendingRestart?: boolean }>;
    }>(ws, "channels.status", { probe: false, timeoutMs: 2000 });

    expect(res.ok).toBe(true);
    expect(res.payload?.channels?.yuanbao).toBeUndefined();
  });

  test("channels.logout reports no session when missing", async () => {
    setRegistry(defaultRegistry);
    const res = await rpcReq<{ cleared?: boolean; channel?: string }>(ws, "channels.logout", {
      channel: "whatsapp",
    });
    expect(res.ok).toBe(true);
    expect(res.payload?.channel).toBe("whatsapp");
    expect(res.payload?.cleared).toBe(false);
  });

  test("channels.logout clears WhatsApp web credentials", async () => {
    setRegistry(defaultRegistry);
    const authDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wa-auth-"));
    await fs.writeFile(path.join(authDir, "creds.json"), "{}", "utf-8");
    await writeConfigFile({
      channels: {
        whatsapp: {
          accounts: {
            default: { authDir },
          },
        },
      },
    });

    const res = await rpcReq<{ cleared?: boolean; channel?: string }>(ws, "channels.logout", {
      channel: "whatsapp",
    });

    expect(res.ok).toBe(true);
    expect(res.payload?.channel).toBe("whatsapp");
    expect(res.payload?.cleared).toBe(true);
    expect(fsSync.existsSync(authDir)).toBe(false);
  });

  test("channels.logout clears telegram bot token from config", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", undefined);
    setRegistry(defaultRegistry);
    await writeConfigFile({
      channels: {
        telegram: {
          botToken: "123:abc",
          groups: { "*": { requireMention: false } },
        },
      },
    });
    const res = await rpcReq<{
      cleared?: boolean;
      envToken?: boolean;
      channel?: string;
    }>(ws, "channels.logout", { channel: "telegram" });
    expect(res.ok).toBe(true);
    expect(res.payload?.channel).toBe("telegram");
    expect(res.payload?.cleared).toBe(true);
    expect(res.payload?.envToken).toBe(false);

    const snap = await readConfigFileSnapshot();
    expect(snap.valid).toBe(true);
    expect(snap.config?.channels?.telegram?.botToken).toBeUndefined();
    expect(snap.config?.channels?.telegram?.groups?.["*"]?.requireMention).toBe(false);
  });
});
