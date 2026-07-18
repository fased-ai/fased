import { describe, expect, it } from "vitest";
import {
  parseLocalSocketSignerRequest,
  validateLocalSocketSignerResult,
} from "./local-socket-signer-protocol.js";

describe("local socket signer protocol", () => {
  it("accepts the complete native signer-v2 capabilities health payload", () => {
    const health = {
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
      schema: { version: 3, supported: 3, ready: true },
      network: { ready: true, wallets: [] },
      capabilities: {
        protocol: { current: 2, min: 2, max: 2 },
        nativeFeeReservationLamports: 5_000_000,
        intentTypes: ["solana.nativeTransfer"],
        operationStates: ["reserved", "broadcast", "confirmed", "failed", "unknown"],
        features: ["failClosedPolicies", "policyHashes", "signerOwnedKeys"],
      },
      policies: [],
      webAuthn: {
        configured: false,
        credentialCount: 0,
        credentialVersion: 4,
        ready: false,
      },
      jupiter: { triggerConfigured: true, liveEnabled: false },
      state: {
        databaseBytes: 4096,
        wallets: 1,
        operations: 80_000,
        operationReplayArchive: 1,
        reviews: 0,
        triggerWorkflows: 0,
        dailyUsageBuckets: 1,
        capacities: {
          operations: { used: 80_000, maximum: 100_000, warnAt: 80_000, warning: true },
        },
        capacityWarnings: ["operations signer state is at 80000/100000 records"],
      },
    };
    expect(validateLocalSocketSignerResult("v2.capabilities", health)).toBe(true);
    expect(
      validateLocalSocketSignerResult("v2.capabilities", {
        ...health,
        webAuthn: { ...health.webAuthn, credentialVersion: -1 },
      }),
    ).toBe(false);
    expect(
      validateLocalSocketSignerResult("v2.capabilities", {
        ...health,
        state: {
          ...health.state,
          capacities: {
            operations: { ...health.state.capacities.operations, maximum: 0 },
          },
        },
      }),
    ).toBe(false);
    expect(
      validateLocalSocketSignerResult("v2.capabilities", {
        ...health,
        jupiter: { ...health.jupiter, apiKey: "must-never-cross-the-socket" },
      }),
    ).toBe(false);
  });

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
          nativeFeeReservationLamports: 5_000_000,
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
        nativeFeeReservationLamports: 5_000_000,
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

  it("accepts typed signer-v2 wallet creation and native execution", () => {
    const policy = {
      role: "agent" as const,
      operations: ["solana.nativeTransfer"],
      programs: ["11111111111111111111111111111111"],
      assets: [
        {
          asset: "solana:native",
          destinations: ["Vote111111111111111111111111111111111111111"],
          maxPerTx: "1000",
          maxDaily: "5000",
        },
      ],
    };
    expect(
      parseLocalSocketSignerRequest({
        op: "v2.wallet.create",
        walletId: "agent",
        request: { expectedPolicyVersion: 0, policy },
      }).op,
    ).toBe("v2.wallet.create");
    expect(
      parseLocalSocketSignerRequest({
        op: "v2.execute",
        walletId: "agent",
        request: {
          requestId: "request-123",
          policyHash: `sha256:${"b".repeat(64)}`,
          intent: {
            type: "solana.nativeTransfer",
            destination: "Vote111111111111111111111111111111111111111",
            lamports: "1000",
          },
        },
      }).op,
    ).toBe("v2.execute");
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

  it("accepts typed SAT actions with request id and current policy hash", () => {
    const request = {
      op: "v2.execute" as const,
      walletId: "mining",
      request: {
        requestId: "sat-request-123",
        policyHash: `sha256:${"d".repeat(64)}`,
        intent: {
          type: "solana.satAction" as const,
          action: "depositMinerCapital",
          programId: "EB4vLPuwkETenY7RxjEunneBuQoH8iMZdzrjqZDYvx75",
          dataBase64: Buffer.from([37, 1, 0, 0, 0, 0, 0, 0, 0]).toString("base64"),
          keys: [
            {
              pubkey: "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW",
              isSigner: true,
              isWritable: true,
            },
          ],
        },
      },
    };
    expect(parseLocalSocketSignerRequest(request)).toEqual(request);
    expect(() =>
      parseLocalSocketSignerRequest({
        ...request,
        request: {
          ...request.request,
          intent: { ...request.request.intent, rawTransactionBase64: "forbidden" },
        },
      }),
    ).toThrow("invalid signer request");
  });

  it("accepts only narrow Vault bond and federation challenge intents", () => {
    const policyHash = `sha256:${"e".repeat(64)}`;
    const bondIntent = {
      type: "solana.vaultBondAction" as const,
      cluster: "devnet" as const,
      action: "requestBondUnlock",
      programId: "D1ySMMiJmvJRhJJKwYnc171w3g2JDPQnkgD8kGhaG4Vq",
      dataBase64: "BA==",
      keys: [
        {
          pubkey: "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW",
          isSigner: true,
          isWritable: true,
        },
      ],
    };
    expect(
      parseLocalSocketSignerRequest({
        op: "v2.execute",
        walletId: "bond-vault",
        request: { requestId: "vault-bond-request", policyHash, intent: bondIntent },
      }).op,
    ).toBe("v2.execute");
    expect(() =>
      parseLocalSocketSignerRequest({
        op: "v2.execute",
        walletId: "bond-vault",
        request: {
          requestId: "vault-bond-request",
          policyHash,
          intent: { ...bondIntent, serializedTxBase64: "forbidden" },
        },
      }),
    ).toThrow("invalid signer request");

    const federationIntent = {
      type: "federation.bondChallenge" as const,
      federation: {
        challengeId: "challenge-1",
        federationOrigin: "https://ff1.fased.app",
        handle: "@bonded@ff1.fased.app",
        nodeId: "node-1",
        tokenId: "token-1",
        bondId: "bond-1",
        tier: "basic-bond" as const,
        amountRaw: "100",
        expiresAt: "2026-07-16T12:05:00Z",
        payloadBase64: "e30=",
      },
    };
    expect(
      parseLocalSocketSignerRequest({
        op: "v2.execute",
        walletId: "bond-vault",
        request: { requestId: "federation-bond:request", policyHash, intent: federationIntent },
      }).op,
    ).toBe("v2.execute");
    expect(() =>
      parseLocalSocketSignerRequest({
        op: "v2.execute",
        walletId: "bond-vault",
        request: {
          requestId: "federation-bond:request",
          policyHash,
          intent: { ...federationIntent, dataBase64: "cmF3" },
        },
      }),
    ).toThrow("invalid signer request");
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
        programs: ["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"],
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
