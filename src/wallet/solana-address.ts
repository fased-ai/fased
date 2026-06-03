import { PublicKey } from "@solana/web3.js";

export function isValidSolanaAddress(value: string | undefined): boolean {
  const text = value?.trim();
  if (!text) {
    return false;
  }
  try {
    return new PublicKey(text).toBase58() === text;
  } catch {
    return false;
  }
}

export function assertValidSolanaAddress(value: string | undefined, label = "Solana address") {
  if (!isValidSolanaAddress(value)) {
    throw new Error(`${label} is not a valid Solana address`);
  }
}
