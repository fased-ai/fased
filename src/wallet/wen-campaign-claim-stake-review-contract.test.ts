import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  bindWenCampaignReview,
  type CampaignReviewExpectation,
} from "./wen-campaign-review-contract.js";
import { campaignSelectionSchema } from "./wen-campaign-selection-contract.js";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/campaign-reviews/claim-stake.json", import.meta.url), "utf8"),
);
const a = fixture.semanticIntent;
const expected: CampaignReviewExpectation = {
  requestId: fixture.requestId,
  walletId: fixture.walletId,
  walletPublicKey: fixture.walletPublicKey,
  policyHash: fixture.policyHash,
  operation: "claim-stake",
  program: a.Claim.Program,
  economy: a.Claim.Economy,
  position: a.Snapshot.Claim.Position.Address,
  amount: 0n,
  maxFee: BigInt(a.Intent.maxFeeLamports),
  genesis: a.Pins.Genesis,
  codeSha256: a.Pins.CodeSHA256,
  deploymentSlot: BigInt(a.Pins.DeploymentSlot),
  upgradeAuthority: a.Pins.UpgradeAuthority,
  claimStake: {
    destination: a.Claim.Destination,
    pool: a.Snapshot.History.Pool.Address,
    stakingPosition: a.Snapshot.History.Position.Address,
    mint: a.Intent.mint,
    pageIndex: BigInt(a.Claim.PageIndex),
    mask: BigInt(a.Claim.Mask),
    minimumNet: BigInt(a.MinimumNet),
    maxTotal: BigInt(a.MaxTotal),
    descriptorSha256: a.Pins.DescriptorSHA256,
    capabilitySha256: a.Pins.CapabilitySHA256,
    day: BigInt(a.Intent.day),
    last: BigInt(a.Intent.last),
    aggregateFrom: BigInt(a.Intent.aggregateFrom),
  },
};
const now = Date.parse(fixture.issuedAt);
const reversed = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(reversed)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .toReversed()
            .map(([key, v]) => [key, reversed(v)]),
        )
      : value;
describe("Go campaign direct-stake stored review", () => {
  it("binds independent Go hashes and recursively reordered JSON", async () => {
    expect(await bindWenCampaignReview(reversed(fixture), expected, now)).toEqual(fixture);
  });
  it("round trips protected selection decimals without allowing extra authority", () => {
    const wire = JSON.parse(
      JSON.stringify(
        { expected, draftSha256: "ab".repeat(32), artifactDigest: fixture.artifactDigest.slice(7) },
        (_k, v) => (typeof v === "bigint" ? String(v) : v),
      ),
    );
    expect(campaignSelectionSchema.parse(wire).expected).toEqual(expected);
    wire.expected.claimStake.extra = true;
    expect(() => campaignSelectionSchema.parse(wire)).toThrow();
  });
  it.each([
    "destination",
    "pool",
    "stakingPosition",
    "mint",
    "descriptorSha256",
    "capabilitySha256",
  ] as const)("rejects replaced protected %s", async (key) => {
    const e = structuredClone(expected);
    e.claimStake![key] = "replacement";
    await expect(bindWenCampaignReview(fixture, e, now)).rejects.toThrow();
  });
  it.each(["pageIndex", "mask", "minimumNet", "maxTotal", "day", "last", "aggregateFrom"] as const)(
    "rejects changed protected %s",
    async (key) => {
      const e = structuredClone(expected);
      e.claimStake![key]++;
      await expect(bindWenCampaignReview(fixture, e, now)).rejects.toThrow();
    },
  );
  it("rejects cross-route expectations, expired review and excessive fees", async () => {
    for (const e of [
      { ...expected, claimStake: undefined },
      { ...expected, operation: "claim" as const },
      { ...expected, maxFee: 0n },
      { ...expected, amount: 1n },
    ]) {
      await expect(bindWenCampaignReview(fixture, e, now)).rejects.toThrow();
    }
    await expect(
      bindWenCampaignReview(fixture, expected, Date.parse(fixture.expiresAt)),
    ).rejects.toThrow();
  });
  it.each(["stateDigest", "transactionDigest", "artifactDigest"])(
    "rejects changed %s",
    async (field) => {
      const r = structuredClone(fixture);
      r[field] = (field === "stateDigest" ? "" : "sha256:") + "ab".repeat(32);
      await expect(bindWenCampaignReview(r, expected, now)).rejects.toThrow();
    },
  );
  it("rejects nested snapshot substitution, unsafe integers and altered message", async () => {
    for (const mutate of [
      (r: typeof fixture) => {
        r.semanticIntent.Snapshot.History.Pool.Data = "AAAA";
      },
      (r: typeof fixture) => {
        r.semanticIntent.Snapshot.Result.NextPosition++;
      },
      (r: typeof fixture) => {
        r.semanticIntent.Fee = Number.MAX_SAFE_INTEGER + 1;
      },
      (r: typeof fixture) => {
        r.semanticIntent.Message = "AAAA";
      },
      (r: typeof fixture) => {
        r.semanticIntent.Snapshot.Claim.Mask = 0;
      },
    ]) {
      const r = structuredClone(fixture);
      mutate(r);
      await expect(bindWenCampaignReview(r, expected, now)).rejects.toThrow();
    }
  });
});
