// Shared receipt rent and owner balance checks. Rent is reported separately
// from the network fee; neither is assumed to be earned yield.
export async function quoteClaimCosts({
  rpc,
  owner,
  minSlot,
  networkFeeLamports,
  maxTotalCostLamports,
  maxSlotLag = 32n,
  receiptBytes,
}) {
  const u64 = (n) => typeof n === "bigint" && n >= 0n && n <= 0xffffffffffffffffn;
  if (![minSlot, networkFeeLamports, maxTotalCostLamports, maxSlotLag].every(u64)) {
    throw new Error("invalid claim cost bounds");
  }
  if (!Number.isInteger(receiptBytes) || receiptBytes < 1 || receiptBytes > 4096) {
    throw new Error("invalid claim receipt size");
  }
  const rentLamports = await rpc
    .getMinimumBalanceForRentExemption(BigInt(receiptBytes), { commitment: "finalized" })
    .send();
  if (!u64(rentLamports) || rentLamports === 0n) {
    throw new Error("invalid claim rent");
  }
  const totalCostLamports = rentLamports + networkFeeLamports;
  if (!u64(totalCostLamports) || totalCostLamports > maxTotalCostLamports) {
    throw new Error("claim exceeds total SOL budget");
  }
  const balance = await rpc
    .getBalance(owner, { commitment: "finalized", minContextSlot: minSlot })
    .send();
  if (
    !u64(balance?.context?.slot) ||
    balance.context.slot < minSlot ||
    balance.context.slot - minSlot > maxSlotLag ||
    !u64(balance.value) ||
    balance.value < totalCostLamports
  ) {
    throw new Error("insufficient or stale SOL balance");
  }
  return { rentLamports, totalCostLamports };
}
