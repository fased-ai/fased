import { beforeEach, describe, expect, it, vi } from "vitest";

const probeGateway = vi.hoisted(() => vi.fn());

vi.mock("../../gateway/probe.js", () => ({ probeGateway }));

import { verifyGatewayRuntimeVersion } from "./update-command.js";

const rpc = { url: "ws://127.0.0.1:18789", timeoutMs: 1_000 };

describe("update gateway version contract", () => {
  beforeEach(() => probeGateway.mockReset());

  it("accepts only the exact installed target version", async () => {
    probeGateway.mockResolvedValue({ ok: true, server: { version: "0.1.54" } });

    await expect(verifyGatewayRuntimeVersion({ expectedVersion: "0.1.54", rpc })).resolves.toEqual({
      ok: true,
      actualVersion: "0.1.54",
    });
  });

  it("rejects a healthy but stale gateway runtime", async () => {
    probeGateway.mockResolvedValue({ ok: true, server: { version: "0.1.53" } });

    await expect(
      verifyGatewayRuntimeVersion({ expectedVersion: "0.1.54", rpc }),
    ).resolves.toMatchObject({
      ok: false,
      actualVersion: "0.1.53",
      error: expect.stringContaining("does not match installed version 0.1.54"),
    });
  });

  it("rejects an unreachable gateway even when it reports a version", async () => {
    probeGateway.mockResolvedValue({
      ok: false,
      error: "gateway timeout",
      server: { version: "0.1.54" },
    });

    await expect(verifyGatewayRuntimeVersion({ expectedVersion: "0.1.54", rpc })).resolves.toEqual({
      ok: false,
      actualVersion: "0.1.54",
      error: "gateway timeout",
    });
  });
});
