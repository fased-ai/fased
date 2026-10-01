import { describe, expect, it } from "vitest";
import {
  parseLocalSocketSignerRequest,
  validateLocalSocketSignerResult,
} from "./local-socket-signer-protocol.js";

describe("local socket signer protocol", () => {
  it("negotiates protocol-v2 capabilities and policy hashes", () => {
    const parsed = parseLocalSocketSignerRequest({ op: "v2.capabilities" });
    expect(parsed.op).toBe("v2.capabilities");
    expect(
      validateLocalSocketSignerResult("v2.capabilities", {
        details: "fased-signerd protocol-v2 ready",
        readOnly: false,
        keystoreType: "signer-owned-v2",
        chains: ["solana"],
        ready: true,
        release: {
          version: "dev",
          commit: "unknown",
          buildInputDigest: "unknown",
          development: true,
        },
        capabilities: {
          protocol: { current: 2, min: 2, max: 2 },
          nativeFeeReservationLamports: 6_500_000,
          intentTypes: ["solana.nativeTransfer", "solana.splTransferChecked"],
          operationStates: ["reserved", "broadcast", "confirmed", "failed", "unknown"],
          features: ["failClosedPolicies", "policyHashes"],
        },
        policies: [
          {
            walletId: "agent",
            role: "agent",
            version: 1,
            hash: `sha256:${"a".repeat(64)}`,
          },
        ],
      }),
    ).toBe(true);
  });

  it("rejects unstamped production identity and missing native fee-reserve negotiation", () => {
    const base = {
      details: "fased-signerd protocol-v2 ready",
      ready: true,
      release: {
        version: "0.1.63",
        commit: "a".repeat(40),
        buildInputDigest: `sha256:${"b".repeat(64)}`,
        development: false,
      },
      capabilities: {
        protocol: { current: 2, min: 2, max: 2 },
        nativeFeeReservationLamports: 6_500_000,
        intentTypes: ["solana.nativeTransfer"],
        operationStates: ["reserved"],
        features: ["signerControlledNativeFeeCaps"],
      },
    };
    expect(validateLocalSocketSignerResult("v2.capabilities", base)).toBe(true);
    expect(
      validateLocalSocketSignerResult("v2.capabilities", {
        ...base,
        release: { ...base.release, commit: "unknown" },
      }),
    ).toBe(false);
    expect(
      validateLocalSocketSignerResult("v2.capabilities", {
        ...base,
        capabilities: {
          protocol: base.capabilities.protocol,
          intentTypes: base.capabilities.intentTypes,
          operationStates: base.capabilities.operationStates,
          features: base.capabilities.features,
        },
      }),
    ).toBe(false);
  });

  it("requires an exact wallet-scoped native balance request and result", () => {
    expect(parseLocalSocketSignerRequest({ op: "getAddresses", walletId: "mining" })).toEqual({
      op: "getAddresses",
      walletId: "mining",
    });
    expect(() => parseLocalSocketSignerRequest({ op: "getAddresses" })).toThrow(
      "invalid signer request",
    );
    expect(
      parseLocalSocketSignerRequest({
        op: "getBalance",
        chain: "solana",
        walletId: "mining",
      }),
    ).toEqual({ op: "getBalance", chain: "solana", walletId: "mining" });
    for (const request of [
      { op: "getBalance", chain: "solana" },
      { op: "getBalance", chain: "solana", walletId: "" },
      {
        op: "getBalance",
        chain: "solana",
        walletId: "mining",
        rpcUrl: "https://gateway-rpc.invalid",
      },
    ]) {
      expect(() => parseLocalSocketSignerRequest(request)).toThrow("invalid signer request");
    }

    const valid = {
      ok: true,
      chain: "solana",
      address: "So11111111111111111111111111111111111111112",
      balance: "4242",
      unit: "lamports",
    };
    expect(validateLocalSocketSignerResult("getBalance", valid)).toBe(true);
    for (const invalid of [
      { ...valid, ok: false },
      { ...valid, balance: "-1" },
      { ...valid, balance: "1.5" },
      { ...valid, balance: "01" },
      { ...valid, address: "not-a-solana-address" },
      { ...valid, unit: "SOL" },
      { ...valid, rpcUrl: "https://signer-secret.invalid" },
    ]) {
      expect(validateLocalSocketSignerResult("getBalance", invalid)).toBe(false);
    }
  });

  it("accepts application policy tightening with an exact version fence", () => {
    const policy = {
      walletId: "agent",
      role: "agent" as const,
      operations: ["solana.nativeTransfer"],
      programs: ["11111111111111111111111111111111"],
      assets: [
        {
          asset: "solana:native",
          destinations: ["Vote111111111111111111111111111111111111111"],
          maxPerTx: "500",
          maxDaily: "2500",
        },
      ],
    };
    expect(
      parseLocalSocketSignerRequest({
        op: "v2.policy.tighten",
        walletId: "agent",
        request: { expectedVersion: 4, policy },
      }).op,
    ).toBe("v2.policy.tighten");
    expect(() =>
      parseLocalSocketSignerRequest({
        op: "v2.policy.tighten",
        walletId: "agent",
        request: { expectedVersion: 0, policy },
      }),
    ).toThrow("invalid signer request");
    expect(
      validateLocalSocketSignerResult("v2.policy.tighten", {
        ...policy,
        version: 5,
        hash: `sha256:${"f".repeat(64)}`,
      }),
    ).toBe(true);
  });

  it("validates durable signer-v2 operation states", () => {
    expect(
      validateLocalSocketSignerResult("v2.operation.get", {
        requestId: "request-123",
        walletId: "agent",
        intentType: "solana.nativeTransfer",
        intentDigest: `sha256:${"a".repeat(64)}`,
        transactionDigest: `sha256:${"b".repeat(64)}`,
        policyHash: `sha256:${"c".repeat(64)}`,
        asset: "solana:native",
        amount: "1000",
        state: "unknown",
        reservationActive: true,
        usageBucket: "2026-07-16",
        reservedAt: "2026-07-16T00:00:00.000Z",
        broadcastAt: "2026-07-16T00:00:01.000Z",
        updatedAt: "2026-07-16T00:00:02.000Z",
        signature: "signature",
        error: "confirmation timeout",
        executionAttempt: 2,
      }),
    ).toBe(true);
  });

  it("accepts only typed Jupiter review.prepare/review.execute requests", () => {
    const intent = {
      type: "solana.jupiter.swap" as const,
      jupiter: {
        owner: "11111111111111111111111111111111",
        inputMint: "So11111111111111111111111111111111111111112",
        outputMint: "Vote111111111111111111111111111111111111111",
        inputAmount: "100",
        maxInputAmount: "100",
        minimumOutputAmount: "90",
        maxFeeLamports: "5000",
        sourceTokenAccount: "Stake11111111111111111111111111111111111111",
        destinationTokenAccount: "Config1111111111111111111111111111111111111",
        programs: ["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"], // pragma: allowlist secret
      },
    };
    const policyHash = `sha256:${"a".repeat(64)}`;
    const transaction = {
      serializedTxBase64: "AA==",
      programs: intent.jupiter.programs,
      writableAccounts: [intent.jupiter.sourceTokenAccount],
      submission: "rpc" as const,
    };
    expect(
      parseLocalSocketSignerRequest({
        op: "v2.review.prepare",
        walletId: "agent",
        request: { requestId: "review-123", policyHash, mode: "reviewed", intent, transaction },
      }).op,
    ).toBe("v2.review.prepare");
    const triggerIntent = {
      type: "solana.jupiter.trigger.create" as const,
      jupiter: {
        owner: "11111111111111111111111111111111",
        inputMint: "So11111111111111111111111111111111111111112",
        outputMint: "Vote111111111111111111111111111111111111111",
        inputAmount: "100",
        maxInputAmount: "100",
        minimumOutputAmount: "0",
        maxFeeLamports: "5000",
        programs: ["11111111111111111111111111111111"],
        trigger: {
          operation: "create" as const,
          program: "11111111111111111111111111111111",
          triggerMint: "So11111111111111111111111111111111111111112",
          condition: "below" as const,
          targetPriceUsd: "120.5",
          slippageBps: 100,
          expiresAt: "2026-07-20T00:00:00.000Z",
          expectedOrderState: "new" as const,
        },
      },
    };
    expect(
      parseLocalSocketSignerRequest({
        op: "v2.review.prepare",
        walletId: "agent",
        request: {
          requestId: "trigger-review-123",
          policyHash,
          mode: "reviewed",
          intent: triggerIntent,
        },
      }).op,
    ).toBe("v2.review.prepare");
    expect(() =>
      parseLocalSocketSignerRequest({
        op: "v2.review.prepare",
        walletId: "agent",
        request: {
          requestId: "trigger-review-123",
          policyHash,
          mode: "reviewed",
          intent: triggerIntent,
          transaction,
        },
      }),
    ).toThrow(/transaction bytes are signer-owned/);
    expect(() =>
      parseLocalSocketSignerRequest({
        op: "v2.execute",
        walletId: "agent",
        request: {
          requestId: "removed-auth",
          policyHash,
          intent: {
            ...triggerIntent,
            type: "solana.jupiter.trigger.auth",
          },
        },
      }),
    ).toThrow(/invalid signer request/);
    expect(() =>
      parseLocalSocketSignerRequest({
        op: "v2.review.prepare",
        walletId: "agent",
        request: {
          requestId: "return-signed",
          policyHash,
          mode: "reviewed",
          intent,
          transaction: { ...transaction, submission: "returnSigned" },
        },
      }),
    ).toThrow(/invalid signer request/);
    expect(
      parseLocalSocketSignerRequest({
        op: "v2.review.prepare",
        walletId: "vault",
        request: {
          requestId: "review-native-123",
          policyHash,
          mode: "reviewed",
          intent: {
            type: "solana.nativeTransfer",
            destination: "So11111111111111111111111111111111111111112",
            lamports: "1000",
          },
        },
      }).op,
    ).toBe("v2.review.prepare");
    expect(
      parseLocalSocketSignerRequest({
        op: "v2.review.get",
        walletId: "agent",
        request: { requestId: "review-123" },
      }).op,
    ).toBe("v2.review.get");
    expect(() =>
      parseLocalSocketSignerRequest({
        op: "v2.review.get",
        walletId: "agent",
        request: { requestId: "review-123", transaction },
      }),
    ).toThrow(/invalid signer request/);
    expect(
      parseLocalSocketSignerRequest({
        op: "v2.review.execute",
        walletId: "agent",
        request: {
          requestId: "review-123",
          authorization: { type: "webauthn", proof: { proofId: "proof-123" } },
        },
      }).op,
    ).toBe("v2.review.execute");
    expect(
      parseLocalSocketSignerRequest({
        op: "v2.review.execute",
        walletId: "agent",
        request: {
          requestId: "review-123",
          authorization: {
            type: "control-ui",
            proof: { proofId: "a".repeat(64) },
          },
        },
      }).op,
    ).toBe("v2.review.execute");
    expect(() =>
      parseLocalSocketSignerRequest({
        op: "v2.review.execute",
        walletId: "agent",
        request: {
          requestId: "review-123",
          transaction,
          rawSignTx: true,
        },
      }),
    ).toThrow(/invalid signer request/);
    for (const injected of [
      { policyHash },
      { transactionDigest: `sha256:${"b".repeat(64)}` },
      { semanticIntent: intent },
    ]) {
      expect(() =>
        parseLocalSocketSignerRequest({
          op: "v2.review.authorization.begin",
          walletId: "agent",
          request: { requestId: "review-123", ...injected },
        }),
      ).toThrow(/invalid signer request/);
    }
    expect(
      parseLocalSocketSignerRequest({
        op: "v2.review.authorization.begin",
        walletId: "agent",
        request: { requestId: "review-123" },
      }).op,
    ).toBe("v2.review.authorization.begin");
    expect(
      parseLocalSocketSignerRequest({
        op: "v2.review.authorization.finish",
        walletId: "agent",
        request: { challengeId: "challenge-123", credential: { id: "credential-123" } },
      }).op,
    ).toBe("v2.review.authorization.finish");
    const binding = {
      requestId: "review-123",
      walletId: "agent",
      role: "agent",
      intentType: intent.type,
      intentDigest: `sha256:${"b".repeat(64)}`,
      semanticIntent: intent,
      artifactKind: "solana-transaction",
      artifactDigest: `sha256:${"c".repeat(64)}`,
      transactionDigest: `sha256:${"c".repeat(64)}`,
      asset: `solana:spl:${intent.jupiter.inputMint}`,
      amount: "100",
      destination: intent.jupiter.owner,
      policyOperation: intent.type,
      requiredPrograms: intent.jupiter.programs,
      policyHash,
      nonce: "d".repeat(64),
      issuedAt: "2026-07-16T00:00:00.000Z",
      expiresAt: "2026-07-16T00:02:00.000Z",
    };
    const { role: requiredRole, ...reviewBinding } = binding;
    expect(
      validateLocalSocketSignerResult("v2.review.get", {
        ...reviewBinding,
        requiredRole,
        mode: "reviewed",
        nonce: binding.nonce,
        transaction,
        issuedAt: binding.issuedAt,
        state: "signed",
        preparedAt: binding.issuedAt,
        updatedAt: binding.issuedAt,
        signature: "signature",
      }),
    ).toBe(true);
    expect(
      validateLocalSocketSignerResult("v2.review.authorization.begin", {
        challengeId: "challenge-123",
        expiresAt: binding.expiresAt,
        binding,
        options: { publicKey: { challenge: "opaque" } },
      }),
    ).toBe(true);
    expect(
      validateLocalSocketSignerResult("v2.review.authorization.finish", {
        authorization: { type: "webauthn", proof: { proofId: "proof-123" } },
        binding,
        credentialId: "credential-123",
        expiresAt: binding.expiresAt,
      }),
    ).toBe(true);
  });

  it("accepts only sanitized signer-owned Jupiter Trigger history", () => {
    expect(
      parseLocalSocketSignerRequest({
        op: "v2.jupiter.trigger.history",
        walletId: "agent",
      }).op,
    ).toBe("v2.jupiter.trigger.history");
    const result = {
      orders: [
        {
          orderId: "order-1",
          orderState: "open",
          orderType: "single",
          inputMint: "So11111111111111111111111111111111111111112",
          initialInputAmount: "100",
          remainingInputAmount: "90",
          outputMint: "Vote111111111111111111111111111111111111111",
          triggerMint: "So11111111111111111111111111111111111111112",
          condition: "below",
          targetPriceUsd: "120.5",
          slippageBps: 100,
          expiresAt: "2026-07-20T00:00:00.000Z",
          cancel: {
            expectedOrderState: "open",
            refundMint: "So11111111111111111111111111111111111111112",
            refundAmount: "90",
            destinationTokenAccount: "11111111111111111111111111111111",
            program: "11111111111111111111111111111111",
          },
        },
      ],
    };
    expect(validateLocalSocketSignerResult("v2.jupiter.trigger.history", result)).toBe(true);
    expect(
      validateLocalSocketSignerResult("v2.jupiter.trigger.history", {
        orders: [{ ...result.orders[0], jwt: "secret" }],
      }),
    ).toBe(false);
    expect(
      validateLocalSocketSignerResult("v2.jupiter.trigger.history", {
        orders: [{ ...result.orders[0], vault: "secret" }],
      }),
    ).toBe(false);
  });

  it("keeps application network bootstrap one-RPC and response-secret-free", () => {
    expect(parseLocalSocketSignerRequest({ op: "v2.network.get", walletId: "agent" })).toEqual({
      op: "v2.network.get",
      walletId: "agent",
    });
    expect(
      parseLocalSocketSignerRequest({
        op: "v2.network.bootstrap",
        walletId: "agent",
        request: { expectedVersion: 1, primaryRpcUrl: "https://rpc.example/solana" },
      }),
    ).toMatchObject({ op: "v2.network.bootstrap", request: { expectedVersion: 1 } });
    expect(() =>
      parseLocalSocketSignerRequest({
        op: "v2.network.bootstrap",
        walletId: "agent",
        request: {
          expectedVersion: 1,
          primaryRpcUrl: "https://rpc.example/solana",
          verificationRpcUrl: "https://witness.example/solana",
        },
      }),
    ).toThrow(/invalid signer request/i);

    const summary = {
      walletId: "agent",
      configured: true,
      version: 2,
      hash: `hmac-sha256:${"a".repeat(64)}`,
      ready: true,
    };
    expect(validateLocalSocketSignerResult("v2.network.get", summary)).toBe(true);
    expect(validateLocalSocketSignerResult("v2.network.bootstrap", summary)).toBe(true);
    expect(
      validateLocalSocketSignerResult("v2.network.bootstrap", {
        ...summary,
        primaryRpcUrl: "https://secret.example/solana?token=secret",
      }),
    ).toBe(false);
  });

  it("accepts reusable RPC profile requests but never profile endpoint secrets in results", () => {
    const hash = `hmac-sha256:${"a".repeat(64)}`;
    expect(
      parseLocalSocketSignerRequest({
        op: "v2.rpcProfile.create",
        request: {
          profileId: "mainnet-primary",
          name: "Mainnet Primary",
          primaryRpcUrl: "https://primary.example/rpc?token=secret",
          websocketRpcUrl: "wss://primary.example/ws?token=secret",
          commitment: "finalized",
        },
      }),
    ).toMatchObject({ op: "v2.rpcProfile.create" });
    expect(
      parseLocalSocketSignerRequest({
        op: "v2.rpcProfile.bind",
        walletId: "profile",
        request: {
          profileId: "mainnet-primary",
          expectedProfileVersion: 1,
          expectedProfileHash: hash,
          expectedNetworkVersion: 0,
        },
      }),
    ).toMatchObject({ op: "v2.rpcProfile.bind", walletId: "profile" });
    const summary = {
      profileId: "mainnet-primary",
      name: "Mainnet Primary",
      chain: "solana",
      cluster: "mainnet-beta",
      genesisHash: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d", // pragma: allowlist secret
      commitment: "finalized",
      version: 1,
      hash,
      endpointCount: 2,
      ready: true,
    };
    expect(validateLocalSocketSignerResult("v2.rpcProfile.create", summary)).toBe(true);
    expect(
      validateLocalSocketSignerResult("v2.rpcProfile.get", {
        ...summary,
        primaryRpcUrl: "https://secret.example/rpc",
      }),
    ).toBe(false);
  });

  it.each([
    "prepareTx",
    "signTx",
    "sendTx",
    "sendSolanaInstruction",
    "sendSolanaInstructions",
    "custodyStatus",
    "unlockCustody",
    "lockCustody",
  ])("rejects removed legacy operation %s at the protocol boundary", (op) => {
    expect(() => parseLocalSocketSignerRequest({ op, request: {} })).toThrow(
      /invalid signer request/,
    );
  });
});

