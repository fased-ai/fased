import { describe, expect, it, vi } from "vitest";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import { authorizeGatewayConnect, resolveGatewayAuth } from "./auth.js";

function createLimiterSpy(): AuthRateLimiter & {
  check: ReturnType<
    typeof vi.fn<(ip: string | undefined, scope?: string) => ReturnType<AuthRateLimiter["check"]>>
  >;
  recordFailure: ReturnType<typeof vi.fn<(ip: string | undefined, scope?: string) => void>>;
  reset: ReturnType<typeof vi.fn<(ip: string | undefined, scope?: string) => void>>;
} {
  return {
    check: vi.fn(() => ({ allowed: true, remaining: 10, retryAfterMs: 0 })),
    recordFailure: vi.fn(),
    reset: vi.fn(),
    size: () => 0,
    prune: () => {},
    dispose: () => {},
  };
}

describe("gateway auth", () => {
  it("resolves token/password from FASED gateway env vars", () => {
    expect(
      resolveGatewayAuth({
        authConfig: {},
        env: {
          FASED_GATEWAY_TOKEN: "env-token",
          FASED_GATEWAY_PASSWORD: "env-password",
        } as NodeJS.ProcessEnv,
      }),
    ).toMatchObject({
      mode: "password",
      token: "env-token",
      password: "env-password",
    });
  });

  it("does not throw when req is missing socket", async () => {
    const res = await authorizeGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: false },
      connectAuth: { token: "secret" },
      // Regression: avoid crashing on req.socket.remoteAddress when callers pass a non-IncomingMessage.
      req: {} as never,
    });
    expect(res.ok).toBe(true);
  });

  it("allows explicit none auth only for a direct loopback request", async () => {
    const direct = await authorizeGatewayConnect({
      auth: { mode: "none", allowTailscale: false },
      req: {
        socket: { remoteAddress: "127.0.0.1" },
        headers: { host: "127.0.0.1" },
      } as never,
    });
    expect(direct).toMatchObject({ ok: true, method: "none" });

    const forwarded = await authorizeGatewayConnect({
      auth: { mode: "none", allowTailscale: false },
      req: {
        socket: { remoteAddress: "127.0.0.1" },
        headers: { "x-forwarded-for": "203.0.113.10" },
      } as never,
    });
    expect(forwarded).toMatchObject({ ok: false, reason: "unauthorized" });

    const emptyForwarded = await authorizeGatewayConnect({
      auth: { mode: "none", allowTailscale: false },
      req: {
        socket: { remoteAddress: "127.0.0.1" },
        headers: { "x-forwarded-for": "" },
      } as never,
    });
    expect(emptyForwarded).toMatchObject({ ok: false, reason: "unauthorized" });

    const viaProxy = await authorizeGatewayConnect({
      auth: { mode: "none", allowTailscale: false },
      req: {
        socket: { remoteAddress: "127.0.0.1" },
        headers: { via: "1.1 local-proxy" },
      } as never,
    });
    expect(viaProxy).toMatchObject({ ok: false, reason: "unauthorized" });

    const remote = await authorizeGatewayConnect({
      auth: { mode: "none", allowTailscale: false },
      req: {
        socket: { remoteAddress: "203.0.113.10" },
        headers: {},
      } as never,
    });
    expect(remote).toMatchObject({ ok: false, reason: "unauthorized" });

    const trustedProxyPeer = await authorizeGatewayConnect({
      auth: { mode: "none", allowTailscale: false },
      req: {
        socket: { remoteAddress: "10.20.30.40" },
        headers: {},
      } as never,
      trustedProxies: ["10.0.0.0/8"],
    });
    expect(trustedProxyPeer).toMatchObject({ ok: false, reason: "unauthorized" });

    const trustedLoopbackProxyPeer = await authorizeGatewayConnect({
      auth: { mode: "none", allowTailscale: false },
      req: {
        socket: { remoteAddress: "127.0.0.1" },
        headers: {},
      } as never,
      trustedProxies: ["127.0.0.1/32"],
    });
    expect(trustedLoopbackProxyPeer).toMatchObject({ ok: false, reason: "unauthorized" });

    const tailscaleProxyAmbiguity = await authorizeGatewayConnect({
      auth: { mode: "none", allowTailscale: true },
      req: {
        socket: { remoteAddress: "127.0.0.1" },
        headers: {},
      } as never,
    });
    expect(tailscaleProxyAmbiguity).toMatchObject({ ok: false, reason: "unauthorized" });
  });

  it("reports missing and mismatched token reasons", async () => {
    const missing = await authorizeGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: false },
      connectAuth: null,
    });
    expect(missing.ok).toBe(false);
    expect(missing.reason).toBe("token_missing");

    const mismatch = await authorizeGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: false },
      connectAuth: { token: "wrong" },
    });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.reason).toBe("token_mismatch");
  });

  it("reports missing token config reason", async () => {
    const res = await authorizeGatewayConnect({
      auth: { mode: "token", allowTailscale: false },
      connectAuth: { token: "anything" },
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("token_missing_config");
  });

  it("accepts session token via verifier when gateway token mismatches", async () => {
    const limiter = createLimiterSpy();
    const res = await authorizeGatewayConnect({
      auth: {
        mode: "token",
        token: "root-token",
        allowTailscale: false,
        sessionTokenVerifier: async () => ({ ok: true }),
      },
      connectAuth: { token: "session-token-1" },
      rateLimiter: limiter,
    });
    expect(res.ok).toBe(true);
    expect(res.method).toBe("session-token");
    expect(limiter.reset).toHaveBeenCalledWith(undefined, "shared-secret");
    expect(limiter.recordFailure).not.toHaveBeenCalled();
  });

  it("falls back to token mismatch when session token verifier rejects", async () => {
    const limiter = createLimiterSpy();
    const res = await authorizeGatewayConnect({
      auth: {
        mode: "token",
        token: "root-token",
        allowTailscale: false,
        sessionTokenVerifier: async () => ({ ok: false }),
      },
      connectAuth: { token: "wrong" },
      rateLimiter: limiter,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("token_mismatch");
    expect(limiter.recordFailure).toHaveBeenCalledWith(undefined, "shared-secret");
  });

  it("reports missing and mismatched password reasons", async () => {
    const missing = await authorizeGatewayConnect({
      auth: { mode: "password", password: "secret", allowTailscale: false },
      connectAuth: null,
    });
    expect(missing.ok).toBe(false);
    expect(missing.reason).toBe("password_missing");

    const mismatch = await authorizeGatewayConnect({
      auth: { mode: "password", password: "secret", allowTailscale: false },
      connectAuth: { password: "wrong" },
    });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.reason).toBe("password_mismatch");
  });

  it("reports missing password config reason", async () => {
    const res = await authorizeGatewayConnect({
      auth: { mode: "password", allowTailscale: false },
      connectAuth: { password: "secret" },
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("password_missing_config");
  });

  it("treats local tailscale serve hostnames as direct", async () => {
    const res = await authorizeGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: true },
      connectAuth: { token: "secret" },
      req: {
        socket: { remoteAddress: "127.0.0.1" },
        headers: { host: "gateway.tailnet-1234.ts.net:443" },
      } as never,
    });

    expect(res.ok).toBe(true);
    expect(res.method).toBe("token");
  });

  it("allows tailscale identity to satisfy token mode auth", async () => {
    const res = await authorizeGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: true },
      connectAuth: null,
      tailscaleWhois: async () => ({ login: "peter", name: "Peter" }),
      req: {
        socket: { remoteAddress: "127.0.0.1" },
        headers: {
          host: "gateway.local",
          "x-forwarded-for": "100.64.0.1",
          "x-forwarded-proto": "https",
          "x-forwarded-host": "ai-hub.bone-egret.ts.net",
          "tailscale-user-login": "peter",
          "tailscale-user-name": "Peter",
        },
      } as never,
    });

    expect(res.ok).toBe(true);
    expect(res.method).toBe("tailscale");
    expect(res.user).toBe("peter");
  });

  it("uses proxy-aware request client IP by default for rate-limit checks", async () => {
    const limiter = createLimiterSpy();
    const res = await authorizeGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: false },
      connectAuth: { token: "wrong" },
      req: {
        socket: { remoteAddress: "127.0.0.1" },
        headers: { "x-forwarded-for": "203.0.113.10" },
      } as never,
      trustedProxies: ["127.0.0.1"],
      rateLimiter: limiter,
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("token_mismatch");
    expect(limiter.check).toHaveBeenCalledWith("203.0.113.10", "shared-secret");
    expect(limiter.recordFailure).toHaveBeenCalledWith("203.0.113.10", "shared-secret");
  });

  it("passes custom rate-limit scope to limiter operations", async () => {
    const limiter = createLimiterSpy();
    const res = await authorizeGatewayConnect({
      auth: { mode: "password", password: "secret", allowTailscale: false },
      connectAuth: { password: "wrong" },
      rateLimiter: limiter,
      rateLimitScope: "custom-scope",
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("password_mismatch");
    expect(limiter.check).toHaveBeenCalledWith(undefined, "custom-scope");
    expect(limiter.recordFailure).toHaveBeenCalledWith(undefined, "custom-scope");
  });
});

