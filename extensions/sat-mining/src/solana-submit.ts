import { createRequire } from "node:module";
import type { FasedAgentConfig } from "../../../src/config/config.js";
import { loadConfig } from "../../../src/config/config.js";
import {
  resolveSatBondProgramIdFromEnv,
  resolveSatMintAddressFromEnv,
  resolveSatMintProgramIdFromEnv,
  resolveSatProgramIdFromEnv,
} from "../../../src/config/sat-runtime-ids.js";
import {
  callLocalSocketSigner,
  requireLocalSocketSignerPath,
} from "../../../src/wallet/providers/local-socket-signer-adapter.js";
import { enforceWalletCustodyForAutonomousSend } from "../../../src/wallet/wallet-custody.js";
import { readWalletProviderRegistry } from "../../../src/wallet/wallet-provider-registry.js";
import { resolveWalletProviderId } from "../../../src/wallet/wallet-provider-resolver.js";
import { resolveWalletRuntimeConfig } from "../../../src/wallet/wallet-runtime-config.js";
import type { SatMiningConfig } from "./config.js";
import { decodeHash32 } from "./hash-spec.js";
import { inspectSatCycleRegistryMeta, inspectSatMinerCyclesByAddress } from "./rpc-read.js";

const require = createRequire(import.meta.url);

const SAT_PROGRAM_ID = () => resolveSatProgramIdFromEnv(process.env);
const SAT_MINT_PROGRAM_ID = () => resolveSatMintProgramIdFromEnv(process.env);
const SAT_MINT_ADDRESS = () => resolveSatMintAddressFromEnv(process.env);
const SAT_ROUND_BUCKET_SEED = "sat_round_bucket";
const SAT_EPOCH_SEED = "sat_epoch";
const SAT_WALLET_EPOCH_SEED = "sat_wallet_epoch";
const SAT_ROUND_COMMIT_SEED = "sat_round_commit";
const SAT_ROUND_STATE_SEED = "sat_round_state";
const SAT_VALIDATOR_ATTESTATION_SEED = "sat_validator_attestation";
const SAT_DISPUTE_SEED = "sat_dispute";
const SAT_GLOBAL_STATE_SEED = "sat_global_state";
const SAT_CYCLE_STATE_SEED = "sat_cycle_state";
const SAT_CYCLE_REGISTRY_META_SEED = "sat_cycle_registry_meta";
const SAT_CYCLE_REGISTRY_PAGE_SEED = "sat_cycle_registry_page";
const SAT_MINER_CYCLE_STATE_SEED = "sat_miner_cycle_state";
const SAT_MINER_CAPITAL_STATE_SEED = "sat_miner_capital_state";
const SAT_BOND_POSITION_SEED = "sat_bond_position";
const SAT_BOND_TIER_POLICY_SEED = "sat_bond_tier_policy";
const SAT_BOND_STAKING_DISTRIBUTOR_SEED = "sat_bond_staking_distributor";
const SAT_BOND_STAKING_POSITION_SEED = "sat_bond_staking_position";
const SAT_TREASURY_STATE_SEED = "sat_treasury_state";
const SAT_REGISTRY_RESERVE_SEED = "sat_registry_reserve";
const SAT_REBATE_VAULT_SEED = "sat_rebate_vault";
const SAT_TREASURY_VAULT_SEED = "sat_treasury_vault";
const SAT_CYCLE_REGISTRY_PAGE_CAPACITY = 64;
const MINING_POOL_SEED = "mining_pool";
const MINING_STAKE_SEED = "mining_stake";
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

const IX = {
  bootstrap: 34,
  initializeCycle: 38,
  finalizeEpoch: 43,
  openRound: 44,
  submitValidatorAttestation: 45,
  openDispute: 46,
  claim: 47,
  resolveDispute: 48,
  republishEpochRoots: 49,
  submitParticipation: 52,
  initMinerCapital: 36,
  depositMinerCapital: 37,
  openCycle: 56,
  submitCycle: 57,
  claimCycleRewards: 59,
  retargetUnlock: 60,
  claimCycleRewardsBatch: 62,
  settleCyclePage: 63,
  finalizeCycleSettlement: 64,
  scoreCyclePage: 65,
  distributeCyclePage: 66,
  withdrawMinerCapital: 67,
  setActiveCommit: 68,
  closeResolvedMinerCycleState: 69,
  closeResolvedCycleRegistryPage: 70,
  closeResolvedCycleArtifacts: 71,
  compactPendingCycleRange: 75,
  setProtocolRecipients: 76,
  claimProtocolTreasury: 77,
  claimProtocolDistributorSat: 85,
  refillRegistryReserveFromTreasury: 88,
  openBondPosition: 79,
  increaseBondPosition: 80,
  requestBondUnlock: 81,
  cancelBondUnlock: 82,
  finalizeBondUnlock: 83,
  miningCrank: 33,
} as const;

const BOND_IX = {
  initTierPolicy: 0,
  updateTierPolicy: 1,
  openBondPosition: 2,
  increaseBondPosition: 3,
  requestBondUnlock: 4,
  cancelBondUnlock: 5,
  finalizeBondUnlock: 6,
  initStakingDistributor: 7,
  syncStakingRewards: 8,
  syncStakingPosition: 9,
  claimStakingRewards: 10,
} as const;

function satSubmitDebug(message: string) {
  if (String(process.env.FASED_SAT_SUBMIT_DEBUG ?? "").trim() === "1") {
    console.error(message);
  }
}

type SolanaModuleLike = typeof import("@solana/web3.js");

type SolanaAccountMeta = {
  pubkey: import("@solana/web3.js").PublicKey;
  isSigner: boolean;
  isWritable: boolean;
};

let solanaModulePromise: Promise<SolanaModuleLike> | null = null;

async function loadSolanaWeb3(): Promise<SolanaModuleLike> {
  solanaModulePromise ??= (async () => require("@solana/web3.js") as SolanaModuleLike)();
  return solanaModulePromise;
}

function loadConfigForSatRuntime(activeConfig?: SatMiningConfig): FasedAgentConfig {
  const cfg = loadConfig();
  if (!activeConfig) {
    return cfg;
  }
  const maybeFullConfig = activeConfig as unknown as { plugins?: unknown };
  if (
    maybeFullConfig.plugins &&
    typeof maybeFullConfig.plugins === "object" &&
    !Array.isArray(maybeFullConfig.plugins) &&
    "entries" in maybeFullConfig.plugins
  ) {
    return activeConfig as unknown as FasedAgentConfig;
  }
  return {
    ...cfg,
    plugins: {
      ...(cfg.plugins ?? {}),
      entries: {
        ...(cfg.plugins?.entries ?? {}),
        "sat-mining": {
          ...(cfg.plugins?.entries?.["sat-mining"] ?? {}),
          config: {
            ...(cfg.plugins?.entries?.["sat-mining"]?.config ?? {}),
            ...activeConfig,
          },
        },
      },
    },
  };
}

function resolveSatWalletId(cfg: FasedAgentConfig): string | undefined {
  const value = cfg.plugins?.entries?.["sat-mining"]?.config?.walletId;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function resolveSatEffectiveEnv(cfg: FasedAgentConfig, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    ...(cfg.env?.vars ?? {}),
  } as NodeJS.ProcessEnv;
}

function resolveSatProviderId(cfg: FasedAgentConfig, env: NodeJS.ProcessEnv): string {
  const effectiveEnv = resolveSatEffectiveEnv(cfg, env);
  const walletId = resolveSatWalletId(cfg);
  if (walletId) {
    const hasSelfHostedSignerMaterial =
      String(effectiveEnv.FASED_WALLET_LOCAL_SIGNER_SOCKET ?? "").trim() ||
      String(effectiveEnv.FASED_WALLET_LOCAL_SIGNER_BACKEND_SOCKET ?? "").trim() ||
      String(
        walletEnvValue(effectiveEnv, "FASED_WALLET_SOLANA_KEYSTORE_PATH", walletId) ?? "",
      ).trim();
    try {
      const wallet = readWalletProviderRegistry(effectiveEnv).wallets.find(
        (entry) => entry.id === walletId,
      );
      if (wallet?.providerId === "local-socket-signer") {
        return wallet.providerId;
      }
      if (hasSelfHostedSignerMaterial) {
        return "local-socket-signer";
      }
      if (wallet?.providerId) {
        return wallet.providerId;
      }
    } catch {}
    if (hasSelfHostedSignerMaterial) {
      return "local-socket-signer";
    }
  }
  return resolveWalletProviderId(cfg, effectiveEnv);
}

async function enforceSatCustodyAutonomousSigning(
  cfg: FasedAgentConfig,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const effectiveEnv = resolveSatEffectiveEnv(cfg, env);
  const walletCfg = resolveWalletRuntimeConfig(cfg, effectiveEnv);
  const walletId = resolveSatWalletId(cfg);
  if (walletCfg.execution.mode !== "autonomous") {
    return;
  }
  const custodyGate = await enforceWalletCustodyForAutonomousSend({
    wallet: walletCfg,
    env: effectiveEnv,
    cfg,
    walletId,
    approvalHost: String(
      effectiveEnv.FASED_WALLET_CUSTODY_ACTIVE_HOST ?? effectiveEnv.FASED_A2A_ORIGIN ?? "127.0.0.1",
    ),
  });
  if (!custodyGate.ok) {
    throw new Error(custodyGate.message);
  }
}

function resolveSatRegistrySolanaAddress(cfg: FasedAgentConfig, env: NodeJS.ProcessEnv): string {
  const effectiveEnv = resolveSatEffectiveEnv(cfg, env);
  const walletId = resolveSatWalletId(cfg);
  if (!walletId) {
    return "";
  }
  const wallet = readWalletProviderRegistry(effectiveEnv).wallets.find(
    (entry) => entry.id === walletId,
  );
  return typeof wallet?.addresses?.solana === "string" ? wallet.addresses.solana.trim() : "";
}

async function resolveSatLocalSignerAddress(
  cfg: FasedAgentConfig,
  env: NodeJS.ProcessEnv,
  errorMessage: string,
): Promise<string> {
  const effectiveEnv = resolveSatEffectiveEnv(cfg, env);
  const walletId = resolveSatWalletId(cfg);
  const result = await callLocalSocketSigner<{ solana?: string }>(
    requireLocalSocketSignerPath(effectiveEnv),
    {
      op: "getAddresses",
      ...(walletId ? { walletId } : {}),
    },
  );
  const signer = String(result.solana ?? "").trim();
  if (signer) {
    return signer;
  }
  const fallback = resolveSatRegistrySolanaAddress(cfg, env);
  if (fallback) {
    return fallback;
  }
  throw new Error(errorMessage);
}

function encodeU64(value: number): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(BigInt(value));
  return out;
}

function encodeI64(value: number): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigInt64LE(BigInt(value));
  return out;
}

function encodePubkey(value: string): Buffer {
  const solana = require("@solana/web3.js") as SolanaModuleLike;
  return new solana.PublicKey(value).toBuffer();
}

function deriveAssociatedTokenAddress(
  solana: SolanaModuleLike,
  owner: import("@solana/web3.js").PublicKey,
  mint: import("@solana/web3.js").PublicKey,
) {
  return solana.PublicKey.findProgramAddressSync(
    [owner.toBuffer(), new solana.PublicKey(TOKEN_PROGRAM_ID).toBuffer(), mint.toBuffer()],
    new solana.PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
  )[0];
}

