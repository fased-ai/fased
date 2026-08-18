import type { IncomingMessage, ServerResponse } from "node:http";
import { isPathProtectedByPrefixes } from "../security-path.js";

const FEDERATION_HTTP_ROUTE_PREFIXES = ["/api/federation"] as const;

// These peer-facing routes perform mandatory directory-bound Ed25519 v2
// authentication in federation-http. Every other federation route stays
// behind the local Gateway auth boundary.
const SIGNED_FEDERATION_INBOUND_ROUTES = new Set([
  "/api/federation/marketplace/orders",
  "/api/federation/marketplace/deliveries",
]);

export type GatewayFederationNetworkFacade = {
  requiresGatewayAuth(params: { req: IncomingMessage; requestPath: string }): boolean;
  handle(params: {
    req: IncomingMessage;
    res: ServerResponse;
    peerAuthClientIp?: string;
  }): Promise<boolean>;
};

type GatewayFederationNetworkDependencies = {
  handleFederationRequest: typeof import("../federation-http.js").handleFederationHttpRequest;
};

function isSignedFederationInboundRequest(req: IncomingMessage): boolean {
  return req.method === "POST" && SIGNED_FEDERATION_INBOUND_ROUTES.has(req.url ?? "");
}

export function createGatewayFederationNetworkFacade(
  overrides: Partial<GatewayFederationNetworkDependencies> = {},
): GatewayFederationNetworkFacade {
  return {
    requiresGatewayAuth: ({ req, requestPath }) =>
      isPathProtectedByPrefixes(requestPath, FEDERATION_HTTP_ROUTE_PREFIXES) &&
      !isSignedFederationInboundRequest(req),
    handle: async ({ req, res, peerAuthClientIp }) => {
      const handler =
        overrides.handleFederationRequest ??
        (await import("../federation-http.js")).handleFederationHttpRequest;
      return await handler(req, res, { peerAuthClientIp });
    },
  };
}
