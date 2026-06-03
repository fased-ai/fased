import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import type { FasedAgentConfig } from "../../config/config.js";
import type { DiscordProbe } from "../../discord/probe.js";
import type { DiscordTokenResolution } from "../../discord/token.js";
import type { IMessageProbe } from "../../imessage/probe.js";
import type { LineProbeResult } from "../../line/types.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import type { SignalProbe } from "../../signal/probe.js";
import type { SlackProbe } from "../../slack/probe.js";
import type { TelegramProbe } from "../../telegram/probe.js";
import type { TelegramTokenResolution } from "../../telegram/token.js";
import {
  createChannelTestPluginBase,
  createMSTeamsTestPluginBase,
  createOutboundTestPlugin,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { getChannelPluginCatalogEntry, listChannelPluginCatalogEntries } from "./catalog.js";
import { resolveChannelConfigWrites } from "./config-writes.js";
import {
  listDiscordDirectoryGroupsFromConfig,
  listDiscordDirectoryPeersFromConfig,
  listSlackDirectoryGroupsFromConfig,
  listSlackDirectoryPeersFromConfig,
  listTelegramDirectoryGroupsFromConfig,
  listTelegramDirectoryPeersFromConfig,
  listWhatsAppDirectoryGroupsFromConfig,
  listWhatsAppDirectoryPeersFromConfig,
} from "./directory-config.js";
import { listChannelPlugins } from "./index.js";
import { loadChannelPlugin } from "./load.js";
import { loadChannelOutboundAdapter } from "./outbound/load.js";
import { buildChannelAccountSnapshot } from "./status.js";
import type { ChannelDirectoryEntry, ChannelOutboundAdapter, ChannelPlugin } from "./types.js";
import type { BaseProbeResult, BaseTokenResolution } from "./types.js";

describe("channel plugin registry", () => {
  const emptyRegistry = createTestRegistry([]);

  const createPlugin = (id: string): ChannelPlugin => ({
    id,
    meta: {
      id,
      label: id,
      selectionLabel: id,
      docsPath: `/channels/${id}`,
      blurb: "test",
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => [],
      resolveAccount: () => ({}),
    },
  });

  beforeEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  afterEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  it("sorts channel plugins by configured order", () => {
    const registry = createTestRegistry(
      ["slack", "telegram", "signal"].map((id) => ({
        pluginId: id,
        plugin: createPlugin(id),
        source: "test",
      })),
    );
    setActivePluginRegistry(registry);
    const pluginIds = listChannelPlugins().map((plugin) => plugin.id);
    expect(pluginIds).toEqual(["telegram", "slack", "signal"]);
  });
});

describe("channel plugin catalog", () => {
  it("includes Microsoft Teams", () => {
    const entry = getChannelPluginCatalogEntry("msteams");
    expect(entry?.install.npmSpec).toBe("@fased/msteams");
    expect(entry?.install.localPath).toBe("extensions/msteams");
    expect(entry?.install.defaultChoice).toBe("local");
    expect(entry?.meta.aliases).toContain("teams");
    expect(entry?.catalogSource).toBe("bundled");
  });

  it("lists plugin catalog entries", () => {
    const ids = listChannelPluginCatalogEntries().map((entry) => entry.id);
    expect(ids).toContain("irc");
    expect(ids).toContain("bluebubbles");
    expect(ids).toContain("line");
    expect(ids).toContain("synology-chat");
    expect(ids).toContain("tlon");
    expect(ids).toContain("zalo");
    expect(ids).toContain("zalouser");
    expect(ids).toContain("msteams");
    expect(ids).toContain("nostr");
    expect(ids).not.toContain("wecom");
    expect(ids).not.toContain("yuanbao");
  });

  it("includes bundled Nostr with local and npm install metadata", () => {
    const entry = getChannelPluginCatalogEntry("nostr");
    expect(entry?.install.npmSpec).toBe("@fased/nostr");
    expect(entry?.install.localPath).toBe("extensions/nostr");
    expect(entry?.install.defaultChoice).toBe("local");
    expect(entry?.meta.label).toBe("Nostr");
    expect(entry?.catalogSource).toBe("bundled");
  });

  it("includes bundled Matrix with local install metadata", () => {
    const entry = getChannelPluginCatalogEntry("matrix");
    expect(entry?.install.npmSpec).toBe("@fased/matrix");
    expect(entry?.install.localPath).toBe("extensions/matrix");
    expect(entry?.install.defaultChoice).toBe("local");
    expect(entry?.meta.blurb).toBe("open protocol; configure a homeserver + access token.");
    expect(entry?.catalogSource).toBe("bundled");
  });

  it("includes bundled Mattermost with local install metadata", () => {
    const entry = getChannelPluginCatalogEntry("mattermost");
    expect(entry?.install.npmSpec).toBe("@fased/mattermost");
    expect(entry?.install.localPath).toBe("extensions/mattermost");
    expect(entry?.install.defaultChoice).toBe("local");
    expect(entry?.meta.blurb).toBe(
      "self-hosted Slack-style chat; configure a bot token and server URL.",
    );
    expect(entry?.catalogSource).toBe("bundled");
  });

  it("includes bundled Nextcloud Talk with local install metadata", () => {
    const entry = getChannelPluginCatalogEntry("nextcloud-talk");
    expect(entry?.install.npmSpec).toBe("@fased/nextcloud-talk");
    expect(entry?.install.localPath).toBe("extensions/nextcloud-talk");
    expect(entry?.install.defaultChoice).toBe("local");
    expect(entry?.meta.blurb).toBe("Self-hosted chat via Nextcloud Talk webhook bots.");
    expect(entry?.catalogSource).toBe("bundled");
  });

  it("includes bundled BlueBubbles with local install metadata", () => {
    const entry = getChannelPluginCatalogEntry("bluebubbles");
    expect(entry?.install.npmSpec).toBe("@fased/bluebubbles");
    expect(entry?.install.localPath).toBe("extensions/bluebubbles");
    expect(entry?.install.defaultChoice).toBe("local");
    expect(entry?.meta.blurb).toBe("iMessage via the BlueBubbles mac app + REST API.");
    expect(entry?.catalogSource).toBe("bundled");
  });

  it("includes bundled LINE with local install metadata", () => {
    const entry = getChannelPluginCatalogEntry("line");
    expect(entry?.install.npmSpec).toBe("@fased/line");
    expect(entry?.install.localPath).toBe("extensions/line");
    expect(entry?.install.defaultChoice).toBe("local");
    expect(entry?.meta.blurb).toBe("LINE Messaging API bot for Japan/Taiwan/Thailand markets.");
    expect(entry?.catalogSource).toBe("bundled");
  });

  it("includes bundled Synology Chat with local install metadata", () => {
    const entry = getChannelPluginCatalogEntry("synology-chat");
    expect(entry?.install.npmSpec).toBe("@fased/synology-chat");
    expect(entry?.install.localPath).toBe("extensions/synology-chat");
    expect(entry?.install.defaultChoice).toBe("local");
    expect(entry?.meta.blurb).toBe(
      "Connect your Synology NAS Chat to FasedAgent with full agent capabilities.",
    );
    expect(entry?.catalogSource).toBe("bundled");
  });

  it("includes bundled Tlon with local install metadata", () => {
    const entry = getChannelPluginCatalogEntry("tlon");
    expect(entry?.install.npmSpec).toBe("@fased/tlon");
    expect(entry?.install.localPath).toBe("extensions/tlon");
    expect(entry?.install.defaultChoice).toBe("local");
    expect(entry?.meta.blurb).toBe(
      "decentralized messaging on Urbit; configure a ship URL and login code.",
    );
    expect(entry?.catalogSource).toBe("bundled");
  });

  it("includes bundled Zalo with local install metadata", () => {
    const entry = getChannelPluginCatalogEntry("zalo");
    expect(entry?.install.npmSpec).toBe("@fased/zalo");
    expect(entry?.install.localPath).toBe("extensions/zalo");
    expect(entry?.install.defaultChoice).toBe("local");
    expect(entry?.meta.blurb).toBe("Vietnam-focused messaging platform with Bot API.");
    expect(entry?.catalogSource).toBe("bundled");
  });

  it("includes bundled Zalo Personal with local install metadata", () => {
    const entry = getChannelPluginCatalogEntry("zalouser");
    expect(entry?.install.npmSpec).toBe("@fased/zalouser");
    expect(entry?.install.localPath).toBe("extensions/zalouser");
    expect(entry?.install.defaultChoice).toBe("local");
    expect(entry?.meta.blurb).toBe("Zalo personal account via QR code login.");
    expect(entry?.catalogSource).toBe("bundled");
  });

  it("includes bundled IRC with local and npm install metadata", () => {
    const entry = getChannelPluginCatalogEntry("irc");
    expect(entry?.install.npmSpec).toBe("@fased/irc");
    expect(entry?.install.localPath).toBe("extensions/irc");
    expect(entry?.install.defaultChoice).toBe("local");
    expect(entry?.meta.label).toBe("IRC");
    expect(entry?.catalogSource).toBe("bundled");
  });

  it("does not list disabled official external channel catalog entries by default", () => {
    const wecom = getChannelPluginCatalogEntry("wecom");
    expect(wecom).toBeUndefined();

    const yuanbao = getChannelPluginCatalogEntry("yuanbao");
    expect(yuanbao).toBeUndefined();
  });

  it("includes external catalog entries", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fased-catalog-"));
    const catalogPath = path.join(dir, "catalog.json");
    fs.writeFileSync(
      catalogPath,
      JSON.stringify({
        entries: [
          {
            name: "@fased/demo-channel",
            fased: {
              channel: {
                id: "demo-channel",
                label: "Demo Channel",
                selectionLabel: "Demo Channel",
                docsPath: "/channels/demo-channel",
                blurb: "Demo entry",
                order: 999,
              },
              install: {
                npmSpec: "@fased/demo-channel",
              },
            },
          },
        ],
      }),
    );

    const entries = listChannelPluginCatalogEntries({ catalogPaths: [catalogPath] });
    const ids = entries.map((entry) => entry.id);
    expect(ids).toContain("demo-channel");
    expect(entries.find((entry) => entry.id === "demo-channel")?.catalogSource).toBe(
      "external-catalog",
    );
  });
});

