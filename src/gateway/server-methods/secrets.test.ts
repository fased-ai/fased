import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getMutatingAdminRpcAuditHistorySnapshot,
  resetMutatingAdminRpcAuditHistoryForTest,
} from "./mutating-admin-rpc-audit.js";
import { createSecretsHandlers } from "./secrets.js";

describe("secrets handlers", () => {
  beforeEach(() => {
    resetMutatingAdminRpcAuditHistoryForTest();
  });

  it("responds with warning count on successful reload", async () => {
    const handlers = createSecretsHandlers({
      reloadSecrets: vi.fn().mockResolvedValue({ warningCount: 2 }),
    });
    const respond = vi.fn();
    await handlers["secrets.reload"]({
      req: { type: "req", id: "1", method: "secrets.reload" },
      params: {},
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {} as never,
    });
    expect(respond).toHaveBeenCalledWith(true, { ok: true, warningCount: 2 });
    expect(getMutatingAdminRpcAuditHistorySnapshot({ method: "secrets.reload" }).events).toEqual([
      expect.objectContaining({
        method: "secrets.reload",
        outcome: "succeeded",
        details: { warningCount: "2" },
      }),
    ]);
  });

  it("returns unavailable when reload fails", async () => {
    const handlers = createSecretsHandlers({
      reloadSecrets: vi.fn().mockRejectedValue(new Error("SENTINEL_SECRET_DETAIL")),
    });
    const respond = vi.fn();
    await handlers["secrets.reload"]({
      req: { type: "req", id: "1", method: "secrets.reload" },
      params: {},
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {} as never,
    });
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        message: expect.not.stringContaining("SENTINEL_SECRET_DETAIL"),
        details: { code: "SECRETS_RELOAD_FAILED" },
        retryable: true,
      }),
    );
    const audit = getMutatingAdminRpcAuditHistorySnapshot({ method: "secrets.reload" });
    expect(audit.events).toEqual([
      expect.objectContaining({
        method: "secrets.reload",
        outcome: "failed",
        details: { code: "SECRETS_RELOAD_FAILED" },
      }),
    ]);
    expect(JSON.stringify(audit)).not.toContain("SENTINEL_SECRET_DETAIL");
  });
});
