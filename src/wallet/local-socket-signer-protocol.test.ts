import { describe, expect, it } from "vitest";
import {
  parseLocalSocketSignerRequest,
  validateLocalSocketSignerResult,
} from "./local-socket-signer-protocol.js";

describe("local socket signer protocol", () => {
  it("accepts the complete native signer-v2 capabilities health payload", () => {
    expect(
      validateLocalSocketSignerResult("v2.capabilities", {
        details: "fased-signerd protocol-v2 ready",
        readOnly: false,
        keystoreType: "signer-owned-v2",
        chains: ["solana"],
        ready: true,
        schema: { version: 3, supported: 3, ready: true },
        network: { ready: true, wallets: [] },
        capabilities: {
          protocol: { current: 2, min: 2, max: 2 },
          intentTypes: ["solana.nativeTransfer"],
          operationStates: ["reserved", "broadcast", "confirmed", "failed", "unknown"],
          features: ["failClosedPolicies", "policyHashes", "signerOwnedKeys"],
        },
        policies: [],
        webAuthn: { configured: false, credentialCount: 0, ready: false },
      }),
    ).toBe(true);
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
        capabilities: {
          protocol: { current: 2, min: 2, max: 2 },
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
    expect(
      parseLocalSocketSignerRequest({
        op: "v2.review.prepare",
        walletId: "agent",
        request: { requestId: "review-123", policyHash, mode: "reviewed", intent },
      }).op,
    ).toBe("v2.review.prepare");
    expect(
      parseLocalSocketSignerRequest({
        op: "v2.review.execute",
        walletId: "agent",
        request: {
          requestId: "review-123",
          policyHash,
          mode: "reviewed",
          intent,
          transaction: {
            serializedTxBase64: "AA==",
            programs: intent.jupiter.programs,
            writableAccounts: [intent.jupiter.sourceTokenAccount],
            submission: "rpc",
          },
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
          policyHash,
          mode: "reviewed",
          intent,
          transaction: {
            serializedTxBase64: "AA==",
            programs: intent.jupiter.programs,
            writableAccounts: [intent.jupiter.sourceTokenAccount],
            submission: "rpc",
          },
          rawSignTx: true,
        },
      }),
    ).toThrow(/invalid signer request/);
  });

  it("accepts sendSolanaInstruction requests", () => {
    const parsed = parseLocalSocketSignerRequest({
      op: "sendSolanaInstruction",
      request: {
        walletId: "wallet-a",
        programId: "EB4vLPuwkETenY7RxjEunneBuQoH8iMZdzrjqZDYvx75",
        dataBase64: Buffer.from([1, 2, 3]).toString("base64"),
        keys: [
          {
            pubkey: "11111111111111111111111111111111",
            isSigner: true,
            isWritable: true,
          },
        ],
      },
    });

    expect(parsed.op).toBe("sendSolanaInstruction");
  });

  it("validates sendSolanaInstruction results", () => {
    expect(
      validateLocalSocketSignerResult("sendSolanaInstruction", {
        ok: true,
        chain: "solana",
        txHash: "sig-123",
        signer: "miner-wallet-1",
      }),
    ).toBe(true);
  });

  it("accepts sat cleanup sendSolanaInstructions requests", () => {
    const parsed = parseLocalSocketSignerRequest({
      op: "sendSolanaInstructions",
      request: {
        walletId: "wallet-a",
        purpose: "sat-cleanup",
        instructions: [
          {
            programId: "EB4vLPuwkETenY7RxjEunneBuQoH8iMZdzrjqZDYvx75",
            dataBase64: Buffer.from([69, 1, 0, 0, 0, 0, 0, 0, 0]).toString("base64"),
            keys: [
              {
                pubkey: "11111111111111111111111111111111",
                isSigner: true,
                isWritable: true,
              },
            ],
          },
        ],
      },
    });

    expect(parsed.op).toBe("sendSolanaInstructions");
  });

  it("validates sendSolanaInstructions results", () => {
    expect(
      validateLocalSocketSignerResult("sendSolanaInstructions", {
        ok: true,
        chain: "solana",
        txHash: "sig-batch-123",
        signer: "miner-wallet-1",
        metadata: {
          instructionCount: 2,
        },
      }),
    ).toBe(true);
  });

  it("accepts custody unlock requests", () => {
    const parsed = parseLocalSocketSignerRequest({
      op: "unlockCustody",
      request: {
        sessionId: "session-1",
        host: "127.0.0.1",
        walletId: "wallet-a",
        role: "agent",
        chains: ["solana"],
        allowPrograms: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        passphrase: "secret-passphrase",
        solanaMaxPerTx: "1000",
        solanaMaxDaily: "5000",
      },
    });

    expect(parsed.op).toBe("unlockCustody");
  });

  it("validates custody status results", () => {
    expect(
      validateLocalSocketSignerResult("custodyStatus", {
        active: true,
        sessionId: "session-1",
        host: "127.0.0.1",
        walletId: "wallet-a",
        role: "agent",
        chains: ["solana"],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    ).toBe(true);
    expect(
      validateLocalSocketSignerResult("lockCustody", {
        active: false,
        removed: true,
      }),
    ).toBe(true);
  });
});
