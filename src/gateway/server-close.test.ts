import type { Server as HttpServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocketServer } from "ws";
import type { ChannelId } from "../channels/plugins/types.js";
import { createGatewayCloseHandler } from "./server-close.js";

const mocks = vi.hoisted(() => ({
  listChannelPlugins: vi.fn(() => [{ id: "telegram" }, { id: "discord" }]),
  stopGmailWatcher: vi.fn(async () => {}),
}));

vi.mock("../channels/plugins/index.js", () => ({
  listChannelPlugins: mocks.listChannelPlugins,
}));

vi.mock("../hooks/gmail-watcher.js", () => ({
  stopGmailWatcher: mocks.stopGmailWatcher,
}));

type CloseHandlerParams = Parameters<typeof createGatewayCloseHandler>[0];

function createCloseFixture(overrides: Partial<CloseHandlerParams> = {}, events: string[] = []) {
  const tickInterval = setInterval(() => {}, 60_000);
  const healthInterval = setInterval(() => {}, 60_000);
  const dedupeCleanup = setInterval(() => {}, 60_000);
  const params: CloseHandlerParams = {
    bonjourStop: null,
    tailscaleCleanup: null,
    canvasHost: null,
    canvasHostServer: null,
    stopChannel: async (name: ChannelId) => {
      events.push(`stopChannel:${name}`);
    },
    pluginServices: null,
    cron: {
      stop: () => {
        events.push("cron.stop");
      },
    },
    heartbeatRunner: {
      stop: () => {
        events.push("heartbeat.stop");
      },
      updateConfig: () => {},
    },
    nodePresenceTimers: new Map(),
    broadcast: (event, payload) => {
      events.push(`broadcast:${event}:${JSON.stringify(payload)}`);
    },
    tickInterval,
    healthInterval,
    dedupeCleanup,
    agentUnsub: null,
    heartbeatUnsub: null,
    chatRunState: {
      clear: () => {
        events.push("chat.clear");
      },
    },
    clients: new Set(),
    configReloader: {
      stop: async () => {
        events.push("configReloader.stop");
      },
    },
    browserControl: null,
    wss: {
      close: (cb: () => void) => {
        events.push("wss.close");
        cb();
      },
    } as unknown as WebSocketServer,
    httpServer: {
      closeIdleConnections: () => {
        events.push("http.closeIdleConnections");
      },
      close: (cb: (err?: Error) => void) => {
        events.push("http.close");
        cb();
      },
    } as unknown as HttpServer,
    ...overrides,
  };
  return {
    close: createGatewayCloseHandler(params),
    events,
    intervals: { tickInterval, healthInterval, dedupeCleanup },
    params,
  };
}

