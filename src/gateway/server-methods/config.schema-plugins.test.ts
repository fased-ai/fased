import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
  type FasedAgentConfig,
} from "../../config/config.js";
import { clearPluginLoaderCache } from "../../plugins/loader.js";
import { clearPluginManifestRegistryCache } from "../../plugins/manifest-registry.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import {
  getActivePluginRegistry,
  getActivePluginRegistryKey,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { configHandlers } from "./config.js";

const prevBundledDir = process.env.FASED_BUNDLED_PLUGINS_DIR;
let tempRoot: string | null = null;

async function writeSchemaOnlyPlugin(root: string): Promise<void> {
  const pluginDir = root;
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "schema-demo.js"),
    `export default { id: "schema-demo", register() { throw new Error("schema load must not activate plugin"); } };`,
    "utf-8",
  );
  await fs.writeFile(
    path.join(pluginDir, "fased.plugin.json"),
    JSON.stringify(
      {
        id: "schema-demo",
        name: "Schema Demo",
        configSchema: {
          type: "object",
          properties: {
            token: { type: "string" },
          },
        },
      },
      null,
      2,
    ),
    "utf-8",
  );
}

async function callConfigSchema(): Promise<unknown> {
  const respond = vi.fn();
  await configHandlers["config.schema"]({
    params: {},
    respond: respond as never,
    context: {} as never,
    client: null,
    req: { type: "req", id: "req-1", method: "config.schema" },
    isWebchatConnect: () => false,
  });
  expect(respond).toHaveBeenCalledWith(true, expect.anything(), undefined);
  return respond.mock.calls[0]?.[1];
}

async function callConfigSchemaLookup(path: string): Promise<unknown> {
  const respond = vi.fn();
  await configHandlers["config.schema.lookup"]({
    params: { path },
    respond: respond as never,
    context: { logGateway: { warn: vi.fn() } } as never,
    client: null,
    req: { type: "req", id: "req-lookup", method: "config.schema.lookup" },
    isWebchatConnect: () => false,
  });
  expect(respond).toHaveBeenCalledWith(true, expect.anything(), undefined);
  return respond.mock.calls[0]?.[1];
}

describe("config.schema plugin metadata", () => {
  beforeEach(async () => {
    clearRuntimeConfigSnapshot();
    clearPluginLoaderCache();
    clearPluginManifestRegistryCache();
    resetPluginRuntimeStateForTest();
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "fased-config-schema-plugin-"));
    process.env.FASED_BUNDLED_PLUGINS_DIR = tempRoot;
    await writeSchemaOnlyPlugin(tempRoot);
    setRuntimeConfigSnapshot({
      plugins: {
        deny: ["schema-demo"],
      },
    } satisfies FasedAgentConfig);
  });

  afterEach(async () => {
    clearRuntimeConfigSnapshot();
    clearPluginLoaderCache();
    clearPluginManifestRegistryCache();
    resetPluginRuntimeStateForTest();
    if (prevBundledDir === undefined) {
      delete process.env.FASED_BUNDLED_PLUGINS_DIR;
    } else {
      process.env.FASED_BUNDLED_PLUGINS_DIR = prevBundledDir;
    }
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
      tempRoot = null;
    }
  });

  it("builds plugin schema metadata without replacing the active runtime registry", async () => {
    const activeRegistry = createEmptyPluginRegistry();
    setActivePluginRegistry(activeRegistry, "startup-registry");

    const schemaResponse = (await callConfigSchema()) as {
      schema?: { properties?: Record<string, unknown> };
      uiHints?: Record<string, unknown>;
    };

    const pluginsNode = schemaResponse.schema?.properties?.plugins as
      | { properties?: Record<string, unknown> }
      | undefined;
    const entriesNode = pluginsNode?.properties?.entries as
      | { properties?: Record<string, unknown> }
      | undefined;
    expect(entriesNode?.properties?.["schema-demo"]).toBeTruthy();
    expect(schemaResponse.uiHints?.["plugins.entries.schema-demo"]).toBeTruthy();
    expect(getActivePluginRegistry()).toBe(activeRegistry);
    expect(getActivePluginRegistryKey()).toBe("startup-registry");
  });

  it("looks up path-scoped config schema without returning the full tree", async () => {
    const result = (await callConfigSchemaLookup("gateway.auth")) as {
      path?: string;
      schema?: { properties?: unknown };
      children?: Array<{ key?: string; path?: string; required?: boolean; hintPath?: string }>;
    };

    expect(result.path).toBe("gateway.auth");
    expect(result.schema?.properties).toBeUndefined();
    expect(result.children).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "token",
          path: "gateway.auth.token",
          required: false,
          hintPath: "gateway.auth.token",
        }),
      ]),
    );
  });

  it("rejects unknown config schema lookup paths", async () => {
    const respond = vi.fn();
    await configHandlers["config.schema.lookup"]({
      params: { path: "gateway.nope" },
      respond: respond as never,
      context: { logGateway: { warn: vi.fn() } } as never,
      client: null,
      req: { type: "req", id: "req-missing", method: "config.schema.lookup" },
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "config schema path not found" }),
    );
  });
});
