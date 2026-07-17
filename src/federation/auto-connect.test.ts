import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { resolveFederationBondWallet, signFederationBondChallenge } = vi.hoisted(() => ({
  resolveFederationBondWallet: vi.fn(),
  signFederationBondChallenge: vi.fn(),
}));

vi.mock("../wallet/solana-bond-signing.js", () => ({
  resolveFederationBondWallet,
  signFederationBondChallenge,
}));
import {
  createAndSubmitFederationBondProof,
  createFederationBondProof,
  loadPersistedFederationBondProof,
  persistFederationBondProofFromSignerReview,
  runFederationAutoConnectOnce,
  startFederationAutoConnect,
} from "./auto-connect.js";

const BOND_WALLET_ADDRESS = "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW";

async function writeFederationTokenFile(stateDir: string, token: Record<string, unknown>) {
  const tokenPath = path.join(stateDir, "federation", "access-token.json");
  await fs.mkdir(path.dirname(tokenPath), { recursive: true });
  await fs.writeFile(tokenPath, `${JSON.stringify(token, null, 2)}\n`, "utf-8");
}

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  resolveFederationBondWallet.mockImplementation(async (params?: { walletId?: string }) => ({
    walletId: params?.walletId ?? "bond-wallet",
    walletAddress: BOND_WALLET_ADDRESS,
    providerId: "local-socket-signer",
    socketPath: "/tmp/fased-bond-signer.sock",
  }));
  signFederationBondChallenge.mockImplementation(async (params: { walletId?: string }) => ({
    walletId: params.walletId ?? "bond-wallet",
    walletAddress: BOND_WALLET_ADDRESS,
    providerId: "local-socket-signer",
    socketPath: "/tmp/fased-bond-signer.sock",
    requestId: "federation-bond:test",
    signatureBase64: Buffer.alloc(64, 7).toString("base64"),
  }));
});

