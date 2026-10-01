import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { registerWenApprovalGateway } from "../../extensions/wen/src/wen-approval-gateway.js";
import { createCampaignGatewayTransport } from "../../ui/src/ui/wen-campaign-gateway-transport.js";
import type { FasedAgentPluginApi } from "../plugins/types.js";
import { callLocalSocketSigner } from "./providers/local-socket-signer-adapter.js";
import { createWenCampaignGatewayProfile } from "./wen-campaign-gateway-profile.js";
import type { CampaignReviewExpectation } from "./wen-campaign-review-contract.js";
import { createWenCampaignSession, type CampaignSessionTransport } from "./wen-campaign-session.js";
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

vi.mock("./providers/local-socket-signer-adapter.js", () => ({ callLocalSocketSigner: vi.fn() }));

it.each(["stop", "top-up", "withdraw", "setup"])(
  "joins %s host approval, uncertain execution and recovery",
  async (op) => {
    const f = setup(op);
    const selected = {
      socket: { walletId: f.r.walletId, socketPath: "/tmp/fixture.sock", revision: "1" },
      expected: f.expected,
      draftSha256: "a".repeat(64),
      artifactDigest: f.identity.digest,
    };
    const call = vi.mocked(callLocalSocketSigner);
    call.mockReset();
    call.mockImplementation(async (_, request) => {
      if (request.op === "v2.wenCampaign.review.prepare") {
        return f.r;
      }
      if (request.op === "v2.review.authorization.begin") {
        return f.challenge;
      }
      if (request.op === "v2.review.authorization.finish") {
        return f.proof;
      }
      if (request.op === "v2.wenCampaign.journey") {
        if (request.request.action === "execute") {
          throw Error("uncertain");
        }
        return f.response.result;
      }
      throw Error("unexpected opcode");
    });
    const profile = createWenCampaignGatewayProfile(async () => selected);
    await expect(
      profile.prepareClaimApproval({ requestId: f.r.requestId, draftSha256: "b".repeat(64) }),
    ).rejects.toThrow("draft mismatch");
    expect(call).not.toHaveBeenCalled();
    const selectionView = await profile.readCampaignSelection();
    expect(selectionView.expected.walletId).toBe(selected.socket.walletId);
    expect(selectionView).not.toHaveProperty("socket");
    await profile.prepareClaimApproval({
      requestId: f.r.requestId,
      draftSha256: selected.draftSha256,
    });
    await profile.beginClaimApproval(f.r);
    await profile.finishClaimApproval(f.challenge.challengeId, {});
    await expect(profile.runClaimJourney(f.r.requestId, "execute")).rejects.toThrow("uncertain");
    await expect(profile.runClaimJourney(f.r.requestId, "execute")).rejects.toThrow(
      "No executable",
    );
    profile.cancelClaimApproval();
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(f.r.expiresAt) + 1);
    expect(await profile.runClaimJourney(f.r.requestId, "recover")).toEqual(f.response.result);
    expect(
      call.mock.calls.filter(
        ([, r]) => r.op === "v2.wenCampaign.journey" && r.request.action === "execute",
      ),
    ).toHaveLength(1);
    expect(call).toHaveBeenCalledTimes(5);
  },
);
it("rejects changed host selection before approved execution", async () => {
  const f = setup();
  const selected = {
    socket: { walletId: f.r.walletId, socketPath: "/tmp/fixture.sock", revision: "1" },
    expected: f.expected,
    draftSha256: "a".repeat(64),
    artifactDigest: f.identity.digest,
  };
  const call = vi.mocked(callLocalSocketSigner);
  call.mockReset();
  call.mockImplementation(async (_, r) =>
    r.op === "v2.review.authorization.begin" ? f.challenge : f.proof,
  );
  const profile = createWenCampaignGatewayProfile(async () => selected);
  await profile.beginClaimApproval(f.r);
  await profile.finishClaimApproval(f.challenge.challengeId, {});
  selected.socket.revision = "2";
  await expect(profile.runClaimJourney(f.r.requestId, "execute")).rejects.toThrow("No executable");
  expect(call).toHaveBeenCalledTimes(2);
});

it("joins browser session to gateway, host adapter and signer transport", async () => {
  const f = setup("withdraw");
  const selected = {
    socket: { walletId: f.r.walletId, socketPath: "/tmp/fixture.sock", revision: "1" },
    expected: f.expected,
    draftSha256: "a".repeat(64),
    artifactDigest: f.identity.digest,
  };
  const call = vi.mocked(callLocalSocketSigner);
  call.mockReset();
  call.mockImplementation(async (_, r) => {
    if (r.op === "v2.review.authorization.begin") {
      return f.challenge;
    }
    if (r.op === "v2.review.authorization.finish") {
      return f.proof;
    }
    if (r.op === "v2.wenCampaign.journey" && r.request.action === "recover") {
      return f.response.result;
    }
    throw Error("lost execute response");
  });
  const profile = createWenCampaignGatewayProfile(async () => selected);
  const handlers = new Map<string, Parameters<FasedAgentPluginApi["registerGatewayMethod"]>[1]>();
  const cancel = registerWenApprovalGateway(
    {
      registerGatewayMethod(name, handler) {
        handlers.set(name, handler);
      },
    },
    () => profile,
    "wen.campaign.approval",
  );
  const requests: unknown[] = [];
  const client = {
    async request<T>(method: string, params: unknown): Promise<T> {
      requests.push({ method, params });
      let result: T | undefined;
      let failure = false;
      await handlers.get(method)!({
        params,
        client: { connId: "owner" },
        respond(ok: boolean, value: T) {
          failure = !ok;
          result = value;
        },
      } as never);
      if (failure) {
        throw Error("gateway unavailable");
      }
      return result!;
    },
  };
  try {
    const transport = createCampaignGatewayTransport(client, f.r, f.r.requestId, f.abort.signal);
    const session = await createWenCampaignSession(f.r, f.expected, transport, f.abort.signal);
    await session.begin();
    await session.finish({});
    await expect(session.execute()).rejects.toThrow("gateway unavailable");
    await expect(session.execute()).rejects.toThrow("already attempted");
    expect(await session.recover()).toEqual(f.response.result);
    expect(requests.at(-2)).toEqual({
      method: "wen.campaign.approval.execute",
      params: { requestId: f.r.requestId },
    });
    expect(
      call.mock.calls.filter(
        ([, r]) => r.op === "v2.wenCampaign.journey" && r.request.action === "execute",
      ),
    ).toHaveLength(1);
  } finally {
    cancel();
  }
});
