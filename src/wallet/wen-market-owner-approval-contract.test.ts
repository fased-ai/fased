import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { registerWenApprovalGateway } from "../../extensions/sat-mining/src/wen-approval-gateway.js";
import { approveWenMarketWithOwnerConfirmation } from "../../ui/src/ui/wen-campaign-approval.js";
import { createCampaignGatewayTransport } from "../../ui/src/ui/wen-campaign-gateway-transport.js";
import type { FasedAgentPluginApi } from "../plugins/types.js";
import { callLocalSocketSigner } from "./providers/local-socket-signer-adapter.js";
import { createWenMarketGatewayProfile } from "./wen-campaign-gateway-profile.js";
import { bindOwnerMarketApproval } from "./wen-market-owner-approval-contract.js";
import type { MarketReviewExpectation } from "./wen-market-review-contract.js";
const review = JSON.parse(
  readFileSync(new URL("./fixtures/market-reviews/buy.json", import.meta.url), "utf8"),
);
const a = review.semanticIntent;
const expected: MarketReviewExpectation = {
  requestId: review.requestId,
  walletId: review.walletId,
  walletPublicKey: review.walletPublicKey,
  policyHash: review.policyHash,
  pins: a.Pins,
  policy: a.Policy,
  limits: a.Limits,
  maxFee: BigInt(a.Binding.MaxFee),
  retainedLamports: BigInt(a.Binding.RetainedLamports),
};
const proofId = "Q".repeat(43);
function setup() {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(review.issuedAt) + 1);
  const metadata = {
    proofId,
    requestId: review.requestId,
    walletId: review.walletId,
    artifactDigest: review.artifactDigest,
    expiresAt: review.expiresAt,
  };
  const identity = {
    requestId: review.requestId,
    walletId: review.walletId,
    digest: review.artifactDigest.slice(7),
  };
  const result = {
    ok: true,
    result: { ...identity, outcome: "finalized-success", recoveryRequired: false },
  };
  const transport = {
    begin: vi.fn(async () => {
      throw Error("Passkey must not be invoked");
    }),
    finish: vi.fn(async () => {
      throw Error("Passkey must not be invoked");
    }),
    confirmOwner: vi.fn(async () => structuredClone(metadata)),
    journey: vi.fn(async () => structuredClone(result)),
  };
  const retain = vi.fn();
  const run = () =>
    approveWenMarketWithOwnerConfirmation(
      review,
      expected,
      transport,
      proofId,
      new AbortController().signal,
      retain,
    );
  return { metadata, identity, transport, retain, run };
}
afterEach(() => vi.restoreAllMocks());
it("consumes exact owner confirmation without passkey and retains identity before execution", async () => {
  const f = setup();
  await f.run();
  expect(f.transport.begin).not.toHaveBeenCalled();
  expect(f.transport.finish).not.toHaveBeenCalled();
  expect(f.retain).toHaveBeenCalledWith(f.identity);
  expect(f.retain.mock.invocationCallOrder[0]).toBeLessThan(
    f.transport.journey.mock.invocationCallOrder[0],
  );
  expect(f.transport.journey).toHaveBeenCalledExactlyOnceWith({
    requestId: review.requestId,
    action: "execute",
  });
});
it("recovers once after lost execution response without resubmission", async () => {
  const f = setup();
  f.transport.journey.mockRejectedValueOnce(Error("response lost"));
  await f.run();
  expect(f.transport.journey.mock.calls.map(([r]) => r)).toEqual([
    { requestId: review.requestId, action: "execute" },
    { requestId: review.requestId, action: "recover" },
  ]);
});
it.each(["requestId", "walletId", "artifactDigest", "proofId", "expiresAt", "unknown"])(
  "rejects changed %s before execution",
  async (field) => {
    const f = setup();
    const changed = { ...f.metadata, [field]: field === "expiresAt" ? review.issuedAt : "wrong" };
    f.transport.confirmOwner.mockResolvedValueOnce(changed);
    await expect(f.run()).rejects.toThrow();
    expect(f.transport.journey).not.toHaveBeenCalled();
  },
);
it("rejects expiry beyond the reviewed deadline", () => {
  const f = setup();
  expect(() =>
    bindOwnerMarketApproval(
      { ...f.metadata, expiresAt: new Date(Date.parse(review.expiresAt) + 1).toISOString() },
      review,
      proofId,
    ),
  ).toThrow();
});

vi.mock("./providers/local-socket-signer-adapter.js", () => ({ callLocalSocketSigner: vi.fn() }));
it("joins the UI, connection-owned gateway, protected profile and native proof inspection", async () => {
  const f = setup();
  const socket = vi.mocked(callLocalSocketSigner);
  socket.mockReset();
  socket.mockImplementation(async (_, request) => {
    if (request.op === "v2.wenMarket.ownerProof.inspect") {
      return f.metadata;
    }
    if (request.op === "v2.wenMarket.journey") {
      return { ...f.identity, outcome: "finalized-success", recoveryRequired: false };
    }
    throw Error("Unexpected signer request");
  });
  const profile = createWenMarketGatewayProfile(async () => ({
    socket: { walletId: review.walletId, socketPath: "/tmp/fixture.sock", revision: "1" },
    expected,
    artifactDigest: f.identity.digest,
    draftSha256: "a".repeat(64),
  }));
  const handlers = new Map<string, Parameters<FasedAgentPluginApi["registerGatewayMethod"]>[1]>();
  const stop = registerWenApprovalGateway(
    {
      registerGatewayMethod(name, handler) {
        handlers.set(name, handler);
      },
    },
    () => profile,
    "wen.market.approval",
  );
  const client = {
    async request<T>(method: string, params: unknown): Promise<T> {
      let response: unknown;
      await handlers.get(method)!({
        params,
        client: { connId: "owner" },
        respond(ok: boolean, payload: unknown) {
          if (!ok) {
            throw Error("Gateway rejected");
          }
          response = payload;
        },
      } as never);
      return response as T;
    },
  };
  const signal = new AbortController().signal;
  const transport = createCampaignGatewayTransport(
    client,
    review,
    review.requestId,
    signal,
    "market",
  );
  try {
    await approveWenMarketWithOwnerConfirmation(
      review,
      expected,
      transport,
      proofId,
      signal,
      f.retain,
    );
    expect(socket.mock.calls.map(([, request]) => request.op)).toEqual([
      "v2.wenMarket.ownerProof.inspect",
      "v2.wenMarket.journey",
    ]);
    await expect(
      transport.journey({ requestId: review.requestId, action: "execute" }),
    ).rejects.toThrow();
    expect(socket).toHaveBeenCalledTimes(2);
  } finally {
    stop();
  }
});
