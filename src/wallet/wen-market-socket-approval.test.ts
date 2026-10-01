import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import {
  parseLocalSocketSignerRequest,
  validateLocalSocketSignerResult,
} from "./local-socket-signer-protocol.js";
import { callLocalSocketSigner } from "./providers/local-socket-signer-adapter.js";
import { createWenMarketSession } from "./wen-campaign-session.js";
import {
  createWenMarketSocketTransport,
  recoverWenMarketSocket,
} from "./wen-campaign-socket-approval.js";
import { type MarketReviewExpectation } from "./wen-market-review-contract.js";
vi.mock("./providers/local-socket-signer-adapter.js", () => ({ callLocalSocketSigner: vi.fn() }));
afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const r = JSON.parse(
    readFileSync(new URL("./fixtures/market-reviews/buy.json", import.meta.url), "utf8"),
  );
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(r.issuedAt) + 1000);
  const a = r.semanticIntent;
  const expected: MarketReviewExpectation = {
    requestId: r.requestId,
    walletId: r.walletId,
    walletPublicKey: r.walletPublicKey,
    policyHash: r.policyHash,
    pins: a.Pins,
    policy: a.Policy,
    limits: a.Limits,
    maxFee: BigInt(a.Binding.MaxFee),
    retainedLamports: BigInt(a.Binding.RetainedLamports),
  };
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
  const binding = { ...Object.fromEntries(fields.map((k) => [k, r[k]])), role: "agent" };
  const challenge = {
    challengeId: "challenge-1",
    expiresAt: r.expiresAt,
    binding,
    options: { publicKey: { challenge: "fixture" } },
  };
  const approval = {
    authorization: { type: "webauthn", proof: { proofId: "proof-1" } },
    binding,
    credentialId: "credential-1",
    expiresAt: r.expiresAt,
  };
  const identity = {
    requestId: r.requestId,
    walletId: r.walletId,
    digest: r.artifactDigest.slice(7),
  };
  const profile = {
    walletId: r.walletId,
    socketPath: "/tmp/candidate-market.sock",
    revision: "profile-1",
  };
  const controller = new AbortController(),
    call = vi.mocked(callLocalSocketSigner);
  call.mockReset();
  call.mockImplementation(async (_, request) => {
    parseLocalSocketSignerRequest(request);
    const result =
      request.op === "v2.review.authorization.begin"
        ? challenge
        : request.op === "v2.review.authorization.finish"
          ? approval
          : request.op === "v2.wenMarket.review.prepare"
            ? r
            : { ...identity, outcome: "finalized-success", recoveryRequired: false };
    if (!validateLocalSocketSignerResult(request.op, result)) {
      throw Error("SDK rejected result");
    }
    return structuredClone(result);
  });
  const transport = await createWenMarketSocketTransport(
    r,
    expected,
    async () => profile,
    controller.signal,
  );
  const session = await createWenMarketSession(r, expected, transport, controller.signal);
  return {
    r,
    expected,
    challenge,
    approval,
    identity,
    profile,
    controller,
    call,
    transport,
    session,
  };
}
it("verifies review, approval and one Buy attempt through SDK operation/result checks", async () => {
  const f = await fixture();
  expect(validateLocalSocketSignerResult("v2.wenMarket.review.prepare", f.r)).toBe(true);
  await f.session.begin();
  await f.session.finish({ id: "assertion" });
  expect((await f.session.execute()).outcome).toBe("finalized-success");
  await expect(f.session.execute()).rejects.toThrow();
  expect(
    f.call.mock.calls.filter(
      (pair): pair is [string, Extract<(typeof pair)[1], { op: "v2.wenMarket.journey" }>] =>
        pair[1].op === "v2.wenMarket.journey",
    ),
  ).toHaveLength(1);
});
it("lost execution reply only recovers after transport recreation, even when review expires", async () => {
  const f = await fixture();
  await f.session.begin();
  await f.session.finish({ id: "assertion" });
  f.call.mockRejectedValueOnce(Error("lost reply"));
  await expect(f.session.execute()).rejects.toThrow("lost reply");
  await expect(f.session.execute()).rejects.toThrow();
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(f.r.expiresAt) + 1000);
  expect(
    (await recoverWenMarketSocket(f.identity, async () => f.profile, new AbortController().signal))
      .result.outcome,
  ).toBe("finalized-success");
  expect(
    f.call.mock.calls
      .filter(([, r]) => r.op === "v2.wenMarket.journey")
      .map(([, r]) => (r.op === "v2.wenMarket.journey" ? r.request.action : undefined)),
  ).toEqual(["execute", "recover"]);
});
it("rejects approval artifact replacement and changed host before dispatch", async () => {
  const f = await fixture();
  f.call.mockResolvedValueOnce({
    ...f.challenge,
    binding: { ...f.challenge.binding, artifactDigest: "sha256:" + "ff".repeat(32) },
  });
  await expect(f.session.begin()).rejects.toThrow();
  const g = await fixture();
  g.profile.revision = "changed";
  await expect(g.session.begin()).rejects.toThrow("profile changed");
  expect(g.call).not.toHaveBeenCalled();
});
it.each(["cancel", "expire"] as const)(
  "sends %s without approval or replacement transaction fields",
  async (action) => {
    const f = await fixture();
    f.call.mockResolvedValueOnce({
      ...f.identity,
      outcome: action === "cancel" ? "cancelled" : "expired",
      recoveryRequired: false,
    });
    expect(
      (await f.transport.journey({ requestId: f.r.requestId, action })).result.recoveryRequired,
    ).toBe(false);
    expect(() =>
      parseLocalSocketSignerRequest({
        op: "v2.wenMarket.journey",
        walletId: f.r.walletId,
        request: { requestId: f.r.requestId, action, rpc: "https://caller.invalid" },
      }),
    ).toThrow();
  },
);
