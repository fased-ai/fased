import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getPackageManifestMetadata,
  loadPluginManifest,
  resolvePackageExtensionEntries,
  type PackageManifest,
} from "./manifest.js";

const tempDirs: string[] = [];

function makeTempDir() {
  const dir = path.join(os.tmpdir(), `fased-plugin-manifest-${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) {
      break;
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  }
});

describe("plugin manifest", () => {
  it("parses JSON5 manifests with richer FasedAgent metadata", () => {
    const dir = makeTempDir();
    fs.writeFileSync(
      path.join(dir, "fased.plugin.json"),
      `{
        // trailing commas/comments should parse
        id: "manifest-rich",
        configSchema: { type: "object" },
        enabledByDefault: true,
        legacyPluginIds: ["legacy-a"],
        autoEnableWhenConfiguredProviders: ["openrouter"],
        providers: ["openrouter"],
        modelSupport: {
          modelPrefixes: ["gpt-5"],
          modelPatterns: ["^claude-"],
        },
        providerAuthEnvVars: {
          openrouter: ["OPENROUTER_API_KEY"],
        },
        providerAuthAliases: {
          "openrouter-plan": "openrouter",
        },
        providerAuthChoices: [
          {
            provider: "openrouter",
            method: "api_key",
            choiceId: "openrouter-api-key",
            onboardingScopes: ["text-inference"],
          },
        ],
        contracts: {
          webSearchProviders: ["openrouter-search"],
          tools: ["web-search"],
        },
        channelConfigs: {
          telegram: {
            schema: { type: "object" },
            label: "Telegram",
            preferOver: ["telegram-legacy"],
          },
        },
      }`,
      "utf-8",
    );

    const result = loadPluginManifest(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.manifest.enabledByDefault).toBe(true);
    expect(result.manifest.legacyPluginIds).toEqual(["legacy-a"]);
    expect(result.manifest.autoEnableWhenConfiguredProviders).toEqual(["openrouter"]);
    expect(result.manifest.modelSupport).toEqual({
      modelPrefixes: ["gpt-5"],
      modelPatterns: ["^claude-"],
    });
    expect(result.manifest.providerAuthEnvVars).toEqual({
      openrouter: ["OPENROUTER_API_KEY"],
    });
    expect(result.manifest.providerAuthAliases).toEqual({
      "openrouter-plan": "openrouter",
    });
    expect(result.manifest.providerAuthChoices).toEqual([
      {
        provider: "openrouter",
        method: "api_key",
        choiceId: "openrouter-api-key",
        onboardingScopes: ["text-inference"],
      },
    ]);
    expect(result.manifest.contracts).toEqual({
      webSearchProviders: ["openrouter-search"],
      tools: ["web-search"],
    });
    expect(result.manifest.channelConfigs?.telegram).toEqual({
      schema: { type: "object" },
      label: "Telegram",
      preferOver: ["telegram-legacy"],
    });
  });

  it("resolves package extension entries and package metadata", () => {
    const manifest: PackageManifest = {
      name: "@fased/test-plugin",
      fased: {
        extensions: ["index.ts"],
        install: {
          minHostVersion: ">=2026.2.27",
          allowInvalidConfigRecovery: true,
        },
        startup: {
          deferConfiguredChannelFullLoadUntilAfterListen: true,
        },
      },
    };

    expect(getPackageManifestMetadata(manifest)).toEqual({
      extensions: ["index.ts"],
      install: {
        minHostVersion: ">=2026.2.27",
        allowInvalidConfigRecovery: true,
      },
      startup: {
        deferConfiguredChannelFullLoadUntilAfterListen: true,
      },
    });
    expect(resolvePackageExtensionEntries(manifest)).toEqual({
      status: "ok",
      entries: ["index.ts"],
    });
  });

  it("resolves package metadata from legacy FasedAgent manifests", () => {
    const manifest: PackageManifest = {
      name: "fased-plugin-demo",
      fased: {
        extensions: ["./dist/index.js"],
        install: {
          minHostVersion: ">=2026.2.27",
        },
      },
    };

    expect(getPackageManifestMetadata(manifest)).toEqual({
      extensions: ["./dist/index.js"],
      install: {
        minHostVersion: ">=2026.2.27",
      },
    });
    expect(resolvePackageExtensionEntries(manifest)).toEqual({
      status: "ok",
      entries: ["./dist/index.js"],
    });
  });

  it("loads fased.plugin.json when no fased plugin manifest exists", () => {
    const dir = makeTempDir();
    fs.writeFileSync(
      path.join(dir, "fased.plugin.json"),
      JSON.stringify({
        id: "legacy-channel",
        configSchema: { type: "object" },
        kind: "channel",
        channels: ["legacy-channel"],
      }),
      "utf-8",
    );

    const result = loadPluginManifest(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(path.basename(result.manifestPath)).toBe("fased.plugin.json");
    expect(result.manifest.id).toBe("legacy-channel");
    expect(result.manifest.channels).toEqual(["legacy-channel"]);
  });
});
