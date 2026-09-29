import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { parseLocalSocketSignerRequest } from "./local-socket-signer-protocol.js";
import { callLocalSocketSigner } from "./providers/local-socket-signer-adapter.js";
import {
  bindWenMiningStoredReview,
  validateWenMiningReviewPrepareRequest,
} from "./wen-mining-review-preparation-contract.js";
import { prepareWenMiningReviewWithSigner } from "./wen-mining-review-preparation.js";
vi.mock("./providers/local-socket-signer-adapter.js", () => ({ callLocalSocketSigner: vi.fn() }));
it.skipIf(!process.env.WEN_PREPARE_VECTOR_DIR).each(["sol", "sat"])(
  "binds actual Go prepared %s review and rejects tampering",
  async (op) => {
    const vector = JSON.parse(
      await readFile(path.join(process.env.WEN_PREPARE_VECTOR_DIR!, op + ".json"), "utf8"),
    );
    const req = validateWenMiningReviewPrepareRequest(vector.request);
    // Test the fixture at its recorded preparation time, not at replay time.
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse(vector.review.issuedAt) + 1);
    try {
      vi.mocked(callLocalSocketSigner).mockResolvedValue(vector.review);
      expect(await prepareWenMiningReviewWithSigner("/test.sock", "miner", req)).toEqual(
        vector.review,
      );
      expect(
        parseLocalSocketSignerRequest(vi.mocked(callLocalSocketSigner).mock.calls.at(-1)![1]).op,
      ).toBe("v2.wenMining.claim.review.prepare");
      for (const change of [
        { walletId: "other" },
        { requestId: "other-request" },
        { amount: "1" },
        { artifactDigest: "sha256:" + "0".repeat(64) },
        { transactionDigest: "sha256:" + "0".repeat(64) },
        { signature: "unexpected" },
        { expiresAt: vector.review.issuedAt },
      ]) {
        await expect(
          bindWenMiningStoredReview({ ...vector.review, ...change }, req, "miner"),
        ).rejects.toThrow();
      }
      for (const key of ["Message", "ReviewSHA", "Fee", "StateHash"]) {
        const changed = structuredClone(vector.review);
        changed.semanticIntent.binding[key] = key === "Fee" ? 1 : "a".repeat(64);
        await expect(bindWenMiningStoredReview(changed, req, "miner")).rejects.toThrow();
      }
      const reordered = {
        ...vector.review,
        semanticIntent: Object.fromEntries(
          Object.entries(vector.review.semanticIntent).toReversed(),
        ),
      };
      expect(await bindWenMiningStoredReview(reordered, req, "miner")).toEqual(reordered);
    } finally {
      clock.mockRestore();
      vi.resetAllMocks();
    }
  },
);
it("rejects malformed request IDs before calling the signer", async () => {
  await expect(
    prepareWenMiningReviewWithSigner("/test.sock", "miner", { requestId: " bad " }),
  ).rejects.toThrow();
  expect(callLocalSocketSigner).not.toHaveBeenCalled();
});
