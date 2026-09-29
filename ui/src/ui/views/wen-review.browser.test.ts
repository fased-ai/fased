import { expect, it, vi } from "vitest";
import "./wen-review.js";
import type { WenReviewPanel } from "./wen-review.js";
it("restores a pending request after reload and reconciles without execution", async () => {
  const pending = { requestId: "pending-request", walletId: "miner" };
  sessionStorage.setItem("wen.pending-claim", JSON.stringify(pending));
  const panel = document.createElement("wen-review-panel") as WenReviewPanel;
  const request = vi.fn().mockResolvedValue({
    ok: true,
    mode: "local-candidate-only",
    signingEnabled: false,
    payload: {
      ...pending,
      walletId: "wrong",
      digest: "a".repeat(64),
      outcome: "finalized-success",
      recoveryRequired: false,
    },
  });
  panel.client = { request };
  panel.connected = true;
  document.body.append(panel);
  try {
    await panel.updateComplete;
    expect(panel.pendingClaim).toEqual(pending);
    await panel.recoverClaim();
    expect(sessionStorage.getItem("wen.pending-claim")).not.toBeNull();
    request.mockResolvedValue({
      ok: true,
      mode: "local-candidate-only",
      signingEnabled: false,
      payload: {
        ...pending,
        digest: "a".repeat(64),
        outcome: "finalized-success",
        recoveryRequired: false,
      },
    });
    await panel.recoverClaim();
    expect(panel.pendingClaim).toBeNull();
    expect(sessionStorage.getItem("wen.pending-claim")).toBeNull();
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "wen.mining.approval.recover",
      "wen.mining.approval.recover",
    ]);
  } finally {
    panel.remove();
    sessionStorage.removeItem("wen.pending-claim");
  }
});
it("renders unsigned review amounts after an explicit refresh", async () => {
  const panel = document.createElement("wen-review-panel") as WenReviewPanel;
  const request = vi.fn().mockResolvedValue({
    ok: true,
    mode: "local-candidate-only",
    signingEnabled: false,
    payload: {
      signingEnabled: false,
      nextCursor: "admission.json",
      scanComplete: false,
      items: [
        {
          entry: "test-entry",
          status: "requires-review",
          reviewDraft: {
            descriptor: "e30=",
            review: {
              walletId: "miner",
              walletPublicKey: "owner",
              intent: {
                programId: "program",
                economy: "economy",
                operation: "sat",
                descriptorSha256: "a".repeat(64),
                capabilitySha256: "b".repeat(64),
                accountStateSha256: "c".repeat(64),
                genesis: "genesis",
                destination: "ata",
                id: "1",
                nonce: "1",
                ordinal: "0",
                minFinalizedSlot: "100",
                expectedGross: "20",
                minimumReceived: "19",
                maxFeeLamports: "5000",
                expiresSlot: "132",
              },
            },
          },
        },
      ],
    },
  });
  panel.client = { request };
  panel.connected = true;
  document.body.append(panel);
  try {
    const reviewButtons = () =>
      [...panel.querySelectorAll("button")].filter(
        (button) => !button.closest("wen-campaign-panel"),
      );
    await panel.updateComplete;
    expect(request).not.toHaveBeenCalled();
    panel.querySelector("button")!.click();
    await vi.waitFor(() => expect(panel.textContent).toContain("minimum received: 19"));
    expect(panel.textContent).toContain("expiry slot: 132");
    expect(panel.textContent).toContain("does not sign or submit");
    expect(panel.textContent).toContain("Wallet: miner (owner)");
    expect(panel.textContent).toContain("Program: program");
    expect(reviewButtons()).toHaveLength(4);
    const base = JSON.parse(panel.rows![0].draftJson!).review.intent;
    request.mockResolvedValue({
      ok: true,
      mode: "local-candidate-only",
      signingEnabled: false,
      payload: {
        intent: { ...base, minFinalizedSlot: "101", expiresSlot: "133" },
        baseReviewSha256: "d".repeat(64),
        observedSlot: 102,
        signingEnabled: false,
      },
    });
    const hash = panel.querySelector("input")!;
    hash.value = "d".repeat(64);
    hash.dispatchEvent(new Event("input", { bubbles: true }));
    await panel.updateComplete;
    reviewButtons()[3].click();
    await vi.waitFor(() => expect(panel.textContent).toContain("claim refreshed at slot 102"));
    expect(request).toHaveBeenLastCalledWith("wen.mining.claim.refresh", {
      base,
      reviewSha256: "d".repeat(64),
    });
    expect(panel.textContent).toContain("approval and submission are still required");
    request.mockResolvedValue({
      ok: true,
      mode: "local-candidate-only",
      signingEnabled: false,
      payload: { signingEnabled: false, items: [], nextCursor: "", scanComplete: true },
    });
    reviewButtons()
      .find((button) => button.textContent === "Next review page")!
      .click();
    await vi.waitFor(() => expect(panel.textContent).toContain("Page 2"));
    expect(panel.textContent).toContain("No review entries on this page");
    expect(reviewButtons()).toHaveLength(1);
    panel.client = { request: vi.fn() };
    await panel.updateComplete;
    expect(panel.rows).toBeNull();
    expect(panel.page).toBe(0);
    expect(panel.textContent).not.toContain("Page 2");
  } finally {
    panel.remove();
  }
});