const emptyRegistry = createTestRegistry([]);

const msteamsOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  sendText: async () => ({ channel: "msteams", messageId: "m1" }),
  sendMedia: async () => ({ channel: "msteams", messageId: "m2" }),
};

const msteamsPlugin: ChannelPlugin = {
  ...createMSTeamsTestPluginBase(),
  outbound: msteamsOutbound,
};

const registryWithMSTeams = createTestRegistry([
  { pluginId: "msteams", plugin: msteamsPlugin, source: "test" },
]);

const msteamsOutboundV2: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  sendText: async () => ({ channel: "msteams", messageId: "m3" }),
  sendMedia: async () => ({ channel: "msteams", messageId: "m4" }),
};

const msteamsPluginV2 = createOutboundTestPlugin({
  id: "msteams",
  label: "Microsoft Teams",
  outbound: msteamsOutboundV2,
});

const registryWithMSTeamsV2 = createTestRegistry([
  { pluginId: "msteams", plugin: msteamsPluginV2, source: "test-v2" },
]);

const mstNoOutboundPlugin = createChannelTestPluginBase({
  id: "msteams",
  label: "Microsoft Teams",
});

const registryWithMSTeamsNoOutbound = createTestRegistry([
  { pluginId: "msteams", plugin: mstNoOutboundPlugin, source: "test-no-outbound" },
]);