function walletIdEnvSuffix(walletId?: string): string | undefined {
  const normalized = String(walletId ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || undefined;
}

function walletEnvValue(env: NodeJS.ProcessEnv, baseKey: string, walletId?: string): string {
  const suffix = walletIdEnvSuffix(walletId);
  if (suffix) {
    const scoped = String(env[`${baseKey}__${suffix.toUpperCase()}`] ?? "").trim();
    if (scoped) {
      return scoped;
    }
  }
  return String(env[baseKey] ?? "").trim();
}

function hasDedicatedBondProgram(env: NodeJS.ProcessEnv): boolean {
  return resolveSatBondProgramIdFromEnv(env).trim().length > 0;
}

function assertDedicatedBondProgram(env: NodeJS.ProcessEnv): void {
  if (!hasDedicatedBondProgram(env)) {
    throw new Error("legacy monolithic SAT bond mode is disabled; set FASED_SAT_BOND_PROGRAM_ID");
  }
}

export async function resolveSatValidatorAuthority(_config: SatMiningConfig) {
  const cfg = loadConfigForSatRuntime(_config);
  const effectiveEnv = resolveSatEffectiveEnv(cfg, process.env);
  await enforceSatCustodyAutonomousSigning(cfg, effectiveEnv);
  if (resolveSatProviderId(cfg, effectiveEnv) !== "local-socket-signer") {
    throw new Error(
      "SAT mining unattended signing currently requires local-socket-signer for validator authority resolution",
    );
  }
  return await resolveSatLocalSignerAddress(
    cfg,
    effectiveEnv,
    "local-socket-signer returned no Solana address",
  );
}

type SatInstructionSubmitSpec = {
  data: Buffer;
  programId?: string;
  accountResolver: (
    solana: SolanaModuleLike,
    signer: import("@solana/web3.js").PublicKey,
  ) => Promise<SolanaAccountMeta[]>;
};

async function prepareLocalSignerSubmitContext(cfg: FasedAgentConfig, env: NodeJS.ProcessEnv) {
  const effectiveEnv = resolveSatEffectiveEnv(cfg, env);
  const solana = await loadSolanaWeb3();
  const walletId = resolveSatWalletId(cfg);
  const socketPath = requireLocalSocketSignerPath(effectiveEnv);
  const signerAddress = await resolveSatLocalSignerAddress(
    cfg,
    effectiveEnv,
    "local-socket-signer returned no Solana address for SAT mining wallet",
  );
  const signer = new solana.PublicKey(signerAddress);
  return { effectiveEnv, solana, walletId, socketPath, signerAddress, signer };
}

async function buildLocalSignerInstructionRequest(params: {
  solana: SolanaModuleLike;
  signer: import("@solana/web3.js").PublicKey;
  walletId?: string;
  spec: SatInstructionSubmitSpec;
}) {
  const keys = await params.spec.accountResolver(params.solana, params.signer);
  satSubmitDebug(
    `[sat-submit-debug] data_len=${params.spec.data.length} disc=${params.spec.data[0] ?? -1} keys=${keys.length}`,
  );
  return {
    ...(params.walletId ? { walletId: params.walletId } : {}),
    programId: params.spec.programId ?? SAT_PROGRAM_ID(),
    dataBase64: params.spec.data.toString("base64"),
    keys: keys.map((key) => ({
      pubkey: key.pubkey.toBase58(),
      isSigner: key.isSigner,
      isWritable: key.isWritable,
    })),
  };
}

async function submitInstructionViaLocalSigner(
  params: {
    cfg: FasedAgentConfig;
    env: NodeJS.ProcessEnv;
  } & SatInstructionSubmitSpec,
) {
  const context = await prepareLocalSignerSubmitContext(params.cfg, params.env);
  const request = await buildLocalSignerInstructionRequest({
    solana: context.solana,
    signer: context.signer,
    walletId: context.walletId,
    spec: params,
  });
  const submitted = await callLocalSocketSigner<{ txHash: string; signer?: string }>(
    context.socketPath,
    {
      op: "sendSolanaInstruction",
      request,
    },
  );
  return {
    txHash: submitted.txHash,
    signer: submitted.signer ?? context.signerAddress,
  };
}

async function submitInstruction(params: {
  cfg: FasedAgentConfig;
  env: NodeJS.ProcessEnv;
  data: Buffer;
  programId?: string;
  accountResolver: (
    solana: SolanaModuleLike,
    signer: import("@solana/web3.js").PublicKey,
  ) => Promise<import("@solana/web3.js").AccountMeta[]>;
}) {
  const effectiveEnv = resolveSatEffectiveEnv(params.cfg, params.env);
  await enforceSatCustodyAutonomousSigning(params.cfg, effectiveEnv);
  if (resolveSatProviderId(params.cfg, effectiveEnv) !== "local-socket-signer") {
    throw new Error("SAT mining unattended submission currently requires local-socket-signer");
  }
  return await submitInstructionViaLocalSigner({
    cfg: params.cfg,
    env: effectiveEnv,
    data: params.data,
    programId: params.programId,
    accountResolver: params.accountResolver,
  });
}

async function submitInstructionBatch(params: {
  cfg: FasedAgentConfig;
  env: NodeJS.ProcessEnv;
  purpose: "sat-cleanup";
  instructions: SatInstructionSubmitSpec[];
}) {
  if (params.instructions.length === 0) {
    throw new Error("SAT cleanup batch has no instructions");
  }
  if (params.instructions.length > 6) {
    throw new Error("SAT cleanup batch exceeds signer limit");
  }
  const effectiveEnv = resolveSatEffectiveEnv(params.cfg, params.env);
  await enforceSatCustodyAutonomousSigning(params.cfg, effectiveEnv);
  if (resolveSatProviderId(params.cfg, effectiveEnv) !== "local-socket-signer") {
    throw new Error(
      "SAT mining unattended batch submission currently requires local-socket-signer",
    );
  }
  const context = await prepareLocalSignerSubmitContext(params.cfg, effectiveEnv);
  const instructions: Array<Awaited<ReturnType<typeof buildLocalSignerInstructionRequest>>> = [];
  for (const spec of params.instructions) {
    instructions.push(
      await buildLocalSignerInstructionRequest({
        solana: context.solana,
        signer: context.signer,
        walletId: context.walletId,
        spec,
      }),
    );
  }
  const submitted = await callLocalSocketSigner<{
    txHash: string;
    signer?: string;
    metadata?: Record<string, unknown>;
  }>(context.socketPath, {
    op: "sendSolanaInstructions",
    request: {
      ...(context.walletId ? { walletId: context.walletId } : {}),
      purpose: params.purpose,
      instructions,
    },
  });
  return {
    txHash: submitted.txHash,
    signer: submitted.signer ?? context.signerAddress,
    instructionCount: instructions.length,
  };
}

function buildInitializeCycleData(params: {
  epochId: number;
  microRoundId: number;
  bucketVersion: number;
  roundOpenTs: number;
  roundCloseTs: number;
  roundSeed: string;
  bucketHash: string;
}) {
  return Buffer.concat([
    Buffer.from([IX.initializeCycle]),
    encodeU64(params.epochId),
    encodeU64(params.microRoundId),
    encodeU64(params.bucketVersion),
    encodeI64(params.roundOpenTs),
    encodeI64(params.roundCloseTs),
    decodeHash32(params.roundSeed),
    decodeHash32(params.bucketHash),
  ]);
}

function buildOpenRoundData(params: Parameters<typeof buildInitializeCycleData>[0]) {
  return Buffer.concat([Buffer.from([IX.openRound]), buildInitializeCycleData(params).subarray(1)]);
}

function buildParticipationData(params: {
  epochId: number;
  microRoundId: number;
  bucketHash: string;
  allocationSum: number;
  allocationFp: number[];
  coordinationGroupHash: string;
  coordinationMessageRoot: string;
  coordinationPeerCount: number;
  coordinationIntent: number;
}) {
  if (params.allocationFp.length !== 25) {
    throw new Error(`expected 25 allocation buckets, got ${params.allocationFp.length}`);
  }
  return Buffer.concat([
    Buffer.from([IX.submitParticipation]),
    encodeU64(params.epochId),
    encodeU64(params.microRoundId),
    decodeHash32(params.bucketHash),
    encodeU64(params.allocationSum),
    Buffer.concat(
      params.allocationFp.map((value) => {
        const out = Buffer.alloc(4);
        out.writeUInt32LE(value);
        return out;
      }),
    ),
    decodeHash32(params.coordinationGroupHash),
    decodeHash32(params.coordinationMessageRoot),
    encodeU64(params.coordinationPeerCount),
    encodeU64(params.coordinationIntent),
  ]);
}

function buildFinalizeEpochData(params: {
  epochId: number;
  bucketRoot: string;
  scoreRoot: string;
}) {
  return Buffer.concat([
    Buffer.from([IX.finalizeEpoch]),
    encodeU64(params.epochId),
    decodeHash32(params.bucketRoot),
    decodeHash32(params.scoreRoot),
  ]);
}

function buildSubmitValidatorAttestationData(params: {
  epochId: number;
  microRoundId: number;
  decisionFlag: number;
  reasonCode: number;
  bucketRoot: string;
  scoreRoot: string;
  coordinationRoot: string;
  evidenceHash: string;
}) {
  const reasonCode = Buffer.alloc(2);
  reasonCode.writeUInt16LE(params.reasonCode);
  return Buffer.concat([
    Buffer.from([IX.submitValidatorAttestation]),
    encodeU64(params.epochId),
    encodeU64(params.microRoundId),
    encodeU64(params.decisionFlag),
    reasonCode,
    Buffer.alloc(6),
    decodeHash32(params.bucketRoot),
    decodeHash32(params.scoreRoot),
    decodeHash32(params.coordinationRoot),
    decodeHash32(params.evidenceHash),
  ]);
}

function buildOpenDisputeData(params: {
  epochId: number;
  microRoundId: number;
  reasonCode: number;
  evidenceHash: string;
  targetRoot: string;
}) {
  const reasonCode = Buffer.alloc(2);
  reasonCode.writeUInt16LE(params.reasonCode);
  return Buffer.concat([
    Buffer.from([IX.openDispute]),
    encodeU64(params.epochId),
    encodeU64(params.microRoundId),
    reasonCode,
    Buffer.alloc(6),
    decodeHash32(params.evidenceHash),
    decodeHash32(params.targetRoot),
  ]);
}

function buildClaimData(params: {
  epochId: number;
  microRoundId?: number;
  targetAuthority?: string;
}) {
  return Buffer.concat([
    Buffer.from([IX.claim]),
    encodeU64(params.epochId),
    encodeU64(params.microRoundId ?? 0),
    params.targetAuthority ? encodePubkey(params.targetAuthority) : Buffer.alloc(32),
  ]);
}

function buildMiningCrankData() {
  return Buffer.from([IX.miningCrank]);
}

function buildBootstrapData(params: { authority: string; initialStake: number }) {
  return Buffer.concat([
    Buffer.from([IX.bootstrap]),
    encodePubkey(params.authority),
    encodeU64(params.initialStake),
  ]);
}

function buildOpenCycleData(params: { cycleId: number }) {
  return Buffer.concat([Buffer.from([IX.openCycle]), encodeU64(params.cycleId)]);
}

function buildInitMinerCapitalData(params: { authority: string }) {
  return Buffer.concat([Buffer.from([IX.initMinerCapital]), encodePubkey(params.authority)]);
}

function buildDepositMinerCapitalData(params: { lamports: number }) {
  return Buffer.concat([Buffer.from([IX.depositMinerCapital]), encodeU64(params.lamports)]);
}

function buildWithdrawMinerCapitalData(params: { lamports: number }) {
  return Buffer.concat([Buffer.from([IX.withdrawMinerCapital]), encodeU64(params.lamports)]);
}

function buildSetActiveCommitData(params: { lamports: number }) {
  return Buffer.concat([Buffer.from([IX.setActiveCommit]), encodeU64(params.lamports)]);
}

function buildInitBondTierPolicyData(params: {
  updateAuthority: string;
  basicMinRaw: number;
  operatorMinRaw: number;
  unlockDelaySlots: number;
  scheduledEffectiveSlot?: number;
}) {
  return Buffer.concat([
    Buffer.from([BOND_IX.initTierPolicy]),
    encodePubkey(params.updateAuthority),
    encodeU64(params.basicMinRaw),
    encodeU64(params.operatorMinRaw),
    encodeU64(params.unlockDelaySlots),
    encodeU64(params.scheduledEffectiveSlot ?? 0),
  ]);
}

function buildUpdateBondTierPolicyData(params: {
  updateAuthority: string;
  basicMinRaw: number;
  operatorMinRaw: number;
  unlockDelaySlots: number;
  scheduledEffectiveSlot?: number;
}) {
  return Buffer.concat([
    Buffer.from([BOND_IX.updateTierPolicy]),
    encodePubkey(params.updateAuthority),
    encodeU64(params.basicMinRaw),
    encodeU64(params.operatorMinRaw),
    encodeU64(params.unlockDelaySlots),
    encodeU64(params.scheduledEffectiveSlot ?? 0),
  ]);
}

function buildOpenBondPositionData(
  params: { amountRaw: number },
  env: NodeJS.ProcessEnv = process.env,
) {
  assertDedicatedBondProgram(env);
  return Buffer.concat([Buffer.from([BOND_IX.openBondPosition]), encodeU64(params.amountRaw)]);
}

function buildIncreaseBondPositionData(
  params: { amountRaw: number },
  env: NodeJS.ProcessEnv = process.env,
) {
  assertDedicatedBondProgram(env);
  return Buffer.concat([Buffer.from([BOND_IX.increaseBondPosition]), encodeU64(params.amountRaw)]);
}

function buildRequestBondUnlockData(env: NodeJS.ProcessEnv = process.env) {
  assertDedicatedBondProgram(env);
  return Buffer.from([BOND_IX.requestBondUnlock]);
}

function buildCancelBondUnlockData(env: NodeJS.ProcessEnv = process.env) {
  assertDedicatedBondProgram(env);
  return Buffer.from([BOND_IX.cancelBondUnlock]);
}

function buildFinalizeBondUnlockData(env: NodeJS.ProcessEnv = process.env) {
  assertDedicatedBondProgram(env);
  return Buffer.from([BOND_IX.finalizeBondUnlock]);
}

function buildInitBondStakingDistributorData(
  params: { updateAuthority: string; minStakeRaw: number },
  env: NodeJS.ProcessEnv = process.env,
) {
  assertDedicatedBondProgram(env);
  return Buffer.concat([
    Buffer.from([BOND_IX.initStakingDistributor]),
    encodePubkey(params.updateAuthority),
    encodeU64(params.minStakeRaw),
  ]);
}

function buildSyncBondStakingRewardsData(env: NodeJS.ProcessEnv = process.env) {
  assertDedicatedBondProgram(env);
  return Buffer.from([BOND_IX.syncStakingRewards]);
}

function buildSyncBondStakingPositionData(env: NodeJS.ProcessEnv = process.env) {
  assertDedicatedBondProgram(env);
  return Buffer.from([BOND_IX.syncStakingPosition]);
}

function buildClaimBondStakingRewardsData(env: NodeJS.ProcessEnv = process.env) {
  assertDedicatedBondProgram(env);
  return Buffer.from([BOND_IX.claimStakingRewards]);
}

function buildSubmitCycleData(params: { cycleId: number; allocationFp: number[] }) {
  if (params.allocationFp.length !== 25) {
    throw new Error(`expected 25 allocation buckets, got ${params.allocationFp.length}`);
  }
  const body = Buffer.concat([
    Buffer.from([IX.submitCycle]),
    encodeU64(params.cycleId),
    Buffer.concat(
      params.allocationFp.map((value) => {
        const out = Buffer.alloc(4);
        out.writeUInt32LE(value);
        return out;
      }),
    ),
    Buffer.alloc(4),
  ]);
  satSubmitDebug(
    `[sat-submit-build] allocs=${params.allocationFp.length} len=${body.length} cycle=${params.cycleId}`,
  );
  return body;
}

function buildClaimCycleRewardsData(params: { cycleId: number }) {
  return Buffer.concat([Buffer.from([IX.claimCycleRewards]), encodeU64(params.cycleId)]);
}

function buildRetargetUnlockData(params: { cycleId: number }) {
  return Buffer.concat([Buffer.from([IX.retargetUnlock]), encodeU64(params.cycleId)]);
}

function buildClaimCycleRewardsBatchData(params: { cycleIds: number[] }) {
  const header = Buffer.alloc(8);
  header.writeUInt8(params.cycleIds.length, 0);
  return Buffer.concat([
    Buffer.from([IX.claimCycleRewardsBatch]),
    header,
    ...params.cycleIds.map((cycleId) => encodeU64(cycleId)),
  ]);
}

function buildSetProtocolRecipientsData(params: {
  treasuryRecipient: string;
  distributorRecipient: string;
}) {
  return Buffer.concat([
    Buffer.from([IX.setProtocolRecipients]),
    encodePubkey(params.treasuryRecipient),
    encodePubkey(params.distributorRecipient),
  ]);
}

function buildClaimProtocolTreasuryData() {
  return Buffer.from([IX.claimProtocolTreasury]);
}

function buildRefillRegistryReserveFromTreasuryData(params: { targetBalanceLamports: number }) {
  return Buffer.concat([
    Buffer.from([IX.refillRegistryReserveFromTreasury]),
    encodeU64(params.targetBalanceLamports),
  ]);
}

function buildClaimProtocolDistributorSatData() {
  return Buffer.from([IX.claimProtocolDistributorSat]);
}

function buildSettleCyclePageData(params: {
  cycleId: number;
  pageIndex: number;
  chunkIndex: number;
}) {
  return Buffer.concat([
    Buffer.from([IX.settleCyclePage]),
    encodeU64(params.cycleId),
    encodeU64(params.pageIndex),
    encodeU64(params.chunkIndex),
  ]);
}

function buildFinalizeCycleSettlementData(params: { cycleId: number }) {
  return Buffer.concat([Buffer.from([IX.finalizeCycleSettlement]), encodeU64(params.cycleId)]);
}

function buildScoreCyclePageData(params: {
  cycleId: number;
  pageIndex: number;
  chunkIndex: number;
}) {
  return Buffer.concat([
    Buffer.from([IX.scoreCyclePage]),
    encodeU64(params.cycleId),
    encodeU64(params.pageIndex),
    encodeU64(params.chunkIndex),
  ]);
}

function buildDistributeCyclePageData(params: {
  cycleId: number;
  pageIndex: number;
  chunkIndex: number;
}) {
  return Buffer.concat([
    Buffer.from([IX.distributeCyclePage]),
    encodeU64(params.cycleId),
    encodeU64(params.pageIndex),
    encodeU64(params.chunkIndex),
  ]);
}

function buildCloseResolvedMinerCycleStateData(params: { cycleId: number }) {
  return Buffer.concat([Buffer.from([IX.closeResolvedMinerCycleState]), encodeU64(params.cycleId)]);
}

function buildCloseResolvedCycleRegistryPageData(params: { cycleId: number; pageIndex: number }) {
  return Buffer.concat([
    Buffer.from([IX.closeResolvedCycleRegistryPage]),
    encodeU64(params.cycleId),
    encodeU64(params.pageIndex),
  ]);
}

function buildCloseResolvedCycleArtifactsData(params: { cycleId: number }) {
  return Buffer.concat([Buffer.from([IX.closeResolvedCycleArtifacts]), encodeU64(params.cycleId)]);
}

function buildCompactPendingCycleRangeData(params: {
  expectedFirstPendingCycleId: number;
  expectedLastPendingCycleId: number;
  frontCycleIds: number[];
  backCycleIds: number[];
}) {
  return Buffer.concat([
    Buffer.from([IX.compactPendingCycleRange]),
    encodeU64(params.expectedFirstPendingCycleId),
    encodeU64(params.expectedLastPendingCycleId),
    Buffer.from([params.frontCycleIds.length & 0xff, params.backCycleIds.length & 0xff]),
    Buffer.alloc(6),
  ]);
}

async function resolveSatCycleRegistryPageIndex(config: SatMiningConfig, cycleId: number) {
  const registryMeta = await inspectSatCycleRegistryMeta(config, { cycleId }).catch(() => null);
  return Math.floor((registryMeta?.participantCount ?? 0) / SAT_CYCLE_REGISTRY_PAGE_CAPACITY);
}

function buildResolveDisputeData(params: {
  epochId: number;
  microRoundId: number;
  statusFlag: number;
  targetAuthority: string;
}) {
  return Buffer.concat([
    Buffer.from([IX.resolveDispute]),
    encodeU64(params.epochId),
    encodeU64(params.microRoundId),
    encodeU64(params.statusFlag),
    encodePubkey(params.targetAuthority),
  ]);
}

function buildRepublishEpochRootsData(params: {
  epochId: number;
  bucketRoot: string;
  scoreRoot: string;
  coordinationRoot: string;
}) {
  return Buffer.concat([
    Buffer.from([IX.republishEpochRoots]),
    encodeU64(params.epochId),
    decodeHash32(params.bucketRoot),
    decodeHash32(params.scoreRoot),
    decodeHash32(params.coordinationRoot),
  ]);
}

export async function submitSatInitializeCycle(
  _config: SatMiningConfig,
  params: Parameters<typeof buildInitializeCycleData>[0],
) {
  const cfg = loadConfigForSatRuntime(_config);
  return submitInstruction({
    cfg,
    env: process.env,
    data: buildInitializeCycleData(params),
    accountResolver: async (solana, signer) => {
      const programId = new solana.PublicKey(SAT_PROGRAM_ID());
      const [satCycle] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_ROUND_BUCKET_SEED)],
        programId,
      );
      const [satEpoch] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_EPOCH_SEED), encodeU64(params.epochId)],
        programId,
      );
      return [
        { pubkey: signer, isSigner: true, isWritable: true },
        { pubkey: satCycle, isSigner: false, isWritable: true },
        { pubkey: satEpoch, isSigner: false, isWritable: true },
        { pubkey: solana.SystemProgram.programId, isSigner: false, isWritable: false },
      ];
    },
  });
}

