import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  readWenCampaignJourneyResult,
  validateWenCampaignJourneyRequest,
  validateWenCampaignReviewRequest,
  wenCampaignServiceAvailability,
} from "./wen-campaign-service-contract.js";
const identity = { requestId: "review-request-001", walletId: "miner", digest: "ab".repeat(32) };
describe("campaign service candidate contract", () => {
  it.each(["execute", "recover", "expire", "cancel"])(
    "accepts %s with exact proof rules",
    (action) => {
      const input = {
        requestId: identity.requestId,
        action,
        ...(action === "execute" ? { proof: { proofId: "proof-001" } } : {}),
      };
      expect(validateWenCampaignJourneyRequest(input)).toEqual(input);
    },
  );
  it.each([
    { action: "execute" },
    { action: "recover", proof: { proofId: "p" } },
    { action: "execute", proof: { proofId: " p " } },
    { action: "cancel", rpc: "https://replacement.invalid" },
    { action: "cancel", walletId: "other" },
    { action: "commit" },
  ])("rejects unbound input %j", (input) =>
    expect(() =>
      validateWenCampaignJourneyRequest({ requestId: identity.requestId, ...input }),
    ).toThrow(),
  );
  it("validates review locators without enabling application signing", () => {
    expect(
      validateWenCampaignReviewRequest({
        requestId: identity.requestId,
        draftSha256: identity.digest,
      }).draftSha256,
    ).toBe(identity.digest);
    expect(() =>
      validateWenCampaignReviewRequest({
        requestId: identity.requestId,
        draftSha256: identity.digest,
        programId: "replacement",
      }),
    ).toThrow();
    expect(wenCampaignServiceAvailability.signingEnabled).toBe(false);
  });
  it("binds the actual Go ok/result envelope to the expected identity", () => {
    const response = {
      ok: true,
      result: { ...identity, outcome: "finalized-success", recoveryRequired: false },
    };
    expect(readWenCampaignJourneyResult(response, identity).outcome).toBe("finalized-success");
    for (const mutation of [
      { walletId: "other" },
      { digest: "cd".repeat(32) },
      { requestId: "different-001" },
      { outcome: "submission-uncertain" },
    ]) {
      expect(() =>
        readWenCampaignJourneyResult(
          { ...response, result: { ...response.result, ...mutation } },
          identity,
        ),
      ).toThrow();
    }
    expect(() => readWenCampaignJourneyResult(response.result, identity)).toThrow();
  });
});

// The Go serializer independently checks these same wire vectors.
it("accepts shared signer wire vectors for every journey state", () => {
  const fixture = JSON.parse(
    readFileSync(new URL("./fixtures/wen-campaign-service-v1.json", import.meta.url), "utf8"),
  );
  for (const request of fixture.requests) {
    expect(validateWenCampaignJourneyRequest(request)).toEqual(request);
  }
  for (const response of fixture.responses) {
    expect(readWenCampaignJourneyResult(response, fixture.identity)).toEqual(response.result);
  }
});