function makeSlackConfigWritesCfg(accountIdKey: string) {
  return {
    channels: {
      slack: {
        configWrites: true,
        accounts: {
          [accountIdKey]: { configWrites: false },
        },
      },
    },
  };
}

type DirectoryListFn = (params: {
  cfg: FasedAgentConfig;
  accountId?: string | null;
  query?: string | null;
  limit?: number | null;
}) => Promise<ChannelDirectoryEntry[]>;

async function listDirectoryEntriesWithDefaults(listFn: DirectoryListFn, cfg: FasedAgentConfig) {
  return await listFn({
    cfg,
    accountId: "default",
    query: null,
    limit: null,
  });
}

async function expectDirectoryIds(
  listFn: DirectoryListFn,
  cfg: FasedAgentConfig,
  expected: string[],
  options?: { sorted?: boolean },
) {
  const entries = await listDirectoryEntriesWithDefaults(listFn, cfg);
  const ids = entries.map((entry) => entry.id);
  expect(options?.sorted ? ids.toSorted() : ids).toEqual(expected);
}

describe("channel plugin loader", () => {
  beforeEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  afterEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  it("loads channel plugins from the active registry", async () => {
    setActivePluginRegistry(registryWithMSTeams);
    const plugin = await loadChannelPlugin("msteams");
    expect(plugin).toBe(msteamsPlugin);
  });

  it("loads outbound adapters from registered plugins", async () => {
    setActivePluginRegistry(registryWithMSTeams);
    const outbound = await loadChannelOutboundAdapter("msteams");
    expect(outbound).toBe(msteamsOutbound);
  });

  it("refreshes cached plugin values when registry changes", async () => {
    setActivePluginRegistry(registryWithMSTeams);
    expect(await loadChannelPlugin("msteams")).toBe(msteamsPlugin);
    setActivePluginRegistry(registryWithMSTeamsV2);
    expect(await loadChannelPlugin("msteams")).toBe(msteamsPluginV2);
  });

  it("refreshes cached outbound values when registry changes", async () => {
    setActivePluginRegistry(registryWithMSTeams);
    expect(await loadChannelOutboundAdapter("msteams")).toBe(msteamsOutbound);
    setActivePluginRegistry(registryWithMSTeamsV2);
    expect(await loadChannelOutboundAdapter("msteams")).toBe(msteamsOutboundV2);
  });

  it("returns undefined when plugin has no outbound adapter", async () => {
    setActivePluginRegistry(registryWithMSTeamsNoOutbound);
    expect(await loadChannelOutboundAdapter("msteams")).toBeUndefined();
  });
});

