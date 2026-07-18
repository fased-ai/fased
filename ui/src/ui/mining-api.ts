export type SatMinerRole = "miner" | "validator" | "admin";

export type SatMiningNetwork = "local" | "devnet" | "mainnet-beta";

export type SatRiskMode = "conservative" | "balanced" | "aggressive" | "swarm";

export type SatClaimMode = "auto" | "prompt" | "manual";

export type SatMiningStrategyMode = "base" | "skill";
export type SatMiningStrategyExecution = "deterministic" | "auto";
export type SatMiningCycleCadence = 1 | 2 | 6 | 12;
export type SatMiningStrategyPreset =
  | "spread"
  | "balanced"
  | "conviction"
  | "swarm"
  | "top_k"
  | "ranked"
  | "adaptive"
  | "crowd_aware"
  | "safe_fallback";
export type SatMiningHistoryWindow = "1h" | "24h" | "7d" | "30d" | "1y" | "all";

export type SatSignerCapability = "background-ready" | "interactive-only" | "unsupported";

export type SatMiningAutomationSettings = {
  autoFinalizeEpoch: boolean;
  autoClaim: boolean;
  claimBatchCycles?: number;
  satSweep?: {
    enabled: boolean;
    destinationWalletId?: string;
    destinationAddress?: string;
    mode?: "all" | "percentage";
    percentage?: number;
    minRaw?: string;
    keepRaw?: string;
  };
};

export type SatMinerProfile = {
  walletId: string;
  role: SatMinerRole;
  network: SatMiningNetwork;
  riskMode: SatRiskMode;
  strategyPreset: SatMiningStrategyPreset;
  strategyExecution: SatMiningStrategyExecution;
  cycleCadence: SatMiningCycleCadence;
  claimMode: SatClaimMode;
  payout: boolean;
  strategyMode: SatMiningStrategyMode;
  automation: SatMiningAutomationSettings;
  funding: {
    commitLamports: string;
    minSolBalanceLamports: string;
  };
  skillConfig?: {
    enabled: boolean;
    useAgentDefaultModel: boolean;
    preferredSkillId?: string;
    preferredModelId?: string;
    fallbackToBaseOnFailure: boolean;
    maxDecisionLatencyMs?: number;
  };
  federation?: {
    federationHandle?: string;
    federationPeers?: string[];
    coordinationGroup?: string;
  };
};

export type SatMiningWalletOption = {
  walletId: string;
  walletName: string;
  providerId:
    | "embedded-keystore"
    | "local-socket-signer"
    | "alchemy"
    | "turnkey"
    | "wallet-standard"
    | "privy";
  role?: "agent" | "vault" | "mining";
  signerCapability: SatSignerCapability;
  signerCapabilityReason?: string;
  address: string;
  rpcReady: boolean;
  solBalanceLamports?: string;
  solBalanceDisplay?: string;
};

export type MiningUiNotification = {
  id: string;
  level: "success" | "warning" | "error" | "info";
  message: string;
  createdAt: string;
};

export type SatMainnetSyncState = "not_live" | "available" | "synced" | "failed";

export type SatMainnetSyncRuntimeIds = {
  programId: string;
  bondProgramId: string;
  mintAddress: string;
  mintProgramId: string;
};

export type SatMainnetSyncStatus = {
  ok: boolean;
  state: SatMainnetSyncState;
  manifestUrl: string;
  checkedAt: string;
  message: string;
  manifestStatus?: "not_live" | "live";
  releaseTag?: string;
  sourceCommit?: string;
  localIds?: SatMainnetSyncRuntimeIds | null;
  officialIds?: SatMainnetSyncRuntimeIds | null;
  needsSync?: boolean;
  runtimeFile?: string;
  verification: {
    hash: "valid" | "missing" | "invalid" | "not_required";
    signature: "valid" | "missing" | "invalid" | "not_required";
  };
  error?: string;
};

export type SatMiningReadinessCheck = {
  key:
    | "walletSelected"
    | "signerReady"
    | "rpcReady"
    | "fundingReady"
    | "minerInitialized"
    | "cycleEntryReady"
    | "ataReady";
  ok: boolean;
  level: "info" | "warning" | "error";
  label: string;
  detail?: string;
  remediation?: string;
};

