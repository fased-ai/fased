import { describe, expect, it } from "vitest";
import {
  parseLocalSocketSignerRequest,
  validateLocalSocketSignerResult,
} from "./local-socket-signer-protocol.js";

describe("local socket signer protocol", () => {
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
