import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CampaignReviewExpectation } from "./wen-campaign-review-contract.js";
import {
  createWenCampaignSession,
  recoverWenCampaignSession,
  type CampaignSessionTransport,
} from "./wen-campaign-session.js";
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
    ...(a.Action.Setup
      ? {
          setup: {
            issuer: a.Action.Setup.Issuer,
            nonce: BigInt(a.Action.Setup.Nonce),
            deposit: BigInt(a.Action.Setup.Terms.Deposit),
            maxPrice: BigInt(a.Action.Setup.Terms.MaxPrice),
            daily: BigInt(a.Action.Setup.Terms.Daily),
            total: BigInt(a.Action.Setup.Terms.Total),
            expiry: BigInt(a.Action.Setup.Terms.Expiry),
            maxWait: BigInt(a.Action.Setup.Terms.MaxWait),
            maxRent: BigInt(a.Binding.Setup.Rent),
          },
        }
      : {}),
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
describe("campaign approval execution and recovery", () => {
  it.each(["stop", "top-up", "withdraw", "setup"])(
    "joins %s approval and a single execution",
    async (op) => {
      const f = setup(op),
        s = await f.create();
      const display = await s.begin();
      display.challengeId = "replacement";
      s.review.amount = "1";
      f.expected.amount = 999n;
      await s.finish({ id: "browser-credential" });
      expect(f.transport.finish.mock.calls[0]).toEqual([
        { challengeId: "challenge-1", credential: { id: "browser-credential" } },
      ]);
      expect((await s.execute()).outcome).toBe("finalized-success");
      expect(f.transport.journey.mock.calls[0]).toEqual([
        { requestId: f.identity.requestId, action: "execute", proof: { proofId: "proof-1" } },
      ]);
      await expect(s.execute()).rejects.toThrow();
      expect(f.transport.journey).toHaveBeenCalledTimes(1);
    },
  );
  it("lost execution response permits recovery but never a second execute", async () => {
    const f = setup(),
      s = await f.create();
    await s.begin();
    await s.finish({});
    f.transport.journey.mockRejectedValueOnce(Error("lost response"));
    await expect(s.execute()).rejects.toThrow("lost response");
    await expect(s.execute()).rejects.toThrow();
    expect((await s.recover()).outcome).toBe("finalized-success");
    expect(f.transport.journey.mock.calls[1]).toEqual([
      { requestId: f.identity.requestId, action: "recover" },
    ]);
  });
  it("lost finish response is never resubmitted or used to execute", async () => {
    const f = setup(),
      s = await f.create();
    await s.begin();
    f.transport.finish.mockRejectedValueOnce(Error("lost"));
    await expect(s.finish({})).rejects.toThrow();
    await expect(s.finish({})).rejects.toThrow();
    await expect(s.execute()).rejects.toThrow();
    expect(f.transport.finish).toHaveBeenCalledTimes(1);
    expect(f.transport.journey).not.toHaveBeenCalled();
  });
  it.each(["begin", "finish"])("rejects mismatched %s approval binding", async (stage) => {
    const f = setup(),
      s = await f.create();
    if (stage === "begin") {
      f.challenge.binding.amount = "1";
      await expect(s.begin()).rejects.toThrow();
    } else {
      await s.begin();
      f.proof.binding.amount = "1";
      await expect(s.finish({})).rejects.toThrow();
    }
    await expect(s.execute()).rejects.toThrow();
    expect(f.transport.journey).not.toHaveBeenCalled();
  });
  it("aborting while approval is in flight prevents using its result", async () => {
    const f = setup(),
      s = await f.create();
    f.transport.begin.mockImplementationOnce(async () => {
      f.abort.abort();
      return f.challenge;
    });
    await expect(s.begin()).rejects.toThrow();
    await expect(s.finish({})).rejects.toThrow();
    expect(f.transport.finish).not.toHaveBeenCalled();
  });
  it("blocks concurrent calls and stale approval", async () => {
    const f = setup(),
      s = await f.create();
    const first = s.begin();
    await expect(s.begin()).rejects.toThrow();
    await first;
    vi.mocked(Date.now).mockReturnValue(Date.parse(f.r.expiresAt));
    await expect(s.finish({})).rejects.toThrow();
    expect(f.transport.finish).not.toHaveBeenCalled();
  });
  it("recovery works after expiry without proof or a fresh review", async () => {
    const f = setup();
    vi.mocked(Date.now).mockReturnValue(Date.parse(f.r.expiresAt) + 10000);
    expect((await recoverWenCampaignSession(f.transport, f.identity, f.abort.signal)).outcome).toBe(
      "finalized-success",
    );
    expect(f.transport.begin).not.toHaveBeenCalled();
    expect(f.transport.finish).not.toHaveBeenCalled();
  });
  it("recovery disallows subsequent execution even for an otherwise approved session", async () => {
    const f = setup(),
      s = await f.create();
    await s.begin();
    await s.finish({});
    await s.recover();
    await expect(s.execute()).rejects.toThrow();
  });
  it("rejects wrong result identity and requires recovery", async () => {
    const f = setup(),
      s = await f.create();
    await s.begin();
    await s.finish({});
    f.response.result.walletId = "other";
    await expect(s.execute()).rejects.toThrow();
    await expect(s.execute()).rejects.toThrow();
    expect(f.transport.journey).toHaveBeenCalledTimes(1);
  });
  it("rejects bad review before any transport call", async () => {
    const f = setup();
    f.r.amount = "1";
    await expect(f.create()).rejects.toThrow();
    expect(f.transport.begin).not.toHaveBeenCalled();
  });
});

it("expired approval cannot execute, but journal recovery remains available", async () => {
  const f = setup(),
    s = await f.create();
  await s.begin();
  await s.finish({});
  vi.mocked(Date.now).mockReturnValue(Date.parse(f.r.expiresAt));
  await expect(s.execute()).rejects.toThrow();
  expect(f.transport.journey).not.toHaveBeenCalled();
  await s.recover();
  expect(f.transport.journey.mock.calls[0]).toEqual([
    { requestId: f.identity.requestId, action: "recover" },
  ]);
});
it("aborted execution is recovered with retained identity and a new session signal", async () => {
  const f = setup(),
    s = await f.create();
  await s.begin();
  await s.finish({});
  f.transport.journey.mockImplementationOnce(async () => {
    f.abort.abort();
    return f.response;
  });
  await expect(s.execute()).rejects.toThrow();
  await expect(s.execute()).rejects.toThrow();
  expect(f.transport.journey).toHaveBeenCalledTimes(1);
  expect(
    (await recoverWenCampaignSession(f.transport, s.identity, new AbortController().signal))
      .outcome,
  ).toBe("finalized-success");
});
