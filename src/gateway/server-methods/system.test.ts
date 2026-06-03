import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadOrCreateDeviceIdentity: vi.fn(),
  publicKeyRawBase64UrlFromPem: vi.fn(),
}));

vi.mock("../../infra/device-identity.js", () => ({
  loadOrCreateDeviceIdentity: mocks.loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem: mocks.publicKeyRawBase64UrlFromPem,
}));

describe("gateway.identity.get", () => {
  beforeEach(() => {
    mocks.loadOrCreateDeviceIdentity.mockReset();
    mocks.publicKeyRawBase64UrlFromPem.mockReset();
    mocks.loadOrCreateDeviceIdentity.mockReturnValue({
      deviceId: "device-123",
      publicKeyPem: "PUBLIC-KEY-PEM",
      privateKeyPem: "PRIVATE-KEY-PEM",
    });
    mocks.publicKeyRawBase64UrlFromPem.mockReturnValue("public-key-raw");
  });

  it("returns public gateway identity without exposing private key material", async () => {
    const { systemHandlers } = await import("./system.js");
    let payload: unknown;

    await systemHandlers["gateway.identity.get"]({
      params: {},
      respond: (_ok: boolean, response: unknown) => {
        payload = response;
      },
    } as never);

    expect(mocks.loadOrCreateDeviceIdentity).toHaveBeenCalledOnce();
    expect(mocks.publicKeyRawBase64UrlFromPem).toHaveBeenCalledWith("PUBLIC-KEY-PEM");
    expect(payload).toEqual({
      deviceId: "device-123",
      publicKey: "public-key-raw",
    });
    expect(JSON.stringify(payload)).not.toContain("PRIVATE");
  });
});
