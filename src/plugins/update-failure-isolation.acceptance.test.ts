import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FasedAgentConfig } from "../config/config.js";

const installPluginFromNpmSpec = vi.hoisted(() => vi.fn());

vi.mock("./install.js", () => ({
  installPluginFromNpmSpec,
  resolvePluginInstallDir: (pluginId: string) =>
    path.join(os.tmpdir(), "fased-update-failure-isolation-default", pluginId),
}));

const { updatePinnedNpmPlugins } = await import("./update.js");

const tempDirs: string[] = [];

function makePluginPackage(pluginId: string, version: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `fased-update-${pluginId}-`));
  tempDirs.push(dir);
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: `@fased/${pluginId}`, version }),
    "utf8",
  );
  return dir;
}

function makeCorruptPluginPackage(pluginId: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `fased-update-${pluginId}-`));
  tempDirs.push(dir);
  fs.writeFileSync(path.join(dir, "package.json"), "{not-json", "utf8");
  return dir;
}

afterEach(() => {
  vi.clearAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Lane 2 plugin update failure isolation acceptance", () => {
  it("keeps successful plugin updates committed when a later plugin repair fails", async () => {
    const rssCurrent = makePluginPackage("rss", "1.0.0");
    const walletCurrent = makePluginPackage("wallet-tools", "1.0.0");
    const rssNext = makePluginPackage("rss-next", "2.0.0");
    const walletNext = makePluginPackage("wallet-tools-next", "1.0.0");
    const config: FasedAgentConfig = {
      plugins: {
        installs: {
          rss: {
            source: "npm",
            spec: "@fased/rss@latest",
            installPath: rssCurrent,
            version: "1.0.0",
          },
          "telegram-tools": {
            source: "npm",
            spec: "@fased/telegram-tools@latest",
            installPath: makePluginPackage("telegram-tools", "1.0.0"),
            version: "1.0.0",
          },
          "wallet-tools": {
            source: "npm",
            spec: "@fased/wallet-tools@latest",
            installPath: walletCurrent,
            version: "1.0.0",
          },
        },
      },
    };

    installPluginFromNpmSpec.mockImplementation(
      async ({ expectedPluginId }: { expectedPluginId?: string }) => {
        if (expectedPluginId === "rss") {
          return {
            ok: true,
            pluginId: "rss",
            targetDir: rssNext,
            version: "2.0.0",
            extensions: ["./dist/index.js"],
          };
        }
        if (expectedPluginId === "telegram-tools") {
          return {
            ok: false,
            error: "scanner rejected package",
          };
        }
        if (expectedPluginId === "wallet-tools") {
          return {
            ok: true,
            pluginId: "wallet-tools",
            targetDir: walletNext,
            version: "1.0.0",
            extensions: ["./dist/index.js"],
          };
        }
        throw new Error(`unexpected plugin: ${String(expectedPluginId)}`);
      },
    );

    const result = await updatePinnedNpmPlugins({
      config,
      pluginIds: ["rss", "telegram-tools", "wallet-tools"],
    });

    expect(result.outcomes.map(({ pluginId, status }) => ({ pluginId, status }))).toEqual([
      { pluginId: "rss", status: "updated" },
      { pluginId: "telegram-tools", status: "error" },
      { pluginId: "wallet-tools", status: "unchanged" },
    ]);
    expect(result.changed).toBe(true);
    expect(result.config.plugins?.installs?.rss).toMatchObject({
      source: "npm",
      spec: "@fased/rss@latest",
      installPath: rssNext,
      version: "2.0.0",
    });
    expect(result.config.plugins?.installs?.["telegram-tools"]).toEqual(
      config.plugins?.installs?.["telegram-tools"],
    );
    expect(result.config.plugins?.entries?.["telegram-tools"]?.enabled).not.toBe(true);
    expect(result.config.plugins?.installs?.["wallet-tools"]).toMatchObject({
      source: "npm",
      spec: "@fased/wallet-tools@latest",
      installPath: walletNext,
      version: "1.0.0",
    });
  });

  it("continues isolated plugin updates when an installed package manifest is corrupt", async () => {
    const corruptCurrent = makeCorruptPluginPackage("corrupt-tools");
    const riskyCurrent = makePluginPackage("risky-tools", "1.0.0");
    const brokenCurrent = makePluginPackage("broken-tools", "1.0.0");
    const corruptNext = makePluginPackage("corrupt-tools-next", "2.0.0");
    const riskyNext = makePluginPackage("risky-tools-next", "1.1.0");
    const config: FasedAgentConfig = {
      plugins: {
        installs: {
          "corrupt-tools": {
            source: "npm",
            spec: "@fased/corrupt-tools@latest",
            installPath: corruptCurrent,
            version: "1.0.0",
            integrity: "sha512-corrupt-old",
          },
          "risky-tools": {
            source: "npm",
            spec: "@fased/risky-tools@latest",
            installPath: riskyCurrent,
            version: "1.0.0",
            integrity: "sha512-risky-old",
          },
          "broken-tools": {
            source: "npm",
            spec: "@fased/broken-tools@latest",
            installPath: brokenCurrent,
            version: "1.0.0",
            integrity: "sha512-broken-old",
          },
        },
      },
    };

    installPluginFromNpmSpec.mockImplementation(
      async ({
        expectedPluginId,
        logger,
      }: {
        expectedPluginId?: string;
        logger?: { warn?: (message: string) => void };
      }) => {
        if (expectedPluginId === "corrupt-tools") {
          return {
            ok: true,
            pluginId: "corrupt-tools",
            targetDir: corruptNext,
            version: "2.0.0",
            extensions: ["./dist/index.js"],
          };
        }
        if (expectedPluginId === "risky-tools") {
          logger?.warn?.("scanner warning: package requests network access");
          return {
            ok: true,
            pluginId: "risky-tools",
            targetDir: riskyNext,
            version: "1.1.0",
            extensions: ["./dist/index.js"],
            review: {
              pluginId: "risky-tools",
              packageName: "@fased/risky-tools",
              version: "1.1.0",
              extensions: ["./dist/index.js"],
              kind: "integration",
              channels: ["telegram", "discord"],
              providers: ["openai"],
              skills: [],
              tools: ["risky.status"],
              dependencyCount: 1,
              dependencyKinds: ["dependencies:1"],
              scriptNames: ["postinstall"],
              dependencyWarnings: ["package declares 1 dependency"],
              scriptWarnings: ["package declares npm scripts (postinstall)"],
            },
          };
        }
        if (expectedPluginId === "broken-tools") {
          return {
            ok: false,
            error: "scanner rejected package",
          };
        }
        throw new Error(`unexpected plugin: ${String(expectedPluginId)}`);
      },
    );

    const result = await updatePinnedNpmPlugins({
      config,
      pluginIds: ["corrupt-tools", "risky-tools", "broken-tools"],
    });

    expect(result.outcomes.map(({ pluginId, status }) => ({ pluginId, status }))).toEqual([
      { pluginId: "corrupt-tools", status: "updated" },
      { pluginId: "risky-tools", status: "updated" },
      { pluginId: "broken-tools", status: "error" },
    ]);
    expect(result.config.plugins?.installs?.["corrupt-tools"]).toMatchObject({
      source: "npm",
      spec: "@fased/corrupt-tools@latest",
      installPath: corruptNext,
      version: "2.0.0",
    });
    expect(result.outcomes[0]).toMatchObject({
      currentVersion: undefined,
      warnings: [
        expect.stringContaining('Could not inspect installed package for "corrupt-tools"'),
      ],
    });
    expect(result.outcomes[1]).toMatchObject({
      packageReview: expect.objectContaining({
        dependencyWarnings: ["package declares 1 dependency"],
        scriptWarnings: ["package declares npm scripts (postinstall)"],
      }),
      warnings: ["scanner warning: package requests network access"],
    });
    expect(result.config.plugins?.installs?.["broken-tools"]).toEqual(
      config.plugins?.installs?.["broken-tools"],
    );
    expect(result.config.plugins?.entries?.["broken-tools"]?.enabled).not.toBe(true);
  });
});