it("rejects removed legacy roles and operations", () => {
  for (const op of ["v2.satCommitment.allocate", "v2.vaultMining.bind", "v2.keeperFeePayer.get"]) {
    expect(() => parseLocalSocketSignerRequest({ op })).toThrow();
  }
  for (const role of ["mining", "vault", "profile", "strategy", "keeper"]) {
    expect(() =>
      parseLocalSocketSignerRequest({
        op: "v2.wallet.create",
        walletId: "wallet",
        request: {
          expectedPolicyVersion: 0,
          policy: { role, operations: [], programs: [], assets: [] },
        },
      }),
    ).toThrow();
  }
});

it("admits exact current WEN market owner proof inspection", () => {
  const proofId = "A".repeat(43);
  expect(
    parseLocalSocketSignerRequest({
      op: "v2.wenMarket.ownerProof.inspect",
      walletId: "wallet",
      request: { requestId: "request", proofId },
    }).op,
  ).toBe("v2.wenMarket.ownerProof.inspect");
  expect(
    validateLocalSocketSignerResult("v2.wenMarket.ownerProof.inspect", {
      walletId: "wallet",
      requestId: "request",
      proofId,
      artifactDigest: `sha256:${"a".repeat(64)}`,
      expiresAt: "2026-10-01",
    }),
  ).toBe(true);
});

it("rejects retired application baseline activation and creation", () => {
  expect(() =>
    parseLocalSocketSignerRequest({
      op: "v2.policy.activateBaseline",
      walletId: "wallet",
      request: { expectedPolicyVersion: 1, baseline: { version: 1, role: "agent" } },
    }),
  ).toThrow();
  expect(() =>
    parseLocalSocketSignerRequest({
      op: "v2.wallet.create",
      walletId: "wallet",
      request: {
        expectedPolicyVersion: 0,
        baseline: { version: 1, role: "agent", approvalMode: "read-only" },
      },
    }),
  ).toThrow();
});
