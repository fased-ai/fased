import { describe, expect, it, vi } from "vitest";
import type { ConfigFileSnapshot, FasedAgentConfig } from "../config/config.js";
import type { PreparedSecretsRuntimeSnapshot } from "../secrets/runtime.js";
import { createGatewaySecretsRuntimeController } from "./server-secrets-runtime.js";

function configSnapshot(
  config: FasedAgentConfig,
  revision: string,
  options?: { exists?: boolean; valid?: boolean },
): ConfigFileSnapshot {
  const exists = options?.exists ?? true;
  const valid = options?.valid ?? true;
  return {
    path: "/tmp/fased-test-config.json",
    exists,
    raw: exists ? JSON.stringify(config) : null,
    parsed: config,
    resolved: config,
    valid,
    config,
    hash: revision,
    issues: valid ? [] : [{ path: "gateway", message: "invalid sentinel detail" }],
    warnings: [],
    legacyIssues: [],
  };
}

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createHarness(params: {
  initialDisk: ConfigFileSnapshot;
  prepareSnapshot?: (params: {
    config: FasedAgentConfig;
  }) => Promise<PreparedSecretsRuntimeSnapshot>;
  onReadConfigSnapshot?: (readNumber: number) => void | Promise<void>;
}) {
  let disk = params.initialDisk;
  let readNumber = 0;
  let active: PreparedSecretsRuntimeSnapshot | null = null;
  const logs: string[] = [];
  const transitions: string[] = [];
  const defaultPrepare = async ({ config }: { config: FasedAgentConfig }) => ({
    sourceConfig: structuredClone(config),
    config: structuredClone(config),
    authStores: [],
    warnings: [],
  });
  const controller = createGatewaySecretsRuntimeController({
    readConfigSnapshot: async () => {
      const captured = structuredClone(disk);
      await params.onReadConfigSnapshot?.(++readNumber);
      return captured;
    },
    log: {
      info: (message) => logs.push(message),
      warn: (message) => logs.push(message),
    },
    prepareSnapshot: params.prepareSnapshot ?? defaultPrepare,
    activateSnapshot: (snapshot) => {
      active = structuredClone(snapshot);
    },
    getActiveSnapshot: () => (active ? structuredClone(active) : null),
    clearSnapshot: () => {
      active = null;
    },
    emitTransition: (code) => transitions.push(code),
  });
  return {
    controller,
    getActive: () => active,
    logs,
    transitions,
    setDisk: (snapshot: ConfigFileSnapshot) => {
      disk = snapshot;
    },
  };
}

const CONFIG_A = {
  models: {
    providers: {
      openai: {
        baseUrl: "https://api.openai.com/v1",
        apiKey: "key-a",
        models: [],
      },
    },
  },
} satisfies FasedAgentConfig;

