import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../protocol/index.js";
import { pluginsMarketplaceHandlers } from "./plugins-marketplace.js";

vi.mock("../../config/config.js", () => ({
  loadConfig: vi.fn(() => ({})),
  writeConfigFile: vi.fn(async () => {}),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  listAgentIds: vi.fn(() => ["main"]),
  resolveDefaultAgentId: vi.fn(() => "main"),
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace-main"),
}));

const buildPluginMarketplaceReport = vi.hoisted(() => vi.fn());
const resolvePluginMarketplaceEntry = vi.hoisted(() => vi.fn());
const installPluginFromNpmSpec = vi.hoisted(() => vi.fn());
const buildNpmResolutionInstallFields = vi.hoisted(() =>
  vi.fn(() => ({ resolvedVersion: "1.2.3" })),
);
const executePluginUninstallLifecycle = vi.hoisted(() => vi.fn());
const executePluginUpdateLifecycle = vi.hoisted(() => vi.fn());
const finalizeInstalledPluginConfig = vi.hoisted(() => vi.fn());
const clearPluginManifestRegistryCache = vi.hoisted(() => vi.fn());
const scheduleGatewaySigusr1Restart = vi.hoisted(() =>
  vi.fn(() => ({ scheduled: true, coalesced: false, delayMs: 0 })),
);

vi.mock("../../plugins/marketplace.js", () => ({
  buildPluginMarketplaceReport,
  resolvePluginMarketplaceEntry,
}));

vi.mock("../../plugins/install.js", () => ({
  installPluginFromNpmSpec,
}));

vi.mock("../../plugins/installs.js", () => ({
  buildNpmResolutionInstallFields,
}));

vi.mock("../../plugins/lifecycle.js", () => ({
  executePluginUninstallLifecycle,
  executePluginUpdateLifecycle,
  finalizeInstalledPluginConfig,
}));

vi.mock("../../plugins/manifest-registry.js", () => ({
  clearPluginManifestRegistryCache,
}));

vi.mock("../../infra/restart.js", () => ({
  scheduleGatewaySigusr1Restart,
}));

type RespondCall = [boolean, unknown?, { code: number; message: string }?];

function createBaseReport() {
  return {
    workspaceDir: "/tmp/workspace-main",
    plugins: [
      {
        id: "demo",
        name: "Demo Plugin",
        origin: "workspace",
        source: "/tmp/extensions/demo",
        status: "loaded",
        discovered: true,
        managed: true,
        loaded: true,
        enabled: true,
        hasInstallRecord: true,
        install: {
          source: "npm",
          spec: "@fased/demo",
          installPath: "/tmp/extensions/demo",
          version: "1.2.2",
          integrity: "sha512-old",
        },
        channels: ["demo"],
        providers: ["demo-provider"],
        toolNames: ["demo-tool"],
        hookNames: [],
        gatewayMethods: ["plugin.demo"],
        cliCommands: ["demo"],
        services: [],
        commands: [],
        httpHandlers: 0,
        hookCount: 0,
        installOptions: {
          npmSpec: "@fased/demo",
        },
        actions: ["status", "update", "uninstall"],
      },
    ],
    diagnostics: [
      {
        level: "warn",
        message: "demo warning",
        pluginId: "demo",
      },
    ],
  };
}

function createInvoke(
  method: keyof typeof pluginsMarketplaceHandlers,
  params: Record<string, unknown>,
) {
  const respond = vi.fn();
  return {
    respond,
    invoke: async () =>
      await pluginsMarketplaceHandlers[method]({
        params,
        respond: respond as never,
        context: {} as never,
        client: null,
        req: { type: "req", id: "req-1", method },
        isWebchatConnect: () => false,
      }),
  };
}