export type SatMiningReadiness = {
  ok: boolean;
  selectedWalletId?: string;
  selectedAddress?: string;
  signerCapability?: SatSignerCapability;
  checks: SatMiningReadinessCheck[];
  warnings: string[];
  balances: {
    solBalanceLamports?: string;
    solBalanceDisplay?: string;
    satBalanceRaw?: string;
    satBalanceDisplay?: string;
    treasurySatBalanceRaw?: string;
    minerCapitalAddress?: string;
    minerCapitalFundedLamports?: string;
    minerCapitalLockedLamports?: string;
    minerCapitalFreeLamports?: string;
    minerCapitalActiveCommitLamports?: string;
    minerCapitalFirstPendingCycleId?: number;
    minerCapitalLastPendingCycleId?: number;
  };
  stake?: {
    shares?: string;
    rewardOwed?: string;
    slashPenaltyOwed?: string;
    jackpotOwed?: string;
  };
};

export type SatMiningRuntimeStatus = {
  running: boolean;
  enabledWanted?: boolean;
  drainOnly?: boolean;
  statusFresh?: boolean;
  degraded?: boolean;
  walletId?: string;
  role?: SatMinerRole;
  strategyPreset?: SatMiningStrategyPreset;
  strategyExecution?: SatMiningStrategyExecution;
  cycleCadence?: SatMiningCycleCadence;
  runway?: {
    commitCollateralLamports: string;
    estimatedParticipations: string | null;
    estimatedCalendarCycles: string | null;
    estimatedDays: number | null;
    excludesNetworkFees: boolean;
  } | null;
  strategyMode?: SatMiningStrategyMode;
  network: SatMiningNetwork;
  riskMode: SatRiskMode;
  snapshotAt?: string;
  bootstrapState?: "idle" | "waiting" | "ready";
  bootstrapReason?: string | null;
  bootstrapCheckedAt?: string | null;
  bootstrapReadyAt?: string | null;
  bootstrapWalletId?: string | null;
  bootstrapChainTimeFreshness?: "fresh" | "stale" | "degraded" | null;
  currentCycleId?: number;
  latestSettledCycleId?: number | null;
  latestSubmittedCycleId?: number | null;
  pendingCycleIds?: number[];
  exactPendingCycleId?: number | null;
  exactPendingStage?: string | null;
  exactPendingReason?: string | null;
  missingCycleStartId?: number | null;
  missingCycleEndId?: number | null;
  missingCycleCount?: number;
  chainTime?: {
    chainUnixTime: number | null;
    derivedCycleId: number | null;
    fetchedAt: string | null;
    freshness: "fresh" | "stale" | "degraded";
    source: "rpc" | "cache" | "local-display" | "unavailable";
    lastError: string | null;
    consecutiveFailures: number;
  } | null;
  currentUnlockTargetLamports?: string;
  currentUnlockProgressLamports?: string;
  currentUnlockRatioFp?: string;
  issuanceYearIndex?: number;
  yearBudgetSatRaw?: string;
  yearIssuedSatRaw?: string;
  totalIssuedSatRaw?: string;
  scheduledBudgetLeftSatRaw?: string;
  lifetimeSupplyLeftSatRaw?: string;
  launchCycleId?: string;
  currentEpochId?: number;
  currentMicroRoundId?: number;
  currentBoardHash?: string;
  currentBoardRoot?: string;
  currentScoreRoot?: string;
  roundOpenTs?: number;
  roundCloseTs?: number;
  liveRoundOpen?: boolean;
  secondsUntilRoundClose?: number;
  secondsSinceRoundClose?: number;
  nextAction?:
    | "participation"
    | "finalize-epoch"
    | "mining-crank"
    | "claim"
    | "starting"
    | "wait"
    | "recover";
  nextActionDetail?: string;
  claimableSatRaw?: string;
  claimableSatDisplay?: string;
  currentSolBalanceLamports?: string;
  signerReserveLamports?: string | null;
  signerFeeBufferLamports?: string | null;
  signerSpendableLamports?: string | null;
  currentSatBalanceRaw?: string;
  registryReserveAddress?: string | null;
  registryReserveLamports?: string | null;
  registryReserveTargetLamports?: string | null;
  registryReserveShortfallLamports?: string | null;
  nextOpenCycleLamports?: string | null;
  nextSubmitCycleSharedLamports?: string | null;
  nextSubmitCycleSignerLamports?: string | null;
  currentCapitalAddress?: string | null;
  currentCapitalFundedLamports?: string;
  currentCapitalLockedLamports?: string;
  currentCapitalFreeLamports?: string;
  currentCapitalFirstPendingCycleId?: number | null;
  currentCapitalLastPendingCycleId?: number | null;
  currentCapitalPendingCycleCount?: number | null;
  claimBatchCycles?: number;
  claimBacklog?: {
    total: number;
    pending: number;
    ready: number;
    failed: number;
    claiming: number;
    oldestPendingCycleId: number | null;
    oldestPendingAgeMs: number | null;
    maxRetryCount: number;
    entries: Array<{
      cycleId: number;
      stage: "pending" | "ready" | "claiming" | "claimed" | "blocked" | "failed" | "resolved";
      retryCount: number;
      firstSeenAt: string;
      lastUpdatedAt: string;
      lastError: string | null;
      lastTxHash: string | null;
      reason: string | null;
    }>;
  };
  activeCommitLamports?: string;
  runStartSolBalanceLamports?: string | null;
  runStartSatBalanceRaw?: string | null;
  runDeltaSolLamports?: string | null;
  runDeltaSatRaw?: string | null;
  blocked: boolean;
  blockedReason?: string;
  validatorAuthority?: string | null;
  programId?: string;
  tokenMintAddress?: string;
  tokenMintProgramId?: string;
  rpcUrl?: string;
  readRpcFallbackUrl?: string | null;
  rpcState?: {
    lastMode: "primary" | "fallback" | "unavailable";
    fallbackCount: number;
    lastError: string | null;
    lastFailureAt: string | null;
    lastSuccessAt: string | null;
    lastRpcUrl: string | null;
    quotaLikely: boolean;
  } | null;
  rpcMetrics?: {
    windowLastHourMs: number;
    windowLast24HoursMs: number;
    methods: Array<{
      method: string;
      requestsSinceStart: number;
      successesSinceStart: number;
      failuresSinceStart: number;
      requestsLastHour: number;
      successesLastHour: number;
      failuresLastHour: number;
      requestsLast24Hours: number;
      successesLast24Hours: number;
      failuresLast24Hours: number;
      lastRequestAt: string | null;
      lastSuccessAt: string | null;
      lastFailureAt: string | null;
    }>;
  } | null;
  lastParticipationTxHash?: string | null;
  lastParticipationAt?: string | null;
  lastMiningCrankTxHash?: string | null;
  lastMiningCrankAt?: string | null;
  lastClaimTxHash?: string | null;
  lastClaimAt?: string | null;
  lastClaimAccountedSatRaw?: string | null;
  lastClaimTransferredSatRaw?: string | null;
  lastClaimSolRebateLamports?: string | null;
  lastClaimFeeLamports?: string | null;
  liveCycleReport?: {
    cycleId: number;
    cycleStatus?: number | null;
    cycleStatePresent: boolean;
    minerStatePresent: boolean;
    validMinerCount?: string | null;
    committedLamports: string;
    erosionLamports: string;
    unlockTargetLamports?: string | null;
    totalCommittedLamports?: string | null;
    unlockRatioFp?: string | null;
    issuedMinerSatRaw?: string | null;
    unissuedMinerSatRaw?: string | null;
    claimableSatRaw: string;
    claimedSatRaw: string;
    totalSatEarnedRaw: string;
    claimableDetRebateLamports: string;
    claimablePerfRebateLamports: string;
    claimedDetRebateLamports: string;
    claimedPerfRebateLamports: string;
    totalRebateLamports: string;
    deterministicRebatePoolLamports?: string | null;
    performanceRebatePoolLamports?: string | null;
    placementReturnFp?: string | null;
    benchmarkReturnFp?: string | null;
    skillScoreFp?: string | null;
    rewardWeightFp?: string | null;
    powerWeightFp?: string | null;
    txFeeLamports: string;
    netProtocolSolLamports: string;
    netLiveCostLamports: string;
  } | null;
  recentTxFees?: Array<{
    action: string;
    cycleId?: number | null;
    at: string;
    txHash: string | null;
    feeLamports: string;
  }>;
  recentCycleFeeBuckets?: Array<{
    cycleId: number;
    totalFeeLamports: string;
    actions: Array<{
      action: string;
      feeLamports: string;
      txHash: string | null;
      at: string;
    }>;
  }>;
  recentTxFeeTotalLamports?: string;
  epochRewardsSatRaw?: string;
  currentStakeUnits?: string;
  lastAction?: string | null;
  lastActionTxHash?: string | null;
  lastFailure?: string | null;
  workers?: Partial<
    Record<
      "roundWatcher" | "epoch" | "claim" | "recovery",
      {
        enabled: boolean;
        running: boolean;
        retryCount: number;
        rpcTimeoutCount?: number;
        waitingReason: string | null;
        nextScheduledAt: string | null;
        lastRunAt: string | null;
        lastSuccessAt: string | null;
        lastFailureAt: string | null;
        lastError: string | null;
        lastDetail: string | null;
        lastSelectedCycleId?: number | null;
        lastSelectedStage?: string | null;
        lastSkipReason?: string | null;
      }
    >
  >;
  timeline?: Array<{
    key: "participation" | "finalize-epoch" | "mining-crank" | "claim";
    label: string;
    status: "completed" | "pending" | "blocked";
    detail?: string;
  }>;
  recentActions?: Array<{
    action: string;
    cycleId?: number | null;
    txHash: string | null;
    status: "success" | "failure";
    message?: string | null;
    at: string;
  }>;
  archivedFailures?: Array<{
    action: string;
    txHash: string | null;
    status: "success" | "failure";
    message?: string | null;
    at: string;
  }>;
  currentRunStartedAt?: string | null;
  lastRoundWatchAt?: string | null;
  lastStrategyDecision?: {
    source: "base" | "skill";
    modelId?: string;
    skillId?: string;
    decidedAt: string;
    rationale?: string;
    fallbackUsed?: boolean;
  } | null;
  lastPlannerDecision?: {
    source: "rule";
    cycleId: number;
    shouldSubmit: boolean;
    commitLamports: string;
    riskMode: SatRiskMode;
    strategyPreset: SatMiningStrategyPreset;
    strategyExecution: SatMiningStrategyExecution;
    decidedAt: string;
    rationale?: string;
    policy?: {
      policyVersion: string;
      decisionEngine: "rule" | "ucb" | "thompson";
      explorationPolicy: "epsilon-greedy" | "ucb" | "thompson" | "none";
      explorationRatePpm: string;
      explorationTaken: boolean;
      capitalTier: "starter" | "standard" | "deep";
      contextKey: string;
      actionKey: string;
      baselineActionKey: string;
      confidenceRadius: string | null;
    } | null;
    snapshot: {
      walletBalanceLamports?: string | null;
      capitalFundedLamports?: string | null;
      capitalFreeLamports?: string | null;
      reserveLamports: string;
      feeBufferLamports: string;
      safeSpendLamports?: string | null;
      minimumEntryLamports: string;
      configuredCommitLamports: string;
      participantCount: number;
      pageCount: number;
      totalCommittedLamports: string;
      unlockTargetLamports: string;
      crowdingRatioFp: string;
      previousCycleId?: number;
      previousParticipantCount?: number;
      previousClaimableSatRaw?: string;
      previousTotalRebateLamports?: string;
      previousValidParticipation?: boolean;
    };
  } | null;
  plannerMemorySummary?: {
    samples: number;
    averageNetLiveCostLamports: string;
    averageFeeLamports: string;
    averageRebateLamports: string;
    validRateFp: string;
  } | null;
  plannerRegimeBuckets?: Array<{
    key: string;
    label: string;
    samples: number;
    autoSamples: number;
    deterministicSamples: number;
    averageCommitLamports: string;
    averageSatRaw: string;
    averageNetLiveCostLamports: string;
    validRateFp: string;
  }>;
  plannerTimeWindowStats?: Array<{
    key: string;
    label: string;
    samples: number;
    autoSamples: number;
    deterministicSamples: number;
    averageCommitLamports: string;
    averageSatRaw: string;
    averageNetLiveCostLamports: string;
    validRateFp: string;
  }>;
  deterministicBaseline?: {
    autoSamples: number;
    deterministicSamples: number;
    autoAverageSatRaw: string | null;
    deterministicAverageSatRaw: string | null;
    deltaAverageSatRaw: string | null;
    autoAverageNetLiveCostLamports: string | null;
    deterministicAverageNetLiveCostLamports: string | null;
    deltaAverageNetLiveCostLamports: string | null;
    autoValidRateFp: string | null;
    deterministicValidRateFp: string | null;
    deltaValidRateFp: string | null;
  } | null;
  plannerPolicySummary?: {
    policyVersion: string | null;
    decisionEngine: string | null;
    explorationPolicy: string | null;
    explorationRatePpm: string | null;
    samples: number;
    averageEstimatedRegret: string | null;
    exploredRateFp: string | null;
    contexts: number;
  } | null;
  plannerPolicyContexts?: Array<{
    contextKey: string;
    regimeKey: string;
    timeWindowKey: string;
    capitalTier: "starter" | "standard" | "deep" | "mixed";
    samples: number;
    bestActionKey: string;
    averageEstimatedRegret: string | null;
    exploredRateFp: string;
    bestActionConfidenceLow: string;
    bestActionConfidenceHigh: string;
  }>;
  plannerCapitalTierStats?: Array<{
    key: "starter" | "standard" | "deep";
    samples: number;
    averageScore: string;
    averageNetLiveCostLamports: string;
    validRateFp: string;
  }>;
  plannerLiveValidation?: Array<{
    key: "1d" | "7d" | "30d";
    label: string;
    sinceAt: string;
    samples: number;
    autoSamples: number;
    deterministicSamples: number;
    deltaAverageScore: string | null;
    deltaAverageNetLiveCostLamports: string | null;
    deltaValidRateFp: string | null;
  }>;
  recentPlannerOutcomes?: Array<{
    cycleId: number;
    committedLamports?: string;
    totalSatEarnedRaw: string;
    totalRebateLamports?: string;
    deterministicRebateLamports?: string;
    performanceRebateLamports?: string;
    claimableDetRebateLamports?: string;
    claimablePerfRebateLamports?: string;
    claimedDetRebateLamports?: string;
    claimedPerfRebateLamports?: string;
    deterministicRebatePoolLamports?: string;
    performanceRebatePoolLamports?: string;
    placementReturnFp?: string;
    benchmarkReturnFp?: string;
    skillScoreFp?: string;
    rewardWeightFp?: string;
    powerWeightFp?: string;
    txFeeLamports?: string;
    netLiveCostLamports: string;
    erosionLamports?: string;
    submitFeeLamports?: string;
    keeperFeeLamports?: string;
    claimFeeLamports?: string;
    otherFeeLamports?: string;
    keeperBountyLamports?: string;
    cycleKeeperBountyPaidLamports?: string;
    validParticipation?: boolean;
    riskMode?: SatRiskMode;
    strategyPreset?: SatMiningStrategyPreset;
    strategyExecution?: SatMiningStrategyExecution;
    strategySource?: "base" | "skill";
    strategyFallbackUsed?: boolean;
    modelId?: string;
    committedMinerCount?: number;
    participantCount?: number;
    pageCount?: number;
    crowdingRatioFp?: string;
    plannerRationale?: string;
    strategyRationale?: string;
    decidedAt?: string;
    recordedAt?: string;
  }>;
  settledHistory?: Array<{
    cycleId: number;
    committedLamports?: string;
    totalSatEarnedRaw: string;
    totalRebateLamports?: string;
    deterministicRebateLamports?: string;
    performanceRebateLamports?: string;
    claimableDetRebateLamports?: string;
    claimablePerfRebateLamports?: string;
    claimedDetRebateLamports?: string;
    claimedPerfRebateLamports?: string;
    deterministicRebatePoolLamports?: string;
    performanceRebatePoolLamports?: string;
    placementReturnFp?: string;
    benchmarkReturnFp?: string;
    skillScoreFp?: string;
    rewardWeightFp?: string;
    powerWeightFp?: string;
    txFeeLamports?: string;
    netLiveCostLamports: string;
    erosionLamports?: string;
    submitFeeLamports?: string;
    keeperFeeLamports?: string;
    claimFeeLamports?: string;
    otherFeeLamports?: string;
    keeperBountyLamports?: string;
    cycleKeeperBountyPaidLamports?: string;
    validParticipation?: boolean;
    riskMode?: SatRiskMode;
    strategyPreset?: SatMiningStrategyPreset;
    strategyExecution?: SatMiningStrategyExecution;
    strategySource?: "base" | "skill";
    strategyFallbackUsed?: boolean;
    modelId?: string;
    committedMinerCount?: number;
    participantCount?: number;
    pageCount?: number;
    crowdingRatioFp?: string;
    plannerRationale?: string;
    strategyRationale?: string;
    decidedAt?: string;
    recordedAt?: string;
  }>;
  updatedAt?: string;
};

