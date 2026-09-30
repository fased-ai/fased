import {
  bindWenBondClaimReview,
  parseWenBondClaimSelection,
  type BondClaimReviewExpectation,
} from "../../../src/wallet/wen-bond-claim-review-contract.js";
import {
  bindWenBondPurchaseReview,
  parseWenBondPurchaseSelection,
} from "../../../src/wallet/wen-bond-purchase-review-contract.js";
import { bindWenCampaignReview } from "../../../src/wallet/wen-campaign-review-contract.js";
import { campaignSelectionSchema } from "../../../src/wallet/wen-campaign-selection-contract.js";
import { validateWenCampaignJourneyRequest } from "../../../src/wallet/wen-campaign-service-contract.js";
import type { CampaignSessionTransport } from "../../../src/wallet/wen-campaign-session.js";
import {
  bindWenMarketReview,
  parseWenMarketSelection,
} from "../../../src/wallet/wen-market-review-contract.js";

// The selected gateway profile retains proof and signer authority. The browser
// supplies only the verified review and the stored request identity for execution.
export function createCampaignGatewayTransport(
  client: { request<T>(method: string, params: unknown): Promise<T> },
  review: unknown,
  requestId: string,
  signal: AbortSignal,
  domain: "campaign" | "market" | "bond" | "bond-claim" = "campaign",
): CampaignSessionTransport {
  const saved = structuredClone(review);
  async function call(method: string, params: unknown) {
    signal.throwIfAborted();
    const value = await client.request<{
      ok?: unknown;
      mode?: unknown;
      signingEnabled?: unknown;
      payload?: unknown;
    }>(`wen.${domain}.approval.` + method, params);
    signal.throwIfAborted();
    if (
      value?.ok !== true ||
      value.mode !== "local-candidate-only" ||
      value.signingEnabled !== (method === "execute")
    ) {
      throw Error("Invalid campaign gateway envelope");
    }
    return value.payload;
  }
  return {
    begin: async (request) => {
      if (request.requestId !== requestId) {
        throw Error("Campaign request changed");
      }
      return call("begin", { input: saved });
    },
    finish: (request) => call("finish", request),
    journey: async (input) => {
      const request = validateWenCampaignJourneyRequest(input);
      if (request.requestId !== requestId || !["execute", "recover"].includes(request.action)) {
        throw Error("Unsupported campaign gateway request");
      }
      return { ok: true, result: await call(request.action, { requestId }) };
    },
  };
}

export async function loadCampaignGatewayHost(
  client: { request<T>(method: string, params: unknown): Promise<T> },
  signal: AbortSignal,
  storage: Pick<Storage, "getItem">,
  domain: "campaign" | "market" | "bond" | "bond-claim" = "campaign",
) {
  async function read(method: string, params: unknown) {
    signal.throwIfAborted();
    const value = await client.request<{
      ok?: unknown;
      mode?: unknown;
      signingEnabled?: unknown;
      payload?: unknown;
    }>(`wen.${domain}.approval.` + method, params);
    signal.throwIfAborted();
    if (
      value?.ok !== true ||
      value.mode !== "local-candidate-only" ||
      value.signingEnabled !== false
    ) {
      throw Error("Invalid campaign configuration response");
    }
    return value.payload;
  }
  const payload = await read("selection", {});
  const selected =
    domain === "bond-claim"
      ? parseWenBondClaimSelection(payload)
      : domain === "bond"
        ? parseWenBondPurchaseSelection(payload)
        : domain === "market"
          ? parseWenMarketSelection(payload)
          : campaignSelectionSchema.parse(payload);
  const { expected } = selected;
  const retained = storage.getItem(
    `wen.${domain}.pending:${"policy" in expected && "pins" in expected ? ("Deployment" in expected.policy ? expected.policy.Deployment.Genesis : expected.policy.Successor.Genesis) : expected.genesis}:${expected.walletId}`,
  );
  let review: unknown = null;
  if (retained !== null) {
    const pending = JSON.parse(retained);
    if (
      pending?.requestId !== expected.requestId ||
      pending?.walletId !== expected.walletId ||
      pending?.digest !== selected.artifactDigest
    ) {
      throw Error("Retained campaign requires its original configured identity");
    }
  } else {
    review = await read("prepare", {
      input: { requestId: expected.requestId, draftSha256: selected.draftSha256 },
    });
    const verified =
      domain === "bond-claim"
        ? await bindWenBondClaimReview(review, expected as BondClaimReviewExpectation)
        : domain === "bond"
          ? await bindWenBondPurchaseReview(
              review,
              expected as Parameters<typeof bindWenBondPurchaseReview>[1],
            )
          : domain === "market"
            ? await bindWenMarketReview(
                review,
                expected as Parameters<typeof bindWenMarketReview>[1],
              )
            : await bindWenCampaignReview(
                review,
                expected as Parameters<typeof bindWenCampaignReview>[1],
              );
    if (verified.artifactDigest !== "sha256:" + selected.artifactDigest) {
      throw Error("Campaign review does not match selected artifact");
    }
  }
  signal.throwIfAborted();
  return {
    review,
    expected,
    transport: createCampaignGatewayTransport(client, review, expected.requestId, signal, domain),
  };
}

export function loadMarketGatewayHost(
  client: { request<T>(method: string, params: unknown): Promise<T> },
  signal: AbortSignal,
  storage: Pick<Storage, "getItem">,
) {
  return loadCampaignGatewayHost(client, signal, storage, "market");
}
