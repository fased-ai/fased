import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { authorizeSignerReviewWithPasskey } from "../wallet-passkey.js";
import { WenCampaignPanel, type CampaignViewHost } from "./wen-campaign.js";
vi.mock("../wallet-passkey.js", () => ({ authorizeSignerReviewWithPasskey: vi.fn() }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(authorizeSignerReviewWithPasskey).mockReset();
});
function setup(operation = "stop") {
  const review = JSON.parse(
    readFileSync(
      new URL(
        `../../../../src/wallet/fixtures/campaign-reviews/${operation}.json`,
        import.meta.url,
      ),
      "utf8",
    ),
  );
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(review.issuedAt) + 1);
  const a = review.semanticIntent;
  const fields =
    "requestId walletId walletPublicKey intentType intentDigest semanticIntent artifactKind artifactDigest transactionDigest stateDigest stateSlot asset amount destination policyOperation requiredPrograms policyHash nonce issuedAt expiresAt".split(
      " ",
    );
  const binding = { ...Object.fromEntries(fields.map((k) => [k, review[k]])), role: "agent" };
  const identity = {
    requestId: review.requestId,
    walletId: review.walletId,
    digest: review.artifactDigest.slice(7),
  };
  const response = {
    ok: true,
    result: { ...identity, outcome: "finalized-success", recoveryRequired: false },
  };
  const events: string[] = [];
  const transport = {
    begin: vi.fn(async () => ({
      challengeId: "challenge-1",
      binding,
      expiresAt: review.expiresAt,
      options: {},
    })),
    finish: vi.fn(async () => ({
      authorization: { type: "webauthn", proof: { proofId: "proof-1" } },
      binding,
      credentialId: "credential-1",
      expiresAt: review.expiresAt,
    })),
    journey: vi.fn(async (request: { action: string }) => {
      events.push(request.action);
      return structuredClone(response);
    }),
  };
  const host: CampaignViewHost = {
    review,
    transport,
    expected: {
      requestId: review.requestId,
      walletId: review.walletId,
      walletPublicKey: review.walletPublicKey,
      policyHash: review.policyHash,
      program: a.Action?.Program ?? a.Claim.Program,
      economy: a.Action?.Economy ?? a.Claim.Economy,
      position: a.Action?.Position ?? a.Snapshot.Claim.Position.Address,
      operation: a.Action?.Operation ?? "claim-stake",
      amount: BigInt(a.Action?.Amount ?? 0),
      maxFee: BigInt(a.Binding?.MaxFee ?? a.Intent.maxFeeLamports),
      genesis: a.Pins.Genesis,
      codeSha256: a.Pins.CodeSHA256,
      deploymentSlot: BigInt(a.Pins.DeploymentSlot),
      upgradeAuthority: a.Pins.UpgradeAuthority,
      ...(a.Snapshot
        ? {
            claimStake: {
              destination: a.Claim.Destination,
              pool: a.Snapshot.History.Pool.Address,
              stakingPosition: a.Snapshot.History.Position.Address,
              mint: a.Intent.mint,
              pageIndex: BigInt(a.Claim.PageIndex),
              mask: BigInt(a.Claim.Mask),
              minimumNet: BigInt(a.MinimumNet),
              maxTotal: BigInt(a.MaxTotal),
              descriptorSha256: a.Pins.DescriptorSHA256,
              capabilitySha256: a.Pins.CapabilitySHA256,
              day: BigInt(a.Intent.day),
              last: BigInt(a.Intent.last),
              aggregateFrom: BigInt(a.Intent.aggregateFrom),
            },
          }
        : {}),
      ...(a.Action?.Setup
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
    },
  };
  vi.mocked(authorizeSignerReviewWithPasskey).mockResolvedValue({
    challengeId: "challenge-1",
    credential: { id: "test" },
  } as never);
  const panel = new WenCampaignPanel();
  panel.host = host;
  const key = `wen.campaign.pending:${host.expected.genesis}:${host.expected.walletId}`;
  return { panel, host, transport, response, identity, events, key };
}
it.each(["stop", "top-up", "withdraw", "setup", "claim-stake"])(
  "joins %s review, one execution and displayed outcome",
  async (op) => {
    const f = setup(op);
    await f.panel.refresh();
    expect(f.panel.verified).not.toBeNull();
    f.transport.journey.mockImplementationOnce(async (request) => {
      expect(JSON.parse(sessionStorage.getItem(f.key)!)).toEqual(f.identity);
      f.events.push(request.action);
      return f.response;
    });
    await Promise.all([f.panel.approve(), f.panel.approve()]);
    expect(f.events).toEqual(["execute"]);
    expect(f.panel.status).toContain("finalized-success");
    expect(f.panel.pending).toBeNull();
    expect(sessionStorage.getItem(f.key)).toBeNull();
  },
);
it("recovers a lost response without another approval or execute", async () => {
  const f = setup();
  await f.panel.refresh();
  f.transport.journey.mockImplementationOnce(async (r) => {
    f.events.push(r.action);
    throw Error("lost");
  });
  await f.panel.approve();
  expect(f.events).toEqual(["execute", "recover"]);
  expect(f.panel.status).toContain("Journal reconciled");
  expect(authorizeSignerReviewWithPasskey).toHaveBeenCalledTimes(1);
});
it.each(["stop", "claim-stake"])(
  "retains %s uncertainty across reload and expired review",
  async (operation) => {
    const f = setup(operation);
    await f.panel.refresh();
    f.transport.journey.mockRejectedValue(Error("offline"));
    await f.panel.approve();
    expect(f.panel.pending).toEqual(f.identity);
    expect(f.panel.status).toContain("unresolved");
    const reloaded = new WenCampaignPanel();
    reloaded.host = f.host;
    vi.spyOn(Date, "now").mockReturnValue(
      Date.parse((f.host.review as { expiresAt: string }).expiresAt) + 1000,
    );
    await reloaded.refresh();
    expect(reloaded.pending).toEqual(f.identity);
    await reloaded.approve();
    f.transport.journey.mockResolvedValue(f.response);
    await reloaded.recover();
    expect(f.transport.journey).toHaveBeenLastCalledWith({
      requestId: f.identity.requestId,
      action: "recover",
    });
    expect(reloaded.status).toContain("finalized-success");
    expect(authorizeSignerReviewWithPasskey).toHaveBeenCalledTimes(1);
  },
);
it("shows failed and pending outcomes without claiming success", async () => {
  const f = setup();
  await f.panel.refresh();
  f.response.result.outcome = "submission-uncertain";
  f.response.result.recoveryRequired = true;
  await f.panel.approve();
  expect(f.panel.pending).not.toBeNull();
  expect(f.panel.status).toContain("Reconciliation still required");
  f.response.result.outcome = "finalized-failed";
  f.response.result.recoveryRequired = false;
  await f.panel.recover();
  expect(f.panel.status).toContain("finalized-failed");
  expect(f.panel.pending).toBeNull();
});
it("does not send when persistence fails", async () => {
  const f = setup();
  await f.panel.refresh();
  vi.spyOn(sessionStorage, "setItem").mockImplementation(() => {
    throw Error("full");
  });
  await f.panel.approve();
  expect(f.transport.journey).not.toHaveBeenCalled();
});
it("blocks changed profile before execution", async () => {
  const f = setup();
  await f.panel.refresh();
  f.host.expected.walletId = "other";
  await f.panel.approve();
  expect(f.transport.begin).not.toHaveBeenCalled();
  expect(f.transport.journey).not.toHaveBeenCalled();
});
it("retains identity on mismatched recovery and suppresses stale display", async () => {
  const f = setup();
  await f.panel.refresh();
  f.transport.journey.mockRejectedValueOnce(Error("lost"));
  f.response.result.digest = "0".repeat(64);
  await f.panel.approve();
  expect(f.panel.pending).toEqual(f.identity);
  expect(f.panel.status).toContain("unresolved");
  f.transport.journey.mockImplementationOnce(async () => {
    f.panel.host = null;
    return { ...f.response, result: { ...f.response.result, ...f.identity } };
  });
  await f.panel.recover();
  expect(sessionStorage.getItem(f.key)).not.toBeNull();
  expect(f.panel.status).not.toContain("finalized-success");
});
it("keeps the unconfigured mounted view disabled", async () => {
  const panel = new WenCampaignPanel();
  await panel.refresh();
  await panel.approve();
  await panel.recover();
  expect(panel.status).toContain("unavailable");
  expect(authorizeSignerReviewWithPasskey).not.toHaveBeenCalled();
});
it("does not execute from malformed retained storage", async () => {
  const f = setup();
  sessionStorage.setItem(f.key, '{"requestId":"bad"}');
  await f.panel.refresh();
  await f.panel.approve();
  expect(f.panel.verified).toBeNull();
  expect(f.transport.begin).not.toHaveBeenCalled();
});

