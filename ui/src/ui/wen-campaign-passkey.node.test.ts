import { afterEach, expect, it, vi } from "vitest";
import { authorizeSignerReviewWithPasskey } from "./wallet-passkey.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function setup() {
  const bytes = (v: number) => new Uint8Array([v]).buffer;
  const get = vi.fn(async (_request: CredentialRequestOptions) => ({
    id: "AQ",
    rawId: bytes(1),
    response: {
      clientDataJSON: bytes(2),
      authenticatorData: bytes(3),
      signature: bytes(4),
      userHandle: null,
    },
    getClientExtensionResults: () => ({}),
  }));
  vi.stubGlobal("window", {
    isSecureContext: true,
    PublicKeyCredential: class {},
    location: { origin: "https://localhost", hostname: "localhost" },
  });
  vi.stubGlobal("navigator", { credentials: { get } });
  const until = new Date(Date.now() + 60000).toISOString();
  const challenge = {
    challengeId: "campaign-challenge",
    expiresAt: until,
    binding: { expiresAt: until },
    options: {
      publicKey: {
        challenge: "BQ",
        rpId: "localhost",
        allowCredentials: [{ id: "AQ", type: "public-key" }],
        userVerification: "required",
      },
    },
  };
  return { get, challenge };
}
it("uses the actual passkey bridge to decode options and serialize the campaign assertion", async () => {
  const f = setup(),
    controller = new AbortController();
  const result = await authorizeSignerReviewWithPasskey(f.challenge, controller.signal);
  const request = f.get.mock.calls[0][0];
  expect(request.signal).toBe(controller.signal);
  expect(new Uint8Array(request.publicKey!.challenge as ArrayBuffer)).toEqual(new Uint8Array([5]));
  expect(request.publicKey!.userVerification).toBe("required");
  expect(result).toEqual({
    challengeId: "campaign-challenge",
    credential: {
      id: "AQ",
      rawId: "AQ",
      type: "public-key",
      response: { clientDataJSON: "Ag", authenticatorData: "Aw", signature: "BA" },
      clientExtensionResults: {},
    },
  });
});
it("rejects invalid campaign passkey options before accessing credentials", async () => {
  const f = setup();
  await expect(authorizeSignerReviewWithPasskey({ ...f.challenge, options: {} })).rejects.toThrow();
  expect(f.get).not.toHaveBeenCalled();
});
it("propagates browser cancellation without returning an assertion", async () => {
  const f = setup();
  f.get.mockRejectedValueOnce(new DOMException("Canceled", "NotAllowedError"));
  await expect(authorizeSignerReviewWithPasskey(f.challenge)).rejects.toThrow("Canceled");
  expect(f.get).toHaveBeenCalledOnce();
});
