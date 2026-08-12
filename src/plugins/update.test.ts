import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FasedAgentConfig } from "../config/config.js";
import type { InstallPluginResult } from "./install.js";
import { installPluginFromNpmSpec } from "./install.js";
import { updatePinnedNpmPlugins } from "./update.js";

vi.mock("./install.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./install.js")>();
  return {
    ...actual,
    installPluginFromNpmSpec: vi.fn(),
  };
});

const installPluginFromNpmSpecMock = vi.mocked(installPluginFromNpmSpec);

function createConfig(spec: string): FasedAgentConfig {
  return {
    plugins: {
      installs: {
        demo: {
          source: "npm",
          spec,
          installPath: "/tmp/fased-demo-plugin",
          version: "1.0.0",
          integrity: "sha512-old",
        },
      },
    },
  } as FasedAgentConfig;
}

function createSuccessfulNpmUpdateResult(params: {
  version: string;
  resolvedSpec?: string;
}): Extract<InstallPluginResult, { ok: true }> {
  return {
    ok: true,
    pluginId: "demo",
    targetDir: "/tmp/fased-demo-plugin",
    version: params.version,
    extensions: ["./dist/index.js"],
    npmResolution: {
      name: "@fased/demo",
      version: params.version,
      resolvedSpec: params.resolvedSpec ?? `@fased/demo@${params.version}`,
      integrity: "sha512-new",
    },
  };
}

describe("updatePinnedNpmPlugins", () => {
  beforeEach(() => {
    installPluginFromNpmSpecMock.mockReset();
  });

  it("uses beta npm tag for default npm specs on beta channel", async () => {
    installPluginFromNpmSpecMock.mockResolvedValue(
      createSuccessfulNpmUpdateResult({
        version: "1.1.0-beta.2",
        resolvedSpec: "@fased/demo@1.1.0-beta.2",
      }),
    );

    const result = await updatePinnedNpmPlugins({
      config: createConfig("@fased/demo"),
      pluginIds: ["demo"],
      updateChannel: "beta",
    });

    expect(installPluginFromNpmSpecMock).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "@fased/demo@beta",
        expectedIntegrity: undefined,
        expectedPluginId: "demo",
      }),
    );
    expect(result.config.plugins?.installs?.demo).toMatchObject({
      source: "npm",
      spec: "@fased/demo",
      version: "1.1.0-beta.2",
      resolvedSpec: "@fased/demo@1.1.0-beta.2",
      integrity: "sha512-new",
    });
  });

  it("falls back to the recorded npm spec when beta package is invalid", async () => {
    installPluginFromNpmSpecMock
      .mockResolvedValueOnce({
        ok: false,
        error: "Installed plugin package uses a TypeScript entry without compiled runtime output.",
      })
      .mockResolvedValueOnce(
        createSuccessfulNpmUpdateResult({
          version: "1.0.2",
          resolvedSpec: "@fased/demo@1.0.2",
        }),
      );
    const warnMessages: string[] = [];

    const result = await updatePinnedNpmPlugins({
      config: createConfig("@fased/demo"),
      pluginIds: ["demo"],
      updateChannel: "beta",
      logger: { warn: (message) => warnMessages.push(message) },
    });

    expect(installPluginFromNpmSpecMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        spec: "@fased/demo@beta",
        expectedIntegrity: undefined,
      }),
    );
    expect(installPluginFromNpmSpecMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        spec: "@fased/demo",
        expectedIntegrity: "sha512-old",
      }),
    );
    expect(warnMessages).toEqual([expect.stringContaining("failed beta npm update")]);
    expect(result.config.plugins?.installs?.demo).toMatchObject({
      spec: "@fased/demo",
      version: "1.0.2",
      resolvedSpec: "@fased/demo@1.0.2",
    });
  });

  it("preserves explicit npm tags on the beta channel", async () => {
    installPluginFromNpmSpecMock.mockResolvedValue(
      createSuccessfulNpmUpdateResult({
        version: "1.2.0-rc.1",
        resolvedSpec: "@fased/demo@1.2.0-rc.1",
      }),
    );

    await updatePinnedNpmPlugins({
      config: createConfig("@fased/demo@rc"),
      pluginIds: ["demo"],
      updateChannel: "beta",
      dryRun: true,
    });

    expect(installPluginFromNpmSpecMock).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "@fased/demo@rc",
      }),
    );
  });

  it("reports the fallback npm spec when beta fallback also fails", async () => {
    installPluginFromNpmSpecMock
      .mockResolvedValueOnce({
        ok: false,
        error: "npm ERR! code ETARGET\nnpm ERR! No matching version found for @fased/demo@beta.",
      })
      .mockResolvedValueOnce({
        ok: false,
        error: "Package not found on npm: @fased/demo.",
      });

    const result = await updatePinnedNpmPlugins({
      config: createConfig("@fased/demo"),
      pluginIds: ["demo"],
      updateChannel: "beta",
    });

    expect(installPluginFromNpmSpecMock).toHaveBeenCalledTimes(2);
    expect(result.outcomes).toEqual([
      {
        pluginId: "demo",
        status: "error",
        message:
          "Failed to update demo: npm install failed for @fased/demo: Package not found on npm: @fased/demo.",
      },
    ]);
  });
});