export async function submitSatValidatorAttestation(
  _config: SatMiningConfig,
  params: Parameters<typeof buildSubmitValidatorAttestationData>[0] & { targetAuthority?: string },
) {
  const cfg = loadConfigForSatRuntime(_config);
  return submitInstruction({
    cfg,
    env: process.env,
    data: buildSubmitValidatorAttestationData(params),
    accountResolver: async (solana, signer) => {
      const programId = new solana.PublicKey(SAT_PROGRAM_ID());
      const targetAuthority = params.targetAuthority?.trim()
        ? new solana.PublicKey(params.targetAuthority)
        : signer;
      const [satEpoch] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_EPOCH_SEED), encodeU64(params.epochId)],
        programId,
      );
      const [satValidatorAttestation] = solana.PublicKey.findProgramAddressSync(
        [
          Buffer.from(SAT_VALIDATOR_ATTESTATION_SEED),
          signer.toBuffer(),
          targetAuthority.toBuffer(),
          encodeU64(params.epochId),
          encodeU64(params.microRoundId),
        ],
        programId,
      );
      const [miningStake] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(MINING_STAKE_SEED), targetAuthority.toBuffer()],
        programId,
      );
      return [
        { pubkey: signer, isSigner: true, isWritable: true },
        { pubkey: satEpoch, isSigner: false, isWritable: true },
        { pubkey: satValidatorAttestation, isSigner: false, isWritable: true },
        { pubkey: miningStake, isSigner: false, isWritable: true },
        { pubkey: solana.SystemProgram.programId, isSigner: false, isWritable: false },
      ];
    },
  });
}

export async function submitSatOpenDispute(
  _config: SatMiningConfig,
  params: Parameters<typeof buildOpenDisputeData>[0] & { targetAuthority?: string },
) {
  const cfg = loadConfigForSatRuntime(_config);
  return submitInstruction({
    cfg,
    env: process.env,
    data: buildOpenDisputeData(params),
    accountResolver: async (solana, signer) => {
      const programId = new solana.PublicKey(SAT_PROGRAM_ID());
      const targetAuthority = params.targetAuthority?.trim()
        ? new solana.PublicKey(params.targetAuthority)
        : signer;
      const [satEpoch] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_EPOCH_SEED), encodeU64(params.epochId)],
        programId,
      );
      const [satDispute] = solana.PublicKey.findProgramAddressSync(
        [
          Buffer.from(SAT_DISPUTE_SEED),
          signer.toBuffer(),
          targetAuthority.toBuffer(),
          encodeU64(params.epochId),
          encodeU64(params.microRoundId),
        ],
        programId,
      );
      const [miningStake] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(MINING_STAKE_SEED), targetAuthority.toBuffer()],
        programId,
      );
      return [
        { pubkey: signer, isSigner: true, isWritable: true },
        { pubkey: satEpoch, isSigner: false, isWritable: true },
        { pubkey: satDispute, isSigner: false, isWritable: true },
        { pubkey: miningStake, isSigner: false, isWritable: true },
        { pubkey: solana.SystemProgram.programId, isSigner: false, isWritable: false },
      ];
    },
  });
}

