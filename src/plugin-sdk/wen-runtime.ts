// WEN operations only; no old Satcoin runtime or configuration.
export async function createLocalWenRecoveryProfile(
  profilePath: string,
  onError: (error: unknown) => void,
) {
  const module = await import("../wallet/wen-mining-recovery-profile.js");
  return module.createLocalWenRecoveryProfile(profilePath, onError);
}

export async function createLocalWenCampaignProfile(profilePath: string) {
  const module = await import("../wallet/wen-campaign-local-profile.js");
  return module.createLocalWenCampaignProfile(profilePath);
}

export { buildWenAcquisitionHandoff } from "../wallet/wen-acquisition-handoff.js";
export { readWenEconomyLocal } from "../wallet/wen-economy-read.js";
export type { WenEconomyReadPin } from "../wallet/wen-economy-read.js";

export async function createLocalWenMarketProfile(profilePath: string) {
  const module = await import("../wallet/wen-campaign-local-profile.js");
  return module.createLocalWenMarketProfile(profilePath);
}
