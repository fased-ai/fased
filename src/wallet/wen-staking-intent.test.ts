import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateWenStakingIntentCandidate } from "./wen-staking-intent.js";
const rows = JSON.parse(
  readFileSync(
    new URL("../../tools/fased-signerd/testdata/wen-staking-candidate.json", import.meta.url),
    "utf8",
  ),
);
describe("WEN staking candidate", () => {
  it("accepts canonical two-launch deposit and whole-position exit vectors", () => {
    expect(rows).toHaveLength(6);
    for (const row of rows) {
      expect(Object.isFrozen(validateWenStakingIntentCandidate(row.intent))).toBe(true);
    }
  });
  it.each([
    { operation: "withdraw" },
    { operation: "requestExit", amount: "1" },
    { operation: "deposit", amount: "0" },
    { amount: "01" },
    { amount: "18446744073709551616" },
    { day: "18446744073709551615" },
    { last: "12" },
    { aggregateFrom: "12" },
    { maxFeeLamports: "0" },
    { maxFeeLamports: "18446744073709551615" },
    { minFinalizedSlot: "0" },
    { expiresSlot: "100" },
    { descriptorSha256: "ABC" },
    { programId: "11111111111111111111111111111111" },
    { mint: "bad" },
    { wire: "AAAA" },
    { rewards: "100" },
  ])("rejects invalid bounds or extra fields %j", (patch) => {
    expect(() => validateWenStakingIntentCandidate({ ...rows[0].intent, ...patch })).toThrow();
  });
});
