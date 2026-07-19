import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ResolvedGatewayAuth } from "./auth.js";

vi.mock("https-proxy-agent", () => ({
  HttpsProxyAgent: class {},
}));

vi.mock("./call.js", () => ({
  callGateway: vi.fn(),
  callGatewayScoped: vi.fn(),
}));

import { callGatewayScoped } from "./call.js";
import { createGatewayHttpServer } from "./server-http.js";

async function withTempConfig(params: {
  cfg: unknown;
  walletRegistry?: unknown;
  run: () => Promise<void>;
}): Promise<void> {
  const prevConfigPath = process.env.FASED_CONFIG_PATH;
  const prevDisableCache = process.env.FASED_DISABLE_CONFIG_CACHE;
  const prevStateDir = process.env.FASED_STATE_DIR;
  const dir = await mkdtemp(path.join(os.tmpdir(), "fased-sat-mining-http-test-"));
  const configPath = path.join(dir, "fased.json");
  process.env.FASED_CONFIG_PATH = configPath;
  process.env.FASED_DISABLE_CONFIG_CACHE = "1";
  process.env.FASED_STATE_DIR = dir;
  try {
    await writeFile(configPath, JSON.stringify(params.cfg, null, 2), "utf-8");
    if (params.walletRegistry) {
      const walletDir = path.join(dir, "wallet");
      await mkdir(walletDir, { recursive: true });
      await writeFile(
        path.join(walletDir, "provider-registry.v1.json"),
        JSON.stringify(params.walletRegistry, null, 2),
        "utf-8",
      );
    }
    await params.run();
  } finally {
    if (prevConfigPath === undefined) {
      delete process.env.FASED_CONFIG_PATH;
    } else {
      process.env.FASED_CONFIG_PATH = prevConfigPath;
    }
    if (prevDisableCache === undefined) {
      delete process.env.FASED_DISABLE_CONFIG_CACHE;
    } else {
      process.env.FASED_DISABLE_CONFIG_CACHE = prevDisableCache;
    }
    if (prevStateDir === undefined) {
      delete process.env.FASED_STATE_DIR;
    } else {
      process.env.FASED_STATE_DIR = prevStateDir;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

function createRequest(params: {
  method?: string;
  path: string;
  host?: string;
  headers?: Record<string, string>;
  body?: unknown;
}): IncomingMessage {
  const req = new PassThrough() as unknown as IncomingMessage;
  req.method = params.method ?? "POST";
  req.url = params.path;
  req.headers = {
    host: params.host ?? "127.0.0.1:4321",
    ...params.headers,
  };
  (req as unknown as { socket: { remoteAddress: string } }).socket = {
    remoteAddress: "127.0.0.1",
  };
  queueMicrotask(() => {
    if (params.body != null) {
      (req as unknown as PassThrough).write(JSON.stringify(params.body));
    }
    (req as unknown as PassThrough).end();
  });
  return req;
}

function createResponse(): {
  res: ServerResponse;
  setHeader: ReturnType<typeof vi.fn>;
  getHeader: ReturnType<typeof vi.fn>;
  getBody: () => string;
} {
  let body = "";
  const headers = new Map<string, string | number | string[]>();
  const setHeader = vi.fn((name: string, value: string | number | readonly string[]) => {
    headers.set(
      name.toLowerCase(),
      typeof value === "string" || typeof value === "number" ? value : [...value],
    );
  });
  const getHeader = vi.fn((name: string) => headers.get(name.toLowerCase()));
  const res = {
    statusCode: 200,
    headersSent: false,
    setHeader,
    getHeader,
    end: vi.fn((chunk?: unknown) => {
      if (typeof chunk === "string") {
        body = chunk;
        return;
      }
      if (chunk instanceof Uint8Array) {
        body = Buffer.from(chunk).toString("utf8");
        return;
      }
      body = "";
    }),
  } as unknown as ServerResponse;
  return {
    res,
    setHeader,
    getHeader,
    getBody: () => body,
  };
}

async function dispatch(
  server: ReturnType<typeof createGatewayHttpServer>,
  req: IncomingMessage,
  res: ServerResponse,
) {
  server.emit("request", req, res);
  await new Promise((resolve) => setImmediate(resolve));
}

describe("SAT mining HTTP routes", () => {
  const resolvedAuth: ResolvedGatewayAuth = {
    mode: "token",
    token: "root-token",
    allowTailscale: false,
  };

  afterEach(() => {
    vi.clearAllMocks();
  });

  test("allows loopback browser preflight for local Control UI API calls", async () => {
    await withTempConfig({
      cfg: { gateway: { trustedProxies: [] } },
      run: async () => {
        const server = createGatewayHttpServer({
          canvasHost: null,
          clients: new Set(),
          controlUiEnabled: false,
          controlUiBasePath: "/ui",
          openAiChatCompletionsEnabled: false,
          openResponsesEnabled: false,
          handleHooksRequest: async () => false,
          resolvedAuth,
        });
        const response = createResponse();

        await dispatch(
          server,
          createRequest({
            method: "OPTIONS",
            path: "/api/mining/profile",
            headers: {
              origin: "http://127.0.0.1:63315",
              "access-control-request-method": "GET",
              "access-control-request-headers": "authorization",
            },
          }),
          response.res,
        );

        expect(response.res.statusCode).toBe(204);
        expect(response.setHeader).toHaveBeenCalledWith(
          "Access-Control-Allow-Origin",
          "http://127.0.0.1:63315",
        );
        expect(response.setHeader).toHaveBeenCalledWith("Access-Control-Allow-Credentials", "true");
        expect(callGatewayScoped).not.toHaveBeenCalled();
      },
    });
  });

  test("blocks mining capital changes when passkey mode is enabled but no passkey is enrolled", async () => {
    await withTempConfig({
      cfg: {
        gateway: { trustedProxies: [] },
        wallet: { approvalAuth: { mode: "webauthn" } },
      },
      run: async () => {
        const server = createGatewayHttpServer({
          canvasHost: null,
          clients: new Set(),
          controlUiEnabled: false,
          controlUiBasePath: "/ui",
          openAiChatCompletionsEnabled: false,
          openResponsesEnabled: false,
          handleHooksRequest: async () => false,
          resolvedAuth,
        });
        const response = createResponse();

        await dispatch(
          server,
          createRequest({
            path: "/api/mining/capital/commit",
            body: { lamports: "500000000" },
          }),
          response.res,
        );

        expect(response.res.statusCode).toBe(401);
        expect(JSON.parse(response.getBody())).toMatchObject({
          ok: false,
          error: { code: "wallet_control_passkey_not_ready" },
        });
        expect(callGatewayScoped).not.toHaveBeenCalled();
      },
    });
  });

  test("returns a structured error for commit failures instead of a plain 500", async () => {
    vi.mocked(callGatewayScoped).mockRejectedValueOnce(new Error("SAT signer unavailable on VPS"));

    await withTempConfig({
      cfg: { gateway: { trustedProxies: [] } },
      run: async () => {
        const server = createGatewayHttpServer({
          canvasHost: null,
          clients: new Set(),
          controlUiEnabled: false,
          controlUiBasePath: "/ui",
          openAiChatCompletionsEnabled: false,
          openResponsesEnabled: false,
          handleHooksRequest: async () => false,
          resolvedAuth,
        });
        const response = createResponse();

        await dispatch(
          server,
          createRequest({
            path: "/api/mining/capital/commit",
            body: { lamports: "500000000" },
          }),
          response.res,
        );

        expect(response.res.statusCode).toBe(503);
        expect(response.setHeader).toHaveBeenCalledWith(
          "Content-Type",
          "application/json; charset=utf-8",
        );
        expect(JSON.parse(response.getBody())).toMatchObject({
          ok: false,
          error: {
            code: "unavailable",
            message: "SAT signer unavailable on VPS",
          },
        });
      },
    });
  });

  test("returns a structured JSON error for mining history failures", async () => {
    vi.mocked(callGatewayScoped).mockRejectedValueOnce(new Error("Internal Server Error"));

    await withTempConfig({
      cfg: { gateway: { trustedProxies: [] } },
      run: async () => {
        const server = createGatewayHttpServer({
          canvasHost: null,
          clients: new Set(),
          controlUiEnabled: false,
          controlUiBasePath: "/ui",
          openAiChatCompletionsEnabled: false,
          openResponsesEnabled: false,
          handleHooksRequest: async () => false,
          resolvedAuth,
        });
        const response = createResponse();

        await dispatch(
          server,
          createRequest({
            method: "GET",
            path: "/api/mining/history?window=all",
          }),
          response.res,
        );

        expect(response.res.statusCode).toBe(500);
        expect(response.setHeader).toHaveBeenCalledWith(
          "Content-Type",
          "application/json; charset=utf-8",
        );
        expect(JSON.parse(response.getBody())).toMatchObject({
          ok: false,
          error: {
            code: "internal_server_error",
            message: "Internal Server Error",
          },
        });
      },
    });
  });

  test("rejects mining start for an unregistered wallet", async () => {
    await withTempConfig({
      cfg: { gateway: { trustedProxies: [], port: 19009 } },
      run: async () => {
        const server = createGatewayHttpServer({
          canvasHost: null,
          clients: new Set(),
          controlUiEnabled: false,
          controlUiBasePath: "/ui",
          openAiChatCompletionsEnabled: false,
          openResponsesEnabled: false,
          handleHooksRequest: async () => false,
          resolvedAuth,
        });
        const response = createResponse();

        await dispatch(
          server,
          createRequest({
            path: "/api/mining/start",
            body: { walletId: "missing-mining-wallet" },
          }),
          response.res,
        );

        expect(response.res.statusCode).toBe(409);
        expect(JSON.parse(response.getBody())).toMatchObject({
          ok: false,
          error: {
            code: "wallet_role_conflict",
            message: "SAT Mining requires an existing dedicated Mining wallet.",
          },
        });
        expect(callGatewayScoped).not.toHaveBeenCalled();
      },
    });
  });

  test("allows mining start to auto-create missing miner capital when wallet is funded", async () => {
    vi.mocked(callGatewayScoped)
      .mockResolvedValueOnce({
        payload: {
          ok: true,
          checks: [
            { key: "fundingReady", ok: true, level: "info", detail: "1 SOL" },
            {
              key: "minerInitialized",
              ok: false,
              level: "warning",
              detail: "SAT miner capital account will be created by funding Mining capital",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        payload: { started: true, status: { running: true, enabledWanted: true } },
      });

    await withTempConfig({
      cfg: { gateway: { trustedProxies: [], port: 19009 } },
      walletRegistry: {
        version: 1,
        providers: {
          "local-socket-signer": {
            enabled: true,
            updatedAt: "2026-07-19T00:00:00.000Z",
          },
        },
        wallets: [
          {
            id: "mining",
            name: "Mining",
            providerId: "local-socket-signer",
            addresses: { solana: "11111111111111111111111111111111" },
            metadata: { purpose: "mining" },
            createdAt: "2026-07-19T00:00:00.000Z",
            updatedAt: "2026-07-19T00:00:00.000Z",
          },
        ],
        assignments: {},
        updatedAt: "2026-07-19T00:00:00.000Z",
      },
      run: async () => {
        const server = createGatewayHttpServer({
          canvasHost: null,
          clients: new Set(),
          controlUiEnabled: false,
          controlUiBasePath: "/ui",
          openAiChatCompletionsEnabled: false,
          openResponsesEnabled: false,
          handleHooksRequest: async () => false,
          resolvedAuth,
        });
        const response = createResponse();

        await dispatch(
          server,
          createRequest({
            path: "/api/mining/start",
            body: { walletId: "mining" },
          }),
          response.res,
        );

        expect(callGatewayScoped).toHaveBeenNthCalledWith(
          1,
          expect.objectContaining({
            method: "sat.getMiningReadiness",
            params: { walletId: "mining" },
          }),
        );
        expect(callGatewayScoped).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({
            method: "sat.startMining",
            params: { walletId: "mining" },
            timeoutMs: 90_000,
          }),
        );
        expect(response.res.statusCode).toBe(200);
      },
    });
  });

  test("routes mining withdraw through localhost with the longer capital timeout", async () => {
    vi.mocked(callGatewayScoped).mockResolvedValueOnce({
      payload: { submitted: { txHash: "tx-1" }, status: { ok: true } },
    });

    await withTempConfig({
      cfg: { gateway: { trustedProxies: [], port: 19009 } },
      run: async () => {
        const server = createGatewayHttpServer({
          canvasHost: null,
          clients: new Set(),
          controlUiEnabled: false,
          controlUiBasePath: "/ui",
          openAiChatCompletionsEnabled: false,
          openResponsesEnabled: false,
          handleHooksRequest: async () => false,
          resolvedAuth,
        });
        const response = createResponse();

        await dispatch(
          server,
          createRequest({
            path: "/api/mining/capital/withdraw",
            body: { lamports: "25000000" },
          }),
          response.res,
        );

        expect(callGatewayScoped).toHaveBeenCalledWith(
          expect.objectContaining({
            url: "ws://localhost:19009",
            method: "sat.withdrawMinerCapital",
            params: { lamports: 25000000 },
            scopes: ["operator.admin"],
            timeoutMs: 45_000,
          }),
        );
        expect(response.res.statusCode).toBe(200);
      },
    });
  });

  test("routes mining stop with a long timeout because stop may drain pending capital", async () => {
    vi.mocked(callGatewayScoped).mockResolvedValueOnce({
      payload: { stopped: true, status: { running: false, enabledWanted: false } },
    });

    await withTempConfig({
      cfg: { gateway: { trustedProxies: [], port: 19009 } },
      run: async () => {
        const server = createGatewayHttpServer({
          canvasHost: null,
          clients: new Set(),
          controlUiEnabled: false,
          controlUiBasePath: "/ui",
          openAiChatCompletionsEnabled: false,
          openResponsesEnabled: false,
          handleHooksRequest: async () => false,
          resolvedAuth,
        });
        const response = createResponse();

        await dispatch(
          server,
          createRequest({
            path: "/api/mining/stop",
          }),
          response.res,
        );

        expect(callGatewayScoped).toHaveBeenCalledWith(
          expect.objectContaining({
            url: "ws://localhost:19009",
            method: "sat.stopMining",
            scopes: ["operator.admin"],
            timeoutMs: 90_000,
          }),
        );
        expect(response.res.statusCode).toBe(200);
      },
    });
  });
});
