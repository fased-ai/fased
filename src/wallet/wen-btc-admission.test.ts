import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { inspectWenBtcReview } from "./wen-btc-admission.js";

const fixture = () => ({
  schema: "fased.wen-btc-subscription-acknowledgement-candidate.v1",
  state: "SOURCE_REVIEW_ONLY",
  publicEntryEnabled: false,
  signingEnabled: false,
  operations: ["acceptance", "acquisition"],
  capabilityDigest: "11".repeat(32),
  sourceDigest: "22".repeat(32),
  contractDigest: "33".repeat(32),
  accountOrderDigest: "44".repeat(32),
  portableClient: "client/btc-subscription-client.mjs",
  deployment: "NOT_BOUND",
  runtime: "NOT_BOUND",
  ownerPermission: "NOT_BOUND",
  legacyCapabilityReuse: false,
});
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const pins = { ...fixture(), artifactDigest: hash(encode(fixture())) };
describe("WEN BTC source review admission", () => {
  it("reports missing authorities without enabling signing", () => {
    const review = inspectWenBtcReview(encode(fixture()), pins);
    expect(review.signingEnabled).toBe(false);
    expect(review.publicEntryEnabled).toBe(false);
    expect(review.missing).toEqual(["deployment", "installedRuntime", "ownerPermission"]);
    expect(Object.isFrozen(review.operations)).toBe(true);
    expect(Object.isFrozen(review.missing)).toBe(true);
  });
  it.each(["capabilityDigest", "sourceDigest", "contractDigest", "accountOrderDigest"])(
    "rejects independently mismatched %s",
    (field) => {
      const bytes = encode({ ...fixture(), [field]: "55".repeat(32) });
      expect(() => inspectWenBtcReview(bytes, { ...pins, artifactDigest: hash(bytes) })).toThrow(
        /mismatched/,
      );
    },
  );
  it.each([
    ["signingEnabled", true],
    ["publicEntryEnabled", true],
    ["legacyCapabilityReuse", true],
    ["deployment", "BOUND"],
    ["runtime", "BOUND"],
    ["ownerPermission", "BOUND"],
    ["operations", ["acquisition", "acceptance"]],
    ["portableClient", "remote.mjs"],
    ["schema", "legacy"],
    ["state", "READY"],
  ])("rejects unsupported %s even with a matching artifact hash", (field, value) => {
    const bytes = encode({ ...fixture(), [field]: value });
    expect(() => inspectWenBtcReview(bytes, { ...pins, artifactDigest: hash(bytes) })).toThrow();
  });
  it("rejects changed bytes, malformed JSON, and oversized input", () => {
    expect(() => inspectWenBtcReview(encode({}), pins)).toThrow(/artifact mismatch/);
    for (const bytes of [
      new Uint8Array(),
      new Uint8Array(16385),
      encode(null),
      new Uint8Array([255]),
    ]) {
      expect(() => inspectWenBtcReview(bytes, { ...pins, artifactDigest: hash(bytes) })).toThrow();
    }
  });
});