export async function submitSatResolveDispute(
  _config: SatMiningConfig,
  params: Parameters<typeof buildResolveDisputeData>[0] & { disputeAuthority: string },
) {
  const cfg = loadConfigForSatRuntime(_config);
  return submitInstruction({
    cfg,
    env: process.env,
    data: buildResolveDisputeData(params),
    accountResolver: async (solana, signer) => {
      const programId = new solana.PublicKey(SAT_PROGRAM_ID());
      const disputeAuthority = new solana.PublicKey(params.disputeAuthority);
      const targetAuthority = new solana.PublicKey(params.targetAuthority);
      const [miningPool] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(MINING_POOL_SEED)],
        programId,
      );
      const [satEpoch] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_EPOCH_SEED), encodeU64(params.epochId)],
        programId,
      );
      const [satDispute] = solana.PublicKey.findProgramAddressSync(
        [
          Buffer.from(SAT_DISPUTE_SEED),
          disputeAuthority.toBuffer(),
          targetAuthority.toBuffer(),
          encodeU64(params.epochId),
          encodeU64(params.microRoundId),
        ],
        programId,
      );
      return [
        { pubkey: signer, isSigner: true, isWritable: true },
        { pubkey: miningPool, isSigner: false, isWritable: false },
        { pubkey: satEpoch, isSigner: false, isWritable: true },
        { pubkey: satDispute, isSigner: false, isWritable: true },
      ];
    },
  });
}

export async function submitSatRepublishEpochRoots(
  _config: SatMiningConfig,
  params: Parameters<typeof buildRepublishEpochRootsData>[0],
) {
  const cfg = loadConfigForSatRuntime(_config);
  return submitInstruction({
    cfg,
    env: process.env,
    data: buildRepublishEpochRootsData(params),
    accountResolver: async (solana, signer) => {
      const programId = new solana.PublicKey(SAT_PROGRAM_ID());
      const [miningPool] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(MINING_POOL_SEED)],
        programId,
      );
      const [satEpoch] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_EPOCH_SEED), encodeU64(params.epochId)],
        programId,
      );
      return [
        { pubkey: signer, isSigner: true, isWritable: true },
        { pubkey: miningPool, isSigner: false, isWritable: false },
        { pubkey: satEpoch, isSigner: false, isWritable: true },
      ];
    },
  });
}

export async function submitSatBootstrap(
  _config: SatMiningConfig,
  params: { authority?: string; initialStake?: number } = {},
) {
  const cfg = loadConfigForSatRuntime(_config);
  return submitInstruction({
    cfg,
    env: process.env,
    data: buildBootstrapData({
      authority: params.authority ?? "",
      initialStake: Math.max(0, Math.floor(params.initialStake ?? 0)),
    }),
    accountResolver: async (solana, signer) => {
      const programId = new solana.PublicKey(SAT_PROGRAM_ID());
      const [satGlobalState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_GLOBAL_STATE_SEED)],
        programId,
      );
      const [treasury] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from("treasury")],
        programId,
      );
      const [satTreasuryState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_TREASURY_STATE_SEED)],
        programId,
      );
      const [satRegistryReserve] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_REGISTRY_RESERVE_SEED)],
        programId,
      );
      const [satRebateVault] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_REBATE_VAULT_SEED)],
        programId,
      );
      const [satTreasuryVault] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_TREASURY_VAULT_SEED)],
        programId,
      );
      return [
        { pubkey: signer, isSigner: true, isWritable: true },
        { pubkey: satGlobalState, isSigner: false, isWritable: true },
        { pubkey: treasury, isSigner: false, isWritable: true },
        { pubkey: satTreasuryState, isSigner: false, isWritable: true },
        { pubkey: satRegistryReserve, isSigner: false, isWritable: true },
        { pubkey: solana.SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: satRebateVault, isSigner: false, isWritable: true },
        { pubkey: satTreasuryVault, isSigner: false, isWritable: true },
      ];
    },
  });
}

export async function submitSatOpenCycle(_config: SatMiningConfig, params: { cycleId: number }) {
  const cfg = loadConfigForSatRuntime(_config);
  return submitInstruction({
    cfg,
    env: process.env,
    data: buildOpenCycleData(params),
    accountResolver: async (solana, signer) => {
      const programId = new solana.PublicKey(SAT_PROGRAM_ID());
      const [satGlobalState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_GLOBAL_STATE_SEED)],
        programId,
      );
      const [satCycleState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_CYCLE_STATE_SEED), encodeU64(params.cycleId)],
        programId,
      );
      const [satCycleRegistryMeta] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_CYCLE_REGISTRY_META_SEED), encodeU64(params.cycleId)],
        programId,
      );
      const [satTreasuryState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_TREASURY_STATE_SEED)],
        programId,
      );
      const [satRegistryReserve] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_REGISTRY_RESERVE_SEED)],
        programId,
      );
      const [satTreasuryVault] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_TREASURY_VAULT_SEED)],
        programId,
      );
      return [
        { pubkey: signer, isSigner: true, isWritable: true },
        { pubkey: satGlobalState, isSigner: false, isWritable: true },
        { pubkey: satCycleState, isSigner: false, isWritable: true },
        { pubkey: satCycleRegistryMeta, isSigner: false, isWritable: true },
        { pubkey: satTreasuryState, isSigner: false, isWritable: true },
        { pubkey: satRegistryReserve, isSigner: false, isWritable: true },
        { pubkey: solana.SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: satTreasuryVault, isSigner: false, isWritable: true },
      ];
    },
  });
}

export async function submitSatInitMinerCapital(
  _config: SatMiningConfig,
  params: { authority?: string },
) {
  const cfg = loadConfigForSatRuntime(_config);
  return submitInstruction({
    cfg,
    env: process.env,
    data: buildInitMinerCapitalData({ authority: params.authority ?? "" }),
    accountResolver: async (solana, signer) => {
      const programId = new solana.PublicKey(SAT_PROGRAM_ID());
      const authority = params.authority?.trim() ? new solana.PublicKey(params.authority) : signer;
      const [satMinerCapitalState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_MINER_CAPITAL_STATE_SEED), authority.toBuffer()],
        programId,
      );
      return [
        { pubkey: signer, isSigner: true, isWritable: true },
        { pubkey: satMinerCapitalState, isSigner: false, isWritable: true },
        { pubkey: solana.SystemProgram.programId, isSigner: false, isWritable: false },
      ];
    },
  });
}

export async function submitSatDepositMinerCapital(
  _config: SatMiningConfig,
  params: { lamports: number },
) {
  const cfg = loadConfigForSatRuntime(_config);
  return submitInstruction({
    cfg,
    env: process.env,
    data: buildDepositMinerCapitalData(params),
    accountResolver: async (solana, signer) => {
      const programId = new solana.PublicKey(SAT_PROGRAM_ID());
      const [satMinerCapitalState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_MINER_CAPITAL_STATE_SEED), signer.toBuffer()],
        programId,
      );
      return [
        { pubkey: signer, isSigner: true, isWritable: true },
        { pubkey: satMinerCapitalState, isSigner: false, isWritable: true },
        { pubkey: solana.SystemProgram.programId, isSigner: false, isWritable: false },
      ];
    },
  });
}

export async function submitSatWithdrawMinerCapital(
  _config: SatMiningConfig,
  params: { lamports: number },
) {
  const cfg = loadConfigForSatRuntime(_config);
  return submitInstruction({
    cfg,
    env: process.env,
    data: buildWithdrawMinerCapitalData(params),
    accountResolver: async (solana, signer) => {
      const programId = new solana.PublicKey(SAT_PROGRAM_ID());
      const [satMinerCapitalState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_MINER_CAPITAL_STATE_SEED), signer.toBuffer()],
        programId,
      );
      return [
        { pubkey: signer, isSigner: true, isWritable: true },
        { pubkey: satMinerCapitalState, isSigner: false, isWritable: true },
        { pubkey: solana.SystemProgram.programId, isSigner: false, isWritable: false },
      ];
    },
  });
}

export async function submitSatSetActiveCommit(
  _config: SatMiningConfig,
  params: { lamports: number },
) {
  const cfg = loadConfigForSatRuntime(_config);
  return submitInstruction({
    cfg,
    env: process.env,
    data: buildSetActiveCommitData(params),
    accountResolver: async (solana, signer) => {
      const programId = new solana.PublicKey(SAT_PROGRAM_ID());
      const [satMinerCapitalState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_MINER_CAPITAL_STATE_SEED), signer.toBuffer()],
        programId,
      );
      return [
        { pubkey: signer, isSigner: true, isWritable: true },
        { pubkey: satMinerCapitalState, isSigner: false, isWritable: true },
      ];
    },
  });
}

function resolveSatBondAccounts(
  solana: SolanaModuleLike,
  signer: import("@solana/web3.js").PublicKey,
  env: NodeJS.ProcessEnv = process.env,
) {
  const programId = new solana.PublicKey(resolveSatBondProgramIdFromEnv(env));
  const mint = new solana.PublicKey(SAT_MINT_ADDRESS());
  const [bondPosition] = solana.PublicKey.findProgramAddressSync(
    [Buffer.from(SAT_BOND_POSITION_SEED), signer.toBuffer()],
    programId,
  );
  const [bondTierPolicy] = solana.PublicKey.findProgramAddressSync(
    [Buffer.from(SAT_BOND_TIER_POLICY_SEED)],
    programId,
  );
  const [bondStakingDistributor] = solana.PublicKey.findProgramAddressSync(
    [Buffer.from(SAT_BOND_STAKING_DISTRIBUTOR_SEED)],
    programId,
  );
  const [bondStakingPosition] = solana.PublicKey.findProgramAddressSync(
    [Buffer.from(SAT_BOND_STAKING_POSITION_SEED), signer.toBuffer()],
    programId,
  );
  const signerTokenAccount = deriveAssociatedTokenAddress(solana, signer, mint);
  const bondVault = deriveAssociatedTokenAddress(solana, bondPosition, mint);
  const bondStakingRewardVault = deriveAssociatedTokenAddress(solana, bondStakingDistributor, mint);
  return {
    bondProgramId: programId,
    bondTierPolicy,
    bondPosition,
    bondStakingDistributor,
    bondStakingPosition,
    signerTokenAccount,
    bondVault,
    bondStakingRewardVault,
    mint,
    dedicated: hasDedicatedBondProgram(env),
  };
}

export async function submitSatInitBondTierPolicy(
  _config: SatMiningConfig,
  params: {
    updateAuthority?: string;
    basicMinRaw: number;
    operatorMinRaw: number;
    unlockDelaySlots: number;
    scheduledEffectiveSlot?: number;
  },
) {
  const cfg = loadConfigForSatRuntime(_config);
  const effectiveEnv = resolveSatEffectiveEnv(cfg, process.env);
  if (!hasDedicatedBondProgram(effectiveEnv)) {
    throw new Error("SAT bond tier policy init requires FASED_SAT_BOND_PROGRAM_ID");
  }
  const defaultUpdateAuthority =
    resolveSatRegistrySolanaAddress(cfg, effectiveEnv) ||
    (await resolveSatLocalSignerAddress(
      cfg,
      effectiveEnv,
      "local-socket-signer returned no Solana address for SAT bond policy authority",
    ));
  return submitInstruction({
    cfg,
    env: effectiveEnv,
    data: buildInitBondTierPolicyData({
      ...params,
      updateAuthority: params.updateAuthority ?? defaultUpdateAuthority,
    }),
    programId: resolveSatBondProgramIdFromEnv(effectiveEnv),
    accountResolver: async (solana, signer) => {
      const { bondTierPolicy } = resolveSatBondAccounts(solana, signer, effectiveEnv);
      return [
        { pubkey: signer, isSigner: true, isWritable: true },
        { pubkey: bondTierPolicy, isSigner: false, isWritable: true },
        { pubkey: solana.SystemProgram.programId, isSigner: false, isWritable: false },
      ];
    },
  });
}

