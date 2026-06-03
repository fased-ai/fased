import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedGatewayAuth } from "./auth.js";
import { withTempConfig } from "./test-temp-config.js";

function createRequest(params: {
  path: string;
  authorization?: string;
  method?: string;
}): IncomingMessage {
  const headers: Record<string, string> = {
    host: "localhost:18789",
  };
  if (params.authorization) {
    headers.authorization = params.authorization;
  }
  return {
    method: params.method ?? "GET",
    url: params.path,
    headers,
    socket: { remoteAddress: "127.0.0.1" },
  } as IncomingMessage;
}

function createResponse(): {
  res: ServerResponse;
  ended: Promise<void>;
  getBody: () => string;
} {
  let body = "";
  let resolveEnded: () => void = () => {};
  const ended = new Promise<void>((resolve) => {
    resolveEnded = resolve;
  });
  const res = {
    headersSent: false,
    statusCode: 200,
    setHeader: vi.fn(),
    writeHead: vi.fn(),
    write: vi.fn((chunk?: unknown) => {
      if (typeof chunk === "string") {
        body += chunk;
      }
      return true;
    }),
    end: vi.fn((chunk?: unknown) => {
      if (typeof chunk === "string") {
        body += chunk;
      } else if (Buffer.isBuffer(chunk)) {
        body += chunk.toString("utf8");
      }
      resolveEnded();
    }),
  } as unknown as ServerResponse;
  return { res, ended, getBody: () => body };
}

async function dispatchRequest(
  server: { emit: (event: "request", req: IncomingMessage, res: ServerResponse) => boolean },
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  server.emit("request", req, res);
  await new Promise((resolve) => setImmediate(resolve));
}

const resolvedAuth: ResolvedGatewayAuth = {
  mode: "token",
  token: "test-token",
  password: undefined,
  allowTailscale: false,
};

function baseServerOptions() {
  return {
    canvasHost: null,
    clients: new Set<never>(),
    controlUiEnabled: false,
    controlUiBasePath: "/__control__",
    openAiChatCompletionsEnabled: false,
    handleHooksRequest: async () => false,
    resolvedAuth,
  };
}

describe("gateway HTTP media sidecar lazy routing", () => {
  afterEach(() => {
    vi.doUnmock("./openresponses-http.js");
    vi.resetModules();
  });

  it("returns fast 404 for disabled OpenResponses media routes without loading the handler", async () => {
    const openResponsesImport = vi.fn();
    vi.doMock("./openresponses-http.js", () => {
      openResponsesImport();
      return {
        handleOpenResponsesHttpRequest: vi.fn(async () => false),
      };
    });

    await withTempConfig({
      cfg: { gateway: { trustedProxies: [] } },
      prefix: "fased-media-sidecar-disabled-test-",
      run: async () => {
        const { createGatewayHttpServer } = await import("./server-http.js");
        const server = createGatewayHttpServer({
          ...baseServerOptions(),
          openResponsesEnabled: false,
        });
        const response = createResponse();

        await dispatchRequest(
          server,
          createRequest({
            path: "/v1/responses",
            method: "POST",
            authorization: "Bearer test-token",
          }),
          response.res,
        );
        await response.ended;

        expect(response.res.statusCode).toBe(404);
        expect(response.getBody()).toBe("Not Found");
        expect(openResponsesImport).not.toHaveBeenCalled();
      },
    });
  });

  it("loads the OpenResponses handler only when the route is enabled", async () => {
    const openResponsesImport = vi.fn();
    const handleOpenResponsesHttpRequest = vi.fn(async (_req: IncomingMessage, res) => {
      res.statusCode = 200;
      res.end("handled");
      return true;
    });
    vi.doMock("./openresponses-http.js", () => {
      openResponsesImport();
      return { handleOpenResponsesHttpRequest };
    });

    await withTempConfig({
      cfg: { gateway: { trustedProxies: [] } },
      prefix: "fased-media-sidecar-enabled-test-",
      run: async () => {
        const { createGatewayHttpServer } = await import("./server-http.js");
        const server = createGatewayHttpServer({
          ...baseServerOptions(),
          openResponsesEnabled: true,
        });
        const response = createResponse();

        await dispatchRequest(
          server,
          createRequest({
            path: "/v1/responses",
            method: "POST",
            authorization: "Bearer test-token",
          }),
          response.res,
        );
        await response.ended;

        expect(response.res.statusCode).toBe(200);
        expect(response.getBody()).toBe("handled");
        expect(openResponsesImport).toHaveBeenCalledTimes(1);
        expect(handleOpenResponsesHttpRequest).toHaveBeenCalledTimes(1);
      },
    });
  });
});
