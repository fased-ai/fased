import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatChannelDelivery, listChannelDeliveryEntries } from "../channels/delivery.js";
import { listProviderBrandManifests } from "../providers/registry.js";

const ROOT = process.cwd();

const PROVIDER_DOC_FILE_BY_ID: Record<string, string> = {
  copilot: "github-copilot.md",
  "ai-gateway": "vercel-ai-gateway.md",
  "opencode-zen": "opencode.md",
};

function read(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

describe("documentation catalog parity", () => {
  it("keeps every public provider manifest represented in the provider index and docs", () => {
    const index = read("docs/providers/index.md");
    const manifests = listProviderBrandManifests();
    expect(manifests).toHaveLength(28);
    for (const manifest of manifests) {
      expect(index, `provider index is missing ${manifest.id}`).toContain(`\`${manifest.id}\``);
      const filename = PROVIDER_DOC_FILE_BY_ID[manifest.id] ?? `${manifest.id}.md`;
      expect(
        fs.existsSync(path.join(ROOT, "docs/providers", filename)),
        `provider docs are missing ${filename}`,
      ).toBe(true);
    }
  });

  it("keeps every channel integration page aligned with its canonical delivery state", () => {
    const entries = listChannelDeliveryEntries();
    expect(entries).toHaveLength(21);
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length);
    for (const entry of entries) {
      const relativePath = `docs${entry.docsPath}.md`;
      const expected = `**Delivery:** ${formatChannelDelivery(entry.delivery)}.`;
      expect(fs.existsSync(path.join(ROOT, relativePath)), `${relativePath} is missing`).toBe(true);
      expect(read(relativePath), `${relativePath} has stale delivery metadata`).toContain(expected);
    }
  });

  it("keeps the Fased-owned channel catalog npm-free and limited to bundled channels", () => {
    const official = JSON.parse(read("config/official-channel-catalog.json")) as {
      entries: Array<{
        fased?: {
          channel?: { id?: string };
          install?: { npmSpec?: string; localPath?: string; defaultChoice?: string };
        };
      }>;
    };
    const officialIds = official.entries
      .map((entry) => entry.fased?.channel?.id)
      .filter((id): id is string => Boolean(id))
      .toSorted();
    expect(officialIds).toEqual([
      "discord",
      "feishu",
      "googlechat",
      "slack",
      "telegram",
      "whatsapp",
    ]);
    for (const entry of official.entries) {
      expect(entry.fased?.install?.npmSpec).toBeUndefined();
      expect(entry.fased?.install?.localPath).toBeTruthy();
      expect(entry.fased?.install?.defaultChoice).toBe("local");
      expect(
        listChannelDeliveryEntries().find((candidate) => candidate.id === entry.fased?.channel?.id)
          ?.delivery,
      ).toBe("bundled");
    }
  });
});