describe("BaseProbeResult assignability", () => {
  it("TelegramProbe satisfies BaseProbeResult", () => {
    expectTypeOf<TelegramProbe>().toMatchTypeOf<BaseProbeResult>();
  });

  it("DiscordProbe satisfies BaseProbeResult", () => {
    expectTypeOf<DiscordProbe>().toMatchTypeOf<BaseProbeResult>();
  });

  it("SlackProbe satisfies BaseProbeResult", () => {
    expectTypeOf<SlackProbe>().toMatchTypeOf<BaseProbeResult>();
  });

  it("SignalProbe satisfies BaseProbeResult", () => {
    expectTypeOf<SignalProbe>().toMatchTypeOf<BaseProbeResult>();
  });

  it("IMessageProbe satisfies BaseProbeResult", () => {
    expectTypeOf<IMessageProbe>().toMatchTypeOf<BaseProbeResult>();
  });

  it("LineProbeResult satisfies BaseProbeResult", () => {
    expectTypeOf<LineProbeResult>().toMatchTypeOf<BaseProbeResult>();
  });
});

describe("BaseTokenResolution assignability", () => {
  it("Telegram and Discord token resolutions satisfy BaseTokenResolution", () => {
    expectTypeOf<TelegramTokenResolution>().toMatchTypeOf<BaseTokenResolution>();
    expectTypeOf<DiscordTokenResolution>().toMatchTypeOf<BaseTokenResolution>();
  });
});

describe("resolveChannelConfigWrites", () => {
  it("defaults to allow when unset", () => {
    const cfg = {};
    expect(resolveChannelConfigWrites({ cfg, channelId: "slack" })).toBe(true);
  });

  it("blocks when channel config disables writes", () => {
    const cfg = { channels: { slack: { configWrites: false } } };
    expect(resolveChannelConfigWrites({ cfg, channelId: "slack" })).toBe(false);
  });

  it("account override wins over channel default", () => {
    const cfg = makeSlackConfigWritesCfg("work");
    expect(resolveChannelConfigWrites({ cfg, channelId: "slack", accountId: "work" })).toBe(false);
  });

  it("matches account ids case-insensitively", () => {
    const cfg = makeSlackConfigWritesCfg("Work");
    expect(resolveChannelConfigWrites({ cfg, channelId: "slack", accountId: "work" })).toBe(false);
  });

  it("lets an account explicitly allow writes when channel default blocks writes", () => {
    const cfg = {
      channels: {
        slack: {
          configWrites: false,
          accounts: {
            work: { configWrites: true },
          },
        },
      },
    };
    expect(resolveChannelConfigWrites({ cfg, channelId: "slack", accountId: "work" })).toBe(true);
  });
});

