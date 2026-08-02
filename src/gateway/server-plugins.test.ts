import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createEmptyPluginRegistry, type PluginRegistry } from "../plugins/registry.js";
import { readValidPluginStatusCache, writePluginStatusCache } from "../plugins/status-cache.js";
import type { PluginDiagnostic } from "../plugins/types.js";
import { finalizeGatewayPluginStatus, loadGatewayPlugins } from "./server-plugins.js";

const loadFasedAgentPlugins = vi.hoisted(() => vi.fn());
const preloadNativePluginModules = vi.hoisted(() => vi.fn(async () => new Map()));
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

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

  test("publishes readiness only after plugin startup configuration settles", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fased-plugin-ready-"));
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, "fased.json");
    const cachePath = path.join(directory, "runtime", "plugin-status.json");
    const registry = createRegistry([]);
    fs.writeFileSync(
      configPath,
      `${JSON.stringify({ plugins: { entries: { fixture: { enabled: false } } } })}\n`,
    );

    // This models the old behavior: a cache written before service startup is
    // invalid as soon as startup recovery changes plugin configuration.
    writePluginStatusCache({ configPath, cachePath, packageVersion: "1.2.3", registry });
    fs.writeFileSync(
      configPath,
      `${JSON.stringify({ plugins: { entries: { fixture: { enabled: true } } } })}\n`,
    );
    expect(
      readValidPluginStatusCache({ configPath, cachePath, packageVersion: "1.2.3" }),
    ).toBeNull();

    const log = { warn: vi.fn() };
    finalizeGatewayPluginStatus({
      registry,
      log,
      configPath,
      cachePath,
      packageVersion: "1.2.3",
    });

    expect(log.warn).not.toHaveBeenCalled();
    expect(
      readValidPluginStatusCache({ configPath, cachePath, packageVersion: "1.2.3" }),
    ).toMatchObject({ packageVersion: "1.2.3", plugins: [] });
  });
});
