import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { reviewWenCampaignAction } from "./wen-campaign-review.js";
const key = (n: number) => new PublicKey(new Uint8Array(32).fill(n)).toBase58();
const input = {
  operation: "stop",
  genesis: key(1),
  programId: key(2),
  economy: key(3),
  owner: key(4),
  position: key(5),
  programSha256: "ab".repeat(32),
  amountLamports: "0",
  maxFeeLamports: "5000",
  minFinalizedSlot: "10",
  expiresSlot: "20",
};
describe("campaign source review", () => {
  it.each([
    ["stop", "0", 139],
    ["top-up", "1000", 143],
    ["withdraw", "1000", 138],
  ])("reviews %s without signing authority", (operation, amountLamports, opcode) => {
    const result = reviewWenCampaignAction({ ...input, operation, amountLamports });
    expect(result.opcode).toBe(opcode);
    expect(result.signingEnabled).toBe(false);
    expect(result.positionVerified).toBe(false);
    expect(Object.isFrozen(result.candidate)).toBe(true);
  });
  it.each([
    { operation: "commit" },
    { operation: "reveal" },
    { allocation: [1, 2, 3, 4] },
    { dataBase64: "AA==" },
    { amountLamports: "1" },
    { maxFeeLamports: "0" },
    { expiresSlot: "43" },
    { owner: "bad" },
    { amountLamports: "18446744073709551616" },
  ])("rejects incompatible request %j", (change) => {
    expect(() => reviewWenCampaignAction({ ...input, ...change })).toThrow();
  });
});
