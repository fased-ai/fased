import { describe, expect, test, vi } from "vitest";
import { createEmptyPluginRegistry, type PluginRegistry } from "../plugins/registry.js";
import type { PluginDiagnostic } from "../plugins/types.js";
import { loadGatewayPlugins } from "./server-plugins.js";

const loadFasedAgentPlugins = vi.hoisted(() => vi.fn());
const preloadNativePluginModules = vi.hoisted(() => vi.fn(async () => new Map()));

vi.mock("../plugins/loader.js", () => ({
  loadFasedAgentPlugins,
  preloadNativePluginModules,
}));

const createRegistry = (diagnostics: PluginDiagnostic[]): PluginRegistry => ({
  ...createEmptyPluginRegistry(),
  plugins: [],
  tools: [],
  hooks: [],
  typedHooks: [],
  channels: [],
  commands: [],
  providers: [],
  gatewayHandlers: {},
  gatewayMethodScopes: {},
  httpHandlers: [],
  httpRoutes: [],
  cliRegistrars: [],
  services: [],
  diagnostics,
});

describe("loadGatewayPlugins", () => {
  test("logs plugin errors with details", async () => {
    const diagnostics: PluginDiagnostic[] = [
      {
        level: "error",
        pluginId: "telegram",
        source: "/tmp/telegram/index.ts",
        message: "failed to load plugin: boom",
      },
    ];
    loadFasedAgentPlugins.mockReturnValue(createRegistry(diagnostics));

    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    await loadGatewayPlugins({
      cfg: {},
      workspaceDir: "/tmp",
      log,
      coreGatewayHandlers: {},
      baseMethods: [],
    });

    expect(log.error).toHaveBeenCalledWith(
      "[plugins] failed to load plugin: boom (plugin=telegram, source=/tmp/telegram/index.ts)",
    );
    expect(log.warn).not.toHaveBeenCalled();
  });
});
