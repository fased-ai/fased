import { createHash } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { createRequire } from "node:module";
import { fetchWithSsrFGuard, redactSensitiveUrlLikeString } from "fased/plugin-sdk";
import {
  loadConfig,
  loadWalletProviderSecret,
  readWalletProviderRegistry,
  resolveSatBondProgramIdFromEnv,
  resolveSatMintAddressFromEnv,
  resolveSatProgramIdFromEnv,
  resolveWalletProviderId,
  type FasedAgentConfig,
} from "fased/plugin-sdk/sat-runtime";
import type { SatMiningConfig } from "./config.js";
import { resolveSatGenesisProfileContract, SAT_PROTOCOL_CONSTANTS } from "./protocol-contract.js";
import {
  loadSatBondLayout,
  loadSatBondPolicyLayout,
  loadSatBondStakingDistributorLayout,
  loadSatBondStakingPositionLayout,
} from "./sat-bond-layout.js";

const require = createRequire(import.meta.url);

const SAT_PROGRAM_ID = () => resolveSatProgramIdFromEnv(process.env);
const SAT_BOND_PROGRAM_ID = () => resolveSatBondProgramIdFromEnv(process.env);
const SAT_MINT_ADDRESS = () => resolveSatMintAddressFromEnv(process.env);
const SAT_MINER_CYCLE_STATE_SEED = "sat_miner_cycle_state";
const SAT_VALIDATOR_ATTESTATION_SEED = "sat_validator_attestation";
const SAT_DISPUTE_SEED = "sat_dispute";
const MINING_STAKE_SEED = "mining_stake";
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const ADDRESS_LOOKUP_TABLE_PROGRAM_ID = "AddressLookupTab1e1111111111111111111111111";

function assertDedicatedBondProgramConfigured(env: NodeJS.ProcessEnv = process.env): void {
  const resolved = resolveSatBondProgramIdFromEnv(env);
  if (!resolved.trim()) {
    throw new Error("legacy monolithic SAT bond mode is disabled; set FASED_SAT_BOND_PROGRAM_ID");
  }
}

const ACCOUNT_DISCRIMINATOR = {
  miningStake: 121,
  satRoundBucket: 122,
  satEpoch: 123,
  satWalletEpoch: 124,
  satRoundCommit: 125,
  satRoundState: 126,
  satValidatorAttestation: 128,
  satDispute: 129,
  satGlobalState: 130,
  satCycleState: 131,
  satMinerCycleState: 132,
  satTreasuryState: 133,
  satCycleRegistryMeta: 134,
  satCycleRegistryPage: 135,
  satCycleSettlementProgressV2: 137,
  satMinerCapitalState: 138,
} as const;

const ACCOUNT_OFFSET = {
  validatorAuthority: 8,
  targetAuthority: 40,
  epochId: 72,
  microRoundId: 80,
} as const;

type SolanaModuleLike = typeof import("@solana/web3.js");

type SatMiningStakeSummary = {
  authority: string;
  shares: string;
  originalStake: string;
  rewardOwed: string;
  jackpotOwed: string;
  slashPenaltyOwed: string;
  autoUnstakeThresholdBps: number;
};

export type SatRoundBucketView = {
  address: string;
  epochId: number;
  microRoundId: number;
  bucketVersion: number;
  roundOpenTs: number;
  roundCloseTs: number;
  roundSeed: string;
  bucketHash: string;
};

type SatRecordLocator = {
  roundKey: string;
  epochId: number;
  microRoundId: number;
  validatorAuthority: string;
  targetAuthority: string;
};

type SatValidatorAttestationView = {
  address: string;
  recordLocator: SatRecordLocator;
  validatorAuthority: string;
  targetAuthority: string;
  epochId: number;
  microRoundId: number;
  decisionFlag: number;
  reasonCode: number;
  bucketRoot: string;
  scoreRoot: string;
  coordinationRoot: string;
  evidenceHash: string;
  attestedAt: number;
  decisionLabel: string;
  epochClaimStatus?: {
    blocked: boolean;
    blockedReason: { kind: string; slashReasonCode?: number } | string | null;
    openDisputeCount: number;
    validatorRejectCount: number;
    slashReasonCode: number;
  };
  targetMiningStake: SatMiningStakeSummary;
};

export type SatEpochView = {
  address: string;
  epochId: number;
  claimsBlocked: boolean;
  blockedReason: { kind: string; slashReasonCode?: number } | string | null;
  openDisputeCount: number;
  validatorRejectCount: number;
  slashReasonCode: number;
  bucketRoot: string;
  scoreRoot: string;
  coordinationRoot: string;
  republishStatus: SatRepublishStatus;
  epoch: {
    startTs: number;
    endTs: number;
    microRoundsTotal: number;
    validWalletCount: number;
    baseEligibleWalletCount: number;
    skillEligibleWalletCount: number;
    settledEmissionSat: number;
  };
};

export type SatWalletEpochView = {
  address: string;
  authority: string;
  aggregateScoreFp: string;
  epochId: number;
  validRoundCount: number;
  heartbeatCount: number;
  revealFaultCount: number;
  finalizationFaultCount: number;
  baseEligible: boolean;
  skillEligible: boolean;
  settled: boolean;
  baseRewardSatOwed: string;
  skillRewardSatOwed: string;
  rebateSolOwed: string;
  performanceSolOwed: string;
};

export type SatRoundCommitView = {
  address: string;
  authority: string;
  epochId: number;
  microRoundId: number;
  submittedAt: number;
  revealed: boolean;
  finalized: boolean;
  allocationSum: string;
  revealBucketHash: string;
};

export type SatRoundStateView = {
  address: string;
  epochId: number;
  microRoundId: number;
  bucketHash: string;
  revealedWalletCount: number;
  finalized: boolean;
};

export type SatClaimReceipt = {
  signature: string;
  feeLamports: string;
  claimedSatRaw: string;
  transferredSatRaw: string;
  solRebateLamports: string;
  payoutExecuted: boolean;
  pendingPayoutRaw: string;
};

export type SatTxReceipt = {
  signature: string;
  feeLamports: string;
  slot?: number;
  blockTime?: number | null;
  logMessages?: string[];
};

export type SatGlobalStateView = {
  address: string;
  version?: number;
  hardCapSatRaw?: string;
  issuanceYearIndex?: number;
  yearBudgetSatRaw?: string;
  yearIssuedSatRaw?: string;
  launchCycleId?: string;
  totalIssuedSatRaw?: string;
  cycleSeconds?: number;
  currentUnlockSolLamports: string;
  minimumEntryLamports: string;
  cycleErosionPpm: number;
  treasuryRecipient?: string;
  distributorRecipient?: string;
};

export type SatCycleView = {
  address: string;
  cycleId: number;
  openTs: number;
  closeTs: number;
  status: number;
  cycleSeed?: string;
  entropyUnavailable?: boolean;
  commitDeadlineTs?: number;
  revealDeadlineTs?: number;
  entropyTargetSlot?: number;
  openSlot?: number;
  commitDeadlineSlot?: number;
  revealDeadlineSlot?: number;
  entropyHashCount?: number;
  unlockIntervalStartCycleId?: number;
  committedMinerCount?: string;
  revealedMinerCount?: string;
  resolvedCommitCount?: string;
  releasedCommitCount?: string;
  entropySealedSlot?: number;
  unlockTargetLamports: string;
  totalCommittedLamports: string;
  validMinerCount: string;
  unlockRatioFp: string;
  issuedCycleMinerSatRaw: string;
  unissuedCycleMinerSatRaw: string;
  solErosionPoolLamports: string;
  deterministicRebatePoolLamports: string;
  performanceRebatePoolLamports: string;
  treasurySolLamports: string;
  submittedSolErosionPoolLamports?: string;
  keeperBountyPaidLamports?: string;
};

export type SatMinerCycleView = {
  address: string;
  placementReturnFp?: string;
  benchmarkReturnFp?: string;
  skillScoreFp?: string;
  rewardWeightFp?: string;
  authority: string;
  cycleId: number;
  committedLamports: string;
  submissionTs?: number;
  powerWeightFp?: string;
  claimableSatRaw: string;
  claimableDetRebateLamports: string;
  claimablePerfRebateLamports: string;
  claimedSatRaw: string;
  claimedDetRebateLamports: string;
  claimedPerfRebateLamports: string;
  validParticipation: boolean;
  capitalLockReleased?: boolean;
  commitment?: string;
  commitSlot?: number;
  revealSlot?: number;
  lockedCollateralLamports?: string;
};

export type SatMinerCapitalView = {
  address: string;
  authority: string;
  fundedLamports: string;
  lockedLamports: string;
  freeLamports: string;
  activeCommitLamports: string;
  firstPendingCycleId?: number;
  lastPendingCycleId?: number;
};

export type SatBondPositionView = {
  address: string;
  authority: string;
  bondMint: string;
  bondVault: string;
  expectedBondVault: string;
  amountRaw: string;
  bump?: number;
  policyVersion?: number;
  tier: number;
  tierLabel: "none" | "basic-bond" | "operator-bond";
  status: number;
  statusLabel: "inactive" | "active" | "unlocking" | "unlocked";
  createdAtSlot: number;
  updatedAtSlot: number;
  unlockRequestedAtSlot: number;
  unlockAvailableAtSlot: number;
  mintMatchesRuntime: boolean;
  vaultMatchesExpected: boolean;
};

export type SatBondTierPolicyView = {
  address: string;
  version: number;
  bump: number;
  policyVersion: number;
  basicMinRaw: string;
  operatorMinRaw: string;
  unlockDelaySlots: number;
  scheduledEffectiveSlot: number;
  lastUpdatedSlot: number;
  updateAuthority: string;
};

export type SatBondStakingDistributorView = {
  address: string;
  version: number;
  bump: number;
  status: number;
  statusLabel: "inactive" | "active";
  policyVersion: number;
  rewardMint: string;
  rewardVault: string;
  expectedRewardVault: string;
  updateAuthority: string;
  minStakeRaw: string;
  totalActiveStakeRaw: string;
  rewardIndexFp: string;
  observedRewardVaultRaw: string;
  unallocatedRewardRaw: string;
  fractionalRemainderFp: string;
  rewardVaultBalanceRaw?: string;
  lastSyncedSlot: number;
  mintMatchesRuntime: boolean;
  vaultMatchesExpected: boolean;
};

export type SatBondStakingPositionView = {
  address: string;
  version: number;
  status: number;
  statusLabel: "inactive" | "active";
  bump: number;
  policyVersion: number;
  authority: string;
  bondPosition: string;
  activeStakeRaw: string;
  claimableRewardRaw: string;
  rewardDebtFp: string;
  fractionalRemainderFp: string;
  lastSyncedSlot: number;
};

export type SatCycleRegistryMetaView = {
  address: string;
  cycleId: number;
  participantCount: number;
  pageCount: number;
  closeTrackingInitialized: boolean;
  remainingParticipantCount: number;
  remainingPageCount: number;
};

export type SatCycleRegistryPageView = {
  address: string;
  cycleId: number;
  pageIndex: number;
  participantCount: number;
  participants: string[];
};

export type SatCycleSettlementProgressV2View = {
  address: string;
  cycleId: number;
  expectedPageCount: number;
  processedPageCount: number;
  settleChunkIndex: number;
  scoredPageCount: number;
  scoreChunkIndex: number;
  distributedPageCount: number;
  distributeChunkIndex: number;
  finalized: boolean;
  scored: boolean;
  settleExclusiveUntilSlot?: number | undefined;
  finalizeExclusiveUntilSlot?: number | undefined;
  scoreExclusiveUntilSlot?: number | undefined;
  distributeExclusiveUntilSlot?: number | undefined;
  keeperBountyPaidLamports?: string | undefined;
  keeperBountyUnpaidLamports?: string | undefined;
};

export type SatTreasuryStateView = {
  address: string;
  pendingDistributorSatRaw: string;
  pendingTreasurySatRaw: string;
  pendingTreasurySolLamports: string;
};

export type SatPayoutReadinessView = {
  treasuryAddress: string;
  treasuryAta: string;
  recipientAta: string;
  treasuryAtaExists: boolean;
  recipientAtaExists: boolean;
  treasuryBalanceRaw?: string;
  recipientBalanceRaw?: string;
};

export type SatMiningStatusAccountsView = {
  globalState: SatGlobalStateView | null;
  currentCycle: SatCycleView | null;
  currentSettlementProgress: SatCycleSettlementProgressV2View | null;
  currentMinerCycle: SatMinerCycleView | null;
  claimMinerCycle: SatMinerCycleView | null;
  minerCapital: SatMinerCapitalView | null;
  payoutReadiness: SatPayoutReadinessView | null;
  treasuryState: SatTreasuryStateView | null;
};

type SatRepublishStatusReason = {
  code: string;
  message: string;
  openDisputeCount?: number;
};

type SatRepublishProposalCheck = {
  inputRoots: {
    bucketRoot: string;
    scoreRoot: string;
    coordinationRoot: string;
  };
  derivedRoots: {
    bucketRoot: string;
    scoreRoot: string;
    coordinationRoot: string;
  };
};

type SatRepublishStatus = {
  canRepublish: boolean;
  blockedReason: { kind: string; slashReasonCode?: number } | string | null;
  correctionSignal: {
    validatorRejectCount: number;
    slashReasonCode: number;
  };
  currentRoots: {
    bucketRoot: string;
    scoreRoot: string;
    coordinationRoot: string;
  };
  proposalCheck: SatRepublishProposalCheck | null;
  rejectionReasons: SatRepublishStatusReason[];
};

type SatDisputeView = {
  address: string;
  recordLocator: SatRecordLocator;
  validatorAuthority: string;
  targetAuthority: string;
  epochId: number;
  microRoundId: number;
  reasonCode: number;
  evidenceHash: string;
  targetRoot: string;
  openedAt: number;
  disputeDeadlineTs: number;
  statusFlag: number;
  statusLabel: string;
  epochClaimStatus?: {
    blocked: boolean;
    blockedReason: { kind: string; slashReasonCode?: number } | string | null;
    openDisputeCount: number;
    validatorRejectCount: number;
    slashReasonCode: number;
  };
  targetMiningStake: SatMiningStakeSummary;
};

type SatRoundAttestationListView = {
  validatorAuthority: string;
  epochId: number;
  microRoundId: number;
  count: number;
  filters: SatListFilters;
  attestations: SatValidatorAttestationView[];
};

type SatRoundDisputeListView = {
  validatorAuthority: string;
  epochId: number;
  microRoundId: number;
  count: number;
  filters: SatListFilters;
  disputes: SatDisputeView[];
};

type SatListSortField =
  | "targetAuthority"
  | "reasonCode"
  | "decisionFlag"
  | "slashPenaltyOwed"
  | "attestedAt"
  | "openedAt";

type SatListFilters = {
  reasonCode?: number;
  decisionFlag?: number;
  requireNonzeroSlashPenalty?: boolean;
  sortBy?: SatListSortField;
  sortOrder?: "asc" | "desc";
};

let solanaModulePromise: Promise<SolanaModuleLike> | null = null;
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

async function loadSolanaWeb3(): Promise<SolanaModuleLike> {
  solanaModulePromise ??= (async () => require("@solana/web3.js") as SolanaModuleLike)();
  return solanaModulePromise;
}

function encodeBase58(input: Uint8Array): string {
  if (input.length === 0) {
    return "";
  }
  let zeroCount = 0;
  while (zeroCount < input.length && input[zeroCount] === 0) {
    zeroCount += 1;
  }
  const digits = [0];
  for (const byte of input) {
    let carry = byte;
    for (let index = 0; index < digits.length; index += 1) {
      const value = digits[index] * 256 + carry;
      digits[index] = value % 58;
      carry = Math.floor(value / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let encoded = "";
  for (let index = 0; index < zeroCount; index += 1) {
    encoded += BASE58_ALPHABET[0];
  }
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    encoded += BASE58_ALPHABET[digits[index]];
  }
  return encoded;
}

function encodeU64(value: number): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(BigInt(value));
  return out;
}

function readPubkey(buffer: Buffer, offset: number) {
  return encodeBase58(buffer.subarray(offset, offset + 32));
}

function readHash32(buffer: Buffer, offset: number) {
  return buffer.subarray(offset, offset + 32).toString("hex");
}

function readU64String(buffer: Buffer, offset: number) {
  return buffer.readBigUInt64LE(offset).toString();
}

function readU128String(buffer: Buffer, offset: number) {
  const low = buffer.readBigUInt64LE(offset);
  const high = buffer.readBigUInt64LE(offset + 8);
  return ((high << 64n) + low).toString();
}

function readU64Number(buffer: Buffer, offset: number) {
  return Number(buffer.readBigUInt64LE(offset));
}

function readI64Number(buffer: Buffer, offset: number) {
  return Number(buffer.readBigInt64LE(offset));
}

function encodeI64(value: number): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigInt64LE(BigInt(value));
  return out;
}