export async function submitSatUpdateBondTierPolicy(
  _config: SatMiningConfig,
  params: {
    updateAuthority?: string;
    basicMinRaw: number;
    operatorMinRaw: number;
    unlockDelaySlots: number;
    scheduledEffectiveSlot?: number;
  },
) {
  const cfg = loadConfigForSatRuntime(_config);
  const effectiveEnv = resolveSatEffectiveEnv(cfg, process.env);
  if (!hasDedicatedBondProgram(effectiveEnv)) {
    throw new Error("SAT bond tier policy update requires FASED_SAT_BOND_PROGRAM_ID");
  }
  const defaultUpdateAuthority =
    resolveSatRegistrySolanaAddress(cfg, effectiveEnv) ||
    (await resolveSatLocalSignerAddress(
      cfg,
      effectiveEnv,
      "local-socket-signer returned no Solana address for SAT bond policy authority",
    ));
  return submitInstruction({
    cfg,
    env: effectiveEnv,
    data: buildUpdateBondTierPolicyData({
      ...params,
      updateAuthority: params.updateAuthority ?? defaultUpdateAuthority,
    }),
    programId: resolveSatBondProgramIdFromEnv(effectiveEnv),
    accountResolver: async (solana, signer) => {
      const { bondTierPolicy } = resolveSatBondAccounts(solana, signer, effectiveEnv);
      return [
        { pubkey: signer, isSigner: true, isWritable: true },
        { pubkey: bondTierPolicy, isSigner: false, isWritable: true },
      ];
    },
  });
}

export async function submitSatOpenBondPosition(
  _config: SatMiningConfig,
  params: { amountRaw: number },
) {
  const cfg = loadConfigForSatRuntime(_config);
  const effectiveEnv = resolveSatEffectiveEnv(cfg, process.env);
  assertDedicatedBondProgram(effectiveEnv);
  return submitInstruction({
    cfg,
    env: effectiveEnv,
    data: buildOpenBondPositionData(params, effectiveEnv),
    programId: resolveSatBondProgramIdFromEnv(effectiveEnv),
    accountResolver: async (solana, signer) => {
      const { bondTierPolicy, bondPosition, signerTokenAccount, bondVault, mint } =
        resolveSatBondAccounts(solana, signer, effectiveEnv);
      const accounts = [
        { pubkey: signer, isSigner: true, isWritable: true },
        { pubkey: bondTierPolicy, isSigner: false, isWritable: false },
      ];
      accounts.push(
        { pubkey: bondPosition, isSigner: false, isWritable: true },
        { pubkey: signerTokenAccount, isSigner: false, isWritable: true },
        { pubkey: bondVault, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: true },
        { pubkey: solana.SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: new solana.PublicKey(TOKEN_PROGRAM_ID), isSigner: false, isWritable: false },
        {
          pubkey: new solana.PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
          isSigner: false,
          isWritable: false,
        },
      );
      return accounts;
    },
  });
}

export async function submitSatIncreaseBondPosition(
  _config: SatMiningConfig,
  params: { amountRaw: number },
) {
  const cfg = loadConfigForSatRuntime(_config);
  const effectiveEnv = resolveSatEffectiveEnv(cfg, process.env);
  assertDedicatedBondProgram(effectiveEnv);
  return submitInstruction({
    cfg,
    env: effectiveEnv,
    data: buildIncreaseBondPositionData(params, effectiveEnv),
    programId: resolveSatBondProgramIdFromEnv(effectiveEnv),
    accountResolver: async (solana, signer) => {
      const { bondTierPolicy, bondPosition, signerTokenAccount, bondVault, mint } =
        resolveSatBondAccounts(solana, signer, effectiveEnv);
      const accounts = [
        { pubkey: signer, isSigner: true, isWritable: true },
        { pubkey: bondTierPolicy, isSigner: false, isWritable: false },
      ];
      accounts.push(
        { pubkey: bondPosition, isSigner: false, isWritable: true },
        { pubkey: signerTokenAccount, isSigner: false, isWritable: true },
        { pubkey: bondVault, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: true },
        { pubkey: solana.SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: new solana.PublicKey(TOKEN_PROGRAM_ID), isSigner: false, isWritable: false },
        {
          pubkey: new solana.PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
          isSigner: false,
          isWritable: false,
        },
      );
      return accounts;
    },
  });
}

export async function submitSatRequestBondUnlock(_config: SatMiningConfig) {
  const cfg = loadConfigForSatRuntime(_config);
  const effectiveEnv = resolveSatEffectiveEnv(cfg, process.env);
  assertDedicatedBondProgram(effectiveEnv);
  return submitInstruction({
    cfg,
    env: effectiveEnv,
    data: buildRequestBondUnlockData(effectiveEnv),
    programId: resolveSatBondProgramIdFromEnv(effectiveEnv),
    accountResolver: async (solana, signer) => {
      const { bondTierPolicy, bondPosition } = resolveSatBondAccounts(solana, signer, effectiveEnv);
      const accounts = [
        { pubkey: signer, isSigner: true, isWritable: true },
        { pubkey: bondTierPolicy, isSigner: false, isWritable: false },
      ];
      accounts.push({ pubkey: bondPosition, isSigner: false, isWritable: true });
      return accounts;
    },
  });
}

export async function submitSatCancelBondUnlock(_config: SatMiningConfig) {
  const cfg = loadConfigForSatRuntime(_config);
  const effectiveEnv = resolveSatEffectiveEnv(cfg, process.env);
  assertDedicatedBondProgram(effectiveEnv);
  return submitInstruction({
    cfg,
    env: effectiveEnv,
    data: buildCancelBondUnlockData(effectiveEnv),
    programId: resolveSatBondProgramIdFromEnv(effectiveEnv),
    accountResolver: async (solana, signer) => {
      const { bondTierPolicy, bondPosition } = resolveSatBondAccounts(solana, signer, effectiveEnv);
      const accounts = [
        { pubkey: signer, isSigner: true, isWritable: true },
        { pubkey: bondTierPolicy, isSigner: false, isWritable: false },
      ];
      accounts.push({ pubkey: bondPosition, isSigner: false, isWritable: true });
      return accounts;
    },
  });
}

export async function submitSatFinalizeBondUnlock(_config: SatMiningConfig) {
  const cfg = loadConfigForSatRuntime(_config);
  const effectiveEnv = resolveSatEffectiveEnv(cfg, process.env);
  assertDedicatedBondProgram(effectiveEnv);
  return submitInstruction({
    cfg,
    env: effectiveEnv,
    data: buildFinalizeBondUnlockData(effectiveEnv),
    programId: resolveSatBondProgramIdFromEnv(effectiveEnv),
    accountResolver: async (solana, signer) => {
      const { bondTierPolicy, bondPosition, signerTokenAccount, bondVault, mint } =
        resolveSatBondAccounts(solana, signer, effectiveEnv);
      const accounts = [
        { pubkey: signer, isSigner: true, isWritable: true },
        { pubkey: bondTierPolicy, isSigner: false, isWritable: false },
      ];
      accounts.push(
        { pubkey: bondPosition, isSigner: false, isWritable: true },
        { pubkey: bondVault, isSigner: false, isWritable: true },
        { pubkey: signerTokenAccount, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: true },
        { pubkey: solana.SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: new solana.PublicKey(TOKEN_PROGRAM_ID), isSigner: false, isWritable: false },
        {
          pubkey: new solana.PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
          isSigner: false,
          isWritable: false,
        },
      );
      return accounts;
    },
  });
}

export async function submitSatInitBondStakingDistributor(
  _config: SatMiningConfig,
  params: { minStakeRaw: number; updateAuthority?: string },
) {
  const cfg = loadConfigForSatRuntime(_config);
  const effectiveEnv = resolveSatEffectiveEnv(cfg, process.env);
  assertDedicatedBondProgram(effectiveEnv);
  const defaultUpdateAuthority = await resolveSatLocalSignerAddress(
    cfg,
    effectiveEnv,
    "local-socket-signer returned no Solana address for SAT bond staking distributor authority",
  );
  return submitInstruction({
    cfg,
    env: effectiveEnv,
    data: buildInitBondStakingDistributorData(
      {
        minStakeRaw: params.minStakeRaw,
        updateAuthority: params.updateAuthority ?? defaultUpdateAuthority,
      },
      effectiveEnv,
    ),
    programId: resolveSatBondProgramIdFromEnv(effectiveEnv),
    accountResolver: async (solana, signer) => {
      const { bondStakingDistributor, bondStakingRewardVault, mint } = resolveSatBondAccounts(
        solana,
        signer,
        effectiveEnv,
      );
      return [
        { pubkey: signer, isSigner: true, isWritable: true },
        { pubkey: bondStakingDistributor, isSigner: false, isWritable: true },
        { pubkey: bondStakingRewardVault, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: true },
        { pubkey: solana.SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: new solana.PublicKey(TOKEN_PROGRAM_ID), isSigner: false, isWritable: false },
        {
          pubkey: new solana.PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
          isSigner: false,
          isWritable: false,
        },
      ];
    },
  });
}

export async function submitSatSyncBondStakingRewards(_config: SatMiningConfig) {
  const cfg = loadConfigForSatRuntime(_config);
  const effectiveEnv = resolveSatEffectiveEnv(cfg, process.env);
  assertDedicatedBondProgram(effectiveEnv);
  return submitInstruction({
    cfg,
    env: effectiveEnv,
    data: buildSyncBondStakingRewardsData(effectiveEnv),
    programId: resolveSatBondProgramIdFromEnv(effectiveEnv),
    accountResolver: async (solana, signer) => {
      const { bondStakingDistributor, bondStakingRewardVault, mint } = resolveSatBondAccounts(
        solana,
        signer,
        effectiveEnv,
      );
      return [
        { pubkey: bondStakingDistributor, isSigner: false, isWritable: true },
        { pubkey: bondStakingRewardVault, isSigner: false, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: false },
      ];
    },
  });
}

export async function submitSatSyncBondStakingPosition(_config: SatMiningConfig) {
  const cfg = loadConfigForSatRuntime(_config);
  const effectiveEnv = resolveSatEffectiveEnv(cfg, process.env);
  assertDedicatedBondProgram(effectiveEnv);
  return submitInstruction({
    cfg,
    env: effectiveEnv,
    data: buildSyncBondStakingPositionData(effectiveEnv),
    programId: resolveSatBondProgramIdFromEnv(effectiveEnv),
    accountResolver: async (solana, signer) => {
      const { bondTierPolicy, bondStakingDistributor, bondStakingPosition, bondPosition } =
        resolveSatBondAccounts(solana, signer, effectiveEnv);
      return [
        { pubkey: signer, isSigner: true, isWritable: true },
        { pubkey: bondTierPolicy, isSigner: false, isWritable: false },
        { pubkey: bondStakingDistributor, isSigner: false, isWritable: true },
        { pubkey: bondStakingPosition, isSigner: false, isWritable: true },
        { pubkey: bondPosition, isSigner: false, isWritable: false },
        { pubkey: solana.SystemProgram.programId, isSigner: false, isWritable: false },
      ];
    },
  });
}

