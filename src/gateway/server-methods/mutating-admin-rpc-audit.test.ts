import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatMutatingAdminRpcAuditLine,
  getMutatingAdminRpcAuditHistorySnapshot,
  logMutatingAdminRpcAudit,
  resetMutatingAdminRpcAuditHistoryForTest,
} from "./mutating-admin-rpc-audit.js";

function makeContext() {
  return {
    logGateway: {
      info: vi.fn(),
    },
  };
}

describe("mutating admin RPC audit formatting", () => {
  beforeEach(() => {
    resetMutatingAdminRpcAuditHistoryForTest();
  });

  it("includes actor and selected safe details", () => {
    expect(
      formatMutatingAdminRpcAuditLine({
        method: "push.test",
        outcome: "succeeded",
        client: {
          connId: "conn-1",
          clientIp: "127.0.0.1",
          connect: {
            client: { id: "dashboard" },
            device: { id: "operator-laptop" },
          },
        } as never,
        details: {
          nodeId: "ios-node-1",
          environment: "sandbox",
          status: 200,
        },
      }),
    ).toBe(
      "security audit: mutating-admin-rpc method=push.test outcome=succeeded actor=dashboard device=operator-laptop ip=127.0.0.1 conn=conn-1 environment=sandbox nodeId=ios-node-1 status=200",
    );
  });

  it("redacts fields that could contain message bodies or secrets", () => {
    const line = formatMutatingAdminRpcAuditLine({
      method: "chat.inject",
      outcome: "succeeded",
      client: null,
      details: {
        sessionKey: "main",
        message: "transcript body should not appear",
        title: "push title should not appear",
        body: "push body should not appear",
        token: "apns-token-secret",
        privateKey: "-----BEGIN PRIVATE KEY-----",
        qrPayload: "login-qr-secret",
      },
    });

    expect(line).toContain("message=<redacted>");
    expect(line).toContain("title=<redacted>");
    expect(line).toContain("body=<redacted>");
    expect(line).toContain("token=<redacted>");
    expect(line).toContain("privateKey=<redacted>");
    expect(line).toContain("qrPayload=<redacted>");
    expect(line).not.toContain("transcript body should not appear");
    expect(line).not.toContain("push title should not appear");
    expect(line).not.toContain("push body should not appear");
    expect(line).not.toContain("apns-token-secret");
    expect(line).not.toContain("BEGIN PRIVATE KEY");
    expect(line).not.toContain("login-qr-secret");
  });

  it("records sanitized bounded history for dashboard inspection", () => {
    const context = makeContext();

    logMutatingAdminRpcAudit({
      context: context as never,
      method: "push.test",
      outcome: "denied",
      client: {
        connId: "conn-1",
        clientIp: "127.0.0.1",
        connect: {
          client: { id: "dashboard" },
          device: { id: "operator-laptop" },
        },
      } as never,
      details: {
        nodeId: "ios-node-1",
        reason: "rate_limited",
        retryAfterMs: 1234,
        limit: "3 per 60s",
        title: "secret title",
        body: "secret body",
        token: "secret-token",
      },
    });
    logMutatingAdminRpcAudit({
      context: context as never,
      method: "chat.inject",
      outcome: "succeeded",
      client: null,
      details: { sessionKey: "main", message: "secret transcript" },
    });

    const snapshot = getMutatingAdminRpcAuditHistorySnapshot({
      method: "push.test",
      limit: 10,
    });

    expect(snapshot.count).toBe(1);
    expect(snapshot.events).toHaveLength(1);
    expect(snapshot.events[0]).toMatchObject({
      seq: 1,
      method: "push.test",
      outcome: "denied",
      actor: "dashboard",
      deviceId: "operator-laptop",
      clientIp: "127.0.0.1",
      connId: "conn-1",
      details: {
        nodeId: "ios-node-1",
        reason: "rate_limited",
        retryAfterMs: "1234",
        limit: "3_per_60s",
        title: "<redacted>",
        body: "<redacted>",
        token: "<redacted>",
      },
    });
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("secret title");
    expect(serialized).not.toContain("secret body");
    expect(serialized).not.toContain("secret-token");
    expect(serialized).not.toContain("secret transcript");
  });
});