function normalizeHex32(value: string) {
  return value.trim().toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

function hash256Hex(input: Buffer): string {
  return `0x${createHash("sha3-256").update(input).digest("hex")}`;
}

function hashParts(parts: Uint8Array[]) {
  return hash256Hex(Buffer.concat(parts.map((part) => Buffer.from(part)))).slice(2);
}

function expectAccountData(data: Buffer, discriminator: number, label: string) {
  if (data.length < 8 || data[0] !== discriminator) {
    throw new Error(`invalid ${label} account discriminator`);
  }
  return data.subarray(8);
}

function decodeMiningStake(data: Buffer): SatMiningStakeSummary {
  const body = expectAccountData(data, ACCOUNT_DISCRIMINATOR.miningStake, "mining stake");
  return {
    authority: readPubkey(body, 0),
    shares: readU64String(body, 32),
    originalStake: readU64String(body, 40),
    rewardOwed: readU64String(body, 64),
    jackpotOwed: readU64String(body, 72),
    slashPenaltyOwed: readU64String(body, 80),
    autoUnstakeThresholdBps: readU64Number(body, 112),
  };
}

export function decodeSatRoundBucket(data: Buffer, address: string): SatRoundBucketView {
  const body = expectAccountData(data, ACCOUNT_DISCRIMINATOR.satRoundBucket, "SAT round bucket");
  return {
    address,
    epochId: readU64Number(body, 0),
    microRoundId: readU64Number(body, 8),
    bucketVersion: readU64Number(body, 16),
    roundOpenTs: readI64Number(body, 24),
    roundCloseTs: readI64Number(body, 32),
    roundSeed: readHash32(body, 56),
    bucketHash: readHash32(body, 88),
  };
}

function decodeValidatorAttestation(
  data: Buffer,
  address: string,
): Omit<SatValidatorAttestationView, "targetMiningStake"> {
  const body = expectAccountData(
    data,
    ACCOUNT_DISCRIMINATOR.satValidatorAttestation,
    "SAT validator attestation",
  );
  return {
    address,
    recordLocator: buildRecordLocator(
      readPubkey(body, 0),
      readPubkey(body, 32),
      readU64Number(body, 64),
      readU64Number(body, 72),
    ),
    validatorAuthority: readPubkey(body, 0),
    targetAuthority: readPubkey(body, 32),
    epochId: readU64Number(body, 64),
    microRoundId: readU64Number(body, 72),
    decisionFlag: readU64Number(body, 80),
    decisionLabel:
      readU64Number(body, 80) === 1
        ? "accept"
        : readU64Number(body, 80) === 2
          ? "reject"
          : "unknown",
    reasonCode: body.readUInt16LE(88),
    bucketRoot: readHash32(body, 96),
    scoreRoot: readHash32(body, 128),
    coordinationRoot: readHash32(body, 160),
    evidenceHash: readHash32(body, 192),
    attestedAt: readI64Number(body, 224),
  };
}

function decodeDispute(data: Buffer, address: string): Omit<SatDisputeView, "targetMiningStake"> {
  const body = expectAccountData(data, ACCOUNT_DISCRIMINATOR.satDispute, "SAT dispute");
  return {
    address,
    recordLocator: buildRecordLocator(
      readPubkey(body, 0),
      readPubkey(body, 32),
      readU64Number(body, 64),
      readU64Number(body, 72),
    ),
    validatorAuthority: readPubkey(body, 0),
    targetAuthority: readPubkey(body, 32),
    epochId: readU64Number(body, 64),
    microRoundId: readU64Number(body, 72),
    reasonCode: body.readUInt16LE(80),
    evidenceHash: readHash32(body, 88),
    targetRoot: readHash32(body, 120),
    openedAt: readI64Number(body, 152),
    disputeDeadlineTs: readI64Number(body, 160),
    statusFlag: readU64Number(body, 168),
    statusLabel: satDisputeStatusLabel(readU64Number(body, 168)),
  };
}

function decodeSatEpoch(data: Buffer, address: string): SatEpochView {
  const body = expectAccountData(data, ACCOUNT_DISCRIMINATOR.satEpoch, "SAT epoch");
  const claimsBlocked = readU64Number(body, 104) === 1;
  const openDisputeCount = readU64Number(body, 96);
  const validatorRejectCount = readU64Number(body, 88);
  const slashReasonCode = body.readUInt16LE(160);
  return {
    address,
    epochId: readU64Number(body, 0),
    claimsBlocked,
    blockedReason: buildBlockedReason({
      claimsBlocked,
      openDisputeCount,
      validatorRejectCount,
      slashReasonCode,
    }),
    openDisputeCount,
    validatorRejectCount,
    slashReasonCode,
    bucketRoot: readHash32(body, 168),
    scoreRoot: readHash32(body, 200),
    coordinationRoot: readHash32(body, 232),
    republishStatus: buildRepublishStatus({
      epochId: readU64Number(body, 0),
      claimsBlocked,
      openDisputeCount,
      validatorRejectCount,
      slashReasonCode,
      bucketRoot: readHash32(body, 168),
      scoreRoot: readHash32(body, 200),
      coordinationRoot: readHash32(body, 232),
      startTs: readI64Number(body, 8),
      endTs: readI64Number(body, 16),
      microRoundsTotal: readU64Number(body, 24),
      validWalletCount: readU64Number(body, 64),
      baseEligibleWalletCount: readU64Number(body, 72),
      skillEligibleWalletCount: readU64Number(body, 80),
    }),
    epoch: {
      startTs: readI64Number(body, 8),
      endTs: readI64Number(body, 16),
      microRoundsTotal: readU64Number(body, 24),
      validWalletCount: readU64Number(body, 64),
      baseEligibleWalletCount: readU64Number(body, 72),
      skillEligibleWalletCount: readU64Number(body, 80),
      settledEmissionSat: readU64Number(body, 112),
    },
  };
}

function decodeSatWalletEpoch(data: Buffer, address: string): SatWalletEpochView {
  const body = expectAccountData(data, ACCOUNT_DISCRIMINATOR.satWalletEpoch, "SAT wallet epoch");
  return {
    address,
    authority: readPubkey(body, 0),
    aggregateScoreFp: readU128String(body, 32),
    epochId: readU64Number(body, 48),
    validRoundCount: readU64Number(body, 56),
    heartbeatCount: readU64Number(body, 64),
    revealFaultCount: readU64Number(body, 72),
    finalizationFaultCount: readU64Number(body, 80),
    baseEligible: readU64Number(body, 88) === 1,
    skillEligible: readU64Number(body, 96) === 1,
    settled: readU64Number(body, 104) === 1,
    baseRewardSatOwed: readU64String(body, 112),
    skillRewardSatOwed: readU64String(body, 120),
    rebateSolOwed: readU64String(body, 128),
    performanceSolOwed: readU64String(body, 136),
  };
}

function decodeSatRoundCommit(data: Buffer, address: string): SatRoundCommitView {
  const body = expectAccountData(data, ACCOUNT_DISCRIMINATOR.satRoundCommit, "SAT round commit");
  return {
    address,
    authority: readPubkey(body, 0),
    epochId: readU64Number(body, 32),
    microRoundId: readU64Number(body, 40),
    submittedAt: readI64Number(body, 48),
    revealed: readU64Number(body, 56) === 1,
    finalized: readU64Number(body, 64) === 1,
    allocationSum: readU64String(body, 72),
    revealBucketHash: readHash32(body, 208),
  };
}

function decodeSatRoundState(data: Buffer, address: string): SatRoundStateView {
  const body = expectAccountData(data, ACCOUNT_DISCRIMINATOR.satRoundState, "SAT round state");
  return {
    address,
    epochId: readU64Number(body, 0),
    microRoundId: readU64Number(body, 8),
    bucketHash: readHash32(body, 16),
    revealedWalletCount: readU64Number(body, 48),
    finalized: readU64Number(body, 152) === 1,
  };
}

export function decodeSatGlobalState(data: Buffer, address: string): SatGlobalStateView {
  const body = expectAccountData(data, ACCOUNT_DISCRIMINATOR.satGlobalState, "SAT global state");
  return {
    address,
    version: readU64Number(body, 0),
    hardCapSatRaw: readU64String(body, 72),
    issuanceYearIndex: readU64Number(body, 80),
    yearBudgetSatRaw: readU64String(body, 88),
    yearIssuedSatRaw: readU64String(body, 96),
    currentUnlockSolLamports: readU64String(body, 128),
    cycleSeconds: readU64Number(body, 144),
    minimumEntryLamports: readU64String(body, 152),
    launchCycleId: readU64String(body, 160),
    totalIssuedSatRaw: readU64String(body, 168),
    cycleErosionPpm: readU64Number(body, 184),
    treasuryRecipient: readPubkey(body, 192),
    distributorRecipient: readPubkey(body, 224),
  };
}

export function decodeSatCycle(data: Buffer, address: string): SatCycleView {
  const body = expectAccountData(data, ACCOUNT_DISCRIMINATOR.satCycleState, "SAT cycle state");
  const validMinerCount = readU64String(body, 192);
  const cycleSeed = readHash32(body, 40);
  return {
    address,
    cycleId: readU64Number(body, 0),
    openTs: readI64Number(body, 8),
    closeTs: readI64Number(body, 16),
    status: body.readUInt8(24),
    cycleSeed,
    entropyUnavailable: cycleSeed === SAT_PROTOCOL_CONSTANTS.entropyUnavailableSeedHex,
    unlockTargetLamports: readU64String(body, 176),
    totalCommittedLamports: readU64String(body, 184),
    validMinerCount,
    unlockRatioFp: readU64String(body, 200),
    issuedCycleMinerSatRaw: readU64String(body, 208),
    unissuedCycleMinerSatRaw: readU64String(body, 216),
    solErosionPoolLamports: readU64String(body, 224),
    deterministicRebatePoolLamports: readU64String(body, 232),
    performanceRebatePoolLamports: readU64String(body, 240),
    treasurySolLamports: readU64String(body, 248),
    submittedSolErosionPoolLamports: readU64String(body, 256),
    keeperBountyPaidLamports: readU64String(body, 264),
    commitDeadlineTs: readI64Number(body, 272),
    revealDeadlineTs: readI64Number(body, 280),
    entropyTargetSlot: readU64Number(body, 288),
    committedMinerCount: readU64String(body, 296),
    revealedMinerCount: validMinerCount,
    resolvedCommitCount: readU64String(body, 304),
    entropySealedSlot: readU64Number(body, 312),
    ...(body.length >= 368
      ? {
          openSlot: readU64Number(body, 320),
          commitDeadlineSlot: readU64Number(body, 328),
          revealDeadlineSlot: readU64Number(body, 336),
          entropyHashCount: readU64Number(body, 344),
          unlockIntervalStartCycleId: readU64Number(body, 352),
          releasedCommitCount: readU64String(body, 360),
        }
      : {}),
  };
}

export function decodeSatMinerCycle(data: Buffer, address: string): SatMinerCycleView {
  const body = expectAccountData(
    data,
    ACCOUNT_DISCRIMINATOR.satMinerCycleState,
    "SAT miner cycle state",
  );
  return {
    address,
    placementReturnFp: readU128String(body, 0),
    benchmarkReturnFp: readU128String(body, 16),
    skillScoreFp: readU128String(body, 32),
    rewardWeightFp: readU128String(body, 48),
    authority: readPubkey(body, 64),
    cycleId: readU64Number(body, 96),
    committedLamports: readU64String(body, 104),
    submissionTs: readI64Number(body, 112),
    powerWeightFp: readU64String(body, 120),
    claimableSatRaw: readU64String(body, 128),
    claimableDetRebateLamports: readU64String(body, 136),
    claimablePerfRebateLamports: readU64String(body, 144),
    claimedSatRaw: readU64String(body, 152),
    claimedDetRebateLamports: readU64String(body, 160),
    claimedPerfRebateLamports: readU64String(body, 168),
    validParticipation: body.readUInt8(176) === 1,
    capitalLockReleased: body.readUInt8(177) === 1,
    ...(body.length >= 336
      ? {
          commitment: readHash32(body, 184),
          commitSlot: readU64Number(body, 216),
          revealSlot: readU64Number(body, 224),
        }
      : {}),
    ...(body.length >= 344
      ? {
          lockedCollateralLamports: readU64String(body, 232),
        }
      : {}),
  };
}

function decodeSatMinerCapital(data: Buffer, address: string): SatMinerCapitalView {
  const body = expectAccountData(
    data,
    ACCOUNT_DISCRIMINATOR.satMinerCapitalState,
    "SAT miner capital state",
  );
  const fundedLamports = readU64String(body, 40);
  const lockedLamports = readU64String(body, 48);
  return {
    address,
    authority: readPubkey(body, 8),
    fundedLamports,
    lockedLamports,
    freeLamports: (() => {
      try {
        return (BigInt(fundedLamports) - BigInt(lockedLamports)).toString();
      } catch {
        return "0";
      }
    })(),
    activeCommitLamports: readU64String(body, 56),
    firstPendingCycleId: readU64Number(body, 64),
    lastPendingCycleId: readU64Number(body, 72),
  };
}

function resolveBondTierLabel(
  amountRaw: bigint,
  tierByte: number,
): SatBondPositionView["tierLabel"] {
  const layout = loadSatBondLayout();
  if (tierByte === layout.tier.operator) {
    return "operator-bond";
  }
  if (tierByte === layout.tier.basic) {
    return "basic-bond";
  }
  if (layout.thresholds && amountRaw >= BigInt(layout.thresholds.operatorMinRaw)) {
    return "operator-bond";
  }
  if (layout.thresholds && amountRaw >= BigInt(layout.thresholds.basicMinRaw)) {
    return "basic-bond";
  }
  return "none";
}

function resolveBondStatusLabel(statusByte: number): SatBondPositionView["statusLabel"] {
  const layout = loadSatBondLayout();
  if (statusByte === layout.status.active) {
    return "active";
  }
  if (statusByte === layout.status.unlocking) {
    return "unlocking";
  }
  if (statusByte === layout.status.unlocked) {
    return "unlocked";
  }
  return "inactive";
}

export function decodeSatBondPosition(data: Buffer, address: string): SatBondPositionView {
  const layout = loadSatBondLayout();
  const body = expectAccountData(data, layout.discriminator, "SAT bond position state");
  const amountRawString = readU64String(body, layout.offsets.amountRaw);
  const amountRaw = BigInt(amountRawString);
  const authority = readPubkey(body, layout.offsets.authority);
  const bondMint = readPubkey(body, layout.offsets.bondMint);
  const bondVault = readPubkey(body, layout.offsets.bondVault);
  const solana = require("@solana/web3.js") as SolanaModuleLike;
  const expectedBondVault = deriveAssociatedTokenAddress(
    solana,
    new solana.PublicKey(address),
    new solana.PublicKey(SAT_MINT_ADDRESS()),
  ).toBase58();
  const status = body[layout.offsets.status] ?? 0;
  const tier = body[layout.offsets.tier] ?? 0;
  return {
    address,
    authority,
    bondMint,
    bondVault,
    expectedBondVault,
    amountRaw: amountRawString,
    bump: layout.offsets.bump != null ? (body[layout.offsets.bump] ?? 0) : undefined,
    policyVersion:
      layout.offsets.policyVersion != null
        ? body.readUInt32LE(layout.offsets.policyVersion)
        : undefined,
    tier,
    tierLabel: resolveBondTierLabel(amountRaw, tier),
    status,
    statusLabel: resolveBondStatusLabel(status),
    createdAtSlot: readU64Number(body, layout.offsets.createdAtSlot),
    updatedAtSlot: readU64Number(body, layout.offsets.updatedAtSlot),
    unlockRequestedAtSlot: readU64Number(body, layout.offsets.unlockRequestedAtSlot),
    unlockAvailableAtSlot: readU64Number(body, layout.offsets.unlockAvailableAtSlot),
    mintMatchesRuntime: bondMint === SAT_MINT_ADDRESS(),
    vaultMatchesExpected: bondVault === expectedBondVault,
  };
}

function decodeSatBondTierPolicy(data: Buffer, address: string): SatBondTierPolicyView {
  const layout = loadSatBondPolicyLayout();
  const body = expectAccountData(data, layout.discriminator, "SAT bond tier policy state");
  return {
    address,
    version: body[layout.offsets.version] ?? 0,
    bump: body[layout.offsets.bump] ?? 0,
    policyVersion: Number(body.readBigUInt64LE(layout.offsets.policyVersion)),
    basicMinRaw: readU64String(body, layout.offsets.basicMinRaw),
    operatorMinRaw: readU64String(body, layout.offsets.operatorMinRaw),
    unlockDelaySlots: readU64Number(body, layout.offsets.unlockDelaySlots),
    scheduledEffectiveSlot: readU64Number(body, layout.offsets.scheduledEffectiveSlot),
    lastUpdatedSlot: readU64Number(body, layout.offsets.lastUpdatedSlot),
    updateAuthority: readPubkey(body, layout.offsets.updateAuthority),
  };
}

export function decodeSatBondStakingDistributor(
  data: Buffer,
  address: string,
): SatBondStakingDistributorView {
  const layout = loadSatBondStakingDistributorLayout();
  const body = expectAccountData(data, layout.discriminator, "SAT bond staking distributor state");
  const rewardMint = readPubkey(body, layout.offsets.rewardMint);
  const rewardVault = readPubkey(body, layout.offsets.rewardVault);
  const solana = require("@solana/web3.js") as SolanaModuleLike;
  const expectedRewardVault = deriveAssociatedTokenAddress(
    solana,
    new solana.PublicKey(address),
    new solana.PublicKey(SAT_MINT_ADDRESS()),
  ).toBase58();
  const status = body[layout.offsets.status] ?? 0;
  return {
    address,
    version: body[layout.offsets.version] ?? 0,
    bump: body[layout.offsets.bump] ?? 0,
    status,
    statusLabel: status === 1 ? "active" : "inactive",
    policyVersion: readU64Number(body, layout.offsets.policyVersion),
    rewardMint,
    rewardVault,
    expectedRewardVault,
    updateAuthority: readPubkey(body, layout.offsets.updateAuthority),
    minStakeRaw: readU64String(body, layout.offsets.minStakeRaw),
    totalActiveStakeRaw: readU64String(body, layout.offsets.totalActiveStakeRaw),
    rewardIndexFp: readU128String(body, layout.offsets.rewardIndexFp),
    observedRewardVaultRaw: readU64String(body, layout.offsets.observedRewardVaultRaw),
    unallocatedRewardRaw: readU64String(body, layout.offsets.unallocatedRewardRaw),
    fractionalRemainderFp: readU64String(body, layout.offsets.fractionalRemainderFp),
    lastSyncedSlot: readU64Number(body, layout.offsets.lastSyncedSlot),
    mintMatchesRuntime: rewardMint === SAT_MINT_ADDRESS(),
    vaultMatchesExpected: rewardVault === expectedRewardVault,
  };
}

function decodeSatBondStakingPosition(data: Buffer, address: string): SatBondStakingPositionView {
  const layout = loadSatBondStakingPositionLayout();
  const body = expectAccountData(data, layout.discriminator, "SAT bond staking position state");
  const status = body[layout.offsets.status] ?? 0;
  return {
    address,
    version: body[layout.offsets.version] ?? 0,
    status,
    statusLabel: status === 1 ? "active" : "inactive",
    bump: body[layout.offsets.bump] ?? 0,
    policyVersion: readU64Number(body, layout.offsets.policyVersion),
    authority: readPubkey(body, layout.offsets.authority),
    bondPosition: readPubkey(body, layout.offsets.bondPosition),
    activeStakeRaw: readU64String(body, layout.offsets.activeStakeRaw),
    claimableRewardRaw: readU64String(body, layout.offsets.claimableRewardRaw),
    rewardDebtFp: readU128String(body, layout.offsets.rewardDebtFp),
    fractionalRemainderFp: readU64String(body, layout.offsets.fractionalRemainderFp),
    lastSyncedSlot: readU64Number(body, layout.offsets.lastSyncedSlot),
  };
}

function decodeSatCycleRegistryMeta(data: Buffer, address: string): SatCycleRegistryMetaView {
  const body = expectAccountData(
    data,
    ACCOUNT_DISCRIMINATOR.satCycleRegistryMeta,
    "SAT cycle registry meta",
  );
  const closeTrackingInitialized = (body[22] ?? 0) !== 0;
  const participantCount = body.readUInt32LE(8);
  const pageCount = body.readUInt16LE(12);
  return {
    address,
    cycleId: readU64Number(body, 0),
    participantCount,
    pageCount,
    closeTrackingInitialized,
    remainingParticipantCount: closeTrackingInitialized ? body.readUInt32LE(16) : participantCount,
    remainingPageCount: closeTrackingInitialized ? body.readUInt16LE(20) : pageCount,
  };
}

export function decodeSatCycleRegistryPage(
  data: Buffer,
  address: string,
): SatCycleRegistryPageView {
  const body = expectAccountData(
    data,
    ACCOUNT_DISCRIMINATOR.satCycleRegistryPage,
    "SAT cycle registry page",
  );
  const participantCount = body.readUInt16LE(10);
  const participants: string[] = [];
  for (let index = 0; index < participantCount; index += 1) {
    participants.push(readPubkey(body, 16 + index * 32));
  }
  return {
    address,
    cycleId: readU64Number(body, 0),
    pageIndex: body.readUInt16LE(8),
    participantCount,
    participants,
  };
}

export function decodeSatCycleSettlementProgressV2(
  data: Buffer,
  address: string,
): SatCycleSettlementProgressV2View {
  const body = expectAccountData(
    data,
    ACCOUNT_DISCRIMINATOR.satCycleSettlementProgressV2,
    "SAT cycle settlement progress v2",
  );
  return {
    address,
    cycleId: readU64Number(body, 0),
    expectedPageCount: body.readUInt16LE(112),
    processedPageCount: body.readUInt16LE(114),
    settleChunkIndex: body.readUInt16LE(116),
    scoredPageCount: body.readUInt16LE(118),
    scoreChunkIndex: body.readUInt16LE(120),
    distributedPageCount: body.readUInt16LE(122),
    distributeChunkIndex: body.readUInt16LE(124),
    finalized: body.readUInt8(126) === 1,
    scored: body.readUInt8(127) === 1,
    settleExclusiveUntilSlot: readU64Number(body, 976),
    finalizeExclusiveUntilSlot: readU64Number(body, 984),
    scoreExclusiveUntilSlot: readU64Number(body, 992),
    distributeExclusiveUntilSlot: readU64Number(body, 1000),
    keeperBountyPaidLamports: readU64String(body, 1008),
    keeperBountyUnpaidLamports: readU64String(body, 1016),
  };
}

function decodeSatTreasuryState(data: Buffer, address: string): SatTreasuryStateView {
  const body = expectAccountData(
    data,
    ACCOUNT_DISCRIMINATOR.satTreasuryState,
    "SAT treasury state",
  );
  return {
    address,
    pendingDistributorSatRaw: readU64String(body, 0),
    pendingTreasurySatRaw: readU64String(body, 8),
    pendingTreasurySolLamports: readU64String(body, 16),
  };
}

function buildRepublishStatus(
  epoch: {
    epochId: number;
    claimsBlocked: boolean;
    openDisputeCount: number;
    validatorRejectCount: number;
    slashReasonCode: number;
    bucketRoot: string;
    scoreRoot: string;
    coordinationRoot: string;
    startTs: number;
    endTs: number;
    microRoundsTotal: number;
    validWalletCount: number;
    baseEligibleWalletCount: number;
    skillEligibleWalletCount: number;
  },
  proposal?: { bucketRoot: string; scoreRoot: string; coordinationRoot: string },
): SatRepublishStatus {
  const rejectionReasons: SatRepublishStatusReason[] = [];
  const blockedReason = buildBlockedReason(epoch);
  if (!epoch.claimsBlocked) {
    rejectionReasons.push({
      code: "epoch_not_blocked",
      message: "epoch claims are not blocked",
    });
  }
  if (epoch.openDisputeCount > 0) {
    rejectionReasons.push({
      code: "open_disputes_present",
      message: "open disputes must be resolved before republishing corrected roots",
      openDisputeCount: epoch.openDisputeCount,
    });
  }
  if (epoch.slashReasonCode === 0 && epoch.validatorRejectCount === 0) {
    rejectionReasons.push({
      code: "no_correction_signal",
      message: "epoch has no slash reason or validator reject signal requiring corrected roots",
    });
  }

  let proposalCheck: SatRepublishProposalCheck | null = null;
  if (proposal) {
    const inputRoots = {
      bucketRoot: normalizeHex32(proposal.bucketRoot),
      scoreRoot: normalizeHex32(proposal.scoreRoot),
      coordinationRoot: normalizeHex32(proposal.coordinationRoot),
    };
    if (
      inputRoots.bucketRoot === "0".repeat(64) ||
      inputRoots.scoreRoot === "0".repeat(64) ||
      inputRoots.coordinationRoot === "0".repeat(64)
    ) {
      rejectionReasons.push({
        code: "zero_replacement_root",
        message: "replacement roots must all be non-zero",
      });
    }
    const eligibilitySummary = hashParts([
      encodeU64(epoch.epochId),
      encodeU64(epoch.validWalletCount),
      encodeU64(epoch.baseEligibleWalletCount),
      encodeU64(epoch.skillEligibleWalletCount),
      encodeU64(epoch.microRoundsTotal),
    ]);
    const derivedRoots = {
      bucketRoot: hashParts([
        Buffer.from(inputRoots.bucketRoot, "hex"),
        Buffer.from(eligibilitySummary, "hex"),
        encodeI64(epoch.startTs),
        encodeI64(epoch.endTs),
      ]),
      scoreRoot: hashParts([
        Buffer.from(inputRoots.scoreRoot, "hex"),
        Buffer.from(eligibilitySummary, "hex"),
        encodeU64(epoch.validWalletCount),
      ]),
      coordinationRoot: hashParts([
        Buffer.from("sat-corrected-coordination-root-v1", "utf8"),
        Buffer.from(inputRoots.coordinationRoot, "hex"),
        encodeU64(epoch.epochId),
      ]),
    };
    if (
      derivedRoots.bucketRoot === normalizeHex32(epoch.bucketRoot) &&
      derivedRoots.scoreRoot === normalizeHex32(epoch.scoreRoot) &&
      derivedRoots.coordinationRoot === normalizeHex32(epoch.coordinationRoot)
    ) {
      rejectionReasons.push({
        code: "unchanged_corrected_roots",
        message: "derived corrected roots would not change the current epoch roots",
      });
    }
    proposalCheck = { inputRoots, derivedRoots };
  }

  return {
    canRepublish: rejectionReasons.length === 0,
    blockedReason,
    correctionSignal: {
      validatorRejectCount: epoch.validatorRejectCount,
      slashReasonCode: epoch.slashReasonCode,
    },
    currentRoots: {
      bucketRoot: normalizeHex32(epoch.bucketRoot),
      scoreRoot: normalizeHex32(epoch.scoreRoot),
      coordinationRoot: normalizeHex32(epoch.coordinationRoot),
    },
    proposalCheck,
    rejectionReasons,
  };
}

export function inspectSatRepublishProposal(
  epoch: SatEpochView,
  proposal: { bucketRoot: string; scoreRoot: string; coordinationRoot: string },
): SatRepublishStatus {
  return buildRepublishStatus(
    {
      epochId: epoch.epochId,
      claimsBlocked: epoch.claimsBlocked,
      openDisputeCount: epoch.openDisputeCount,
      validatorRejectCount: epoch.validatorRejectCount,
      slashReasonCode: epoch.slashReasonCode,
      bucketRoot: epoch.bucketRoot,
      scoreRoot: epoch.scoreRoot,
      coordinationRoot: epoch.coordinationRoot,
      startTs: epoch.epoch.startTs,
      endTs: epoch.epoch.endTs,
      microRoundsTotal: epoch.epoch.microRoundsTotal,
      validWalletCount: epoch.epoch.validWalletCount,
      baseEligibleWalletCount: epoch.epoch.baseEligibleWalletCount,
      skillEligibleWalletCount: epoch.epoch.skillEligibleWalletCount,
    },
    proposal,
  );
}

function satDisputeStatusLabel(statusFlag: number) {
  switch (statusFlag) {
    case 1:
      return "open";
    case 2:
      return "resolved_dismissed";
    case 3:
      return "resolved_upheld";
    default:
      return "unknown";
  }
}

function buildBlockedReason(params: {
  claimsBlocked: boolean;
  openDisputeCount: number;
  validatorRejectCount: number;
  slashReasonCode: number;
}) {
  if (!params.claimsBlocked) {
    return null;
  }
  if (params.openDisputeCount > 0) {
    return "open_disputes";
  }
  if (params.validatorRejectCount > 0) {
    return "validator_rejects";
  }
  if (params.slashReasonCode !== 0) {
    return {
      kind: "corrected_roots_required",
      slashReasonCode: params.slashReasonCode,
    };
  }
  return "blocked";
}

function buildRecordLocator(
  validatorAuthority: string,
  targetAuthority: string,
  epochId: number,
  microRoundId: number,
): SatRecordLocator {
  return {
    roundKey: `${epochId}:${microRoundId}`,
    epochId,
    microRoundId,
    validatorAuthority,
    targetAuthority,
  };
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

type SatReadRpcConfig = {
  primaryUrl: string;
  secondaryUrl: string | null;
};

type SatReadRpcRuntimeState = {
  lastMode: "primary" | "fallback" | "unavailable";
  fallbackCount: number;
  lastError: string | null;
  lastFailureAt: string | null;
  lastSuccessAt: string | null;
  lastRpcUrl: string | null;
  quotaLikely: boolean;
};

type SatReadRpcEndpointState = {
  consecutiveFailures: number;
  backoffUntilMs: number;
  quotaLikely: boolean;
  lastError: string | null;
  lastFailureAt: string | null;
  lastSuccessAt: string | null;
};

type SatRpcMethodBucket = {
  requests: number;
  successes: number;
  failures: number;
};

type SatRpcMethodMetricState = {
  requestsSinceStart: number;
  successesSinceStart: number;
  failuresSinceStart: number;
  lastRequestAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  buckets: Map<number, SatRpcMethodBucket>;
};

type SatRpcAccountReadMetricState = {
  requestsSinceStart: number;
  successesSinceStart: number;
  nullsSinceStart: number;
  failuresSinceStart: number;
  lastRequestAt: string | null;
  lastSuccessAt: string | null;
  lastNullAt: string | null;
  lastFailureAt: string | null;
};

const satReadRpcRuntimeState: SatReadRpcRuntimeState = {
  lastMode: "unavailable",
  fallbackCount: 0,
  lastError: null,
  lastFailureAt: null,
  lastSuccessAt: null,
  lastRpcUrl: null,
  quotaLikely: false,
};
const satReadRpcEndpointStates = new Map<string, SatReadRpcEndpointState>();

type SatReadConnectionLike = {
  rpcEndpoint: string;
  secondaryRpcEndpoint: string | null;
  getAccountInfo: InstanceType<SolanaModuleLike["Connection"]>["getAccountInfo"];
  getProgramAccounts: InstanceType<SolanaModuleLike["Connection"]>["getProgramAccounts"];
  getMinimumBalanceForRentExemption: InstanceType<
    SolanaModuleLike["Connection"]
  >["getMinimumBalanceForRentExemption"];
};

type SatReadMethodName = keyof Pick<
  SatReadConnectionLike,
  "getAccountInfo" | "getProgramAccounts" | "getMinimumBalanceForRentExemption"
>;

type SatRpcAccountRecord = {
  owner: string | null;
  data: Buffer;
} | null;

function readPositiveIntEnv(name: string, fallback: number): number {
  const value = Number.parseInt(String(process.env[name] ?? ""), 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const SAT_RPC_ACCOUNT_RECORD_CACHE_TTL_MS = readPositiveIntEnv(
  "FASED_SAT_RPC_ACCOUNT_CACHE_TTL_MS",
  30_000,
);
const SAT_RPC_BALANCE_CACHE_TTL_MS = readPositiveIntEnv(
  "FASED_SAT_RPC_BALANCE_CACHE_TTL_MS",
  15_000,
);
const SAT_RPC_PAYOUT_READINESS_CACHE_TTL_MS = 60_000;
const SAT_RPC_LIVE_VIEW_CACHE_TTL_MS = readPositiveIntEnv(
  "FASED_SAT_RPC_LIVE_VIEW_CACHE_TTL_MS",
  30_000,
);
const SAT_RPC_STABLE_VIEW_CACHE_TTL_MS = 60_000;
const SAT_RPC_RENT_EXEMPTION_CACHE_TTL_MS = 5 * 60_000;
const SAT_RPC_METHOD_METRIC_BUCKET_MS = 60 * 60_000;
const SAT_RPC_METHOD_METRIC_RETENTION_MS = 24 * 60 * 60_000;
const SAT_RPC_QUOTA_BACKOFF_MS = 30_000;
const SAT_RPC_FAILURE_BACKOFF_THRESHOLD = 2;
const SAT_RPC_FAILURE_BACKOFF_BASE_MS = 5_000;
const SAT_RPC_FAILURE_BACKOFF_MAX_MS = 30_000;
const SAT_RPC_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

function satRpcRequestTimeoutMs(): number {
  return readPositiveIntEnv("FASED_SAT_RPC_REQUEST_TIMEOUT_MS", 10_000);
}

const satRpcReadCache = new Map<string, { expiresAt: number; value: unknown }>();
const satRpcReadInFlight = new Map<string, Promise<unknown>>();
const satRpcMethodMetrics = new Map<string, SatRpcMethodMetricState>();
const satRpcAccountReadMetrics = new Map<string, SatRpcAccountReadMetricState>();
let satRpcReadCacheGeneration = 0;

function normalizeAccountReadLabel(label: string | undefined): string {
  return String(label ?? "").trim() || "unlabeled";
}

function getOrCreateSatRpcAccountReadMetric(label: string): SatRpcAccountReadMetricState {
  const normalized = normalizeAccountReadLabel(label);
  const existing = satRpcAccountReadMetrics.get(normalized);
  if (existing) {
    return existing;
  }
  const created: SatRpcAccountReadMetricState = {
    requestsSinceStart: 0,
    successesSinceStart: 0,
    nullsSinceStart: 0,
    failuresSinceStart: 0,
    lastRequestAt: null,
    lastSuccessAt: null,
    lastNullAt: null,
    lastFailureAt: null,
  };
  satRpcAccountReadMetrics.set(normalized, created);
  return created;
}

function updateSatRpcAccountReadMetric(
  label: string | undefined,
  outcome: "request" | "success" | "null" | "failure",
  nowMs = Date.now(),
) {
  const entry = getOrCreateSatRpcAccountReadMetric(normalizeAccountReadLabel(label));
  const at = new Date(nowMs).toISOString();
  if (outcome === "request") {
    entry.requestsSinceStart += 1;
    entry.lastRequestAt = at;
  } else if (outcome === "success") {
    entry.successesSinceStart += 1;
    entry.lastSuccessAt = at;
  } else if (outcome === "null") {
    entry.nullsSinceStart += 1;
    entry.lastNullAt = at;
  } else {
    entry.failuresSinceStart += 1;
    entry.lastFailureAt = at;
  }
}

function getOrCreateSatRpcMethodMetric(method: string): SatRpcMethodMetricState {
  const trimmedMethod = String(method ?? "").trim() || "unknown";
  const existing = satRpcMethodMetrics.get(trimmedMethod);
  if (existing) {
    return existing;
  }
  const created: SatRpcMethodMetricState = {
    requestsSinceStart: 0,
    successesSinceStart: 0,
    failuresSinceStart: 0,
    lastRequestAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    buckets: new Map<number, SatRpcMethodBucket>(),
  };
  satRpcMethodMetrics.set(trimmedMethod, created);
  return created;
}

function pruneSatRpcMethodMetricBuckets(entry: SatRpcMethodMetricState, nowMs: number) {
  const retentionStartMs = nowMs - SAT_RPC_METHOD_METRIC_RETENTION_MS;
  for (const bucketStartMs of [...entry.buckets.keys()]) {
    if (bucketStartMs < retentionStartMs) {
      entry.buckets.delete(bucketStartMs);
    }
  }
}

function updateSatRpcMethodMetric(
  method: string,
  outcome: "request" | "success" | "failure",
  nowMs = Date.now(),
) {
  const entry = getOrCreateSatRpcMethodMetric(method);
  const bucketStartMs = nowMs - (nowMs % SAT_RPC_METHOD_METRIC_BUCKET_MS);
  const bucket = entry.buckets.get(bucketStartMs) ?? {
    requests: 0,
    successes: 0,
    failures: 0,
  };
  const at = new Date(nowMs).toISOString();
  if (outcome === "request") {
    entry.requestsSinceStart += 1;
    entry.lastRequestAt = at;
    bucket.requests += 1;
  } else if (outcome === "success") {
    entry.successesSinceStart += 1;
    entry.lastSuccessAt = at;
    bucket.successes += 1;
  } else {
    entry.failuresSinceStart += 1;
    entry.lastFailureAt = at;
    bucket.failures += 1;
  }
  entry.buckets.set(bucketStartMs, bucket);
  pruneSatRpcMethodMetricBuckets(entry, nowMs);
}

function summarizeSatRpcMethodMetrics(nowMs = Date.now()) {
  const lastHourStartMs = nowMs - 60 * 60_000;
  const last24HoursStartMs = nowMs - SAT_RPC_METHOD_METRIC_RETENTION_MS;
  const methods = [...satRpcMethodMetrics.entries()]
    .map(([method, entry]) => {
      pruneSatRpcMethodMetricBuckets(entry, nowMs);
      let requestsLastHour = 0;
      let successesLastHour = 0;
      let failuresLastHour = 0;
      let requestsLast24Hours = 0;
      let successesLast24Hours = 0;
      let failuresLast24Hours = 0;
      for (const [bucketStartMs, bucket] of entry.buckets.entries()) {
        if (bucketStartMs >= last24HoursStartMs) {
          requestsLast24Hours += bucket.requests;
          successesLast24Hours += bucket.successes;
          failuresLast24Hours += bucket.failures;
        }
        if (bucketStartMs >= lastHourStartMs) {
          requestsLastHour += bucket.requests;
          successesLastHour += bucket.successes;
          failuresLastHour += bucket.failures;
        }
      }
      return {
        method,
        requestsSinceStart: entry.requestsSinceStart,
        successesSinceStart: entry.successesSinceStart,
        failuresSinceStart: entry.failuresSinceStart,
        requestsLastHour,
        successesLastHour,
        failuresLastHour,
        requestsLast24Hours,
        successesLast24Hours,
        failuresLast24Hours,
        lastRequestAt: entry.lastRequestAt,
        lastSuccessAt: entry.lastSuccessAt,
        lastFailureAt: entry.lastFailureAt,
      };
    })
    .sort((left, right) => right.requestsLast24Hours - left.requestsLast24Hours);
  return {
    windowLastHourMs: 60 * 60_000,
    windowLast24HoursMs: SAT_RPC_METHOD_METRIC_RETENTION_MS,
    methods,
    accountReads: [...satRpcAccountReadMetrics.entries()]
      .map(([label, entry]) => ({
        label,
        requestsSinceStart: entry.requestsSinceStart,
        successesSinceStart: entry.successesSinceStart,
        nullsSinceStart: entry.nullsSinceStart,
        failuresSinceStart: entry.failuresSinceStart,
        lastRequestAt: entry.lastRequestAt,
        lastSuccessAt: entry.lastSuccessAt,
        lastNullAt: entry.lastNullAt,
        lastFailureAt: entry.lastFailureAt,
      }))
      .sort((left, right) => right.requestsSinceStart - left.requestsSinceStart),
  };
}

function looksLikeRpcQuotaFailure(value: unknown): boolean {
  const message = String(value ?? "").toLowerCase();
  if (!message.trim()) {
    return false;
  }
  return (
    message.includes("429") ||
    message.includes("rate limit") ||
    message.includes("too many requests") ||
    message.includes("quota") ||
    message.includes("credit") ||
    message.includes("credits exhausted") ||
    message.includes("resource exhausted")
  );
}

function getOrCreateReadRpcEndpointState(rpcUrl: string): SatReadRpcEndpointState {
  const key = normalizeRpcUrlForComparison(rpcUrl);
  const existing = satReadRpcEndpointStates.get(key);
  if (existing) {
    return existing;
  }
  const created: SatReadRpcEndpointState = {
    consecutiveFailures: 0,
    backoffUntilMs: 0,
    quotaLikely: false,
    lastError: null,
    lastFailureAt: null,
    lastSuccessAt: null,
  };
  satReadRpcEndpointStates.set(key, created);
  return created;
}

function currentReadRpcBackoffMs(rpcUrl: string, nowMs = Date.now()): number {
  const state = satReadRpcEndpointStates.get(normalizeRpcUrlForComparison(rpcUrl));
  if (!state) {
    return 0;
  }
  return Math.max(0, state.backoffUntilMs - nowMs);
}

function makeReadRpcBackoffError(method: string, remainingMs: number): Error {
  return new Error(
    `rpc ${method} skipped during endpoint circuit backoff; retry in ${Math.ceil(remainingMs / 1000)}s`,
  );
}

function markReadRpcEndpointSuccess(rpcUrl: string) {
  const state = getOrCreateReadRpcEndpointState(rpcUrl);
  state.consecutiveFailures = 0;
  state.backoffUntilMs = 0;
  state.quotaLikely = false;
  state.lastError = null;
  state.lastSuccessAt = new Date().toISOString();
}

function markReadRpcEndpointFailure(rpcUrl: string, error: unknown) {
  const state = getOrCreateReadRpcEndpointState(rpcUrl);
  const message = error instanceof Error ? error.message : String(error);
  const quotaLikely = looksLikeRpcQuotaFailure(message);
  state.consecutiveFailures += 1;
  state.quotaLikely = quotaLikely;
  state.lastError = message;
  state.lastFailureAt = new Date().toISOString();
  if (quotaLikely) {
    state.backoffUntilMs = Date.now() + SAT_RPC_QUOTA_BACKOFF_MS;
  } else if (state.consecutiveFailures >= SAT_RPC_FAILURE_BACKOFF_THRESHOLD) {
    const exponent = state.consecutiveFailures - SAT_RPC_FAILURE_BACKOFF_THRESHOLD;
    state.backoffUntilMs =
      Date.now() +
      Math.min(SAT_RPC_FAILURE_BACKOFF_MAX_MS, SAT_RPC_FAILURE_BACKOFF_BASE_MS * 2 ** exponent);
  }
}

function markReadRpcSuccess(mode: "primary" | "fallback", rpcUrl: string) {
  markReadRpcEndpointSuccess(rpcUrl);
  satReadRpcRuntimeState.lastMode = mode;
  satReadRpcRuntimeState.lastRpcUrl = rpcUrl;
  satReadRpcRuntimeState.lastSuccessAt = new Date().toISOString();
  if (mode === "primary") {
    satReadRpcRuntimeState.lastError = null;
    satReadRpcRuntimeState.quotaLikely = false;
  } else {
    satReadRpcRuntimeState.fallbackCount += 1;
  }
}

function markReadRpcFailure(error: unknown, rpcUrl: string) {
  const message = error instanceof Error ? error.message : String(error);
  markReadRpcEndpointFailure(rpcUrl, error);
  satReadRpcRuntimeState.lastMode = "unavailable";
  satReadRpcRuntimeState.lastError = message;
  satReadRpcRuntimeState.lastFailureAt = new Date().toISOString();
  satReadRpcRuntimeState.quotaLikely =
    satReadRpcRuntimeState.quotaLikely || looksLikeRpcQuotaFailure(message);
}

function firstNonEmpty(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    const trimmed = String(value ?? "").trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return "";
}

function normalizeSecondaryRpcUrl(primaryUrl: string, secondaryUrl: string): string | null {
  const trimmed = secondaryUrl.trim();
  if (!trimmed || trimmed === primaryUrl.trim()) {
    return null;
  }
  return trimmed;
}

function normalizeRpcUrlForComparison(url: string): string {
  try {
    const parsed = new URL(url.trim());
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return url.trim().replace(/\/$/, "");
  }
}

export function resolveDefaultSolanaPublicReadFallbackUrl(params: {
  network?: string;
  primaryUrl?: string;
}): string {
  const network = String(params.network ?? "").trim();
  const primaryUrl = String(params.primaryUrl ?? "").trim();
  const fallbackUrl =
    network === "devnet"
      ? "https://api.devnet.solana.com"
      : network === "mainnet-beta"
        ? "https://api.mainnet-beta.solana.com"
        : "";
  if (!fallbackUrl) {
    return "";
  }
  if (
    primaryUrl &&
    normalizeRpcUrlForComparison(primaryUrl) === normalizeRpcUrlForComparison(fallbackUrl)
  ) {
    return "";
  }
  return fallbackUrl;
}

function rpcCacheScope(rpc: string | SatReadRpcConfig): string {
  const normalized = normalizeReadRpcConfig(rpc);
  return `${normalized.primaryUrl}::${normalized.secondaryUrl ?? ""}`;
}

function accountRpcCacheKey(rpc: string | SatReadRpcConfig, address: string): string {
  return `account:${rpcCacheScope(rpc)}:${address}`;
}

type RpcCacheReadResult<T> = { hit: true; value: T } | { hit: false };

function readRpcCacheEntry<T>(key: string): RpcCacheReadResult<T> {
  const cached = satRpcReadCache.get(key);
  if (!cached) {
    return { hit: false };
  }
  if (cached.expiresAt <= Date.now()) {
    satRpcReadCache.delete(key);
    return { hit: false };
  }
  return { hit: true, value: cached.value as T };
}

function writeRpcCacheValue<T>(key: string, ttlMs: number, value: T) {
  satRpcReadCache.set(key, {
    expiresAt: Date.now() + ttlMs,
    value,
  });
}

async function getOrLoadRpcCacheValue<T>(
  key: string,
  ttlMs: number,
  loader: () => Promise<T>,
): Promise<T> {
  const cached = readRpcCacheEntry<T>(key);
  if (cached.hit) {
    return cached.value;
  }
  const inFlight = satRpcReadInFlight.get(key) as Promise<T> | undefined;
  if (inFlight) {
    return await inFlight;
  }
  const generation = satRpcReadCacheGeneration;
  const task = loader()
    .then((value) => {
      if (generation === satRpcReadCacheGeneration) {
        writeRpcCacheValue(key, ttlMs, value);
      }
      return value;
    })
    .finally(() => {
      satRpcReadInFlight.delete(key);
    });
  satRpcReadInFlight.set(key, task as Promise<unknown>);
  return await task;
}

export function invalidateSatReadCaches(options?: { preserveStable?: boolean }) {
  satRpcReadCacheGeneration += 1;
  if (options?.preserveStable) {
    for (const key of [...satRpcReadCache.keys()]) {
      if (
        key.startsWith("view:rent-exemption:") ||
        key.startsWith("view:global-state:") ||
        key.startsWith("view:treasury-state:")
      ) {
        continue;
      }
      satRpcReadCache.delete(key);
    }
    satRpcReadInFlight.clear();
    return;
  }
  satRpcReadCache.clear();
  satRpcReadInFlight.clear();
}

function readProviderCredentialUrl(
  credentials: Record<string, unknown> | undefined,
  keys: string[],
): string {
  if (!credentials) {
    return "";
  }
  for (const key of keys) {
    const value = String(credentials[key] ?? "").trim();
    if (value) {
      return value;
    }
  }
  return "";
}

function resolveReadRpcConfig(cfg: FasedAgentConfig, env: NodeJS.ProcessEnv): SatReadRpcConfig {
  const satMiningConfig =
    cfg.plugins?.entries?.["sat-mining"]?.config &&
    typeof cfg.plugins.entries["sat-mining"]?.config === "object"
      ? (cfg.plugins.entries["sat-mining"]?.config as Record<string, unknown>)
      : {};
  const network =
    satMiningConfig.network === "devnet" ||
    satMiningConfig.network === "mainnet-beta" ||
    satMiningConfig.network === "local"
      ? satMiningConfig.network
      : "devnet";
  const walletId =
    typeof satMiningConfig.walletId === "string"
      ? String(satMiningConfig.walletId).trim()
      : undefined;
  const registryProviderId = walletId
    ? readWalletProviderRegistry(env).wallets.find((wallet) => wallet.id === walletId)?.providerId
    : undefined;
  const providerId = registryProviderId || resolveWalletProviderId(cfg, env);
  const walletReadRpcUrl = walletEnvValue(env, "FASED_WALLET_SOLANA_READ_RPC_URL", walletId);
  const walletRpcUrl = walletEnvValue(env, "FASED_WALLET_SOLANA_RPC_URL", walletId);
  const walletReadRpcFallbackUrl =
    walletEnvValue(env, "FASED_WALLET_SOLANA_READ_RPC_FALLBACK_URL", walletId) ||
    walletEnvValue(env, "FASED_WALLET_SOLANA_RPC_FALLBACK_URL", walletId);
  if (providerId === "local-socket-signer") {
    const primaryUrl = firstNonEmpty(walletReadRpcUrl, walletRpcUrl);
    if (!primaryUrl) {
      throw new Error(
        "SAT on-chain inspection requires a Solana RPC URL for the local signer wallet",
      );
    }
    return {
      primaryUrl,
      secondaryUrl: normalizeSecondaryRpcUrl(
        primaryUrl,
        firstNonEmpty(
          walletReadRpcFallbackUrl,
          resolveDefaultSolanaPublicReadFallbackUrl({ network, primaryUrl }),
        ),
      ),
    };
  }
  const secret = loadWalletProviderSecret(providerId, env);
  const credentials =
    secret?.credentials && typeof secret.credentials === "object"
      ? (secret.credentials as Record<string, unknown>)
      : undefined;
  const primaryUrl = firstNonEmpty(
    walletReadRpcUrl,
    readProviderCredentialUrl(credentials, [
      "readRpcUrl",
      "read_rpc_url",
      "rpcReadUrl",
      "rpc_read_url",
    ]),
    readProviderCredentialUrl(credentials, ["rpcUrl", "rpc_url"]),
    walletRpcUrl,
  );
  if (!primaryUrl) {
    throw new Error(
      "SAT on-chain inspection requires a Solana RPC URL in wallet provider config or env",
    );
  }
  const secondaryUrl = normalizeSecondaryRpcUrl(
    primaryUrl,
    firstNonEmpty(
      walletReadRpcFallbackUrl,
      readProviderCredentialUrl(credentials, [
        "readRpcFallbackUrl",
        "read_rpc_fallback_url",
        "secondaryReadRpcUrl",
        "secondary_read_rpc_url",
        "rpcReadFallbackUrl",
        "rpc_read_fallback_url",
      ]),
      resolveDefaultSolanaPublicReadFallbackUrl({ network, primaryUrl }),
    ),
  );
  return { primaryUrl, secondaryUrl };
}

function resolveRpcUrl(cfg: FasedAgentConfig, env: NodeJS.ProcessEnv) {
  return resolveReadRpcConfig(cfg, env).primaryUrl;
}

function resolveEffectiveRpcUrl(): string {
  return resolveEffectiveReadRpcConfig().primaryUrl;
}

export function resolveEffectiveReadRpcConfig(): SatReadRpcConfig {
  const cfg = loadConfig();
  const mergedEnv = {
    ...process.env,
    ...(cfg.env?.vars ?? {}),
  } as NodeJS.ProcessEnv;
  return resolveReadRpcConfig(cfg, mergedEnv);
}

function createAbortableReadRpcFetch(): typeof globalThis.fetch {
  return (async (input, init) => {
    const timeoutMs = satRpcRequestTimeoutMs();
    const requestUrl =
      typeof input === "string" || input instanceof URL ? input.toString() : input.url;
    let guardedFetch: Awaited<ReturnType<typeof fetchWithSsrFGuard>>;
    try {
      guardedFetch = await fetchWithSsrFGuard({
        url: requestUrl,
        init,
        timeoutMs,
        signal: init?.signal ?? (input instanceof Request ? input.signal : undefined),
        policy: { allowPrivateNetwork: true },
        auditContext: "sat-mining-read-rpc",
      });
    } catch (error) {
      const reason = redactSensitiveUrlLikeString(
        error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      );
      throw new Error(
        `rpc fetch failed after at most ${timeoutMs}ms (${redactSensitiveUrlLikeString(requestUrl)}): ${reason}`,
      );
    }
    const { response, release } = guardedFetch;
    try {
      const body = await response.arrayBuffer();
      return new Response(body, {
        headers: response.headers,
        status: response.status,
        statusText: response.statusText,
      });
    } finally {
      await release();
    }
  }) as typeof globalThis.fetch;
}

async function withReadRpcTimeout<T>(task: Promise<T>, method: string, rpcUrl: string): Promise<T> {
  const timeoutMs = satRpcRequestTimeoutMs();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `rpc ${method} timed out after ${timeoutMs}ms (${redactSensitiveUrlLikeString(rpcUrl)})`,
              ),
            ),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export function createReadConnection(
  solana: SolanaModuleLike,
  rpc: SatReadRpcConfig,
): SatReadConnectionLike {
  const primary = new solana.Connection(rpc.primaryUrl, {
    disableRetryOnRateLimit: true,
    fetch: createAbortableReadRpcFetch(),
  });
  const secondary = rpc.secondaryUrl
    ? new solana.Connection(rpc.secondaryUrl, {
        disableRetryOnRateLimit: true,
        fetch: createAbortableReadRpcFetch(),
      })
    : null;

  const withFallback = <TMethod extends SatReadMethodName>(
    method: TMethod,
  ): SatReadConnectionLike[TMethod] => {
    return (async (...args: unknown[]): Promise<unknown> => {
      const primaryBackoffMs = currentReadRpcBackoffMs(rpc.primaryUrl);
      const secondaryBackoffMs = rpc.secondaryUrl ? currentReadRpcBackoffMs(rpc.secondaryUrl) : 0;
      const callEndpoint = async (
        connection: InstanceType<SolanaModuleLike["Connection"]>,
        mode: "primary" | "fallback",
        rpcUrl: string,
      ) => {
        updateSatRpcMethodMetric(method, "request");
        try {
          const task = (connection[method] as unknown as (...inner: unknown[]) => Promise<unknown>)(
            ...args,
          );
          const result = await withReadRpcTimeout(task, method, rpcUrl);
          updateSatRpcMethodMetric(method, "success");
          markReadRpcSuccess(mode, rpcUrl);
          return result;
        } catch (error) {
          updateSatRpcMethodMetric(method, "failure");
          markReadRpcFailure(error, rpcUrl);
          throw error;
        }
      };
      if (primaryBackoffMs > 0) {
        if (!secondary || !rpc.secondaryUrl || secondaryBackoffMs > 0) {
          throw makeReadRpcBackoffError(
            method,
            Math.min(
              primaryBackoffMs,
              secondaryBackoffMs > 0 ? secondaryBackoffMs : primaryBackoffMs,
            ),
          );
        }
        return await callEndpoint(secondary, "fallback", rpc.secondaryUrl);
      }
      try {
        return await callEndpoint(primary, "primary", rpc.primaryUrl);
      } catch (primaryError) {
        if (!secondary || !rpc.secondaryUrl) {
          throw primaryError;
        }
        const fallbackBackoffMs = currentReadRpcBackoffMs(rpc.secondaryUrl);
        if (fallbackBackoffMs > 0) {
          throw makeReadRpcBackoffError(method, fallbackBackoffMs);
        }
        try {
          return await callEndpoint(secondary, "fallback", rpc.secondaryUrl);
        } catch (secondaryError) {
          throw new Error(
            `rpc ${method} failed on primary (${String(
              redactSensitiveUrlLikeString(
                primaryError instanceof Error ? primaryError.message : String(primaryError),
              ),
            )}) and fallback (${String(
              redactSensitiveUrlLikeString(
                secondaryError instanceof Error ? secondaryError.message : String(secondaryError),
              ),
            )})`,
          );
        }
      }
    }) as unknown as SatReadConnectionLike[TMethod];
  };

  return {
    rpcEndpoint: rpc.primaryUrl,
    secondaryRpcEndpoint: rpc.secondaryUrl,
    getAccountInfo: withFallback("getAccountInfo"),
    getProgramAccounts: withFallback("getProgramAccounts"),
    getMinimumBalanceForRentExemption: withFallback("getMinimumBalanceForRentExemption"),
  };
}

async function resolveConnection(env: NodeJS.ProcessEnv) {
  const solana = await loadSolanaWeb3();
  const cfg = loadConfig();
  const mergedEnv = {
    ...env,
    ...(cfg.env?.vars ?? {}),
  } as NodeJS.ProcessEnv;
  const readRpc = resolveReadRpcConfig(cfg, mergedEnv);
  return {
    solana,
    connection: createReadConnection(solana, readRpc),
    programId: new solana.PublicKey(SAT_PROGRAM_ID()),
    readRpc,
  };
}

async function resolveProgramContext(env: NodeJS.ProcessEnv) {
  const solana = await loadSolanaWeb3();
  return {
    solana,
    programId: new solana.PublicKey(SAT_PROGRAM_ID()),
  };
}

async function resolveBondProgramContext(env: NodeJS.ProcessEnv) {
  assertDedicatedBondProgramConfigured(env);
  const solana = await loadSolanaWeb3();
  return {
    solana,
    programId: new solana.PublicKey(SAT_BOND_PROGRAM_ID()),
  };
}

export const SAT_RENT_ACCOUNT_SPACES = {
  protocolVault: 0,
  cycleState: 376,
  cycleRegistryMeta: 88,
  cycleRegistryPage: 2_072,
  cycleSettlementProgressV2: 1_048,
  minerCycle: 352,
  unlockInterval: 80,
} as const;

export function calculateSatRevealSharedRentLamports(params: {
  cycleSettlementProgressLamports: number;
  cycleRegistryPageLamports: number;
  unlockIntervalLamports: number;
}): number {
  return (
    params.cycleSettlementProgressLamports +
    params.cycleRegistryPageLamports +
    params.unlockIntervalLamports
  );
}

function normalizeReadRpcConfig(rpc: string | SatReadRpcConfig): SatReadRpcConfig {
  return typeof rpc === "string" ? { primaryUrl: rpc, secondaryUrl: null } : rpc;
}

async function rpcRequestOnce<T>(rpcUrl: string, method: string, params: unknown[]): Promise<T> {
  updateSatRpcMethodMetric(method, "request");
  try {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
    const target = new URL(rpcUrl);
    const transport = target.protocol === "https:" ? https : http;
    const payload = await new Promise<string>((resolve, reject) => {
      let settled = false;
      const finishReject = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        reject(error);
      };
      const req = transport.request(
        target,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let responseBytes = 0;
          res.on("data", (chunk) => {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            responseBytes += buffer.length;
            if (responseBytes > SAT_RPC_MAX_RESPONSE_BYTES) {
              req.destroy(new Error(`rpc ${method} response exceeded size limit`));
              return;
            }
            chunks.push(buffer);
          });
          res.on("end", () => {
            if (settled) {
              return;
            }
            const text = Buffer.concat(chunks).toString("utf8");
            if ((res.statusCode ?? 500) >= 400) {
              finishReject(new Error(text || `rpc ${method} failed`));
              return;
            }
            settled = true;
            resolve(text);
          });
        },
      );
      req.setTimeout(satRpcRequestTimeoutMs(), () => {
        req.destroy(
          new Error(
            `rpc ${method} timed out after ${satRpcRequestTimeoutMs()}ms (${redactSensitiveUrlLikeString(rpcUrl)})`,
          ),
        );
      });
      req.on("error", (error) => finishReject(error));
      req.write(body);
      req.end();
    });
    const parsed = JSON.parse(payload) as { result?: T; error?: { message?: string } };
    if (parsed.error) {
      throw new Error(parsed.error.message || `rpc ${method} failed`);
    }
    updateSatRpcMethodMetric(method, "success");
    return parsed.result as T;
  } catch (error) {
    updateSatRpcMethodMetric(method, "failure");
    throw error;
  }
}

async function rpcRequest<T>(
  rpc: string | SatReadRpcConfig,
  method: string,
  params: unknown[],
): Promise<T> {
  const normalized = normalizeReadRpcConfig(rpc);
  const primaryBackoffMs = currentReadRpcBackoffMs(normalized.primaryUrl);
  const secondaryBackoffMs = normalized.secondaryUrl
    ? currentReadRpcBackoffMs(normalized.secondaryUrl)
    : 0;
  if (primaryBackoffMs > 0 && (!normalized.secondaryUrl || secondaryBackoffMs > 0)) {
    throw makeReadRpcBackoffError(
      method,
      Math.min(primaryBackoffMs, secondaryBackoffMs > 0 ? secondaryBackoffMs : primaryBackoffMs),
    );
  }
  const useFallbackDueToBackoff = primaryBackoffMs > 0 && Boolean(normalized.secondaryUrl);
  try {
    const rpcUrl =
      useFallbackDueToBackoff && normalized.secondaryUrl
        ? normalized.secondaryUrl
        : normalized.primaryUrl;
    const result = await rpcRequestOnce<T>(rpcUrl, method, params);
    markReadRpcSuccess(
      useFallbackDueToBackoff && normalized.secondaryUrl ? "fallback" : "primary",
      rpcUrl,
    );
    return result;
  } catch (primaryError) {
    const failedRpcUrl =
      useFallbackDueToBackoff && normalized.secondaryUrl
        ? normalized.secondaryUrl
        : normalized.primaryUrl;
    markReadRpcFailure(primaryError, failedRpcUrl);
    if (!normalized.secondaryUrl || useFallbackDueToBackoff) {
      throw primaryError;
    }
    const fallbackBackoffMs = currentReadRpcBackoffMs(normalized.secondaryUrl);
    if (fallbackBackoffMs > 0) {
      throw makeReadRpcBackoffError(method, fallbackBackoffMs);
    }
    try {
      const result = await rpcRequestOnce<T>(normalized.secondaryUrl, method, params);
      markReadRpcSuccess("fallback", normalized.secondaryUrl);
      return result;
    } catch (secondaryError) {
      markReadRpcFailure(secondaryError, normalized.secondaryUrl);
      const primaryMessage = redactSensitiveUrlLikeString(
        primaryError instanceof Error ? primaryError.message : String(primaryError),
      );
      const secondaryMessage = redactSensitiveUrlLikeString(
        secondaryError instanceof Error ? secondaryError.message : String(secondaryError),
      );
      throw new Error(
        `rpc ${method} failed on primary (${primaryMessage}) and fallback (${secondaryMessage})`,
      );
    }
  }
}

async function fetchAccountInfoRaw(
  rpc: string | SatReadRpcConfig,
  address: string,
  label?: string,
): Promise<Buffer | null> {
  const record = await fetchAccountRecordRaw(rpc, address, label);
  return record?.data ?? null;
}

async function fetchAccountRecordRaw(
  rpc: string | SatReadRpcConfig,
  address: string,
  label?: string,
): Promise<SatRpcAccountRecord> {
  const normalized = normalizeReadRpcConfig(rpc);
  const trimmedAddress = String(address ?? "").trim();
  if (!trimmedAddress) {
    return null;
  }
  return await getOrLoadRpcCacheValue<SatRpcAccountRecord>(
    accountRpcCacheKey(normalized, trimmedAddress),
    SAT_RPC_ACCOUNT_RECORD_CACHE_TTL_MS,
    async () => {
      updateSatRpcAccountReadMetric(label, "request");
      try {
        const result = await rpcRequest<{
          value?: { data?: [string, string] | null; owner?: string | null } | null;
        }>(normalized, "getAccountInfo", [trimmedAddress, { encoding: "base64" }]);
        const encoded = Array.isArray(result.value?.data) ? result.value?.data[0] : null;
        if (!encoded) {
          updateSatRpcAccountReadMetric(label, "null");
          return null;
        }
        updateSatRpcAccountReadMetric(label, "success");
        return {
          owner: String(result.value?.owner ?? "").trim() || null,
          data: Buffer.from(encoded, "base64"),
        };
      } catch (error) {
        updateSatRpcAccountReadMetric(label, "failure");
        throw error;
      }
    },
  );
}

async function fetchMultipleAccountRecordsRaw(
  rpc: string | SatReadRpcConfig,
  addresses: string[],
  label?: string,
  options?: { ttlMs?: number },
): Promise<SatRpcAccountRecord[]> {
  const normalized = normalizeReadRpcConfig(rpc);
  const ttlMs = options?.ttlMs ?? SAT_RPC_ACCOUNT_RECORD_CACHE_TTL_MS;
  const uniqueAddresses: string[] = [];
  const addressIndex = new Map<string, number>();
  for (const address of addresses) {
    const trimmedAddress = String(address ?? "").trim();
    if (!trimmedAddress || addressIndex.has(trimmedAddress)) {
      continue;
    }
    addressIndex.set(trimmedAddress, uniqueAddresses.length);
    uniqueAddresses.push(trimmedAddress);
  }
  if (uniqueAddresses.length === 0) {
    return [];
  }
  const uniqueRecords: SatRpcAccountRecord[] = new Array(uniqueAddresses.length).fill(null);
  const missingAddresses: string[] = [];
  const missingIndexes: number[] = [];
  for (const [index, address] of uniqueAddresses.entries()) {
    const cached = readRpcCacheEntry<SatRpcAccountRecord>(accountRpcCacheKey(normalized, address));
    if (cached.hit) {
      uniqueRecords[index] = cached.value;
      continue;
    }
    missingAddresses.push(address);
    missingIndexes.push(index);
  }
  if (missingAddresses.length > 0) {
    const missingRecords = await getOrLoadRpcCacheValue<SatRpcAccountRecord[]>(
      `accounts:${rpcCacheScope(normalized)}:${missingAddresses.join(",")}`,
      ttlMs,
      async () => {
        for (const _address of missingAddresses) {
          updateSatRpcAccountReadMetric(label, "request");
        }
        try {
          const result = await rpcRequest<{
            value?: Array<{ data?: [string, string] | null; owner?: string | null } | null>;
          }>(normalized, "getMultipleAccounts", [missingAddresses, { encoding: "base64" }]);
          return missingAddresses.map((address, index) => {
            const entry = Array.isArray(result.value) ? result.value[index] : null;
            const encoded = Array.isArray(entry?.data) ? entry?.data[0] : null;
            const record = encoded
              ? {
                  owner: String(entry?.owner ?? "").trim() || null,
                  data: Buffer.from(encoded, "base64"),
                }
              : null;
            updateSatRpcAccountReadMetric(label, record ? "success" : "null");
            writeRpcCacheValue(accountRpcCacheKey(normalized, address), ttlMs, record);
            return record;
          });
        } catch (error) {
          for (const _address of missingAddresses) {
            updateSatRpcAccountReadMetric(label, "failure");
          }
          throw error;
        }
      },
    );
    for (const [index, record] of missingRecords.entries()) {
      const targetIndex = missingIndexes[index];
      if (typeof targetIndex === "number") {
        uniqueRecords[targetIndex] = record ?? null;
      }
    }
  }
  return addresses.map((address) => {
    const trimmedAddress = String(address ?? "").trim();
    if (!trimmedAddress) {
      return null;
    }
    const index = addressIndex.get(trimmedAddress);
    return typeof index === "number" ? (uniqueRecords[index] ?? null) : null;
  });
}

async function fetchTokenBalanceRaw(
  rpc: string | SatReadRpcConfig,
  address: string,
): Promise<string | null> {
  const normalized = normalizeReadRpcConfig(rpc);
  const trimmedAddress = String(address ?? "").trim();
  if (!trimmedAddress) {
    return null;
  }
  return await getOrLoadRpcCacheValue<string | null>(
    `token-balance:${rpcCacheScope(normalized)}:${trimmedAddress}`,
    SAT_RPC_BALANCE_CACHE_TTL_MS,
    async () => {
      const result = await rpcRequest<{ value?: { amount?: string } }>(
        normalized,
        "getTokenAccountBalance",
        [trimmedAddress],
      );
      return result.value?.amount ?? null;
    },
  );
}

async function fetchLamportBalanceRaw(
  rpc: string | SatReadRpcConfig,
  address: string,
): Promise<string | null> {
  const normalized = normalizeReadRpcConfig(rpc);
  const trimmedAddress = String(address ?? "").trim();
  if (!trimmedAddress) {
    return null;
  }
  return await getOrLoadRpcCacheValue<string | null>(
    `lamport-balance:${rpcCacheScope(normalized)}:${trimmedAddress}`,
    SAT_RPC_BALANCE_CACHE_TTL_MS,
    async () => {
      const result = await rpcRequest<{ value?: number | null }>(normalized, "getBalance", [
        trimmedAddress,
      ]);
      return typeof result.value === "number" && Number.isFinite(result.value)
        ? String(result.value)
        : null;
    },
  );
}

function decodeSplTokenAccountAmount(record: SatRpcAccountRecord): string | undefined {
  if (!record?.data || record.data.length < 72) {
    return undefined;
  }
  try {
    return readU64String(record.data, 64);
  } catch {
    return undefined;
  }
}

export async function inspectSatChainUnixTime(_config: SatMiningConfig): Promise<number> {
  const rpc = resolveEffectiveReadRpcConfig();
  const slot = await rpcRequest<number>(rpc, "getSlot", []);
  const blockTime = await rpcRequest<number | null>(rpc, "getBlockTime", [slot]);
  return typeof blockTime === "number" && Number.isFinite(blockTime)
    ? blockTime
    : Math.floor(Date.now() / 1000);
}

export async function inspectSatChainSlot(_config: SatMiningConfig): Promise<number> {
  const rpc = resolveEffectiveReadRpcConfig();
  return await rpcRequest<number>(rpc, "getSlot", []);
}

export type SatAddressLookupTableView = {
  address: string;
  authority: string | null;
  addresses: string[];
  active: boolean;
  lastExtendedSlot: number;
};

export async function inspectSatAddressLookupTable(
  _config: SatMiningConfig,
  params: { address: string },
): Promise<SatAddressLookupTableView | null> {
  const { solana, connection } = await resolveConnection(process.env);
  const address = new solana.PublicKey(params.address);
  const account = await connection.getAccountInfo(address, "confirmed");
  if (!account) {
    return null;
  }
  if (!account.owner.equals(new solana.PublicKey(ADDRESS_LOOKUP_TABLE_PROGRAM_ID))) {
    throw new Error("SAT distribution lookup table has the wrong program owner");
  }
  const state = solana.AddressLookupTableAccount.deserialize(account.data);
  return {
    address: address.toBase58(),
    authority: state.authority?.toBase58() ?? null,
    addresses: state.addresses.map((entry) => entry.toBase58()),
    active: state.deactivationSlot === 18_446_744_073_709_551_615n,
    lastExtendedSlot: state.lastExtendedSlot,
  };
}

export async function inspectSatLamportBalance(
  _config: SatMiningConfig,
  params: { address: string },
): Promise<string | null> {
  const rpc = resolveEffectiveReadRpcConfig();
  return await fetchLamportBalanceRaw(rpc, params.address);
}

export async function inspectSatMinerCycleAccountExists(
  _config: SatMiningConfig,
  params: { authority: string; cycleId: number },
): Promise<boolean> {
  const { solana, programId } = await resolveProgramContext(process.env);
  const [address] = solana.PublicKey.findProgramAddressSync(
    [
      Buffer.from(SAT_MINER_CYCLE_STATE_SEED),
      new solana.PublicKey(params.authority).toBuffer(),
      encodeU64(params.cycleId),
    ],
    programId,
  );
  const rpc = resolveEffectiveReadRpcConfig();
  const account = await fetchAccountInfoRaw(rpc, address.toBase58(), "miner-cycle-exists");
  if (!account) {
    return false;
  }
  try {
    const decoded = decodeSatMinerCycle(account, address.toBase58());
    return decoded.cycleId === params.cycleId;
  } catch {
    return false;
  }
}

export async function inspectSatCycleAccountExists(
  _config: SatMiningConfig,
  params: { cycleId: number },
): Promise<boolean> {
  const { solana, programId } = await resolveProgramContext(process.env);
  const [address] = solana.PublicKey.findProgramAddressSync(
    [Buffer.from("sat_cycle_state"), encodeU64(params.cycleId)],
    programId,
  );
  const rpc = resolveEffectiveReadRpcConfig();
  const account = await fetchAccountInfoRaw(rpc, address.toBase58(), "cycle-exists");
  if (!account) {
    return false;
  }
  try {
    const decoded = decodeSatCycle(account, address.toBase58());
    return decoded.cycleId === params.cycleId;
  } catch {
    return false;
  }
}

export async function inspectSatGlobalState(
  _config: SatMiningConfig,
): Promise<SatGlobalStateView | null> {
  const { solana, programId } = await resolveProgramContext(process.env);
  const [address] = solana.PublicKey.findProgramAddressSync(
    [Buffer.from("sat_global_state")],
    programId,
  );
  const rpc = resolveEffectiveReadRpcConfig();
  return await getOrLoadRpcCacheValue<SatGlobalStateView | null>(
    `view:global-state:${rpcCacheScope(rpc)}:${address.toBase58()}`,
    SAT_RPC_STABLE_VIEW_CACHE_TTL_MS,
    async () => {
      const account = await fetchAccountInfoRaw(rpc, address.toBase58(), "global-state");
      return account ? decodeSatGlobalState(account, address.toBase58()) : null;
    },
  );
}

export async function inspectSatCycle(
  _config: SatMiningConfig,
  params: { cycleId: number },
): Promise<SatCycleView | null> {
  const { solana, programId } = await resolveProgramContext(process.env);
  const [address] = solana.PublicKey.findProgramAddressSync(
    [Buffer.from("sat_cycle_state"), encodeU64(params.cycleId)],
    programId,
  );
  const rpc = resolveEffectiveReadRpcConfig();
  return await getOrLoadRpcCacheValue<SatCycleView | null>(
    `view:cycle:${rpcCacheScope(rpc)}:${params.cycleId}`,
    SAT_RPC_LIVE_VIEW_CACHE_TTL_MS,
    async () => {
      const account = await fetchAccountInfoRaw(rpc, address.toBase58(), "cycle-view");
      return account ? decodeSatCycle(account, address.toBase58()) : null;
    },
  );
}

export async function inspectSatMinerCycle(
  _config: SatMiningConfig,
  params: { authority: string; cycleId: number },
): Promise<SatMinerCycleView | null> {
  const { solana, programId } = await resolveProgramContext(process.env);
  const [address] = solana.PublicKey.findProgramAddressSync(
    [
      Buffer.from(SAT_MINER_CYCLE_STATE_SEED),
      new solana.PublicKey(params.authority).toBuffer(),
      encodeU64(params.cycleId),
    ],
    programId,
  );
  const rpc = resolveEffectiveReadRpcConfig();
  return await getOrLoadRpcCacheValue<SatMinerCycleView | null>(
    `view:miner-cycle:${rpcCacheScope(rpc)}:${params.authority}:${params.cycleId}`,
    SAT_RPC_LIVE_VIEW_CACHE_TTL_MS,
    async () => {
      const account = await fetchAccountInfoRaw(rpc, address.toBase58(), "miner-cycle-view");
      return account ? decodeSatMinerCycle(account, address.toBase58()) : null;
    },
  );
}

export async function deriveSatMinerCycleAddress(
  _config: SatMiningConfig,
  params: { authority: string; cycleId: number },
): Promise<string> {
  const { solana, programId } = await resolveProgramContext(process.env);
  const [address] = solana.PublicKey.findProgramAddressSync(
    [
      Buffer.from(SAT_MINER_CYCLE_STATE_SEED),
      new solana.PublicKey(params.authority).toBuffer(),
      encodeU64(params.cycleId),
    ],
    programId,
  );
  return address.toBase58();
}

export async function inspectSatMinerCycleByAddress(
  _config: SatMiningConfig,
  params: { address: string },
): Promise<SatMinerCycleView | null> {
  const rpc = resolveEffectiveReadRpcConfig();
  return await getOrLoadRpcCacheValue<SatMinerCycleView | null>(
    minerCycleAddressViewCacheKey(rpc, params.address),
    SAT_RPC_LIVE_VIEW_CACHE_TTL_MS,
    async () => {
      const account = await fetchAccountInfoRaw(rpc, params.address, "miner-cycle-address");
      return account ? decodeSatMinerCycle(account, params.address) : null;
    },
  );
}

function minerCycleAddressViewCacheKey(rpc: SatReadRpcConfig, address: string): string {
  return `view:miner-cycle-address:${rpcCacheScope(rpc)}:${address}`;
}

export async function inspectSatMinerCyclesByAddress(
  _config: SatMiningConfig,
  params: { addresses: readonly string[] },
): Promise<Array<SatMinerCycleView | null>> {
  const rpc = resolveEffectiveReadRpcConfig();
  const uniqueAddresses: string[] = [];
  const addressIndex = new Map<string, number>();
  for (const address of params.addresses) {
    const trimmedAddress = String(address ?? "").trim();
    if (!trimmedAddress || addressIndex.has(trimmedAddress)) {
      continue;
    }
    addressIndex.set(trimmedAddress, uniqueAddresses.length);
    uniqueAddresses.push(trimmedAddress);
  }
  if (uniqueAddresses.length === 0) {
    return [];
  }

  const uniqueViews: Array<SatMinerCycleView | null> = new Array(uniqueAddresses.length).fill(null);
  const missingAddresses: string[] = [];
  const missingIndexes: number[] = [];
  for (const [index, address] of uniqueAddresses.entries()) {
    const cached = readRpcCacheEntry<SatMinerCycleView | null>(
      minerCycleAddressViewCacheKey(rpc, address),
    );
    if (cached.hit) {
      uniqueViews[index] = cached.value;
      continue;
    }
    missingAddresses.push(address);
    missingIndexes.push(index);
  }

  if (missingAddresses.length > 0) {
    const records = await fetchMultipleAccountRecordsRaw(
      rpc,
      missingAddresses,
      "miner-cycle-address-batch",
    );
    for (const [recordIndex, record] of records.entries()) {
      const address = missingAddresses[recordIndex];
      const targetIndex = missingIndexes[recordIndex];
      if (!address || typeof targetIndex !== "number") {
        continue;
      }
      let view: SatMinerCycleView | null = null;
      if (record?.data) {
        try {
          view = decodeSatMinerCycle(record.data, address);
        } catch {
          view = null;
        }
      }
      writeRpcCacheValue(
        minerCycleAddressViewCacheKey(rpc, address),
        SAT_RPC_LIVE_VIEW_CACHE_TTL_MS,
        view,
      );
      uniqueViews[targetIndex] = view;
    }
  }

  return params.addresses.map((address) => {
    const index = addressIndex.get(String(address ?? "").trim());
    return typeof index === "number" ? (uniqueViews[index] ?? null) : null;
  });
}

export async function inspectSatMinerCapital(
  _config: SatMiningConfig,
  params: { authority: string },
): Promise<SatMinerCapitalView | null> {
  const { solana, programId } = await resolveProgramContext(process.env);
  const [address] = solana.PublicKey.findProgramAddressSync(
    [Buffer.from("sat_miner_capital_state"), new solana.PublicKey(params.authority).toBuffer()],
    programId,
  );
  const rpc = resolveEffectiveReadRpcConfig();
  return await getOrLoadRpcCacheValue<SatMinerCapitalView | null>(
    `view:miner-capital:${rpcCacheScope(rpc)}:${params.authority}`,
    SAT_RPC_LIVE_VIEW_CACHE_TTL_MS,
    async () => {
      const account = await fetchAccountInfoRaw(rpc, address.toBase58(), "miner-capital");
      return account ? decodeSatMinerCapital(account, address.toBase58()) : null;
    },
  );
}

export async function inspectSatMiningStatusAccounts(
  _config: SatMiningConfig,
  params: {
    authority: string | null | undefined;
    currentCycleId: number;
    claimCycleId?: number | null;
  },
): Promise<SatMiningStatusAccountsView> {
  const { solana, programId } = await resolveProgramContext(process.env);
  const rpc = resolveEffectiveReadRpcConfig();
  const authority = String(params.authority ?? "").trim();
  const owner = authority ? new solana.PublicKey(authority) : null;
  const currentCycleId = Math.max(0, Math.floor(params.currentCycleId));
  const claimCycleId =
    typeof params.claimCycleId === "number" &&
    Number.isFinite(params.claimCycleId) &&
    params.claimCycleId > 0
      ? Math.floor(params.claimCycleId)
      : null;
  const mint = new solana.PublicKey(SAT_MINT_ADDRESS());
  const [globalAddress] = solana.PublicKey.findProgramAddressSync(
    [Buffer.from("sat_global_state")],
    programId,
  );
  const [currentCycleAddress] = solana.PublicKey.findProgramAddressSync(
    [Buffer.from("sat_cycle_state"), encodeU64(currentCycleId)],
    programId,
  );
  const [currentSettlementProgressAddress] = solana.PublicKey.findProgramAddressSync(
    [Buffer.from("sat_cycle_settlement_progress_v2"), encodeU64(currentCycleId)],
    programId,
  );
  const [treasuryStateAddress] = solana.PublicKey.findProgramAddressSync(
    [Buffer.from("sat_treasury_state")],
    programId,
  );
  const [treasury] = solana.PublicKey.findProgramAddressSync([Buffer.from("treasury")], programId);
  const currentMinerCycleAddress = owner
    ? solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_MINER_CYCLE_STATE_SEED), owner.toBuffer(), encodeU64(currentCycleId)],
        programId,
      )[0]
    : null;
  const claimMinerCycleAddress =
    owner && claimCycleId != null
      ? solana.PublicKey.findProgramAddressSync(
          [Buffer.from(SAT_MINER_CYCLE_STATE_SEED), owner.toBuffer(), encodeU64(claimCycleId)],
          programId,
        )[0]
      : null;
  const minerCapitalAddress = owner
    ? solana.PublicKey.findProgramAddressSync(
        [Buffer.from("sat_miner_capital_state"), owner.toBuffer()],
        programId,
      )[0]
    : null;
  const recipientAta = owner ? deriveAssociatedTokenAddress(solana, owner, mint) : null;
  const treasuryAta = deriveAssociatedTokenAddress(solana, treasury, mint);

  const coreEntries = [
    ["currentCycle", currentCycleAddress],
    ["currentSettlementProgress", currentSettlementProgressAddress],
    ["currentMinerCycle", currentMinerCycleAddress],
    ["claimMinerCycle", claimMinerCycleAddress],
    ["minerCapital", minerCapitalAddress],
    ["recipientAta", recipientAta],
  ] as const;
  const stableEntries = [
    ["global", globalAddress],
    ["treasuryState", treasuryStateAddress],
    ["treasuryAta", treasuryAta],
  ] as const;
  const coreAddresses = coreEntries
    .map(([, address]) => address?.toBase58() ?? "")
    .filter((address) => address.trim());
  const stableAddresses = stableEntries
    .map(([, address]) => address?.toBase58() ?? "")
    .filter((address) => address.trim());
  const [coreRecords, stableRecords] = await Promise.all([
    fetchMultipleAccountRecordsRaw(rpc, coreAddresses, "status-core"),
    fetchMultipleAccountRecordsRaw(rpc, stableAddresses, "status-stable", {
      ttlMs: SAT_RPC_STABLE_VIEW_CACHE_TTL_MS,
    }),
  ]);
  const byAddress = new Map<string, SatRpcAccountRecord>();
  coreAddresses.forEach((address, index) => {
    byAddress.set(address, coreRecords[index] ?? null);
  });
  stableAddresses.forEach((address, index) => {
    byAddress.set(address, stableRecords[index] ?? null);
  });
  const recordFor = (address: import("@solana/web3.js").PublicKey | null) =>
    address ? (byAddress.get(address.toBase58()) ?? null) : null;

  const globalRecord = recordFor(globalAddress);
  const currentCycleRecord = recordFor(currentCycleAddress);
  const currentSettlementProgressRecord = recordFor(currentSettlementProgressAddress);
  const currentMinerCycleRecord = recordFor(currentMinerCycleAddress);
  const claimMinerCycleRecord = recordFor(claimMinerCycleAddress);
  const minerCapitalRecord = recordFor(minerCapitalAddress);
  const treasuryStateRecord = recordFor(treasuryStateAddress);
  const recipientAtaRecord = recordFor(recipientAta);
  const treasuryAtaRecord = recordFor(treasuryAta);

  const globalState = globalRecord?.data
    ? decodeSatGlobalState(globalRecord.data, globalAddress.toBase58())
    : null;
  const currentCycle = currentCycleRecord?.data
    ? decodeSatCycle(currentCycleRecord.data, currentCycleAddress.toBase58())
    : null;
  const currentSettlementProgress = currentSettlementProgressRecord?.data
    ? decodeSatCycleSettlementProgressV2(
        currentSettlementProgressRecord.data,
        currentSettlementProgressAddress.toBase58(),
      )
    : null;
  const currentMinerCycle = currentMinerCycleRecord?.data
    ? decodeSatMinerCycle(currentMinerCycleRecord.data, currentMinerCycleAddress?.toBase58() ?? "")
    : null;
  const claimMinerCycle = claimMinerCycleRecord?.data
    ? decodeSatMinerCycle(claimMinerCycleRecord.data, claimMinerCycleAddress?.toBase58() ?? "")
    : null;
  const minerCapital = minerCapitalRecord?.data
    ? decodeSatMinerCapital(minerCapitalRecord.data, minerCapitalAddress?.toBase58() ?? "")
    : null;
  const treasuryState = treasuryStateRecord?.data
    ? decodeSatTreasuryState(treasuryStateRecord.data, treasuryStateAddress.toBase58())
    : null;
  const payoutReadiness: SatPayoutReadinessView | null = owner
    ? {
        treasuryAddress: treasury.toBase58(),
        treasuryAta: treasuryAta.toBase58(),
        recipientAta: recipientAta?.toBase58() ?? "",
        treasuryAtaExists: Boolean(treasuryAtaRecord),
        recipientAtaExists: Boolean(recipientAtaRecord),
        treasuryBalanceRaw: decodeSplTokenAccountAmount(treasuryAtaRecord),
        recipientBalanceRaw: decodeSplTokenAccountAmount(recipientAtaRecord),
      }
    : null;

  writeRpcCacheValue(
    `view:global-state:${rpcCacheScope(rpc)}:${globalAddress.toBase58()}`,
    SAT_RPC_STABLE_VIEW_CACHE_TTL_MS,
    globalState,
  );
  writeRpcCacheValue(
    `view:cycle:${rpcCacheScope(rpc)}:${currentCycleId}`,
    SAT_RPC_LIVE_VIEW_CACHE_TTL_MS,
    currentCycle,
  );
  writeRpcCacheValue(
    `view:settlement-progress:${rpcCacheScope(rpc)}:${currentCycleId}`,
    SAT_RPC_LIVE_VIEW_CACHE_TTL_MS,
    currentSettlementProgress,
  );
  if (owner && currentMinerCycleAddress) {
    writeRpcCacheValue(
      `view:miner-cycle:${rpcCacheScope(rpc)}:${authority}:${currentCycleId}`,
      SAT_RPC_LIVE_VIEW_CACHE_TTL_MS,
      currentMinerCycle,
    );
  }
  if (owner && claimCycleId != null && claimMinerCycleAddress) {
    writeRpcCacheValue(
      `view:miner-cycle:${rpcCacheScope(rpc)}:${authority}:${claimCycleId}`,
      SAT_RPC_LIVE_VIEW_CACHE_TTL_MS,
      claimMinerCycle,
    );
  }
  if (owner && minerCapitalAddress) {
    writeRpcCacheValue(
      `view:miner-capital:${rpcCacheScope(rpc)}:${authority}`,
      SAT_RPC_LIVE_VIEW_CACHE_TTL_MS,
      minerCapital,
    );
  }
  writeRpcCacheValue(
    `view:treasury-state:${rpcCacheScope(rpc)}:${treasuryStateAddress.toBase58()}`,
    SAT_RPC_STABLE_VIEW_CACHE_TTL_MS,
    treasuryState,
  );
  if (owner) {
    writeRpcCacheValue(
      `view:payout-readiness:${rpcCacheScope(rpc)}:${authority}`,
      SAT_RPC_PAYOUT_READINESS_CACHE_TTL_MS,
      payoutReadiness,
    );
  }

  return {
    globalState,
    currentCycle,
    currentSettlementProgress,
    currentMinerCycle,
    claimMinerCycle,
    minerCapital,
    payoutReadiness,
    treasuryState,
  };
}