export async function submitSatClaimBondStakingRewards(_config: SatMiningConfig) {
  const cfg = loadConfigForSatRuntime(_config);
  const effectiveEnv = resolveSatEffectiveEnv(cfg, process.env);
  assertDedicatedBondProgram(effectiveEnv);
  return submitInstruction({
    cfg,
    env: effectiveEnv,
    data: buildClaimBondStakingRewardsData(effectiveEnv),
    programId: resolveSatBondProgramIdFromEnv(effectiveEnv),
    accountResolver: async (solana, signer) => {
      const {
        bondTierPolicy,
        bondStakingDistributor,
        bondStakingPosition,
        bondPosition,
        bondStakingRewardVault,
        signerTokenAccount,
        mint,
      } = resolveSatBondAccounts(solana, signer, effectiveEnv);
      return [
        { pubkey: signer, isSigner: true, isWritable: true },
        { pubkey: bondTierPolicy, isSigner: false, isWritable: false },
        { pubkey: bondStakingDistributor, isSigner: false, isWritable: true },
        { pubkey: bondStakingPosition, isSigner: false, isWritable: true },
        { pubkey: bondPosition, isSigner: false, isWritable: false },
        { pubkey: bondStakingRewardVault, isSigner: false, isWritable: true },
        { pubkey: signerTokenAccount, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: true },
        { pubkey: solana.SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: new solana.PublicKey(TOKEN_PROGRAM_ID), isSigner: false, isWritable: false },
        {
          pubkey: new solana.PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
          isSigner: false,
          isWritable: false,
        },
      ];
    },
  });
}

export async function submitSatCycle(
  _config: SatMiningConfig,
  params: { cycleId: number; allocationFp: number[] },
) {
  const cfg = loadConfigForSatRuntime(_config);
  return submitInstruction({
    cfg,
    env: process.env,
    data: buildSubmitCycleData(params),
    accountResolver: async (solana, signer) => {
      const programId = new solana.PublicKey(SAT_PROGRAM_ID());
      const pageIndex = await resolveSatCycleRegistryPageIndex(_config, params.cycleId);
      const [satGlobalState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_GLOBAL_STATE_SEED)],
        programId,
      );
      const [satCycleState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_CYCLE_STATE_SEED), encodeU64(params.cycleId)],
        programId,
      );
      const [satCycleRegistryMeta] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_CYCLE_REGISTRY_META_SEED), encodeU64(params.cycleId)],
        programId,
      );
      const [satCycleRegistryPage] = solana.PublicKey.findProgramAddressSync(
        [
          Buffer.from(SAT_CYCLE_REGISTRY_PAGE_SEED),
          encodeU64(params.cycleId),
          encodeU64(pageIndex),
        ],
        programId,
      );
      const [satCycleSettlementProgress] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from("sat_cycle_settlement_progress_v2"), encodeU64(params.cycleId)],
        programId,
      );
      const [satMinerCycleState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_MINER_CYCLE_STATE_SEED), signer.toBuffer(), encodeU64(params.cycleId)],
        programId,
      );
      const [satMinerCapitalState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_MINER_CAPITAL_STATE_SEED), signer.toBuffer()],
        programId,
      );
      const [satRegistryReserve] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_REGISTRY_RESERVE_SEED)],
        programId,
      );
      const [satTreasuryState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_TREASURY_STATE_SEED)],
        programId,
      );
      const [satRebateVault] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_REBATE_VAULT_SEED)],
        programId,
      );
      const [satTreasuryVault] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_TREASURY_VAULT_SEED)],
        programId,
      );
      return [
        { pubkey: signer, isSigner: true, isWritable: true },
        { pubkey: satGlobalState, isSigner: false, isWritable: true },
        { pubkey: satCycleState, isSigner: false, isWritable: true },
        { pubkey: satCycleRegistryMeta, isSigner: false, isWritable: true },
        { pubkey: satCycleRegistryPage, isSigner: false, isWritable: true },
        { pubkey: satCycleSettlementProgress, isSigner: false, isWritable: true },
        { pubkey: satMinerCycleState, isSigner: false, isWritable: true },
        { pubkey: satMinerCapitalState, isSigner: false, isWritable: true },
        { pubkey: satRegistryReserve, isSigner: false, isWritable: true },
        { pubkey: satTreasuryState, isSigner: false, isWritable: true },
        { pubkey: solana.SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: satRebateVault, isSigner: false, isWritable: true },
        { pubkey: satTreasuryVault, isSigner: false, isWritable: true },
      ];
    },
  });
}

export async function submitSatSettleCyclePage(
  _config: SatMiningConfig,
  params: { cycleId: number; pageIndex: number; chunkIndex: number; minerCycleAccounts?: string[] },
) {
  const cfg = loadConfigForSatRuntime(_config);
  return submitInstruction({
    cfg,
    env: process.env,
    data: buildSettleCyclePageData(params),
    accountResolver: async (solana, signer) => {
      const programId = new solana.PublicKey(SAT_PROGRAM_ID());
      const [satGlobalState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_GLOBAL_STATE_SEED)],
        programId,
      );
      const [satCycleState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_CYCLE_STATE_SEED), encodeU64(params.cycleId)],
        programId,
      );
      const [satCycleRegistryMeta] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_CYCLE_REGISTRY_META_SEED), encodeU64(params.cycleId)],
        programId,
      );
      const [satCycleRegistryPage] = solana.PublicKey.findProgramAddressSync(
        [
          Buffer.from(SAT_CYCLE_REGISTRY_PAGE_SEED),
          encodeU64(params.cycleId),
          encodeU64(params.pageIndex),
        ],
        programId,
      );
      const [satCycleSettlementProgress] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from("sat_cycle_settlement_progress_v2"), encodeU64(params.cycleId)],
        programId,
      );
      const [satRegistryReserve] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_REGISTRY_RESERVE_SEED)],
        programId,
      );
      const [satTreasuryState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_TREASURY_STATE_SEED)],
        programId,
      );
      const [satSignerMinerCycleState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_MINER_CYCLE_STATE_SEED), signer.toBuffer(), encodeU64(params.cycleId)],
        programId,
      );
      const [satSignerMinerCapitalState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_MINER_CAPITAL_STATE_SEED), signer.toBuffer()],
        programId,
      );
      const [satRebateVault] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_REBATE_VAULT_SEED)],
        programId,
      );
      const accounts = [
        { pubkey: signer, isSigner: true, isWritable: true },
        { pubkey: satGlobalState, isSigner: false, isWritable: false },
        { pubkey: satCycleState, isSigner: false, isWritable: true },
        { pubkey: satCycleRegistryMeta, isSigner: false, isWritable: false },
        { pubkey: satCycleRegistryPage, isSigner: false, isWritable: false },
        { pubkey: satCycleSettlementProgress, isSigner: false, isWritable: true },
        { pubkey: satRegistryReserve, isSigner: false, isWritable: true },
        { pubkey: satTreasuryState, isSigner: false, isWritable: true },
        { pubkey: solana.SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: satSignerMinerCycleState, isSigner: false, isWritable: false },
        { pubkey: satSignerMinerCapitalState, isSigner: false, isWritable: true },
        { pubkey: satRebateVault, isSigner: false, isWritable: true },
      ];
      for (const minerCycleAccount of params.minerCycleAccounts ?? []) {
        accounts.push({
          pubkey: new solana.PublicKey(minerCycleAccount),
          isSigner: false,
          isWritable: true,
        });
      }
      return accounts;
    },
  });
}

export async function submitSatFinalizeCycleSettlement(
  _config: SatMiningConfig,
  params: { cycleId: number; pageCount: number },
) {
  const cfg = loadConfigForSatRuntime(_config);
  return submitInstruction({
    cfg,
    env: process.env,
    data: buildFinalizeCycleSettlementData(params),
    accountResolver: async (solana, signer) => {
      const programId = new solana.PublicKey(SAT_PROGRAM_ID());
      const [satGlobalState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_GLOBAL_STATE_SEED)],
        programId,
      );
      const [satCycleState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_CYCLE_STATE_SEED), encodeU64(params.cycleId)],
        programId,
      );
      const [satCycleSettlementProgress] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from("sat_cycle_settlement_progress_v2"), encodeU64(params.cycleId)],
        programId,
      );
      const [satCycleRegistryMeta] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_CYCLE_REGISTRY_META_SEED), encodeU64(params.cycleId)],
        programId,
      );
      const [satTreasuryState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_TREASURY_STATE_SEED)],
        programId,
      );
      const [satSignerMinerCycleState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_MINER_CYCLE_STATE_SEED), signer.toBuffer(), encodeU64(params.cycleId)],
        programId,
      );
      const [satSignerMinerCapitalState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_MINER_CAPITAL_STATE_SEED), signer.toBuffer()],
        programId,
      );
      const [satRebateVault] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_REBATE_VAULT_SEED)],
        programId,
      );
      const accounts = [
        { pubkey: signer, isSigner: true, isWritable: true },
        { pubkey: satGlobalState, isSigner: false, isWritable: true },
        { pubkey: satCycleState, isSigner: false, isWritable: true },
        { pubkey: satCycleSettlementProgress, isSigner: false, isWritable: true },
        { pubkey: satCycleRegistryMeta, isSigner: false, isWritable: true },
        { pubkey: satTreasuryState, isSigner: false, isWritable: true },
        { pubkey: satSignerMinerCycleState, isSigner: false, isWritable: false },
        { pubkey: satSignerMinerCapitalState, isSigner: false, isWritable: true },
        { pubkey: satRebateVault, isSigner: false, isWritable: true },
      ];
      for (let pageIndex = 0; pageIndex < params.pageCount; pageIndex += 1) {
        const [satCycleRegistryPage] = solana.PublicKey.findProgramAddressSync(
          [
            Buffer.from(SAT_CYCLE_REGISTRY_PAGE_SEED),
            encodeU64(params.cycleId),
            encodeU64(pageIndex),
          ],
          programId,
        );
        accounts.push({ pubkey: satCycleRegistryPage, isSigner: false, isWritable: false });
      }
      return accounts;
    },
  });
}

export async function submitSatScoreCyclePage(
  _config: SatMiningConfig,
  params: { cycleId: number; pageIndex: number; chunkIndex: number; minerCycleAccounts?: string[] },
) {
  const cfg = loadConfigForSatRuntime(_config);
  return submitInstruction({
    cfg,
    env: process.env,
    data: buildScoreCyclePageData(params),
    accountResolver: async (solana, signer) => {
      const programId = new solana.PublicKey(SAT_PROGRAM_ID());
      const [satGlobalState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_GLOBAL_STATE_SEED)],
        programId,
      );
      const [satCycleState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_CYCLE_STATE_SEED), encodeU64(params.cycleId)],
        programId,
      );
      const [satCycleRegistryPage] = solana.PublicKey.findProgramAddressSync(
        [
          Buffer.from(SAT_CYCLE_REGISTRY_PAGE_SEED),
          encodeU64(params.cycleId),
          encodeU64(params.pageIndex),
        ],
        programId,
      );
      const [satCycleSettlementProgress] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from("sat_cycle_settlement_progress_v2"), encodeU64(params.cycleId)],
        programId,
      );
      const [satTreasuryState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_TREASURY_STATE_SEED)],
        programId,
      );
      const [satSignerMinerCycleState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_MINER_CYCLE_STATE_SEED), signer.toBuffer(), encodeU64(params.cycleId)],
        programId,
      );
      const [satSignerMinerCapitalState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_MINER_CAPITAL_STATE_SEED), signer.toBuffer()],
        programId,
      );
      const [satRebateVault] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_REBATE_VAULT_SEED)],
        programId,
      );
      const accounts = [
        { pubkey: signer, isSigner: true, isWritable: true },
        { pubkey: satGlobalState, isSigner: false, isWritable: false },
        { pubkey: satCycleState, isSigner: false, isWritable: false },
        { pubkey: satCycleRegistryPage, isSigner: false, isWritable: false },
        { pubkey: satCycleSettlementProgress, isSigner: false, isWritable: true },
        { pubkey: satTreasuryState, isSigner: false, isWritable: true },
        { pubkey: satSignerMinerCycleState, isSigner: false, isWritable: false },
        { pubkey: satSignerMinerCapitalState, isSigner: false, isWritable: true },
        { pubkey: satRebateVault, isSigner: false, isWritable: true },
      ];
      for (const minerCycleAccount of params.minerCycleAccounts ?? []) {
        accounts.push({
          pubkey: new solana.PublicKey(minerCycleAccount),
          isSigner: false,
          isWritable: true,
        });
      }
      return accounts;
    },
  });
}

