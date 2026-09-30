import { expect, it, vi } from "vitest";
import { createCampaignGatewayTransport } from "./wen-campaign-gateway-transport.js";

it("forwards only retained identity for execution and restores the result envelope", async () => {
  const request = vi.fn(async (method: string) => ({
    ok: true,
    mode: "local-candidate-only",
    signingEnabled: method.endsWith("execute"),
    payload: { status: "pending" },
  }));
  const controller = new AbortController();
  const transport = createCampaignGatewayTransport(
    { request } as never,
    {},
    "request-1",
    controller.signal,
  );
  expect(
    await transport.journey({
      action: "execute",
      requestId: "request-1",
      proof: { proofId: "private-proof" },
    }),
  ).toEqual({
    ok: true,
    result: { status: "pending" },
  });
  expect(request).toHaveBeenCalledWith("wen.campaign.approval.execute", { requestId: "request-1" });
  await transport.journey({ action: "recover", requestId: "request-1" });
  expect(request).toHaveBeenLastCalledWith("wen.campaign.approval.recover", {
    requestId: "request-1",
  });
  await expect(transport.journey({ action: "recover", requestId: "other" })).rejects.toThrow();
  expect(request).toHaveBeenCalledTimes(2);
  controller.abort();
  await expect(transport.journey({ action: "recover", requestId: "request-1" })).rejects.toThrow();
  expect(request).toHaveBeenCalledTimes(2);
});

it("rejects an invalid gateway envelope", async () => {
  const request = vi.fn(async () => ({ ok: true, signingEnabled: true, payload: {} }));
  const transport = createCampaignGatewayTransport(
    { request } as never,
    {},
    "request-1",
    new AbortController().signal,
  );
  await expect(transport.journey({ action: "recover", requestId: "request-1" })).rejects.toThrow(
    "Invalid campaign gateway envelope",
  );
});