export type SatMinerCapitalAccountStatusView = {
  address: string;
  exists: boolean;
  owner: string | null;
  expectedOwner: string;
  dataLength: number;
};

export async function inspectSatMinerCapitalAccountStatus(
  _config: SatMiningConfig,
  params: { authority: string },
): Promise<SatMinerCapitalAccountStatusView> {
  const { solana, programId } = await resolveProgramContext(process.env);
  const [address] = solana.PublicKey.findProgramAddressSync(
    [Buffer.from("sat_miner_capital_state"), new solana.PublicKey(params.authority).toBuffer()],
    programId,
  );
  const rpc = resolveEffectiveReadRpcConfig();
  const account = await fetchAccountRecordRaw(rpc, address.toBase58(), "miner-capital-status");
  return {
    address: address.toBase58(),
    exists: Boolean(account),
    owner: account?.owner ?? null,
    expectedOwner: programId.toBase58(),
    dataLength: account?.data.length ?? 0,
  };
}

export async function deriveSatBondPositionAddress(
  _config: SatMiningConfig,
  params: { authority: string },
): Promise<string> {
  const { solana, programId } = await resolveBondProgramContext(process.env);
  const layout = loadSatBondLayout();
  const [address] = solana.PublicKey.findProgramAddressSync(
    [Buffer.from(layout.pdaSeed), new solana.PublicKey(params.authority).toBuffer()],
    programId,
  );
  return address.toBase58();
}

