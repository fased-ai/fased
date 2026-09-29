import { prepareWenMiningReviewWithSigner } from "./wen-mining-review-preparation.js";
vi.mock("./wen-mining-review-preparation.js", () => ({
  prepareWenMiningReviewWithSigner: vi.fn(),
}));
import { proposeWenMiningClaimWithSigner } from "./wen-mining-claim-proposal.js";
vi.mock("./wen-mining-claim-proposal.js", () => ({ proposeWenMiningClaimWithSigner: vi.fn() }));
import { mkdtemp, writeFile, readFile, rm, chmod } from "node:fs/promises";
import os from "node:os";
import { recoverWenMiningWithSigner } from "./wen-mining-recovery.js";
vi.mock("./wen-mining-recovery.js", () => ({ recoverWenMiningWithSigner: vi.fn() }));
import path from "node:path";
import { it, expect, vi } from "vitest";
import type { WenRecoveryLifecycleConfig } from "./wen-mining-recovery-lifecycle.js";
import { createLocalWenRecoveryProfile } from "./wen-mining-recovery-profile.js";
const mock = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn(async () => {}) }));
vi.mock("./wen-mining-recovery-lifecycle.js", () => ({
  createWenMiningRecoveryLifecycle: () => mock,
}));
it.each([
  "valid",
  "prepare",
  "prepare-change",
  "prepare-pins",
  "prepare-fee",
  "prepare-slots",
  "claim",
  "claim-change",
  "claim-pins",
  "claim-fee",
  "claim-override",
  "mode",
  "permissions",
  "identity",
  "late-wallet",
  "late-budget",
  "pages",
  "restart",
  "refresh",
  "refresh-change",
  "refresh-invalid-cursor",
  "capacity-count",
  "capacity-bytes",
])("local recovery profile %s", async (mode) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wen-profile-"));
  const file = path.join(dir, "profile.json");
  const profile = {
    version: 1,
    mode: "local-candidate-only",
    walletId: "miner",
    socketPath: "/socket",
    ticks: 1,
    intervalMs: 5000,
    request: {
      cursor: "",
      limit: 1,
      operation: "sol",
      descriptor: "e30=",
      pins: {
        ProgramID: "p",
        Genesis: "g",
        DescriptorSHA256: "ab".repeat(32),
        CapabilitySHA256: "cd".repeat(32),
        CodeSHA256: "ef".repeat(32),
        DeploymentSlot: 1,
        UpgradeAuthority: null,
      },
      minFinalizedSlot: "100",
      expiresSlot: "132",
      maxFeeLamports: "5000",
      maxSlotLag: "2",
    },
  };
  let selected!: WenRecoveryLifecycleConfig;
  mock.start.mockImplementation(async (config) => {
    selected = config;
  });
  const errors = vi.fn();
  const service = createLocalWenRecoveryProfile(file, errors);
  try {
    if (mode === "mode") {
      profile.mode = "live";
    }
    await writeFile(file, JSON.stringify(profile), { mode: 0o600 });
    if (mode === "permissions") {
      await chmod(file, 0o644);
    }
    if (mode === "mode" || mode === "permissions") {
      await expect(service.start()).rejects.toThrow();
      return;
    }
    if (mode.startsWith("claim") || mode.startsWith("prepare")) {
      vi.mocked(proposeWenMiningClaimWithSigner).mockReset();
      const base = {
        operation: "sol",
        descriptorSha256: profile.request.pins.DescriptorSHA256,
        capabilitySha256: profile.request.pins.CapabilitySHA256,
        accountStateSha256: "a".repeat(64),
        programId: "p",
        genesis: "g",
        economy: "e",
        id: "1",
        nonce: "1",
        ordinal: "0",
        expectedGross: "100",
        minimumReceived: "100",
        maxFeeLamports: "5000",
        minFinalizedSlot: "100",
        expiresSlot: "132",
      };
      if (mode.startsWith("prepare")) {
        vi.mocked(prepareWenMiningReviewWithSigner).mockReset();
        vi.mocked(prepareWenMiningReviewWithSigner).mockImplementation(async () => {
          if (mode === "prepare-change") {
            profile.walletId = "replaced";
            await writeFile(file, JSON.stringify(profile));
          }
          return { requestId: "prepared" } as never;
        });
        if (mode === "prepare-pins") {
          base.programId = "other";
        }
        if (mode === "prepare-fee") {
          base.maxFeeLamports = "5001";
        }
        if (mode === "prepare-slots") {
          base.minFinalizedSlot = "101";
        }
        const request = { requestId: "prepare-test", intent: base, reviewSha256: "b".repeat(64) };
        if (mode === "prepare") {
          expect(await service.prepareClaimApproval(request)).toEqual({ requestId: "prepared" });
          expect(prepareWenMiningReviewWithSigner).toHaveBeenCalledWith(
            "/socket",
            "miner",
            request,
          );
        } else {
          await expect(service.prepareClaimApproval(request)).rejects.toThrow();
          if (mode !== "prepare-change") {
            expect(prepareWenMiningReviewWithSigner).not.toHaveBeenCalled();
          }
        }
        return;
      }
      const input = { base, reviewSha256: "b".repeat(64) };
      const result = {
        intent: { ...base, operation: "sol" as const },
        baseReviewSha256: input.reviewSha256,
        observedSlot: 101,
        signingEnabled: false as const,
      };
      vi.mocked(proposeWenMiningClaimWithSigner).mockImplementation(async () => {
        if (mode === "claim-change") {
          profile.walletId = "replaced";
          await writeFile(file, JSON.stringify(profile));
        }
        return result;
      });
      if (mode === "claim-pins") {
        base.programId = "other";
      }
      if (mode === "claim-fee") {
        base.maxFeeLamports = "5001";
      }
      if (mode === "claim-override") {
        Object.assign(input, { walletId: "other" });
      }
      if (mode === "claim") {
        expect(await service.refreshAdmittedClaim(input)).toEqual(result);
        expect(proposeWenMiningClaimWithSigner).toHaveBeenCalledWith("/socket", "miner", {
          ...input,
          minFinalizedSlot: "100",
          expiresSlot: "132",
        });
      } else {
        await expect(service.refreshAdmittedClaim(input)).rejects.toThrow();
        if (mode !== "claim-change") {
          expect(proposeWenMiningClaimWithSigner).not.toHaveBeenCalled();
        }
      }
      return;
    }
    if (mode.startsWith("refresh")) {
      vi.mocked(recoverWenMiningWithSigner).mockReset();
      // Even a forged mailbox must never be used as the returned review source.
      await writeFile(file + ".review.json", '{"signingEnabled":true,"result":"forged"}');
      const fresh = {
        items: [],
        nextCursor: "",
        scanComplete: true,
        scanned: 0,
        signingEnabled: false as const,
      };
      vi.mocked(recoverWenMiningWithSigner).mockImplementation(async () => {
        if (mode === "refresh-change") {
          profile.walletId = "replacement";
          await writeFile(file, JSON.stringify(profile));
        }
        return fresh;
      });
      if (mode === "refresh-invalid-cursor") {
        await expect(service.refreshReviewPage("../bad")).rejects.toThrow();
        expect(recoverWenMiningWithSigner).not.toHaveBeenCalled();
      } else if (mode === "refresh-change") {
        await expect(service.refreshReviewPage()).rejects.toThrow(
          "profile changed during review refresh",
        );
      } else {
        expect(await service.refreshReviewPage("admission.json")).toEqual(fresh);
        expect(recoverWenMiningWithSigner).toHaveBeenCalledWith("/socket", "miner", {
          ...profile.request,
          cursor: "admission.json",
        });
      }
      return;
    }
    await service.start();
    expect(await selected.request(new AbortController().signal)).toEqual(profile.request);
    if (mode === "identity") {
      profile.walletId = "other";
      await writeFile(file, JSON.stringify(profile));
      await expect(selected.request(new AbortController().signal)).rejects.toThrow(
        "identity changed",
      );
      return;
    }
    if (mode.startsWith("capacity-")) {
      const result = {
        items: [],
        nextCursor: "",
        scanComplete: true,
        scanned: 0,
        signingEnabled: false as const,
      };
      const count = mode === "capacity-count" ? 100 : 1;
      for (let i = 0; i < count; i++) {
        selected.onResult(result);
      }
      await service.stop();
      const before = await readFile(file + ".review.json", "utf8");
      selected.onResult(
        mode === "capacity-count"
          ? result
          : {
              ...result,
              items: [{ entry: "x".repeat(8 * 1024 * 1024), status: "readback-rejected" as const }],
            },
      );
      await service.stop();
      expect(await readFile(file + ".review.json", "utf8")).toBe(before);
      expect(errors).toHaveBeenCalledOnce();
      expect(String(errors.mock.calls[0][0])).toContain("capacity reached");
      return;
    }
    if (mode === "late-wallet" || mode === "late-budget") {
      if (mode === "late-wallet") {
        profile.walletId = "other";
      } else {
        profile.request.maxFeeLamports = "1";
      }
      await writeFile(file, JSON.stringify(profile));
    }
    if (mode === "pages" || mode === "restart") {
      const first = {
        items: [{ entry: "first", status: "readback-rejected" as const }],
        nextCursor: "admission.json",
        scanComplete: false,
        scanned: 1,
        signingEnabled: false as const,
      };
      selected.onResult(first);
      await service.stop();
      profile.request.minFinalizedSlot = "101";
      profile.request.expiresSlot = "133";
      if (mode === "restart") {
        profile.walletId = "replacement";
      }
      await writeFile(file, JSON.stringify(profile));
      if (mode === "restart") {
        await service.start();
      }
      expect(await selected.request(new AbortController().signal)).toEqual(profile.request);
    }
    selected.onResult({
      items: [],
      nextCursor: "",
      scanComplete: true,
      scanned: 0,
      signingEnabled: false,
    });
    await service.stop();
    if (mode === "late-wallet" || mode === "late-budget") {
      await expect(readFile(file + ".review.json")).rejects.toMatchObject({ code: "ENOENT" });
      expect(errors).toHaveBeenCalledOnce();
      return;
    }
    expect(JSON.parse(await readFile(file + ".review.json", "utf8"))).toMatchObject({
      mode: "local-candidate-only",
      walletId: profile.walletId,
      signingEnabled: false,
    });
    if (mode === "pages" || mode === "restart") {
      const mailbox = JSON.parse(await readFile(file + ".review.json", "utf8"));
      expect(mailbox.history).toHaveLength(mode === "pages" ? 2 : 1);
      expect(mailbox.history.at(-1).request.minFinalizedSlot).toBe("101");
      expect(mailbox.history.at(-1).request.cursor).toBe(mode === "pages" ? "admission.json" : "");
      if (mode === "pages") {
        expect(mailbox.history[0].result.items[0].entry).toBe("first");
        expect(mailbox.history[0].request.minFinalizedSlot).toBe("100");
      }
    }
    expect(errors).not.toHaveBeenCalled();
  } finally {
    await service.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
