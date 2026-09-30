import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CampaignReviewExpectation } from "../../../src/wallet/wen-campaign-review-contract.js";
import type { CampaignSessionTransport } from "../../../src/wallet/wen-campaign-session.js";
import { authorizeSignerReviewWithPasskey } from "./wallet-passkey.js";
import { approveWenCampaign } from "./wen-campaign-approval.js";
vi.mock("./wallet-passkey.js", () => ({ authorizeSignerReviewWithPasskey: vi.fn() }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(authorizeSignerReviewWithPasskey).mockReset();
});
const fields = [
  "requestId",
  "walletId",
  "walletPublicKey",
  "intentType",
  "intentDigest",
  "semanticIntent",
  "artifactKind",
  "artifactDigest",
  "transactionDigest",
  "stateDigest",
  "stateSlot",
  "asset",
  "amount",
  "destination",
  "policyOperation",
  "requiredPrograms",
  "policyHash",
  "nonce",
  "issuedAt",
  "expiresAt",
];
describe.each(["stop", "top-up", "withdraw"])("browser campaign %s", (operation) => {
  it.each([
    "ok",
    "lost-execute",
    "lost-recover",
    "changed-challenge",
    "bad-review",
    "canceled",
    "lost-finish",
    "retention-failed",
    "abort-after-send",
  ])("handles %s", async (mode) => {
    const review = JSON.parse(
      readFileSync(
        new URL(`../../../src/wallet/fixtures/campaign-reviews/${operation}.json`, import.meta.url),
        "utf8",
      ),
    );
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(review.issuedAt) + 1);
    const a = review.semanticIntent;
    const expected: CampaignReviewExpectation = {
      requestId: review.requestId,
      walletId: review.walletId,
      walletPublicKey: review.walletPublicKey,
      policyHash: review.policyHash,
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
    };
    const binding = { ...Object.fromEntries(fields.map((k) => [k, review[k]])), role: "agent" };
    const controller = new AbortController();
    const events: string[] = [];
    const response = {
      ok: true,
      result: {
        requestId: review.requestId,
        walletId: review.walletId,
        digest: review.artifactDigest.slice(7),
        outcome: "finalized-success",
        recoveryRequired: false,
      },
    };
    const transport = {
      begin: vi.fn(async () => {
        events.push("begin");
        return {
          challengeId: "challenge-1",
          binding,
          expiresAt: review.expiresAt,
          options: { challenge: "fixture" },
        };
      }),
      finish: vi.fn(async () => {
        events.push("finish");
        if (mode === "lost-finish") {
          throw Error("lost finish");
        }
        return {
          authorization: { type: "webauthn", proof: { proofId: "proof-1" } },
          binding,
          credentialId: "credential-1",
          expiresAt: review.expiresAt,
        };
      }),
      journey: vi.fn(async (request) => {
        events.push(request.action);
        if (mode === "abort-after-send") {
          controller.abort();
        }
        if ((mode === "lost-execute" && request.action === "execute") || mode === "lost-recover") {
          throw Error("lost response");
        }
        return response;
      }),
    };
    vi.mocked(authorizeSignerReviewWithPasskey).mockImplementation(async () => {
      events.push("passkey");
      if (mode === "canceled") {
        controller.abort();
      }
      return {
        challengeId: mode === "changed-challenge" ? "other" : "challenge-1",
        credential: { id: "fixture" },
      } satisfies CampaignSessionTransport;
    });
    const retain = vi.fn(async () => {
      events.push("retain");
      if (mode === "retention-failed") {
        throw Error("cannot retain");
      }
    });
    if (mode === "bad-review") {
      review.amount = "1";
    }
    const action = approveWenCampaign(review, expected, transport, controller.signal, retain);
    if (mode === "ok" || mode === "lost-execute") {
      expect((await action).outcome).toBe("finalized-success");
    } else {
      await expect(action).rejects.toThrow();
    }
    const executed = ["ok", "lost-execute", "lost-recover", "abort-after-send"].includes(mode);
    expect(events.filter((x) => x === "execute")).toHaveLength(executed ? 1 : 0);
    expect(events.filter((x) => x === "recover")).toHaveLength(
      ["lost-execute", "lost-recover"].includes(mode) ? 1 : 0,
    );
    if (executed) {
      expect(events.indexOf("retain")).toBeLessThan(events.indexOf("execute"));
      expect(retain).toHaveBeenCalledWith({
        requestId: review.requestId,
        walletId: review.walletId,
        digest: review.artifactDigest.slice(7),
      });
    }
    if (mode === "bad-review") {
      expect(authorizeSignerReviewWithPasskey).not.toHaveBeenCalled();
      expect(transport.begin).not.toHaveBeenCalled();
    }
    if (["canceled", "changed-challenge"].includes(mode)) {
      expect(transport.finish).not.toHaveBeenCalled();
    }
  });
});