describe("createGatewayCloseHandler", () => {
  beforeEach(() => {
    mocks.listChannelPlugins.mockReturnValue([{ id: "telegram" }, { id: "discord" }]);
    mocks.stopGmailWatcher.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stops channel runtimes before plugin services and clears maintenance timers", async () => {
    const events: string[] = [];
    mocks.stopGmailWatcher.mockImplementation(async () => {
      events.push("gmail.stop");
    });
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const tickInterval = setInterval(() => {}, 60_000);
    const healthInterval = setInterval(() => {}, 60_000);
    const dedupeCleanup = setInterval(() => {}, 60_000);
    const presenceTimer = setInterval(() => {}, 60_000);
    const clients = new Set([
      {
        socket: {
          close: vi.fn((code: number, reason: string) => {
            events.push(`client.close:${code}:${reason}`);
          }),
        },
      },
    ]);
    const httpServer = {
      closeIdleConnections: vi.fn(() => {
        events.push("http.closeIdleConnections");
      }),
      close: vi.fn((cb: (err?: Error) => void) => {
        events.push("http.close");
        cb();
      }),
    } as unknown as HttpServer;
    const wss = {
      close: vi.fn((cb: () => void) => {
        events.push("wss.close");
        cb();
      }),
    } as unknown as WebSocketServer;
    const close = createGatewayCloseHandler({
      bonjourStop: async () => {
        events.push("bonjour.stop");
      },
      tailscaleCleanup: async () => {
        events.push("tailscale.cleanup");
      },
      canvasHost: {
        close: async () => {
          events.push("canvas.close");
        },
      } as never,
      canvasHostServer: {
        close: async () => {
          events.push("canvasServer.close");
        },
      } as never,
      stopChannel: async (name: ChannelId) => {
        events.push(`stopChannel:${name}`);
      },
      pluginServices: {
        stop: async () => {
          events.push("pluginServices.stop");
        },
      },
      cron: {
        stop: () => {
          events.push("cron.stop");
        },
      },
      heartbeatRunner: {
        stop: () => {
          events.push("heartbeat.stop");
        },
        updateConfig: () => {},
      },
      nodePresenceTimers: new Map([["mobile", presenceTimer]]),
      broadcast: (event, payload) => {
        events.push(`broadcast:${event}:${JSON.stringify(payload)}`);
      },
      tickInterval,
      healthInterval,
      dedupeCleanup,
      agentUnsub: () => {
        events.push("agent.unsub");
      },
      heartbeatUnsub: () => {
        events.push("heartbeat.unsub");
      },
      chatRunState: {
        clear: () => {
          events.push("chat.clear");
        },
      },
      clients,
      configReloader: {
        stop: async () => {
          events.push("configReloader.stop");
        },
      },
      browserControl: {
        stop: async () => {
          events.push("browserControl.stop");
        },
      },
      wss,
      httpServer,
      onClose: [
        () => {
          events.push("onClose");
        },
      ],
    });

    await close({ reason: "test shutdown", restartExpectedMs: 250 });

    expect(events).toEqual([
      "bonjour.stop",
      "tailscale.cleanup",
      "onClose",
      "canvas.close",
      "canvasServer.close",
      "stopChannel:telegram",
      "stopChannel:discord",
      "pluginServices.stop",
      "gmail.stop",
      "cron.stop",
      "heartbeat.stop",
      'broadcast:shutdown:{"reason":"test shutdown","restartExpectedMs":250}',
      "agent.unsub",
      "heartbeat.unsub",
      "chat.clear",
      "client.close:1012:service restart",
      "configReloader.stop",
      "browserControl.stop",
      "wss.close",
      "http.closeIdleConnections",
      "http.close",
    ]);
    expect(clearIntervalSpy).toHaveBeenCalledWith(tickInterval);
    expect(clearIntervalSpy).toHaveBeenCalledWith(healthInterval);
    expect(clearIntervalSpy).toHaveBeenCalledWith(dedupeCleanup);
    expect(clearIntervalSpy).toHaveBeenCalledWith(presenceTimer);
    expect(clients.size).toBe(0);
  });

  it("resolves with undefined under the current Promise<void> close contract", async () => {
    const { close } = createCloseFixture();

    await expect(close({ reason: "contract check" })).resolves.toBeUndefined();
  });

  it("rejects HTTP close errors instead of returning structured shutdown warnings", async () => {
    const events: string[] = [];
    const closeError = new Error("http close failed");
    const { close } = createCloseFixture(
      {
        httpServer: {
          closeIdleConnections: () => {
            events.push("http.closeIdleConnections");
          },
          close: (cb: (err?: Error) => void) => {
            events.push("http.close");
            cb(closeError);
          },
        } as unknown as HttpServer,
      },
      events,
    );

    await expect(close({ reason: "http failure" })).rejects.toThrow("http close failed");
    expect(events).toContain("wss.close");
    expect(events).toContain("http.closeIdleConnections");
    expect(events).toContain("http.close");
  });

  it("does not apply an HTTP close timeout before a shutdown result contract exists", async () => {
    vi.useFakeTimers();
    let resolveHttpClose: (() => void) | null = null;
    const { close } = createCloseFixture({
      httpServer: {
        closeIdleConnections: vi.fn(),
        close: (cb: (err?: Error) => void) => {
          resolveHttpClose = () => cb();
        },
      } as unknown as HttpServer,
    });

    const closePromise = close({ reason: "hung http close audit" });
    let settled = false;
    void closePromise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await vi.advanceTimersByTimeAsync(10_000);

    expect(settled).toBe(false);
    expect(resolveHttpClose).toBeTypeOf("function");
    (resolveHttpClose as unknown as () => void)();
    await expect(closePromise).resolves.toBeUndefined();
  });
});
