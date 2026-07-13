import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPluginCatalogEntry } from "../channels/plugins/catalog.js";
import type { PluginLifecycleReport } from "./lifecycle.js";
import type { PluginManifestRegistry } from "./manifest-registry.js";

const buildPluginLifecycleReport = vi.hoisted(() => vi.fn());
const loadPluginManifestRegistry = vi.hoisted(() => vi.fn());
const listChannelPluginCatalogEntries = vi.hoisted(() => vi.fn());
const resolveBundledPluginSources = vi.hoisted(() => vi.fn());

vi.mock("./lifecycle.js", () => {
  return {
    buildPluginLifecycleReport,
  };
});

vi.mock("./manifest-registry.js", () => {
  return {
    loadPluginManifestRegistry,
  };
});

vi.mock("../channels/plugins/catalog.js", () => {
  return {
    listChannelPluginCatalogEntries,
  };
});

vi.mock("./bundled-sources.js", () => {
  return {
    resolveBundledPluginSources,
  };
});

import { buildPluginMarketplaceReport, resolvePluginMarketplaceEntry } from "./marketplace.js";

function createLifecycleReport(): PluginLifecycleReport {
  return {
    workspaceDir: "/workspace",
    plugins: [
      {
        id: "demo",
        name: "Demo Plugin",
        version: "1.2.3",
        description: "Loaded demo plugin",
        source: "/workspace/.fased/extensions/demo",
        origin: "config",
        enabled: true,
        status: "loaded",
        toolNames: ["demo-tool"],
        hookNames: ["before_tool_call"],
        channelIds: ["demo"],
        providerIds: ["demo-provider"],
        gatewayMethods: ["plugin.demo"],
        cliCommands: ["demo"],
        services: ["demo-service"],
        commands: ["demo-command"],
        httpHandlers: 1,
        hookCount: 1,
        configSchema: true,
        managed: true,
        install: {
          source: "npm",
          spec: "@fased/demo",
          installPath: "/tmp/demo",
          version: "1.2.3",
        },
      },
      {
        id: "memory-core",
        name: "Memory Core",
        source: "/workspace/extensions/memory-core",
        origin: "bundled",
        enabled: false,
        status: "disabled",
        toolNames: [],
        hookNames: [],
        channelIds: [],
        providerIds: [],
        gatewayMethods: [],
        cliCommands: [],
        services: [],
        commands: [],
        httpHandlers: 0,
        hookCount: 0,
        configSchema: false,
        managed: false,
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
    diagnostics: [
      {
        level: "warn",
        pluginId: "demo",
        source: "/workspace/.fased/extensions/demo",
        message: "shared warning",
      },
    ],
  };
}

function createManifestRegistry(): PluginManifestRegistry {
  return {
    plugins: [
      {
        id: "demo",
        name: "Demo Plugin",
        description: "Manifest demo plugin",
        version: "1.2.3",
        channels: ["demo"],
        providers: ["demo-provider"],
        skills: [],
        origin: "config",
        rootDir: "/workspace/.fased/extensions/demo",
        source: "/workspace/.fased/extensions/demo",
        manifestPath: "/workspace/.fased/extensions/demo/fased.plugin.json",
      },
      {
        id: "provider-kit",
        name: "Provider Kit",
        description: "Provider-only plugin",
        version: "0.4.0",
        providers: ["provider-kit"],
        channels: [],
        skills: [],
        origin: "workspace",
        rootDir: "/workspace/extensions/provider-kit",
        source: "/workspace/extensions/provider-kit",
        manifestPath: "/workspace/extensions/provider-kit/fased.plugin.json",
      },
    ],
    diagnostics: [
      {
        level: "warn",
        pluginId: "demo",
        source: "/workspace/.fased/extensions/demo",
        message: "shared warning",
      },
      {
        level: "error",
        pluginId: "provider-kit",
        message: "provider diagnostic",
      },
    ],
  };
}

function createChannelCatalog(): ChannelPluginCatalogEntry[] {
  return [
    {
      id: "zalo",
      catalogSource: "bundled",
      delivery: "bundled",
      meta: {
        id: "zalo",
        label: "Zalo",
        selectionLabel: "Zalo (Bot API)",
        docsPath: "/channels/zalo",
        docsLabel: "zalo",
        blurb: "Zalo channel plugin",
        order: 5,
      },
      install: {
        npmSpec: "@fased/zalo",
        localPath: "extensions/zalo",
        defaultChoice: "local",
      },
    },
  ];
}

describe("plugin marketplace backend", () => {
  beforeEach(() => {
    buildPluginLifecycleReport.mockReset();
    loadPluginManifestRegistry.mockReset();
    listChannelPluginCatalogEntries.mockReset();
    resolveBundledPluginSources.mockReset();

    buildPluginLifecycleReport.mockReturnValue(createLifecycleReport());
    loadPluginManifestRegistry.mockReturnValue(createManifestRegistry());
    listChannelPluginCatalogEntries.mockReturnValue(createChannelCatalog());
    resolveBundledPluginSources.mockReturnValue(
      new Map([
        [
          "zalo",
          {
            pluginId: "zalo",
            localPath: "/workspace/extensions/zalo",
            npmSpec: "@fased/zalo",
          },
        ],
      ]),
    );
  });

  it("merges lifecycle, manifest, catalog, and bundled data into actionable entries", () => {
    const report = buildPluginMarketplaceReport({
      config: {
        plugins: {
          entries: {
            demo: {
              runtime: {
                helpers: {
                  sessions: {
                    read: true,
                  },
                },
                adminRpcActions: {
                  allow: [
                    {
                      method: "push.test",
                      sources: ["origin:config", "source:/workspace/.fased/extensions/demo"],
                      requireOperatorApproval: true,
                    },
                  ],
                },
              },
            },
          },
        },
      },
    });

    const demo = report.plugins.find((entry) => entry.id === "demo");
    expect(demo).toMatchObject({
      id: "demo",
      name: "Demo Plugin",
      status: "loaded",
      managed: true,
      discovered: true,
      hasInstallRecord: true,
      providers: ["demo-provider"],
      channels: ["demo"],
      runtimeHelpers: {
        sessions: {
          read: true,
        },
        adminRpcActions: {
          sourceKeys: [
            "origin:config",
            "/workspace/.fased/extensions/demo",
            "source:/workspace/.fased/extensions/demo",
          ],
          methods: expect.arrayContaining([
            expect.objectContaining({
              method: "push.test",
              granted: true,
              effective: true,
            }),
          ]),
        },
      },
      actions: ["status", "update", "uninstall"],
    });
    expect(demo?.install?.spec).toBe("@fased/demo");

    const zalo = report.plugins.find((entry) => entry.id === "zalo");
    expect(zalo).toMatchObject({
      id: "zalo",
      name: "Zalo",
      status: "available",
      managed: false,
      discovered: false,
      actions: ["status", "install"],
      installOptions: {
        npmSpec: "@fased/zalo",
        localPath: "extensions/zalo",
        resolvedLocalPath: "/workspace/extensions/zalo",
        bundledLocalPath: "/workspace/extensions/zalo",
        defaultChoice: "local",
      },
    });

    expect(report.diagnostics).toEqual([
      {
        level: "warn",
        pluginId: "demo",
        source: "/workspace/.fased/extensions/demo",
        message: "shared warning",
      },
      {
        level: "error",
        pluginId: "provider-kit",
        message: "provider diagnostic",
      },
    ]);
  });

  it("marks runtime helper grants as disabled when the plugin has no explicit helper config", () => {
    const report = buildPluginMarketplaceReport({ config: {} });

    const demo = report.plugins.find((entry) => entry.id === "demo");
    expect(demo?.runtimeHelpers).toMatchObject({
      sessions: {
        read: false,
      },
    });
  });

  it("does not advertise install for already discovered unmanaged bundled plugins", () => {
    const report = buildPluginMarketplaceReport({ config: {} });
    const memory = report.plugins.find((entry) => entry.id === "memory-core");
    expect(memory).toMatchObject({
      id: "memory-core",
      status: "disabled",
      discovered: true,
      managed: false,
      actions: ["status"],
    });
  });

  it("advertises install for discovered but unloaded channel plugins with bundled sources", () => {
    buildPluginLifecycleReport.mockReturnValue({
      ...createLifecycleReport(),
      plugins: [
        ...createLifecycleReport().plugins,
        {
          id: "feishu",
          name: "Feishu",
          source: "/workspace/extensions/feishu",
          origin: "bundled",
          enabled: false,
          status: "disabled",
          toolNames: [],
          hookNames: [],
          channelIds: [],
          providerIds: [],
          gatewayMethods: [],
          cliCommands: [],
          services: [],
          commands: [],
          httpHandlers: 0,
          hookCount: 0,
          configSchema: false,
          managed: false,
        },
      ],
    });
    listChannelPluginCatalogEntries.mockReturnValue([
      ...createChannelCatalog(),
      {
        id: "feishu",
        meta: {
          id: "feishu",
          label: "Feishu",
          selectionLabel: "Feishu/Lark",
          docsPath: "/channels/feishu",
          docsLabel: "feishu",
          blurb: "Feishu channel plugin",
          order: 35,
        },
        catalogSource: "bundled",
        install: {
          localPath: "extensions/feishu",
          defaultChoice: "local",
        },
      },
    ]);
    resolveBundledPluginSources.mockReturnValue(
      new Map([
        [
          "feishu",
          {
            pluginId: "feishu",
            localPath: "/workspace/extensions/feishu",
          },
        ],
      ]),
    );

    const report = buildPluginMarketplaceReport({ config: {} });
    const feishu = report.plugins.find((entry) => entry.id === "feishu");
    expect(feishu).toMatchObject({
      id: "feishu",
      status: "disabled",
      discovered: true,
      managed: false,
      loaded: false,
      actions: ["status", "install"],
      installOptions: expect.objectContaining({
        localPath: "extensions/feishu",
        bundledLocalPath: "/workspace/extensions/feishu",
      }),
    });
  });

  it("resolves marketplace entries by id or display name", () => {
    const report = buildPluginMarketplaceReport({ config: {} });
    expect(
      resolvePluginMarketplaceEntry({
        idOrName: "Zalo",
        report,
      })?.id,
    ).toBe("zalo");
    expect(
      resolvePluginMarketplaceEntry({
        idOrName: "provider-kit",
        report,
      })?.name,
    ).toBe("Provider Kit");
  });
});