export async function inspectSatBondPosition(
  _config: SatMiningConfig,
  params: { authority: string },
): Promise<SatBondPositionView | null> {
  const { solana, programId } = await resolveBondProgramContext(process.env);
  const layout = loadSatBondLayout();
  const [address] = solana.PublicKey.findProgramAddressSync(
    [Buffer.from(layout.pdaSeed), new solana.PublicKey(params.authority).toBuffer()],
    programId,
  );
  const rpc = resolveEffectiveReadRpcConfig();
  return await getOrLoadRpcCacheValue<SatBondPositionView | null>(
    `view:bond-position:${rpcCacheScope(rpc)}:${params.authority}`,
    SAT_RPC_LIVE_VIEW_CACHE_TTL_MS,
    async () => {
      const account = await fetchAccountInfoRaw(rpc, address.toBase58(), "bond-position");
      return account ? decodeSatBondPosition(account, address.toBase58()) : null;
    },
  );
}

export async function deriveSatBondTierPolicyAddress(_config: SatMiningConfig): Promise<string> {
  assertDedicatedBondProgramConfigured(process.env);
  const { solana, programId } = await resolveBondProgramContext(process.env);
  const layout = loadSatBondPolicyLayout();
  const [address] = solana.PublicKey.findProgramAddressSync(
    [Buffer.from(layout.pdaSeed)],
    programId,
  );
  return address.toBase58();
}

