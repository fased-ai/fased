import { readFileSync } from "node:fs";
import { VersionedMessage } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  parseWenMarketSelection,
  bindWenMarketReview,
  type MarketReviewExpectation,
} from "./wen-market-review-contract.js";
const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/market-reviews/buy.json", import.meta.url), "utf8"),
);
const a = fixture.semanticIntent;
export const expected: MarketReviewExpectation = {
  requestId: fixture.requestId,
  walletId: fixture.walletId,
  walletPublicKey: fixture.walletPublicKey,
  policyHash: fixture.policyHash,
  pins: a.Pins,
  policy: a.Policy,
  limits: a.Limits,
  maxFee: BigInt(a.Binding.MaxFee),
  retainedLamports: BigInt(a.Binding.RetainedLamports),
};
const now = Date.parse(fixture.issuedAt);
function reverse(v: unknown): unknown {
  if (Array.isArray(v)) {
    return v.map(reverse);
  }
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v)
        .toReversed()
        .map(([k, v]) => [k, reverse(v)]),
    );
  }
  return v;
}
describe("protected Buy client review", () => {
  it("binds actual Go review, canonical digest and independent instruction/account derivation", async () => {
    expect(await bindWenMarketReview(reverse(fixture), expected, now)).toEqual(fixture);
  });
  it.each([
    "owner",
    "program",
    "genesis",
    "quantity",
    "cash",
    "minimum",
    "cost",
    "retained",
    "state",
    "message",
    "digest",
    "unsafe",
    "unknown",
  ])("rejects substituted %s", async (mode) => {
    const r = structuredClone(fixture),
      a = r.semanticIntent;
    switch (mode) {
      case "owner":
        r.walletPublicKey = a.Pins.Pool;
        break;
      case "program":
        a.Policy.Successor.ProgramID = a.Pins.Owner;
        break;
      case "genesis":
        a.Policy.Venue.Genesis = "wrong";
        break;
      case "quantity":
        a.Limits.RequestedNet++;
        break;
      case "cash":
        a.Binding.Snapshot.Quote.InputCash++;
        break;
      case "minimum":
        a.Limits.MinimumNet = 0;
        break;
      case "cost":
        a.Binding.MaxFee++;
        break;
      case "retained":
        a.Binding.RetainedLamports--;
        break;
      case "state":
        r.stateDigest = "ff".repeat(32);
        break;
      case "message":
        a.Binding.Message = btoa("changed");
        break;
      case "digest":
        r.artifactDigest = "sha256:" + "ff".repeat(32);
        break;
      case "unsafe":
        a.Binding.Snapshot.Quote.InputCash = Number.MAX_SAFE_INTEGER + 1;
        break;
      case "unknown":
        a.rpc = "https://caller.invalid";
        break;
    }
    await expect(bindWenMarketReview(r, expected, now)).rejects.toThrow();
  });
  it("rejects stale review and changed protected selection", async () => {
    await expect(
      bindWenMarketReview(fixture, expected, Date.parse(fixture.expiresAt)),
    ).rejects.toThrow();
    await expect(
      bindWenMarketReview(
        fixture,
        { ...expected, pins: { ...expected.pins, Pool: expected.pins.Owner } },
        now,
      ),
    ).rejects.toThrow();
  });
});

async function rehash(r: typeof fixture) {
  const sha = async (raw: Uint8Array) =>
    Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", raw as Uint8Array<ArrayBuffer>)),
      (x) => x.toString(16).padStart(2, "0"),
    ).join("");
  r.transactionDigest =
    "sha256:" +
    (await sha(Uint8Array.from(atob(r.semanticIntent.Binding.Message), (c) => c.charCodeAt(0))));
  r.artifactDigest = r.intentDigest =
    "sha256:" +
    (await sha(
      new TextEncoder().encode("wen-market-buy-review-v1\0" + JSON.stringify(r.semanticIntent)),
    ));
}
it.each(["cash instruction", "privileges"])(
  "rejects coherently rehashed %s through independent message verification",
  async (mode) => {
    const r = structuredClone(fixture),
      a = r.semanticIntent;
    if (mode === "cash instruction") {
      a.Binding.Snapshot.Quote.InputCash++;
      r.amount = String(a.Binding.Snapshot.Quote.InputCash);
    } else {
      const m = VersionedMessage.deserialize(
        Uint8Array.from(atob(a.Binding.Message), (c) => c.charCodeAt(0)),
      );
      m.header.numReadonlyUnsignedAccounts--;
      a.Binding.Message = btoa(String.fromCharCode(...m.serialize()));
    }
    await rehash(r);
    await expect(bindWenMarketReview(r, expected, now)).rejects.toThrow(
      mode === "cash instruction" ? "instruction amounts" : "account privileges",
    );
  },
);

it("parses protected Buy selection without unsafe or caller-controlled additions", () => {
  const selected = JSON.parse(
    JSON.stringify(
      { expected, draftSha256: "ab".repeat(32), artifactDigest: fixture.artifactDigest.slice(7) },
      (_, v) => (typeof v === "bigint" ? v.toString() : v),
    ),
  );
  expect(parseWenMarketSelection(selected).expected).toEqual(expected);
  expect(() => parseWenMarketSelection({ ...selected, rpc: "https://caller.invalid" })).toThrow();
  const changed = structuredClone(selected);
  changed.expected.maxFee = "18446744073709551616";
  expect(() => parseWenMarketSelection(changed)).toThrow();
  changed.expected.maxFee = "5000";
  changed.expected.limits.RequestedNet = Number.MAX_SAFE_INTEGER + 1;
  expect(() => parseWenMarketSelection(changed)).toThrow();
});