describe("gateway secrets runtime controller", () => {
  it("keeps last-known-good when manual reload finds a missing config", async () => {
    const startup = configSnapshot(CONFIG_A, "a");
    const harness = createHarness({ initialDisk: startup });
    await harness.controller.activateStartup(startup);

    harness.setDisk(configSnapshot({}, "missing", { exists: false }));
    await expect(harness.controller.reloadFromConfig()).rejects.toMatchObject({
      code: "SECRETS_CONFIG_MISSING",
    });
    expect(harness.getActive()?.sourceConfig).toEqual(CONFIG_A);

    await harness.controller.shutdown();
  });

  it("rejects restart-only source changes during manual reload", async () => {
    const configA = { gateway: { bind: "loopback" as const } };
    const configB = { gateway: { bind: "lan" as const } };
    const startup = configSnapshot(configA, "a");
    const harness = createHarness({ initialDisk: startup });
    await harness.controller.activateStartup(startup);

    harness.setDisk(configSnapshot(configB, "b"));
    await expect(harness.controller.reloadFromConfig()).rejects.toMatchObject({
      code: "SECRETS_SOURCE_RESTART_REQUIRED",
    });
    expect(harness.getActive()?.sourceConfig).toEqual(configA);

    await harness.controller.shutdown();
  });

  it("validates restart secrets without activating them in the old process", async () => {
    const configA = { gateway: { bind: "loopback" as const } };
    const configB = { gateway: { bind: "lan" as const } };
    const startup = configSnapshot(configA, "a");
    const restart = configSnapshot(configB, "b");
    const harness = createHarness({ initialDisk: startup });
    await harness.controller.activateStartup(startup);

    harness.setDisk(restart);
    await expect(harness.controller.validateRestart(restart)).resolves.toEqual({
      warningCount: 0,
    });
    expect(harness.getActive()?.sourceConfig).toEqual(configA);

    await harness.controller.shutdown();
  });

  it("rolls back the candidate snapshot when hot apply fails and sanitizes details", async () => {
    const configB = {
      ...CONFIG_A,
      hooks: { enabled: true, token: "hook-token" },
    } satisfies FasedAgentConfig;
    const startup = configSnapshot(CONFIG_A, "a");
    const hot = configSnapshot(configB, "b");
    const harness = createHarness({ initialDisk: startup });
    await harness.controller.activateStartup(startup);
    harness.setDisk(hot);

    let componentConfig = "old";
    const transaction = {
      apply: vi.fn(async () => {
        expect(harness.getActive()?.sourceConfig).toEqual(configB);
        componentConfig = "candidate";
        throw new Error("SENTINEL_SECRET_DETAIL");
      }),
      rollback: vi.fn(async (previousConfig: FasedAgentConfig) => {
        // Component rollback must run after the global snapshot is restored.
        expect(harness.getActive()?.sourceConfig).toEqual(CONFIG_A);
        expect(previousConfig).toEqual(CONFIG_A);
        componentConfig = "old";
      }),
    };
    const result = harness.controller.activateHotReload(hot, transaction);
    await expect(result).rejects.toMatchObject({
      code: "SECRETS_HOT_APPLY_FAILED",
      message: expect.not.stringContaining("SENTINEL_SECRET_DETAIL"),
    });
    expect(transaction.apply).toHaveBeenCalledTimes(1);
    expect(transaction.rollback).toHaveBeenCalledTimes(1);
    expect(componentConfig).toBe("old");
    expect(harness.getActive()?.sourceConfig).toEqual(CONFIG_A);
    expect(harness.logs.join("\n")).not.toContain("SENTINEL_SECRET_DETAIL");

    await harness.controller.shutdown();
  });

  it("drains close-vs-reload and cannot reactivate after shutdown", async () => {
    const gate = deferred();
    const prepareStarted = deferred();
    let blockReload = false;
    const startup = configSnapshot(CONFIG_A, "a");
    const harness = createHarness({
      initialDisk: startup,
      prepareSnapshot: async ({ config }) => {
        if (blockReload) {
          prepareStarted.resolve();
          await gate.promise;
        }
        return {
          sourceConfig: structuredClone(config),
          config: structuredClone(config),
          authStores: [],
          warnings: [],
        };
      },
    });
    await harness.controller.activateStartup(startup);

    blockReload = true;
    const reload = harness.controller.reloadFromConfig();
    await prepareStarted.promise;
    const shutdown = harness.controller.shutdown();
    gate.resolve();

    await expect(reload).rejects.toMatchObject({ code: "SECRETS_RUNTIME_CLOSED" });
    await shutdown;
    expect(harness.getActive()).toBeNull();
  });

  it("rejects a stale watcher generation and lets the newest manual revision win", async () => {
    const configB = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: "key-b",
            models: [],
          },
        },
      },
    } satisfies FasedAgentConfig;
    const configC = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: "key-c",
            models: [],
          },
        },
      },
    } satisfies FasedAgentConfig;
    const gate = deferred();
    const watcherPrepareStarted = deferred();
    let blockWatcher = false;
    const startup = configSnapshot(CONFIG_A, "a");
    const watcher = configSnapshot(configB, "b");
    const newest = configSnapshot(configC, "c");
    const harness = createHarness({
      initialDisk: startup,
      prepareSnapshot: async ({ config }) => {
        if (blockWatcher) {
          blockWatcher = false;
          watcherPrepareStarted.resolve();
          await gate.promise;
        }
        return {
          sourceConfig: structuredClone(config),
          config: structuredClone(config),
          authStores: [],
          warnings: [],
        };
      },
    });
    await harness.controller.activateStartup(startup);

    harness.setDisk(watcher);
    blockWatcher = true;
    const transaction = {
      apply: vi.fn(async () => {}),
      rollback: vi.fn(async () => {}),
    };
    const staleWatcher = harness.controller.activateHotReload(watcher, transaction);
    await watcherPrepareStarted.promise;

    harness.setDisk(newest);
    const newestReload = harness.controller.reloadFromConfig();
    gate.resolve();

    await expect(staleWatcher).rejects.toMatchObject({ code: "SECRETS_SOURCE_STALE" });
    await expect(newestReload).resolves.toEqual({ warningCount: 0 });
    expect(transaction.apply).not.toHaveBeenCalled();
    expect(transaction.rollback).not.toHaveBeenCalled();
    expect(harness.getActive()?.sourceConfig).toEqual(configC);

    await harness.controller.shutdown();
  });

  it("rolls back a hot apply when a newer generation starts during the final disk check", async () => {
    const configB = { ...CONFIG_A, hooks: { enabled: true, token: "candidate" } };
    const configC = {
      models: {
        providers: {
          openai: { ...CONFIG_A.models.providers.openai, apiKey: "key-newest" },
        },
      },
    };
    const startup = configSnapshot(CONFIG_A, "a");
    const hot = configSnapshot(configB, "b");
    const newest = configSnapshot(configC, "c");
    const finalReadStarted = deferred();
    const releaseFinalRead = deferred();
    const harness = createHarness({
      initialDisk: startup,
      onReadConfigSnapshot: async (readNumber) => {
        if (readNumber === 3) {
          finalReadStarted.resolve();
          await releaseFinalRead.promise;
        }
      },
    });
    await harness.controller.activateStartup(startup);
    harness.setDisk(hot);

    let componentConfig = "old";
    const transaction = {
      apply: vi.fn(async () => {
        componentConfig = "candidate";
      }),
      rollback: vi.fn(async () => {
        componentConfig = "old";
      }),
    };
    const staleHot = harness.controller.activateHotReload(hot, transaction);
    await finalReadStarted.promise;

    harness.setDisk(newest);
    const newestReload = harness.controller.reloadFromConfig();
    releaseFinalRead.resolve();

    await expect(staleHot).rejects.toMatchObject({ code: "SECRETS_SOURCE_STALE" });
    await expect(newestReload).resolves.toEqual({ warningCount: 0 });
    expect(transaction.rollback).toHaveBeenCalledTimes(1);
    expect(componentConfig).toBe("old");
    expect(harness.getActive()?.sourceConfig).toEqual(configC);

    await harness.controller.shutdown();
  });

  it("rejects restart validation made stale during its final disk check", async () => {
    const configB = { gateway: { bind: "lan" as const } };
    const configC = {
      models: {
        providers: {
          openai: {
            ...CONFIG_A.models.providers.openai,
            apiKey: "key-newest",
          },
        },
      },
    };
    const startup = configSnapshot(CONFIG_A, "a");
    const restart = configSnapshot(configB, "b");
    const newest = configSnapshot(configC, "c");
    const finalReadStarted = deferred();
    const releaseFinalRead = deferred();
    const harness = createHarness({
      initialDisk: startup,
      onReadConfigSnapshot: async (readNumber) => {
        if (readNumber === 2) {
          finalReadStarted.resolve();
          await releaseFinalRead.promise;
        }
      },
    });
    await harness.controller.activateStartup(startup);
    harness.setDisk(restart);

    const staleValidation = harness.controller.validateRestart(restart);
    await finalReadStarted.promise;
    harness.setDisk(newest);
    const newestReload = harness.controller.reloadFromConfig();
    releaseFinalRead.resolve();

    await expect(staleValidation).rejects.toMatchObject({ code: "SECRETS_SOURCE_STALE" });
    await expect(newestReload).resolves.toEqual({ warningCount: 0 });
    expect(harness.getActive()?.sourceConfig).toEqual(configC);

    await harness.controller.shutdown();
  });

  it("does not activate a manual reload made stale during its final disk check", async () => {
    const configB = {
      models: {
        providers: {
          openai: { ...CONFIG_A.models.providers.openai, apiKey: "key-candidate" },
        },
      },
    };
    const configC = {
      models: {
        providers: {
          openai: { ...CONFIG_A.models.providers.openai, apiKey: "key-newest" },
        },
      },
    };
    const startup = configSnapshot(CONFIG_A, "a");
    const candidate = configSnapshot(configB, "b");
    const newest = configSnapshot(configC, "c");
    const finalReadStarted = deferred();
    const releaseFinalRead = deferred();
    const harness = createHarness({
      initialDisk: startup,
      onReadConfigSnapshot: async (readNumber) => {
        if (readNumber === 2) {
          finalReadStarted.resolve();
          await releaseFinalRead.promise;
        }
      },
    });
    await harness.controller.activateStartup(startup);
    harness.setDisk(candidate);

    const staleReload = harness.controller.reloadFromConfig();
    await finalReadStarted.promise;
    harness.setDisk(newest);
    const newestReload = harness.controller.reloadFromConfig();
    releaseFinalRead.resolve();

    await expect(staleReload).rejects.toMatchObject({ code: "SECRETS_SOURCE_STALE" });
    await expect(newestReload).resolves.toEqual({ warningCount: 0 });
    expect(harness.getActive()?.sourceConfig).toEqual(configC);

    await harness.controller.shutdown();
  });
});
