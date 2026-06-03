import { describe, expect, it, vi } from "vitest";
import {
  installPluginMarketplaceEntry,
  loadExtensionsHooks,
  loadPluginMarketplace,
  loadPluginMarketplaceInfo,
  restartPluginMarketplaceRuntime,
  selectPluginMarketplaceEntry,
  setExtensionHookEnabled,
  setPluginMarketplaceAdminRpcGrant,
  setPluginMarketplaceSessionHelperGrant,
  type PluginsMarketplaceState,
  uninstallPluginMarketplaceEntry,
  updatePluginMarketplaceEntry,
} from "./plugins-marketplace.ts";

function createState() {
  const request = vi.fn();
  const client = { request } as unknown as NonNullable<PluginsMarketplaceState["client"]>;
  const state: PluginsMarketplaceState = {
    client,
    connected: true,
    pluginsMarketplaceLoading: false,
    pluginsMarketplaceDetailLoading: false,
    pluginsMarketplaceError: null,
    pluginsMarketplaceList: null,
    pluginsMarketplaceSelectedId: null,
    pluginsMarketplaceDetail: null,
    pluginsMarketplaceActionBusy: null,
    pluginsMarketplaceMessage: null,
    pluginsMarketplaceRemediation: null,
    extensionsHooksLoading: false,
    extensionsHooksError: null,
    extensionsHooksStatus: null,
    extensionsHooksBusyKey: null,
    extensionsHooksMessage: null,
  };
  return {
    state,
    request,
  };
}