describe("buildChannelAccountSnapshot", () => {
  it("falls back to account enabled and configured state when no status hook exists", async () => {
    const plugin: ChannelPlugin<{ enabled?: boolean; token?: string }> = {
      id: "demo",
      meta: {
        id: "demo",
        label: "Demo",
        selectionLabel: "Demo",
        docsPath: "/channels/demo",
        blurb: "Demo channel",
      },
      capabilities: { chatTypes: ["direct"] },
      config: {
        listAccountIds: () => ["default"],
        resolveAccount: () => ({ enabled: true, token: "token" }),
        isConfigured: async (account) => Boolean(account.token),
      },
    };

    await expect(
      buildChannelAccountSnapshot({
        plugin,
        cfg: {},
        accountId: "default",
      }),
    ).resolves.toEqual({
      accountId: "default",
      enabled: true,
      configured: true,
    });
  });

  it("projects safe account routing fields into fallback snapshots", async () => {
    const plugin: ChannelPlugin<{
      enabled?: boolean;
      token?: string;
      defaultTo?: string | number;
      audience?: string;
      audienceType?: string;
      webhookPath?: string;
      webhookUrl?: string;
      allowFrom?: Array<string | number>;
    }> = {
      id: "demo",
      meta: {
        id: "demo",
        label: "Demo",
        selectionLabel: "Demo",
        docsPath: "/channels/demo",
        blurb: "Demo channel",
      },
      capabilities: { chatTypes: ["direct"] },
      config: {
        listAccountIds: () => ["default"],
        resolveAccount: () => ({
          enabled: true,
          token: "token",
          defaultTo: 397848047,
          audienceType: "telegram-chat",
          webhookPath: "/hooks/demo",
          webhookUrl: "https://user:pass@example.test/hooks/demo?token=secret#frag",
          allowFrom: ["397848047"],
        }),
        isConfigured: async (account) => Boolean(account.token),
      },
    };

    await expect(
      buildChannelAccountSnapshot({
        plugin,
        cfg: {},
        accountId: "default",
      }),
    ).resolves.toEqual({
      accountId: "default",
      enabled: true,
      configured: true,
      audience: "397848047",
      audienceType: "telegram-chat",
      webhookPath: "/hooks/demo",
      webhookUrl: "https://example.test/...",
      allowFrom: ["397848047"],
    });
  });

  it("prefers explicit audience over default route targets", async () => {
    const plugin: ChannelPlugin<{
      enabled?: boolean;
      token?: string;
      defaultTo?: string | number;
      audience?: string;
    }> = {
      id: "demo",
      meta: {
        id: "demo",
        label: "Demo",
        selectionLabel: "Demo",
        docsPath: "/channels/demo",
        blurb: "Demo channel",
      },
      capabilities: { chatTypes: ["direct"] },
      config: {
        listAccountIds: () => ["default"],
        resolveAccount: () => ({
          enabled: true,
          token: "token",
          defaultTo: "default-target",
          audience: "explicit-target",
        }),
        isConfigured: async (account) => Boolean(account.token),
      },
    };

    await expect(
      buildChannelAccountSnapshot({
        plugin,
        cfg: {},
        accountId: "default",
      }),
    ).resolves.toMatchObject({
      accountId: "default",
      audience: "explicit-target",
    });
  });

  it("delegates status snapshots to channel status hooks with runtime/probe/audit context", async () => {
    const plugin: ChannelPlugin<{ enabled?: boolean }> = {
      id: "demo",
      meta: {
        id: "demo",
        label: "Demo",
        selectionLabel: "Demo",
        docsPath: "/channels/demo",
        blurb: "Demo channel",
      },
      capabilities: { chatTypes: ["direct"] },
      config: {
        listAccountIds: () => ["default"],
        resolveAccount: () => ({ enabled: true }),
      },
      status: {
        buildAccountSnapshot: async ({ runtime, probe, audit }) => ({
          accountId: "default",
          configured: true,
          running: Boolean(runtime),
          probe,
          audit,
        }),
      },
    };

    await expect(
      buildChannelAccountSnapshot({
        plugin,
        cfg: {},
        accountId: "default",
        runtime: { accountId: "default", running: true },
        probe: { ok: true },
        audit: { lastStartAt: 123 },
      }),
    ).resolves.toEqual({
      accountId: "default",
      configured: true,
      running: true,
      probe: { ok: true },
      audit: { lastStartAt: 123 },
    });
  });
});

