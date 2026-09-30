// Synthetic Devnet acceptance may need extra finalized slots to read the full
// upgradeable ProgramData repeatedly. Production keeps the tighter 32-slot cap.
export function campaignReadWindow(config) {
  return config?.networkProfile === "devnet-synthetic-fixture" && config?.chain === "solana:devnet"
    ? 256n
    : 32n;
}
