import { type BondClaimReviewExpectation } from "../../../src/wallet/wen-bond-claim-review-contract.js";
import type { BondPurchaseReviewExpectation } from "../../../src/wallet/wen-bond-purchase-review-contract.js";
import type { CampaignReviewExpectation } from "../../../src/wallet/wen-campaign-review-contract.js";
import { readWenCampaignJourneyResult } from "../../../src/wallet/wen-campaign-service-contract.js";
import {
  createWenCampaignSession,
  type CampaignRecoveryIdentity,
  type CampaignSessionTransport,
} from "../../../src/wallet/wen-campaign-session.js";
import { bindOwnerMarketApproval } from "../../../src/wallet/wen-market-owner-approval-contract.js";
import {
  bindWenMarketReview,
  type MarketReviewExpectation,
} from "../../../src/wallet/wen-market-review-contract.js";
import { authorizeSignerReviewWithPasskey } from "./wallet-passkey.js";

// Fased control UI candidate helper. The host supplies a profile-bound transport;
// this file neither registers gateway methods nor supplies deployment identities.
// beforeExecution must retain identity for recovery after navigation/disconnection.
export async function approveWenCampaign(
  review: unknown,
  expected:
    | CampaignReviewExpectation
    | MarketReviewExpectation
    | BondPurchaseReviewExpectation
    | BondClaimReviewExpectation,
  transport: CampaignSessionTransport,
  signal: AbortSignal,
  beforeExecution: (identity: CampaignRecoveryIdentity) => void | Promise<void>,
  domain: "campaign" | "market" | "bond" | "bond-claim" = "campaign",
) {
  const session = await createWenCampaignSession(review, expected, transport, signal, domain);
  const challenge = await session.begin();
  signal.throwIfAborted();
  const assertion = await authorizeSignerReviewWithPasskey(challenge, signal);
  signal.throwIfAborted();
  if (assertion.challengeId !== challenge.challengeId) {
    throw Error("Campaign approval challenge changed");
  }
  await session.finish(assertion.credential);
  signal.throwIfAborted();
  await beforeExecution({ ...session.identity });
  signal.throwIfAborted();
  try {
    return await session.execute();
  } catch {
    signal.throwIfAborted();
    // Exactly one reconciliation, never a repeated execute or approval request.
    // If recovery fails too, the caller still has the retained identity.
    return session.recover();
  }
}

// The native owner channel creates the proof. This view can only consume its
// exact, expiring handle; it cannot grant a wallet operation or mint authority.
export async function approveWenMarketWithOwnerConfirmation(
  input: unknown,
  expected: MarketReviewExpectation,
  transport: CampaignSessionTransport,
  proofId: string,
  signal: AbortSignal,
  beforeExecution: (identity: CampaignRecoveryIdentity) => void | Promise<void>,
) {
  signal.throwIfAborted();
  const review = await bindWenMarketReview(input, expected);
  if (!transport.confirmOwner) {
    throw Error("Owner confirmation unavailable");
  }
  const metadata = await transport.confirmOwner({ requestId: review.requestId, proofId });
  signal.throwIfAborted();
  const approval = bindOwnerMarketApproval(metadata, review, proofId);
  const identity = {
    requestId: review.requestId,
    walletId: review.walletId,
    digest: review.artifactDigest.slice(7),
  };
  await beforeExecution({ ...identity });
  signal.throwIfAborted();
  bindOwnerMarketApproval(approval, review, proofId);
  try {
    const response = await transport.journey({
      requestId: identity.requestId,
      action: "execute",
      proof: { proofId },
    });
    signal.throwIfAborted();
    return readWenCampaignJourneyResult(response, identity);
  } catch {
    signal.throwIfAborted();
    const response = await transport.journey({ requestId: identity.requestId, action: "recover" });
    signal.throwIfAborted();
    return readWenCampaignJourneyResult(response, identity);
  }
}
