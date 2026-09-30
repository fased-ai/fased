import { callLocalSocketSigner } from "./providers/local-socket-signer-adapter.js";
import {
  validateWenBtcClaimIntent,
  isWenBtcClaimPreparation,
} from "./wen-btc-claim-preparation-contract.js";
export async function prepareWenBtcClaimWithSigner(
  socketPath: string,
  walletId: string,
  input: unknown,
) {
  if (!walletId.trim() || walletId !== walletId.trim()) {
    throw Error("Invalid BTC claim wallet");
  }
  const intent = validateWenBtcClaimIntent(input);
  const result = await callLocalSocketSigner<unknown>(socketPath, {
    op: "v2.wenBTCClaim.prepare",
    walletId,
    request: intent,
  });
  if (
    !isWenBtcClaimPreparation(result) ||
    result.descriptorSha256 !== intent.descriptorSha256 ||
    BigInt(result.slot) < BigInt(intent.minFinalizedSlot) ||
    BigInt(result.slot) >= BigInt(intent.expiresSlot) ||
    BigInt(result.networkFeeLamports) > BigInt(intent.maxFeeLamports) ||
    BigInt(result.rentLamports) > BigInt(intent.maxRentLamports) ||
    BigInt(result.netBtcRaw) < BigInt(intent.minimumReceived)
  ) {
    throw Error("BtcClaim preview binding mismatch");
  }
  return Object.freeze({ ...result });
}
