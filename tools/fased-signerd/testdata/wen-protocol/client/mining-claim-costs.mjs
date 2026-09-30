// Quote an exact compiled claim message. The caller must independently bind that
// message to its validated claim instruction before signing. No accounts are created.
export async function quoteMiningClaimCosts({
  rpc,
  owner,
  message,
  minSlot,
  expiresSlot,
  maxTotalCostLamports,
  maxSlotLag = 32n,
  commitment = "finalized",
  additionalBalanceLamports = 0n,
  parallelBalanceRead = false,
}) {
  const valid = (n) => typeof n === "bigint" && n >= 0n && n <= 0xffffffffffffffffn;
  if (
    ![minSlot, expiresSlot, maxTotalCostLamports, maxSlotLag, additionalBalanceLamports].every(
      valid,
    ) ||
    expiresSlot <= minSlot ||
    typeof owner !== "string" ||
    !owner ||
    typeof message !== "string" ||
    !message ||
    message.length > 1644
  ) {
    throw Error("invalid mining claim cost request");
  }
  let raw;
  try {
    raw = atob(message);
  } catch {
    throw Error("invalid compiled message");
  }
  if (btoa(raw) !== message) {
    throw Error("invalid compiled message");
  }
  const fresh = (n) => valid(n) && n >= minSlot && n - minSlot <= maxSlotLag && n < expiresSlot;
  if (
    typeof parallelBalanceRead !== "boolean" ||
    !["finalized", "confirmed"].includes(commitment)
  ) {
    throw Error("invalid mining claim fee commitment");
  }
  // Only the unsigned Devnet preview opts in. Catch prefetched failures even
  // when fee validation fails first; neither result authorizes spending alone.
  const prefetched = parallelBalanceRead
    ? Promise.resolve()
        .then(() => rpc.getBalance(owner, { commitment, minContextSlot: minSlot }).send())
        .then(
          (value) => ({ value }),
          (error) => ({ error }),
        )
    : null;
  const fee = await rpc.getFeeForMessage(message, { commitment, minContextSlot: minSlot }).send();
  if (!fresh(fee?.context?.slot) || !valid(fee.value) || fee.value > maxTotalCostLamports) {
    throw Error(
      "unavailable, stale or excessive mining claim fee: " +
        `feeSlot=${fee?.context?.slot} minSlot=${minSlot} expiresSlot=${expiresSlot} maxSlotLag=${maxSlotLag} fee=${fee?.value} maxFee=${maxTotalCostLamports}`,
    );
  }
  let balance;
  if (prefetched) {
    const result = await prefetched;
    if (result.error) {
      throw result.error;
    }
    balance = result.value;
  }
  // A valid older snapshot can be refreshed once, within the same fixed bounds.
  // Malformed, out-of-window or insufficient final evidence still fails closed.
  if (!prefetched || (fresh(balance?.context?.slot) && balance.context.slot < fee.context.slot)) {
    balance = await rpc.getBalance(owner, { commitment, minContextSlot: fee.context.slot }).send();
  }
  if (
    !fresh(balance?.context?.slot) ||
    balance.context.slot < fee.context.slot ||
    !valid(balance.value) ||
    balance.value < fee.value + additionalBalanceLamports
  ) {
    throw Error("insufficient or stale mining claim fee balance");
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    Uint8Array.from(raw, (c) => c.charCodeAt(0)),
  );
  const messageSha256 = Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  return Object.freeze({
    networkFeeLamports: fee.value,
    rentLamports: 0n,
    totalCostLamports: fee.value,
    feeSlot: fee.context.slot,
    balanceSlot: balance.context.slot,
    messageSha256,
    paymentEnabled: false,
  });
}