describe("directory (config-backed)", () => {
  it("lists Slack peers/groups from config", async () => {
    const cfg = {
      channels: {
        slack: {
          botToken: "xoxb-test",
          appToken: "xapp-test",
          dm: { allowFrom: ["U123", "user:U999"] },
          dms: { U234: {} },
          channels: { C111: { users: ["U777"] } },
        },
      },
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any;

    await expectDirectoryIds(
      listSlackDirectoryPeersFromConfig,
      cfg,
      ["user:u123", "user:u234", "user:u777", "user:u999"],
      { sorted: true },
    );
    await expectDirectoryIds(listSlackDirectoryGroupsFromConfig, cfg, ["channel:c111"]);
  });

  it("lists Discord peers/groups from config (numeric ids only)", async () => {
    const cfg = {
      channels: {
        discord: {
          token: "discord-test",
          dm: { allowFrom: ["<@111>", "<@!333>", "nope"] },
          dms: { "222": {} },
          guilds: {
            "123": {
              users: ["<@12345>", " discord:444 ", "not-an-id"],
              channels: {
                "555": {},
                "<#777>": {},
                "channel:666": {},
                general: {},
              },
            },
          },
        },
      },
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any;

    await expectDirectoryIds(
      listDiscordDirectoryPeersFromConfig,
      cfg,
      ["user:111", "user:12345", "user:222", "user:333", "user:444"],
      { sorted: true },
    );
    await expectDirectoryIds(
      listDiscordDirectoryGroupsFromConfig,
      cfg,
      ["channel:555", "channel:666", "channel:777"],
      { sorted: true },
    );
  });

  it("lists Telegram peers/groups from config", async () => {
    const cfg = {
      channels: {
        telegram: {
          botToken: "telegram-test",
          allowFrom: ["123", "alice", "tg:@bob"],
          dms: { "456": {} },
          groups: { "-1001": {}, "*": {} },
        },
      },
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any;

    await expectDirectoryIds(
      listTelegramDirectoryPeersFromConfig,
      cfg,
      ["123", "456", "@alice", "@bob"],
      {
        sorted: true,
      },
    );
    await expectDirectoryIds(listTelegramDirectoryGroupsFromConfig, cfg, ["-1001"]);
  });

  it("lists WhatsApp peers/groups from config", async () => {
    const cfg = {
      channels: {
        whatsapp: {
          allowFrom: ["+15550000000", "*", "123@g.us"],
          groups: { "999@g.us": { requireMention: true }, "*": {} },
        },
      },
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any;

    await expectDirectoryIds(listWhatsAppDirectoryPeersFromConfig, cfg, ["+15550000000"]);
    await expectDirectoryIds(listWhatsAppDirectoryGroupsFromConfig, cfg, ["999@g.us"]);
  });

  it("applies query and limit filtering for config-backed directories", async () => {
    const cfg = {
      channels: {
        slack: {
          botToken: "xoxb-test",
          appToken: "xapp-test",
          dm: { allowFrom: ["U100", "U200"] },
          dms: { U300: {} },
          channels: { C111: {}, C222: {}, C333: {} },
        },
        discord: {
          token: "discord-test",
          guilds: {
            "123": {
              channels: {
                "555": {},
                "666": {},
                "777": {},
              },
            },
          },
        },
        telegram: {
          botToken: "telegram-test",
          groups: { "-1001": {}, "-1002": {}, "-2001": {} },
        },
        whatsapp: {
          groups: { "111@g.us": {}, "222@g.us": {}, "333@s.whatsapp.net": {} },
        },
      },
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any;

    const slackPeers = await listSlackDirectoryPeersFromConfig({
      cfg,
      accountId: "default",
      query: "user:u",
      limit: 2,
    });
    expect(slackPeers).toHaveLength(2);
    expect(slackPeers.every((entry) => entry.id.startsWith("user:u"))).toBe(true);

    const discordGroups = await listDiscordDirectoryGroupsFromConfig({
      cfg,
      accountId: "default",
      query: "666",
      limit: 5,
    });
    expect(discordGroups.map((entry) => entry.id)).toEqual(["channel:666"]);

    const telegramGroups = await listTelegramDirectoryGroupsFromConfig({
      cfg,
      accountId: "default",
      query: "-100",
      limit: 1,
    });
    expect(telegramGroups.map((entry) => entry.id)).toEqual(["-1001"]);

    const whatsAppGroups = await listWhatsAppDirectoryGroupsFromConfig({
      cfg,
      accountId: "default",
      query: "@g.us",
      limit: 1,
    });
    expect(whatsAppGroups.map((entry) => entry.id)).toEqual(["111@g.us"]);
  });
});
