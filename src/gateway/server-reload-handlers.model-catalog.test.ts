import { describe, expect, it, vi } from "vitest";
import type { ChannelKind, GatewayReloadPlan } from "./config-reload.js";

const modelCatalog = vi.hoisted(() => ({
  markGatewayModelCatalogStaleForReload: vi.fn(),
}));

vi.mock("./server-model-catalog.js", () => ({
  markGatewayModelCatalogStaleForReload: modelCatalog.markGatewayModelCatalogStaleForReload,
}));

const { createGatewayReloadHandlers } = await import("./server-reload-handlers.js");

function createPlan(changedPaths: string[]): GatewayReloadPlan {
  return {
    changedPaths,
    restartGateway: false,
    restartReasons: [],
    hotReasons: changedPaths,
    reloadHooks: false,
    restartGmailWatcher: false,
    restartBrowserControl: false,
    restartCron: false,
    restartHeartbeat: false,
    restartChannels: new Set<ChannelKind>(),
    noopPaths: [],
  };
}

function createHandlers() {
  const state = {
    hooksConfig: null,
    heartbeatRunner: {
      stop: vi.fn(),
      updateConfig: vi.fn(),
    },
    cronState: {
      cron: {
        start: vi.fn(async () => {}),
        stop: vi.fn(),
      },
    },
    browserControl: null,
  };
  return createGatewayReloadHandlers({
    deps: {} as never,
    broadcast: vi.fn(),
    getState: () => state as never,
    setState: vi.fn(),
    startChannel: vi.fn(),
    stopChannel: vi.fn(),
    logHooks: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    logBrowser: { error: vi.fn() },
    logChannels: {
      info: vi.fn(),
      error: vi.fn(),
    },
    logCron: { error: vi.fn() },
    logReload: {
      info: vi.fn(),
      warn: vi.fn(),
    },
  });
}

describe("gateway reload model catalog invalidation", () => {
  it("marks the gateway model catalog stale when model config changes hot-reload", async () => {
    modelCatalog.markGatewayModelCatalogStaleForReload.mockClear();
    const handlers = createHandlers();

    await handlers.applyHotReload(
      createPlan(["models.providers.openai.models", "agents.defaults.model"]),
      {
        models: {
          providers: {
            openai: {
              models: [
                {
                  id: "gpt-5.5",
                  name: "gpt-5.5",
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                },
              ],
            },
          },
        },
      },
    );

    expect(modelCatalog.markGatewayModelCatalogStaleForReload).toHaveBeenCalledTimes(1);
  });

  it("does not mark the gateway model catalog stale for unrelated hot-reload paths", async () => {
    modelCatalog.markGatewayModelCatalogStaleForReload.mockClear();
    const handlers = createHandlers();

    await handlers.applyHotReload(createPlan(["hooks.gmail.account"]), {
      hooks: { enabled: true, token: "secret" },
    });

    expect(modelCatalog.markGatewayModelCatalogStaleForReload).not.toHaveBeenCalled();
  });
});