it.each([false, true])(
  "loads the configured gateway and preserves reload recovery: %s",
  async (recovering) => {
    const f = setup();
    sessionStorage.removeItem(f.key);
    if (recovering) {
      sessionStorage.setItem(f.key, JSON.stringify(f.identity));
    }
    const selection = JSON.parse(
      JSON.stringify(
        {
          expected: f.host.expected,
          draftSha256: "a".repeat(64),
          artifactDigest: f.identity.digest,
        },
        (_, v) => (typeof v === "bigint" ? v.toString() : v),
      ),
    );
    const request = vi.fn(async (method: string) => ({
      ok: true,
      mode: "local-candidate-only",
      signingEnabled: false,
      payload: method.endsWith("selection")
        ? selection
        : method.endsWith("recover")
          ? f.response.result
          : f.host.review,
    }));
    f.panel.host = null;
    f.panel.client = { request } as never;
    f.panel.connected = true;
    await f.panel.loadConfigured();
    expect(f.panel.host).not.toBeNull();
    await f.panel.refresh();
    if (recovering) {
      expect(f.panel.pending).toEqual(f.identity);
      expect(request).toHaveBeenCalledTimes(1);
      await f.panel.recover();
      expect(f.panel.status).toContain("finalized-success");
    } else {
      expect(f.panel.verified).not.toBeNull();
      expect(request).toHaveBeenCalledTimes(2);
    }
    f.panel.disconnectedCallback();
    expect(f.panel.host).toBeNull();
    sessionStorage.removeItem(f.key);
  },
);
it("rejects mismatched configured artifact and leaves approval disabled", async () => {
  const f = setup();
  sessionStorage.removeItem(f.key);
  const selection = JSON.parse(
    JSON.stringify(
      { expected: f.host.expected, draftSha256: "a".repeat(64), artifactDigest: "b".repeat(64) },
      (_, v) => (typeof v === "bigint" ? v.toString() : v),
    ),
  );
  const request = vi.fn(async (method: string) => ({
    ok: true,
    mode: "local-candidate-only",
    signingEnabled: false,
    payload: method.endsWith("selection") ? selection : f.host.review,
  }));
  f.panel.client = { request } as never;
  f.panel.connected = true;
  await f.panel.loadConfigured();
  expect(f.panel.host).toBeNull();
  expect(f.panel.verified).toBeNull();
});

it("shows direct stake gross, net, pool custody and bounded SOL debit", async () => {
  const { panel, host } = setup("claim-stake");
  await panel.refresh();
  expect(panel.verified).not.toBeNull();
  const rendered = JSON.stringify(panel.render(), (_key, value) =>
    typeof value === "bigint" ? String(value) : value,
  );
  expect(rendered).toContain("Claim gross SAT");
  expect(rendered).toContain("net stake credit");
  expect(rendered).toContain("Maximum SOL debit");
  expect(rendered).toContain(host.expected.claimStake!.destination);
});
