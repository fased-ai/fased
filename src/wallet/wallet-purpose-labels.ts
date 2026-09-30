// Purpose labels are presentation metadata, never signer admission or policy.
export function walletPurposeLabels(metadata?: Record<string, unknown>): string[] {
  if (!metadata) {
    return [];
  }
  const raw = metadata.purposeLabels;
  if (Array.isArray(raw)) {
    if (
      raw.length > 8 ||
      raw.some((v) => typeof v !== "string" || !/^[A-Za-z0-9][A-Za-z0-9 _-]{0,31}$/.test(v))
    ) {
      return [];
    }
    return [...new Set(raw.map((v) => v.trim()).filter(Boolean))];
  }
  return [];
}

export function nextWalletDisplayName(wallets: ReadonlyArray<{ name?: string }>): string {
  const names = new Set(wallets.map((wallet) => wallet.name?.trim().toLowerCase()));
  for (let number = 1; ; number += 1) {
    const name = number === 1 ? "Wallet" : `Wallet ${number}`;
    if (!names.has(name.toLowerCase())) {
      return name;
    }
  }
}

export function nextStandardWalletIdentity(wallets: ReadonlyArray<{ id: string; name?: string }>) {
  const ids = new Set(wallets.map((wallet) => wallet.id.toLowerCase().replace(/-/g, "_")));
  for (let number = 1; ; number++) {
    const walletId = `wallet-${number}`;
    if (!ids.has(walletId.replace(/-/g, "_"))) {
      return { walletId, walletName: nextWalletDisplayName(wallets) };
    }
  }
}