export async function inspectSatBondTierPolicy(
  _config: SatMiningConfig,
): Promise<SatBondTierPolicyView | null> {
  assertDedicatedBondProgramConfigured(process.env);
  const { solana, programId } = await resolveBondProgramContext(process.env);
  const layout = loadSatBondPolicyLayout();
  const [address] = solana.PublicKey.findProgramAddressSync(
    [Buffer.from(layout.pdaSeed)],
    programId,
  );
  const rpc = resolveEffectiveReadRpcConfig();
  return await getOrLoadRpcCacheValue<SatBondTierPolicyView | null>(
    `view:bond-tier-policy:${rpcCacheScope(rpc)}`,
    SAT_RPC_LIVE_VIEW_CACHE_TTL_MS,
    async () => {
      const account = await fetchAccountInfoRaw(rpc, address.toBase58(), "bond-tier-policy");
      return account ? decodeSatBondTierPolicy(account, address.toBase58()) : null;
    },
  );
}

export async function inspectSatBondStakingDistributor(
  _config: SatMiningConfig,
): Promise<SatBondStakingDistributorView | null> {
  assertDedicatedBondProgramConfigured(process.env);
  const { solana, programId } = await resolveBondProgramContext(process.env);
  const layout = loadSatBondStakingDistributorLayout();
  const [address] = solana.PublicKey.findProgramAddressSync(
    [Buffer.from(layout.pdaSeed)],
    programId,
  );
  const rpc = resolveEffectiveReadRpcConfig();
  return await getOrLoadRpcCacheValue<SatBondStakingDistributorView | null>(
    `view:bond-staking-distributor:${rpcCacheScope(rpc)}`,
    SAT_RPC_LIVE_VIEW_CACHE_TTL_MS,
    async () => {
      const expectedRewardVault = deriveAssociatedTokenAddress(
        solana,
        address,
        new solana.PublicKey(SAT_MINT_ADDRESS()),
      ).toBase58();
      const [distributorRecord, rewardVaultRecord] = await fetchMultipleAccountRecordsRaw(
        rpc,
        [address.toBase58(), expectedRewardVault],
        "bond-staking-distributor",
      );
      if (!distributorRecord?.data) {
        return null;
      }
      const view = decodeSatBondStakingDistributor(distributorRecord.data, address.toBase58());
      if (view.rewardVault === expectedRewardVault) {
        view.rewardVaultBalanceRaw = decodeSplTokenAccountAmount(rewardVaultRecord);
      }
      return view;
    },
  );
}

