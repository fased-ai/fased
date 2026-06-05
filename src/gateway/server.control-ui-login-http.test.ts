import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import type { ResolvedGatewayAuth } from "./auth.js";
import { createGatewayHttpServer } from "./server-http.js";

vi.mock("https-proxy-agent", () => ({
  HttpsProxyAgent: class {},
}));

async function withTempConfig(params: { cfg: unknown; run: () => Promise<void> }): Promise<void> {
  const prevConfigPath = process.env.FASED_CONFIG_PATH;
  const prevDisableCache = process.env.FASED_DISABLE_CONFIG_CACHE;
  const dir = await mkdtemp(path.join(os.tmpdir(), "fased-control-ui-login-http-test-"));
  const configPath = path.join(dir, "fased.json");
  process.env.FASED_CONFIG_PATH = configPath;
  process.env.FASED_DISABLE_CONFIG_CACHE = "1";
  try {
    await writeFile(configPath, JSON.stringify(params.cfg, null, 2), "utf-8");
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
    await rm(dir, { recursive: true, force: true });
  }
}

function createRequest(params: {
  method?: string;
  path: string;
  host?: string;
  headers?: Record<string, string>;
  cookie?: string;
  body?: unknown;
}): IncomingMessage {
  const req = new PassThrough() as unknown as IncomingMessage;
  req.method = params.method ?? "POST";
  req.url = params.path;
  req.headers = {
    host: params.host ?? "fasedagent7f1b9b93ccfdb.agents.fased.app",
    ...params.headers,
    ...(params.cookie ? { cookie: params.cookie } : {}),
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
  end: ReturnType<typeof vi.fn>;
  getBody: () => string;
} {
  const headers = new Map<string, string>();
  const setHeader = vi.fn((name: string, value: unknown) => {
    headers.set(name.toLowerCase(), String(value));
  });
  let body = "";
  const end = vi.fn((chunk?: unknown) => {
    if (typeof chunk === "string") {
      body = chunk;
      return;
    }
    body = chunk ? (chunk as string) : "";
  });
  const res = {
    statusCode: 200,
    headersSent: false,
    setHeader,
    end,
  } as unknown as ServerResponse;
  return {
    res,
    setHeader,
    end,
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

describe("control-ui login exchange endpoint", () => {
  const resolvedAuth: ResolvedGatewayAuth = {
    mode: "token",
    token: "root-token",
    allowTailscale: false,
  };

  test("returns 200 with session token on successful grant exchange", async () => {
    await withTempConfig({
      cfg: { gateway: { trustedProxies: [] } },
      run: async () => {
        const exchangeGrant = vi.fn(() => ({
          ok: true as const,
          sessionToken: "session-token-1",
          expiresAtMs: 1_700_000_100_000,
          idleTimeoutMs: 604_800_000,
        }));
        const server = createGatewayHttpServer({
          canvasHost: null,
          clients: new Set(),
          controlUiEnabled: false,
          controlUiBasePath: "/ui",
          openAiChatCompletionsEnabled: false,
          openResponsesEnabled: false,
          handleHooksRequest: async () => false,
          resolvedAuth,
          controlUiLogin: {
            exchangeGrant,
            issueSession: () => ({
              ok: true,
              sessionToken: "session-token-issued",
              expiresAtMs: 1_700_000_200_000,
              idleTimeoutMs: 604_800_000,
            }),
            authorizeSessionToken: () => ({ ok: true }),
            revokeSessionToken: () => ({ ok: true }),
          },
        });
        const response = createResponse();
        await dispatch(
          server,
          createRequest({ path: "/api/control-ui/login/exchange", body: { grant: "g1" } }),
          response.res,
        );
        expect(response.res.statusCode).toBe(200);
        expect(response.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
        const body = JSON.parse(response.getBody()) as { ok: boolean; sessionToken?: string };
        expect(body.ok).toBe(true);
        expect(body.sessionToken).toBe("session-token-1");
      },
    });
  });

  test("returns 401 when grant is reused", async () => {
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
          controlUiLogin: {
            exchangeGrant: () => ({ ok: false, code: "invalid_or_used_grant" }),
            issueSession: () => ({ ok: false, code: "invalid_session_host" }),
            authorizeSessionToken: () => ({ ok: false, code: "invalid_session_token" }),
            revokeSessionToken: () => ({ ok: true }),
          },
        });
        const response = createResponse();
        await dispatch(
          server,
          createRequest({ path: "/api/control-ui/login/exchange", body: { grant: "g1" } }),
          response.res,
        );
        expect(response.res.statusCode).toBe(401);
        expect(response.getBody()).toContain("invalid_or_used_grant");
      },
    });
  });

  test("returns 200 on successful session logout", async () => {
    await withTempConfig({
      cfg: { gateway: { trustedProxies: [] } },
      run: async () => {
        const revokeSessionToken = vi.fn(() => ({ ok: true }));
        const server = createGatewayHttpServer({
          canvasHost: null,
          clients: new Set(),
          controlUiEnabled: false,
          controlUiBasePath: "/ui",
          openAiChatCompletionsEnabled: false,
          openResponsesEnabled: false,
          handleHooksRequest: async () => false,
          resolvedAuth,
          controlUiLogin: {
            exchangeGrant: () => ({ ok: false, code: "invalid_grant" }),
            issueSession: () => ({
              ok: true,
              sessionToken: "session-token-issued",
              expiresAtMs: 1_700_000_300_000,
              idleTimeoutMs: 604_800_000,
            }),
            authorizeSessionToken: () => ({ ok: true }),
            revokeSessionToken,
          },
        });
        const response = createResponse();
        await dispatch(
          server,
          createRequest({ path: "/api/control-ui/login/logout", body: { token: "session-1" } }),
          response.res,
        );
        expect(response.res.statusCode).toBe(200);
        expect(response.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
        expect(revokeSessionToken).toHaveBeenCalledWith({
          token: "session-1",
          host: "fasedagent7f1b9b93ccfdb.agents.fased.app",
        });
      },
    });
  });

  test("returns 200 on token-to-session login", async () => {
    await withTempConfig({
      cfg: { gateway: { trustedProxies: [] } },
      run: async () => {
        const issueSession = vi.fn(() => ({
          ok: true as const,
          sessionToken: "session-from-root-token",
          expiresAtMs: 1_700_000_400_000,
          idleTimeoutMs: 604_800_000,
        }));
        const server = createGatewayHttpServer({
          canvasHost: null,
          clients: new Set(),
          controlUiEnabled: false,
          controlUiBasePath: "/ui",
          openAiChatCompletionsEnabled: false,
          openResponsesEnabled: false,
          handleHooksRequest: async () => false,
          resolvedAuth,
          controlUiLogin: {
            exchangeGrant: () => ({ ok: false, code: "invalid_grant" }),
            issueSession,
            authorizeSessionToken: () => ({ ok: true }),
            revokeSessionToken: () => ({ ok: true }),
          },
        });
        const response = createResponse();
        await dispatch(
          server,
          createRequest({
            path: "/api/control-ui/login/token",
            body: { token: "root-token" },
          }),
          response.res,
        );
        expect(response.res.statusCode).toBe(200);
        expect(issueSession).toHaveBeenCalledWith({
          host: "fasedagent7f1b9b93ccfdb.agents.fased.app",
        });
      },
    });
  });

  test("omits secure session cookie for localhost token login", async () => {
    await withTempConfig({
      cfg: { gateway: { trustedProxies: [] } },
      run: async () => {
        const issueSession = vi.fn(() => ({
          ok: true as const,
          sessionToken: "session-from-root-token",
          expiresAtMs: 1_700_000_400_000,
          idleTimeoutMs: 604_800_000,
        }));
        const server = createGatewayHttpServer({
          canvasHost: null,
          clients: new Set(),
          controlUiEnabled: false,
          controlUiBasePath: "/ui",
          openAiChatCompletionsEnabled: false,
          openResponsesEnabled: false,
          handleHooksRequest: async () => false,
          resolvedAuth,
          controlUiLogin: {
            exchangeGrant: () => ({ ok: false, code: "invalid_grant" }),
            issueSession,
            authorizeSessionToken: () => ({ ok: true }),
            revokeSessionToken: () => ({ ok: true }),
          },
        });
        const response = createResponse();
        await dispatch(
          server,
          createRequest({
            path: "/api/control-ui/login/token",
            host: "127.0.0.1:18789",
            body: { token: "root-token" },
          }),
          response.res,
        );
        expect(response.res.statusCode).toBe(200);
        expect(response.setHeader).toHaveBeenCalledWith(
          "Set-Cookie",
          expect.stringContaining("fased_ui_session=session-from-root-token"),
        );
        expect(response.setHeader).not.toHaveBeenCalledWith(
          "Set-Cookie",
          expect.stringContaining("Secure"),
        );
      },
    });
  });

  test("restores a saved UI session token as a session cookie", async () => {
    await withTempConfig({
      cfg: { gateway: { trustedProxies: [] } },
      run: async () => {
        const issueSession = vi.fn(() => ({
          ok: true as const,
          sessionToken: "session-from-root-token",
          expiresAtMs: 1_700_000_400_000,
          idleTimeoutMs: 604_800_000,
        }));
        const authorizeSessionToken = vi.fn(() => ({
          ok: true,
          expiresAtMs: 1_700_000_500_000,
        }));
        const server = createGatewayHttpServer({
          canvasHost: null,
          clients: new Set(),
          controlUiEnabled: false,
          controlUiBasePath: "/ui",
          openAiChatCompletionsEnabled: false,
          openResponsesEnabled: false,
          handleHooksRequest: async () => false,
          resolvedAuth,
          controlUiLogin: {
            exchangeGrant: () => ({ ok: false, code: "invalid_grant" }),
            issueSession,
            authorizeSessionToken,
            revokeSessionToken: () => ({ ok: true }),
          },
        });
        const response = createResponse();
        await dispatch(
          server,
          createRequest({
            path: "/api/control-ui/login/token",
            host: "localhost:18789",
            body: { token: "saved-ui-session" },
          }),
          response.res,
        );
        expect(response.res.statusCode).toBe(200);
        expect(issueSession).not.toHaveBeenCalled();
        expect(authorizeSessionToken).toHaveBeenCalledWith({
          token: "saved-ui-session",
          host: "localhost:18789",
        });
        expect(response.setHeader).toHaveBeenCalledWith(
          "Set-Cookie",
          expect.stringContaining("fased_ui_session=saved-ui-session"),
        );
      },
    });
  });

  test("gates public UI shell behind login page when session cookie is missing", async () => {
    await withTempConfig({
      cfg: { gateway: { trustedProxies: [] } },
      run: async () => {
        const server = createGatewayHttpServer({
          canvasHost: null,
          clients: new Set(),
          controlUiEnabled: true,
          controlUiBasePath: "",
          openAiChatCompletionsEnabled: false,
          openResponsesEnabled: false,
          handleHooksRequest: async () => false,
          resolvedAuth,
          controlUiLogin: {
            exchangeGrant: () => ({ ok: false, code: "invalid_grant" }),
            issueSession: () => ({ ok: false, code: "invalid_session_host" }),
            authorizeSessionToken: () => ({ ok: false, code: "invalid_session_token" }),
            revokeSessionToken: () => ({ ok: true }),
          },
        });
        const response = createResponse();
        await dispatch(server, createRequest({ method: "GET", path: "/" }), response.res);
        expect(response.res.statusCode).toBe(401);
        expect(response.getBody()).toContain("<h1>Sign in to Fased Agent</h1>");
        expect(response.getBody()).toContain("gatewayUrl: currentGatewayUrl()");
        expect(response.getBody()).toContain("fased.control.token.local.v1");
        expect(response.getBody()).toContain("fased.control.token.session.v1");
      },
    });
  });

  test("allows UI request when valid session cookie is present", async () => {
    await withTempConfig({
      cfg: { gateway: { trustedProxies: [] } },
      run: async () => {
        const authorizeSessionToken = vi.fn(() => ({ ok: true }));
        const server = createGatewayHttpServer({
          canvasHost: null,
          clients: new Set(),
          controlUiEnabled: true,
          controlUiBasePath: "",
          openAiChatCompletionsEnabled: false,
          openResponsesEnabled: false,
          handleHooksRequest: async () => false,
          resolvedAuth,
          controlUiLogin: {
            exchangeGrant: () => ({ ok: false, code: "invalid_grant" }),
            issueSession: () => ({ ok: false, code: "invalid_session_host" }),
            authorizeSessionToken,
            revokeSessionToken: () => ({ ok: true }),
          },
        });
        const response = createResponse();
        await dispatch(
          server,
          createRequest({
            method: "GET",
            path: "/",
            cookie: "fased_ui_session=session-cookie-token",
          }),
          response.res,
        );
        expect(authorizeSessionToken).toHaveBeenCalledWith({
          token: "session-cookie-token",
          host: "fasedagent7f1b9b93ccfdb.agents.fased.app",
        });
        expect(response.res.statusCode).not.toBe(401);
      },
    });
  });

  test("uses trusted forwarded host for proxied hosted session checks", async () => {
    await withTempConfig({
      cfg: { gateway: { trustedProxies: ["127.0.0.1/32", "::1/128"] } },
      run: async () => {
        const authorizeSessionToken = vi.fn(() => ({ ok: true }));
        const server = createGatewayHttpServer({
          canvasHost: null,
          clients: new Set(),
          controlUiEnabled: true,
          controlUiBasePath: "",
          openAiChatCompletionsEnabled: false,
          openResponsesEnabled: false,
          handleHooksRequest: async () => false,
          resolvedAuth,
          controlUiLogin: {
            exchangeGrant: () => ({ ok: false, code: "invalid_grant" }),
            issueSession: () => ({ ok: false, code: "invalid_session_host" }),
            authorizeSessionToken,
            revokeSessionToken: () => ({ ok: true }),
          },
        });
        const response = createResponse();
        await dispatch(
          server,
          createRequest({
            method: "GET",
            path: "/",
            host: "127.0.0.1:18789",
            headers: {
              "x-forwarded-host": "fased-vps.tailnet.ts.net",
              "x-forwarded-proto": "https",
              "x-forwarded-for": "100.65.209.118",
            },
            cookie: "fased_ui_session=session-cookie-token",
          }),
          response.res,
        );
        expect(authorizeSessionToken).toHaveBeenCalledWith({
          token: "session-cookie-token",
          host: "fased-vps.tailnet.ts.net",
        });
        expect(response.res.statusCode).not.toBe(401);
      },
    });
  });

  test("issues hosted login sessions against trusted forwarded host", async () => {
    await withTempConfig({
      cfg: { gateway: { trustedProxies: ["127.0.0.1/32", "::1/128"] } },
      run: async () => {
        const issueSession = vi.fn(() => ({
          ok: true as const,
          sessionToken: "session-token-hosted",
          expiresAtMs: 1_700_000_100_000,
          idleTimeoutMs: 3_600_000,
        }));
        const server = createGatewayHttpServer({
          canvasHost: null,
          clients: new Set(),
          controlUiEnabled: true,
          controlUiBasePath: "",
          openAiChatCompletionsEnabled: false,
          openResponsesEnabled: false,
          handleHooksRequest: async () => false,
          resolvedAuth,
          controlUiLogin: {
            exchangeGrant: () => ({ ok: false, code: "invalid_grant" }),
            issueSession,
            authorizeSessionToken: () => ({ ok: false, code: "invalid_session_token" }),
            revokeSessionToken: () => ({ ok: true }),
          },
        });
        const response = createResponse();
        await dispatch(
          server,
          createRequest({
            method: "POST",
            path: "/api/control-ui/login/token",
            host: "127.0.0.1:18789",
            headers: {
              "x-forwarded-host": "fased-vps.tailnet.ts.net",
              "x-forwarded-proto": "https",
              "x-forwarded-for": "100.65.209.118",
            },
            body: { token: "root-token" },
          }),
          response.res,
        );
        expect(issueSession).toHaveBeenCalledWith({ host: "fased-vps.tailnet.ts.net" });
        expect(response.res.statusCode).toBe(200);
        expect(JSON.parse(response.getBody())).toMatchObject({
          ok: true,
          sessionToken: "session-token-hosted",
        });
      },
    });
  });

  test("serves local UI deep links like normal SPA routes without the remote cookie gate", async () => {
    await withTempConfig({
      cfg: { gateway: { trustedProxies: [] } },
      run: async () => {
        const authorizeSessionToken = vi.fn(() => ({ ok: false, code: "invalid_session_token" }));
        const server = createGatewayHttpServer({
          canvasHost: null,
          clients: new Set(),
          controlUiEnabled: true,
          controlUiBasePath: "",
          openAiChatCompletionsEnabled: false,
          openResponsesEnabled: false,
          handleHooksRequest: async () => false,
          resolvedAuth,
          controlUiLogin: {
            exchangeGrant: () => ({ ok: false, code: "invalid_grant" }),
            issueSession: () => ({ ok: false, code: "invalid_session_host" }),
            authorizeSessionToken,
            revokeSessionToken: () => ({ ok: true }),
          },
        });
        for (const path of ["/memory?agent=main", "/skills", "/agents"]) {
          const response = createResponse();
          await dispatch(
            server,
            createRequest({
              method: "GET",
              path,
              host: "127.0.0.1:18789",
            }),
            response.res,
          );
          expect(response.res.statusCode).not.toBe(401);
          expect(response.res.statusCode).not.toBe(302);
          expect(response.getBody()).not.toContain("<h1>Sign in to Fased Agent</h1>");
        }
        expect(authorizeSessionToken).not.toHaveBeenCalled();
      },
    });
  });

  test("does not clear stale local UI cookies before serving deep links", async () => {
    await withTempConfig({
      cfg: { gateway: { trustedProxies: [] } },
      run: async () => {
        const authorizeSessionToken = vi.fn(() => ({ ok: false as const, code: "expired" }));
        const server = createGatewayHttpServer({
          canvasHost: null,
          clients: new Set(),
          controlUiEnabled: true,
          controlUiBasePath: "",
          openAiChatCompletionsEnabled: false,
          openResponsesEnabled: false,
          handleHooksRequest: async () => false,
          resolvedAuth,
          controlUiLogin: {
            exchangeGrant: () => ({ ok: false, code: "invalid_grant" }),
            issueSession: () => ({ ok: false, code: "invalid_session_host" }),
            authorizeSessionToken,
            revokeSessionToken: () => ({ ok: true }),
          },
        });
        const response = createResponse();
        await dispatch(
          server,
          createRequest({
            method: "GET",
            path: "/memory?agent=main",
            host: "127.0.0.1:18789",
            cookie: "fased_ui_session=stale-session-token",
          }),
          response.res,
        );
        expect(authorizeSessionToken).not.toHaveBeenCalled();
        expect(response.res.statusCode).not.toBe(401);
        expect(response.res.statusCode).not.toBe(302);
        expect(response.setHeader).not.toHaveBeenCalledWith(
          "Set-Cookie",
          expect.stringContaining("fased_ui_session=;"),
        );
      },
    });
  });
});