describe("plugins marketplace controller", () => {
  it("loads the marketplace list without auto-expanding a plugin", async () => {
    const { state, request } = createState();
    request.mockResolvedValueOnce({
      agentId: "main",
      workspaceDir: "/tmp/workspace",
      plugins: [
        {
          id: "demo-plugin",
          name: "Demo Plugin",
          status: "loaded",
          discovered: true,
          managed: true,
          loaded: true,
          enabled: true,
          hasInstallRecord: true,
          channels: ["discord"],
          providers: ["demo-provider"],
          toolNames: ["demo-tool"],
          hookNames: [],
          gatewayMethods: ["plugins.demo"],
          cliCommands: [],
          services: [],
          commands: [],
          httpHandlers: 0,
          hookCount: 0,
          installOptions: {},
          actions: ["status", "update", "uninstall"],
        },
      ],
      diagnostics: [],
    });

    await loadPluginMarketplace(state);

    expect(request).toHaveBeenNthCalledWith(1, "plugins.marketplace.list", {});
    expect(request).toHaveBeenCalledTimes(1);
    expect(state.pluginsMarketplaceSelectedId).toBeNull();
    expect(state.pluginsMarketplaceDetail).toBeNull();
  });

  it("loads plugin detail when selecting another entry", async () => {
    const { state, request } = createState();
    state.pluginsMarketplaceSelectedId = "demo-plugin";

    request.mockResolvedValueOnce({
      agentId: "main",
      plugin: {
        id: "other-plugin",
        name: "Other Plugin",
        status: "available",
        discovered: true,
        managed: false,
        loaded: false,
        enabled: false,
        hasInstallRecord: false,
        channels: [],
        providers: [],
        toolNames: [],
        hookNames: [],
        gatewayMethods: [],
        cliCommands: [],
        services: [],
        commands: [],
        httpHandlers: 0,
        hookCount: 0,
        installOptions: {},
        actions: ["status", "install"],
      },
      diagnostics: [{ level: "warn", message: "Needs setup", pluginId: "other-plugin" }],
    });

    await selectPluginMarketplaceEntry(state, "other-plugin");

    expect(request).toHaveBeenCalledWith("plugins.marketplace.info", {
      id: "other-plugin",
    });
    expect(state.pluginsMarketplaceSelectedId).toBe("other-plugin");
    expect(state.pluginsMarketplaceDetail?.plugin.name).toBe("Other Plugin");
  });

  it("clears plugin detail when collapsing the selected entry", async () => {
    const { state, request } = createState();
    state.pluginsMarketplaceSelectedId = "demo-plugin";
    state.pluginsMarketplaceDetail = {
      agentId: "main",
      plugin: {
        id: "demo-plugin",
        name: "Demo Plugin",
        status: "loaded",
        discovered: true,
        managed: true,
        loaded: true,
        enabled: true,
        hasInstallRecord: true,
        channels: [],
        providers: [],
        toolNames: [],
        hookNames: [],
        gatewayMethods: [],
        cliCommands: [],
        services: [],
        commands: [],
        httpHandlers: 0,
        hookCount: 0,
        installOptions: {},
        actions: ["status"],
      },
      diagnostics: [],
    };

    await selectPluginMarketplaceEntry(state, " ");

    expect(request).not.toHaveBeenCalled();
    expect(state.pluginsMarketplaceSelectedId).toBeNull();
    expect(state.pluginsMarketplaceDetail).toBeNull();
  });

  it("clears detail state for an empty plugin id", async () => {
    const { state, request } = createState();

    await loadPluginMarketplaceInfo(state, "   ");

    expect(request).not.toHaveBeenCalled();
    expect(state.pluginsMarketplaceSelectedId).toBeNull();
    expect(state.pluginsMarketplaceDetail).toBeNull();
  });

  it("installs a marketplace plugin, refreshes detail, and stores the success message", async () => {
    const { state, request } = createState();
    state.pluginsMarketplaceSelectedId = "demo-plugin";

    request
      .mockResolvedValueOnce({
        action: "install",
        pluginId: "demo-plugin",
        changed: true,
        requiresRestart: true,
        message: "Installed plugin: demo-plugin",
        warnings: ["Restart required"],
      })
      .mockResolvedValueOnce({
        agentId: "main",
        workspaceDir: "/tmp/workspace",
        plugins: [
          {
            id: "demo-plugin",
            name: "Demo Plugin",
            status: "loaded",
            discovered: true,
            managed: true,
            loaded: true,
            enabled: true,
            hasInstallRecord: true,
            channels: [],
            providers: [],
            toolNames: [],
            hookNames: [],
            gatewayMethods: [],
            cliCommands: [],
            services: [],
            commands: [],
            httpHandlers: 0,
            hookCount: 0,
            installOptions: {},
            actions: ["status", "update", "uninstall"],
          },
        ],
        diagnostics: [],
      })
      .mockResolvedValueOnce({
        agentId: "main",
        workspaceDir: "/tmp/workspace",
        plugin: {
          id: "demo-plugin",
          name: "Demo Plugin",
          status: "loaded",
          discovered: true,
          managed: true,
          loaded: true,
          enabled: true,
          hasInstallRecord: true,
          channels: [],
          providers: [],
          toolNames: [],
          hookNames: [],
          gatewayMethods: [],
          cliCommands: [],
          services: [],
          commands: [],
          httpHandlers: 0,
          hookCount: 0,
          installOptions: {},
          actions: ["status", "update", "uninstall"],
        },
        diagnostics: [],
      });

    const ok = await installPluginMarketplaceEntry(state, "demo-plugin");

    expect(ok).toBe(true);
    expect(request).toHaveBeenNthCalledWith(1, "plugins.marketplace.install", {
      id: "demo-plugin",
    });
    expect(request).toHaveBeenNthCalledWith(2, "plugins.marketplace.list", {});
    expect(request).toHaveBeenNthCalledWith(3, "plugins.marketplace.info", {
      id: "demo-plugin",
    });
    expect(state.pluginsMarketplaceMessage).toContain("Installed plugin: demo-plugin");
    expect(state.pluginsMarketplaceMessage).toContain("Restart required");
    expect(state.pluginsMarketplaceRemediation).toMatchObject({
      pluginId: "demo-plugin",
      action: "install",
      requiresRestart: true,
    });
    expect(state.pluginsMarketplaceActionBusy).toBeNull();
  });

  it("updates a marketplace plugin and refreshes the selected detail", async () => {
    const { state, request } = createState();
    state.pluginsMarketplaceSelectedId = "demo-plugin";

    request
      .mockResolvedValueOnce({
        action: "update-preview",
        pluginId: "demo-plugin",
        message: "Would update demo-plugin: 1.0.0 -> 1.1.0.",
        warnings: [],
        updateReview: {
          approvalRequired: false,
          reasons: [],
          dependencyWarnings: [],
          scriptWarnings: [],
          scanWarnings: [],
          sourceTrust: {
            source: "npm",
            trusted: true,
            reason: "npm registry source with pinned integrity",
            integrityPinned: true,
          },
          permissionDiff: {
            added: { channels: [], providers: [], tools: [], skills: [] },
            removed: { channels: [], providers: [], tools: [], skills: [] },
            changed: [],
          },
        },
      })
      .mockResolvedValueOnce({
        action: "update",
        pluginId: "demo-plugin",
        changed: true,
        requiresRestart: true,
        message: "Updated plugin: demo-plugin",
        warnings: [],
      })
      .mockResolvedValueOnce({
        agentId: "main",
        workspaceDir: "/tmp/workspace",
        plugins: [
          {
            id: "demo-plugin",
            name: "Demo Plugin",
            status: "loaded",
            discovered: true,
            managed: true,
            loaded: true,
            enabled: true,
            hasInstallRecord: true,
            channels: [],
            providers: [],
            toolNames: [],
            hookNames: [],
            gatewayMethods: [],
            cliCommands: [],
            services: [],
            commands: [],
            httpHandlers: 0,
            hookCount: 0,
            installOptions: {},
            actions: ["status", "update", "uninstall"],
          },
        ],
        diagnostics: [],
      })
      .mockResolvedValueOnce({
        agentId: "main",
        workspaceDir: "/tmp/workspace",
        plugin: {
          id: "demo-plugin",
          name: "Demo Plugin",
          status: "loaded",
          discovered: true,
          managed: true,
          loaded: true,
          enabled: true,
          hasInstallRecord: true,
          channels: [],
          providers: [],
          toolNames: [],
          hookNames: [],
          gatewayMethods: [],
          cliCommands: [],
          services: [],
          commands: [],
          httpHandlers: 0,
          hookCount: 0,
          installOptions: {},
          actions: ["status", "update", "uninstall"],
        },
        diagnostics: [],
      });

    const ok = await updatePluginMarketplaceEntry(state, "demo-plugin");

    expect(ok).toBe(true);
    expect(request).toHaveBeenNthCalledWith(1, "plugins.marketplace.update.preview", {
      id: "demo-plugin",
    });
    expect(request).toHaveBeenNthCalledWith(2, "plugins.marketplace.update", {
      id: "demo-plugin",
    });
    expect(request).toHaveBeenNthCalledWith(3, "plugins.marketplace.list", {});
    expect(request).toHaveBeenNthCalledWith(4, "plugins.marketplace.info", {
      id: "demo-plugin",
    });
    expect(state.pluginsMarketplaceMessage).toBe("Updated plugin: demo-plugin");
  });

  it("requires confirmation before approving risky marketplace plugin updates", async () => {
    const { state, request } = createState();
    state.pluginsMarketplaceSelectedId = "demo-plugin";
    const confirmSpy = vi.fn(() => true);
    vi.stubGlobal("confirm", confirmSpy);

    request
      .mockResolvedValueOnce({
        action: "update-preview",
        pluginId: "demo-plugin",
        message: "Would update demo-plugin: 1.0.0 -> 1.1.0.",
        warnings: ["Update review: plugin manifest surface expands or changes"],
        updateReview: {
          approvalRequired: true,
          reasons: ["plugin manifest surface expands or changes"],
          dependencyWarnings: [],
          scriptWarnings: [],
          scanWarnings: [],
          sourceTrust: {
            source: "npm",
            trusted: true,
            reason: "npm registry source with pinned integrity",
            integrityPinned: true,
          },
          permissionDiff: {
            added: { channels: ["whatsapp"], providers: [], tools: [], skills: [] },
            removed: { channels: [], providers: [], tools: [], skills: [] },
            changed: [],
          },
        },
      })
      .mockResolvedValueOnce({
        action: "update",
        pluginId: "demo-plugin",
        changed: true,
        requiresRestart: true,
        message: "Updated plugin: demo-plugin",
        warnings: ["Update review: plugin manifest surface expands or changes"],
      })
      .mockResolvedValueOnce({ agentId: "main", plugins: [], diagnostics: [] });

    const ok = await updatePluginMarketplaceEntry(state, "demo-plugin");

    expect(ok).toBe(true);
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining("Approve risky update"));
    expect(request).toHaveBeenNthCalledWith(2, "plugins.marketplace.update", {
      id: "demo-plugin",
      approveRiskyChanges: true,
    });
    vi.unstubAllGlobals();
  });

  it("cancels risky marketplace plugin updates when confirmation is denied", async () => {
    const { state, request } = createState();
    const confirmSpy = vi.fn(() => false);
    vi.stubGlobal("confirm", confirmSpy);

    request.mockResolvedValueOnce({
      action: "update-preview",
      pluginId: "demo-plugin",
      message: "Would update demo-plugin: 1.0.0 -> 1.1.0.",
      warnings: ["Update review: package declares npm scripts"],
      updateReview: {
        approvalRequired: true,
        reasons: ["package declares npm scripts"],
        dependencyWarnings: [],
        scriptWarnings: ["package declares npm scripts (postinstall)"],
        scanWarnings: [],
        sourceTrust: {
          source: "npm",
          trusted: true,
          reason: "npm registry source with pinned integrity",
          integrityPinned: true,
        },
        permissionDiff: {
          added: { channels: [], providers: [], tools: [], skills: [] },
          removed: { channels: [], providers: [], tools: [], skills: [] },
          changed: [],
        },
      },
    });

    const ok = await updatePluginMarketplaceEntry(state, "demo-plugin");

    expect(ok).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
    expect(state.pluginsMarketplaceRemediation).toMatchObject({
      pluginId: "demo-plugin",
      message: "Update review cancelled.",
    });
    vi.unstubAllGlobals();
  });

  it("schedules a plugin runtime restart without forcing an immediate marketplace reload", async () => {
    const { state, request } = createState();

    request.mockResolvedValueOnce({
      action: "restart",
      pluginId: "demo-plugin",
      changed: false,
      requiresRestart: false,
      message: "Scheduled gateway restart for plugin runtime: demo-plugin",
      warnings: ["The control UI will reconnect automatically after the gateway restarts."],
    });

    const ok = await restartPluginMarketplaceRuntime(state, "demo-plugin");

    expect(ok).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("plugins.marketplace.restart", {
      id: "demo-plugin",
    });
    expect(state.pluginsMarketplaceMessage).toContain(
      "Scheduled gateway restart for plugin runtime: demo-plugin",
    );
    expect(state.pluginsMarketplaceRemediation).toMatchObject({
      pluginId: "demo-plugin",
      action: "restart",
      requiresRestart: false,
    });
  });

  it("sets a plugin runtime session helper grant and refreshes detail", async () => {
    const { state, request } = createState();
    state.pluginsMarketplaceSelectedId = "demo-plugin";

    request
      .mockResolvedValueOnce({
        action: "runtime-helper",
        pluginId: "demo-plugin",
        changed: true,
        requiresRestart: true,
        message: "Enabled runtime.helpers.sessions.read for plugin: demo-plugin",
        warnings: ["Restart the gateway to apply this helper grant to the active plugin runtime."],
      })
      .mockResolvedValueOnce({
        agentId: "main",
        workspaceDir: "/tmp/workspace",
        plugins: [
          {
            id: "demo-plugin",
            name: "Demo Plugin",
            status: "loaded",
            discovered: true,
            managed: true,
            loaded: true,
            enabled: true,
            hasInstallRecord: true,
            channels: [],
            providers: [],
            toolNames: [],
            hookNames: [],
            gatewayMethods: [],
            cliCommands: [],
            services: [],
            commands: [],
            httpHandlers: 0,
            hookCount: 0,
            installOptions: {},
            actions: ["status", "update", "uninstall"],
            runtimeHelpers: {
              sessions: {
                read: true,
              },
            },
          },
        ],
        diagnostics: [],
      })
      .mockResolvedValueOnce({
        agentId: "main",
        workspaceDir: "/tmp/workspace",
        plugin: {
          id: "demo-plugin",
          name: "Demo Plugin",
          status: "loaded",
          discovered: true,
          managed: true,
          loaded: true,
          enabled: true,
          hasInstallRecord: true,
          channels: [],
          providers: [],
          toolNames: [],
          hookNames: [],
          gatewayMethods: [],
          cliCommands: [],
          services: [],
          commands: [],
          httpHandlers: 0,
          hookCount: 0,
          installOptions: {},
          actions: ["status", "update", "uninstall"],
          runtimeHelpers: {
            sessions: {
              read: true,
            },
          },
        },
        diagnostics: [],
      });

    const ok = await setPluginMarketplaceSessionHelperGrant(state, "demo-plugin", true);

    expect(ok).toBe(true);
    expect(request).toHaveBeenNthCalledWith(1, "plugins.marketplace.runtimeHelper.set", {
      id: "demo-plugin",
      helper: "sessions.read",
      enabled: true,
    });
    expect(request).toHaveBeenNthCalledWith(2, "plugins.marketplace.list", {});
    expect(request).toHaveBeenNthCalledWith(3, "plugins.marketplace.info", {
      id: "demo-plugin",
    });
    expect(state.pluginsMarketplaceRemediation).toMatchObject({
      pluginId: "demo-plugin",
      action: "runtime-helper",
      requiresRestart: true,
    });
  });

  it("sets a plugin admin RPC grant with confirmation and refreshes detail", async () => {
    const { state, request } = createState();
    state.pluginsMarketplaceSelectedId = "demo-plugin";
    const confirmSpy = vi.fn(() => true);
    vi.stubGlobal("confirm", confirmSpy);

    request
      .mockResolvedValueOnce({
        action: "admin-rpc-grant",
        pluginId: "demo-plugin",
        changed: true,
        requiresRestart: true,
        message: "Enabled plugin admin RPC grant push.test for plugin: demo-plugin",
        warnings: [
          "Restart the gateway to apply this admin RPC grant to the active plugin runtime.",
          "The grant still requires operator-scoped calls, runtime audit, and rate limits.",
        ],
      })
      .mockResolvedValueOnce({
        agentId: "main",
        workspaceDir: "/tmp/workspace",
        plugins: [],
        diagnostics: [],
      });

    const ok = await setPluginMarketplaceAdminRpcGrant(state, "demo-plugin", "push.test", true);

    expect(ok).toBe(true);
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining("Enable admin RPC grant"));
    expect(request).toHaveBeenNthCalledWith(1, "plugins.marketplace.adminRpcGrant.set", {
      id: "demo-plugin",
      method: "push.test",
      enabled: true,
    });
    expect(request).toHaveBeenNthCalledWith(2, "plugins.marketplace.list", {});
    expect(state.pluginsMarketplaceRemediation).toMatchObject({
      pluginId: "demo-plugin",
      action: "admin-rpc-grant",
      requiresRestart: true,
    });
    vi.unstubAllGlobals();
  });

  it("cancels plugin admin RPC grants when confirmation is denied", async () => {
    const { state, request } = createState();
    const confirmSpy = vi.fn(() => false);
    vi.stubGlobal("confirm", confirmSpy);

    const ok = await setPluginMarketplaceAdminRpcGrant(state, "demo-plugin", "push.test", true);

    expect(ok).toBe(false);
    expect(request).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("forwards an explicit install source choice for marketplace installs", async () => {
    const { state, request } = createState();
    state.pluginsMarketplaceSelectedId = "demo-plugin";

    request
      .mockResolvedValueOnce({
        action: "install",
        pluginId: "demo-plugin",
        changed: true,
        requiresRestart: true,
        message: "Installed plugin: demo-plugin",
        warnings: [],
      })
      .mockResolvedValueOnce({
        agentId: "main",
        workspaceDir: "/tmp/workspace",
        plugins: [
          {
            id: "demo-plugin",
            name: "Demo Plugin",
            status: "loaded",
            discovered: true,
            managed: true,
            loaded: true,
            enabled: true,
            hasInstallRecord: true,
            channels: [],
            providers: [],
            toolNames: [],
            hookNames: [],
            gatewayMethods: [],
            cliCommands: [],
            services: [],
            commands: [],
            httpHandlers: 0,
            hookCount: 0,
            installOptions: {
              npmSpec: "@fased/demo-plugin",
              bundledLocalPath: "/tmp/extensions/demo-plugin",
            },
            actions: ["status", "update", "uninstall"],
          },
        ],
        diagnostics: [],
      })
      .mockResolvedValueOnce({
        agentId: "main",
        workspaceDir: "/tmp/workspace",
        plugin: {
          id: "demo-plugin",
          name: "Demo Plugin",
          status: "loaded",
          discovered: true,
          managed: true,
          loaded: true,
          enabled: true,
          hasInstallRecord: true,
          channels: [],
          providers: [],
          toolNames: [],
          hookNames: [],
          gatewayMethods: [],
          cliCommands: [],
          services: [],
          commands: [],
          httpHandlers: 0,
          hookCount: 0,
          installOptions: {
            npmSpec: "@fased/demo-plugin",
            bundledLocalPath: "/tmp/extensions/demo-plugin",
          },
          actions: ["status", "update", "uninstall"],
        },
        diagnostics: [],
      });

    const ok = await installPluginMarketplaceEntry(state, "demo-plugin", "npm");

    expect(ok).toBe(true);
    expect(request).toHaveBeenNthCalledWith(1, "plugins.marketplace.install", {
      id: "demo-plugin",
      sourceChoice: "npm",
    });
  });

  it("uninstalls a marketplace plugin, prompts first, and clears the selected detail", async () => {
    const { state, request } = createState();
    state.pluginsMarketplaceSelectedId = "demo-plugin";

    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    request
      .mockResolvedValueOnce({
        action: "uninstall",
        pluginId: "demo-plugin",
        changed: true,
        requiresRestart: true,
        message: "Uninstalled plugin: demo-plugin",
        warnings: [],
      })
      .mockResolvedValueOnce({
        agentId: "main",
        workspaceDir: "/tmp/workspace",
        plugins: [],
        diagnostics: [],
      });

    try {
      const ok = await uninstallPluginMarketplaceEntry(state, "demo-plugin");

      expect(ok).toBe(true);
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenNthCalledWith(1, "plugins.marketplace.uninstall", {
        id: "demo-plugin",
      });
      expect(request).toHaveBeenNthCalledWith(2, "plugins.marketplace.list", {});
      expect(request).not.toHaveBeenCalledWith("plugins.marketplace.info", expect.anything());
      expect(state.pluginsMarketplaceSelectedId).toBeNull();
      expect(state.pluginsMarketplaceDetail).toBeNull();
    } finally {
      confirm.mockRestore();
    }
  });

  it("loads extension hook status separately from the plugin catalog", async () => {
    const { state, request } = createState();
    request.mockResolvedValueOnce({
      agentId: "main",
      workspaceDir: "/tmp/workspace",
      managedHooksDir: "/tmp/hooks",
      hooks: [
        {
          name: "command-logger",
          hookKey: "command-logger",
          description: "Log commands",
          source: "workspace",
          events: ["command:new"],
          always: false,
          disabled: false,
          eligible: true,
          managedByPlugin: false,
          missing: [],
          configChecks: [],
          install: [],
        },
      ],
    });

    await loadExtensionsHooks(state);

    expect(request).toHaveBeenCalledWith("hooks.list", {});
    expect(state.extensionsHooksStatus?.hooks[0]?.name).toBe("command-logger");
    expect(state.extensionsHooksError).toBeNull();
  });

  it("toggles extension hooks and stores the returned status report", async () => {
    const { state, request } = createState();
    request.mockResolvedValueOnce({
      changed: true,
      hookName: "command-logger",
      hookKey: "command-logger",
      enabled: false,
      report: {
        agentId: "main",
        workspaceDir: "/tmp/workspace",
        managedHooksDir: "/tmp/hooks",
        hooks: [
          {
            name: "command-logger",
            hookKey: "command-logger",
            description: "Log commands",
            source: "workspace",
            events: ["command:new"],
            always: false,
            disabled: true,
            eligible: false,
            managedByPlugin: false,
            missing: [],
            configChecks: [],
            install: [],
          },
        ],
      },
    });

    const ok = await setExtensionHookEnabled(state, "command-logger", false);

    expect(ok).toBe(true);
    expect(request).toHaveBeenCalledWith("hooks.setEnabled", {
      name: "command-logger",
      enabled: false,
    });
    expect(state.extensionsHooksStatus?.hooks[0]?.disabled).toBe(true);
    expect(state.extensionsHooksMessage).toBe("Disabled hook command-logger.");
    expect(state.extensionsHooksBusyKey).toBeNull();
  });
});
