import { beforeEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";

const callGateway = vi.hoisted(() => vi.fn());

vi.mock("../../gateway/call.js", () => ({
  callGateway: (options: unknown) => callGateway(options),
}));

import { probeGatewayStatus } from "./probe.js";

describe("probeGatewayStatus", () => {
  beforeEach(() => {
    callGateway.mockReset();
    callGateway.mockResolvedValue({});
  });

  it("uses silent probe identity during expected restart connection races", async () => {
    await expect(
      probeGatewayStatus({
        url: "ws://127.0.0.1:18789",
        timeoutMs: 1_500,
        json: true,
      }),
    ).resolves.toEqual({ ok: true });

    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        clientName: GATEWAY_CLIENT_NAMES.PROBE,
        mode: GATEWAY_CLIENT_MODES.PROBE,
      }),
    );
  });
});