export type SatMiningHistoryPoint = NonNullable<SatMiningRuntimeStatus["settledHistory"]>[number];

export type SatMiningHistoryAction = {
  action: string;
  cycleId?: number | null;
  txHash: string | null;
  status: "success" | "failure";
  message?: string | null;
  at: string;
};

export type SatMiningHistory = {
  window: SatMiningHistoryWindow;
  activityWindow: SatMiningHistoryWindow;
  latestCycleId?: number | null;
  totalStoredOutcomeCount: number;
  matchingOutcomeCount: number;
  sampled: boolean;
  windowStartAt: string | null;
  dataStartAt: string | null;
  dataEndAt: string | null;
  outcomes: SatMiningHistoryPoint[];
  activityOutcomes: SatMiningHistoryPoint[];
  totalStoredActionCount: number;
  matchingActionCount: number;
  actionWindowStartAt: string | null;
  actionDataStartAt: string | null;
  actionDataEndAt: string | null;
  actions: SatMiningHistoryAction[];
  updatedAt: string;
};

export type SatMiningRecoverySummary = {
  blocked: boolean;
  epochId?: number;
  microRoundId?: number;
  reason?: string;
  validatorAuthority?: string;
  targetAuthority?: string;
  boardRoot?: string;
  scoreRoot?: string;
  coordinationRoot?: string;
  openDisputeCount?: number;
  validatorRejectCount?: number;
  republishEligible?: boolean;
  selectedCandidate?: {
    epochId: number;
    microRoundId: number;
    targetAuthority?: string;
    blockedReason?: unknown;
  } | null;
  recommendedAction?: "none" | "wait" | "resolve-dispute" | "republish-roots" | "retry-claim";
  detail?: string;
};