describe("federation auto-connect", () => {
  it("persists only the exact signer-owned reviewed federation signature", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-reviewed-bond-proof-"));
    const now = new Date().toISOString();
    const challengeExpiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    const payload = JSON.stringify({ schema: "fased-bond-v1", challenge: "reviewed" });
    const payloadBase64 = Buffer.from(payload, "utf8").toString("base64");
    const signatureBase64 = Buffer.alloc(64, 7).toString("base64");
    const env = {
      FASED_STATE_DIR: stateDir,
      FASED_FEDERATION_BASE_URL: "https://ff1.fased.app",
    };
    await writeFederationTokenFile(stateDir, {
      tokenId: "bond-token-reviewed",
      nodeId: "node-reviewed",
      handle: "@reviewed@ff1.fased.app",
      issuedAt: now,
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      scopes: ["federation.read"],
      signature: "token-signature",
    });
    const review = {
      requestId: "federation-bond:reviewed",
      walletId: "bond_wallet",
      walletPublicKey: BOND_WALLET_ADDRESS,
      intentType: "federation.bondChallenge" as const,
      intentDigest: `sha256:${"a".repeat(64)}`,
      policyHash: `sha256:${"b".repeat(64)}`,
      mode: "reviewed" as const,
      nonce: "c".repeat(64),
      semanticIntent: {
        type: "federation.bondChallenge" as const,
        federation: {
          challengeId: "challenge-reviewed",
          federationOrigin: "https://ff1.fased.app",
          handle: "@reviewed@ff1.fased.app",
          nodeId: "node-reviewed",
          tokenId: "bond-token-reviewed",
          bondId: "bond-reviewed",
          tier: "basic-bond" as const,
          amountRaw: "100",
          expiresAt: challengeExpiresAt,
          payloadBase64,
        },
      },
      artifactKind: "domain-separated-message" as const,
      artifactDigest: `sha256:${"d".repeat(64)}`,
      messageBase64: payloadBase64,
      asset: "federation:bond-challenge",
      amount: "1",
      destination: BOND_WALLET_ADDRESS,
      policyOperation: "federation.bondChallenge",
      requiredPrograms: ["domain:fased:federation-bond-challenge-v1"],
      requiredRole: "vault" as const,
      issuedAt: now,
      state: "signed" as const,
      preparedAt: now,
      expiresAt: challengeExpiresAt,
      updatedAt: now,
      signature: signatureBase64,
    };
    try {
      const proof = await persistFederationBondProofFromSignerReview({
        review,
        signatureBase64,
        walletId: "bond-wallet",
        env,
      });
      expect(proof).toMatchObject({
        challengeId: "challenge-reviewed",
        bondId: "bond-reviewed",
        walletId: "bond-wallet",
        walletAddress: BOND_WALLET_ADDRESS,
        payload,
        signatureBase64,
      });
      expect(await loadPersistedFederationBondProof(env)).toEqual(proof);
      await expect(
        persistFederationBondProofFromSignerReview({
          review: { ...review, destination: "tampered-destination" },
          signatureBase64,
          walletId: "bond-wallet",
          env,
        }),
      ).rejects.toThrow(/does not match its wallet or payload/);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("uses configured api token for register + attest", async () => {
    const calls: Array<{ url: string; auth: string; body: unknown }> = [];
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const headers = new Headers(init?.headers ?? {});
      calls.push({
        url,
        auth: headers.get("authorization") ?? "",
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      });
      return new Response(
        JSON.stringify({
          status: "accepted",
          token: {
            tokenId: "token-1",
            nodeId: "node-1",
            handle: "@node-1@ff1.fased.app",
            issuedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            scopes: ["federation.read", "federation.write"],
            signature: "sig",
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await runFederationAutoConnectOnce({
      env: {
        FASED_FEDERATION_AUTO_CONNECT: "1",
        FASED_FEDERATION_BASE_URL: "https://ff1.fased.app",
        FASED_A2A_ORIGIN: "https://node-1.example.com",
        FASED_A2A_HANDLE: "@node-1@ff1.fased.app",
        FASED_FEDERATION_API_TOKEN: "admin-token",
      },
    });

    expect(result.enabled).toBe(true);
    expect(calls.length).toBe(2);
    expect(calls[0]?.url).toContain("/api/federation/registry/handles");
    expect(calls[1]?.url).toContain("/api/federation/admission/attest");
    expect(calls[0]?.auth).toBe("Bearer admin-token");
    expect(calls[1]?.auth).toBe("Bearer admin-token");
  });

  it("falls back to challenge + enroll when no api token is configured", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-auto-connect-test-"));
    const calls: string[] = [];
    let enrollBody: Record<string, unknown> | null = null;
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push(url);
      if (url.endsWith("/api/federation/admission/challenge")) {
        return new Response(
          JSON.stringify({ status: "accepted", challengeId: "ch-1", nonce: "nonce-1" }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      if (url.endsWith("/api/federation/admission/enroll")) {
        enrollBody = init?.body
          ? (JSON.parse(init.body as string) as Record<string, unknown>)
          : null;
        return new Response(
          JSON.stringify({
            status: "accepted",
            token: {
              tokenId: "agent-token",
              nodeId: "node-2",
              handle: "@node-2@ff1.fased.app",
              issuedAt: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              scopes: ["federation.read", "federation.write"],
              signature: "sig",
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response(JSON.stringify({ status: "rejected" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await runFederationAutoConnectOnce({
      env: {
        FASED_FEDERATION_AUTO_CONNECT: "1",
        FASED_FEDERATION_BASE_URL: "https://ff1.fased.app",
        FASED_A2A_ORIGIN: "https://node-2.example.com",
        FASED_A2A_HANDLE: "@node-2@ff1.fased.app",
        FASED_STATE_DIR: stateDir,
      },
    });

    expect(result.enabled).toBe(true);
    expect(calls).toContain("https://ff1.fased.app/api/federation/admission/challenge");
    expect(calls).toContain("https://ff1.fased.app/api/federation/admission/enroll");
    const submittedEnrollBody = enrollBody as Record<string, unknown> | null;
    expect(
      (submittedEnrollBody?.attestation as { challengeNonce?: string } | undefined)?.challengeNonce,
    ).toBe("nonce-1");
  });

  it("updates the federation endpoint override when enroll returns a hosted public URL", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-auto-connect-hosted-"));
    const calls: Array<{ url: string; auth: string; body: unknown }> = [];
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const headers = new Headers(init?.headers ?? {});
      calls.push({
        url,
        auth: headers.get("authorization") ?? "",
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      });
      if (url.endsWith("/api/federation/admission/challenge")) {
        return new Response(
          JSON.stringify({ status: "accepted", challengeId: "ch-hosted", nonce: "nonce-hosted" }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      if (url.endsWith("/api/federation/admission/enroll")) {
        return new Response(
          JSON.stringify({
            status: "accepted",
            token: {
              tokenId: "agent-token-hosted",
              nodeId: "node-hosted",
              handle: "@node-hosted@ff1.fased.app",
              issuedAt: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              scopes: ["federation.read", "federation.write"],
              signature: "sig",
              hostedState: "ready",
              publicUrl: "https://node-hosted.agents.fased.app",
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      if (url.endsWith("/api/federation/endpoint/update")) {
        return new Response(JSON.stringify({ status: "accepted" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ status: "rejected" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await runFederationAutoConnectOnce({
      env: {
        FASED_FEDERATION_AUTO_CONNECT: "1",
        FASED_FEDERATION_BASE_URL: "https://ff1.fased.app",
        FASED_A2A_ORIGIN: "http://127.0.0.1:18789",
        FASED_A2A_HANDLE: "@node-hosted@ff1.fased.app",
        FASED_STATE_DIR: stateDir,
      },
    });

    const endpointUpdate = calls.find((call) =>
      call.url.endsWith("/api/federation/endpoint/update"),
    );
    expect(endpointUpdate).toBeDefined();
    expect(endpointUpdate?.auth).toBe("Bearer agent-token-hosted");
    expect(endpointUpdate?.body).toEqual({
      endpoint: "https://node-hosted.agents.fased.app",
      fallbackUrl: "http://127.0.0.1:18789",
    });
  });

  it("skips when auto-connect is disabled", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await runFederationAutoConnectOnce({
      env: {
        FASED_FEDERATION_AUTO_CONNECT: "0",
      },
    });

    expect(result.enabled).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("starts and stops renew loop", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/api/federation/admission/challenge")) {
        return new Response(
          JSON.stringify({ status: "accepted", challengeId: "ch-2", nonce: "nonce-2" }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response(
        JSON.stringify({
          status: "accepted",
          token: {
            tokenId: "token-2",
            nodeId: "node-2",
            handle: "@node-2@ff1.fased.app",
            issuedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            scopes: ["federation.read", "federation.write"],
            signature: "sig",
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const auto = startFederationAutoConnect({
      env: {
        FASED_FEDERATION_AUTO_CONNECT: "1",
        FASED_FEDERATION_BASE_URL: "https://ff1.fased.app",
        FASED_A2A_ORIGIN: "https://node-2.example.com",
        FASED_A2A_HANDLE: "@node-2@ff1.fased.app",
        FASED_FEDERATION_API_TOKEN: "bootstrap-token",
        FASED_FEDERATION_RENEW_INTERVAL_MS: "60000",
      },
    });

    expect(auto).not.toBeNull();
    auto?.stop();
  });

  it("preserves prior tunnel metadata when renewed token omits zrok fields", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-auto-connect-"));
    const tokenDir = path.join(stateDir, "federation");
    await fs.mkdir(tokenDir, { recursive: true });
    await fs.writeFile(
      path.join(tokenDir, "access-token.json"),
      JSON.stringify(
        {
          tokenId: "old-token",
          nodeId: "node-keep",
          handle: "@node-keep@ff1.fased.app",
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 120_000).toISOString(),
          scopes: ["federation.read", "federation.write"],
          signature: "sig-old",
          hostedState: "ready",
          zrokToken: "zrok-old",
          agentSlug: "oldslug1234",
          publicUrl: "https://oldslug1234.agents.fased.app",
        },
        null,
        2,
      ),
      "utf-8",
    );

    const calls: Array<{ url: string; auth: string; body: unknown }> = [];
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const headers = new Headers(init?.headers ?? {});
      calls.push({
        url,
        auth: headers.get("authorization") ?? "",
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      });
      if (url.endsWith("/api/federation/endpoint/update")) {
        return new Response(JSON.stringify({ status: "accepted" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          status: "accepted",
          token: {
            tokenId: "new-token",
            nodeId: "node-keep",
            handle: "@node-keep@ff1.fased.app",
            issuedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 120_000).toISOString(),
            scopes: ["federation.read", "federation.write"],
            signature: "sig-new",
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await runFederationAutoConnectOnce({
      env: {
        FASED_FEDERATION_AUTO_CONNECT: "1",
        FASED_FEDERATION_BASE_URL: "https://ff1.fased.app",
        FASED_A2A_ORIGIN: "https://node-keep.example.com",
        FASED_A2A_HANDLE: "@node-keep@ff1.fased.app",
        FASED_STATE_DIR: stateDir,
      },
    });

    const savedRaw = await fs.readFile(path.join(tokenDir, "access-token.json"), "utf-8");
    const saved = JSON.parse(savedRaw) as {
      zrokToken?: string;
      agentSlug?: string;
      publicUrl?: string;
      tokenId: string;
    };
    expect(saved.tokenId).toBe("new-token");
    expect(saved.zrokToken).toBe("zrok-old");
    expect(saved.agentSlug).toBe("oldslug1234");
    expect(saved.publicUrl).toBe("https://oldslug1234.agents.fased.app");
    const endpointUpdate = calls.find((call) =>
      call.url.endsWith("/api/federation/endpoint/update"),
    );
    expect(endpointUpdate?.auth).toBe("Bearer new-token");
    expect(endpointUpdate?.body).toEqual({
      endpoint: "https://oldslug1234.agents.fased.app",
      fallbackUrl: "https://node-keep.example.com",
    });
  });

  it("replaces prior tunnel metadata when new token includes zrok fields", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-auto-connect-"));
    const tokenDir = path.join(stateDir, "federation");
    await fs.mkdir(tokenDir, { recursive: true });
    await fs.writeFile(
      path.join(tokenDir, "access-token.json"),
      JSON.stringify(
        {
          tokenId: "old-token",
          nodeId: "node-replace",
          handle: "@node-replace@ff1.fased.app",
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 120_000).toISOString(),
          scopes: ["federation.read", "federation.write"],
          signature: "sig-old",
          zrokToken: "zrok-old",
          agentSlug: "oldslug5678",
          publicUrl: "https://oldslug5678.agents.fased.app",
        },
        null,
        2,
      ),
      "utf-8",
    );

    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          status: "accepted",
          token: {
            tokenId: "new-token",
            nodeId: "node-replace",
            handle: "@node-replace@ff1.fased.app",
            issuedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 120_000).toISOString(),
            scopes: ["federation.read", "federation.write"],
            signature: "sig-new",
            zrokToken: "zrok-new",
            agentSlug: "newslug5678",
            publicUrl: "https://newslug5678.agents.fased.app",
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await runFederationAutoConnectOnce({
      env: {
        FASED_FEDERATION_AUTO_CONNECT: "1",
        FASED_FEDERATION_BASE_URL: "https://ff1.fased.app",
        FASED_A2A_ORIGIN: "https://node-replace.example.com",
        FASED_A2A_HANDLE: "@node-replace@ff1.fased.app",
        FASED_STATE_DIR: stateDir,
      },
    });

    const savedRaw = await fs.readFile(path.join(tokenDir, "access-token.json"), "utf-8");
    const saved = JSON.parse(savedRaw) as {
      zrokToken?: string;
      agentSlug?: string;
      publicUrl?: string;
      tokenId: string;
    };
    expect(saved.tokenId).toBe("new-token");
    expect(saved.zrokToken).toBe("zrok-new");
    expect(saved.agentSlug).toBe("newslug5678");
    expect(saved.publicUrl).toBe("https://newslug5678.agents.fased.app");
  });

  it("creates and persists a federation bond proof using the configured bond Vault", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-bond-proof-"));
    const publicKeyBase58 = BOND_WALLET_ADDRESS;
    await writeFederationTokenFile(stateDir, {
      tokenId: "bond-token-1",
      nodeId: "node-bond-1",
      handle: "@bonded@ff1.fased.app",
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      scopes: ["federation.read", "federation.write"],
      signature: "sig",
    });

    const payload = JSON.stringify({
      schema: "https://schemas.fased.ai/fased-bond-challenge-v1.json",
      handle: "@bonded@ff1.fased.app",
      nodeId: "node-bond-1",
      tokenId: "bond-token-1",
      bondId: "bond-pos-1",
      wallet: {
        chain: "solana",
        address: publicKeyBase58,
      },
      tier: "basic-bond",
      nonce: "nonce-bond-1",
      issuedAt: "2026-04-19T00:00:00.000Z",
      expiresAt: "2026-04-19T00:05:00.000Z",
    });
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/api/federation/bond/challenge")) {
        const headers = new Headers(init?.headers ?? {});
        expect(headers.get("authorization")).toBe("Bearer bond-token-1");
        expect(init?.body ? JSON.parse(init.body as string) : null).toEqual({
          bondId: "bond-pos-1",
          wallet: {
            chain: "solana",
            address: publicKeyBase58,
          },
          tier: "basic-bond",
        });
        return new Response(
          JSON.stringify({
            status: "accepted",
            challengeId: "bond-challenge-1",
            nonce: "nonce-bond-1",
            expiresAt: "2026-04-19T00:05:00.000Z",
            payload,
            payloadBase64: Buffer.from(payload, "utf-8").toString("base64"),
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response(JSON.stringify({ status: "rejected" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const proof = await createFederationBondProof({
      env: {
        FASED_STATE_DIR: stateDir,
        FASED_FEDERATION_BASE_URL: "https://ff1.fased.app",
        FASED_FEDERATION_BOND_WALLET_ID: "bond-wallet",
      },
      bondId: "bond-pos-1",
      tier: "basic-bond",
    });

    expect(proof.challengeId).toBe("bond-challenge-1");
    expect(proof.walletId).toBe("bond-wallet");
    expect(proof.walletAddress).toBe(publicKeyBase58);
    expect(proof.signatureBase64.length).toBeGreaterThan(10);
    expect(signFederationBondChallenge).toHaveBeenCalledWith(
      expect.objectContaining({
        challengeId: "bond-challenge-1",
        federationOrigin: "https://ff1.fased.app",
        payloadBase64: Buffer.from(payload, "utf-8").toString("base64"),
        handle: "@bonded@ff1.fased.app",
        nodeId: "node-bond-1",
        tokenId: "bond-token-1",
        bondId: "bond-pos-1",
        tier: "basic-bond",
      }),
    );

    const persisted = JSON.parse(
      await fs.readFile(path.join(stateDir, "federation", "bond-proof.json"), "utf-8"),
    ) as { bondId?: string; walletId?: string; walletAddress?: string };
    expect(persisted.bondId).toBe("bond-pos-1");
    expect(persisted.walletId).toBe("bond-wallet");
    expect(persisted.walletAddress).toBe(publicKeyBase58);
  });

  it("submits a federation bond proof and persists the verified token state", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-bond-submit-"));
    const publicKeyBase58 = BOND_WALLET_ADDRESS;
    await writeFederationTokenFile(stateDir, {
      tokenId: "bond-token-2",
      nodeId: "node-bond-2",
      handle: "@bonded@ff1.fased.app",
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      scopes: ["federation.read", "federation.write"],
      signature: "sig",
    });

    const payload = JSON.stringify({
      schema: "https://schemas.fased.ai/fased-bond-challenge-v1.json",
      handle: "@bonded@ff1.fased.app",
      nodeId: "node-bond-2",
      tokenId: "bond-token-2",
      bondId: "bond-pos-2",
      wallet: {
        chain: "solana",
        address: publicKeyBase58,
      },
      tier: "basic-bond",
      nonce: "nonce-bond-2",
      issuedAt: "2026-04-19T00:00:00.000Z",
      expiresAt: "2026-04-19T00:05:00.000Z",
    });
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/api/federation/bond/challenge")) {
        return new Response(
          JSON.stringify({
            status: "accepted",
            challengeId: "bond-challenge-2",
            nonce: "nonce-bond-2",
            expiresAt: "2026-04-19T00:05:00.000Z",
            payload,
            payloadBase64: Buffer.from(payload, "utf-8").toString("base64"),
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      if (url.endsWith("/api/federation/bond/verify")) {
        const headers = new Headers(init?.headers ?? {});
        expect(headers.get("authorization")).toBe("Bearer bond-token-2");
        const body = init?.body
          ? (JSON.parse(init.body as string) as {
              challengeId?: string;
              payloadBase64?: string;
              signatureBase64?: string;
            })
          : null;
        expect(body?.challengeId).toBe("bond-challenge-2");
        expect(body?.payloadBase64).toBe(Buffer.from(payload, "utf-8").toString("base64"));
        expect(typeof body?.signatureBase64).toBe("string");
        expect((body?.signatureBase64?.length ?? 0) > 10).toBe(true);
        return new Response(
          JSON.stringify({
            status: "accepted",
            binding: {
              verifiedAt: "2026-04-19T00:01:00.000Z",
              status: "active",
              tier: "basic-bond",
              amountRaw: "100000000000",
              quotaBand: "boosted",
              derivedScopes: ["offers.publish", "payments.receive.boost"],
            },
            token: {
              tokenId: "bond-token-2",
              nodeId: "node-bond-2",
              handle: "@bonded@ff1.fased.app",
              issuedAt: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              scopes: ["federation.read", "federation.write", "payments.receive"],
              signature: "sig",
              trustState: "verified",
              bondId: "bond-pos-2",
              bondStatus: "active",
              bondTier: "basic-bond",
              bondAmountRaw: "100000000000",
              bondQuotaBand: "boosted",
              bondDerivedScopes: ["offers.publish", "payments.receive.boost"],
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response(JSON.stringify({ status: "rejected" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await createAndSubmitFederationBondProof({
      env: {
        FASED_STATE_DIR: stateDir,
        FASED_FEDERATION_BASE_URL: "https://ff1.fased.app",
        FASED_FEDERATION_BOND_WALLET_ID: "bond-wallet",
      },
      bondId: "bond-pos-2",
      tier: "basic-bond",
    });

    expect(result.token.bondTier).toBe("basic-bond");
    expect(result.token.bondDerivedScopes).toEqual(["offers.publish", "payments.receive.boost"]);
    expect(result.proof.bondQuotaBand).toBe("boosted");
    expect(result.proof.verifiedAt).toBe("2026-04-19T00:01:00.000Z");

    const savedToken = JSON.parse(
      await fs.readFile(path.join(stateDir, "federation", "access-token.json"), "utf-8"),
    ) as { bondTier?: string; bondDerivedScopes?: string[] };
    expect(savedToken.bondTier).toBe("basic-bond");
    expect(savedToken.bondDerivedScopes).toEqual(["offers.publish", "payments.receive.boost"]);

    const savedProof = JSON.parse(
      await fs.readFile(path.join(stateDir, "federation", "bond-proof.json"), "utf-8"),
    ) as { verifiedAt?: string; bondQuotaBand?: string };
    expect(savedProof.verifiedAt).toBe("2026-04-19T00:01:00.000Z");
    expect(savedProof.bondQuotaBand).toBe("boosted");
  });
});