describe("trusted-proxy auth", () => {
  const trustedProxyConfig = {
    userHeader: "x-forwarded-user",
    requiredHeaders: ["x-forwarded-proto"],
    allowUsers: [],
  };

  it("accepts valid request from trusted proxy", async () => {
    const res = await authorizeGatewayConnect({
      auth: {
        mode: "trusted-proxy",
        allowTailscale: false,
        trustedProxy: trustedProxyConfig,
      },
      connectAuth: null,
      trustedProxies: ["10.0.0.1"],
      req: {
        socket: { remoteAddress: "10.0.0.1" },
        headers: {
          host: "gateway.local",
          "x-forwarded-user": "nick@example.com",
          "x-forwarded-proto": "https",
        },
      } as never,
    });

    expect(res.ok).toBe(true);
    expect(res.method).toBe("trusted-proxy");
    expect(res.user).toBe("nick@example.com");
  });

  it("rejects request from untrusted source", async () => {
    const res = await authorizeGatewayConnect({
      auth: {
        mode: "trusted-proxy",
        allowTailscale: false,
        trustedProxy: trustedProxyConfig,
      },
      connectAuth: null,
      trustedProxies: ["10.0.0.1"],
      req: {
        socket: { remoteAddress: "192.168.1.100" },
        headers: {
          host: "gateway.local",
          "x-forwarded-user": "attacker@evil.com",
          "x-forwarded-proto": "https",
        },
      } as never,
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("trusted_proxy_untrusted_source");
  });

  it("rejects request with missing user header", async () => {
    const res = await authorizeGatewayConnect({
      auth: {
        mode: "trusted-proxy",
        allowTailscale: false,
        trustedProxy: trustedProxyConfig,
      },
      connectAuth: null,
      trustedProxies: ["10.0.0.1"],
      req: {
        socket: { remoteAddress: "10.0.0.1" },
        headers: {
          host: "gateway.local",
          "x-forwarded-proto": "https",
          // missing x-forwarded-user
        },
      } as never,
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("trusted_proxy_user_missing");
  });

  it("rejects request with missing required headers", async () => {
    const res = await authorizeGatewayConnect({
      auth: {
        mode: "trusted-proxy",
        allowTailscale: false,
        trustedProxy: trustedProxyConfig,
      },
      connectAuth: null,
      trustedProxies: ["10.0.0.1"],
      req: {
        socket: { remoteAddress: "10.0.0.1" },
        headers: {
          host: "gateway.local",
          "x-forwarded-user": "nick@example.com",
          // missing x-forwarded-proto
        },
      } as never,
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("trusted_proxy_missing_header_x-forwarded-proto");
  });

  it("rejects user not in allowlist", async () => {
    const res = await authorizeGatewayConnect({
      auth: {
        mode: "trusted-proxy",
        allowTailscale: false,
        trustedProxy: {
          userHeader: "x-forwarded-user",
          allowUsers: ["admin@example.com", "nick@example.com"],
        },
      },
      connectAuth: null,
      trustedProxies: ["10.0.0.1"],
      req: {
        socket: { remoteAddress: "10.0.0.1" },
        headers: {
          host: "gateway.local",
          "x-forwarded-user": "stranger@other.com",
        },
      } as never,
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("trusted_proxy_user_not_allowed");
  });

  it("accepts user in allowlist", async () => {
    const res = await authorizeGatewayConnect({
      auth: {
        mode: "trusted-proxy",
        allowTailscale: false,
        trustedProxy: {
          userHeader: "x-forwarded-user",
          allowUsers: ["admin@example.com", "nick@example.com"],
        },
      },
      connectAuth: null,
      trustedProxies: ["10.0.0.1"],
      req: {
        socket: { remoteAddress: "10.0.0.1" },
        headers: {
          host: "gateway.local",
          "x-forwarded-user": "nick@example.com",
        },
      } as never,
    });

    expect(res.ok).toBe(true);
    expect(res.method).toBe("trusted-proxy");
    expect(res.user).toBe("nick@example.com");
  });

  it("rejects when no trustedProxies configured", async () => {
    const res = await authorizeGatewayConnect({
      auth: {
        mode: "trusted-proxy",
        allowTailscale: false,
        trustedProxy: trustedProxyConfig,
      },
      connectAuth: null,
      trustedProxies: [],
      req: {
        socket: { remoteAddress: "10.0.0.1" },
        headers: {
          host: "gateway.local",
          "x-forwarded-user": "nick@example.com",
        },
      } as never,
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("trusted_proxy_no_proxies_configured");
  });

  it("rejects when trustedProxy config missing", async () => {
    const res = await authorizeGatewayConnect({
      auth: {
        mode: "trusted-proxy",
        allowTailscale: false,
        // trustedProxy missing
      },
      connectAuth: null,
      trustedProxies: ["10.0.0.1"],
      req: {
        socket: { remoteAddress: "10.0.0.1" },
        headers: {
          host: "gateway.local",
          "x-forwarded-user": "nick@example.com",
        },
      } as never,
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("trusted_proxy_config_missing");
  });

  it("supports Pomerium-style headers", async () => {
    const res = await authorizeGatewayConnect({
      auth: {
        mode: "trusted-proxy",
        allowTailscale: false,
        trustedProxy: {
          userHeader: "x-pomerium-claim-email",
          requiredHeaders: ["x-pomerium-jwt-assertion"],
        },
      },
      connectAuth: null,
      trustedProxies: ["172.17.0.1"],
      req: {
        socket: { remoteAddress: "172.17.0.1" },
        headers: {
          host: "gateway.local",
          "x-pomerium-claim-email": "nick@example.com",
          "x-pomerium-jwt-assertion": "eyJ...",
        },
      } as never,
    });

    expect(res.ok).toBe(true);
    expect(res.method).toBe("trusted-proxy");
    expect(res.user).toBe("nick@example.com");
  });

  it("trims whitespace from user header value", async () => {
    const res = await authorizeGatewayConnect({
      auth: {
        mode: "trusted-proxy",
        allowTailscale: false,
        trustedProxy: {
          userHeader: "x-forwarded-user",
        },
      },
      connectAuth: null,
      trustedProxies: ["10.0.0.1"],
      req: {
        socket: { remoteAddress: "10.0.0.1" },
        headers: {
          host: "gateway.local",
          "x-forwarded-user": "  nick@example.com  ",
        },
      } as never,
    });

    expect(res.ok).toBe(true);
    expect(res.user).toBe("nick@example.com");
  });
});
