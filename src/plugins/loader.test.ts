import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { withEnv } from "../test-utils/env.js";
import { __testing, clearPluginLoaderCache, loadFasedAgentPlugins } from "./loader.js";
import { writePluginReadinessReceipt } from "./readiness-receipt.js";
import { createPluginRuntime } from "./runtime/index.js";

type TempPlugin = { dir: string; file: string; id: string };

const fixtureRoot = path.join(os.tmpdir(), `fased-plugin-${randomUUID()}`);
let tempDirIndex = 0;
const prevBundledDir = process.env.FASED_BUNDLED_PLUGINS_DIR;
const EMPTY_PLUGIN_SCHEMA = { type: "object", additionalProperties: false, properties: {} };
const BUNDLED_TELEGRAM_PLUGIN_BODY = `export default { id: "telegram", register(api) {
  api.registerChannel({
    plugin: {
      id: "telegram",
      meta: {
        id: "telegram",
        label: "Telegram",
        selectionLabel: "Telegram",
        docsPath: "/channels/telegram",
        blurb: "telegram channel"
      },
      capabilities: { chatTypes: ["direct"] },
      config: {
        listAccountIds: () => [],
        resolveAccount: () => ({ accountId: "default" })
      },
      outbound: { deliveryMode: "direct" }
    }
  });
} };`;

it("keeps every signed mandatory managed plugin enabled with an explicit allowlist", () => {
  const root = makeTempDir();
  const lockPath = path.join(root, "plugin.lock.json");
  fs.writeFileSync(
    lockPath,
    `${JSON.stringify({
      schemaVersion: 1,
      type: "fased-plugin-lock",
      entries: [
        {
          id: "fixture-transaction-plugin",
          origin: "store",
          digest: `sha256:${"d".repeat(64)}`,
          apiCapability: "fased.plugin.v1",
          required: true,
        },
        {
          id: "optional-core",
          origin: "bundled",
          digest: `sha256:${"a".repeat(64)}`,
          apiCapability: "fased.plugin.v1",
          required: false,
        },
        {
          id: "sat-mining",
          origin: "bundled",
          digest: `sha256:${"b".repeat(64)}`,
          apiCapability: "fased.plugin.v1",
          required: true,
        },
        {
          id: "stable-bridge",
          origin: "store",
          digest: `sha256:${"c".repeat(64)}`,
          apiCapability: "fased.plugin.v1",
          required: true,
        },
      ],
    })}\n`,
  );
  const normalized = __testing.applyManagedRequiredAllowlist(
    {
      enabled: true,
      allow: ["stable-bridge"],
      deny: [],
      loadPaths: [],
      slots: { memory: "memory-core" },
      entries: {},
    },
    { FASED_PLUGIN_LOCK_PATH: lockPath },
  );
  expect(normalized.allow).toEqual(["fixture-transaction-plugin", "sat-mining", "stable-bridge"]);
});

