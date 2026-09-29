import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { validateLocalSocketSignerResult } from "./local-socket-signer-protocol.js";
import { callLocalSocketSigner } from "./providers/local-socket-signer-adapter.js";
import type { CampaignReviewExpectation } from "./wen-campaign-review-contract.js";
import { createWenCampaignSession, type CampaignSessionTransport } from "./wen-campaign-session.js";
import { createWenCampaignSocketApproval } from "./wen-campaign-socket-approval.js";
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
function setup(op = "top-up") {
  const r = JSON.parse(
    readFileSync(new URL(`./fixtures/campaign-reviews/${op}.json`, import.meta.url), "utf8"),
  );
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(r.issuedAt) + 1000);
  const a = r.semanticIntent;
  const expected: CampaignReviewExpectation = {
    requestId: r.requestId,
    walletId: r.walletId,
    walletPublicKey: r.walletPublicKey,
    policyHash: r.policyHash,
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
  const binding: Record<string, unknown> & { role: string } = {
    ...Object.fromEntries(fields.map((k) => [k, r[k]])),
    role: "agent",
  };
  const challenge = {
    challengeId: "challenge-1",
    expiresAt: r.expiresAt,
    binding,
    options: { publicKey: { challenge: "fixture" } },
  };
  const proof = {
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
  const response = {
    ok: true,
    result: { ...identity, outcome: "finalized-success", recoveryRequired: false },
  };
  const transport = {
    begin: vi.fn<CampaignSessionTransport["begin"]>(async () => structuredClone(challenge)),
    finish: vi.fn<CampaignSessionTransport["finish"]>(async () => structuredClone(proof)),
    journey: vi.fn<CampaignSessionTransport["journey"]>(async () => structuredClone(response)),
  };
  const abort = new AbortController();
  return {
    r,
    expected,
    challenge,
    proof,
    identity,
    response,
    transport,
    abort,
    create: () => createWenCampaignSession(r, expected, transport, abort.signal),
  };
}
afterEach(() => vi.restoreAllMocks());

vi.mock("./providers/local-socket-signer-adapter.js", () => ({ callLocalSocketSigner: vi.fn() }));

async function socketFixture(op = "stop") {
  const f = setup(op);
  const profile = {
    walletId: f.r.walletId,
    socketPath: "/tmp/candidate.sock",
    revision: "profile-1",
  };
  const call = vi.mocked(callLocalSocketSigner);
  call.mockReset();
  call.mockImplementation(async (_path, req) => {
    const reply = req.op === "v2.review.authorization.begin" ? f.challenge : f.proof;
    if (!validateLocalSocketSignerResult(req.op, reply)) {
      throw Error("Socket rejected approval response");
    }
    return structuredClone(reply);
  });
  const s = await createWenCampaignSocketApproval(
    f.r,
    f.expected,
    async () => profile,
    f.abort.signal,
  );
  return { ...f, profile, call, s };
}
it.each(["stop", "top-up", "withdraw"])(
  "accepts %s through socket result validation",
  async (op) => {
    const f = await socketFixture(op);
    expect(await f.s.begin({ requestId: f.r.requestId })).toEqual(f.challenge);
    expect(
      await f.s.finish({ challengeId: f.challenge.challengeId, credential: { id: "assertion" } }),
    ).toEqual(f.proof);
    expect(f.call).toHaveBeenNthCalledWith(2, f.profile.socketPath, {
      op: "v2.review.authorization.finish",
      walletId: f.r.walletId,
      request: { challengeId: f.challenge.challengeId, credential: { id: "assertion" } },
    });
    await expect(
      f.s.finish({ challengeId: f.challenge.challengeId, credential: {} }),
    ).rejects.toThrow();
    expect(f.call).toHaveBeenCalledTimes(2);
  },
);
it.each(["walletId", "socketPath", "revision"] as const)("blocks changed %s", async (key) => {
  const f = await socketFixture();
  f.profile[key] += "changed";
  await expect(f.s.begin({ requestId: f.r.requestId })).rejects.toThrow("profile changed");
  expect(f.call).not.toHaveBeenCalled();
});
it("rejects profile replacement during finish", async () => {
  const f = await socketFixture();
  await f.s.begin({ requestId: f.r.requestId });
  f.call.mockImplementationOnce(async () => {
    f.profile.revision = "new";
    return f.proof;
  });
  await expect(
    f.s.finish({ challengeId: f.challenge.challengeId, credential: {} }),
  ).rejects.toThrow("profile changed");
});
it("never retries uncertain finish", async () => {
  const f = await socketFixture();
  await f.s.begin({ requestId: f.r.requestId });
  f.call.mockRejectedValueOnce(Error("lost reply"));
  await expect(
    f.s.finish({ challengeId: f.challenge.challengeId, credential: {} }),
  ).rejects.toThrow("lost reply");
  await expect(
    f.s.finish({ challengeId: f.challenge.challengeId, credential: {} }),
  ).rejects.toThrow();
  expect(f.call).toHaveBeenCalledTimes(2);
});
it("rejects malformed approval result", () => {
  const f = setup();
  for (const [op, value] of [
    ["v2.review.authorization.begin", f.challenge],
    ["v2.review.authorization.finish", f.proof],
  ] as const) {
    expect(
      validateLocalSocketSignerResult(op, {
        ...value,
        binding: { ...value.binding, artifactKind: "other" },
      }),
    ).toBe(false);
    expect(validateLocalSocketSignerResult(op, { ...value, injected: true })).toBe(false);
  }
});
it("blocks aborted approval", async () => {
  const f = await socketFixture();
  f.abort.abort();
  await expect(f.s.begin({ requestId: f.r.requestId })).rejects.toThrow();
  expect(f.call).not.toHaveBeenCalled();
});
