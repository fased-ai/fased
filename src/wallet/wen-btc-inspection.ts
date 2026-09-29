import { callLocalSocketSigner } from "./providers/local-socket-signer-adapter.js";
import { isWenBtcInspection, type WenBtcInspection } from "./wen-btc-inspection-contract.js";
import { validateWenBtcIntentCandidate } from "./wen-btc-intent.js";

// Read-only inspection; no transaction preparation, signing or broadcast fallback.
export async function inspectWenBtcWithSigner(
  socketPath: string,
  walletId: string,
  input: unknown,
): Promise<WenBtcInspection> {
  if (!walletId.trim() || walletId !== walletId.trim()) {
    throw new Error("Invalid WEN BTC inspection wallet");
  }
  const intent = validateWenBtcIntentCandidate(input);
  const result = await callLocalSocketSigner<unknown>(socketPath, {
    op: "v2.wenBtc.inspect",
    walletId,
    request: intent,
  });
  if (
    !isWenBtcInspection(result) ||
    result.operation !== intent.operation ||
    result.descriptorSha256 !== intent.descriptorSha256 ||
    result.offerSha256 !== intent.offerSha256 ||
    BigInt(result.readback.slot) < BigInt(intent.minFinalizedSlot) ||
    BigInt(result.readback.referenceSlot) >= BigInt(intent.expiresSlot)
  ) {
    throw new Error("WEN BTC inspection differs from requested review");
  }
  return result;
}