export type GetMiningProfileResponse = {
  ok: true;
  profile: SatMinerProfile | null;
};

export type PutMiningProfileRequest = {
  profile: SatMinerProfile;
};

export type PutMiningProfileResponse = {
  ok: true;
  profile: SatMinerProfile;
};

export type GetMiningWalletsResponse = {
  ok: true;
  wallets: SatMiningWalletOption[];
  defaultWalletId?: string;
};

export type GetMiningReadinessResponse = {
  ok: true;
  readiness: SatMiningReadiness;
};

export type GetMiningHistoryResponse = {
  ok: true;
  history: SatMiningHistory | null;
};

export type GetMiningStatusResponse = {
  ok: true;
  status: SatMiningRuntimeStatus;
};

export type GetMiningRecoveryResponse = {
  ok: true;
  recovery: SatMiningRecoverySummary;
};

export type GetMiningMainnetSyncResponse = {
  ok: true;
  sync: SatMainnetSyncStatus | null;
};

export type PostMiningStartRequest = {
  walletId?: string;
};

export type PostMiningStartResponse = {
  ok: true;
  started: boolean;
  status: SatMiningRuntimeStatus;
};

export type PostMiningStopResponse = {
  ok: true;
  stopped: true;
  status: SatMiningRuntimeStatus;
};

