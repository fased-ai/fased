import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FasedAgentConfig } from "../config/config.js";
import type { PluginStatusReport } from "./status.js";

const buildPluginStatusReport = vi.hoisted(() => vi.fn());
const applyExclusiveSlotSelection = vi.hoisted(() => vi.fn());
const clearPluginManifestRegistryCache = vi.hoisted(() => vi.fn());
const enablePluginInConfig = vi.hoisted(() => vi.fn());
const recordPluginInstall = vi.hoisted(() => vi.fn());
const resolveUninstallDirectoryTarget = vi.hoisted(() => vi.fn());
const uninstallPlugin = vi.hoisted(() => vi.fn());
const updateNpmInstalledPlugins = vi.hoisted(() => vi.fn());

vi.mock("./status.js", () => ({
  buildPluginStatusReport,
}));

vi.mock("./slots.js", () => ({
  applyExclusiveSlotSelection,
}));

vi.mock("./manifest-registry.js", () => ({
  clearPluginManifestRegistryCache,
}));

vi.mock("./enable.js", () => ({
  enablePluginInConfig,
}));

vi.mock("./installs.js", () => ({
  recordPluginInstall,
}));

vi.mock("./uninstall.js", () => ({
  resolveUninstallDirectoryTarget,
  uninstallPlugin,
}));

vi.mock("./update.js", () => ({
  updateNpmInstalledPlugins,
}));

import {
  buildPluginLifecycleReport,
  buildPluginUninstallPreview,
  executePluginUninstallLifecycle,
  executePluginUpdateLifecycle,
  finalizeInstalledPluginConfig,
  resolvePluginLifecycleEntry,
} from "./lifecycle.js";

function createBaseReport(): PluginStatusReport {
  return {
    workspaceDir: "/tmp/workspace",
    plugins: [
      {
        id: "demo",
        name: "Demo Plugin",
        source: "/tmp/plugins/demo",
        origin: "global",
        enabled: true,
        status: "loaded",
        toolNames: [],
        hookNames: [],
        channelIds: [],
        providerIds: ["demo-provider"],
        gatewayMethods: [],
        cliCommands: [],
        services: [],
        commands: [],
        httpHandlers: 0,
        hookCount: 0,
        configSchema: false,
      },
    ],
    tools: [],
    hooks: [],
    typedHooks: [],
    channels: [],
    providers: [],
    webSearchProviders: [],
    imageGenerationProviders: [],
    videoGenerationProviders: [],
    realtimeTranscriptionProviders: [],
    realtimeVoiceProviders: [],
    gatewayHandlers: {},
    gatewayMethodScopes: {},
    httpHandlers: [],
    httpRoutes: [],
    cliRegistrars: [],
    services: [],
    commands: [],
    diagnostics: [],
  };
}

