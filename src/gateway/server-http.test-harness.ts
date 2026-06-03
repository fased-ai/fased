import type { IncomingMessage, ServerResponse } from "node:http";
import { vi } from "vitest";
import type { ResolvedGatewayAuth } from "./auth.js";
import { createGatewayHttpServer, type GatewayHttpServerOpts } from "./server-http.js";

export const AUTH_NONE: ResolvedGatewayAuth = {
  mode: "none",
  allowTailscale: false,
};

export const AUTH_TOKEN: ResolvedGatewayAuth = {
  mode: "token",
  token: "test-token",
  allowTailscale: false,
};

export function createRequest(params: {
  path: string;
  authorization?: string;
  method?: string;
  remoteAddress?: string;
  host?: string;
}): IncomingMessage {
  const headers: Record<string, string> = {
    host: params.host ?? "localhost:18789",
  };
  if (params.authorization) {
    headers.authorization = params.authorization;
  }
  return {
    method: params.method ?? "GET",
    url: params.path,
    headers,
    socket: { remoteAddress: params.remoteAddress ?? "127.0.0.1" },
  } as IncomingMessage;
}

export function createResponse(): {
  res: ServerResponse;
  getBody: () => string;
} {
  let body = "";
  const res = {
    headersSent: false,
    statusCode: 200,
    setHeader: vi.fn(),
    writeHead: vi.fn((statusCode?: number) => {
      if (typeof statusCode === "number") {
        res.statusCode = statusCode;
      }
    }),
    write: vi.fn((chunk?: unknown) => {
      if (typeof chunk === "string") {
        body += chunk;
      } else if (Buffer.isBuffer(chunk)) {
        body += chunk.toString("utf8");
      }
      return true;
    }),
    end: vi.fn((chunk?: unknown) => {
      if (typeof chunk === "string") {
        body += chunk;
      } else if (Buffer.isBuffer(chunk)) {
        body += chunk.toString("utf8");
      }
    }),
  } as unknown as ServerResponse;
  return { res, getBody: () => body };
}

export async function dispatchRequest(
  server: { emit: (event: "request", req: IncomingMessage, res: ServerResponse) => boolean },
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  server.emit("request", req, res);
  await new Promise((resolve) => setImmediate(resolve));
}

export async function withGatewayServer<T>(params: {
  prefix: string;
  resolvedAuth: ResolvedGatewayAuth;
  overrides?: Partial<GatewayHttpServerOpts>;
  run: (server: ReturnType<typeof createGatewayHttpServer>) => Promise<T>;
}): Promise<T> {
  const server = createGatewayHttpServer({
    canvasHost: null,
    clients: new Set(),
    controlUiEnabled: false,
    controlUiBasePath: "/__control__",
    openAiChatCompletionsEnabled: false,
    openResponsesEnabled: false,
    handleHooksRequest: async () => false,
    resolvedAuth: params.resolvedAuth,
    ...params.overrides,
  });
  try {
    return await params.run(server);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
}
