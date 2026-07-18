import type { WalletNamedWallet } from "./wallet-provider-registry.js";

export function normalizeNativeSignerWalletId(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "default";
}

export function resolveNativeSignerWalletId(
  wallet: Pick<WalletNamedWallet, "id" | "providerId" | "metadata">,
): string {
  if (wallet.providerId !== "local-socket-signer") {
    throw new Error(`wallet ${wallet.id} is not owned by the native signer`);
  }
  const recorded =
    typeof wallet.metadata?.signerWalletId === "string"
      ? wallet.metadata.signerWalletId.trim()
      : "";
  if (recorded) {
    if (recorded.length > 64 || normalizeNativeSignerWalletId(recorded) !== recorded) {
      throw new Error(`wallet ${wallet.id} has a non-canonical native signer wallet ID`);
    }
    return recorded;
  }
  const fallback = normalizeNativeSignerWalletId(wallet.id);
  if (fallback.length > 64) {
    throw new Error(`wallet ${wallet.id} has an overlong native signer wallet ID`);
  }
  return fallback;
}
