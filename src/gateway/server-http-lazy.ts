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
import { safeEqualSecret } from "../security/secret-equal.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import { isDirectLoopbackRequest, type ResolvedGatewayAuth } from "./auth.js";
import { getBearerToken } from "./http-utils.js";
import type { GatewayHttpServerOpts } from "./server-http.js";
import {
  handleGatewayReadinessHttpRequest,
  resolveGatewayProbeStatus,
} from "./server/readiness-http-service.js";
import type { GatewayWsClient } from "./server/ws-types.js";

type ServerHttpModule = typeof import("./server-http.js");

let serverHttpModulePromise: Promise<ServerHttpModule> | null = null;

function loadServerHttpModule(): Promise<ServerHttpModule> {
  serverHttpModulePromise ??= import("./server-http.js");
  return serverHttpModulePromise;
}

function canRevealLazyReadinessDetails(req: IncomingMessage, auth: ResolvedGatewayAuth): boolean {
  if (isDirectLoopbackRequest(req)) {
    return true;
  }
  const bearerToken = getBearerToken(req);
  if (!bearerToken) {
    return false;
  }
  if (auth.mode === "token" && auth.token) {
    return safeEqualSecret(auth.token, bearerToken);
  }
  if (auth.mode === "password" && auth.password) {
    return safeEqualSecret(auth.password, bearerToken);
  }
  return false;
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
    const requestPath = new URL(req.url ?? "/", "http://localhost").pathname;
    if (resolveGatewayProbeStatus(requestPath)) {
      void handleGatewayReadinessHttpRequest({
        req,
        res,
        requestPath,
        getReadiness: opts.getReadiness,
        canRevealDetails: () => canRevealLazyReadinessDetails(req, opts.resolvedAuth),
      }).catch(() => {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
        }
        res.end("Gateway readiness handler failed");
      });
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
