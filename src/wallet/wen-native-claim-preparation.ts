import { callLocalSocketSigner } from "./providers/local-socket-signer-adapter.js";
import {
  validateWenNativeClaimIntent,
  isWenNativeClaimPreparation,
} from "./wen-native-claim-preparation-contract.js";
export async function prepareWenNativeClaimWithSigner(
  socketPath: string,
  walletId: string,
  input: unknown,
) {
  if (!walletId.trim() || walletId !== walletId.trim()) {
    throw Error("Invalid native claim wallet");
  }
  const intent = validateWenNativeClaimIntent(input);
  const result = await callLocalSocketSigner<unknown>(socketPath, {
    op: "v2.wenNativeClaim.prepare",
    walletId,
    request: intent,
  });
  if (
    !isWenNativeClaimPreparation(result) ||
    result.descriptorSha256 !== intent.descriptorSha256 ||
    BigInt(result.slot) < BigInt(intent.minFinalizedSlot) ||
    BigInt(result.slot) >= BigInt(intent.expiresSlot) ||
    BigInt(result.networkFeeLamports) > BigInt(intent.maxFeeLamports) ||
    BigInt(result.rentLamports) > BigInt(intent.maxRentLamports) ||
    BigInt(result.netSatRaw) < BigInt(intent.minimumReceived)
  ) {
    throw Error("NativeClaim preview binding mismatch");
  }
  return Object.freeze({ ...result });
}
