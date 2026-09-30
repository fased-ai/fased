// Fixed counterparts of src/network_profile.rs. Selection is an installed host
// policy, never a quote request override; synthetic assets are not real USD/BTC.
const MAINNET = Object.freeze({
  label: "mainnet",
  synthetic: false,
  btc: "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij",
  router: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
  usdc: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  oraclePush: "pyt2F414BA6dPttK6RddPZUdHfapoBN24GL5wbrPCou",
  oracleReceiver: "rec2HHDDnjLfj4kE7VyEtFA1HPGQLK33259532cRyHp",
  cpmm: "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
});
const DEVNET = Object.freeze({
  label: "devnet-synthetic-fixture",
  synthetic: true,
  btc: "GjcBddmBe8EHZQXqaf9qHsxovSqZ4ZpNE8Huc25sziTv",
  router: "G7q2jKVjXZCFXLVeJU9AXKe8HNpH5VKxYJo4jdbCzEh6",
  usdc: "DE8BhmX7qJGzjUSHnYYEXjAcnr86aVUCNquoyEqYsENc",
  oraclePush: "G7q2jKVjXZCFXLVeJU9AXKe8HNpH5VKxYJo4jdbCzEh6",
  oracleReceiver: "G7q2jKVjXZCFXLVeJU9AXKe8HNpH5VKxYJo4jdbCzEh6",
  cpmm: "DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb",
});
export function networkProfile(label = "mainnet") {
  if (label === "mainnet") {
    return MAINNET;
  }
  if (label === "devnet-synthetic-fixture") {
    return DEVNET;
  }
  throw Error("unsupported network profile");
}
