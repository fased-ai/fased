import { beforeEach, describe, expect, it, vi } from "vitest";

const { callLocalSocketSigner, readWalletProviderRegistry } = vi.hoisted(() => ({
  callLocalSocketSigner: vi.fn(),
  readWalletProviderRegistry: vi.fn(() => ({
    defaultWalletId: "bond-vault",
    wallets: [
      {
        id: "bond-vault",
        providerId: "local-socket-signer",
        addresses: { solana: "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW" },
      },
    ],
  })),
}));

vi.mock("./providers/local-socket-signer-adapter.js", () => ({
  assertSecureLocalSignerSocket: vi.fn(),
  callLocalSocketSigner,
  requireLocalSocketSignerPath: () => "/tmp/fased-bond-signer.sock",
}));

vi.mock("./wallet-provider-registry.js", () => ({ readWalletProviderRegistry }));

import {
  buildFederationBondChallengeIntent,
  federationBondChallengeRequestId,
  resolveFederationBondWallet,
  signFederationBondChallenge,
} from "./solana-bond-signing.js";

const POLICY_HASH = `sha256:${"a".repeat(64)}`;
const ADDRESS = "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW";

function configureSigner() {
  callLocalSocketSigner.mockImplementation(
    async (_socketPath: string, request: { op: string; request?: { requestId?: string } }) => {
      switch (request.op) {
        case "v2.capabilities":
          return {
            ready: true,
            capabilities: {
              protocol: { current: 2, min: 2, max: 2 },
              intentTypes: ["federation.bondChallenge"],
              features: [
                "failClosedPolicies",
                "policyHashes",
                "durableCaps",
                "atomicIdempotency",
                "signerOwnedKeys",
                "domainSeparatedFederationBondChallenges",
                "signerOwnedWebAuthn",
                "singleUseReviewedAuthorization",
              ],
            },
          };
        case "v2.wallet.get":
          return {
            walletId: "bond_vault",
            publicKey: ADDRESS,
            version: 1,
            createdAt: "2026-07-16T12:00:00Z",
          };
        case "v2.policy.get":
          return {
            walletId: "bond_vault",
            role: "vault",
            version: 2,
            operations: ["federation.bondChallenge"],
            programs: [],
            assets: [
              {
                asset: "federation:bond-challenge",
                destinations: [ADDRESS],
                maxPerTx: "1",
                maxDaily: "4",
              },
            ],
            hash: POLICY_HASH,
          };
        default:
          throw new Error(`unexpected signer op ${request.op}`);
      }
    },
  );
}

describe("native federation bond signing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configureSigner();
  });

  it("resolves the Vault only from signer-owned public state", async () => {
    await expect(
      resolveFederationBondWallet({
        walletId: "bond-vault",
        env: { FASED_WALLET_LOCAL_SIGNER_SOCKET: "/tmp/fased-bond-signer.sock" },
      }),
    ).resolves.toMatchObject({
      walletId: "bond-vault",
      walletAddress: ADDRESS,
      socketPath: "/tmp/fased-bond-signer.sock",
    });
    expect(callLocalSocketSigner.mock.calls.map((call) => call[1].op)).toEqual([
      "v2.capabilities",
      "v2.wallet.get",
    ]);
  });

  it("builds an exact typed challenge without plaintext key input", () => {
    const payload = JSON.stringify({
      schema: "https://schemas.fased.ai/fased-bond-challenge-v1.json",
    });
    const challengeId = "bond-challenge-1";
    const intent = buildFederationBondChallengeIntent({
      challengeId,
      federationOrigin: "https://ff1.fased.app",
      payloadBase64: Buffer.from(payload).toString("base64"),
      handle: "@bonded@ff1.fased.app",
      nodeId: "node-1",
      tokenId: "token-1",
      bondId: "bond-1",
      tier: "basic-bond",
      amountRaw: "100",
      expiresAt: "2026-07-16T12:05:00Z",
    });
    expect(intent).toEqual({
      type: "federation.bondChallenge",
      federation: {
        challengeId,
        federationOrigin: "https://ff1.fased.app",
        handle: "@bonded@ff1.fased.app",
        nodeId: "node-1",
        tokenId: "token-1",
        bondId: "bond-1",
        tier: "basic-bond",
        amountRaw: "100",
        expiresAt: "2026-07-16T12:05:00Z",
        payloadBase64: Buffer.from(payload).toString("base64"),
      },
    });
    expect(JSON.stringify(intent)).not.toMatch(/passphrase|keystore|secretKey|serializedTx/i);
    expect(federationBondChallengeRequestId(challengeId)).toMatch(/^federation-bond:[0-9a-f]{64}$/);
  });

  it("keeps federation challenge signing reviewed-only", async () => {
    await expect(
      signFederationBondChallenge({
        challengeId: "bond-challenge-reviewed",
        federationOrigin: "https://ff1.fased.app",
        payloadBase64: Buffer.from("{}").toString("base64"),
        handle: "@bonded@ff1.fased.app",
        nodeId: "node-1",
        tokenId: "token-1",
        bondId: "bond-1",
        tier: "basic-bond",
        amountRaw: "100",
        expiresAt: "2026-07-16T12:05:00Z",
        walletId: "bond-vault",
        env: { FASED_WALLET_LOCAL_SIGNER_SOCKET: "/tmp/fased-bond-signer.sock" },
      }),
    ).rejects.toThrow("requires signer-owned reviewed authorization; direct signing is disabled");
    expect(callLocalSocketSigner.mock.calls.map((call) => call[1].op)).toEqual([
      "v2.capabilities",
      "v2.wallet.get",
      "v2.policy.get",
    ]);
    expect(callLocalSocketSigner).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ op: "v2.execute" }),
    );
  });

  it("fails closed when the signer lacks the challenge capability", async () => {
    callLocalSocketSigner.mockResolvedValueOnce({
      ready: true,
      capabilities: {
        protocol: { current: 2, min: 2, max: 2 },
        intentTypes: [],
        features: [],
      },
    });
    await expect(resolveFederationBondWallet({ walletId: "bond-vault", env: {} })).rejects.toThrow(
      "does not support secure federation bond challenges",
    );
  });
});
