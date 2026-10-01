import type { FasedAgentPluginApi } from "fased/plugin-sdk";
import { afterEach, expect, it, vi } from "vitest";
import { registerWenApprovalGateway, WEN_APPROVAL_METHODS } from "./wen-approval-gateway.js";
afterEach(() => vi.useRealTimers());
function setup(namespace: "wen.mining.approval" | "wen.market.approval" = "wen.mining.approval") {
  const profile = {
    confirmOwnerApproval: vi.fn(async () => ({ proofId: "Q".repeat(43) })),
    prepareClaimApproval: vi.fn(async () => ({ prepared: true })),
    beginClaimApproval: vi.fn(async () => ({ challengeId: "challenge" })),
    finishClaimApproval: vi.fn(async () => ({ proof: "proof" })),
    cancelClaimApproval: vi.fn(),
    runClaimJourney: vi.fn(async () => ({ outcome: "finalized-success" })),
  };
  let selected: typeof profile | undefined = profile;
  const handlers = new Map<string, Parameters<FasedAgentPluginApi["registerGatewayMethod"]>[1]>();
  const scopes: unknown[] = [];
  const cancel = registerWenApprovalGateway(
    {
      registerGatewayMethod(name, handler, options) {
        handlers.set(name, handler);
        scopes.push(options);
      },
    },
    () => selected,
    namespace,
  );
  async function call(suffix: string, params: unknown, connection = "owner") {
    const respond = vi.fn();
    await handlers.get(namespace + "." + suffix)!({
      params,
      client: { connId: connection },
      respond,
    } as never);
    return respond.mock.calls[0];
  }
  return {
    profile,
    call,
    cancel,
    scopes,
    handlers,
    remove: () => {
      selected = undefined;
      cancel();
    },
  };
}
it("registers only admin methods and rejects unknown input and missing connection", async () => {
  const s = setup();
  expect([...s.handlers.keys()]).toEqual(WEN_APPROVAL_METHODS);
  expect(s.scopes).toEqual(WEN_APPROVAL_METHODS.map(() => ({ scope: "operator.admin" })));
  expect((await s.call("prepare", { input: {}, walletId: "override" }))[0]).toBe(false);
  expect((await s.call("prepare", { input: {} }, ""))[0]).toBe(false);
  expect(s.profile.prepareClaimApproval).not.toHaveBeenCalled();
});
it("binds begin and finish to one connection and consumes the session", async () => {
  const s = setup();
  expect((await s.call("prepare", { input: {} }))[0]).toBe(true);
  expect((await s.call("begin", { input: {} }))[0]).toBe(true);
  expect((await s.call("cancel", {}, "other"))[0]).toBe(false);
  expect((await s.call("finish", { challengeId: "challenge", credential: {} }, "other"))[0]).toBe(
    false,
  );
  expect(s.profile.finishClaimApproval).not.toHaveBeenCalled();
  expect((await s.call("finish", { challengeId: "challenge", credential: {} }))[1]).toMatchObject({
    signingEnabled: false,
  });
  expect((await s.call("finish", { challengeId: "challenge", credential: {} }))[0]).toBe(false);
  expect(s.profile.finishClaimApproval).toHaveBeenCalledOnce();
  expect((await s.call("execute", { requestId: "request-123" }, "other"))[0]).toBe(false);
  expect((await s.call("execute", { requestId: "request-123" }))[0]).toBe(true);
  expect((await s.call("execute", { requestId: "request-123" }))[0]).toBe(false);
  expect((await s.call("recover", { requestId: "request-123" }))[0]).toBe(true);
  expect(s.profile.runClaimJourney).toHaveBeenCalledTimes(2);
});
it("discards late begin on service replacement and disallows concurrent begin", async () => {
  const s = setup();
  let resolve!: (value: { challengeId: string }) => void;
  s.profile.beginClaimApproval.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const first = s.call("begin", { input: {} });
  expect((await s.call("begin", { input: {} }))[0]).toBe(false);
  s.remove();
  resolve({ challengeId: "late" });
  expect((await first)[0]).toBe(false);
});
it("expires an abandoned connection without allowing a later finish", async () => {
  vi.useFakeTimers();
  const s = setup();
  await s.call("begin", { input: {} });
  await vi.advanceTimersByTimeAsync(120000);
  expect(s.profile.cancelClaimApproval).toHaveBeenCalledOnce();
  expect((await s.call("finish", { challengeId: "challenge", credential: {} }))[0]).toBe(false);
});
it("does not retry uncertain finish and cancellation discards late replies", async () => {
  const s = setup();
  await s.call("begin", { input: {} });
  s.profile.finishClaimApproval.mockRejectedValue(Error("lost reply"));
  expect((await s.call("finish", { challengeId: "challenge", credential: {} }))[0]).toBe(false);
  expect((await s.call("finish", { challengeId: "challenge", credential: {} }))[0]).toBe(false);
  expect(s.profile.finishClaimApproval).toHaveBeenCalledOnce();
});
it("registers a separate fail-closed campaign namespace without a bound profile", async () => {
  const handlers = new Map<string, Parameters<FasedAgentPluginApi["registerGatewayMethod"]>[1]>();
  const stop = registerWenApprovalGateway(
    {
      registerGatewayMethod(name, handler, options) {
        expect(options).toEqual({ scope: "operator.admin" });
        handlers.set(name, handler);
      },
    },
    () => undefined,
    "wen.campaign.approval",
  );
  expect(handlers.size).toBe(7);
  for (const suffix of ["prepare", "begin", "finish", "execute", "recover"]) {
    const respond = vi.fn();
    const params =
      suffix === "finish"
        ? { challengeId: "challenge", credential: {} }
        : ["execute", "recover"].includes(suffix)
          ? { requestId: "request-1" }
          : { input: {} };
    await handlers.get("wen.campaign.approval." + suffix)!({
      params,
      client: { connId: "owner" },
      respond,
    } as never);
    expect(respond.mock.calls[0][0]).toBe(false);
  }
  stop();
});

it("joins owner confirmation to the same connection and consumes it exactly once", async () => {
  const s = setup("wen.market.approval");
  expect((await s.call("execute", { requestId: "request" }))[0]).toBe(false);
  expect((await s.call("owner-confirm", { input: {} }))[0]).toBe(true);
  expect((await s.call("execute", { requestId: "request" }, "other"))[0]).toBe(false);
  expect((await s.call("finish", { challengeId: "other", credential: {} }))[0]).toBe(false);
  expect((await s.call("execute", { requestId: "request" }))[0]).toBe(true);
  expect((await s.call("execute", { requestId: "request" }))[0]).toBe(false);
  expect(s.profile.runClaimJourney).toHaveBeenCalledTimes(1);
  expect(s.profile.beginClaimApproval).not.toHaveBeenCalled();
  expect(s.profile.finishClaimApproval).not.toHaveBeenCalled();
});
it("cancels owner confirmation on disconnect or timeout", async () => {
  vi.useFakeTimers();
  const s = setup("wen.market.approval");
  await s.call("owner-confirm", { input: {} });
  vi.advanceTimersByTime(120000);
  expect((await s.call("execute", { requestId: "request" }))[0]).toBe(false);
  expect(s.profile.runClaimJourney).not.toHaveBeenCalled();
  s.cancel();
});
