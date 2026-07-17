import { afterEach, describe, expect, it, vi } from "vitest";
import { authorizeSignerReviewWithPasskey } from "./wallet-passkey.ts";

function stubBrowserCapabilities(params: {
  secureContext: boolean;
  publicKeyCredential?: unknown;
  credentials?: unknown;
}) {
  vi.stubGlobal("window", {
    isSecureContext: params.secureContext,
    PublicKeyCredential: params.publicKeyCredential,
    location: { origin: "http://localhost:18789", hostname: "localhost" },
  });
  vi.stubGlobal("isSecureContext", params.secureContext);
  vi.stubGlobal("PublicKeyCredential", params.publicKeyCredential);
  vi.stubGlobal(
    "navigator",
    params.credentials === undefined ? {} : { credentials: params.credentials },
  );
}

function bufferSourceBytes(value: BufferSource | undefined): number[] {
  if (!value) {
    return [];
  }
  if (value instanceof ArrayBuffer) {
    return Array.from(new Uint8Array(value));
  }
  return Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
}

describe("signer-owned wallet WebAuthn", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses signer options for WebAuthn and serializes only the opaque assertion", async () => {
    const get = vi.fn(async (_options: CredentialRequestOptions) => ({
      id: "credential-123",
      rawId: Uint8Array.from([4, 5, 6]).buffer,
      type: "public-key",
      authenticatorAttachment: "platform",
      response: {
        clientDataJSON: Uint8Array.from([1, 2]).buffer,
        authenticatorData: Uint8Array.from([3, 4]).buffer,
        signature: Uint8Array.from([5, 6]).buffer,
        userHandle: Uint8Array.from([7]).buffer,
      },
      getClientExtensionResults: () => ({ credProps: { rk: true } }),
    }));
    stubBrowserCapabilities({
      secureContext: true,
      publicKeyCredential: class {},
      credentials: { get },
    });
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const result = await authorizeSignerReviewWithPasskey({
      challengeId: "challenge-123",
      expiresAt,
      binding: {
        requestId: "review-123",
        walletId: "vault-1",
        role: "vault",
        intentType: "solana.nativeTransfer",
        intentDigest: `sha256:${"a".repeat(64)}`,
        semanticIntent: {
          type: "solana.nativeTransfer",
          destination: "So11111111111111111111111111111111111111112",
          lamports: "500000000",
        },
        transactionDigest: `sha256:${"b".repeat(64)}`,
        policyHash: `sha256:${"c".repeat(64)}`,
        nonce: "d".repeat(64),
        issuedAt: new Date().toISOString(),
        expiresAt,
      },
      options: {
        publicKey: {
          challenge: "AQID",
          rpId: "localhost",
          allowCredentials: [{ type: "public-key", id: "BAUG", transports: ["internal"] }],
          userVerification: "required",
          timeout: 45_000,
        },
      },
    });

    expect(get).toHaveBeenCalledTimes(1);
    const options = get.mock.calls[0]?.[0];
    expect(bufferSourceBytes(options?.publicKey?.challenge)).toEqual([1, 2, 3]);
    expect(bufferSourceBytes(options?.publicKey?.allowCredentials?.[0]?.id)).toEqual([4, 5, 6]);
    expect(options.publicKey).toMatchObject({
      rpId: "localhost",
      userVerification: "required",
      timeout: 45_000,
    });
    expect(result).toEqual({
      challengeId: "challenge-123",
      credential: {
        id: "credential-123",
        rawId: "BAUG",
        type: "public-key",
        response: {
          clientDataJSON: "AQI",
          authenticatorData: "AwQ",
          signature: "BQY",
          userHandle: "Bw",
        },
        clientExtensionResults: { credProps: { rk: true } },
        authenticatorAttachment: "platform",
      },
    });
  });
});
