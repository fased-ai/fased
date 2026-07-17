export type { FasedAgentConfig } from "../config/config.js";
export { loadConfig, resolveGatewayPort } from "../config/config.js";
export {
  SAT_RUNTIME_DEFAULTS,
  resolveSatBondProgramIdFromEnv,
  resolveSatMintAddressFromEnv,
  resolveSatMintProgramIdFromEnv,
  resolveSatProgramIdFromEnv,
  tryResolveSatRuntimeIds,
} from "../config/sat-runtime-ids.js";
export type { SatRuntimeIds } from "../config/sat-runtime-ids.js";
export type { ErrorCode } from "../gateway/protocol/index.js";
export { ErrorCodes, errorShape } from "../gateway/protocol/index.js";
export type { RespondFn } from "../gateway/server-methods/types.js";
export { callGatewayScoped } from "../gateway/call.js";
export { getSatMainnetSyncStatus, syncSatMainnetRuntimeIds } from "../mining/mainnet-sync.js";
export type { SatMainnetSyncStatus } from "../mining/mainnet-sync.js";
export {
  resolveAgentConfig,
  resolveAgentDir,
  resolveAgentEffectiveModelPrimary,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
export { DEFAULT_PROVIDER } from "../agents/defaults.js";
export { getApiKeyForModel, requireApiKey } from "../agents/model-auth.js";
export type { ResolvedProviderAuth } from "../agents/model-auth.js";
export {
  buildModelAliasIndex,
  resolveConfiguredModelRef,
  resolveDefaultModelForAgent,
  resolveModelRefFromString,
} from "../agents/model-selection.js";
export { resolveModel } from "../agents/pi-embedded-runner/model.js";
export { buildAttestation } from "../federation/attestation.js";
export {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
  verifyDeviceSignature,
} from "../infra/device-identity.js";
export { createSubsystemLogger } from "../logging/subsystem.js";
export { resolvePreferredFasedAgentTmpDir } from "../infra/tmp-fased-dir.js";
export { fetchSolanaWalletAssetsViaRpc } from "../wallet/solana-assets.js";
export {
  callLocalSocketSigner,
  probeLocalSocketSignerHealth,
  requireLocalSocketSignerPath,
} from "../wallet/providers/local-socket-signer-adapter.js";
export {
  readWalletProviderRegistry,
  resolveWalletUserRole,
  upsertNamedWallet,
} from "../wallet/wallet-provider-registry.js";
export type {
  WalletNamedWallet,
  WalletProviderRegistry,
  WalletUserRole,
} from "../wallet/wallet-provider-registry.js";
export {
  createWalletProviderAdapter,
  resolveWalletProviderId,
} from "../wallet/wallet-provider-resolver.js";
export {
  resolveLocalSignerSocketPath,
  resolveWalletRuntimeConfig,
} from "../wallet/wallet-runtime-config.js";
export { loadWalletProviderSecret } from "../wallet/wallet-secrets-store.js";
export {
  resolveWalletPolicyConfig,
  resolveWalletRolePolicyProfile,
} from "../wallet/wallet-policy.js";
export {
  createOrExecuteWalletSend,
  createSignerReviewApprovalRequest,
} from "../wallet/wallet-send-approvals.js";
export type { WalletProviderJupiterReviewV2 } from "../wallet/wallet-provider-adapter.js";
export { readWalletStatusSnapshot } from "../wallet/wallet-status.js";

export async function fetchWithSsrFGuard(
  params: Parameters<typeof import("../infra/net/fetch-guard.js").fetchWithSsrFGuard>[0],
): ReturnType<typeof import("../infra/net/fetch-guard.js").fetchWithSsrFGuard> {
  const fetchGuard = await import("../infra/net/fetch-guard.js");
  return fetchGuard.fetchWithSsrFGuard(params);
}
