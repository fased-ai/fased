import { afterEach, expect, it, vi } from "vitest";
import fixtureData from "../../../../src/wallet/fixtures/wen-bond-claim-review-v2.json" with { type: "json" };
import { authorizeSignerReviewWithPasskey } from "../wallet-passkey.js";
import "./wen-campaign.js";
import type { WenCampaignPanel } from "./wen-campaign.js";
const review = fixtureData.review;
vi.mock("../wallet-passkey.js", () => ({ authorizeSignerReviewWithPasskey: vi.fn() }));
afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
  document.body.replaceChildren();
});
function fixture() {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(review.issuedAt) + 1);
  const expected = fixtureData.expected;
  const fields =
    "requestId walletId walletPublicKey intentType intentDigest semanticIntent artifactKind artifactDigest transactionDigest stateDigest stateSlot asset amount destination policyOperation requiredPrograms policyHash nonce issuedAt expiresAt".split(
      " ",
    );
  const binding = {
    ...Object.fromEntries(fields.map((k) => [k, review[k as keyof typeof review]])),
    role: "agent",
  };
  const identity = {
    requestId: review.requestId,
    walletId: review.walletId,
    digest: review.artifactDigest.slice(7),
  };
  let recoveryFails = true;
  const request = vi.fn(async (method: string) => {
    if (method.endsWith("execute")) {
      throw Error("uncertain");
    }
    if (method.endsWith("recover") && recoveryFails) {
      throw Error("temporarily unavailable");
    }
    const payload = method.endsWith("selection")
      ? { expected, draftSha256: "a".repeat(64), artifactDigest: identity.digest }
      : method.endsWith("prepare")
        ? review
        : method.endsWith("begin")
          ? { challengeId: "challenge-1", binding, expiresAt: review.expiresAt, options: {} }
          : method.endsWith("finish")
            ? {
                authorization: { type: "webauthn", proof: { proofId: "proof-1" } },
                binding,
                credentialId: "credential-1",
                expiresAt: review.expiresAt,
              }
            : { ...identity, outcome: "finalized-success", recoveryRequired: false };
    return { ok: true, mode: "local-candidate-only", signingEnabled: false, payload };
  });
  vi.mocked(authorizeSignerReviewWithPasskey).mockResolvedValue({
    challengeId: "challenge-1",
    credential: { id: "fixture" },
  } as never);
  const panel = document.createElement("wen-campaign-panel") as WenCampaignPanel;
  panel.domain = "bond-claim";
  panel.client = { request } as never;
  panel.connected = true;
  document.body.append(panel);
  return {
    panel,
    request,
    identity,
    key: `wen.bond-claim.pending:${expected.policy.Deployment.Genesis}:${expected.walletId}`,
    allowRecovery: () => {
      recoveryFails = false;
    },
  };
}
it("mounts, executes once, reloads and reconciles an uncertain request", async () => {
  const f = fixture();
  await f.panel.updateComplete;
  await f.panel.loadConfigured();
  await f.panel.updateComplete;
  await f.panel.refresh();
  await f.panel.updateComplete;
  const approve = [...f.panel.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("Approve"),
  )!;
  expect(approve.disabled).toBe(false);
  approve.click();
  approve.click();
  await vi.waitFor(() => expect(f.panel.busy).toBe(false));
  expect(f.request.mock.calls.filter(([m]) => m.endsWith("execute"))).toHaveLength(1);
  expect(JSON.parse(sessionStorage.getItem(f.key)!)).toEqual(f.identity);
  f.panel.remove();
  f.allowRecovery();
  const reloaded = document.createElement("wen-campaign-panel") as WenCampaignPanel;
  reloaded.domain = "bond-claim";
  reloaded.client = { request: f.request } as never;
  reloaded.connected = true;
  document.body.append(reloaded);
  await reloaded.updateComplete;
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(review.expiresAt) + 1000);
  await reloaded.loadConfigured();
  await reloaded.updateComplete;
  await reloaded.refresh();
  await reloaded.updateComplete;
  expect(reloaded.pending).toEqual(f.identity);
  await reloaded.recover();
  await reloaded.updateComplete;
  expect(reloaded.textContent).toContain("finalized-success");
  expect(sessionStorage.getItem(f.key)).toBeNull();
  expect(f.request.mock.calls.filter(([m]) => m.endsWith("execute"))).toHaveLength(1);
  expect(f.request.mock.calls.filter(([m]) => m.endsWith("prepare"))).toHaveLength(1);
});
it("disconnect removes approval capability without deleting recovery", async () => {
  const f = fixture();
  await f.panel.updateComplete;
  await f.panel.loadConfigured();
  await f.panel.updateComplete;
  sessionStorage.setItem(f.key, JSON.stringify(f.identity));
  f.panel.connected = false;
  await f.panel.updateComplete;
  expect(f.panel.host).toBeNull();
  expect([...f.panel.querySelectorAll("button")].every((b) => b.disabled)).toBe(true);
  expect(sessionStorage.getItem(f.key)).not.toBeNull();
});
