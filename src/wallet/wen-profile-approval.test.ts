import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { beginWenMiningApproval } from "./wen-mining-review-authorization.js";
import { createWenProfileApproval } from "./wen-profile-approval.js";
vi.mock("./wen-mining-review-authorization.js", () => ({ beginWenMiningApproval: vi.fn() }));
it.skipIf(!process.env.WEN_AUTH_VECTOR_DIR).each(["sol", "sat"])(
  "profile retains and cancels %s approval",
  async (op) => {
    const vector = JSON.parse(
      await readFile(path.join(process.env.WEN_AUTH_VECTOR_DIR!, op + ".json"), "utf8"),
    );
    const v = vector.review.semanticIntent.intent;
    const profile = {
      walletId: "miner",
      socketPath: "/fixture.sock",
      request: {
        cursor: "",
        limit: 1,
        operation: op,
        descriptor: "e30=",
        minFinalizedSlot: v.minFinalizedSlot,
        expiresSlot: v.expiresSlot,
        maxFeeLamports: v.maxFeeLamports,
        maxSlotLag: "2",
        pins: {
          ProgramID: v.programId,
          Genesis: v.genesis,
          DescriptorSHA256: v.descriptorSha256,
          CapabilitySHA256: v.capabilitySha256,
          CodeSHA256: "a".repeat(64),
          DeploymentSlot: 1,
          UpgradeAuthority: null,
        },
      },
    };
    try {
      for (const mode of [
        "ok",
        "wrong-profile",
        "changed-before-finish",
        "changed-during-finish",
        "stop-during-begin",
        "stop-during-finish",
      ]) {
        const selected = structuredClone(profile);
        const manager = createWenProfileApproval(async () => structuredClone(selected) as never);
        const finish = vi.fn(async () => {
          if (mode === "changed-during-finish") {
            selected.walletId = "replacement";
          }
          if (mode === "stop-during-finish") {
            manager.cancel();
          }
          return vector.finish;
        });
        vi.mocked(beginWenMiningApproval).mockImplementation(async () => {
          if (mode === "stop-during-begin") {
            manager.cancel();
          }
          return { challenge: vector.begin, finish };
        });
        if (mode === "wrong-profile") {
          selected.walletId = "other";
        }
        if (mode === "wrong-profile" || mode === "stop-during-begin") {
          await expect(manager.begin(vector.review)).rejects.toThrow();
          if (mode === "wrong-profile") {
            expect(beginWenMiningApproval).not.toHaveBeenCalled();
          }
        } else {
          const challenge = await manager.begin(vector.review);
          await expect(manager.begin(vector.review)).rejects.toThrow("already pending");
          await expect(manager.finish("other-challenge", {})).rejects.toThrow();
          expect(finish).not.toHaveBeenCalled();
          if (mode === "changed-before-finish") {
            selected.request.maxFeeLamports = "1";
          }
          if (mode === "ok") {
            expect(await manager.finish(challenge.challengeId, {})).toEqual(vector.finish);
          } else {
            await expect(manager.finish(challenge.challengeId, {})).rejects.toThrow();
          }
          await expect(manager.finish(challenge.challengeId, {})).rejects.toThrow();
          if (mode === "changed-before-finish") {
            expect(finish).not.toHaveBeenCalled();
          }
        }
        manager.cancel();
        vi.resetAllMocks();
      }
    } finally {
      vi.resetAllMocks();
    }
  },
);
