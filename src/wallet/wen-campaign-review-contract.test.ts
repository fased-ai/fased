import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  bindWenCampaignReview,
  type CampaignReviewExpectation,
} from "./wen-campaign-review-contract.js";

describe.each(["stop", "top-up", "withdraw", "setup"])("campaign %s review", (operation) => {
  const fixture = JSON.parse(
    readFileSync(new URL(`./fixtures/campaign-reviews/${operation}.json`, import.meta.url), "utf8"),
  );
  const a = fixture.semanticIntent;
  const expected: CampaignReviewExpectation = {
    requestId: fixture.requestId,
    walletId: fixture.walletId,
    walletPublicKey: fixture.walletPublicKey,
    policyHash: fixture.policyHash,
    program: a.Action.Program,
    economy: a.Action.Economy,
    position: a.Action.Position,
    operation: a.Action.Operation,
    amount: BigInt(a.Action.Amount),
    maxFee: BigInt(a.Binding.MaxFee),
    genesis: a.Pins.Genesis,
    codeSha256: a.Pins.CodeSHA256,
    deploymentSlot: BigInt(a.Pins.DeploymentSlot),
    upgradeAuthority: a.Pins.UpgradeAuthority,
    ...(a.Action.Setup
      ? {
          setup: {
            issuer: a.Action.Setup.Issuer,
            nonce: BigInt(a.Action.Setup.Nonce),
            deposit: BigInt(a.Action.Setup.Terms.Deposit),
            maxPrice: BigInt(a.Action.Setup.Terms.MaxPrice),
            daily: BigInt(a.Action.Setup.Terms.Daily),
            total: BigInt(a.Action.Setup.Terms.Total),
            expiry: BigInt(a.Action.Setup.Terms.Expiry),
            maxWait: BigInt(a.Action.Setup.Terms.MaxWait),
            maxRent: BigInt(a.Binding.Setup.Rent),
          },
        }
      : {}),
  };
  const now = Date.parse(fixture.issuedAt);
  it("binds a real Go-generated stored review without relying on object key order", async () => {
    const reversed = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(reversed)
        : v !== null && typeof v === "object"
          ? Object.fromEntries(
              Object.entries(v)
                .toReversed()
                .map(([k, x]) => [k, reversed(x)]),
            )
          : v;
    expect(await bindWenCampaignReview(reversed(fixture), expected, now)).toEqual(fixture);
  });
  it.each([
    "walletId",
    "requestId",
    "policyHash",
    "transactionDigest",
    "stateDigest",
    "amount",
    "destination",
    "nonce",
  ])("rejects altered %s", async (key) => {
    const changed = structuredClone(fixture);
    changed[key] = "changed";
    await expect(bindWenCampaignReview(changed, expected, now)).rejects.toThrow();
  });
  it("rejects changed setup limits and missing setup scope", async () => {
    if (!expected.setup) {
      return;
    }
    for (const key of [
      "nonce",
      "deposit",
      "maxPrice",
      "daily",
      "total",
      "expiry",
      "maxWait",
    ] as const) {
      const changed = structuredClone(expected);
      changed.setup![key]++;
      await expect(bindWenCampaignReview(fixture, changed, now)).rejects.toThrow();
    }
    await expect(
      bindWenCampaignReview(fixture, { ...expected, setup: undefined }, now),
    ).rejects.toThrow();
    await expect(
      bindWenCampaignReview(
        fixture,
        { ...expected, setup: { ...expected.setup, maxRent: 0n } },
        now,
      ),
    ).rejects.toThrow();
  });
  it("rejects expired reviews, wrong intended operation, fee limits and deployment", async () => {
    await expect(
      bindWenCampaignReview(fixture, expected, Date.parse(fixture.expiresAt)),
    ).rejects.toThrow();
    for (const changed of [
      { amount: expected.amount + 1n },
      { maxFee: 1n },
      { codeSha256: "ab".repeat(32) },
      { genesis: "replacement" },
    ]) {
      await expect(
        bindWenCampaignReview(fixture, { ...expected, ...changed }, now),
      ).rejects.toThrow();
    }
  });
  it("rejects valid-shaped but changed state and digest bytes", async () => {
    for (const field of ["stateDigest", "transactionDigest", "artifactDigest"]) {
      const changed = structuredClone(fixture);
      changed[field] = (field === "stateDigest" ? "" : "sha256:") + "ab".repeat(32);
      await expect(bindWenCampaignReview(changed, expected, now)).rejects.toThrow();
    }
    const changed = structuredClone(fixture);
    changed.semanticIntent.Binding.Position.Data = "AAAA";
    await expect(bindWenCampaignReview(changed, expected, now)).rejects.toThrow();
  });
  it("requires the authenticated accounting read on existing owner positions", async () => {
    if (operation === "setup") {
      return;
    }
    for (const accounting of [undefined, "", "ab".repeat(32)]) {
      const changed = structuredClone(fixture);
      if (accounting === undefined) {
        delete changed.semanticIntent.Binding.Position.AccountingSHA256;
      } else {
        changed.semanticIntent.Binding.Position.AccountingSHA256 = accounting;
      }
      await expect(bindWenCampaignReview(changed, expected, now)).rejects.toThrow();
    }
  });
  it("rejects altered messages and unsafe numeric values", async () => {
    for (const field of ["Message", "MaxFee"]) {
      const changed = structuredClone(fixture);
      changed.semanticIntent.Binding[field] =
        field === "Message" ? "AAAA" : Number.MAX_SAFE_INTEGER + 1;
      await expect(bindWenCampaignReview(changed, expected, now)).rejects.toThrow();
    }
  });
});
