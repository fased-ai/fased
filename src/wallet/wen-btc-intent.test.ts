import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateWenBtcIntentCandidate } from "./wen-btc-intent.js";
const fixture = JSON.parse(
  readFileSync(
    new URL("../../tools/fased-signerd/testdata/wen-btc-intent-candidate.json", import.meta.url),
    "utf8",
  ),
);
describe("WEN BTC semantic candidate", () => {
  it.each(["acceptance", "acquisition"])("accepts shared Go fixture for %s", (operation) => {
    expect(Object.isFrozen(validateWenBtcIntentCandidate({ ...fixture, operation }))).toBe(true);
  });
  it.each([
    ["operation", "claim"],
    ["descriptorSha256", ""],
    ["offerSha256", "ZZ"],
    ["programId", "invalid"],
    ["maxCashRaw", "0"],
    ["maxCostRaw", "-1"],
    ["maxFeeLamports", "05000"],
    ["maxRentLamports", "6500000"],
    ["minFinalizedSlot", "0"],
    ["expiresSlot", "100"],
    ["maxCashRaw", "18446744073709551615"],
    ["maxCostRaw", "18446744073709551616"],
    ["dataBase64", "AAAA"],
    ["keys", []],
  ])("rejects %s=%s", (field, value) => {
    expect(() => validateWenBtcIntentCandidate({ ...fixture, [field]: value })).toThrow();
  });
});
