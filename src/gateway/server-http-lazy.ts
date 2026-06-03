import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { Duplex } from "node:stream";
import type { WebSocketServer } from "ws";
import type { CanvasHostHandler } from "../canvas-host/server.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import type { GatewayHttpServerOpts } from "./server-http.js";
import type { GatewayWsClient } from "./server/ws-types.js";

type ServerHttpModule = typeof import("./server-http.js");

let serverHttpModulePromise: Promise<ServerHttpModule> | null = null;

function loadServerHttpModule(): Promise<ServerHttpModule> {
  serverHttpModulePromise ??= import("./server-http.js");
  return serverHttpModulePromise;
}

function handleGatewayProbeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: Pick<GatewayHttpServerOpts, "getReadiness">,
): boolean {
  const requestPath = new URL(req.url ?? "/", "http://localhost").pathname;
  const status =
    requestPath === "/health" || requestPath === "/healthz"
      ? "live"
      : requestPath === "/ready" || requestPath === "/readyz"
        ? "ready"
        : null;
  if (!status) {
    return false;
  }

  const method = (req.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET, HEAD");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Method Not Allowed");
    return true;
  }

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");

  if (status === "ready" && opts.getReadiness) {
    try {
      const readiness = opts.getReadiness();
      res.statusCode = readiness.ready ? 200 : 503;
      res.end(method === "HEAD" ? undefined : JSON.stringify(readiness));
    } catch {
      res.statusCode = 503;
      res.end(method === "HEAD" ? undefined : JSON.stringify({ ready: false }));
    }
    return true;
  }

  res.statusCode = 200;
  res.end(method === "HEAD" ? undefined : JSON.stringify({ ok: true, status }));
  return true;
}

export function createGatewayHttpServer(opts: GatewayHttpServerOpts): HttpServer {
  let delegateServerPromise: Promise<HttpServer> | null = null;
  const loadDelegateServer = async (): Promise<HttpServer> => {
    delegateServerPromise ??= loadServerHttpModule().then((mod) =>
      mod.createGatewayHttpServer(opts),
    );
    return delegateServerPromise;
  };

  const handleRequest = (req: IncomingMessage, res: ServerResponse) => {
    if (handleGatewayProbeRequest(req, res, opts)) {
      return;
    }

    void loadDelegateServer()
      .then((delegateServer) => {
        delegateServer.emit("request", req, res);
      })
      .catch((error) => {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
        }
        res.end(`Gateway request handler failed to load: ${String(error)}`);
      });
  };

  return opts.tlsOptions
    ? createHttpsServer(opts.tlsOptions, handleRequest)
    : createHttpServer(handleRequest);
}

export function attachGatewayUpgradeHandler(opts: {
  httpServer: HttpServer;
  wss: WebSocketServer;
  canvasHost: CanvasHostHandler | null;
  clients: Set<GatewayWsClient>;
  resolvedAuth: ResolvedGatewayAuth;
  rateLimiter?: AuthRateLimiter;
}) {
  const { httpServer, wss, canvasHost } = opts;
  httpServer.on("upgrade", (req, socket, head) => {
    if (!canvasHost) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
      return;
    }

    void loadServerHttpModule()
      .then((mod) =>
        mod.handleGatewayUpgradeRequest({
          ...opts,
          req,
          socket,
          head,
        }),
      )
      .catch(() => {
        socket.destroy();
      });
  });
}

export const __testing = {
  isServerHttpModuleLoaded: () => serverHttpModulePromise !== null,
  resetServerHttpModuleForTest: () => {
    serverHttpModulePromise = null;
  },
};

export type { GatewayHttpServerOpts };
export type GatewayUpgradeRequest = {
  req: IncomingMessage;
  socket: Duplex;
  head: Buffer;
};