describe("plugin lifecycle backend", () => {
  beforeEach(() => {
    buildPluginStatusReport.mockReset();
    applyExclusiveSlotSelection.mockReset();
    clearPluginManifestRegistryCache.mockReset();
    enablePluginInConfig.mockReset();
    recordPluginInstall.mockReset();
    resolveUninstallDirectoryTarget.mockReset();
    uninstallPlugin.mockReset();
    updateNpmInstalledPlugins.mockReset();

    enablePluginInConfig.mockImplementation((cfg: FasedAgentConfig, pluginId: string) => ({
      config: {
        ...cfg,
        plugins: {
          ...cfg.plugins,
          entries: {
            ...cfg.plugins?.entries,
            [pluginId]: { enabled: true },
          },
        },
      },
    }));
    recordPluginInstall.mockImplementation(
      (cfg: FasedAgentConfig, update: { pluginId: string; source: string; spec?: string }) => ({
        ...cfg,
        plugins: {
          ...cfg.plugins,
          installs: {
            ...cfg.plugins?.installs,
            [update.pluginId]: {
              source: update.source,
              ...(update.spec ? { spec: update.spec } : {}),
            },
          },
        },
      }),
    );
    applyExclusiveSlotSelection.mockImplementation(({ config }) => ({
      config: {
        ...config,
        plugins: {
          ...config.plugins,
          slots: {
            ...config.plugins?.slots,
            memory: "demo",
          },
        },
      },
      warnings: ["slot warning"],
    }));
    buildPluginStatusReport.mockReturnValue(createBaseReport());
    resolveUninstallDirectoryTarget.mockImplementation(({ installRecord }) =>
      installRecord?.source === "path" ? null : "/tmp/extensions/demo",
    );
    uninstallPlugin.mockResolvedValue({
      ok: true,
      config: {},
      pluginId: "demo",
      actions: {
        entry: true,
        install: true,
        allowlist: false,
        loadPath: false,
        memorySlot: false,
        directory: true,
      },
      warnings: [],
    });
    updateNpmInstalledPlugins.mockResolvedValue({
      config: {},
      changed: false,
      outcomes: [],
    });
  });

  it("builds lifecycle status entries with merged install metadata", () => {
    const config: FasedAgentConfig = {
      plugins: {
        entries: {
          demo: { enabled: true },
        },
        installs: {
          demo: {
            source: "npm",
            spec: "demo@1.0.0",
          },
        },
      },
    };

    const report = buildPluginLifecycleReport({
      config,
      report: createBaseReport(),
    });

    expect(report.plugins[0]).toMatchObject({
      id: "demo",
      managed: true,
      install: {
        source: "npm",
        spec: "demo@1.0.0",
      },
    });
    expect(
      resolvePluginLifecycleEntry({
        idOrName: "Demo Plugin",
        report,
      }),
    ).toMatchObject({
      id: "demo",
    });
  });

  it("finalizes installed plugin config through shared enable/install/slot flows", () => {
    const result = finalizeInstalledPluginConfig({
      config: {},
      pluginId: "demo",
      loadPath: "/tmp/plugins/demo",
      installRecord: {
        source: "npm",
        spec: "demo@1.0.0",
      },
      refreshManifestRegistry: true,
    });

    expect(clearPluginManifestRegistryCache).toHaveBeenCalledOnce();
    expect(enablePluginInConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        plugins: {
          load: {
            paths: ["/tmp/plugins/demo"],
          },
        },
      }),
      "demo",
    );
    expect(recordPluginInstall).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        pluginId: "demo",
        source: "npm",
        spec: "demo@1.0.0",
      }),
    );
    expect(result.config.plugins?.slots?.memory).toBe("demo");
    expect(result.config.plugins?.allow).toEqual(["demo"]);
    expect(result.slotWarnings).toEqual(["slot warning"]);
  });

  it("builds uninstall previews from managed config state", () => {
    const config: FasedAgentConfig = {
      plugins: {
        entries: {
          demo: { enabled: true },
        },
        installs: {
          demo: {
            source: "path",
            sourcePath: "/tmp/plugins/demo",
            installPath: "/tmp/plugins/demo",
          },
        },
        allow: ["demo"],
        load: {
          paths: ["/tmp/plugins/demo"],
        },
        slots: {
          memory: "demo",
        },
      },
    };

    const preview = buildPluginUninstallPreview({
      config,
      idOrName: "demo",
      keepFiles: false,
      report: buildPluginLifecycleReport({
        config,
        report: createBaseReport(),
      }),
    });

    expect(preview).toMatchObject({
      ok: true,
      pluginId: "demo",
      pluginName: "Demo Plugin",
      hasEntry: true,
      hasInstall: true,
      isLinked: true,
      preview: expect.arrayContaining([
        "config entry",
        "install record",
        "allowlist entry",
        "load path",
        'memory slot (will reset to "memory-core")',
      ]),
    });
  });

  it("delegates update and uninstall execution to existing lifecycle primitives", async () => {
    await expect(
      executePluginUpdateLifecycle({
        config: {},
        dryRun: true,
      }),
    ).resolves.toEqual({
      config: {},
      changed: false,
      outcomes: [],
    });
    await expect(
      executePluginUninstallLifecycle({
        config: {},
        pluginId: "demo",
      }),
    ).resolves.toMatchObject({
      ok: true,
      pluginId: "demo",
    });

    expect(updateNpmInstalledPlugins).toHaveBeenCalledWith({
      config: {},
      dryRun: true,
    });
    expect(uninstallPlugin).toHaveBeenCalledWith({
      config: {},
      pluginId: "demo",
    });
  });
});
