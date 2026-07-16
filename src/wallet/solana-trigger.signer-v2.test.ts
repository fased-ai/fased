import { describe, expect, it } from "vitest";
import {
  validateJupiterTriggerCancellationOrder,
  validateJupiterTriggerDepositCraftResponse,
} from "./solana-trigger.js";

const WALLET = "11111111111111111111111111111111";
const VAULT = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const MINT = "So11111111111111111111111111111111111111112";
const SOURCE = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

describe("typed Jupiter Trigger API semantics", () => {
  it("binds a crafted deposit to the authenticated vault, mint, amount, and source", () => {
    expect(
      validateJupiterTriggerDepositCraftResponse({
        raw: {
          transaction: Buffer.from("unsigned").toString("base64"),
          requestId: "deposit-request",
          receiverAddress: VAULT,
          mint: MINT,
          amount: "10",
          inputTokenAccount: SOURCE,
        },
        vaultAddress: VAULT,
        inputMint: MINT,
        amount: "10",
        expectedInputTokenAccount: SOURCE,
      }),
    ).toEqual({
      transaction: Buffer.from("unsigned").toString("base64"),
      requestId: "deposit-request",
    });
  });

  it.each([
    ["receiverAddress", WALLET],
    ["mint", WALLET],
    ["amount", "11"],
    ["inputTokenAccount", WALLET],
  ])("rejects a deposit with changed %s", (field, value) => {
    expect(() =>
      validateJupiterTriggerDepositCraftResponse({
        raw: {
          transaction: Buffer.from("unsigned").toString("base64"),
          requestId: "deposit-request",
          receiverAddress: VAULT,
          mint: MINT,
          amount: "10",
          inputTokenAccount: SOURCE,
          [field]: value,
        },
        vaultAddress: VAULT,
        inputMint: MINT,
        amount: "10",
        expectedInputTokenAccount: SOURCE,
      }),
    ).toThrow();
  });

  it("derives exact cancellation semantics from the locked order, not cancel response guesses", () => {
    expect(
      validateJupiterTriggerCancellationOrder({
        raw: {
          id: "order-one",
          userPubkey: WALLET,
          privyWalletPubkey: VAULT,
          inputMint: MINT,
          remainingInputAmount: "25",
        },
        orderId: "order-one",
        walletAddress: WALLET,
      }),
    ).toEqual({
      vaultAddress: VAULT,
      refundMint: MINT,
      refundAmount: "25",
    });
  });

  it.each([
    ["id", "order-two"],
    ["userPubkey", VAULT],
    ["privyWalletPubkey", ""],
    ["inputMint", ""],
    ["remainingInputAmount", "0"],
  ])("rejects cancellation history with changed %s", (field, value) => {
    expect(() =>
      validateJupiterTriggerCancellationOrder({
        raw: {
          id: "order-one",
          userPubkey: WALLET,
          privyWalletPubkey: VAULT,
          inputMint: MINT,
          remainingInputAmount: "25",
          [field]: value,
        },
        orderId: "order-one",
        walletAddress: WALLET,
      }),
    ).toThrow();
  });
});
