import { callLocalSocketSigner } from "./providers/local-socket-signer-adapter.js";
import {
  validateWenMiningFundingIntent,
  isWenMiningFundingPreparation,
} from "./wen-mining-funding-preparation-contract.js";
export async function prepareWenMiningFundingWithSigner(
  socketPath: string,
  walletId: string,
  input: unknown,
) {
  if (!walletId.trim() || walletId !== walletId.trim()) {
    throw Error("Invalid mining funding wallet");
  }
  const intent = validateWenMiningFundingIntent(input);
  const result = await callLocalSocketSigner<unknown>(socketPath, {
    op: "v2.wenMiningFunding.prepare",
    walletId,
    request: intent,
  });
  if (
    !isWenMiningFundingPreparation(result) ||
    result.descriptorSha256 !== intent.descriptorSha256 ||
    BigInt(result.slot) < BigInt(intent.minFinalizedSlot) ||
    BigInt(result.slot) >= BigInt(intent.expiresSlot) ||
    BigInt(result.networkFeeLamports) > BigInt(intent.maxFeeLamports) ||
    result.capitalLamports !== intent.amount
  ) {
    throw Error("MiningFunding preview binding mismatch");
  }
  return Object.freeze({ ...result });
}
