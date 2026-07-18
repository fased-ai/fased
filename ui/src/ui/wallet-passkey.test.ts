import { afterEach, describe, expect, it, vi } from "vitest";
import {
  signerAuthorizationMatchesWalletApproval,
  type WalletSendApprovalRequest,
  type WalletSignerReviewAuthorizationBegin,
} from "./wallet-api.ts";
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
        walletPublicKey: "So11111111111111111111111111111111111111112",
        intentType: "solana.nativeTransfer",
        intentDigest: `sha256:${"a".repeat(64)}`,
        semanticIntent: {
          type: "solana.nativeTransfer",
          destination: "So11111111111111111111111111111111111111112",
          lamports: "500000000",
        },
        artifactKind: "solana-transaction",
        artifactDigest: `sha256:${"b".repeat(64)}`,
        transactionDigest: `sha256:${"b".repeat(64)}`,
        asset: "solana:native",
        amount: "500000000",
        destination: "So11111111111111111111111111111111111111112",
        policyOperation: "solana.nativeTransfer",
        requiredPrograms: ["11111111111111111111111111111111"],
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

  it("rejects any changed field in an exact domain-message approval binding", () => {
    const programs = ["domain:fased:federation-bond-challenge-v1"];
    const semanticIntent = {
      type: "federation.bondChallenge",
      federation: {
        challengeId: "challenge-1",
        federationOrigin: "https://federation.example.test",
        handle: "@vault@example.test",
        nodeId: "node-1",
        tokenId: "token-1",
        bondId: "bond-1",
        tier: "basic-bond",
        expiresAt: "2026-07-16T12:02:00.000Z",
        payloadBase64: "Y2hhbGxlbmdl",
      },
    };
    const request = {
      id: "federation-review-1",
      createdAt: "2026-07-16T12:00:00.000Z",
      expiresAt: "2026-07-16T12:02:00.000Z",
      status: "pending",
      requestedBy: "federation-bond",
      payload: {
        chain: "solana",
        actionKind: "signer_review",
        providerId: "local-socket-signer",
        walletId: "vault-friendly-name",
        signerReviewId: "federation-review-1",
        signerWalletId: "vault_friendly_name",
        signerWalletPublicKey: "Vault11111111111111111111111111111111111111",
        signerIntentType: "federation.bondChallenge",
        signerPolicyHash: `sha256:${"a".repeat(64)}`,
        signerIntentDigest: `sha256:${"b".repeat(64)}`,
        signerSemanticIntent: structuredClone(semanticIntent),
        signerArtifactKind: "domain-separated-message",
        signerArtifactDigest: `sha256:${"c".repeat(64)}`,
        signerAsset: "federation:bond-challenge",
        signerAmount: "1",
        signerDestination: "Vault11111111111111111111111111111111111111",
        signerPolicyOperation: "federation.bondChallenge",
        signerRequiredPrograms: programs,
        signerRequiredRole: "vault",
        signerNonce: "d".repeat(64),
        signerIssuedAt: "2026-07-16T12:00:00.000Z",
        signerReviewExpiresAt: "2026-07-16T12:02:00.000Z",
      },
    } satisfies WalletSendApprovalRequest;
    const authorization = {
      challengeId: "challenge-1",
      expiresAt: request.expiresAt,
      binding: {
        requestId: request.id,
        walletId: "vault_friendly_name",
        role: "vault",
        walletPublicKey: request.payload.signerWalletPublicKey,
        intentType: "federation.bondChallenge",
        intentDigest: request.payload.signerIntentDigest,
        semanticIntent: structuredClone(semanticIntent),
        artifactKind: "domain-separated-message",
        artifactDigest: request.payload.signerArtifactDigest,
        asset: "federation:bond-challenge",
        amount: "1",
        destination: request.payload.signerDestination,
        policyOperation: "federation.bondChallenge",
        requiredPrograms: programs,
        policyHash: request.payload.signerPolicyHash,
        nonce: request.payload.signerNonce,
        issuedAt: request.payload.signerIssuedAt,
        expiresAt: request.payload.signerReviewExpiresAt,
      },
      options: {},
    } satisfies WalletSignerReviewAuthorizationBegin;

    expect(signerAuthorizationMatchesWalletApproval(authorization, request)).toBe(true);
    expect(
      signerAuthorizationMatchesWalletApproval(
        { ...authorization, binding: { ...authorization.binding, amount: "2" } },
        request,
      ),
    ).toBe(false);
    expect(
      signerAuthorizationMatchesWalletApproval(
        {
          ...authorization,
          binding: { ...authorization.binding, walletId: request.payload.walletId },
        },
        request,
      ),
    ).toBe(false);
    expect(
      signerAuthorizationMatchesWalletApproval(
        {
          ...authorization,
          binding: {
            ...authorization.binding,
            semanticIntent: {
              ...semanticIntent,
              federation: { ...semanticIntent.federation, bondId: "different-bond" },
            },
          },
        },
        request,
      ),
    ).toBe(false);
  });
});
