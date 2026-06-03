import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWebSearchInstallCatalogEntries } from "./web-search-install-catalog.js";

describe("web search install catalog", () => {
  it("loads web search providers from official catalog entries", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fased-web-search-catalog-"));
    const catalogPath = path.join(dir, "official.json");
    fs.writeFileSync(
      catalogPath,
      JSON.stringify({
        entries: [
          {
            name: "@example/search-plugin",
            fased: {
              plugin: { id: "example-search", label: "Example Search" },
              webSearchProviders: [
                {
                  id: "example",
                  label: "Example Search",
                  hint: "Example web results",
                  envVars: ["EXAMPLE_SEARCH_API_KEY"],
                  placeholder: "ex-...",
                  signupUrl: "https://example.test/search",
                  credentialPath: "plugins.entries.example-search.config.webSearch.apiKey",
                },
              ],
              install: {
                npmSpec: "@example/search-plugin",
                defaultChoice: "npm",
              },
            },
          },
        ],
      }),
      "utf-8",
    );

    const entries = resolveWebSearchInstallCatalogEntries({
      officialCatalogPaths: [catalogPath],
      catalogPaths: [],
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.pluginId).toBe("example-search");
    expect(entries[0]?.install.npmSpec).toBe("@example/search-plugin");
    expect(entries[0]?.provider.id).toBe("example");
  });
});