export type PostMiningRetryClaimRequest = {
  epochId?: number;
  cycleId?: number;
};

export type PostMiningDirectActionResponse = {
  ok: true;
  result: unknown;
  status: SatMiningRuntimeStatus | null;
};

export type PostMiningCapitalActionRequest = {
  lamports: string;
  persistConfig?: boolean;
};

export type PostMiningCapitalActionResponse = {
  ok: true;
  submitted: unknown;
  status: SatMiningRuntimeStatus;
};

export type PostMiningResolveDisputeRequest = {
  disputeAuthority: string;
  targetAuthority: string;
  epochId: number;
  microRoundId: number;
  statusFlag: number;
};

export type PostMiningRepublishRootsRequest = {
  epochId: number;
  boardRoot: string;
  scoreRoot: string;
  coordinationRoot: string;
};

export type PostMiningClearHistoryResponse = {
  ok: true;
  cleared: true;
  status: SatMiningRuntimeStatus;
};

export type MiningWalletAttachment = {
  walletId: string | null;
  attached: boolean;
};

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options);
  const text = await res.text();
  if (!res.ok) {
    if (text) {
      try {
        const parsed = JSON.parse(text) as {
          error?: { message?: unknown } | null;
          message?: unknown;
        };
        const message =
          typeof parsed?.error?.message === "string"
            ? parsed.error.message
            : typeof parsed?.message === "string"
              ? parsed.message
              : "";
        throw new Error(message || text);
      } catch (error) {
        if (error instanceof Error && error.message && error.message !== text) {
          throw error;
        }
      }
    }
    throw new Error(text || `Request failed (${res.status})`);
  }
  if (!text) {
    return {} as T;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(text);
  }
}

