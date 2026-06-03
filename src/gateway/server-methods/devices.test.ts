import { beforeEach, describe, expect, it, vi } from "vitest";
import { deviceHandlers } from "./devices.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const rotateDeviceTokenMock = vi.hoisted(() => vi.fn());

vi.mock("../../infra/device-pairing.js", () => ({
  approveDevicePairing: vi.fn(),
  listDevicePairing: vi.fn(),
  removePairedDevice: vi.fn(),
  rejectDevicePairing: vi.fn(),
  revokeDeviceToken: vi.fn(),
  rotateDeviceToken: rotateDeviceTokenMock,
  summarizeDeviceTokens: vi.fn((tokens) => tokens ?? {}),
}));

function createRotateOptions(params: Record<string, unknown>, callerDeviceId?: string) {
  const respond = vi.fn();
  const opts = {
    req: { id: "req-1", type: "request", method: "device.token.rotate", params },
    params,
    client: callerDeviceId
      ? {
          connect: {
            minProtocol: 1,
            maxProtocol: 1,
            client: {
              id: "test-client",
              version: "test",
              platform: "test",
              mode: "control-ui",
            },
            device: {
              id: callerDeviceId,
              publicKey: "public-key",
              signature: "signature",
              signedAt: 1,
              nonce: "nonce",
            },
          },
        }
      : null,
    isWebchatConnect: vi.fn(() => false),
    respond,
    context: {
      logGateway: {
        info: vi.fn(),
      },
    },
  } as unknown as GatewayRequestHandlerOptions;
  return { opts, respond };
}

describe("deviceHandlers", () => {
  beforeEach(() => {
    rotateDeviceTokenMock.mockReset();
    rotateDeviceTokenMock.mockResolvedValue({
      role: "operator",
      token: "rotated-token",
      scopes: ["operator.pairing"],
      createdAtMs: 100,
      rotatedAtMs: 200,
    });
  });

  it("returns a rotated token when the caller rotates its own device token", async () => {
    const { opts, respond } = createRotateOptions(
      {
        deviceId: "device-1",
        role: "operator",
        scopes: ["operator.pairing"],
      },
      "device-1",
    );

    await deviceHandlers["device.token.rotate"]?.(opts);

    expect(respond).toHaveBeenCalledWith(
      true,
      {
        deviceId: "device-1",
        role: "operator",
        token: "rotated-token",
        scopes: ["operator.pairing"],
        rotatedAtMs: 200,
      },
      undefined,
    );
  });

  it("omits a rotated token when the caller rotates another device token", async () => {
    const { opts, respond } = createRotateOptions(
      {
        deviceId: "device-1",
        role: "operator",
        scopes: ["operator.pairing"],
      },
      "admin-device",
    );

    await deviceHandlers["device.token.rotate"]?.(opts);

    expect(respond).toHaveBeenCalledWith(
      true,
      {
        deviceId: "device-1",
        role: "operator",
        scopes: ["operator.pairing"],
        rotatedAtMs: 200,
      },
      undefined,
    );
  });
});