export async function submitSatDistributeCyclePage(
  _config: SatMiningConfig,
  params: { cycleId: number; pageIndex: number; chunkIndex: number; minerCycleAccounts?: string[] },
) {
  const cfg = loadConfigForSatRuntime(_config);
  return submitInstruction({
    cfg,
    env: process.env,
    data: buildDistributeCyclePageData(params),
    accountResolver: async (solana, signer) => {
      const programId = new solana.PublicKey(SAT_PROGRAM_ID());
      const [satCycleState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_CYCLE_STATE_SEED), encodeU64(params.cycleId)],
        programId,
      );
      const [satCycleRegistryPage] = solana.PublicKey.findProgramAddressSync(
        [
          Buffer.from(SAT_CYCLE_REGISTRY_PAGE_SEED),
          encodeU64(params.cycleId),
          encodeU64(params.pageIndex),
        ],
        programId,
      );
      const [satCycleSettlementProgress] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from("sat_cycle_settlement_progress_v2"), encodeU64(params.cycleId)],
        programId,
      );
      const [satGlobalState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_GLOBAL_STATE_SEED)],
        programId,
      );
      const [satTreasuryState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_TREASURY_STATE_SEED)],
        programId,
      );
      const [satSignerMinerCycleState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_MINER_CYCLE_STATE_SEED), signer.toBuffer(), encodeU64(params.cycleId)],
        programId,
      );
      const [satSignerMinerCapitalState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_MINER_CAPITAL_STATE_SEED), signer.toBuffer()],
        programId,
      );
      const [satRebateVault] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_REBATE_VAULT_SEED)],
        programId,
      );
      const accounts = [
        { pubkey: signer, isSigner: true, isWritable: true },
        { pubkey: satCycleState, isSigner: false, isWritable: true },
        { pubkey: satCycleRegistryPage, isSigner: false, isWritable: false },
        { pubkey: satCycleSettlementProgress, isSigner: false, isWritable: true },
        { pubkey: satGlobalState, isSigner: false, isWritable: true },
        { pubkey: satTreasuryState, isSigner: false, isWritable: true },
        { pubkey: satSignerMinerCycleState, isSigner: false, isWritable: false },
        { pubkey: satSignerMinerCapitalState, isSigner: false, isWritable: true },
        { pubkey: satRebateVault, isSigner: false, isWritable: true },
      ];
      const minerCycleAccounts = params.minerCycleAccounts ?? [];
      const minerCycles =
        minerCycleAccounts.length > 0
          ? await inspectSatMinerCyclesByAddress(_config, {
              addresses: minerCycleAccounts,
            }).catch(() => [])
          : [];
      for (const [index, minerCycleAccount] of minerCycleAccounts.entries()) {
        const satMinerCycleState = new solana.PublicKey(minerCycleAccount);
        const minerCycle = minerCycles[index] ?? null;
        const authorityKey = minerCycle?.authority
          ? new solana.PublicKey(minerCycle.authority)
          : null;
        if (!authorityKey) {
          throw new Error(
            `SAT distributeCyclePage could not resolve miner authority for ${minerCycleAccount}`,
          );
        }
        const [satMinerCapitalState] = solana.PublicKey.findProgramAddressSync(
          [Buffer.from(SAT_MINER_CAPITAL_STATE_SEED), authorityKey.toBuffer()],
          programId,
        );
        accounts.push({ pubkey: satMinerCycleState, isSigner: false, isWritable: true });
        accounts.push({ pubkey: satMinerCapitalState, isSigner: false, isWritable: true });
      }
      return accounts;
    },
  });
}

export async function submitSatClaimCycleRewards(
  _config: SatMiningConfig,
  params: { cycleId: number },
) {
  const cfg = loadConfigForSatRuntime(_config);
  return submitInstruction({
    cfg,
    env: process.env,
    data: buildClaimCycleRewardsData(params),
    accountResolver: async (solana, signer) => {
      const programId = new solana.PublicKey(SAT_PROGRAM_ID());
      const [satGlobalState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_GLOBAL_STATE_SEED)],
        programId,
      );
      const [satCycleState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_CYCLE_STATE_SEED), encodeU64(params.cycleId)],
        programId,
      );
      const [satMinerCycleState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_MINER_CYCLE_STATE_SEED), signer.toBuffer(), encodeU64(params.cycleId)],
        programId,
      );
      const [satMinerCapitalState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_MINER_CAPITAL_STATE_SEED), signer.toBuffer()],
        programId,
      );
      const [treasury] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from("treasury")],
        programId,
      );
      const [satTreasuryState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_TREASURY_STATE_SEED)],
        programId,
      );
      const [satRebateVault] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_REBATE_VAULT_SEED)],
        programId,
      );
      const recipientAta = deriveAssociatedTokenAddress(
        solana,
        signer,
        new solana.PublicKey(SAT_MINT_ADDRESS()),
      );
      const [mintAuthority] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from("authority")],
        new solana.PublicKey(SAT_MINT_PROGRAM_ID()),
      );
      return [
        { pubkey: signer, isSigner: true, isWritable: true },
        { pubkey: satGlobalState, isSigner: false, isWritable: true },
        { pubkey: satCycleState, isSigner: false, isWritable: true },
        { pubkey: satMinerCycleState, isSigner: false, isWritable: true },
        { pubkey: satMinerCapitalState, isSigner: false, isWritable: true },
        { pubkey: treasury, isSigner: false, isWritable: true },
        { pubkey: satTreasuryState, isSigner: false, isWritable: true },
        { pubkey: mintAuthority, isSigner: false, isWritable: true },
        { pubkey: new solana.PublicKey(SAT_MINT_ADDRESS()), isSigner: false, isWritable: true },
        { pubkey: recipientAta, isSigner: false, isWritable: true },
        { pubkey: solana.SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: new solana.PublicKey(TOKEN_PROGRAM_ID), isSigner: false, isWritable: false },
        {
          pubkey: new solana.PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
          isSigner: false,
          isWritable: false,
        },
        { pubkey: new solana.PublicKey(SAT_MINT_PROGRAM_ID()), isSigner: false, isWritable: false },
        { pubkey: satRebateVault, isSigner: false, isWritable: true },
      ];
    },
  });
}

export async function submitSatClaimCycleRewardsBatch(
  _config: SatMiningConfig,
  params: { cycleIds: number[] },
) {
  const cfg = loadConfigForSatRuntime(_config);
  return submitInstruction({
    cfg,
    env: process.env,
    data: buildClaimCycleRewardsBatchData(params),
    accountResolver: async (solana, signer) => {
      const programId = new solana.PublicKey(SAT_PROGRAM_ID());
      const [satGlobalState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_GLOBAL_STATE_SEED)],
        programId,
      );
      const [treasury] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from("treasury")],
        programId,
      );
      const [satTreasuryState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_TREASURY_STATE_SEED)],
        programId,
      );
      const [satMinerCapitalState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_MINER_CAPITAL_STATE_SEED), signer.toBuffer()],
        programId,
      );
      const [satRebateVault] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_REBATE_VAULT_SEED)],
        programId,
      );
      const mint = new solana.PublicKey(SAT_MINT_ADDRESS());
      const [mintAuthority] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from("authority")],
        new solana.PublicKey(SAT_MINT_PROGRAM_ID()),
      );
      const recipient = deriveAssociatedTokenAddress(solana, signer, mint);
      const accounts = [
        { pubkey: signer, isSigner: true, isWritable: true },
        { pubkey: satGlobalState, isSigner: false, isWritable: false },
        { pubkey: treasury, isSigner: false, isWritable: true },
        { pubkey: satTreasuryState, isSigner: false, isWritable: true },
        { pubkey: satMinerCapitalState, isSigner: false, isWritable: true },
        { pubkey: mintAuthority, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: true },
        { pubkey: recipient, isSigner: false, isWritable: true },
      ];
      for (const cycleId of params.cycleIds) {
        const [satCycleState] = solana.PublicKey.findProgramAddressSync(
          [Buffer.from(SAT_CYCLE_STATE_SEED), encodeU64(cycleId)],
          programId,
        );
        const [satMinerCycleState] = solana.PublicKey.findProgramAddressSync(
          [Buffer.from(SAT_MINER_CYCLE_STATE_SEED), signer.toBuffer(), encodeU64(cycleId)],
          programId,
        );
        accounts.push({ pubkey: satCycleState, isSigner: false, isWritable: false });
        accounts.push({ pubkey: satMinerCycleState, isSigner: false, isWritable: true });
      }
      accounts.push({ pubkey: solana.SystemProgram.programId, isSigner: false, isWritable: false });
      accounts.push({
        pubkey: new solana.PublicKey(TOKEN_PROGRAM_ID),
        isSigner: false,
        isWritable: false,
      });
      accounts.push({
        pubkey: new solana.PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
        isSigner: false,
        isWritable: false,
      });
      accounts.push({
        pubkey: new solana.PublicKey(SAT_MINT_PROGRAM_ID()),
        isSigner: false,
        isWritable: false,
      });
      accounts.push({ pubkey: satRebateVault, isSigner: false, isWritable: true });
      return accounts;
    },
  });
}

export async function submitSatSetProtocolRecipients(
  _config: SatMiningConfig,
  params: { treasuryRecipient: string; distributorRecipient: string },
) {
  const cfg = loadConfigForSatRuntime(_config);
  return submitInstruction({
    cfg,
    env: process.env,
    data: buildSetProtocolRecipientsData(params),
    accountResolver: async (solana, signer) => {
      const programId = new solana.PublicKey(SAT_PROGRAM_ID());
      const [satGlobalState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_GLOBAL_STATE_SEED)],
        programId,
      );
      return [
        { pubkey: signer, isSigner: true, isWritable: true },
        { pubkey: satGlobalState, isSigner: false, isWritable: true },
      ];
    },
  });
}

export async function submitSatClaimProtocolTreasury(
  _config: SatMiningConfig,
  params: { recipientOwner: string },
) {
  const cfg = loadConfigForSatRuntime(_config);
  return submitInstruction({
    cfg,
    env: process.env,
    data: buildClaimProtocolTreasuryData(),
    accountResolver: async (solana, signer) => {
      const programId = new solana.PublicKey(SAT_PROGRAM_ID());
      const recipientOwner = new solana.PublicKey(params.recipientOwner);
      const [satGlobalState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_GLOBAL_STATE_SEED)],
        programId,
      );
      const [treasury] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from("treasury")],
        programId,
      );
      const [satTreasuryState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_TREASURY_STATE_SEED)],
        programId,
      );
      const [satTreasuryVault] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_TREASURY_VAULT_SEED)],
        programId,
      );
      const [satRegistryReserve] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_REGISTRY_RESERVE_SEED)],
        programId,
      );
      const [mintAuthority] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from("authority")],
        new solana.PublicKey(SAT_MINT_PROGRAM_ID()),
      );
      const recipientAta = deriveAssociatedTokenAddress(
        solana,
        recipientOwner,
        new solana.PublicKey(SAT_MINT_ADDRESS()),
      );
      return [
        { pubkey: signer, isSigner: true, isWritable: true },
        { pubkey: satGlobalState, isSigner: false, isWritable: false },
        { pubkey: treasury, isSigner: false, isWritable: true },
        { pubkey: satTreasuryState, isSigner: false, isWritable: true },
        { pubkey: satTreasuryVault, isSigner: false, isWritable: true },
        { pubkey: satRegistryReserve, isSigner: false, isWritable: true },
        { pubkey: recipientOwner, isSigner: false, isWritable: true },
        { pubkey: mintAuthority, isSigner: false, isWritable: true },
        { pubkey: new solana.PublicKey(SAT_MINT_ADDRESS()), isSigner: false, isWritable: true },
        { pubkey: recipientAta, isSigner: false, isWritable: true },
        { pubkey: solana.SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: new solana.PublicKey(TOKEN_PROGRAM_ID), isSigner: false, isWritable: false },
        {
          pubkey: new solana.PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
          isSigner: false,
          isWritable: false,
        },
        { pubkey: new solana.PublicKey(SAT_MINT_PROGRAM_ID()), isSigner: false, isWritable: false },
      ];
    },
  });
}

