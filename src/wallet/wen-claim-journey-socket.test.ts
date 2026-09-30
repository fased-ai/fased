import { expect, it } from "vitest";
import {
  parseLocalSocketSignerRequest,
  validateLocalSocketSignerResult,
} from "./local-socket-signer-protocol.js";

const envelope = (request: unknown) => ({
  op: "v2.wenMining.claim.journey",
  walletId: "bank_test",
  request,
});
it("validates journey results before the profile binds wallet and request", () => {
  const result = {
    requestId: "state-request",
    walletId: "bank_test",
    digest: "a".repeat(64),
    outcome: "finalized-success",
    recoveryRequired: false,
  };
  expect(validateLocalSocketSignerResult("v2.wenMining.claim.journey", result)).toBe(true);
  for (const patch of [
    { digest: "bad" },
    { walletId: "" },
    { requestId: "" },
    { outcome: "pending" },
    { recoveryRequired: "false" },
    { transaction: "injected" },
  ]) {
    expect(
      validateLocalSocketSignerResult("v2.wenMining.claim.journey", { ...result, ...patch }),
    ).toBe(false);
  }
});
it.each([
  { requestId: "state-request", action: "execute", proof: { proofId: "issued-proof" } },
  { requestId: "state-request", action: "recover" },
])("admits the protected claim $action socket operation", (request) => {
  expect(parseLocalSocketSignerRequest(envelope(request))).toEqual(envelope(request));
});
it("rejects unbound execution, proof-bearing recovery and caller-controlled transactions", () => {
  for (const request of [
    { requestId: "state-request", action: "execute" },
    { requestId: "state-request", action: "execute", proof: { proofId: "" } },
    { requestId: "state-request", action: "recover", proof: { proofId: "issued-proof" } },
    { requestId: "state-request", action: "send" },
    { requestId: "short", action: "recover" },
    { requestId: " state-request", action: "recover" },
    ...["transaction", "rpc", "destination", "walletId"].map((key) => ({
      requestId: "state-request",
      action: "recover",
      [key]: "override",
    })),
  ]) {
    expect(() => parseLocalSocketSignerRequest(envelope(request))).toThrow();
  }
});