export async function inspectSatBondStakingPosition(
  _config: SatMiningConfig,
  params: { authority: string },
): Promise<SatBondStakingPositionView | null> {
  assertDedicatedBondProgramConfigured(process.env);
  const { solana, programId } = await resolveBondProgramContext(process.env);
  const layout = loadSatBondStakingPositionLayout();
  const [address] = solana.PublicKey.findProgramAddressSync(
    [Buffer.from(layout.pdaSeed), new solana.PublicKey(params.authority).toBuffer()],
    programId,
  );
  const rpc = resolveEffectiveReadRpcConfig();
  return await getOrLoadRpcCacheValue<SatBondStakingPositionView | null>(
    `view:bond-staking-position:${rpcCacheScope(rpc)}:${params.authority}`,
    SAT_RPC_LIVE_VIEW_CACHE_TTL_MS,
    async () => {
      const account = await fetchAccountInfoRaw(rpc, address.toBase58(), "bond-staking-position");
      return account ? decodeSatBondStakingPosition(account, address.toBase58()) : null;
    },
  );
}

export async function inspectSatCycleRegistryMeta(
  _config: SatMiningConfig,
  params: { cycleId: number },
): Promise<SatCycleRegistryMetaView | null> {
  const { solana, programId } = await resolveProgramContext(process.env);
  const [address] = solana.PublicKey.findProgramAddressSync(
    [Buffer.from("sat_cycle_registry_meta"), encodeU64(params.cycleId)],
    programId,
  );
  const rpc = resolveEffectiveReadRpcConfig();
  const account = await fetchAccountInfoRaw(rpc, address.toBase58(), "cycle-registry-meta");
  return account ? decodeSatCycleRegistryMeta(account, address.toBase58()) : null;
}