export function strategyPresetToRiskMode(preset: SatMiningStrategyPreset): SatRiskMode {
  switch (preset) {
    case "spread":
    case "crowd_aware":
    case "safe_fallback":
      return "conservative";
    case "conviction":
    case "top_k":
      return "aggressive";
    case "swarm":
      return "swarm";
    case "ranked":
    case "adaptive":
    case "balanced":
    default:
      return "balanced";
  }
}

export function riskModeToStrategyPreset(mode: SatRiskMode): SatMiningStrategyPreset {
  switch (mode) {
    case "conservative":
      return "spread";
    case "aggressive":
      return "conviction";
    case "swarm":
      return "swarm";
    case "balanced":
    default:
      return "balanced";
  }
}

export function strategyExecutionToMode(
  execution: SatMiningStrategyExecution,
): SatMiningStrategyMode {
  return execution === "auto" ? "skill" : "base";
}

export function strategyModeToExecution(
  strategyMode: SatMiningStrategyMode | null | undefined,
): SatMiningStrategyExecution {
  return strategyMode === "skill" ? "auto" : "deterministic";
}

export function createDefaultMinerProfile(walletId = ""): SatMinerProfile {
  const strategyPreset = "balanced" as SatMiningStrategyPreset;
  const strategyExecution = "deterministic" as SatMiningStrategyExecution;
  return {
    walletId,
    role: "miner",
    network: "devnet",
    riskMode: strategyPresetToRiskMode(strategyPreset),
    strategyPreset,
    strategyExecution,
    cycleCadence: 1,
    claimMode: "auto",
    payout: true,
    strategyMode: strategyExecutionToMode(strategyExecution),
    automation: {
      autoFinalizeEpoch: true,
      autoClaim: true,
      satSweep: {
        enabled: false,
        destinationWalletId: undefined,
        destinationAddress: undefined,
        mode: "all",
        percentage: 100,
        minRaw: "1",
        keepRaw: "0",
      },
    },
    funding: {
      commitLamports: "250000000",
      minSolBalanceLamports: "150000000",
    },
    skillConfig: {
      enabled: strategyExecution === "auto",
      useAgentDefaultModel: true,
      fallbackToBaseOnFailure: true,
      maxDecisionLatencyMs: 8000,
    },
  };
}

