import { type BondClaimReviewExpectation } from "../../../src/wallet/wen-bond-claim-review-contract.js";
import type { BondPurchaseReviewExpectation } from "../../../src/wallet/wen-bond-purchase-review-contract.js";
import type { CampaignReviewExpectation } from "../../../src/wallet/wen-campaign-review-contract.js";
import {
  createWenCampaignSession,
  type CampaignRecoveryIdentity,
  type CampaignSessionTransport,
} from "../../../src/wallet/wen-campaign-session.js";
import type { MarketReviewExpectation } from "../../../src/wallet/wen-market-review-contract.js";
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
