import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { PluginMarketplaceEntry } from "../types.ts";
import {
  buildPluginConfigurationNotes,
  buildPluginManagementShortcuts,
  buildPluginRemediationNotes,
  buildPluginRemediationState,
  filterPluginAdminRpcDiagnostics,
  filterPluginDiagnostics,
  filterGlobalPluginDiagnostics,
  filterPluginRuntimeHelperDiagnostics,
  resolveInstallActionChoices,
  resolvePluginInstallSourceDetail,
  renderPluginsMarketplace,
  shouldShowPluginRestartAction,
  summarizePluginDiagnosticsOverview,
  summarizePluginOperationalState,
  summarizePluginRuntimeHelpers,
  summarizePluginRuntimeSurface,
} from "./plugins-marketplace.ts";

function normalizeText(node: Element | DocumentFragment): string {
  return node.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

describe("plugins marketplace view helpers", () => {
  it("renders extensions as an expandable list instead of a split detail pane", () => {
    const container = document.createElement("div");
    render(
      renderPluginsMarketplace({
        connected: true,
        loading: false,
        detailLoading: false,
        error: null,
        message: null,
        actionBusy: null,
        remediation: null,
        hooksLoading: false,
        hooksError: null,
        hooksMessage: null,
        hooksBusyKey: null,
        hooksStatus: {
          agentId: "main",
          workspaceDir: "/tmp/workspace",
          managedHooksDir: "/tmp/hooks",
          hooks: [],
        },
        report: {
          agentId: "main",
          workspaceDir: "/tmp/workspace",
          plugins: [
            {
              id: "discord-plugin",
              name: "Discord Plugin",
              status: "loaded",
              discovered: true,
              managed: true,
              loaded: true,
              enabled: true,
              hasInstallRecord: true,
              channels: ["discord"],
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
              actions: ["status", "uninstall"],
            },
          ],
          diagnostics: [],
        },
        detail: null,
        selectedId: null,
        onRefresh: vi.fn(),
        onHooksRefresh: vi.fn(),
        onSetHookEnabled: vi.fn(),
        onSelect: vi.fn(),
        onInstall: vi.fn(),
        onRestartRuntime: vi.fn(),
        onUpdate: vi.fn(),
        onUninstall: vi.fn(),
        onSetSessionHelperGrant: vi.fn(),
        onSetAdminRpcGrant: vi.fn(),
        onOpenConfigSection: vi.fn(),
        onOpenChannels: vi.fn(),
        onOpenTab: vi.fn(),
      }),
      container,
    );

    expect(container.querySelectorAll("details.extensions-plugin")).toHaveLength(1);
    expect(container.querySelector(".surface-split")).toBeNull();
    expect(container.querySelector("details.extension-detail-section--top")).toBeNull();
    const text = normalizeText(container);
    expect(text).toContain("Extensions");
    expect(text).toContain("Hooks");
    expect(text).toContain("1 channel");
    expect(text).not.toContain("Plugin Details");
    expect(text).not.toContain("status only");
  });

  it("sorts active extensions above inactive entries", () => {
    const container = document.createElement("div");
    const baseEntry: Omit<PluginMarketplaceEntry, "id" | "name" | "status" | "loaded" | "enabled"> =
      {
        discovered: true,
        managed: true,
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
      };
    render(
      renderPluginsMarketplace({
        connected: true,
        loading: false,
        detailLoading: false,
        error: null,
        message: null,
        actionBusy: null,
        remediation: null,
        hooksLoading: false,
        hooksError: null,
        hooksMessage: null,
        hooksBusyKey: null,
        hooksStatus: {
          agentId: "main",
          workspaceDir: "/tmp/workspace",
          managedHooksDir: "/tmp/hooks",
          hooks: [],
        },
        report: {
          agentId: "main",
          workspaceDir: "/tmp/workspace",
          plugins: [
            {
              ...baseEntry,
              id: "available-plugin",
              name: "Available Plugin",
              status: "available",
              loaded: false,
              enabled: false,
            },
            {
              ...baseEntry,
              id: "active-plugin",
              name: "Active Plugin",
              status: "loaded",
              loaded: true,
              enabled: true,
            },
          ],
          diagnostics: [],
        },
        detail: null,
        selectedId: null,
        onRefresh: vi.fn(),
        onHooksRefresh: vi.fn(),
        onSetHookEnabled: vi.fn(),
        onSelect: vi.fn(),
        onInstall: vi.fn(),
        onRestartRuntime: vi.fn(),
        onUpdate: vi.fn(),
        onUninstall: vi.fn(),
        onSetSessionHelperGrant: vi.fn(),
        onSetAdminRpcGrant: vi.fn(),
        onOpenConfigSection: vi.fn(),
        onOpenChannels: vi.fn(),
        onOpenTab: vi.fn(),
      }),
      container,
    );

    const rows = Array.from(container.querySelectorAll("details.extensions-plugin"));
    expect(rows).toHaveLength(2);
    expect(normalizeText(rows[0])).toContain("Active Plugin");
  });

  it("summarizes the runtime surface counts compactly", () => {
    const summary = summarizePluginRuntimeSurface({
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
      runtimeHelpers: {
        sessions: {
          read: true,
        },
        adminRpcActions: {
          sourceKeys: ["origin:workspace"],
          methods: [
            {
              method: "push.test",
              granted: true,
              effective: true,
              sources: ["origin:workspace"],
              requireOperatorApproval: true,
            },
            {
              method: "chat.inject",
              granted: false,
              effective: false,
              sources: [],
              requireOperatorApproval: false,
              reason: "missing-runtime-admin-rpc-grant",
            },
          ],
        },
      },
      installOptions: {},
      actions: ["status", "update"],
    });

    expect(summary).toContain("1 channels");
    expect(summary).toContain("1 providers");
    expect(summary).toContain("1 tools");
    expect(summary).toContain("1 gateway methods");
    expect(summary).toContain("session helper");
    expect(summary).toContain("admin RPC grant");
  });

  it("keeps global diagnostics out of plugin-specific detail filtering", () => {
    const filtered = filterPluginDiagnostics(
      [
        { level: "warn", message: "Global note" },
        { level: "error", message: "Wrong plugin", pluginId: "other-plugin" },
        { level: "warn", message: "Selected plugin", pluginId: "demo-plugin" },
      ],
      "demo-plugin",
    );

    expect(filtered).toEqual([
      { level: "warn", message: "Selected plugin", pluginId: "demo-plugin" },
    ]);
    expect(filterPluginDiagnostics([{ level: "warn", message: "Global note" }], null)).toEqual([
      { level: "warn", message: "Global note" },
    ]);
    expect(
      filterGlobalPluginDiagnostics([
        { level: "warn", message: "Global note" },
        { level: "warn", message: "Selected plugin", pluginId: "demo-plugin" },
      ]),
    ).toEqual([{ level: "warn", message: "Global note" }]);
  });

  it("shows an empty runtime summary when nothing is registered", () => {
    const summary = summarizePluginRuntimeSurface({
      id: "empty-plugin",
      name: "Empty Plugin",
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
    });

    expect(summary).toBe("");
  });

  it("offers both local and npm install choices when both sources are available", () => {
    const choices = resolveInstallActionChoices({
      id: "demo-plugin",
      name: "Demo Plugin",
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
      installOptions: {
        npmSpec: "@fased/demo-plugin",
        bundledLocalPath: "/tmp/extensions/demo-plugin",
      },
      actions: ["status", "install"],
    });

    expect(choices).toEqual([
      {
        label: "Link local",
        sourceChoice: "local",
        detail: "/tmp/extensions/demo-plugin",
      },
      {
        label: "Install npm",
        sourceChoice: "npm",
        detail: "@fased/demo-plugin",
      },
    ]);
  });

  it("builds management shortcuts for installed plugins with providers, channels, and gateway surfaces", () => {
    const shortcuts = buildPluginManagementShortcuts({
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
      hookNames: ["before-send"],
      gatewayMethods: ["plugins.demo"],
      cliCommands: [],
      services: [],
      commands: [],
      httpHandlers: 1,
      hookCount: 1,
      installOptions: {},
      actions: ["status", "update", "uninstall"],
    });

    expect(shortcuts.map((shortcut) => shortcut.key)).toEqual([
      "providers",
      "agents",
      "channels",
      "debug",
      "tools",
    ]);
    expect(shortcuts.map((shortcut) => shortcut.label)).toEqual([
      "Open Providers",
      "Open Agent Models",
      "Open Channels",
      "Open Debug",
      "Open Agent Tools",
    ]);
    expect(shortcuts.map((shortcut) => shortcut.label).join(" ")).not.toContain("Open Config");
  });

  it("prefers resolved install detail for path installs and npm spec for npm installs", () => {
    expect(
      resolvePluginInstallSourceDetail({
        id: "path-plugin",
        name: "Path Plugin",
        status: "loaded",
        discovered: true,
        managed: true,
        loaded: true,
        enabled: true,
        hasInstallRecord: true,
        install: {
          source: "path",
          sourcePath: "/tmp/extensions/path-plugin",
          installedAt: "2026-04-07T00:00:00Z",
        },
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
        actions: ["status", "uninstall"],
      }),
    ).toBe("/tmp/extensions/path-plugin");

    expect(
      resolvePluginInstallSourceDetail({
        id: "npm-plugin",
        name: "Npm Plugin",
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
        installOptions: {
          npmSpec: "@fased/npm-plugin",
        },
        actions: ["status", "install"],
      }),
    ).toBe("@fased/npm-plugin");
  });

  it("summarizes operational state for managed plugins that still need runtime reload", () => {
    const lines = summarizePluginOperationalState({
      id: "managed-plugin",
      name: "Managed Plugin",
      status: "disabled",
      discovered: true,
      managed: true,
      loaded: false,
      enabled: true,
      hasInstallRecord: true,
      install: {
        source: "path",
        sourcePath: "/tmp/extensions/managed-plugin",
        installedAt: "2026-04-07T00:00:00Z",
      },
      channels: ["discord"],
      providers: ["openrouter"],
      toolNames: ["search"],
      hookNames: ["before-send"],
      gatewayMethods: ["plugins.managed"],
      cliCommands: [],
      services: [],
      commands: [],
      httpHandlers: 1,
      hookCount: 1,
      installOptions: {},
      actions: ["status", "update", "uninstall"],
    });

    expect(lines).toContain(
      "Plugin is configured and enabled, but the active runtime still needs a reload to pick it up.",
    );
    expect(lines).toContain(
      "Linked from a local path, so updates come from the checked-out source tree.",
    );
    expect(lines).toContain("Exposes 1 provider surface that may need auth and model routing.");
    expect(lines).toContain("Exposes 1 channel surface that show up in Channels.");
    expect(lines).toContain(
      "Adds runtime control surfaces across 1 tools, 1 gateway methods, 1 hooks.",
    );
  });

  it("builds configuration notes for docs and provider-managed plugins", () => {
    const notes = buildPluginConfigurationNotes({
      id: "docs-plugin",
      name: "Docs Plugin",
      status: "loaded",
      discovered: true,
      managed: true,
      loaded: true,
      enabled: true,
      hasInstallRecord: true,
      install: {
        source: "npm",
        spec: "@fased/docs-plugin",
        installedAt: "2026-04-07T00:00:00Z",
      },
      channels: ["discord"],
      providers: ["openrouter"],
      toolNames: ["search"],
      hookNames: [],
      gatewayMethods: ["plugins.docs"],
      cliCommands: [],
      services: [],
      commands: [],
      httpHandlers: 0,
      hookCount: 0,
      channelCatalog: {
        id: "docs",
        label: "Docs",
        selectionLabel: "Docs",
        docsPath: "docs/plugins/docs-plugin.md",
        docsLabel: "Plugin docs",
        blurb: "Docs plugin",
      },
      installOptions: {
        npmSpec: "@fased/docs-plugin",
      },
      actions: ["status", "update", "uninstall"],
    });

    expect(notes.map((note) => note.label)).toEqual([
      "Install path",
      "Restart behavior",
      "Plugin docs",
      "Provider config",
      "Channel setup",
      "Gateway surface",
      "Tools and hooks",
    ]);
    expect(notes[0]?.detail).toBe("@fased/docs-plugin");
    expect(notes.map((note) => note.detail).join(" ")).not.toContain("Config →");
    expect(notes.map((note) => note.detail).join(" ")).toContain("Agent > Tools");
  });

  it("summarizes diagnostics counts and prefers the first error as the primary note", () => {
    const overview = summarizePluginDiagnosticsOverview(
      [
        { level: "warn", message: "Global warning" },
        { level: "error", message: "Other plugin failure", pluginId: "other-plugin" },
        { level: "warn", message: "Selected warning", pluginId: "demo-plugin" },
        { level: "error", message: "Selected error", pluginId: "demo-plugin" },
      ],
      "demo-plugin",
    );

    expect(overview).toEqual({
      warnings: 1,
      errors: 1,
      primary: "Selected error",
    });
  });

  it("summarizes runtime helper grants and filters denied helper diagnostics", () => {
    const entry: PluginMarketplaceEntry = {
      id: "helper-plugin",
      name: "Helper Plugin",
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
      runtimeHelpers: {
        sessions: {
          read: true,
        },
        adminRpcActions: {
          sourceKeys: ["origin:workspace"],
          methods: [
            {
              method: "push.test",
              granted: true,
              effective: true,
              sources: ["origin:workspace"],
              requireOperatorApproval: true,
            },
            {
              method: "chat.inject",
              granted: false,
              effective: false,
              sources: [],
              requireOperatorApproval: false,
              reason: "missing-runtime-admin-rpc-grant",
            },
          ],
        },
      },
      installOptions: {},
      actions: ["status"],
    };
    const diagnostics = [
      { level: "warn" as const, message: "Global warning" },
      {
        level: "warn" as const,
        pluginId: "helper-plugin",
        message:
          "runtime session helper denied: helper=sessions.list reason=missing runtime.helpers.sessions.read grant",
      },
      {
        level: "warn" as const,
        pluginId: "other-plugin",
        message: "runtime session helper denied: helper=sessions.list reason=other",
      },
      {
        level: "warn" as const,
        pluginId: "helper-plugin",
        message: "runtime admin RPC denied: method=push.test reason=rate-limit-exceeded",
      },
    ];

    expect(filterPluginRuntimeHelperDiagnostics(diagnostics, "helper-plugin")).toHaveLength(1);
    expect(filterPluginAdminRpcDiagnostics(diagnostics, "helper-plugin")).toHaveLength(1);
    expect(summarizePluginRuntimeHelpers(entry, diagnostics)).toMatchObject({
      sessionsRead: true,
      adminRpcGranted: 1,
      deniedDiagnostics: [
        expect.objectContaining({
          pluginId: "helper-plugin",
        }),
      ],
      adminRpcDiagnostics: [
        expect.objectContaining({
          pluginId: "helper-plugin",
        }),
      ],
    });
  });

  it("shows restart remediation when a plugin mutation requires runtime reload", () => {
    const entry: PluginMarketplaceEntry = {
      id: "demo-plugin",
      name: "Demo Plugin",
      status: "loaded",
      discovered: true,
      managed: true,
      loaded: true,
      enabled: true,
      hasInstallRecord: true,
      channels: ["discord"],
      providers: ["openrouter"],
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
    };
    const remediation = {
      pluginId: "demo-plugin",
      action: "update" as const,
      requiresRestart: true,
      message: "Updated plugin: demo-plugin",
      warnings: [],
    };

    expect(shouldShowPluginRestartAction(entry, remediation)).toBe(true);
    expect(buildPluginRemediationState(entry, [], remediation)).toEqual({
      severity: "warn",
      title: "Restart required",
      detail:
        "Updated plugin: demo-plugin Restart the gateway runtime to make this plugin change live.",
    });
    expect(buildPluginRemediationNotes(entry, [], remediation)).toContain(
      "Restart the gateway runtime once so install, update, or uninstall changes take effect.",
    );
    expect(buildPluginRemediationNotes(entry, [], remediation).join(" ")).toContain(
      "Providers and Agent > Models",
    );
    expect(buildPluginRemediationNotes(entry, [], remediation).join(" ")).not.toContain("Config →");
  });

  it("surfaces runtime failure remediation from live plugin diagnostics", () => {
    const entry: PluginMarketplaceEntry = {
      id: "broken-plugin",
      name: "Broken Plugin",
      status: "error",
      discovered: true,
      managed: true,
      loaded: false,
      enabled: true,
      hasInstallRecord: true,
      error: "Module load crashed",
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
    };

    expect(shouldShowPluginRestartAction(entry, null)).toBe(true);
    expect(buildPluginRemediationState(entry, [], null)).toEqual({
      severity: "danger",
      title: "Plugin failed to load",
      detail: "Module load crashed",
    });
    expect(buildPluginRemediationNotes(entry, [], null)).toContain(
      "If the plugin still fails after restart, review Install detail, Docs path, and the Diagnostics list below.",
    );
  });
});