export async function getMiningProfile(): Promise<GetMiningProfileResponse> {
  return await fetchJson<GetMiningProfileResponse>("/api/mining/profile", {
    method: "GET",
    cache: "no-store",
    credentials: "include",
  });
}

export async function putMiningProfile(
  input: PutMiningProfileRequest,
  approvalToken?: string | null,
): Promise<PutMiningProfileResponse> {
  return await fetchJson<PutMiningProfileResponse>("/api/mining/profile", {
    method: "PUT",
    cache: "no-store",
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...(approvalToken ? { "x-wallet-approval-token": approvalToken } : {}),
    },
    body: JSON.stringify(input),
  });
}

export async function getMiningWallets(): Promise<GetMiningWalletsResponse> {
  return await fetchJson<GetMiningWalletsResponse>("/api/mining/wallets", {
    method: "GET",
    cache: "no-store",
    credentials: "include",
  });
}

export async function getMiningReadiness(walletId?: string): Promise<GetMiningReadinessResponse> {
  const query = walletId ? `?walletId=${encodeURIComponent(walletId)}` : "";
  return await fetchJson<GetMiningReadinessResponse>(`/api/mining/readiness${query}`, {
    method: "GET",
    cache: "no-store",
    credentials: "include",
  });
}

export async function getMiningStatus(opts?: {
  forceFresh?: boolean;
}): Promise<GetMiningStatusResponse> {
  const query = opts?.forceFresh ? "?forceFresh=1" : "";
  return await fetchJson<GetMiningStatusResponse>(`/api/mining/status${query}`, {
    method: "GET",
    cache: "no-store",
    credentials: "include",
  });
}

export async function getMiningHistory(
  window: SatMiningHistoryWindow,
  opts?: { activityWindow?: SatMiningHistoryWindow },
): Promise<GetMiningHistoryResponse> {
  const query = new URLSearchParams({ window });
  if (opts?.activityWindow) {
    query.set("activityWindow", opts.activityWindow);
  }
  return await fetchJson<GetMiningHistoryResponse>(`/api/mining/history?${query.toString()}`, {
    method: "GET",
    cache: "no-store",
    credentials: "include",
  });
}

export async function getMiningRecovery(): Promise<GetMiningRecoveryResponse> {
  return await fetchJson<GetMiningRecoveryResponse>("/api/mining/recovery", {
    method: "GET",
    cache: "no-store",
    credentials: "include",
  });
}

export async function getMiningMainnetSync(): Promise<GetMiningMainnetSyncResponse> {
  return await fetchJson<GetMiningMainnetSyncResponse>("/api/mining/mainnet-sync", {
    method: "GET",
    cache: "no-store",
    credentials: "include",
  });
}

