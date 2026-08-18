import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  handleGatewayReadinessHttpRequest,
  resolveGatewayProbeStatus,
} from "./readiness-http-service.js";

function createRequest(path: string, method = "GET"): IncomingMessage {
  return { method, url: path } as IncomingMessage;
}

function createResponse(): {
  res: ServerResponse;
  body: () => string;
  end: ReturnType<typeof vi.fn>;
  setHeader: ReturnType<typeof vi.fn>;
} {
  let value = "";
  const setHeader = vi.fn();
  const end = vi.fn((chunk?: unknown) => {
    if (typeof chunk === "string") {
      value += chunk;
    } else if (Buffer.isBuffer(chunk)) {
      value += chunk.toString("utf8");
    }
  });
  const res = {
    statusCode: 200,
    setHeader,
    end,
  } as unknown as ServerResponse;
  return { res, body: () => value, end, setHeader };
}

describe("gateway readiness HTTP service", () => {
  it("recognizes only the four public probe paths", () => {
    expect(resolveGatewayProbeStatus("/health")).toBe("live");
    expect(resolveGatewayProbeStatus("/healthz")).toBe("live");
    expect(resolveGatewayProbeStatus("/ready")).toBe("ready");
    expect(resolveGatewayProbeStatus("/readyz")).toBe("ready");
    expect(resolveGatewayProbeStatus("/health/details")).toBeNull();
  });

  it("leaves unrelated paths untouched", async () => {
    const { res, end } = createResponse();
    const canRevealDetails = vi.fn(() => true);
    const getReadiness = vi.fn(() => ({ ready: true, failing: [], uptimeMs: 1 }));

    await expect(
      handleGatewayReadinessHttpRequest({
        req: createRequest("/other"),
        res,
        requestPath: "/other",
        getReadiness,
        canRevealDetails,
      }),
    ).resolves.toBe(false);
    expect(canRevealDetails).not.toHaveBeenCalled();
    expect(getReadiness).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
  });

  it("keeps liveness shallow and rejects unsupported methods", async () => {
    const live = createResponse();
    const canRevealDetails = vi.fn(() => true);
    const getReadiness = vi.fn(() => ({ ready: false, failing: ["wallet"], uptimeMs: 1 }));

    await handleGatewayReadinessHttpRequest({
      req: createRequest("/healthz"),
      res: live.res,
      requestPath: "/healthz",
      getReadiness,
      canRevealDetails,
    });
    expect(live.res.statusCode).toBe(200);
    expect(JSON.parse(live.body())).toMatchObject({ ok: true, status: "live" });
    expect(canRevealDetails).not.toHaveBeenCalled();
    expect(getReadiness).not.toHaveBeenCalled();

    const unsupported = createResponse();
    await handleGatewayReadinessHttpRequest({
      req: createRequest("/ready", "POST"),
      res: unsupported.res,
      requestPath: "/ready",
      getReadiness,
      canRevealDetails,
    });
    expect(unsupported.res.statusCode).toBe(405);
    expect(unsupported.setHeader).toHaveBeenCalledWith("Allow", "GET, HEAD");
    expect(unsupported.body()).toBe("Method Not Allowed");
  });

  it("returns either redacted or detailed readiness from the same domain result", async () => {
    const getReadiness = () => ({ ready: false, failing: ["wallet"], uptimeMs: 2_000 });
    const redacted = createResponse();
    await handleGatewayReadinessHttpRequest({
      req: createRequest("/ready"),
      res: redacted.res,
      requestPath: "/ready",
      getReadiness,
      canRevealDetails: () => false,
    });
    expect(redacted.res.statusCode).toBe(503);
    expect(JSON.parse(redacted.body())).toEqual({ ready: false });

    const detailed = createResponse();
    await handleGatewayReadinessHttpRequest({
      req: createRequest("/readyz"),
      res: detailed.res,
      requestPath: "/readyz",
      getReadiness,
      canRevealDetails: () => true,
    });
    expect(detailed.res.statusCode).toBe(503);
    expect(JSON.parse(detailed.body())).toMatchObject({
      ok: true,
      status: "ready",
      ready: false,
      failing: ["wallet"],
      uptimeMs: 2_000,
    });
  });

  it("fails closed when readiness evaluation throws and keeps HEAD bodyless", async () => {
    const failed = createResponse();
    await handleGatewayReadinessHttpRequest({
      req: createRequest("/ready"),
      res: failed.res,
      requestPath: "/ready",
      getReadiness: () => {
        throw new Error("sensitive failure");
      },
      canRevealDetails: () => true,
    });
    expect(failed.res.statusCode).toBe(503);
    expect(JSON.parse(failed.body())).toEqual({
      ready: false,
      failing: ["internal"],
      uptimeMs: 0,
    });
    expect(failed.body()).not.toContain("sensitive failure");

    const authorizationFailed = createResponse();
    await handleGatewayReadinessHttpRequest({
      req: createRequest("/ready"),
      res: authorizationFailed.res,
      requestPath: "/ready",
      getReadiness: () => ({ ready: true, failing: [], uptimeMs: 1 }),
      canRevealDetails: () => {
        throw new Error("sensitive authorization failure");
      },
    });
    expect(authorizationFailed.res.statusCode).toBe(503);
    expect(JSON.parse(authorizationFailed.body())).toEqual({ ready: false });
    expect(authorizationFailed.body()).not.toContain("sensitive authorization failure");

    const head = createResponse();
    await handleGatewayReadinessHttpRequest({
      req: createRequest("/readyz", "HEAD"),
      res: head.res,
      requestPath: "/readyz",
      getReadiness: () => ({ ready: true, failing: [], uptimeMs: 1 }),
      canRevealDetails: () => true,
    });
    expect(head.res.statusCode).toBe(200);
    expect(head.body()).toBe("");
  });
});