export async function listSettledSatCycleIds(_config: SatMiningConfig): Promise<number[]> {
  const { connection, programId } = await resolveConnection(process.env);
  const filters = [
    {
      memcmp: {
        offset: 0,
        bytes: encodeBase58(Uint8Array.from([ACCOUNT_DISCRIMINATOR.satCycleState])),
      },
    },
    {
      memcmp: {
        offset: 32,
        bytes: encodeBase58(Uint8Array.from([2])),
      },
    },
  ];
  const accounts = await connection.getProgramAccounts(programId, { filters });
  const cycleIds: number[] = [];
  for (const { pubkey, account } of accounts) {
    try {
      const decoded = decodeSatCycle(Buffer.from(account.data), pubkey.toBase58());
      if (decoded.status === 2) {
        cycleIds.push(decoded.cycleId);
      }
    } catch {
      continue;
    }
  }
  return cycleIds.sort((left, right) => left - right);
}

export async function inspectSatCycleSettlementProgressV2(
  _config: SatMiningConfig,
  params: { cycleId: number },
): Promise<SatCycleSettlementProgressV2View | null> {
  const { solana, programId } = await resolveProgramContext(process.env);
  const [address] = solana.PublicKey.findProgramAddressSync(
    [Buffer.from("sat_cycle_settlement_progress_v2"), encodeU64(params.cycleId)],
    programId,
  );
  const rpc = resolveEffectiveReadRpcConfig();
  return await getOrLoadRpcCacheValue<SatCycleSettlementProgressV2View | null>(
    `view:settlement-progress:${rpcCacheScope(rpc)}:${params.cycleId}`,
    SAT_RPC_LIVE_VIEW_CACHE_TTL_MS,
    async () => {
      const account = await fetchAccountInfoRaw(rpc, address.toBase58(), "settlement-progress");
      return account ? decodeSatCycleSettlementProgressV2(account, address.toBase58()) : null;
    },
  );
}

export async function inspectSatCycleRegistryPage(
  _config: SatMiningConfig,
  params: { cycleId: number; pageIndex: number },
): Promise<SatCycleRegistryPageView | null> {
  const { solana, programId } = await resolveProgramContext(process.env);
  const [address] = solana.PublicKey.findProgramAddressSync(
    [
      Buffer.from("sat_cycle_registry_page"),
      encodeU64(params.cycleId),
      encodeU64(params.pageIndex),
    ],
    programId,
  );
  const rpc = resolveEffectiveReadRpcConfig();
  const account = await fetchAccountInfoRaw(rpc, address.toBase58(), "cycle-registry-page");
  return account ? decodeSatCycleRegistryPage(account, address.toBase58()) : null;
}

export async function listSatMinerCycleAddressesForCycle(
  _config: SatMiningConfig,
  params: { cycleId: number },
): Promise<string[]> {
  const { connection, programId } = await resolveConnection(process.env);
  const filters = [
    {
      memcmp: {
        offset: 0,
        bytes: encodeBase58(Uint8Array.from([ACCOUNT_DISCRIMINATOR.satMinerCycleState])),
      },
    },
    {
      memcmp: {
        offset: 104,
        bytes: encodeBase58(encodeU64(params.cycleId)),
      },
    },
  ];
  const accounts = await connection.getProgramAccounts(programId, { filters });
  const participants: string[] = [];
  for (const { pubkey, account } of accounts) {
    try {
      const decoded = decodeSatMinerCycle(Buffer.from(account.data), pubkey.toBase58());
      if (decoded.cycleId === params.cycleId) {
        participants.push(pubkey.toBase58());
      }
    } catch {
      continue;
    }
  }
  return participants;
}

export async function inspectSatClaimReceipt(
  _config: SatMiningConfig,
  params: { signature: string },
): Promise<SatClaimReceipt | null> {
  const signature = String(params.signature ?? "").trim();
  if (!signature) {
    return null;
  }
  const { solana, programId } = await resolveConnection(process.env);
  const rpc = resolveEffectiveReadRpcConfig();
  const result = await rpcRequest<{
    meta?: {
      fee?: number;
      preBalances?: number[];
      postBalances?: number[];
      preTokenBalances?: Array<{ accountIndex?: number; uiTokenAmount?: { amount?: string } }>;
      postTokenBalances?: Array<{ accountIndex?: number; uiTokenAmount?: { amount?: string } }>;
    } | null;
    transaction?: {
      message?: {
        accountKeys?: Array<string | { pubkey?: string; signer?: boolean }>;
      } | null;
    } | null;
  } | null>(rpc, "getTransaction", [
    signature,
    { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
  ]);
  if (!result?.meta) {
    return null;
  }
  const feeLamports = BigInt(result.meta.fee ?? 0);
  const accountKeyEntries = Array.isArray(result.transaction?.message?.accountKeys)
    ? result.transaction?.message?.accountKeys
    : [];
  const accountKeys = accountKeyEntries.map((entry) =>
    typeof entry === "string" ? entry : String(entry.pubkey ?? ""),
  );
  const signerIndex = accountKeyEntries.findIndex(
    (entry) => typeof entry !== "string" && entry?.signer === true,
  );
  const fallbackSignerIndex =
    signerIndex >= 0 ? signerIndex : accountKeys.findIndex((entry) => entry.length > 0);
  let solRebateLamports = 0n;
  let capitalIndex = -1;
  if (fallbackSignerIndex >= 0) {
    try {
      const signer = new solana.PublicKey(accountKeys[fallbackSignerIndex]);
      const [capitalPda] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from("sat_miner_capital_state"), signer.toBuffer()],
        programId,
      );
      capitalIndex = accountKeys.findIndex((entry) => entry === capitalPda.toBase58());
    } catch {
      capitalIndex = -1;
    }
  }
  if (
    Array.isArray(result.meta.preBalances) &&
    Array.isArray(result.meta.postBalances) &&
    capitalIndex >= 0 &&
    capitalIndex < result.meta.preBalances.length &&
    capitalIndex < result.meta.postBalances.length
  ) {
    solRebateLamports =
      BigInt(result.meta.postBalances[capitalIndex] ?? 0) -
      BigInt(result.meta.preBalances[capitalIndex] ?? 0);
    if (solRebateLamports < 0n) {
      solRebateLamports = 0n;
    }
  } else if (
    fallbackSignerIndex >= 0 &&
    Array.isArray(result.meta.preBalances) &&
    Array.isArray(result.meta.postBalances) &&
    fallbackSignerIndex < result.meta.preBalances.length &&
    fallbackSignerIndex < result.meta.postBalances.length
  ) {
    const netLamports =
      BigInt(result.meta.postBalances[fallbackSignerIndex] ?? 0) -
      BigInt(result.meta.preBalances[fallbackSignerIndex] ?? 0);
    solRebateLamports = netLamports + feeLamports;
    if (solRebateLamports < 0n) {
      solRebateLamports = 0n;
    }
  }
  const preByIndex = new Map<number, bigint>();
  for (const entry of result.meta.preTokenBalances ?? []) {
    if (typeof entry.accountIndex === "number") {
      preByIndex.set(entry.accountIndex, BigInt(entry.uiTokenAmount?.amount ?? "0"));
    }
  }
  let transferredSatRaw = 0n;
  for (const entry of result.meta.postTokenBalances ?? []) {
    if (typeof entry.accountIndex !== "number") {
      continue;
    }
    const post = BigInt(entry.uiTokenAmount?.amount ?? "0");
    const pre = preByIndex.get(entry.accountIndex) ?? 0n;
    const delta = post - pre;
    if (delta > transferredSatRaw) {
      transferredSatRaw = delta;
    }
  }
  return {
    signature,
    feeLamports: feeLamports.toString(),
    claimedSatRaw: transferredSatRaw.toString(),
    transferredSatRaw: transferredSatRaw.toString(),
    solRebateLamports: solRebateLamports.toString(),
    payoutExecuted: transferredSatRaw > 0n || solRebateLamports > 0n,
    pendingPayoutRaw: transferredSatRaw.toString(),
  };
}

export async function inspectSatTxReceipt(
  _config: SatMiningConfig,
  params: { signature: string },
): Promise<SatTxReceipt | null> {
  const signature = String(params.signature ?? "").trim();
  if (!signature) {
    return null;
  }
  const rpc = resolveEffectiveReadRpcConfig();
  const result = await rpcRequest<{
    slot?: number;
    blockTime?: number | null;
    meta?: { fee?: number; logMessages?: string[] | null } | null;
  } | null>(rpc, "getTransaction", [
    signature,
    { encoding: "json", maxSupportedTransactionVersion: 0 },
  ]);
  if (!result) {
    return null;
  }
  return {
    signature,
    feeLamports: String(result.meta?.fee ?? 0),
    slot: result.slot,
    blockTime: result.blockTime,
    logMessages: Array.isArray(result.meta?.logMessages)
      ? result.meta?.logMessages.filter((entry) => typeof entry === "string")
      : undefined,
  };
}

export async function inspectSatSolBalanceLamports(
  _config: SatMiningConfig,
  params: { address: string },
): Promise<string | null> {
  const address = String(params.address ?? "").trim();
  if (!address) {
    return null;
  }
  const rpc = resolveEffectiveReadRpcConfig();
  return await fetchLamportBalanceRaw(rpc, address);
}

async function buildMemcmpFilters(
  discriminator: number,
  params: {
    validatorAuthority: string;
    epochId: number;
    microRoundId: number;
  },
) {
  const solana = await loadSolanaWeb3();
  return [
    {
      memcmp: {
        offset: 0,
        bytes: encodeBase58(Uint8Array.from([discriminator])),
      },
    },
    {
      memcmp: {
        offset: ACCOUNT_OFFSET.validatorAuthority,
        bytes: new solana.PublicKey(params.validatorAuthority).toBase58(),
      },
    },
    {
      memcmp: {
        offset: ACCOUNT_OFFSET.epochId,
        bytes: encodeBase58(encodeU64(params.epochId)),
      },
    },
    {
      memcmp: {
        offset: ACCOUNT_OFFSET.microRoundId,
        bytes: encodeBase58(encodeU64(params.microRoundId)),
      },
    },
  ];
}

