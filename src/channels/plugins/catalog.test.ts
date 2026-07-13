import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getChannelPluginCatalogEntry, listChannelPluginCatalogEntries } from "./catalog.js";

describe("channel plugin catalog", () => {
  it.each(["telegram", "whatsapp", "discord", "slack", "feishu", "googlechat"])(
    "installs %s from its npm add-on by default",
    (channelId) => {
      const entry = getChannelPluginCatalogEntry(channelId);
      expect(entry?.install.npmSpec).toBe(`@fased/${channelId}`);
      expect(entry?.install.defaultChoice).toBe("npm");
    },
  );

  it("includes Microsoft Teams", () => {
    const entry = getChannelPluginCatalogEntry("msteams");
    expect(entry?.install.npmSpec).toBe("@fased/msteams");
    expect(entry?.install.localPath).toBe("extensions/msteams");
    expect(entry?.install.defaultChoice).toBe("local");
    expect(entry?.meta.aliases).toContain("teams");
    expect(entry?.catalogSource).toBe("bundled");
  });

  it("includes Feishu with its npm install metadata", () => {
    const entry = getChannelPluginCatalogEntry("feishu");
    expect(entry?.install.npmSpec).toBe("@fased/feishu");
    expect(entry?.install.localPath).toBe("extensions/feishu");
    expect(entry?.install.defaultChoice).toBe("npm");
    expect(entry?.meta.aliases).toContain("lark");
    expect(entry?.catalogSource).toBe("bundled");
  });

  it("keeps source-only Nostr visible without npm or local install actions", () => {
    const entry = getChannelPluginCatalogEntry("nostr");
    expect(entry?.delivery).toBe("source-only");
    expect(entry?.install).toEqual({});
    expect(entry?.meta.label).toBe("Nostr");
    expect(entry?.catalogSource).toBe("bundled");
  });

  it("keeps source-only Matrix visible without npm or local install actions", () => {
    const entry = getChannelPluginCatalogEntry("matrix");
    expect(entry?.delivery).toBe("source-only");
    expect(entry?.install).toEqual({});
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

  it("keeps BlueBubbles behind its external prerequisite without an install action", () => {
    const entry = getChannelPluginCatalogEntry("bluebubbles");
    expect(entry?.delivery).toBe("external-prerequisite");
    expect(entry?.install).toEqual({});
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

  it("keeps source-only Tlon visible without npm or local install actions", () => {
    const entry = getChannelPluginCatalogEntry("tlon");
    expect(entry?.delivery).toBe("source-only");
    expect(entry?.install).toEqual({});
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
    expect(entry?.meta.aliases).toContain("zlu");
    expect(entry?.catalogSource).toBe("bundled");
  });

  it("includes bundled IRC with install metadata", () => {
    const entry = getChannelPluginCatalogEntry("irc");
    expect(entry?.install.npmSpec).toBe("@fased/irc");
    expect(entry?.install.localPath).toBe("extensions/irc");
    expect(entry?.install.defaultChoice).toBe("local");
    expect(entry?.meta.label).toBe("IRC");
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
    expect(ids).toContain("feishu");
    expect(ids).toContain("nostr");
    expect(ids).not.toContain("wecom");
    expect(ids).not.toContain("yuanbao");
  });

  it("does not list disabled official external channel catalog entries by default", () => {
    const wecom = getChannelPluginCatalogEntry("wecom");
    expect(wecom).toBeUndefined();

    const yuanbao = getChannelPluginCatalogEntry("yuanbao");
    expect(yuanbao).toBeUndefined();
  });

  it("loads official channel entries from a bundled catalog path", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fased-official-catalog-"));
    const catalogPath = path.join(dir, "official.json");
    fs.writeFileSync(
      catalogPath,
      JSON.stringify({
        entries: [
          {
            name: "@fased/official-demo",
            fased: {
              channel: {
                id: "official-demo",
                label: "Official Demo",
                selectionLabel: "Official Demo",
                docsPath: "/channels/official-demo",
                blurb: "Official catalog entry",
                order: 321,
              },
              install: {
                npmSpec: "@fased/official-demo@1.2.3",
                defaultChoice: "npm",
                expectedIntegrity: "sha512-demo",
              },
            },
          },
        ],
      }),
    );

    const entry = getChannelPluginCatalogEntry("official-demo", {
      officialCatalogPaths: [catalogPath],
    });
    expect(entry?.install.npmSpec).toBe("@fased/official-demo@1.2.3");
    expect(entry?.install.expectedIntegrity).toBe("sha512-demo");
    expect(entry?.catalogSource).toBe("official-catalog");
  });

  it("does not let official catalog data override bundled plugin entries", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fased-official-catalog-"));
    const catalogPath = path.join(dir, "official.json");
    fs.writeFileSync(
      catalogPath,
      JSON.stringify({
        entries: [
          {
            name: "@evil/msteams",
            fased: {
              channel: {
                id: "msteams",
                label: "Fake Teams",
                selectionLabel: "Fake Teams",
                docsPath: "/channels/fake-teams",
                blurb: "Should not override bundled plugin metadata",
                order: 1,
              },
              install: {
                npmSpec: "@evil/msteams@999.0.0",
                expectedIntegrity: "sha512-fake",
              },
            },
          },
        ],
      }),
    );

    const entry = getChannelPluginCatalogEntry("msteams", {
      officialCatalogPaths: [catalogPath],
    });
    expect(entry?.install.npmSpec).toBe("@fased/msteams");
    expect(entry?.install.expectedIntegrity).toBeUndefined();
    expect(entry?.meta.label).toBe("Microsoft Teams");
    expect(entry?.catalogSource).toBe("bundled");
  });

  it("ignores malformed official catalog entries", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fased-official-catalog-"));
    const catalogPath = path.join(dir, "official.json");
    fs.writeFileSync(
      catalogPath,
      JSON.stringify({
        entries: [
          {
            name: "@fased/no-label",
            fased: {
              channel: {
                id: "no-label",
                docsPath: "/channels/no-label",
                blurb: "Missing required label metadata",
              },
            },
          },
        ],
      }),
    );

    expect(
      getChannelPluginCatalogEntry("no-label", {
        officialCatalogPaths: [catalogPath],
      }),
    ).toBeUndefined();
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
