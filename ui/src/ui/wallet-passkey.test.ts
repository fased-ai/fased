import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authorizeSignerReviewWithPasskey,
  detectWalletCustodyClientCompatibility,
} from "./wallet-passkey.ts";

class MemoryStorage implements Storage {
  private readonly data = new Map<string, string>();

  get length() {
    return this.data.size;
  }

  clear(): void {
    this.data.clear();
  }

  getItem(key: string): string | null {
    return this.data.has(key) ? (this.data.get(key) ?? null) : null;
  }

  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

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
  vi.stubGlobal("localStorage", new MemoryStorage());
}

describe("detectWalletCustodyClientCompatibility", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports manual-only mode when WebAuthn is unavailable", async () => {
    stubBrowserCapabilities({ secureContext: false });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404 })),
    );

    const result = await detectWalletCustodyClientCompatibility();

    expect(result.secureContext).toBe(false);
    expect(result.webauthn).toBe(false);
    expect(result.storageMode).toBe("manual-share-only");
    expect(result.nativeHelper).toEqual({ status: "unreachable" });
  });

  it("reports encrypted browser storage when PRF support is available", async () => {
    stubBrowserCapabilities({
      secureContext: true,
      publicKeyCredential: {
        getClientCapabilities: vi.fn(async () => ({ prf: true })),
        isConditionalMediationAvailable: vi.fn(async () => true),
        isUserVerifyingPlatformAuthenticatorAvailable: vi.fn(async () => true),
      },
      credentials: {},
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404 })),
    );

    const result = await detectWalletCustodyClientCompatibility();

    expect(result.secureContext).toBe(true);
    expect(result.webauthn).toBe(true);
    expect(result.storageMode).toBe("encrypted-browser-storage");
    expect(result.platformAuthenticator).toBe("supported");
    expect(result.conditionalMediation).toBe("supported");
    expect(result.prf).toBe("supported");
    expect(result.nativeHelper).toEqual({ status: "unreachable" });
  });

  it("reports browser storage as untested when PRF cannot be preflighted", async () => {
    stubBrowserCapabilities({
      secureContext: true,
      publicKeyCredential: {
        isConditionalMediationAvailable: vi.fn(async () => true),
        isUserVerifyingPlatformAuthenticatorAvailable: vi.fn(async () => true),
      },
      credentials: {},
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404 })),
    );

    const result = await detectWalletCustodyClientCompatibility();

    expect(result.storageMode).toBe("encrypted-browser-storage-untested");
    expect(result.prf).toBe("unknown");
    expect(
      result.notes.some((note) =>
        note.includes("first custody unlock with browser storage enabled"),
      ),
    ).toBe(true);
  });

  it("reports native helper availability when the companion responds", async () => {
    stubBrowserCapabilities({
      secureContext: true,
      publicKeyCredential: {
        getClientCapabilities: vi.fn(async () => ({ prf: true })),
        isConditionalMediationAvailable: vi.fn(async () => true),
        isUserVerifyingPlatformAuthenticatorAvailable: vi.fn(async () => true),
      },
      credentials: {},
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          ok: true,
          protocolVersion: 2,
          helper: "fased-macos-custody-companion",
          platform: "macos",
          storageMode: "os-keychain",
          availableRoutes: ["/v1/custody/health"],
          storedWalletCount: 2,
        }),
      })),
    );

    const result = await detectWalletCustodyClientCompatibility();

    expect(result.nativeHelper).toEqual({
      status: "available",
      helper: "fased-macos-custody-companion",
      platform: "macos",
      storageMode: "os-keychain",
      protocolVersion: 2,
      availableRoutes: ["/v1/custody/health"],
      storedWalletCount: 2,
    });
  });

  it("rejects the unauthenticated protocol-v1 helper", async () => {
    stubBrowserCapabilities({ secureContext: false });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          ok: true,
          protocolVersion: 1,
          helper: "fased-native-custody-helper",
          platform: "linux",
          storageMode: "secret-service",
          availableRoutes: [
            "/v1/custody/health",
            "/v1/custody/device-share/status",
            "/v1/custody/device-share/store",
            "/v1/custody/device-share/load",
            "/v1/custody/device-share/delete",
          ],
          storedWalletCount: 1,
        }),
      })),
    );

    const result = await detectWalletCustodyClientCompatibility();

    expect(result.nativeHelper).toEqual({ status: "unreachable" });
  });

  it("reports mock helper availability distinctly from the real macOS helper", async () => {
    stubBrowserCapabilities({
      secureContext: true,
      publicKeyCredential: {
        getClientCapabilities: vi.fn(async () => ({ prf: true })),
        isConditionalMediationAvailable: vi.fn(async () => true),
        isUserVerifyingPlatformAuthenticatorAvailable: vi.fn(async () => true),
      },
      credentials: {},
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          ok: true,
          protocolVersion: 2,
          helper: "fased-wallet-custody-companion-mock",
          platform: "mock",
          storageMode: "mock-memory",
          availableRoutes: ["/v1/custody/health", "/v1/custody/device-share/load"],
          storedWalletCount: 1,
        }),
      })),
    );

    const result = await detectWalletCustodyClientCompatibility();

    expect(result.nativeHelper).toEqual({
      status: "available",
      helper: "fased-wallet-custody-companion-mock",
      platform: "mock",
      storageMode: "mock-memory",
      protocolVersion: 2,
      availableRoutes: ["/v1/custody/health", "/v1/custody/device-share/load"],
      storedWalletCount: 1,
    });
    expect(result.notes.some((note) => note.includes("Mock custody helper detected"))).toBe(true);
  });

  it("reports native helper availability for Linux/Windows storage backends", async () => {
    stubBrowserCapabilities({
      secureContext: true,
      publicKeyCredential: {
        getClientCapabilities: vi.fn(async () => ({ prf: true })),
        isConditionalMediationAvailable: vi.fn(async () => true),
        isUserVerifyingPlatformAuthenticatorAvailable: vi.fn(async () => true),
      },
      credentials: {},
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          ok: true,
          protocolVersion: 2,
          helper: "fased-native-custody-helper",
          platform: "windows",
          storageMode: "windows-dpapi",
          availableRoutes: [
            "/v1/custody/health",
            "/v1/custody/device-share/status",
            "/v1/custody/device-share/store",
            "/v1/custody/device-share/load",
            "/v1/custody/device-share/delete",
          ],
          storedWalletCount: 3,
        }),
      })),
    );

    const result = await detectWalletCustodyClientCompatibility();

    expect(result.nativeHelper).toEqual({
      status: "available",
      helper: "fased-native-custody-helper",
      platform: "windows",
      storageMode: "windows-dpapi",
      protocolVersion: 2,
      availableRoutes: [
        "/v1/custody/health",
        "/v1/custody/device-share/status",
        "/v1/custody/device-share/store",
        "/v1/custody/device-share/load",
        "/v1/custody/device-share/delete",
      ],
      storedWalletCount: 3,
      warning: undefined,
    });
    expect(
      result.notes.some((note) =>
        note.includes("Browser-held encrypted storage remains the primary path"),
      ),
    ).toBe(true);
  });

  it("uses signer options for WebAuthn and serializes only the opaque assertion", async () => {
    const get = vi.fn(async () => ({
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
    const options = get.mock.calls[0]?.[0] as CredentialRequestOptions;
    expect(Array.from(new Uint8Array(options.publicKey?.challenge ?? new ArrayBuffer(0)))).toEqual([
      1, 2, 3,
    ]);
    expect(
      Array.from(
        new Uint8Array(options.publicKey?.allowCredentials?.[0]?.id ?? new ArrayBuffer(0)),
      ),
    ).toEqual([4, 5, 6]);
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