function makeTempDir() {
  const dir = path.join(fixtureRoot, `case-${tempDirIndex++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writePlugin(params: {
  id: string;
  body: string;
  dir?: string;
  filename?: string;
}): TempPlugin {
  const dir = params.dir ?? makeTempDir();
  const filename = params.filename ?? `${params.id}.js`;
  const file = path.join(dir, filename);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, params.body, "utf-8");
  fs.writeFileSync(
    path.join(dir, "fased.plugin.json"),
    JSON.stringify(
      {
        id: params.id,
        configSchema: EMPTY_PLUGIN_SCHEMA,
      },
      null,
      2,
    ),
    "utf-8",
  );
  return { dir, file, id: params.id };
}

function loadBundledMemoryPluginRegistry(options?: {
  packageMeta?: { name: string; version: string; description?: string };
  pluginBody?: string;
  pluginFilename?: string;
}) {
  const bundledDir = makeTempDir();
  let pluginDir = bundledDir;
  let pluginFilename = options?.pluginFilename ?? "memory-core.js";

  if (options?.packageMeta) {
    pluginDir = path.join(bundledDir, "memory-core");
    pluginFilename = "index.js";
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify(
        {
          name: options.packageMeta.name,
          version: options.packageMeta.version,
          description: options.packageMeta.description,
          fased: { extensions: ["./index.js"] },
        },
        null,
        2,
      ),
      "utf-8",
    );
  }

  writePlugin({
    id: "memory-core",
    body:
      options?.pluginBody ?? `export default { id: "memory-core", kind: "memory", register() {} };`,
    dir: pluginDir,
    filename: pluginFilename,
  });
  process.env.FASED_BUNDLED_PLUGINS_DIR = bundledDir;

  return loadFasedAgentPlugins({
    cache: false,
    config: {
      plugins: {
        slots: {
          memory: "memory-core",
        },
      },
    },
  });
}

function setupBundledTelegramPlugin() {
  const bundledDir = makeTempDir();
  writePlugin({
    id: "telegram",
    body: BUNDLED_TELEGRAM_PLUGIN_BODY,
    dir: bundledDir,
    filename: "telegram.js",
  });
  process.env.FASED_BUNDLED_PLUGINS_DIR = bundledDir;
}

function expectTelegramLoaded(registry: ReturnType<typeof loadFasedAgentPlugins>) {
  const telegram = registry.plugins.find((entry) => entry.id === "telegram");
  expect(telegram?.status).toBe("loaded");
  expect(registry.channels.some((entry) => entry.plugin.id === "telegram")).toBe(true);
}

function pluginStatus(registry: ReturnType<typeof loadFasedAgentPlugins>, id: string) {
  return registry.plugins.find((entry) => entry.id === id)?.status;
}

function pluginError(registry: ReturnType<typeof loadFasedAgentPlugins>, id: string) {
  return registry.plugins.find((entry) => entry.id === id)?.error;
}

afterEach(() => {
  clearPluginLoaderCache();
  if (prevBundledDir === undefined) {
    delete process.env.FASED_BUNDLED_PLUGINS_DIR;
  } else {
    process.env.FASED_BUNDLED_PLUGINS_DIR = prevBundledDir;
  }
});

afterAll(() => {
  try {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  } catch {
    // ignore cleanup failures
  }
});

describe("loadFasedAgentPlugins", () => {
  it("rejects an optional managed digest that exports multiple plugin identities", () => {
    const root = makeTempDir();
    const codeRoot = path.join(root, "plugin-code");
    const dataRoot = path.join(root, "plugin-data");
    const digest = `sha256:${"e".repeat(64)}`;
    const digestRoot = path.join(codeRoot, digest.slice("sha256:".length));
    const lockPath = path.join(root, "plugin.lock.json");
    const outputPath = path.join(root, "plugin-readiness.json");
    for (const id of ["optional", "rogue"]) {
      const pluginRoot = path.join(digestRoot, id);
      fs.mkdirSync(pluginRoot, { recursive: true });
      fs.writeFileSync(
        path.join(pluginRoot, "fased.plugin.json"),
        JSON.stringify({ id, configSchema: EMPTY_PLUGIN_SCHEMA }),
      );
      fs.writeFileSync(
        path.join(pluginRoot, "index.js"),
        `export default { id: "${id}", register() { throw new Error("must not activate"); } };`,
      );
    }
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        schemaVersion: 1,
        type: "fased-plugin-lock",
        entries: [
          {
            id: "optional",
            origin: "store",
            digest,
            apiCapability: "fased.plugin.v1",
            required: false,
          },
        ],
      }),
    );

    withEnv(
      {
        FASED_BUNDLED_PLUGINS_DIR: "/nonexistent/bundled/plugins",
        FASED_PLUGIN_CODE_ROOT: codeRoot,
        FASED_PLUGIN_DATA_ROOT: dataRoot,
        FASED_PLUGIN_LOCK_PATH: lockPath,
      },
      () => {
        const registry = loadFasedAgentPlugins({
          cache: false,
          config: { plugins: { allow: ["optional"], entries: { optional: { enabled: true } } } },
        });
        expect(registry.plugins).toHaveLength(0);
        expect(registry.diagnostics).toContainEqual(
          expect.objectContaining({
            level: "error",
            message: expect.stringContaining(
              'lock entry "optional" must expose exactly one runtime plugin (found 2)',
            ),
          }),
        );
        expect(() =>
          writePluginReadinessReceipt({
            registry,
            lockPath,
            outputPath,
            generationId: `sha256:${"a".repeat(64)}`,
          }),
        ).toThrow(/managed plugin identity rejected/);
      },
    );
    expect(fs.existsSync(outputPath)).toBe(false);
  });

  it("rejects an optional managed digest whose loaded export changes its approved identity", () => {
    const root = makeTempDir();
    const codeRoot = path.join(root, "plugin-code");
    const dataRoot = path.join(root, "plugin-data");
    const digest = `sha256:${"f".repeat(64)}`;
    const pluginRoot = path.join(codeRoot, digest.slice("sha256:".length), "optional");
    const lockPath = path.join(root, "plugin.lock.json");
    const outputPath = path.join(root, "plugin-readiness.json");
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, "fased.plugin.json"),
      JSON.stringify({ id: "optional", configSchema: EMPTY_PLUGIN_SCHEMA }),
    );
    fs.writeFileSync(
      path.join(pluginRoot, "index.js"),
      `export default { id: "rogue", register() { throw new Error("must not activate"); } };`,
    );
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        schemaVersion: 1,
        type: "fased-plugin-lock",
        entries: [
          {
            id: "optional",
            origin: "store",
            digest,
            apiCapability: "fased.plugin.v1",
            required: false,
          },
        ],
      }),
    );

    withEnv(
      {
        FASED_BUNDLED_PLUGINS_DIR: "/nonexistent/bundled/plugins",
        FASED_PLUGIN_CODE_ROOT: codeRoot,
        FASED_PLUGIN_DATA_ROOT: dataRoot,
        FASED_PLUGIN_LOCK_PATH: lockPath,
      },
      () => {
        const registry = loadFasedAgentPlugins({
          cache: false,
          config: { plugins: { allow: ["optional"], entries: { optional: { enabled: true } } } },
        });
        expect(registry.plugins).toHaveLength(1);
        expect(registry.plugins[0]).toEqual(
          expect.objectContaining({
            id: "optional",
            status: "error",
            error: 'managed plugin identity rejected: lock entry "optional" exports "rogue"',
          }),
        );
        expect(registry.channels).toHaveLength(0);
        expect(registry.diagnostics).toContainEqual(
          expect.objectContaining({
            level: "error",
            message: 'managed plugin identity rejected: lock entry "optional" exports "rogue"',
          }),
        );
        expect(() =>
          writePluginReadinessReceipt({
            registry,
            lockPath,
            outputPath,
            generationId: `sha256:${"a".repeat(64)}`,
          }),
        ).toThrow(/managed plugin identity rejected/);
      },
    );
    expect(fs.existsSync(outputPath)).toBe(false);
  });

  it("rejects readiness when the same plugin id switches digest before receipt", () => {
    const root = makeTempDir();
    const codeRoot = path.join(root, "plugin-code");
    const dataRoot = path.join(root, "plugin-data");
    const lockPath = path.join(root, "plugin.lock.json");
    const outputPath = path.join(root, "plugin-readiness.json");
    const digestA = `sha256:${"a".repeat(64)}`;
    const digestB = `sha256:${"b".repeat(64)}`;

    for (const digest of [digestA, digestB]) {
      const pluginRoot = path.join(codeRoot, digest.slice("sha256:".length));
      fs.mkdirSync(pluginRoot, { recursive: true });
      fs.writeFileSync(
        path.join(pluginRoot, "fased.plugin.json"),
        JSON.stringify({ id: "race-plugin", configSchema: EMPTY_PLUGIN_SCHEMA }),
      );
      fs.writeFileSync(
        path.join(pluginRoot, "index.js"),
        'export default { id: "race-plugin", register() {} };',
        "utf-8",
      );
    }
    fs.mkdirSync(dataRoot, { recursive: true });
    const lock = (digest: string) => ({
      schemaVersion: 1,
      type: "fased-plugin-lock",
      entries: [
        {
          id: "race-plugin",
          origin: "store",
          digest,
          apiCapability: "fased.plugin.v1",
          required: true,
        },
      ],
    });
    fs.writeFileSync(lockPath, `${JSON.stringify(lock(digestB))}\n`, "utf-8");

    withEnv(
      {
        FASED_BUNDLED_PLUGINS_DIR: "/nonexistent/bundled/plugins",
        FASED_PLUGIN_CODE_ROOT: codeRoot,
        FASED_PLUGIN_DATA_ROOT: dataRoot,
        FASED_PLUGIN_LOCK_PATH: lockPath,
      },
      () => {
        const registry = loadFasedAgentPlugins({
          cache: false,
          config: {
            plugins: {
              allow: ["race-plugin"],
              entries: { "race-plugin": { enabled: true } },
            },
          },
        });
        expect(pluginStatus(registry, "race-plugin")).toBe("loaded");

        fs.writeFileSync(lockPath, `${JSON.stringify(lock(digestA))}\n`, "utf-8");
        expect(() =>
          writePluginReadinessReceipt({
            registry,
            lockPath,
            outputPath,
            generationId: `sha256:${"c".repeat(64)}`,
          }),
        ).toThrow(/lock changed after plugin load/);
      },
    );
    expect(fs.existsSync(outputPath)).toBe(false);
  });

  it("disables bundled plugins by default", () => {
    const bundledDir = makeTempDir();
    writePlugin({
      id: "bundled",
      body: `export default { id: "bundled", register() {} };`,
      dir: bundledDir,
      filename: "bundled.js",
    });
    process.env.FASED_BUNDLED_PLUGINS_DIR = bundledDir;

    const registry = loadFasedAgentPlugins({
      cache: false,
      config: {
        plugins: {
          allow: ["bundled"],
        },
      },
    });

    const bundled = registry.plugins.find((entry) => entry.id === "bundled");
    expect(bundled?.status).toBe("disabled");

    const enabledRegistry = loadFasedAgentPlugins({
      cache: false,
      config: {
        plugins: {
          allow: ["bundled"],
          entries: {
            bundled: { enabled: true },
          },
        },
      },
    });

    const enabled = enabledRegistry.plugins.find((entry) => entry.id === "bundled");
    expect(enabled?.status).toBe("loaded");
  });

  it("loads bundled telegram plugin when enabled", () => {
    setupBundledTelegramPlugin();

    const registry = loadFasedAgentPlugins({
      cache: false,
      config: {
        plugins: {
          allow: ["telegram"],
          entries: {
            telegram: { enabled: true },
          },
        },
      },
    });

    expectTelegramLoaded(registry);
  });

  it("loads legacy FasedAgent plugins through the plugin-sdk compatibility alias", () => {
    const bundledDir = makeTempDir();
    const pluginDir = path.join(bundledDir, "fased-plugin-yuanbao");
    fs.mkdirSync(path.join(pluginDir, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify(
        {
          name: "fased-plugin-yuanbao",
          version: "2.11.0",
          type: "module",
          main: "./dist/index.js",
        },
        null,
        2,
      ),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pluginDir, "fased.plugin.json"),
      JSON.stringify(
        {
          id: "fased-plugin-yuanbao",
          configSchema: EMPTY_PLUGIN_SCHEMA,
        },
        null,
        2,
      ),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pluginDir, "dist", "index.js"),
      [
        'import { DEFAULT_ACCOUNT_ID } from "fased/plugin-sdk/account-id";',
        'export default { id: "fased-plugin-yuanbao", register(api) { api.logger.info(DEFAULT_ACCOUNT_ID); } };',
      ].join("\n"),
      "utf-8",
    );
    process.env.FASED_BUNDLED_PLUGINS_DIR = bundledDir;

    const registry = loadFasedAgentPlugins({
      cache: false,
      config: {
        plugins: {
          allow: ["fased-plugin-yuanbao"],
          entries: {
            "fased-plugin-yuanbao": { enabled: true },
          },
        },
      },
    });

    const record = registry.plugins.find((entry) => entry.id === "fased-plugin-yuanbao");
    expect(record?.status).toBe("loaded");
    expect(record?.error).toBeUndefined();
  });

  it("loads bundled channel plugins when channels.<id>.enabled=true", () => {
    setupBundledTelegramPlugin();

    const registry = loadFasedAgentPlugins({
      cache: false,
      config: {
        channels: {
          telegram: {
            enabled: true,
          },
        },
        plugins: {
          enabled: true,
        },
      },
    });

    expectTelegramLoaded(registry);
  });

  it("still respects explicit disable via plugins.entries for bundled channels", () => {
    setupBundledTelegramPlugin();

    const registry = loadFasedAgentPlugins({
      cache: false,
      config: {
        channels: {
          telegram: {
            enabled: true,
          },
        },
        plugins: {
          entries: {
            telegram: { enabled: false },
          },
        },
      },
    });

    const telegram = registry.plugins.find((entry) => entry.id === "telegram");
    expect(telegram?.status).toBe("disabled");
    expect(telegram?.error).toBe("disabled in config");
  });

  it("enables bundled memory plugin when selected by slot", () => {
    const registry = loadBundledMemoryPluginRegistry();

    const memory = registry.plugins.find((entry) => entry.id === "memory-core");
    expect(memory?.status).toBe("loaded");
  });

  it("preserves package.json metadata for bundled memory plugins", () => {
    const registry = loadBundledMemoryPluginRegistry({
      packageMeta: {
        name: "@fased/memory-core",
        version: "1.2.3",
        description: "Memory plugin package",
      },
      pluginBody:
        'export default { id: "memory-core", kind: "memory", name: "Memory (Core)", register() {} };',
    });

    const memory = registry.plugins.find((entry) => entry.id === "memory-core");
    expect(memory?.status).toBe("loaded");
    expect(memory?.origin).toBe("bundled");
    expect(memory?.name).toBe("Memory (Core)");
    expect(memory?.version).toBe("1.2.3");
  });
  it("loads plugins from config paths", () => {
    process.env.FASED_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
    const plugin = writePlugin({
      id: "allowed",
      body: `export default { id: "allowed", register(api) { api.registerGatewayMethod("allowed.ping", ({ respond }) => respond(true, { ok: true }), { scope: "operator.read" }); } };`,
    });

    const registry = loadFasedAgentPlugins({
      cache: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["allowed"],
        },
      },
    });

    const loaded = registry.plugins.find((entry) => entry.id === "allowed");
    expect(loaded?.status).toBe("loaded");
    expect(Object.keys(registry.gatewayHandlers)).toContain("allowed.ping");
    expect(registry.gatewayMethodScopes["allowed.ping"]).toBe("operator.read");
  });

  it("scopes read-only session runtime helpers through the real plugin loader", () => {
    process.env.FASED_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
    const globals = globalThis as typeof globalThis & {
      __fasedSessionHelperSmoke?: {
        allowed?: {
          list?: unknown;
          get?: unknown;
        };
        denied?: {
          error?: string;
        };
      };
    };
    delete globals.__fasedSessionHelperSmoke;

    const storePath = path.join(makeTempDir(), "sessions.json");
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        "agent:main:telegram:dm:alice": {
          sessionId: "secret-session-id",
          sessionFile: "secret-transcript.jsonl",
          updatedAt: 123,
          displayName: "Alice",
          channel: "telegram",
          chatType: "direct",
          origin: {
            label: "Alice",
            from: "alice-private-id",
            to: "bot-private-id",
            accountId: "account-private-id",
          },
          lastTo: "alice-private-id",
          lastAccountId: "account-private-id",
          lastChannel: "telegram",
          modelProvider: "openrouter",
          model: "openai/gpt-4.1-mini",
          totalTokens: 42,
          totalTokensFresh: true,
        },
      }),
      "utf-8",
    );

    const allowed = writePlugin({
      id: "session-reader",
      body: `export default { id: "session-reader", register(api) {
        globalThis.__fasedSessionHelperSmoke ??= {};
        globalThis.__fasedSessionHelperSmoke.allowed = {
          list: api.runtime.helpers.sessions.list({ limit: 5 }),
          get: api.runtime.helpers.sessions.get({ key: "agent:main:telegram:dm:alice" })
        };
      } };`,
    });
    const denied = writePlugin({
      id: "session-denied",
      body: `export default { id: "session-denied", register(api) {
        globalThis.__fasedSessionHelperSmoke ??= {};
        try {
          api.runtime.helpers.sessions.list({ limit: 5 });
        } catch (err) {
          globalThis.__fasedSessionHelperSmoke.denied = {
            error: err instanceof Error ? err.message : String(err)
          };
        }
      } };`,
    });

    const registry = loadFasedAgentPlugins({
      cache: false,
      workspaceDir: allowed.dir,
      config: {
        session: { store: storePath },
        plugins: {
          load: { paths: [allowed.file, denied.file] },
          allow: ["session-reader", "session-denied"],
          entries: {
            "session-reader": {
              enabled: true,
              runtime: { helpers: { sessions: { read: true } } },
            },
            "session-denied": {
              enabled: true,
              runtime: { helpers: { sessions: { read: false } } },
            },
          },
        },
      },
    });

    expect(pluginStatus(registry, "session-reader")).toBe("loaded");
    expect(pluginStatus(registry, "session-denied")).toBe("loaded");
    const sessionSmoke = (
      globals as unknown as typeof globalThis & {
        __fasedSessionHelperSmoke?: {
          allowed?: { list?: unknown; get?: unknown };
          denied?: { error?: string };
        };
      }
    ).__fasedSessionHelperSmoke;
    const allowedList = sessionSmoke?.allowed?.list as
      | { count?: number; sessions?: Array<Record<string, unknown>> }
      | undefined;
    const allowedGet = sessionSmoke?.allowed?.get as Record<string, unknown> | undefined;
    expect(allowedList?.count).toBe(1);
    expect(allowedList?.sessions?.[0]).toMatchObject({
      key: "agent:main:telegram:dm:alice",
      displayName: "Alice",
      channel: "telegram",
      chatType: "direct",
      updatedAt: 123,
      lastChannel: "telegram",
      modelProvider: "openrouter",
      model: "openai/gpt-4.1-mini",
      totalTokens: 42,
      totalTokensFresh: true,
    });
    expect(allowedList?.sessions?.[0]).not.toHaveProperty("sessionId");
    expect(allowedList?.sessions?.[0]).not.toHaveProperty("sessionFile");
    expect(allowedList?.sessions?.[0]).not.toHaveProperty("origin");
    expect(allowedList?.sessions?.[0]).not.toHaveProperty("lastTo");
    expect(allowedList?.sessions?.[0]).not.toHaveProperty("lastAccountId");
    expect(allowedGet).toMatchObject({
      key: "agent:main:telegram:dm:alice",
      updatedAt: 123,
    });
    expect(sessionSmoke?.denied?.error).toContain("not enabled for plugin: session-denied");
    expect(
      registry.diagnostics.some(
        (diag) =>
          diag.pluginId === "session-denied" &&
          diag.message.includes("runtime session helper denied") &&
          diag.message.includes("helper=sessions.list") &&
          diag.message.includes("missing runtime.helpers.sessions.read grant"),
      ),
    ).toBe(true);
    expect(() =>
      createPluginRuntime({
        config: { session: { store: storePath } },
      }).helpers.sessions.list(),
    ).toThrow(/trusted plugin id/);

    delete globals.__fasedSessionHelperSmoke;
  });

  it("scopes fixed admin RPC helpers through the real plugin loader", async () => {
    process.env.FASED_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
    const globals = globalThis as typeof globalThis & {
      __fasedAdminRpcHelperSmoke?: {
        run?: (call: unknown) => Promise<unknown>;
      };
    };
    delete globals.__fasedAdminRpcHelperSmoke;

    const plugin = writePlugin({
      id: "admin-helper",
      body: `export default { id: "admin-helper", register(api) {
        globalThis.__fasedAdminRpcHelperSmoke = {
          run: (call) => api.runtime.helpers.adminRpc.pushTest({ nodeId: "ios-node", title: "secret title", body: "secret body" }, call)
        };
      } };`,
    });
    const handler = vi.fn(async ({ respond }) => {
      respond(true, {
        ok: true,
        status: 200,
        environment: "sandbox",
        tokenSuffix: "1234",
        topic: "com.fased.test",
      });
    });
    const logGateway = {
      info: vi.fn(),
      warn: vi.fn(),
    };

    const registry = loadFasedAgentPlugins({
      cache: false,
      workspaceDir: plugin.dir,
      coreGatewayHandlers: {
        "push.test": handler,
      },
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["admin-helper"],
          entries: {
            "admin-helper": {
              enabled: true,
              runtime: {
                adminRpcActions: {
                  allow: [
                    {
                      method: "push.test",
                      sources: ["origin:config"],
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

    expect(pluginStatus(registry, "admin-helper")).toBe("loaded");
    const adminSmoke = (
      globals as unknown as typeof globalThis & {
        __fasedAdminRpcHelperSmoke?: {
          run?: (call: unknown) => Promise<unknown>;
        };
      }
    ).__fasedAdminRpcHelperSmoke;
    await expect(
      adminSmoke?.run?.({
        context: { logGateway },
        client: {
          connId: "conn-admin-helper",
          clientIp: "127.0.0.1",
          connect: {
            role: "operator",
            scopes: ["operator.write"],
            client: { id: "operator" },
            device: { id: "device" },
          },
        },
      }),
    ).resolves.toEqual({
      ok: true,
      status: 200,
      environment: "sandbox",
      tokenSuffix: "1234",
      topic: "com.fased.test",
    });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        req: expect.objectContaining({
          method: "push.test",
          params: { nodeId: "ios-node", title: "secret title", body: "secret body" },
        }),
        params: { nodeId: "ios-node", title: "secret title", body: "secret body" },
      }),
    );
    expect(logGateway.info).toHaveBeenCalledWith(expect.stringContaining("method=push.test"));
    expect(logGateway.info.mock.calls.join("\n")).not.toContain("secret body");

    delete globals.__fasedAdminRpcHelperSmoke;
  });

  it("coerces plugin gateway methods in reserved admin namespaces to admin scope", () => {
    process.env.FASED_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
    const plugin = writePlugin({
      id: "reserved-gateway",
      body: `export default { id: "reserved-gateway", register(api) { api.registerGatewayMethod("config.pluginRead", ({ respond }) => respond(true, { ok: true }), { scope: "operator.read" }); } };`,
    });

    const registry = loadFasedAgentPlugins({
      cache: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["reserved-gateway"],
        },
      },
    });

    const loaded = registry.plugins.find((entry) => entry.id === "reserved-gateway");
    expect(loaded?.status).toBe("loaded");
    expect(Object.keys(registry.gatewayHandlers)).toContain("config.pluginRead");
    expect(registry.gatewayMethodScopes["config.pluginRead"]).toBe("operator.admin");
    expect(
      registry.diagnostics.some(
        (diag) =>
          diag.pluginId === "reserved-gateway" &&
          diag.message.includes("coerced to operator.admin"),
      ),
    ).toBe(true);
  });

  it("does not reuse cached registry when core gateway methods change", () => {
    process.env.FASED_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
    const plugin = writePlugin({
      id: "core-method-cache",
      body: `export default { id: "core-method-cache", register(api) { api.registerGatewayMethod("conflict.ping", ({ respond }) => respond(true, { ok: true }), { scope: "operator.read" }); } };`,
    });
    const config = {
      plugins: {
        load: { paths: [plugin.file] },
        allow: ["core-method-cache"],
      },
    };

    const first = loadFasedAgentPlugins({ config });
    const second = loadFasedAgentPlugins({
      config,
      coreGatewayHandlers: {
        "conflict.ping": ({ respond }) => respond(true, { ok: true }),
      },
    });

    expect(Object.keys(first.gatewayHandlers)).toContain("conflict.ping");
    expect(Object.keys(second.gatewayHandlers)).not.toContain("conflict.ping");
    expect(
      second.diagnostics.some(
        (diag) =>
          diag.pluginId === "core-method-cache" &&
          diag.message.includes("gateway method already registered: conflict.ping"),
      ),
    ).toBe(true);
  });

  it("does not reuse cached registry when plugins.allow changes", () => {
    process.env.FASED_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
    const pluginA = writePlugin({
      id: "allow-a",
      body: `export default { id: "allow-a", register() {} };`,
    });
    const pluginB = writePlugin({
      id: "allow-b",
      body: `export default { id: "allow-b", register() {} };`,
    });

    const first = loadFasedAgentPlugins({
      config: {
        plugins: {
          load: { paths: [pluginA.file, pluginB.file] },
          allow: ["allow-a"],
        },
      },
    });
    const second = loadFasedAgentPlugins({
      config: {
        plugins: {
          load: { paths: [pluginA.file, pluginB.file] },
          allow: ["allow-b"],
        },
      },
    });

    expect(pluginStatus(first, "allow-a")).toBe("loaded");
    expect(pluginStatus(first, "allow-b")).toBe("disabled");
    expect(pluginStatus(second, "allow-a")).toBe("disabled");
    expect(pluginStatus(second, "allow-b")).toBe("loaded");
  });

  it("does not reuse cached registry when plugins.deny changes", () => {
    process.env.FASED_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
    const plugin = writePlugin({
      id: "deny-flip",
      body: `export default { id: "deny-flip", register() {} };`,
    });

    const first = loadFasedAgentPlugins({
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["deny-flip"],
        },
      },
    });
    const second = loadFasedAgentPlugins({
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["deny-flip"],
          deny: ["deny-flip"],
        },
      },
    });

    expect(pluginStatus(first, "deny-flip")).toBe("loaded");
    expect(pluginStatus(second, "deny-flip")).toBe("disabled");
    expect(pluginError(second, "deny-flip")).toBe("blocked by denylist");
  });

  it("does not reuse cached registry when plugins.entries changes", () => {
    process.env.FASED_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
    const plugin = writePlugin({
      id: "entry-flip",
      body: `export default { id: "entry-flip", register() {} };`,
    });

    const first = loadFasedAgentPlugins({
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["entry-flip"],
          entries: {
            "entry-flip": { enabled: false },
          },
        },
      },
    });
    const second = loadFasedAgentPlugins({
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["entry-flip"],
          entries: {
            "entry-flip": { enabled: true },
          },
        },
      },
    });

    expect(pluginStatus(first, "entry-flip")).toBe("disabled");
    expect(pluginError(first, "entry-flip")).toBe("disabled in config");
    expect(pluginStatus(second, "entry-flip")).toBe("loaded");
  });

  it("does not reuse cached registry when plugins.slots.memory changes", () => {
    process.env.FASED_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
    const memoryA = writePlugin({
      id: "memory-cache-a",
      body: `export default { id: "memory-cache-a", kind: "memory", register() {} };`,
    });
    const memoryB = writePlugin({
      id: "memory-cache-b",
      body: `export default { id: "memory-cache-b", kind: "memory", register() {} };`,
    });

    const first = loadFasedAgentPlugins({
      config: {
        plugins: {
          load: { paths: [memoryA.file, memoryB.file] },
          slots: { memory: "memory-cache-a" },
        },
      },
    });
    const second = loadFasedAgentPlugins({
      config: {
        plugins: {
          load: { paths: [memoryA.file, memoryB.file] },
          slots: { memory: "memory-cache-b" },
        },
      },
    });

    expect(pluginStatus(first, "memory-cache-a")).toBe("loaded");
    expect(pluginStatus(first, "memory-cache-b")).toBe("disabled");
    expect(pluginStatus(second, "memory-cache-a")).toBe("disabled");
    expect(pluginStatus(second, "memory-cache-b")).toBe("loaded");
  });

  it("does not reuse cached registry when plugins.load.paths changes", () => {
    process.env.FASED_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
    const pluginA = writePlugin({
      id: "load-path-a",
      body: `export default { id: "load-path-a", register() {} };`,
    });
    const pluginB = writePlugin({
      id: "load-path-b",
      body: `export default { id: "load-path-b", register() {} };`,
    });

    const first = loadFasedAgentPlugins({
      config: {
        plugins: {
          load: { paths: [pluginA.file] },
          allow: ["load-path-a"],
        },
      },
    });
    const second = loadFasedAgentPlugins({
      config: {
        plugins: {
          load: { paths: [pluginB.file] },
          allow: ["load-path-b"],
        },
      },
    });

    expect(pluginStatus(first, "load-path-a")).toBe("loaded");
    expect(pluginStatus(first, "load-path-b")).toBeUndefined();
    expect(pluginStatus(second, "load-path-a")).toBeUndefined();
    expect(pluginStatus(second, "load-path-b")).toBe("loaded");
  });

  it("does not reuse cached registry when workspaceDir changes", () => {
    process.env.FASED_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
    const workspaceA = makeTempDir();
    const workspaceB = makeTempDir();
    const pluginA = writePlugin({
      id: "workspace-a",
      body: `export default { id: "workspace-a", register() {} };`,
      dir: path.join(workspaceA, ".fased", "extensions", "workspace-a"),
      filename: "index.js",
    });
    const pluginB = writePlugin({
      id: "workspace-b",
      body: `export default { id: "workspace-b", register() {} };`,
      dir: path.join(workspaceB, ".fased", "extensions", "workspace-b"),
      filename: "index.js",
    });

    const first = loadFasedAgentPlugins({
      workspaceDir: workspaceA,
      config: {
        plugins: {
          allow: [pluginA.id],
        },
      },
    });
    const second = loadFasedAgentPlugins({
      workspaceDir: workspaceB,
      config: {
        plugins: {
          allow: [pluginB.id],
        },
      },
    });

    expect(pluginStatus(first, pluginA.id)).toBe("loaded");
    expect(pluginStatus(first, pluginB.id)).toBeUndefined();
    expect(pluginStatus(second, pluginA.id)).toBeUndefined();
    expect(pluginStatus(second, pluginB.id)).toBe("loaded");
  });

  it("loads plugins when source and root differ only by realpath alias", () => {
    process.env.FASED_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
    const plugin = writePlugin({
      id: "alias-safe",
      body: `export default { id: "alias-safe", register() {} };`,
    });
    const realRoot = fs.realpathSync(plugin.dir);
    if (realRoot === plugin.dir) {
      return;
    }

    const registry = loadFasedAgentPlugins({
      cache: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["alias-safe"],
        },
      },
    });

    const loaded = registry.plugins.find((entry) => entry.id === "alias-safe");
    expect(loaded?.status).toBe("loaded");
  });

  it("denylist disables plugins even if allowed", () => {
    process.env.FASED_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
    const plugin = writePlugin({
      id: "blocked",
      body: `export default { id: "blocked", register() {} };`,
    });

    const registry = loadFasedAgentPlugins({
      cache: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["blocked"],
          deny: ["blocked"],
        },
      },
    });

    const blocked = registry.plugins.find((entry) => entry.id === "blocked");
    expect(blocked?.status).toBe("disabled");
  });

  it("fails fast on invalid plugin config", () => {
    process.env.FASED_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
    const plugin = writePlugin({
      id: "configurable",
      body: `export default { id: "configurable", register() {} };`,
    });

    const registry = loadFasedAgentPlugins({
      cache: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          entries: {
            configurable: {
              config: "nope" as unknown as Record<string, unknown>,
            },
          },
        },
      },
    });

    const configurable = registry.plugins.find((entry) => entry.id === "configurable");
    expect(configurable?.status).toBe("error");
    expect(registry.diagnostics.some((d) => d.level === "error")).toBe(true);
  });

  it("accepts empty object plugin config without schema compilation", () => {
    process.env.FASED_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
    const plugin = writePlugin({
      id: "empty-config",
      body: `export default { id: "empty-config", register() {} };`,
    });

    const registry = loadFasedAgentPlugins({
      cache: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          entries: {
            "empty-config": {
              config: {},
            },
          },
        },
      },
    });

    const loaded = registry.plugins.find((entry) => entry.id === "empty-config");
    expect(loaded?.status).toBe("loaded");
  });

  it("rejects non-empty config for empty plugin config schemas", () => {
    process.env.FASED_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
    const plugin = writePlugin({
      id: "extra-config",
      body: `export default { id: "extra-config", register() {} };`,
    });

    const registry = loadFasedAgentPlugins({
      cache: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          entries: {
            "extra-config": {
              config: { extra: true },
            },
          },
        },
      },
    });

    const rejected = registry.plugins.find((entry) => entry.id === "extra-config");
    expect(rejected?.status).toBe("error");
    expect(rejected?.error).toContain("config must be empty");
  });

  it("registers channel plugins", () => {
    process.env.FASED_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
    const plugin = writePlugin({
      id: "channel-demo",
      body: `export default { id: "channel-demo", register(api) {
  api.registerChannel({
    plugin: {
      id: "demo",
      meta: {
        id: "demo",
        label: "Demo",
        selectionLabel: "Demo",
        docsPath: "/channels/demo",
        blurb: "demo channel"
      },
      capabilities: { chatTypes: ["direct"] },
      config: {
        listAccountIds: () => [],
        resolveAccount: () => ({ accountId: "default" })
      },
      outbound: { deliveryMode: "direct" }
    }
  });
} };`,
    });

    const registry = loadFasedAgentPlugins({
      cache: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["channel-demo"],
        },
      },
    });

    const channel = registry.channels.find((entry) => entry.plugin.id === "demo");
    expect(channel).toBeDefined();
  });

  it("registers http handlers", () => {
    process.env.FASED_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
    const plugin = writePlugin({
      id: "http-demo",
      body: `export default { id: "http-demo", register(api) {
  api.registerHttpHandler(async () => false);
} };`,
    });

    const registry = loadFasedAgentPlugins({
      cache: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["http-demo"],
        },
      },
    });

    const handler = registry.httpHandlers.find((entry) => entry.pluginId === "http-demo");
    expect(handler).toBeDefined();
    const httpPlugin = registry.plugins.find((entry) => entry.id === "http-demo");
    expect(httpPlugin?.httpHandlers).toBe(1);
  });

  it("registers http routes", () => {
    process.env.FASED_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
    const plugin = writePlugin({
      id: "http-route-demo",
      body: `export default { id: "http-route-demo", register(api) {
  api.registerHttpRoute({ path: "/demo", handler: async (_req, res) => { res.statusCode = 200; res.end("ok"); } });
} };`,
    });

    const registry = loadFasedAgentPlugins({
      cache: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["http-route-demo"],
        },
      },
    });

    const route = registry.httpRoutes.find((entry) => entry.pluginId === "http-route-demo");
    expect(route).toBeDefined();
    expect(route?.path).toBe("/demo");
    const httpPlugin = registry.plugins.find((entry) => entry.id === "http-route-demo");
    expect(httpPlugin?.httpHandlers).toBe(1);
  });

  it("respects explicit disable in config", () => {
    process.env.FASED_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
    const plugin = writePlugin({
      id: "config-disable",
      body: `export default { id: "config-disable", register() {} };`,
    });

    const registry = loadFasedAgentPlugins({
      cache: false,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          entries: {
            "config-disable": { enabled: false },
          },
        },
      },
    });

    const disabled = registry.plugins.find((entry) => entry.id === "config-disable");
    expect(disabled?.status).toBe("disabled");
  });

  it("enforces memory slot selection", () => {
    process.env.FASED_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
    const memoryA = writePlugin({
      id: "memory-a",
      body: `export default { id: "memory-a", kind: "memory", register() {} };`,
    });
    const memoryB = writePlugin({
      id: "memory-b",
      body: `export default { id: "memory-b", kind: "memory", register() {} };`,
    });

    const registry = loadFasedAgentPlugins({
      cache: false,
      config: {
        plugins: {
          load: { paths: [memoryA.file, memoryB.file] },
          slots: { memory: "memory-b" },
        },
      },
    });

    const a = registry.plugins.find((entry) => entry.id === "memory-a");
    const b = registry.plugins.find((entry) => entry.id === "memory-b");
    expect(b?.status).toBe("loaded");
    expect(a?.status).toBe("disabled");
  });

  it("disables memory plugins when slot is none", () => {
    process.env.FASED_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
    const memory = writePlugin({
      id: "memory-off",
      body: `export default { id: "memory-off", kind: "memory", register() {} };`,
    });

    const registry = loadFasedAgentPlugins({
      cache: false,
      config: {
        plugins: {
          load: { paths: [memory.file] },
          slots: { memory: "none" },
        },
      },
    });

    const entry = registry.plugins.find((item) => item.id === "memory-off");
    expect(entry?.status).toBe("disabled");
  });

  it("loads the higher-precedence plugin and rejects the duplicate id", () => {
    const bundledDir = makeTempDir();
    writePlugin({
      id: "shadow",
      body: `export default { id: "shadow", register() {} };`,
      dir: bundledDir,
      filename: "shadow.js",
    });
    process.env.FASED_BUNDLED_PLUGINS_DIR = bundledDir;

    const override = writePlugin({
      id: "shadow",
      body: `export default { id: "shadow", register() {} };`,
    });

    const registry = loadFasedAgentPlugins({
      cache: false,
      config: {
        plugins: {
          load: { paths: [override.file] },
          entries: {
            shadow: { enabled: true },
          },
        },
      },
    });

    const entries = registry.plugins.filter((entry) => entry.id === "shadow");
    const loaded = entries.find((entry) => entry.status === "loaded");
    expect(entries).toHaveLength(1);
    expect(loaded?.origin).toBe("config");
    expect(registry.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "error",
        pluginId: "shadow",
        source: path.join(bundledDir, "shadow.js"),
        message: expect.stringContaining("duplicate plugin id rejected"),
      }),
    );
  });
  it("warns when plugins.allow is empty and non-bundled plugins are discoverable", () => {
    process.env.FASED_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
    const plugin = writePlugin({
      id: "warn-open-allow",
      body: `export default { id: "warn-open-allow", register() {} };`,
    });
    const warnings: string[] = [];
    loadFasedAgentPlugins({
      cache: false,
      logger: {
        info: () => {},
        warn: (msg) => warnings.push(msg),
        error: () => {},
      },
      config: {
        plugins: {
          load: { paths: [plugin.file] },
        },
      },
    });
    expect(
      warnings.some((msg) => msg.includes("plugins.allow is empty") && msg.includes(plugin.id)),
    ).toBe(true);
  });

  it("warns when loaded non-bundled plugin has no install/load-path provenance", () => {
    process.env.FASED_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
    const stateDir = makeTempDir();
    withEnv({ FASED_STATE_DIR: stateDir }, () => {
      const globalDir = path.join(stateDir, "extensions", "rogue");
      fs.mkdirSync(globalDir, { recursive: true });
      writePlugin({
        id: "rogue",
        body: `export default { id: "rogue", register() {} };`,
        dir: globalDir,
        filename: "index.js",
      });

      const warnings: string[] = [];
      const registry = loadFasedAgentPlugins({
        cache: false,
        logger: {
          info: () => {},
          warn: (msg) => warnings.push(msg),
          error: () => {},
        },
        config: {
          plugins: {
            allow: ["rogue"],
          },
        },
      });

      const rogue = registry.plugins.find((entry) => entry.id === "rogue");
      expect(rogue?.status).toBe("loaded");
      expect(
        warnings.some(
          (msg) =>
            msg.includes("rogue") && msg.includes("loaded without install/load-path provenance"),
        ),
      ).toBe(true);
    });
  });

  it("rejects plugin entry files that escape plugin root via symlink", () => {
    process.env.FASED_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
    const pluginDir = makeTempDir();
    const outsideDir = makeTempDir();
    const outsideEntry = path.join(outsideDir, "outside.js");
    const linkedEntry = path.join(pluginDir, "entry.js");
    fs.writeFileSync(
      outsideEntry,
      'export default { id: "symlinked", register() { throw new Error("should not run"); } };',
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pluginDir, "fased.plugin.json"),
      JSON.stringify(
        {
          id: "symlinked",
          configSchema: EMPTY_PLUGIN_SCHEMA,
        },
        null,
        2,
      ),
      "utf-8",
    );
    try {
      fs.symlinkSync(outsideEntry, linkedEntry);
    } catch {
      return;
    }

    const registry = loadFasedAgentPlugins({
      cache: false,
      config: {
        plugins: {
          load: { paths: [linkedEntry] },
          allow: ["symlinked"],
        },
      },
    });

    const record = registry.plugins.find((entry) => entry.id === "symlinked");
    expect(record?.status).not.toBe("loaded");
    expect(registry.diagnostics.some((entry) => entry.message.includes("escapes"))).toBe(true);
  });

  it("rejects plugin entry files that escape plugin root via hardlink", () => {
    if (process.platform === "win32") {
      return;
    }
    process.env.FASED_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
    const pluginDir = makeTempDir();
    const outsideDir = makeTempDir();
    const outsideEntry = path.join(outsideDir, "outside.js");
    const linkedEntry = path.join(pluginDir, "entry.js");
    fs.writeFileSync(
      outsideEntry,
      'export default { id: "hardlinked", register() { throw new Error("should not run"); } };',
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pluginDir, "fased.plugin.json"),
      JSON.stringify(
        {
          id: "hardlinked",
          configSchema: EMPTY_PLUGIN_SCHEMA,
        },
        null,
        2,
      ),
      "utf-8",
    );
    try {
      fs.linkSync(outsideEntry, linkedEntry);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EXDEV") {
        return;
      }
      throw err;
    }

    const registry = loadFasedAgentPlugins({
      cache: false,
      config: {
        plugins: {
          load: { paths: [linkedEntry] },
          allow: ["hardlinked"],
        },
      },
    });

    const record = registry.plugins.find((entry) => entry.id === "hardlinked");
    expect(record?.status).not.toBe("loaded");
    expect(registry.diagnostics.some((entry) => entry.message.includes("escapes"))).toBe(true);
  });

  it("prefers dist plugin-sdk alias when loader runs from dist", () => {
    const root = makeTempDir();
    const srcFile = path.join(root, "src", "plugin-sdk", "index.ts");
    const distFile = path.join(root, "dist", "plugin-sdk", "index.js");
    fs.mkdirSync(path.dirname(srcFile), { recursive: true });
    fs.mkdirSync(path.dirname(distFile), { recursive: true });
    fs.writeFileSync(srcFile, "export {};\n", "utf-8");
    fs.writeFileSync(distFile, "export {};\n", "utf-8");

    const resolved = __testing.resolvePluginSdkAliasFile({
      srcFile: "index.ts",
      distFile: "index.js",
      modulePath: path.join(root, "dist", "plugins", "loader.js"),
    });
    expect(resolved).toBe(distFile);
  });

  it("exposes official channel dependencies to the core runtime", () => {
    const root = makeTempDir();
    const coreRoot = path.join(root, "core");
    const pluginRoot = path.join(root, "telegram");
    const dependencyRoot = path.join(pluginRoot, "node_modules", "grammy");
    fs.mkdirSync(path.join(coreRoot, "node_modules"), { recursive: true });
    fs.mkdirSync(dependencyRoot, { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, "package.json"),
      JSON.stringify({ name: "@fased/telegram", dependencies: { grammy: "1.0.0" } }),
      "utf-8",
    );

    __testing.repairOfficialChannelRuntimeDependencies({
      pluginId: "telegram",
      pluginRoot,
      coreRoot,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    const exposedDependency = path.join(coreRoot, "node_modules", "grammy");
    expect(fs.lstatSync(exposedDependency).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(exposedDependency)).toBe(fs.realpathSync(dependencyRoot));
  });

  it("prefers src plugin-sdk alias when loader runs from src in non-production", () => {
    const root = makeTempDir();
    const srcFile = path.join(root, "src", "plugin-sdk", "index.ts");
    const distFile = path.join(root, "dist", "plugin-sdk", "index.js");
    fs.mkdirSync(path.dirname(srcFile), { recursive: true });
    fs.mkdirSync(path.dirname(distFile), { recursive: true });
    fs.writeFileSync(srcFile, "export {};\n", "utf-8");
    fs.writeFileSync(distFile, "export {};\n", "utf-8");

    const resolved = withEnv({ NODE_ENV: undefined }, () =>
      __testing.resolvePluginSdkAliasFile({
        srcFile: "index.ts",
        distFile: "index.js",
        modulePath: path.join(root, "src", "plugins", "loader.ts"),
      }),
    );
    expect(resolved).toBe(srcFile);
  });
});
