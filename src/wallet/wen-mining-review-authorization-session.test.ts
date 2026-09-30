import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { callLocalSocketSigner } from "./providers/local-socket-signer-adapter.js";
import { beginWenMiningApproval } from "./wen-mining-review-authorization.js";
vi.mock("./providers/local-socket-signer-adapter.js", () => ({ callLocalSocketSigner: vi.fn() }));
it.skipIf(!process.env.WEN_AUTH_VECTOR_DIR).each(["sol", "sat"])(
  "retains %s approval identity and rejects reuse/cancellation",
  async (op) => {
    const v = JSON.parse(
      await readFile(path.join(process.env.WEN_AUTH_VECTOR_DIR!, op + ".json"), "utf8"),
    );
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse(v.review.issuedAt) + 1);
    try {
      const rpc = vi.mocked(callLocalSocketSigner);
      rpc.mockResolvedValueOnce(v.begin).mockResolvedValueOnce(v.finish);
      const original = structuredClone(v.review),
        controller = new AbortController();
      const session = await beginWenMiningApproval(
        "/fixture.sock",
        "miner",
        original,
        controller.signal,
      );
      original.walletId = "other";
      session.challenge.challengeId = "changed";
      const credential = { id: "assertion" };
      expect(await session.finish(credential)).toEqual(v.finish);
      expect(rpc).toHaveBeenLastCalledWith("/fixture.sock", {
        op: "v2.review.authorization.finish",
        walletId: "miner",
        request: { challengeId: v.begin.challengeId, credential },
      });
      await expect(session.finish(credential)).rejects.toThrow("already");
      expect(rpc).toHaveBeenCalledTimes(2);
      rpc.mockReset();
      rpc.mockResolvedValueOnce(v.begin);
      const cancelled = new AbortController();
      const second = await beginWenMiningApproval(
        "/fixture.sock",
        "miner",
        v.review,
        cancelled.signal,
      );
      cancelled.abort();
      await expect(second.finish(credential)).rejects.toThrow();
      expect(rpc).toHaveBeenCalledTimes(1);
      rpc.mockReset();
      rpc.mockResolvedValueOnce(v.begin).mockRejectedValueOnce(Error("lost reply"));
      const third = await beginWenMiningApproval(
        "/fixture.sock",
        "miner",
        v.review,
        new AbortController().signal,
      );
      await expect(third.finish(credential)).rejects.toThrow("lost reply");
      await expect(third.finish(credential)).rejects.toThrow("already");
      expect(rpc).toHaveBeenCalledTimes(2);
      rpc.mockReset();
      rpc.mockResolvedValueOnce(v.begin);
      const late = new AbortController();
      const fourth = await beginWenMiningApproval("/fixture.sock", "miner", v.review, late.signal);
      rpc.mockImplementationOnce(async () => {
        late.abort();
        return v.finish;
      });
      await expect(fourth.finish(credential)).rejects.toThrow();
    } finally {
      clock.mockRestore();
      vi.resetAllMocks();
    }
  },
);
