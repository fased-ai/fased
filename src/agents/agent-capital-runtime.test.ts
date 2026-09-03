import { Keypair } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { callLocalSocketSigner, fetchPinnedSolanaRpcRead } = vi.hoisted(() => ({
  callLocalSocketSigner: vi.fn(),
  fetchPinnedSolanaRpcRead: vi.fn(),
}));

vi.mock("../wallet/providers/local-socket-signer-adapter.js", () => ({
  callLocalSocketSigner,
}));
vi.mock("../wallet/solana-rpc-read-fetch.js", () => ({ fetchPinnedSolanaRpcRead }));

import {
  deriveAgentCapitalRequestId,
  executeReviewedAgentCapitalAction,
  validateAgentCapitalInstruction,
  type AgentCapitalInstruction,
} from "./agent-capital-runtime.js";
import { FASED_AGENT_CAPITAL_CONTRACT } from "./fased-agent-capital-contract.generated.js";

function instruction(action: AgentCapitalInstruction["action"], signer: string) {
  const contract = FASED_AGENT_CAPITAL_CONTRACT.instructions.find(
    (candidate) => candidate.action === action,
  );
  if (!contract) {
    throw new Error(`missing fixture contract ${action}`);
  }
  const data = Buffer.alloc(contract.dataSize);
  Buffer.from(contract.discriminator).copy(data);
  if (action === "deposit_capital_offer") {
    data.writeBigUInt64LE(1_000_000_000n, 8);
  }
  return {
    action,
    programId: FASED_AGENT_CAPITAL_CONTRACT.programId,
    dataBase64: data.toString("base64"),
    keys: contract.accounts.map((account) => ({
      pubkey:
        "address" in account
          ? account.address
          : account.signer
            ? signer
            : Keypair.generate().publicKey.toBase58(),
      isSigner: account.signer,
      isWritable: account.writable,
    })),
  } as AgentCapitalInstruction;
}

describe("Agent Capital reviewed runtime contract", () => {
  beforeEach(() => vi.clearAllMocks());

  it("binds action, program, account order, signer and deterministic restart identity", () => {
    const signer = Keypair.generate().publicKey.toBase58();
    const deposit = validateAgentCapitalInstruction(
      instruction("deposit_capital_offer", signer),
      signer,
    );
    const left = deriveAgentCapitalRequestId({
      walletId: "owner-vault",
      workflowId: "offer-7-deposit-1",
      instruction: deposit,
    });
    const right = deriveAgentCapitalRequestId({
      walletId: "owner-vault",
      workflowId: "offer-7-deposit-1",
      instruction: deposit,
    });
    expect(left).toBe(right);
    expect(left).toMatch(/^agent-capital-[0-9a-f]{48}$/u);

    const wrongProgram = { ...deposit, programId: Keypair.generate().publicKey.toBase58() };
    expect(() => validateAgentCapitalInstruction(wrongProgram, signer)).toThrow(
      "pinned canonical program",
    );
    const wrongFlags = {
      ...deposit,
      keys: deposit.keys.map((key, index) =>
        index === 1 ? { ...key, isWritable: !key.isWritable } : key,
      ),
    };
    expect(() => validateAgentCapitalInstruction(wrongFlags, signer)).toThrow("flags do not match");
    const wrongData = Buffer.from(deposit.dataBase64, "base64");
    wrongData[0] ^= 0xff;
    expect(() =>
      validateAgentCapitalInstruction(
        { ...deposit, dataBase64: wrongData.toString("base64") },
        signer,
      ),
    ).toThrow("does not match its generated action");
  });

  it("keeps distinct Profile and Mining signatures outside one-wallet runtime execution", () => {
    const profile = Keypair.generate().publicKey.toBase58();
    const bind = instruction("bind_satcoin_vault", profile);
    bind.keys[1] = { ...bind.keys[1], pubkey: Keypair.generate().publicKey.toBase58() };
    bind.keys[2] = { ...bind.keys[2], pubkey: Keypair.generate().publicKey.toBase58() };
    expect(() => validateAgentCapitalInstruction(bind, profile)).toThrow(
      "multi-authority binding remains an explicit owner ceremony",
    );
  });

  it("recovers an ambiguous broadcast, reads finalized state, and never submits a duplicate", async () => {
    const signer = Keypair.generate().publicKey.toBase58();
    const deposit = instruction("deposit_capital_offer", signer);
    const intent = { type: "solana.agentCapitalAction", cluster: "devnet", ...deposit };
    const release = vi.fn();
    const operations: string[] = [];
    callLocalSocketSigner.mockImplementation(
      async (_socketPath: string, request: { op: string; request?: { requestId?: string } }) => {
        operations.push(request.op);
        switch (request.op) {
          case "v2.capabilities":
            return {
              ready: true,
              capabilities: {
                intentTypes: ["solana.agentCapitalAction"],
                features: [
                  "reviewedAgentCapitalActions",
                  "signerOwnedStateRecheck",
                  "durableReviewAuthorization",
                  "ambiguousBroadcastReconciliation",
                ],
              },
            };
          case "v2.policy.get":
            return { hash: `sha256:${"a".repeat(64)}` };
          case "v2.review.get":
            return {
              requestId: request.request?.requestId,
              walletId: "owner-vault",
              intentType: "solana.agentCapitalAction",
              policyHash: `sha256:${"a".repeat(64)}`,
              mode: "reviewed",
              semanticIntent: intent,
              state: "signed",
            };
          case "v2.operation.get":
            return { requestId: request.request?.requestId, state: "unknown" };
          case "v2.operation.reconcile":
            return {
              requestId: request.request?.requestId,
              state: "confirmed",
              signature: "finalized-signature",
            };
          default:
            throw new Error(`unexpected signer operation ${request.op}`);
        }
      },
    );
    const writableCount = deposit.keys.filter((key) => key.isWritable).length;
    fetchPinnedSolanaRpcRead.mockResolvedValue({
      response: new Response(
        JSON.stringify({
          result: {
            context: { slot: 4242 },
            value: Array.from({ length: writableCount }, () => ({
              owner: FASED_AGENT_CAPITAL_CONTRACT.programId,
              data: [Buffer.alloc(8).toString("base64"), "base64"],
            })),
          },
        }),
        { status: 200 },
      ),
      release,
    });

    const result = await executeReviewedAgentCapitalAction({
      socketPath: "/tmp/fased-agent-capital.sock",
      rpcUrl: "https://rpc.invalid",
      cluster: "devnet",
      walletId: "owner-vault",
      walletPublicKey: signer,
      workflowId: "offer-7-deposit-1",
      instruction: deposit,
    });

    expect(result.operation).toMatchObject({
      state: "confirmed",
      signature: "finalized-signature",
    });
    expect(result.readback).toMatchObject({
      finalizedSlot: 4242,
      signature: "finalized-signature",
    });
    expect(result.readback.accounts).toHaveLength(writableCount);
    expect(result.readback.accounts.every((account) => account.exists)).toBe(true);
    expect(operations).toEqual([
      "v2.capabilities",
      "v2.policy.get",
      "v2.review.get",
      "v2.operation.get",
      "v2.operation.reconcile",
    ]);
    expect(operations).not.toContain("v2.review.execute");
    expect(operations).not.toContain("v2.execute");
    expect(release).toHaveBeenCalledOnce();
  });
});
