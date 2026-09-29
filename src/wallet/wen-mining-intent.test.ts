import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateWenMiningIntentCandidate } from "./wen-mining-intent.js";
const fixture = JSON.parse(
  readFileSync(
    new URL("../../tools/fased-signerd/testdata/wen-mining-candidate.json", import.meta.url),
    "utf8",
  ),
).intent;
describe("WEN mining candidate request", () => {
  it.each(["commit", "reveal"])("accepts shared Rust/Go fixture for %s", (operation) => {
    const result = validateWenMiningIntentCandidate({ ...fixture, operation });
    expect(Object.isFrozen(result)).toBe(true);
  });
  it.each([
    ["operation", "admit"],
    ["nonce", "01"],
    ["capital", "0"],
    ["open", "9223372036854774908"],
    ["maxFeeLamports", "0"],
    ["maxFeeLamports", "18446744073709551615"],
    ["minFinalizedSlot", "0"],
    ["expiresSlot", "100"],
    ["capital", "18446744073709551616"],
    ["commitmentSha256", "ABC"],
    ["programId", "11111111111111111111111111111111"],
    ["programId", "bad"],
    ["salt", "secret"],
    ["allocation", [10000, 0, 0, 0]],
    ["dataBase64", "AAAA"],
    ["keys", []],
  ])("rejects %s=%s", (key, value) => {
    expect(() => validateWenMiningIntentCandidate({ ...fixture, [key]: value })).toThrow();
  });
});
