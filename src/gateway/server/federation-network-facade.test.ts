import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createGatewayFederationNetworkFacade } from "./federation-network-facade.js";

function request(method: string, url: string): IncomingMessage {
  return { method, url } as IncomingMessage;
}

describe("Gateway federation network facade", () => {
  it("keeps local federation administration behind Gateway auth", () => {
    const facade = createGatewayFederationNetworkFacade();
    expect(
      facade.requiresGatewayAuth({
        req: request("GET", "/api/federation/status"),
        requestPath: "/api/federation/status",
      }),
    ).toBe(true);
    expect(
      facade.requiresGatewayAuth({
        req: request("POST", "/api/federation/bond/open"),
        requestPath: "/api/federation/bond/open",
      }),
    ).toBe(true);
  });

  it("allows only exact signed POST ingress routes to bypass Gateway auth", () => {
    const facade = createGatewayFederationNetworkFacade();
    for (const path of [
      "/api/federation/marketplace/orders",
      "/api/federation/marketplace/deliveries",
    ]) {
      expect(facade.requiresGatewayAuth({ req: request("POST", path), requestPath: path })).toBe(
        false,
      );
      expect(facade.requiresGatewayAuth({ req: request("GET", path), requestPath: path })).toBe(
        true,
      );
      expect(
        facade.requiresGatewayAuth({
          req: request("POST", `${path}?unexpected=1`),
          requestPath: path,
        }),
      ).toBe(true);
    }
  });

  it("does not claim unrelated or lookalike paths", () => {
    const facade = createGatewayFederationNetworkFacade();
    expect(
      facade.requiresGatewayAuth({
        req: request("GET", "/api/wallet/status"),
        requestPath: "/api/wallet/status",
      }),
    ).toBe(false);
    expect(
      facade.requiresGatewayAuth({
        req: request("GET", "/api/federation-evil/status"),
        requestPath: "/api/federation-evil/status",
      }),
    ).toBe(false);
  });

  it("delegates peer handling with the resolved client identity", async () => {
    const handleFederationRequest = vi.fn(async () => true);
    const facade = createGatewayFederationNetworkFacade({ handleFederationRequest });
    const req = request("POST", "/api/federation/marketplace/orders");
    const res = {} as ServerResponse;

    await expect(facade.handle({ req, res, peerAuthClientIp: "100.64.0.12" })).resolves.toBe(true);
    expect(handleFederationRequest).toHaveBeenCalledWith(req, res, {
      peerAuthClientIp: "100.64.0.12",
    });
  });

  it("preserves a non-matching result from the domain handler", async () => {
    const handleFederationRequest = vi.fn(async () => false);
    const facade = createGatewayFederationNetworkFacade({ handleFederationRequest });

    await expect(
      facade.handle({
        req: request("GET", "/unrelated"),
        res: {} as ServerResponse,
        peerAuthClientIp: "127.0.0.1",
      }),
    ).resolves.toBe(false);
  });
});