export async function submitSatRefillRegistryReserveFromTreasury(
  _config: SatMiningConfig,
  params: { targetBalanceLamports?: number },
) {
  const cfg = loadConfigForSatRuntime(_config);
  const targetBalanceLamports =
    typeof params.targetBalanceLamports === "number" &&
    Number.isFinite(params.targetBalanceLamports)
      ? Math.max(0, Math.floor(params.targetBalanceLamports))
      : 0;
  return submitInstruction({
    cfg,
    env: process.env,
    data: buildRefillRegistryReserveFromTreasuryData({ targetBalanceLamports }),
    accountResolver: async (solana, signer) => {
      const programId = new solana.PublicKey(SAT_PROGRAM_ID());
      const [satTreasuryState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_TREASURY_STATE_SEED)],
        programId,
      );
      const [satTreasuryVault] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_TREASURY_VAULT_SEED)],
        programId,
      );
      const [satRegistryReserve] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_REGISTRY_RESERVE_SEED)],
        programId,
      );
      return [
        { pubkey: signer, isSigner: true, isWritable: true },
        { pubkey: satTreasuryState, isSigner: false, isWritable: true },
        { pubkey: satTreasuryVault, isSigner: false, isWritable: true },
        { pubkey: satRegistryReserve, isSigner: false, isWritable: true },
        { pubkey: solana.SystemProgram.programId, isSigner: false, isWritable: false },
      ];
    },
  });
}

export async function submitSatClaimProtocolDistributorSat(
  _config: SatMiningConfig,
  params: { recipientOwner: string },
) {
  const cfg = loadConfigForSatRuntime(_config);
  return submitInstruction({
    cfg,
    env: process.env,
    data: buildClaimProtocolDistributorSatData(),
    accountResolver: async (solana, signer) => {
      const programId = new solana.PublicKey(SAT_PROGRAM_ID());
      const recipientOwner = new solana.PublicKey(params.recipientOwner);
      const [satGlobalState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_GLOBAL_STATE_SEED)],
        programId,
      );
      const [treasury] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from("treasury")],
        programId,
      );
      const [satTreasuryState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_TREASURY_STATE_SEED)],
        programId,
      );
      const [mintAuthority] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from("authority")],
        new solana.PublicKey(SAT_MINT_PROGRAM_ID()),
      );
      const recipientAta = deriveAssociatedTokenAddress(
        solana,
        recipientOwner,
        new solana.PublicKey(SAT_MINT_ADDRESS()),
      );
      return [
        { pubkey: signer, isSigner: true, isWritable: true },
        { pubkey: satGlobalState, isSigner: false, isWritable: false },
        { pubkey: treasury, isSigner: false, isWritable: true },
        { pubkey: satTreasuryState, isSigner: false, isWritable: true },
        { pubkey: recipientOwner, isSigner: false, isWritable: true },
        { pubkey: mintAuthority, isSigner: false, isWritable: true },
        { pubkey: new solana.PublicKey(SAT_MINT_ADDRESS()), isSigner: false, isWritable: true },
        { pubkey: recipientAta, isSigner: false, isWritable: true },
        { pubkey: solana.SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: new solana.PublicKey(TOKEN_PROGRAM_ID), isSigner: false, isWritable: false },
        {
          pubkey: new solana.PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
          isSigner: false,
          isWritable: false,
        },
        { pubkey: new solana.PublicKey(SAT_MINT_PROGRAM_ID()), isSigner: false, isWritable: false },
      ];
    },
  });
}

export async function submitSatRetargetUnlock(
  _config: SatMiningConfig,
  params: { cycleId: number },
) {
  const cfg = loadConfigForSatRuntime(_config);
  return submitInstruction({
    cfg,
    env: process.env,
    data: buildRetargetUnlockData(params),
    accountResolver: async (solana, signer) => {
      const programId = new solana.PublicKey(SAT_PROGRAM_ID());
      const [satGlobalState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_GLOBAL_STATE_SEED)],
        programId,
      );
      const [satCycleState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_CYCLE_STATE_SEED), encodeU64(params.cycleId)],
        programId,
      );
      return [
        { pubkey: signer, isSigner: true, isWritable: true },
        { pubkey: satGlobalState, isSigner: false, isWritable: true },
        { pubkey: satCycleState, isSigner: false, isWritable: false },
      ];
    },
  });
}

function buildCloseResolvedMinerCycleStateSpec(params: {
  cycleId: number;
  authority: string;
}): SatInstructionSubmitSpec {
  return {
    data: buildCloseResolvedMinerCycleStateData(params),
    accountResolver: async (solana, signer) => {
      const programId = new solana.PublicKey(SAT_PROGRAM_ID());
      const minerAuthority = new solana.PublicKey(params.authority);
      const [satCycleState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_CYCLE_STATE_SEED), encodeU64(params.cycleId)],
        programId,
      );
      const [satMinerCycleState] = solana.PublicKey.findProgramAddressSync(
        [
          Buffer.from(SAT_MINER_CYCLE_STATE_SEED),
          minerAuthority.toBuffer(),
          encodeU64(params.cycleId),
        ],
        programId,
      );
      const [satMinerCapitalState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_MINER_CAPITAL_STATE_SEED), minerAuthority.toBuffer()],
        programId,
      );
      const [satCycleRegistryMeta] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_CYCLE_REGISTRY_META_SEED), encodeU64(params.cycleId)],
        programId,
      );
      return [
        { pubkey: signer, isSigner: true, isWritable: true },
        { pubkey: satCycleState, isSigner: false, isWritable: false },
        { pubkey: minerAuthority, isSigner: false, isWritable: true },
        { pubkey: satMinerCycleState, isSigner: false, isWritable: true },
        { pubkey: satMinerCapitalState, isSigner: false, isWritable: true },
        { pubkey: satCycleRegistryMeta, isSigner: false, isWritable: true },
      ];
    },
  };
}

function buildCloseResolvedCycleRegistryPageSpec(params: {
  cycleId: number;
  pageIndex: number;
}): SatInstructionSubmitSpec {
  return {
    data: buildCloseResolvedCycleRegistryPageData(params),
    accountResolver: async (solana, signer) => {
      const programId = new solana.PublicKey(SAT_PROGRAM_ID());
      const [satCycleState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_CYCLE_STATE_SEED), encodeU64(params.cycleId)],
        programId,
      );
      const [satCycleRegistryMeta] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_CYCLE_REGISTRY_META_SEED), encodeU64(params.cycleId)],
        programId,
      );
      const [satCycleRegistryPage] = solana.PublicKey.findProgramAddressSync(
        [
          Buffer.from(SAT_CYCLE_REGISTRY_PAGE_SEED),
          encodeU64(params.cycleId),
          encodeU64(params.pageIndex),
        ],
        programId,
      );
      const [satRegistryReserve] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_REGISTRY_RESERVE_SEED)],
        programId,
      );
      return [
        { pubkey: signer, isSigner: true, isWritable: true },
        { pubkey: satCycleState, isSigner: false, isWritable: false },
        { pubkey: satCycleRegistryMeta, isSigner: false, isWritable: true },
        { pubkey: satCycleRegistryPage, isSigner: false, isWritable: true },
        { pubkey: satRegistryReserve, isSigner: false, isWritable: true },
      ];
    },
  };
}

function buildCloseResolvedCycleArtifactsSpec(params: {
  cycleId: number;
}): SatInstructionSubmitSpec {
  return {
    data: buildCloseResolvedCycleArtifactsData(params),
    accountResolver: async (solana, signer) => {
      const programId = new solana.PublicKey(SAT_PROGRAM_ID());
      const [satCycleState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_CYCLE_STATE_SEED), encodeU64(params.cycleId)],
        programId,
      );
      const [satCycleSettlementProgress] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from("sat_cycle_settlement_progress_v2"), encodeU64(params.cycleId)],
        programId,
      );
      const [satCycleRegistryMeta] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_CYCLE_REGISTRY_META_SEED), encodeU64(params.cycleId)],
        programId,
      );
      const [satRegistryReserve] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_REGISTRY_RESERVE_SEED)],
        programId,
      );
      return [
        { pubkey: signer, isSigner: true, isWritable: true },
        { pubkey: satCycleState, isSigner: false, isWritable: true },
        { pubkey: satCycleSettlementProgress, isSigner: false, isWritable: true },
        { pubkey: satCycleRegistryMeta, isSigner: false, isWritable: true },
        { pubkey: satRegistryReserve, isSigner: false, isWritable: true },
      ];
    },
  };
}

export async function submitSatCloseResolvedMinerCycleState(
  _config: SatMiningConfig,
  params: { cycleId: number; authority: string },
) {
  const cfg = loadConfigForSatRuntime(_config);
  return submitInstruction({
    cfg,
    env: process.env,
    ...buildCloseResolvedMinerCycleStateSpec(params),
  });
}

export async function submitSatCloseResolvedCycleRegistryPage(
  _config: SatMiningConfig,
  params: { cycleId: number; pageIndex: number },
) {
  const cfg = loadConfigForSatRuntime(_config);
  return submitInstruction({
    cfg,
    env: process.env,
    ...buildCloseResolvedCycleRegistryPageSpec(params),
  });
}

export async function submitSatCloseResolvedCycleArtifacts(
  _config: SatMiningConfig,
  params: { cycleId: number },
) {
  const cfg = loadConfigForSatRuntime(_config);
  return submitInstruction({
    cfg,
    env: process.env,
    ...buildCloseResolvedCycleArtifactsSpec(params),
  });
}

export type SatCloseResolvedCleanupBatchItem =
  | { kind: "minerCycleState"; cycleId: number; authority: string }
  | { kind: "cycleRegistryPage"; cycleId: number; pageIndex: number }
  | { kind: "cycleArtifacts"; cycleId: number };

export async function submitSatCloseResolvedCleanupBatch(
  _config: SatMiningConfig,
  items: SatCloseResolvedCleanupBatchItem[],
) {
  if (items.length === 0) {
    throw new Error("SAT cleanup batch has no items");
  }
  const cfg = loadConfigForSatRuntime(_config);
  return submitInstructionBatch({
    cfg,
    env: process.env,
    purpose: "sat-cleanup",
    instructions: items.map((item) => {
      switch (item.kind) {
        case "minerCycleState":
          return buildCloseResolvedMinerCycleStateSpec(item);
        case "cycleRegistryPage":
          return buildCloseResolvedCycleRegistryPageSpec(item);
        case "cycleArtifacts":
          return buildCloseResolvedCycleArtifactsSpec(item);
      }
    }),
  });
}

export async function submitSatCompactPendingCycleRange(
  _config: SatMiningConfig,
  params: {
    expectedFirstPendingCycleId: number;
    expectedLastPendingCycleId: number;
    frontCycleIds: number[];
    backCycleIds: number[];
  },
) {
  const cfg = loadConfigForSatRuntime(_config);
  return submitInstruction({
    cfg,
    env: process.env,
    data: buildCompactPendingCycleRangeData(params),
    accountResolver: async (solana, signer) => {
      const programId = new solana.PublicKey(SAT_PROGRAM_ID());
      const [satMinerCapitalState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_MINER_CAPITAL_STATE_SEED), signer.toBuffer()],
        programId,
      );
      const accounts: SolanaAccountMeta[] = [
        { pubkey: signer, isSigner: true, isWritable: true },
        { pubkey: satMinerCapitalState, isSigner: false, isWritable: true },
      ];
      for (const cycleId of params.frontCycleIds) {
        const [satMinerCycleState] = solana.PublicKey.findProgramAddressSync(
          [Buffer.from(SAT_MINER_CYCLE_STATE_SEED), signer.toBuffer(), encodeU64(cycleId)],
          programId,
        );
        accounts.push({
          pubkey: satMinerCycleState,
          isSigner: false,
          isWritable: false,
        });
      }
      for (const cycleId of params.backCycleIds) {
        const [satMinerCycleState] = solana.PublicKey.findProgramAddressSync(
          [Buffer.from(SAT_MINER_CYCLE_STATE_SEED), signer.toBuffer(), encodeU64(cycleId)],
          programId,
        );
        accounts.push({
          pubkey: satMinerCycleState,
          isSigner: false,
          isWritable: false,
        });
      }
      return accounts;
    },
  });
}
