import { describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { connectOk, getFreePort, installGatewayTestHooks, rpcReq } from "./test-helpers.js";

const sidecarControl = vi.hoisted(() => {
  let markStarted: (() => void) | undefined;
  let releaseSidecars: (() => void) | undefined;
  return {
    started: new Promise<void>((resolve) => {
      markStarted = resolve;
    }),
    release: new Promise<void>((resolve) => {
      releaseSidecars = resolve;
    }),
    markStarted: () => markStarted?.(),
    releaseSidecars: () => releaseSidecars?.(),
  };
});

vi.mock("./server-startup.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./server-startup.js")>();
  return {
    ...actual,
    startGatewaySidecars: vi.fn(async () => {
      sidecarControl.markStarted();
      await sidecarControl.release;
      return {
        browserControl: null,
        pluginServices: null,
        federationAutoConnect: null,
      };
    }),
  };
});

installGatewayTestHooks({ scope: "suite" });

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for ws open")), 10_000);
    const cleanup = () => {
      clearTimeout(timer);
      ws.off("open", onOpen);
      ws.off("error", onError);
      ws.off("close", onClose);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = (code: number, reason: Buffer) => {
      cleanup();
      reject(new Error(`closed ${code}: ${reason.toString()}`));
    };
    ws.once("open", onOpen);
    ws.once("error", onError);
    ws.once("close", onClose);
  });
}

describe("gateway startup RPC availability", () => {
  test("serves core read-only RPCs while sidecars are still starting", async () => {
    process.env.FASED_TEST_MINIMAL_GATEWAY = "0";
    process.env.FASED_SKIP_CHANNELS = "1";
    process.env.FASED_SKIP_PROVIDERS = "1";
    process.env.FASED_SKIP_BROWSER_CONTROL_SERVER = "1";
    process.env.FASED_SKIP_GMAIL_WATCHER = "1";

    const { startGatewayServer } = await import("./server.js");
    const port = await getFreePort();
    let serverResolved = false;
    const serverPromise = startGatewayServer(port, { controlUiEnabled: false }).then((server) => {
      serverResolved = true;
      return server;
    });

    let ws: WebSocket | null = null;
    try {
      await sidecarControl.started;
      expect(serverResolved).toBe(false);

      const startingReadiness = await fetch(`http://127.0.0.1:${port}/readyz`);
      expect(startingReadiness.status).toBe(503);
      await expect(startingReadiness.json()).resolves.toMatchObject({
        ok: true,
        status: "ready",
        ready: false,
        failing: ["startup"],
      });

      ws = new WebSocket(`ws://127.0.0.1:${port}`);
      await waitForOpen(ws);
      await connectOk(ws, { device: null });

      const status = await rpcReq<Record<string, unknown>>(ws, "status", {});
      expect(status.ok).toBe(true);
      expect(status.payload).toBeTruthy();
      expect(serverResolved).toBe(false);

      const health = await rpcReq<Record<string, unknown>>(ws, "health", {});
      expect(health.ok).toBe(true);
      expect(health.payload).toBeTruthy();
      expect(serverResolved).toBe(false);

      const modelCatalogStatus = await rpcReq<{
        totalModels?: number;
        totalProviders?: number;
        providerExtensionCatalog?: { totalEntries?: number };
      }>(ws, "models.catalog.status", {});
      expect(modelCatalogStatus.ok).toBe(true);
      expect(typeof modelCatalogStatus.payload?.totalModels).toBe("number");
      expect(typeof modelCatalogStatus.payload?.totalProviders).toBe("number");
      expect(typeof modelCatalogStatus.payload?.providerExtensionCatalog?.totalEntries).toBe(
        "number",
      );
      expect(serverResolved).toBe(false);

      const commands = await rpcReq<{ commands?: unknown[] }>(ws, "commands.list", {
        scope: "both",
        includeArgs: false,
      });
      expect(commands.ok).toBe(true);
      expect(Array.isArray(commands.payload?.commands)).toBe(true);
      expect(serverResolved).toBe(false);

      const history = await rpcReq<{ messages?: unknown[] }>(ws, "chat.history", {
        sessionKey: "main",
        limit: 1,
      });

      expect(history.ok).toBe(true);
      expect(history.payload?.messages).toEqual([]);
      expect(serverResolved).toBe(false);

      sidecarControl.releaseSidecars();
      await serverPromise;
      expect(serverResolved).toBe(true);

      const ready = await fetch(`http://127.0.0.1:${port}/readyz`);
      expect(ready.status).toBe(200);
      await expect(ready.json()).resolves.toMatchObject({
        ok: true,
        status: "ready",
        ready: true,
        failing: [],
      });
    } finally {
      ws?.close();
      sidecarControl.releaseSidecars();
      const server = await serverPromise;
      await server.close();
    }
  });
});
