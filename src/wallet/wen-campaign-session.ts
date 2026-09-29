import {
  bindWenBondClaimReview,
  type BondClaimReviewExpectation,
} from "./wen-bond-claim-review-contract.js";
import {
  bindWenBondPurchaseReview,
  type BondPurchaseReviewExpectation,
} from "./wen-bond-purchase-review-contract.js";
import {
  bindWenCampaignAuthorizationBegin,
  bindWenCampaignAuthorizationFinish,
} from "./wen-campaign-authorization-contract.js";
import {
  bindWenCampaignReview,
  type CampaignReviewExpectation,
} from "./wen-campaign-review-contract.js";
import {
  readWenCampaignJourneyResult,
  validateWenCampaignJourneyRequest,
  type WenCampaignJourneyRequest,
} from "./wen-campaign-service-contract.js";
import { bindWenMarketReview, type MarketReviewExpectation } from "./wen-market-review-contract.js";

// Injected internal transport only. No public socket opcode or production binding
// is registered here. The transport must retain its selected wallet/profile.
export interface CampaignSessionTransport {
  begin(request: { requestId: string }): Promise<unknown>;
  finish(request: { challengeId: string; credential: unknown }): Promise<unknown>;
  journey(request: WenCampaignJourneyRequest): Promise<unknown>;
}
export type CampaignRecoveryIdentity = { requestId: string; walletId: string; digest: string };
// Recovery uses an already retained identity, not a new review/approval or expiry.
// The signer is authoritative for its durable journal and never resends here.
export async function recoverWenCampaignSession(
  transport: Pick<CampaignSessionTransport, "journey">,
  identity: CampaignRecoveryIdentity,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const expected = { ...identity };
  const response = await transport.journey(
    validateWenCampaignJourneyRequest({ requestId: expected.requestId, action: "recover" }),
  );
  signal.throwIfAborted();
  return readWenCampaignJourneyResult(response, expected);
}
export async function createWenCampaignSession(
  input: unknown,
  expected:
    | CampaignReviewExpectation
    | MarketReviewExpectation
    | BondPurchaseReviewExpectation
    | BondClaimReviewExpectation,
  transport: CampaignSessionTransport,
  signal: AbortSignal,
  domain: "campaign" | "market" | "bond" | "bond-claim" = "campaign",
) {
  signal.throwIfAborted();
  const pins = structuredClone(expected);
  const bindReview = (v: unknown) =>
    domain === "bond-claim"
      ? bindWenBondClaimReview(v, pins as BondClaimReviewExpectation)
      : domain === "bond"
        ? bindWenBondPurchaseReview(v, pins as BondPurchaseReviewExpectation)
        : domain === "market"
          ? bindWenMarketReview(v, pins as MarketReviewExpectation)
          : bindWenCampaignReview(v, pins as CampaignReviewExpectation);
  const review = await bindReview(input);
  signal.throwIfAborted();
  const identity = Object.freeze({
    requestId: review.requestId,
    walletId: review.walletId,
    digest: review.artifactDigest.slice(7),
  });
  let busy = false,
    began = false,
    finished = false,
    attempted = false;
  let challenge: ReturnType<typeof bindWenCampaignAuthorizationBegin> | undefined;
  let approval: ReturnType<typeof bindWenCampaignAuthorizationFinish> | undefined;
  async function run<T>(work: () => Promise<T>) {
    signal.throwIfAborted();
    if (busy) {
      throw Error("Campaign session already has work in flight");
    }
    busy = true;
    try {
      return await work();
    } finally {
      busy = false;
    }
  }
  return {
    identity,
    review: structuredClone(review),
    begin: () =>
      run(async () => {
        if (began || attempted) {
          throw Error("Campaign approval already attempted");
        }
        await bindReview(review);
        signal.throwIfAborted();
        began = true;
        const result = await transport.begin({ requestId: identity.requestId });
        signal.throwIfAborted();
        challenge = bindWenCampaignAuthorizationBegin(result, review);
        return structuredClone(challenge);
      }),
    finish: (credential: unknown) =>
      run(async () => {
        if (!challenge || finished || attempted) {
          throw Error("Campaign approval unavailable or already attempted");
        }
        bindWenCampaignAuthorizationBegin(challenge, review);
        const copy = structuredClone(credential);
        const encoded = JSON.stringify(copy);
        if (!encoded || new TextEncoder().encode(encoded).length > 65536) {
          throw Error("Invalid campaign credential size");
        }
        finished = true;
        const result = await transport.finish({
          challengeId: challenge.challengeId,
          credential: copy,
        });
        signal.throwIfAborted();
        approval = bindWenCampaignAuthorizationFinish(result, review);
        return { approved: true } as const;
      }),
    execute: () =>
      run(async () => {
        if (!approval || attempted) {
          throw Error("Campaign execution unavailable or already attempted; recover its journal");
        }
        await bindReview(review);
        bindWenCampaignAuthorizationFinish(approval, review);
        signal.throwIfAborted();
        const request = validateWenCampaignJourneyRequest({
          requestId: identity.requestId,
          action: "execute",
          proof: approval.authorization.proof,
        });
        // Set before dispatch: timeout, malformed reply or disconnect may follow signing.
        attempted = true;
        const response = await transport.journey(request);
        signal.throwIfAborted();
        return readWenCampaignJourneyResult(response, identity);
      }),
    recover: () =>
      run(() => {
        attempted = true;
        return recoverWenCampaignSession(transport, identity, signal);
      }),
  };
}

export function createWenMarketSession(
  input: unknown,
  expected: MarketReviewExpectation,
  transport: CampaignSessionTransport,
  signal: AbortSignal,
) {
  return createWenCampaignSession(input, expected, transport, signal, "market");
}
