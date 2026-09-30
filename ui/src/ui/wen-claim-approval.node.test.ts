import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { authorizeSignerReviewWithPasskey } from "./wallet-passkey.js";
import { approveWenClaim } from "./wen-claim-approval.js";
vi.mock("./wallet-passkey.js", () => ({ authorizeSignerReviewWithPasskey: vi.fn() }));
it.skipIf(!process.env.WEN_AUTH_VECTOR_DIR).each(["sol", "sat"])(
  "browser binds %s approval before credential handoff",
  async (op) => {
    const v = JSON.parse(
      await readFile(path.join(process.env.WEN_AUTH_VECTOR_DIR!, op + ".json"), "utf8"),
    );
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse(v.review.issuedAt) + 1);
    try {
      for (const mode of [
        "ok",
        "wrong-wallet",
        "wrong-binding",
        "canceled",
        "lost-reply",
        "lost-execute",
      ]) {
        const controller = new AbortController();
        const request = vi.fn(async (method: string) => {
          if (method.endsWith("cancel")) {
            return {};
          }
          if (method.endsWith("execute") && mode === "lost-execute") {
            throw Error("lost execute");
          }
          if (method.endsWith("finish") && mode === "lost-reply") {
            throw Error("lost reply");
          }
          const payload = structuredClone(
            method.endsWith("execute") || method.endsWith("recover")
              ? {
                  requestId: v.review.requestId,
                  walletId: v.review.walletId,
                  digest: "a".repeat(64),
                  outcome: "finalized-success",
                  recoveryRequired: false,
                }
              : method.endsWith("prepare")
                ? v.review
                : method.endsWith("begin")
                  ? v.begin
                  : v.finish,
          );
          if (mode === "wrong-binding" && method.endsWith("begin")) {
            payload.binding.walletId = "replacement";
          }
          return {
            ok: true,
            mode: "local-candidate-only",
            signingEnabled: method.endsWith("execute"),
            payload,
          };
        });
        vi.mocked(authorizeSignerReviewWithPasskey).mockImplementation(async () => {
          if (mode === "canceled") {
            controller.abort();
          }
          return { challengeId: v.begin.challengeId, credential: { id: "fixture" } };
        });
        const action = approveWenClaim(
          { request } as never,
          mode === "wrong-wallet" ? "other" : v.review.walletId,
          {
            requestId: v.review.requestId,
            intent: v.review.semanticIntent.intent,
            reviewSha256: v.review.semanticIntent.binding.ReviewSHA,
          },
          controller.signal,
        );
        if (mode === "ok" || mode === "lost-execute") {
          expect(await action).toMatchObject({
            outcome: "finalized-success",
            recoveryRequired: false,
          });
        } else {
          await expect(action).rejects.toThrow();
        }
        const finishes = request.mock.calls.filter(([method]) => method.endsWith("finish"));
        expect(finishes).toHaveLength(
          mode === "ok" || mode === "lost-reply" || mode === "lost-execute" ? 1 : 0,
        );
        expect(request.mock.calls.filter(([method]) => method.endsWith("execute"))).toHaveLength(
          mode === "ok" || mode === "lost-execute" ? 1 : 0,
        );
        if (mode.startsWith("wrong")) {
          expect(authorizeSignerReviewWithPasskey).not.toHaveBeenCalled();
        }
        expect(request).toHaveBeenLastCalledWith("wen.mining.approval.cancel", {});
        vi.mocked(authorizeSignerReviewWithPasskey).mockClear();
      }
    } finally {
      clock.mockRestore();
    }
  },
);
