import { bindWenClaimJourneyResult } from "../../../src/wallet/wen-claim-journey-contract.js";
import {
  bindWenMiningAuthorizationBegin,
  bindWenMiningAuthorizationFinish,
} from "../../../src/wallet/wen-mining-review-authorization-contract.js";
import {
  bindWenMiningStoredReview,
  validateWenMiningReviewPrepareRequest,
} from "../../../src/wallet/wen-mining-review-preparation-contract.js";
import { authorizeSignerReviewWithPasskey } from "./wallet-passkey.js";

type Client = { request<T>(method: string, params: unknown): Promise<T> };
export async function approveWenClaim(
  client: Client,
  walletId: string,
  input: unknown,
  signal: AbortSignal,
  beforeExecution: () => void = () => {},
) {
  const request = structuredClone(validateWenMiningReviewPrepareRequest(input));
  async function call(method: string, params: unknown) {
    signal.throwIfAborted();
    const result = await client.request<{
      ok: unknown;
      mode: string;
      signingEnabled: unknown;
      payload: unknown;
    }>("wen.mining.approval." + method, params);
    signal.throwIfAborted();
    if (
      result.ok !== true ||
      result.mode !== "local-candidate-only" ||
      result.signingEnabled !== (method === "execute")
    ) {
      throw Error("Invalid approval response");
    }
    return result.payload;
  }
  try {
    const review = await bindWenMiningStoredReview(
      await call("prepare", { input: request }),
      request,
      walletId,
    );
    const begin = bindWenMiningAuthorizationBegin(await call("begin", { input: review }), review);
    signal.throwIfAborted();
    const assertion = await authorizeSignerReviewWithPasskey(begin, signal);
    signal.throwIfAborted();
    if (assertion.challengeId !== begin.challengeId) {
      throw Error("Approval challenge changed");
    }
    bindWenMiningAuthorizationFinish(await call("finish", assertion), review);
    signal.throwIfAborted();
    beforeExecution();
    try {
      return bindWenClaimJourneyResult(
        await call("execute", { requestId: request.requestId }),
        request.requestId,
        walletId,
      );
    } catch {
      signal.throwIfAborted();
      // Reconcile once after a lost response; never repeat the execute request.
      return bindWenClaimJourneyResult(
        await call("recover", { requestId: request.requestId }),
        request.requestId,
        walletId,
      );
    }
  } finally {
    // Best effort only: the gateway also expires abandoned sessions. Never retry finish.
    await client.request("wen.mining.approval.cancel", {}).catch(() => {});
  }
}
