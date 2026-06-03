import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __testing as mutatingAdminRateLimitTesting,
  resolveMutatingAdminRpcRateLimitKey,
} from "./mutating-admin-rpc-rate-limit.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayRequestHandler } from "./server-methods/types.js";

const noWebchat = () => false;

const limits = [
  { method: "chat.inject", allowed: 10, windowMs: 60_000 },
  { method: "push.test", allowed: 3, windowMs: 60_000 },
  { method: "web.login.start", allowed: 3, windowMs: 300_000 },
  { method: "web.login.wait", allowed: 12, windowMs: 300_000 },
] as const;

describe("gateway mutating admin RPC rate limit", () => {
  beforeEach(() => {
    mutatingAdminRateLimitTesting.resetMutatingAdminRpcRateLimitState();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    mutatingAdminRateLimitTesting.resetMutatingAdminRpcRateLimitState();
  });

  function buildContext(logWarn = vi.fn(), logInfo = vi.fn()) {
    return {
      logGateway: {
        warn: logWarn,
        info: logInfo,
      },
    } as unknown as Parameters<typeof handleGatewayRequest>[0]["context"];
  }

  function buildConnect(): NonNullable<
    Parameters<typeof handleGatewayRequest>[0]["client"]
  >["connect"] {
    return {
      role: "operator",
      scopes: ["operator.admin"],
      client: {
        id: "fased-control-ui",
        version: "1.0.0",
        platform: "darwin",
        mode: "ui",
      },
      device: {
        id: "operator-laptop",
        publicKey: "pk",
        signature: "sig",
        signedAt: 1,
        nonce: "nonce",
      },
      minProtocol: 1,
      maxProtocol: 1,
    };
  }

  function buildClient() {
    return {
      connect: buildConnect(),
      connId: "conn-1",
      clientIp: "10.0.0.5",
    } as Parameters<typeof handleGatewayRequest>[0]["client"];
  }

  async function runRequest(params: {
    method: string;
    context: Parameters<typeof handleGatewayRequest>[0]["context"];
    client: Parameters<typeof handleGatewayRequest>[0]["client"];
    handler?: GatewayRequestHandler;
    requestParams?: Record<string, unknown>;
  }) {
    const respond = vi.fn();
    const handler: GatewayRequestHandler =
      params.handler ??
      ((opts) => {
        opts.respond(true, { ok: true }, undefined);
      });
    await handleGatewayRequest({
      req: {
        type: "req",
        id: crypto.randomUUID(),
        method: params.method,
        params: params.requestParams,
      },
      respond,
      client: params.client,
      isWebchatConnect: noWebchat,
      context: params.context,
      extraHandlers: {
        [params.method]: handler,
      },
    });
    return respond;
  }

  it.each(limits)("blocks $method after its method-specific budget", async (limit) => {
    const handlerCalls = vi.fn();
    const handler: GatewayRequestHandler = (opts) => {
      handlerCalls(opts);
      opts.respond(true, { ok: true }, undefined);
    };
    const logWarn = vi.fn();
    const logInfo = vi.fn();
    const context = buildContext(logWarn, logInfo);
    const client = buildClient();

    for (let index = 0; index < limit.allowed; index += 1) {
      const allowed = await runRequest({ method: limit.method, context, client, handler });
      expect(allowed).toHaveBeenCalledWith(true, { ok: true }, undefined);
    }
    const blocked = await runRequest({
      method: limit.method,
      context,
      client,
      handler,
      requestParams: {
        message: "secret transcript body",
        title: "secret push title",
        body: "secret push body",
        token: "secret-token",
        qrPayload: "secret-qr",
      },
    });

    expect(handlerCalls).toHaveBeenCalledTimes(limit.allowed);
    expect(blocked).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        retryable: true,
      }),
    );
    expect(logWarn).toHaveBeenCalledWith(
      expect.stringContaining(`mutating admin RPC rate-limited method=${limit.method}`),
    );
    const auditLine = String(logInfo.mock.calls.at(-1)?.[0] ?? "");
    expect(auditLine).toContain(`method=${limit.method}`);
    expect(auditLine).toContain("outcome=denied");
    expect(auditLine).toContain("reason=rate_limited");
    expect(auditLine).not.toContain("secret transcript body");
    expect(auditLine).not.toContain("secret push title");
    expect(auditLine).not.toContain("secret push body");
    expect(auditLine).not.toContain("secret-token");
    expect(auditLine).not.toContain("secret-qr");
  });

  it("resets each method budget after its configured window", async () => {
    const context = buildContext();
    const client = buildClient();

    await runRequest({ method: "push.test", context, client });
    await runRequest({ method: "push.test", context, client });
    await runRequest({ method: "push.test", context, client });
    const blocked = await runRequest({ method: "push.test", context, client });
    expect(blocked).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE" }),
    );

    vi.advanceTimersByTime(60_001);

    const allowed = await runRequest({ method: "push.test", context, client });
    expect(allowed).toHaveBeenCalledWith(true, { ok: true }, undefined);
  });

  it("keeps method budgets separate for the same actor", async () => {
    const context = buildContext();
    const client = buildClient();

    await runRequest({ method: "push.test", context, client });
    await runRequest({ method: "push.test", context, client });
    await runRequest({ method: "push.test", context, client });
    const blockedPush = await runRequest({ method: "push.test", context, client });
    expect(blockedPush).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE" }),
    );

    const chat = await runRequest({ method: "chat.inject", context, client });
    expect(chat).toHaveBeenCalledWith(true, { ok: true }, undefined);
  });

  it("uses connId fallback when device and client IP are unavailable", () => {
    expect(
      resolveMutatingAdminRpcRateLimitKey({
        method: "chat.inject",
        client: {
          connect: { role: "operator", scopes: ["operator.admin"] },
          connId: "conn-fallback",
        } as never,
      }),
    ).toBe("chat.inject|unknown-device|unknown-ip|conn=conn-fallback");
  });
});
