import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { callLocalSocketSigner } from "./providers/local-socket-signer-adapter.js";
import { createLocalWenRecoveryProfile } from "./wen-mining-recovery-profile.js";
const session = vi.hoisted(() => ({ begin: vi.fn(), finish: vi.fn(), cancel: vi.fn() }));
vi.mock("./wen-profile-approval.js", () => ({ createWenProfileApproval: () => session }));
vi.mock("./providers/local-socket-signer-adapter.js", () => ({ callLocalSocketSigner: vi.fn() }));
it.skipIf(!process.env.WEN_AUTH_VECTOR_DIR).each(["sol", "sat"])(
  "retains %s execution proof, rejects replay and permits recovery",
  async (op) => {
    const v = JSON.parse(
      await readFile(path.join(process.env.WEN_AUTH_VECTOR_DIR!, op + ".json"), "utf8"),
    );
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse(v.review.issuedAt) + 1);
    const dir = await mkdtemp(path.join(os.tmpdir(), "wen-journey-profile-"));
    try {
      const intent = v.review.semanticIntent.intent;
      const profile = {
        version: 1,
        mode: "local-candidate-only",
        walletId: v.review.walletId,
        socketPath: "/fixture.sock",
        ticks: 1,
        intervalMs: 1000,
        request: {
          cursor: "",
          limit: 1,
          operation: op,
          descriptor: "e30=",
          minFinalizedSlot: intent.minFinalizedSlot,
          expiresSlot: intent.expiresSlot,
          maxFeeLamports: intent.maxFeeLamports,
          maxSlotLag: "2",
          pins: {
            ProgramID: intent.programId,
            Genesis: intent.genesis,
            DescriptorSHA256: intent.descriptorSha256,
            CapabilitySHA256: intent.capabilitySha256,
            CodeSHA256: "a".repeat(64),
            DeploymentSlot: 1,
            UpgradeAuthority: null,
          },
        },
      };
      const file = path.join(dir, "profile.json");
      await writeFile(file, JSON.stringify(profile), { mode: 0o600 });
      const service = createLocalWenRecoveryProfile(file, () => {});
      session.finish.mockResolvedValue(v.finish);
      const result = {
        requestId: v.review.requestId,
        walletId: profile.walletId,
        digest: "a".repeat(64),
        outcome: "finalized-success",
        recoveryRequired: false,
      };
      vi.mocked(callLocalSocketSigner).mockResolvedValue(result);
      await expect(service.runClaimJourney(v.review.requestId, "execute")).rejects.toThrow();
      expect(callLocalSocketSigner).not.toHaveBeenCalled();
      await service.finishClaimApproval("challenge", {});
      await expect(service.runClaimJourney("other-request", "execute")).rejects.toThrow();
      const concurrent = await Promise.allSettled([
        service.runClaimJourney(v.review.requestId, "execute"),
        service.runClaimJourney(v.review.requestId, "execute"),
      ]);
      expect(concurrent.filter((value) => value.status === "fulfilled")).toHaveLength(1);
      expect(concurrent.filter((value) => value.status === "rejected")).toHaveLength(1);
      expect(callLocalSocketSigner).toHaveBeenLastCalledWith("/fixture.sock", {
        op: "v2.wenMining.claim.journey",
        walletId: profile.walletId,
        request: {
          requestId: v.review.requestId,
          action: "execute",
          proof: v.finish.authorization.proof,
        },
      });
      await expect(service.runClaimJourney(v.review.requestId, "execute")).rejects.toThrow();
      expect(await service.runClaimJourney(v.review.requestId, "recover")).toEqual(result);
      expect(callLocalSocketSigner).toHaveBeenLastCalledWith("/fixture.sock", {
        op: "v2.wenMining.claim.journey",
        walletId: profile.walletId,
        request: { requestId: v.review.requestId, action: "recover" },
      });
      await service.finishClaimApproval("challenge", {});
      service.cancelClaimApproval();
      await expect(service.runClaimJourney(v.review.requestId, "execute")).rejects.toThrow();
      await service.finishClaimApproval("challenge", {});
      profile.walletId = "replaced";
      await writeFile(file, JSON.stringify(profile));
      await expect(service.runClaimJourney(v.review.requestId, "execute")).rejects.toThrow();
    } finally {
      clock.mockRestore();
      vi.clearAllMocks();
      await rm(dir, { recursive: true });
    }
  },
);
