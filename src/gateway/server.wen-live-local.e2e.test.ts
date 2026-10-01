import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import plugin from "../../extensions/wen/index.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import {
  connectReq,
  getFreePort,
  installGatewayTestHooks,
  rpcReq,
  setTestPluginRegistry,
  startGatewayServer,
  trackConnectChallengeNonce,
} from "./test-helpers.js";
installGatewayTestHooks({ scope: "suite" });
test.skipIf(process.env.FASED_WEN_LIVE_LOCAL !== "1")(
  "live local WEN/Devnet gateway read survives restart without signing",
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "wen-live-gateway-"));
    const pin = JSON.parse(await readFile(process.env.FASED_WEN_LIVE_PIN!, "utf8"));
    const profile = path.join(dir, "read.json");
    await writeFile(
      profile,
      JSON.stringify({ url: "http://127.0.0.1:3004/api/v1/economies/sat-v1/factsheet", pin }),
    );
    vi.stubEnv("FASED_WEN_LOCAL_READ_PROFILE", profile);
    const registry = createEmptyPluginRegistry();
    let service!: {
      start(c: { stateDir: string }): Promise<void>;
      stop(c: { stateDir: string }): Promise<void>;
    };
    plugin.register({
      registerGatewayMethod(
        name: string,
        handler: (typeof registry.gatewayHandlers)[string],
        opts?: { scope: "operator.admin" | "operator.read" },
      ) {
        registry.gatewayHandlers[name] = handler;
        if (opts) {
          registry.gatewayMethodScopes[name] = opts.scope;
        }
      },
      registerService(value: typeof service) {
        service = value;
      },
      registerTool() {},
      logger: { info() {}, warn() {} },
    } as never);
    setTestPluginRegistry(registry);
    const snapshots: unknown[] = [];
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        await service.start({ stateDir: dir });
        const port = await getFreePort();
        const server = await startGatewayServer(port);
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        trackConnectChallengeNonce(ws);
        try {
          await new Promise<void>((resolve, reject) => {
            ws.once("open", resolve);
            ws.once("error", reject);
          });
          expect((await connectReq(ws, { scopes: ["operator.read"] })).ok).toBe(true);
          const result = await rpcReq(ws, "wen.economy.read", {}, 60000);
          expect(result.ok, JSON.stringify(result)).toBe(true);
          const snapshot = result.payload as {
            identity: unknown;
            signingEnabled: boolean;
            rows: { id: string; status: string; value: unknown }[];
          };
          expect(snapshot.identity).toEqual(pin);
          expect(snapshot.signingEnabled).toBe(false);
          expect(snapshot.rows.find((r) => r.id === "issuedSupply")?.status).toBe("reported");
          expect(snapshot.rows.find((r) => r.id === "economicNav")?.status).toBe("unavailable");
          snapshots.push(snapshot);
        } finally {
          ws.close();
          await server.close();
          await service.stop({ stateDir: dir });
        }
      }
      if (process.env.FASED_WEN_LIVE_RECEIPT) {
        await writeFile(
          process.env.FASED_WEN_LIVE_RECEIPT,
          JSON.stringify(
            {
              status: "PASS_LIVE_GATEWAY_READ_RESTART",
              scope:
                "Current source gateway -> local WEN -> pinned Devnet, read-only; not installed Fased or financial action acceptance",
              snapshots,
            },
            null,
            2,
          ) + "\n",
        );
      }
    } finally {
      vi.unstubAllEnvs();
      await rm(dir, { recursive: true, force: true });
    }
  },
  120000,
);