describe("plugins.marketplace handlers", () => {
  beforeEach(() => {
    buildPluginMarketplaceReport.mockReset();
    resolvePluginMarketplaceEntry.mockReset();
    installPluginFromNpmSpec.mockReset();
    buildNpmResolutionInstallFields.mockReset();
    executePluginUninstallLifecycle.mockReset();
    executePluginUpdateLifecycle.mockReset();
    finalizeInstalledPluginConfig.mockReset();
    clearPluginManifestRegistryCache.mockReset();
    scheduleGatewaySigusr1Restart.mockReset();
    buildPluginMarketplaceReport.mockReturnValue(createBaseReport());
    resolvePluginMarketplaceEntry.mockImplementation(({ report, idOrName }) =>
      report.plugins.find(
        (entry: { id: string; name: string }) => entry.id === idOrName || entry.name === idOrName,
      ),
    );
    buildNpmResolutionInstallFields.mockReturnValue({ resolvedVersion: "1.2.3" });
    finalizeInstalledPluginConfig.mockReturnValue({
      config: { plugins: { entries: { demo: { enabled: true } } } },
      slotWarnings: ["slot adjusted"],
    });
    executePluginUpdateLifecycle.mockResolvedValue({
      changed: true,
      config: { plugins: { entries: { demo: { enabled: true } } } },
      outcomes: [
        {
          pluginId: "demo",
          status: "updated",
          message: "Updated plugin: demo",
          currentVersion: "1.2.2",
          nextVersion: "1.2.3",
          resolvedSpec: "@fased/demo@1.2.3",
          integrity: "sha512-new",
          warnings: [],
          packageReview: {
            pluginId: "demo",
            packageName: "@fased/demo",
            version: "1.2.3",
            extensions: ["index.js"],
            channels: ["demo"],
            providers: ["demo-provider"],
            skills: [],
            tools: ["demo-tool"],
            dependencyCount: 0,
            dependencyKinds: [],
            scriptNames: [],
            dependencyWarnings: [],
            scriptWarnings: [],
          },
        },
      ],
    });
    executePluginUninstallLifecycle.mockResolvedValue({
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
    scheduleGatewaySigusr1Restart.mockReturnValue({
      scheduled: true,
      coalesced: false,
      delayMs: 0,
    });
  });

  it("rejects invalid list params", async () => {
    const { respond, invoke } = createInvoke("plugins.marketplace.list", { extra: true });
    await invoke();
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(call?.[2]?.message).toContain("invalid plugins.marketplace.list params");
  });

  it("rejects unknown agent ids", async () => {
    const { respond, invoke } = createInvoke("plugins.marketplace.list", { agentId: "unknown" });
    await invoke();
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(call?.[2]?.message).toContain('unknown agent id "unknown"');
  });

  it("returns marketplace list payload", async () => {
    const { respond, invoke } = createInvoke("plugins.marketplace.list", {});
    await invoke();
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    expect(call?.[1]).toMatchObject({
      agentId: "main",
      workspaceDir: "/tmp/workspace-main",
      plugins: [
        expect.objectContaining({
          id: "demo",
          actions: ["status", "update", "uninstall"],
        }),
      ],
      diagnostics: [
        expect.objectContaining({
          pluginId: "demo",
        }),
      ],
    });
    expect(buildPluginMarketplaceReport).toHaveBeenCalledWith({
      config: {},
      workspaceDir: "/tmp/workspace-main",
    });
  });

  it("returns marketplace info payload", async () => {
    const { respond, invoke } = createInvoke("plugins.marketplace.info", { id: "demo" });
    await invoke();
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    expect(call?.[1]).toMatchObject({
      agentId: "main",
      plugin: expect.objectContaining({
        id: "demo",
        name: "Demo Plugin",
      }),
    });
  });

  it("returns an error when marketplace plugin info is missing", async () => {
    resolvePluginMarketplaceEntry.mockReturnValue(undefined);
    const { respond, invoke } = createInvoke("plugins.marketplace.info", { id: "missing" });
    await invoke();
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(call?.[2]?.message).toContain("plugin not found in marketplace");
  });

  it("installs a plugin from a linked local source", async () => {
    buildPluginMarketplaceReport.mockReturnValue({
      ...createBaseReport(),
      plugins: [
        {
          ...createBaseReport().plugins[0],
          status: "available",
          enabled: false,
          loaded: false,
          hasInstallRecord: false,
          actions: ["status", "install"],
          installOptions: {
            bundledLocalPath: "/tmp/extensions/demo",
            defaultChoice: "local",
          },
        },
      ],
    });

    const { respond, invoke } = createInvoke("plugins.marketplace.install", { id: "demo" });
    await invoke();

    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    expect(call?.[1]).toMatchObject({
      action: "install",
      pluginId: "demo",
      changed: true,
      requiresRestart: true,
    });
    expect(finalizeInstalledPluginConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: "demo",
        loadPath: "/tmp/extensions/demo",
      }),
    );
  });

  it("enables a bundled local plugin without adding it as a config load path", async () => {
    buildPluginMarketplaceReport.mockReturnValue({
      ...createBaseReport(),
      plugins: [
        {
          ...createBaseReport().plugins[0],
          origin: "bundled",
          source: "/repo/extensions/demo/index.ts",
          status: "disabled",
          enabled: false,
          loaded: false,
          managed: false,
          hasInstallRecord: false,
          install: undefined,
          actions: ["status", "install"],
          installOptions: {
            bundledLocalPath: "/repo/extensions/demo",
            defaultChoice: "local",
          },
        },
      ],
    });

    const { respond, invoke } = createInvoke("plugins.marketplace.install", { id: "demo" });
    await invoke();

    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    expect(call?.[1]).toMatchObject({
      action: "install",
      pluginId: "demo",
      changed: true,
      requiresRestart: true,
      message: "Enabled bundled plugin: demo. Restart the gateway to load it.",
    });
    expect(finalizeInstalledPluginConfig).toHaveBeenCalledWith(
      expect.not.objectContaining({
        loadPath: expect.any(String),
        installRecord: expect.any(Object),
      }),
    );
  });

  it("installs a plugin from npm when requested", async () => {
    buildPluginMarketplaceReport.mockReturnValue({
      ...createBaseReport(),
      plugins: [
        {
          ...createBaseReport().plugins[0],
          status: "available",
          enabled: false,
          loaded: false,
          hasInstallRecord: false,
          actions: ["status", "install"],
          installOptions: {
            npmSpec: "@fased/demo",
            defaultChoice: "npm",
          },
        },
      ],
    });
    installPluginFromNpmSpec.mockResolvedValue({
      ok: true,
      pluginId: "demo",
      targetDir: "/tmp/extensions/demo",
      version: "1.2.3",
      extensions: ["index.js"],
      npmResolution: { version: "1.2.3" },
    });

    const { respond, invoke } = createInvoke("plugins.marketplace.install", {
      id: "demo",
      sourceChoice: "npm",
    });
    await invoke();

    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    expect(installPluginFromNpmSpec).toHaveBeenCalledWith({
      spec: "@fased/demo",
      expectedPluginId: "demo",
    });
    expect(finalizeInstalledPluginConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: "demo",
        installRecord: expect.objectContaining({
          source: "npm",
          spec: "@fased/demo",
          installPath: "/tmp/extensions/demo",
          version: "1.2.3",
          resolvedVersion: "1.2.3",
        }),
      }),
    );
  });

  it("installs official external channel packages with legacy plugin id aliases", async () => {
    buildPluginMarketplaceReport.mockReturnValue({
      ...createBaseReport(),
      plugins: [
        {
          ...createBaseReport().plugins[0],
          id: "yuanbao",
          name: "Yuanbao",
          status: "available",
          enabled: false,
          loaded: false,
          hasInstallRecord: false,
          actions: ["status", "install"],
          channelCatalog: {
            id: "yuanbao",
            label: "Yuanbao",
            selectionLabel: "Yuanbao",
            docsPath: "/plugins/community#yuanbao",
            blurb: "Tencent Yuanbao AI assistant conversation channel.",
            aliases: ["fased-plugin-yuanbao"],
          },
          installOptions: {
            npmSpec: "fased-plugin-yuanbao@2.11.0",
            defaultChoice: "npm",
            expectedIntegrity: "sha512-yuanbao",
          },
        },
      ],
    });
    installPluginFromNpmSpec.mockResolvedValue({
      ok: true,
      pluginId: "fased-plugin-yuanbao",
      targetDir: "/tmp/extensions/fased-plugin-yuanbao",
      version: "2.11.0",
      extensions: ["index.js"],
      npmResolution: { version: "2.11.0" },
    });

    const { respond, invoke } = createInvoke("plugins.marketplace.install", {
      id: "yuanbao",
      sourceChoice: "npm",
    });
    await invoke();

    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    expect(installPluginFromNpmSpec).toHaveBeenCalledWith({
      spec: "fased-plugin-yuanbao@2.11.0",
      expectedPluginId: "yuanbao",
      expectedPluginIds: ["fased-plugin-yuanbao", "yuanbao"],
      expectedIntegrity: "sha512-yuanbao",
    });
    expect(finalizeInstalledPluginConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: "fased-plugin-yuanbao",
      }),
    );
  });

  it("updates a marketplace plugin via the lifecycle backend", async () => {
    const { respond, invoke } = createInvoke("plugins.marketplace.update", { id: "demo" });
    await invoke();

    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    expect(call?.[1]).toMatchObject({
      action: "update",
      pluginId: "demo",
      changed: true,
      requiresRestart: true,
      message: "Updated plugin: demo",
    });
    expect(executePluginUpdateLifecycle).toHaveBeenNthCalledWith(1, {
      config: {},
      pluginIds: ["demo"],
      dryRun: true,
    });
    expect(executePluginUpdateLifecycle).toHaveBeenNthCalledWith(2, {
      config: {},
      pluginIds: ["demo"],
    });
    expect(clearPluginManifestRegistryCache).toHaveBeenCalledTimes(1);
  });

  it("previews marketplace plugin update trust and permission state", async () => {
    const { respond, invoke } = createInvoke("plugins.marketplace.update.preview", { id: "demo" });
    await invoke();

    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    expect(call?.[1]).toMatchObject({
      action: "update-preview",
      pluginId: "demo",
      updateReview: {
        approvalRequired: false,
        sourceTrust: {
          source: "npm",
          trusted: true,
          integrityPinned: true,
        },
      },
    });
    expect(executePluginUpdateLifecycle).toHaveBeenCalledWith({
      config: {},
      pluginIds: ["demo"],
      dryRun: true,
    });
  });

  it("requires explicit approval when plugin update review is risky", async () => {
    executePluginUpdateLifecycle.mockResolvedValueOnce({
      changed: false,
      config: {},
      outcomes: [
        {
          pluginId: "demo",
          status: "updated",
          message: "Would update demo: 1.2.2 -> 1.2.3.",
          currentVersion: "1.2.2",
          nextVersion: "1.2.3",
          packageReview: {
            pluginId: "demo",
            packageName: "@fased/demo",
            version: "1.2.3",
            extensions: ["index.js"],
            channels: ["demo", "whatsapp"],
            providers: ["demo-provider"],
            skills: [],
            tools: ["demo-tool"],
            dependencyCount: 1,
            dependencyKinds: ["dependencies:1"],
            scriptNames: ["postinstall"],
            dependencyWarnings: [
              "package declares 1 runtime dependency; Fased installs with npm --ignore-scripts",
            ],
            scriptWarnings: [
              "package declares npm scripts (postinstall); Fased pack/install paths use --ignore-scripts",
            ],
          },
        },
      ],
    });

    const { respond, invoke } = createInvoke("plugins.marketplace.update", { id: "demo" });
    await invoke();

    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(call?.[2]?.message).toContain("plugin update requires explicit approval");
    expect(executePluginUpdateLifecycle).toHaveBeenCalledTimes(1);
  });

  it("allows approved risky marketplace plugin updates", async () => {
    executePluginUpdateLifecycle
      .mockResolvedValueOnce({
        changed: false,
        config: {},
        outcomes: [
          {
            pluginId: "demo",
            status: "updated",
            message: "Would update demo: 1.2.2 -> 1.2.3.",
            currentVersion: "1.2.2",
            nextVersion: "1.2.3",
            packageReview: {
              pluginId: "demo",
              packageName: "@fased/demo",
              version: "1.2.3",
              extensions: ["index.js"],
              channels: ["demo", "whatsapp"],
              providers: ["demo-provider"],
              skills: [],
              tools: ["demo-tool"],
              dependencyCount: 1,
              dependencyKinds: ["dependencies:1"],
              scriptNames: ["postinstall"],
              dependencyWarnings: [
                "package declares 1 runtime dependency; Fased installs with npm --ignore-scripts",
              ],
              scriptWarnings: [
                "package declares npm scripts (postinstall); Fased pack/install paths use --ignore-scripts",
              ],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        changed: true,
        config: { plugins: { entries: { demo: { enabled: true } } } },
        outcomes: [{ pluginId: "demo", status: "updated", message: "Updated plugin: demo" }],
      });

    const { respond, invoke } = createInvoke("plugins.marketplace.update", {
      id: "demo",
      approveRiskyChanges: true,
    });
    await invoke();

    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    expect(call?.[1]).toMatchObject({
      action: "update",
      pluginId: "demo",
      warnings: expect.arrayContaining([
        expect.stringContaining("plugin manifest surface expands or changes"),
        expect.stringContaining("npm scripts"),
      ]),
    });
    expect(executePluginUpdateLifecycle).toHaveBeenCalledTimes(2);
  });

  it("schedules a gateway restart for plugin runtime remediation", async () => {
    const { respond, invoke } = createInvoke("plugins.marketplace.restart", { id: "demo" });
    await invoke();

    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    expect(call?.[1]).toMatchObject({
      action: "restart",
      pluginId: "demo",
      changed: false,
      requiresRestart: false,
      message: "Scheduled gateway restart for plugin runtime: demo",
      warnings: ["The control UI will reconnect automatically after the gateway restarts."],
    });
    expect(scheduleGatewaySigusr1Restart).toHaveBeenCalledWith({
      reason: "plugins.marketplace.restart:demo",
    });
  });

  it("sets a plugin runtime helper grant through the marketplace", async () => {
    const { respond, invoke } = createInvoke("plugins.marketplace.runtimeHelper.set", {
      id: "demo",
      helper: "sessions.read",
      enabled: true,
    });
    await invoke();

    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    expect(call?.[1]).toMatchObject({
      action: "runtime-helper",
      pluginId: "demo",
      changed: true,
      requiresRestart: true,
      message: "Enabled runtime.helpers.sessions.read for plugin: demo",
      warnings: ["Restart the gateway to apply this helper grant to the active plugin runtime."],
    });
  });

  it("sets a plugin admin RPC grant through the marketplace", async () => {
    const { respond, invoke } = createInvoke("plugins.marketplace.adminRpcGrant.set", {
      id: "demo",
      method: "push.test",
      enabled: true,
    });
    await invoke();

    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    expect(call?.[1]).toMatchObject({
      action: "admin-rpc-grant",
      pluginId: "demo",
      changed: true,
      requiresRestart: true,
      message: "Enabled plugin admin RPC grant push.test for plugin: demo",
      warnings: [
        "Restart the gateway to apply this admin RPC grant to the active plugin runtime.",
        "The grant still requires operator-scoped calls, runtime audit, and rate limits.",
      ],
    });
  });

  it("rejects plugin admin RPC grant enablement without trusted source keys", async () => {
    buildPluginMarketplaceReport.mockReturnValue({
      ...createBaseReport(),
      plugins: [
        {
          ...createBaseReport().plugins[0],
          origin: undefined,
          source: undefined,
        },
      ],
    });
    const { respond, invoke } = createInvoke("plugins.marketplace.adminRpcGrant.set", {
      id: "demo",
      method: "push.test",
      enabled: true,
    });
    await invoke();

    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(call?.[2]?.message).toContain("has no trusted source keys");
  });

  it("rejects admin RPC names as plugin runtime helper grants", async () => {
    for (const helper of ["chat.inject", "push.test", "web.login.start", "web.login.wait"]) {
      const { respond, invoke } = createInvoke("plugins.marketplace.runtimeHelper.set", {
        id: "demo",
        helper,
        enabled: true,
      });
      await invoke();

      const call = respond.mock.calls[0] as RespondCall | undefined;
      expect(call?.[0]).toBe(false);
      expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
      expect(call?.[2]?.message).toContain("invalid plugins.marketplace.runtimeHelper.set params");
      respond.mockClear();
    }
  });

  it("uninstalls a marketplace plugin via the lifecycle backend", async () => {
    const { respond, invoke } = createInvoke("plugins.marketplace.uninstall", { id: "demo" });
    await invoke();

    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    expect(call?.[1]).toMatchObject({
      action: "uninstall",
      pluginId: "demo",
      changed: true,
      requiresRestart: true,
      message: "Uninstalled plugin: demo",
    });
    expect(executePluginUninstallLifecycle).toHaveBeenCalledWith({
      config: {},
      pluginId: "demo",
      deleteFiles: true,
    });
    expect(clearPluginManifestRegistryCache).toHaveBeenCalledTimes(1);
  });
});