export async function postMiningMainnetSync(): Promise<GetMiningMainnetSyncResponse> {
  return await fetchJson<GetMiningMainnetSyncResponse>("/api/mining/mainnet-sync", {
    method: "POST",
    cache: "no-store",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
}

export async function postMiningStart(
  input: PostMiningStartRequest,
): Promise<PostMiningStartResponse> {
  return await fetchJson<PostMiningStartResponse>("/api/mining/start", {
    method: "POST",
    cache: "no-store",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function postMiningStop(): Promise<PostMiningStopResponse> {
  return await fetchJson<PostMiningStopResponse>("/api/mining/stop", {
    method: "POST",
    cache: "no-store",
    credentials: "include",
  });
}

export async function postMiningInitCapital(
  approvalToken?: string | null,
): Promise<PostMiningCapitalActionResponse> {
  return await fetchJson<PostMiningCapitalActionResponse>("/api/mining/capital/init", {
    method: "POST",
    cache: "no-store",
    credentials: "include",
    headers: approvalToken ? { "x-wallet-approval-token": approvalToken } : undefined,
  });
}

export async function postMiningTopUpReserve(
  approvalToken?: string | null,
): Promise<PostMiningCapitalActionResponse> {
  return await fetchJson<PostMiningCapitalActionResponse>("/api/mining/reserve/top-up", {
    method: "POST",
    cache: "no-store",
    credentials: "include",
    headers: approvalToken ? { "x-wallet-approval-token": approvalToken } : undefined,
  });
}

export async function postMiningDepositCapital(
  input: PostMiningCapitalActionRequest,
  approvalToken?: string | null,
): Promise<PostMiningCapitalActionResponse> {
  return await fetchJson<PostMiningCapitalActionResponse>("/api/mining/capital/deposit", {
    method: "POST",
    cache: "no-store",
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...(approvalToken ? { "x-wallet-approval-token": approvalToken } : {}),
    },
    body: JSON.stringify(input),
  });
}

export async function postMiningWithdrawCapital(
  input: PostMiningCapitalActionRequest,
  approvalToken?: string | null,
): Promise<PostMiningCapitalActionResponse> {
  return await fetchJson<PostMiningCapitalActionResponse>("/api/mining/capital/withdraw", {
    method: "POST",
    cache: "no-store",
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...(approvalToken ? { "x-wallet-approval-token": approvalToken } : {}),
    },
    body: JSON.stringify(input),
  });
}

export async function postMiningSetActiveCommit(
  input: PostMiningCapitalActionRequest,
  approvalToken?: string | null,
): Promise<PostMiningCapitalActionResponse> {
  return await fetchJson<PostMiningCapitalActionResponse>("/api/mining/capital/commit", {
    method: "POST",
    cache: "no-store",
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...(approvalToken ? { "x-wallet-approval-token": approvalToken } : {}),
    },
    body: JSON.stringify(input),
  });
}

export async function postMiningParticipate(): Promise<PostMiningDirectActionResponse> {
  return await fetchJson<PostMiningDirectActionResponse>("/api/mining/action/participate", {
    method: "POST",
    cache: "no-store",
    credentials: "include",
  });
}

export async function postMiningCrank(): Promise<PostMiningDirectActionResponse> {
  return await fetchJson<PostMiningDirectActionResponse>("/api/mining/action/crank", {
    method: "POST",
    cache: "no-store",
    credentials: "include",
  });
}

export async function postMiningFinalizeEpoch(): Promise<PostMiningDirectActionResponse> {
  return await fetchJson<PostMiningDirectActionResponse>("/api/mining/action/finalize-epoch", {
    method: "POST",
    cache: "no-store",
    credentials: "include",
  });
}

export async function postMiningClaimDirect(): Promise<PostMiningDirectActionResponse> {
  return await fetchJson<PostMiningDirectActionResponse>("/api/mining/action/claim", {
    method: "POST",
    cache: "no-store",
    credentials: "include",
  });
}

export async function getMiningWalletAttachment(): Promise<{
  ok: true;
  attachment: MiningWalletAttachment | null;
}> {
  return await fetchJson<{ ok: true; attachment: MiningWalletAttachment | null }>(
    "/api/mining/wallet-attachment",
    {
      method: "GET",
      cache: "no-store",
      credentials: "include",
    },
  );
}

export async function postMiningRetryClaim(
  input: PostMiningRetryClaimRequest,
): Promise<PostMiningDirectActionResponse> {
  return await fetchJson<PostMiningDirectActionResponse>("/api/mining/recovery/claim", {
    method: "POST",
    cache: "no-store",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function postMiningResolveDispute(
  input: PostMiningResolveDisputeRequest,
): Promise<{ ok: true; result: unknown }> {
  return await fetchJson<{ ok: true; result: unknown }>("/api/mining/recovery/resolve-dispute", {
    method: "POST",
    cache: "no-store",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function postMiningRepublishRoots(
  input: PostMiningRepublishRootsRequest,
): Promise<{ ok: true; result: unknown }> {
  return await fetchJson<{ ok: true; result: unknown }>("/api/mining/recovery/republish-roots", {
    method: "POST",
    cache: "no-store",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function postMiningClearHistory(): Promise<PostMiningClearHistoryResponse> {
  return await fetchJson<PostMiningClearHistoryResponse>("/api/mining/history/clear", {
    method: "POST",
    cache: "no-store",
    credentials: "include",
  });
}