async function fetchMiningStakeSummary(
  connection: SatReadConnectionLike,
  programId: import("@solana/web3.js").PublicKey,
  solana: SolanaModuleLike,
  authority: string,
) {
  const targetAuthority = new solana.PublicKey(authority);
  const [miningStake] = solana.PublicKey.findProgramAddressSync(
    [Buffer.from(MINING_STAKE_SEED), targetAuthority.toBuffer()],
    programId,
  );
  const rpc = resolveEffectiveReadRpcConfig();
  const account = await fetchAccountInfoRaw(rpc, miningStake.toBase58(), "mining-stake");
  if (!account) {
    throw new Error(`missing mining stake account for ${authority}`);
  }
  try {
    return decodeMiningStake(account);
  } catch {
    return {
      authority,
      shares: "0",
      originalStake: "0",
      rewardOwed: "0",
      jackpotOwed: "0",
      slashPenaltyOwed: "0",
      autoUnstakeThresholdBps: 0,
    } satisfies SatMiningStakeSummary;
  }
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

export async function inspectSatMiningStake(
  _config: SatMiningConfig,
  params: { authority: string },
): Promise<SatMiningStakeSummary | null> {
  const { solana, connection, programId } = await resolveConnection(process.env);
  const rpc = resolveEffectiveReadRpcConfig();
  return await getOrLoadRpcCacheValue<SatMiningStakeSummary | null>(
    `view:mining-stake:${rpcCacheScope(rpc)}:${params.authority}`,
    SAT_RPC_LIVE_VIEW_CACHE_TTL_MS,
    async () => await fetchMiningStakeSummary(connection, programId, solana, params.authority),
  );
}

export async function inspectSatPayoutReadiness(
  _config: SatMiningConfig,
  params: { authority: string },
) {
  const { solana, programId } = await resolveProgramContext(process.env);
  const owner = new solana.PublicKey(params.authority);
  const mint = new solana.PublicKey(SAT_MINT_ADDRESS());
  const [treasury] = solana.PublicKey.findProgramAddressSync([Buffer.from("treasury")], programId);
  const recipientAta = deriveAssociatedTokenAddress(solana, owner, mint);
  const treasuryAta = deriveAssociatedTokenAddress(solana, treasury, mint);
  const rpc = resolveEffectiveReadRpcConfig();
  return await getOrLoadRpcCacheValue(
    `view:payout-readiness:${rpcCacheScope(rpc)}:${params.authority}`,
    SAT_RPC_PAYOUT_READINESS_CACHE_TTL_MS,
    async () => {
      const [recipientInfo, treasuryInfo] = await fetchMultipleAccountRecordsRaw(
        rpc,
        [recipientAta.toBase58(), treasuryAta.toBase58()],
        "payout-readiness-atas",
      );
      const [recipientBalance, treasuryBalance] = await Promise.all([
        recipientInfo
          ? fetchTokenBalanceRaw(rpc, recipientAta.toBase58()).catch(() => null)
          : Promise.resolve(null),
        treasuryInfo
          ? fetchTokenBalanceRaw(rpc, treasuryAta.toBase58()).catch(() => null)
          : Promise.resolve(null),
      ]);
      return {
        treasuryAddress: treasury.toBase58(),
        treasuryAta: treasuryAta.toBase58(),
        recipientAta: recipientAta.toBase58(),
        treasuryAtaExists: Boolean(treasuryInfo),
        recipientAtaExists: Boolean(recipientInfo),
        treasuryBalanceRaw: treasuryBalance ?? undefined,
        recipientBalanceRaw: recipientBalance ?? undefined,
      };
    },
  );
}

export async function inspectSatTreasuryState(
  _config: SatMiningConfig,
): Promise<SatTreasuryStateView | null> {
  const { solana, programId } = await resolveProgramContext(process.env);
  const [address] = solana.PublicKey.findProgramAddressSync(
    [Buffer.from("sat_treasury_state")],
    programId,
  );
  const rpc = resolveEffectiveReadRpcConfig();
  return await getOrLoadRpcCacheValue<SatTreasuryStateView | null>(
    `view:treasury-state:${rpcCacheScope(rpc)}:${address.toBase58()}`,
    SAT_RPC_STABLE_VIEW_CACHE_TTL_MS,
    async () => {
      const account = await fetchAccountInfoRaw(rpc, address.toBase58(), "treasury-state");
      return account ? decodeSatTreasuryState(account, address.toBase58()) : null;
    },
  );
}

export async function inspectSatRegistryReserveLamports(
  _config: SatMiningConfig,
): Promise<{ address: string; lamports: string | null }> {
  const { solana, programId } = await resolveProgramContext(process.env);
  const [address] = solana.PublicKey.findProgramAddressSync(
    [Buffer.from("sat_registry_reserve")],
    programId,
  );
  const rpc = resolveEffectiveReadRpcConfig();
  return {
    address: address.toBase58(),
    lamports: await fetchLamportBalanceRaw(rpc, address.toBase58()),
  };
}

export async function inspectSatTreasuryVaultLamports(
  _config: SatMiningConfig,
): Promise<{ address: string; lamports: string | null }> {
  const { solana, programId } = await resolveProgramContext(process.env);
  const [address] = solana.PublicKey.findProgramAddressSync(
    [Buffer.from("sat_treasury_vault")],
    programId,
  );
  const rpc = resolveEffectiveReadRpcConfig();
  return {
    address: address.toBase58(),
    lamports: await fetchLamportBalanceRaw(rpc, address.toBase58()),
  };
}

export async function inspectSatRentExemptionLamports(config: SatMiningConfig): Promise<{
  registryReserveTargetLamports: string;
  protocolVaultLamports: string;
  cycleStateLamports: string;
  cycleRegistryMetaLamports: string;
  cycleRegistryPageLamports: string;
  cycleSettlementProgressLamports: string;
  minerCycleLamports: string;
  unlockIntervalLamports: string;
  openCycleLamports: string;
  submitCycleSharedLamports: string;
  submitCycleSignerLamports: string;
}> {
  const { connection } = await resolveConnection(process.env);
  const rpc = resolveEffectiveReadRpcConfig();
  const registryReserveTargetLamports = resolveSatGenesisProfileContract(
    config.network,
  ).registryReserveTargetLamports;
  return await getOrLoadRpcCacheValue(
    `view:rent-exemption:${rpcCacheScope(rpc)}:${registryReserveTargetLamports}`,
    SAT_RPC_RENT_EXEMPTION_CACHE_TTL_MS,
    async () => {
      const [
        protocolVaultLamports,
        cycleStateLamports,
        cycleRegistryMetaLamports,
        cycleRegistryPageLamports,
        cycleSettlementProgressLamports,
        minerCycleLamports,
        unlockIntervalLamports,
      ] = await Promise.all([
        connection.getMinimumBalanceForRentExemption(SAT_RENT_ACCOUNT_SPACES.protocolVault),
        connection.getMinimumBalanceForRentExemption(SAT_RENT_ACCOUNT_SPACES.cycleState),
        connection.getMinimumBalanceForRentExemption(SAT_RENT_ACCOUNT_SPACES.cycleRegistryMeta),
        connection.getMinimumBalanceForRentExemption(SAT_RENT_ACCOUNT_SPACES.cycleRegistryPage),
        connection.getMinimumBalanceForRentExemption(
          SAT_RENT_ACCOUNT_SPACES.cycleSettlementProgressV2,
        ),
        connection.getMinimumBalanceForRentExemption(SAT_RENT_ACCOUNT_SPACES.minerCycle),
        connection.getMinimumBalanceForRentExemption(SAT_RENT_ACCOUNT_SPACES.unlockInterval),
      ]);
      const openCycleLamports = cycleStateLamports + cycleRegistryMetaLamports;
      const submitCycleSharedLamports = calculateSatRevealSharedRentLamports({
        cycleSettlementProgressLamports,
        cycleRegistryPageLamports,
        unlockIntervalLamports,
      });
      return {
        registryReserveTargetLamports: String(registryReserveTargetLamports),
        protocolVaultLamports: String(protocolVaultLamports),
        cycleStateLamports: String(cycleStateLamports),
        cycleRegistryMetaLamports: String(cycleRegistryMetaLamports),
        cycleRegistryPageLamports: String(cycleRegistryPageLamports),
        cycleSettlementProgressLamports: String(cycleSettlementProgressLamports),
        minerCycleLamports: String(minerCycleLamports),
        unlockIntervalLamports: String(unlockIntervalLamports),
        openCycleLamports: String(openCycleLamports),
        submitCycleSharedLamports: String(submitCycleSharedLamports),
        submitCycleSignerLamports: String(minerCycleLamports),
      };
    },
  );
}

export async function inspectSatValidatorAttestation(
  _config: SatMiningConfig,
  params: {
    validatorAuthority: string;
    targetAuthority: string;
    epochId: number;
    microRoundId: number;
  },
): Promise<SatValidatorAttestationView> {
  const { solana, connection, programId } = await resolveConnection(process.env);
  const validatorAuthority = new solana.PublicKey(params.validatorAuthority);
  const targetAuthority = new solana.PublicKey(params.targetAuthority);
  const [attestationAddress] = solana.PublicKey.findProgramAddressSync(
    [
      Buffer.from(SAT_VALIDATOR_ATTESTATION_SEED),
      validatorAuthority.toBuffer(),
      targetAuthority.toBuffer(),
      encodeU64(params.epochId),
      encodeU64(params.microRoundId),
    ],
    programId,
  );
  const rpc = resolveEffectiveReadRpcConfig();
  const account = await fetchAccountInfoRaw(
    rpc,
    attestationAddress.toBase58(),
    "validator-attestation",
  );
  if (!account) {
    throw new Error(
      `missing SAT validator attestation for ${params.validatorAuthority} at ${params.epochId}:${params.microRoundId}`,
    );
  }
  const decoded = decodeValidatorAttestation(account, attestationAddress.toBase58());
  const targetMiningStake = await fetchMiningStakeSummary(
    connection,
    programId,
    solana,
    decoded.targetAuthority,
  );
  return { ...decoded, targetMiningStake };
}

export async function inspectSatDispute(
  _config: SatMiningConfig,
  params: {
    validatorAuthority: string;
    targetAuthority: string;
    epochId: number;
    microRoundId: number;
  },
): Promise<SatDisputeView> {
  const { solana, connection, programId } = await resolveConnection(process.env);
  const validatorAuthority = new solana.PublicKey(params.validatorAuthority);
  const targetAuthority = new solana.PublicKey(params.targetAuthority);
  const [disputeAddress] = solana.PublicKey.findProgramAddressSync(
    [
      Buffer.from(SAT_DISPUTE_SEED),
      validatorAuthority.toBuffer(),
      targetAuthority.toBuffer(),
      encodeU64(params.epochId),
      encodeU64(params.microRoundId),
    ],
    programId,
  );
  const rpc = resolveEffectiveReadRpcConfig();
  const account = await fetchAccountInfoRaw(rpc, disputeAddress.toBase58(), "dispute");
  if (!account) {
    throw new Error(
      `missing SAT dispute for ${params.validatorAuthority} at ${params.epochId}:${params.microRoundId}`,
    );
  }
  const decoded = decodeDispute(account, disputeAddress.toBase58());
  const epochView = await inspectSatEpoch(_config, { epochId: params.epochId });
  const targetMiningStake = await fetchMiningStakeSummary(
    connection,
    programId,
    solana,
    decoded.targetAuthority,
  );
  return {
    ...decoded,
    epochClaimStatus: {
      blocked: epochView.claimsBlocked,
      blockedReason: epochView.blockedReason,
      openDisputeCount: epochView.openDisputeCount,
      validatorRejectCount: epochView.validatorRejectCount,
      slashReasonCode: epochView.slashReasonCode,
    },
    targetMiningStake,
  };
}

export async function inspectSatEpoch(
  _config: SatMiningConfig,
  params: { epochId: number },
): Promise<SatEpochView> {
  const { solana, programId } = await resolveProgramContext(process.env);
  const [epochAddress] = solana.PublicKey.findProgramAddressSync(
    [Buffer.from("sat_epoch"), encodeU64(params.epochId)],
    programId,
  );
  const rpc = resolveEffectiveReadRpcConfig();
  return await getOrLoadRpcCacheValue<SatEpochView>(
    `view:epoch:${rpcCacheScope(rpc)}:${params.epochId}`,
    SAT_RPC_ACCOUNT_RECORD_CACHE_TTL_MS,
    async () => {
      const account = await fetchAccountInfoRaw(rpc, epochAddress.toBase58(), "epoch");
      if (!account) {
        throw new Error(`missing SAT epoch for ${params.epochId}`);
      }
      return decodeSatEpoch(account, epochAddress.toBase58());
    },
  );
}

export async function inspectSatWalletEpoch(
  _config: SatMiningConfig,
  params: { authority: string; epochId: number },
): Promise<SatWalletEpochView | null> {
  const { solana, programId } = await resolveProgramContext(process.env);
  const [address] = solana.PublicKey.findProgramAddressSync(
    [
      Buffer.from("sat_wallet_epoch"),
      new solana.PublicKey(params.authority).toBuffer(),
      encodeU64(params.epochId),
    ],
    programId,
  );
  const rpc = resolveEffectiveReadRpcConfig();
  return await getOrLoadRpcCacheValue<SatWalletEpochView | null>(
    `view:wallet-epoch:${rpcCacheScope(rpc)}:${params.authority}:${params.epochId}`,
    SAT_RPC_LIVE_VIEW_CACHE_TTL_MS,
    async () => {
      const account = await fetchAccountInfoRaw(rpc, address.toBase58(), "wallet-epoch");
      if (!account) {
        return null;
      }
      return decodeSatWalletEpoch(account, address.toBase58());
    },
  );
}

export async function inspectSatRoundCommit(
  _config: SatMiningConfig,
  params: { authority: string; epochId: number; microRoundId: number },
): Promise<SatRoundCommitView | null> {
  const { solana, programId } = await resolveProgramContext(process.env);
  const [address] = solana.PublicKey.findProgramAddressSync(
    [
      Buffer.from("sat_round_commit"),
      new solana.PublicKey(params.authority).toBuffer(),
      encodeU64(params.epochId),
      encodeU64(params.microRoundId),
    ],
    programId,
  );
  const rpc = resolveEffectiveReadRpcConfig();
  return await getOrLoadRpcCacheValue<SatRoundCommitView | null>(
    `view:round-commit:${rpcCacheScope(rpc)}:${params.authority}:${params.epochId}:${params.microRoundId}`,
    SAT_RPC_LIVE_VIEW_CACHE_TTL_MS,
    async () => {
      const account = await fetchAccountInfoRaw(rpc, address.toBase58(), "round-commit");
      if (!account) {
        return null;
      }
      return decodeSatRoundCommit(account, address.toBase58());
    },
  );
}

export async function inspectSatRoundState(
  _config: SatMiningConfig,
  params: { epochId: number; microRoundId: number },
): Promise<SatRoundStateView | null> {
  const { solana, programId } = await resolveProgramContext(process.env);
  const [address] = solana.PublicKey.findProgramAddressSync(
    [Buffer.from("sat_round_state"), encodeU64(params.epochId), encodeU64(params.microRoundId)],
    programId,
  );
  const rpc = resolveEffectiveReadRpcConfig();
  return await getOrLoadRpcCacheValue<SatRoundStateView | null>(
    `view:round-state:${rpcCacheScope(rpc)}:${params.epochId}:${params.microRoundId}`,
    SAT_RPC_LIVE_VIEW_CACHE_TTL_MS,
    async () => {
      const account = await fetchAccountInfoRaw(rpc, address.toBase58(), "round-state");
      if (!account) {
        return null;
      }
      return decodeSatRoundState(account, address.toBase58());
    },
  );
}

export function inspectSatConnectionDetails() {
  const rpc = resolveEffectiveReadRpcConfig();
  const endpointStates = [rpc.primaryUrl, rpc.secondaryUrl]
    .filter((rpcUrl): rpcUrl is string => Boolean(rpcUrl))
    .map((rpcUrl) => {
      const state = satReadRpcEndpointStates.get(normalizeRpcUrlForComparison(rpcUrl));
      return {
        rpcUrl: redactSensitiveUrlLikeString(rpcUrl),
        consecutiveFailures: state?.consecutiveFailures ?? 0,
        backoffRemainingMs: currentReadRpcBackoffMs(rpcUrl),
        quotaLikely: state?.quotaLikely ?? false,
        lastError: state?.lastError ? redactSensitiveUrlLikeString(state.lastError) : null,
        lastFailureAt: state?.lastFailureAt ?? null,
        lastSuccessAt: state?.lastSuccessAt ?? null,
      };
    });
  return {
    programId: SAT_PROGRAM_ID(),
    bondProgramId: SAT_BOND_PROGRAM_ID(),
    rpcUrl: redactSensitiveUrlLikeString(rpc.primaryUrl),
    readRpcFallbackUrl: rpc.secondaryUrl ? redactSensitiveUrlLikeString(rpc.secondaryUrl) : null,
    rpcState: {
      ...satReadRpcRuntimeState,
      lastError: satReadRpcRuntimeState.lastError
        ? redactSensitiveUrlLikeString(satReadRpcRuntimeState.lastError)
        : null,
      lastRpcUrl: satReadRpcRuntimeState.lastRpcUrl
        ? redactSensitiveUrlLikeString(satReadRpcRuntimeState.lastRpcUrl)
        : null,
      quotaLikely:
        satReadRpcRuntimeState.quotaLikely ||
        looksLikeRpcQuotaFailure(satReadRpcRuntimeState.lastError),
      endpoints: endpointStates,
    },
    rpcMetrics: summarizeSatRpcMethodMetrics(),
  };
}

export async function inspectCurrentSatRoundBucket(
  _config: SatMiningConfig,
): Promise<SatRoundBucketView | null> {
  const { solana, programId } = await resolveConnection(process.env);
  const [roundBucketAddress] = solana.PublicKey.findProgramAddressSync(
    [Buffer.from("sat_round_bucket")],
    programId,
  );
  const rpc = resolveEffectiveReadRpcConfig();
  const account = await fetchAccountInfoRaw(
    rpc,
    roundBucketAddress.toBase58(),
    "current-round-bucket",
  );
  if (!account) {
    return null;
  }
  return decodeSatRoundBucket(account, roundBucketAddress.toBase58());
}

export async function listSatValidatorAttestations(
  _config: SatMiningConfig,
  params: {
    validatorAuthority: string;
    epochId: number;
    microRoundId: number;
    reasonCode?: number;
    decisionFlag?: number;
    requireNonzeroSlashPenalty?: boolean;
    sortBy?: SatListSortField;
    sortOrder?: "asc" | "desc";
  },
): Promise<SatRoundAttestationListView> {
  const { solana, connection, programId } = await resolveConnection(process.env);
  const epochView = await inspectSatEpoch(_config, { epochId: params.epochId });
  const filters = await buildMemcmpFilters(ACCOUNT_DISCRIMINATOR.satValidatorAttestation, params);
  const accounts = await connection.getProgramAccounts(programId, { filters });
  const attestations = await Promise.all(
    accounts.map(async ({ pubkey, account }) => {
      const decoded = decodeValidatorAttestation(Buffer.from(account.data), pubkey.toBase58());
      const targetMiningStake = await fetchMiningStakeSummary(
        connection,
        programId,
        solana,
        decoded.targetAuthority,
      );
      return { ...decoded, targetMiningStake };
    }),
  );
  const enriched = attestations.map((item) => ({
    ...item,
    epochClaimStatus: {
      blocked: epochView.claimsBlocked,
      blockedReason: epochView.blockedReason,
      openDisputeCount: epochView.openDisputeCount,
      validatorRejectCount: epochView.validatorRejectCount,
      slashReasonCode: epochView.slashReasonCode,
    },
  }));
  const filtered = enriched
    .filter((item) =>
      typeof params.reasonCode === "number" ? item.reasonCode === params.reasonCode : true,
    )
    .filter((item) =>
      typeof params.decisionFlag === "number" ? item.decisionFlag === params.decisionFlag : true,
    )
    .filter((item) =>
      params.requireNonzeroSlashPenalty ? item.targetMiningStake.slashPenaltyOwed !== "0" : true,
    );
  sortSatRows(filtered, params.sortBy ?? "targetAuthority", params.sortOrder ?? "asc");
  return {
    validatorAuthority: params.validatorAuthority,
    epochId: params.epochId,
    microRoundId: params.microRoundId,
    count: filtered.length,
    filters: buildListFilters(params),
    attestations: filtered,
  };
}

export async function listSatDisputes(
  _config: SatMiningConfig,
  params: {
    validatorAuthority: string;
    epochId: number;
    microRoundId: number;
    reasonCode?: number;
    requireNonzeroSlashPenalty?: boolean;
    sortBy?: SatListSortField;
    sortOrder?: "asc" | "desc";
  },
): Promise<SatRoundDisputeListView> {
  const { solana, connection, programId } = await resolveConnection(process.env);
  const epochView = await inspectSatEpoch(_config, { epochId: params.epochId });
  const filters = await buildMemcmpFilters(ACCOUNT_DISCRIMINATOR.satDispute, params);
  const accounts = await connection.getProgramAccounts(programId, { filters });
  const disputes = await Promise.all(
    accounts.map(async ({ pubkey, account }) => {
      const decoded = decodeDispute(Buffer.from(account.data), pubkey.toBase58());
      const targetMiningStake = await fetchMiningStakeSummary(
        connection,
        programId,
        solana,
        decoded.targetAuthority,
      );
      return { ...decoded, targetMiningStake };
    }),
  );
  const enriched = disputes.map((item) => ({
    ...item,
    epochClaimStatus: {
      blocked: epochView.claimsBlocked,
      blockedReason: epochView.blockedReason,
      openDisputeCount: epochView.openDisputeCount,
      validatorRejectCount: epochView.validatorRejectCount,
      slashReasonCode: epochView.slashReasonCode,
    },
  }));
  const filtered = enriched
    .filter((item) =>
      typeof params.reasonCode === "number" ? item.reasonCode === params.reasonCode : true,
    )
    .filter((item) =>
      params.requireNonzeroSlashPenalty ? item.targetMiningStake.slashPenaltyOwed !== "0" : true,
    );
  sortSatRows(filtered, params.sortBy ?? "targetAuthority", params.sortOrder ?? "asc");
  return {
    validatorAuthority: params.validatorAuthority,
    epochId: params.epochId,
    microRoundId: params.microRoundId,
    count: filtered.length,
    filters: buildListFilters(params),
    disputes: filtered,
  };
}

function buildListFilters(params: SatListFilters): SatListFilters {
  return {
    reasonCode: params.reasonCode,
    decisionFlag: params.decisionFlag,
    requireNonzeroSlashPenalty: params.requireNonzeroSlashPenalty ?? false,
    sortBy: params.sortBy,
    sortOrder: params.sortOrder,
  };
}

function sortSatRows<T extends SatValidatorAttestationView | SatDisputeView>(
  rows: T[],
  sortBy: SatListSortField,
  sortOrder: "asc" | "desc",
) {
  const direction = sortOrder === "desc" ? -1 : 1;
  rows.sort((left, right) => {
    const leftValue = sortableValue(left, sortBy);
    const rightValue = sortableValue(right, sortBy);
    if (leftValue < rightValue) {
      return -1 * direction;
    }
    if (leftValue > rightValue) {
      return 1 * direction;
    }
    return left.targetAuthority.localeCompare(right.targetAuthority) * direction;
  });
}

function sortableValue(
  row: SatValidatorAttestationView | SatDisputeView,
  sortBy: SatListSortField,
): number | string {
  switch (sortBy) {
    case "reasonCode":
      return row.reasonCode;
    case "decisionFlag":
      return "decisionFlag" in row ? row.decisionFlag : -1;
    case "slashPenaltyOwed":
      return BigInt(row.targetMiningStake.slashPenaltyOwed).toString().padStart(32, "0");
    case "attestedAt":
      return "attestedAt" in row ? row.attestedAt : -1;
    case "openedAt":
      return "openedAt" in row ? row.openedAt : -1;
    case "targetAuthority":
    default:
      return row.targetAuthority;
  }
}
