import { readFileSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";
import {
  validateLocalSocketSignerResult,
  parseLocalSocketSignerRequest,
} from "./local-socket-signer-protocol.js";
import {
  bindWenBondClaimReview,
  type BondClaimReviewExpectation,
  type BondClaimStoredReview,
} from "./wen-bond-claim-review-contract.js";
import { createWenBondClaimGatewayProfile } from "./wen-campaign-gateway-profile.js";
const call = vi.hoisted(() => vi.fn());
vi.mock("./providers/local-socket-signer-adapter.js", () => ({ callLocalSocketSigner: call }));
function fixture() {
  return JSON.parse(
    readFileSync(new URL("./fixtures/wen-bond-claim-review-v2.json", import.meta.url), "utf8"),
  ) as { review: BondClaimStoredReview; expected: BondClaimReviewExpectation };
}
describe("current Bond public review", () => {
  it("binds the Go protected review and exact admitted packet", async () => {
    const f = fixture();
    const now = Date.parse(f.review.issuedAt) + 1;
    const r = await bindWenBondClaimReview(f.review, f.expected, now);
    expect(r.amount).toBe("10000");
    expect(validateLocalSocketSignerResult("v2.wenBondClaim.review.prepare", r)).toBe(true);
  });
  it.each(["amount", "wallet", "fee", "quote", "message", "artifact", "unsafe", "extra", "expiry"])(
    "rejects changed %s",
    async (mode) => {
      const f = fixture();
      const r = f.review,
        a = r.semanticIntent,
        b = a.Binding;
      switch (mode) {
        case "amount":
          r.amount = "1";
          break;
        case "wallet":
          r.walletId = "other";
          break;
        case "fee":
          b.Fee++;
          break;
        case "quote":
          b.Snapshot.Claim.QuoteSHA256[0] ^= 1;
          break;
        case "message":
          b.Message = "AA==";
          break;
        case "artifact":
          r.artifactDigest = "sha256:" + "0".repeat(64);
          break;
        case "unsafe":
          b.Fee = Number.MAX_SAFE_INTEGER + 1;
          break;
        case "extra":
          Object.assign(a, { extra: true });
          break;
        case "expiry":
          r.expiresAt = r.issuedAt;
          break;
      }
      await expect(
        bindWenBondClaimReview(r, f.expected, Date.parse(r.issuedAt) + 1),
      ).rejects.toThrow();
    },
  );
  it("routes recovery through the current Bond domain without preparing or approving again", async () => {
    const f = fixture();
    const digest = f.expected.artifactDigest.slice(7);
    call.mockReset();
    call.mockResolvedValue({
      requestId: f.expected.requestId,
      walletId: f.expected.walletId,
      digest,
      outcome: "finalized-success",
      recoveryRequired: false,
    });
    const profile = createWenBondClaimGatewayProfile(async () => ({
      socket: { walletId: f.expected.walletId, socketPath: "/tmp/test-bond.sock", revision: "1" },
      expected: f.expected,
      draftSha256: "a".repeat(64),
      artifactDigest: digest,
    }));
    expect((await profile.runClaimJourney(f.expected.requestId, "recover")).outcome).toBe(
      "finalized-success",
    );
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0][1].op).toBe("v2.wenBondClaim.journey");
    expect(call.mock.calls[0][1].request.proof).toBeUndefined();
  });
  it("accepts only typed application requests", () => {
    expect(
      parseLocalSocketSignerRequest({
        op: "v2.wenBondClaim.journey",
        walletId: "miner",
        request: { requestId: "review-request-001", action: "recover" },
      }).op,
    ).toBe("v2.wenBondClaim.journey");
    expect(() =>
      parseLocalSocketSignerRequest({
        op: "v2.wenBondClaim.journey",
        walletId: "miner",
        request: {
          requestId: "review-request-001",
          action: "recover",
          rpc: "https://caller.invalid",
        },
      }),
    ).toThrow();
  });
});
