import type { SatMiningConfig } from "./config.js";

export const SAT_GATEWAY_METHODS = {
  initMinerCapital: "sat.initMinerCapital",
  depositMinerCapital: "sat.depositMinerCapital",
  withdrawMinerCapital: "sat.withdrawMinerCapital",
  setActiveCommit: "sat.setActiveCommit",
  openCycle: "sat.openCycle",
  submitCycle: "sat.submitCycle",
  settleCyclePage: "sat.settleCyclePage",
  finalizeCycleSettlement: "sat.finalizeCycleSettlement",
  scoreCyclePage: "sat.scoreCyclePage",
  distributeCyclePage: "sat.distributeCyclePage",
  claimCycleRewards: "sat.claimCycleRewards",
  claimCycleRewardsBatch: "sat.claimCycleRewardsBatch",
  retargetUnlock: "sat.retargetUnlock",
  refillRegistryReserveFromTreasury: "sat.refillRegistryReserveFromTreasury",
  runProtocolMaintenanceOnce: "sat.runProtocolMaintenanceOnce",
  resolveDispute: "sat.resolveDispute",
  republishEpochRoots: "sat.republishEpochRoots",
  getEpoch: "sat.getEpoch",
  getRecoverySummary: "sat.getRecoverySummary",
  getValidatorAttestation: "sat.getValidatorAttestation",
  getDispute: "sat.getDispute",
  listValidatorAttestations: "sat.listValidatorAttestations",
  listDisputes: "sat.listDisputes",
  submitValidatorAttestation: "sat.submitValidatorAttestation",
  openDispute: "sat.openDispute",
} as const;

export class SatMiningClient {
  constructor(private readonly config: SatMiningConfig) {}

  getStatus() {
    return {
      method: "sat.status",
      network: this.config.network,
      walletId: this.config.walletId ?? null,
      riskMode: this.config.riskMode,
    };
  }

  buildOpenCycleRequest(params: { cycleId: number }) {
    return {
      method: SAT_GATEWAY_METHODS.openCycle,
      params,
    };
  }

  buildInitMinerCapitalRequest(params: { authority: string }) {
    return {
      method: SAT_GATEWAY_METHODS.initMinerCapital,
      params,
    };
  }

  buildDepositMinerCapitalRequest(params: { lamports: number }) {
    return {
      method: SAT_GATEWAY_METHODS.depositMinerCapital,
      params,
    };
  }

  buildWithdrawMinerCapitalRequest(params: { lamports: number }) {
    return {
      method: SAT_GATEWAY_METHODS.withdrawMinerCapital,
      params,
    };
  }

  buildSetActiveCommitRequest(params: { lamports: number }) {
    return {
      method: SAT_GATEWAY_METHODS.setActiveCommit,
      params,
    };
  }

  buildSubmitCycleRequest(params: { cycleId: number; allocationFp: number[] }) {
    return {
      method: SAT_GATEWAY_METHODS.submitCycle,
      params,
    };
  }

  buildClaimCycleRewardsRequest(params: { cycleId: number }) {
    return {
      method: SAT_GATEWAY_METHODS.claimCycleRewards,
      params,
    };
  }

  buildClaimCycleRewardsBatchRequest(params: { cycleIds: number[] }) {
    return {
      method: SAT_GATEWAY_METHODS.claimCycleRewardsBatch,
      params,
    };
  }

  buildSettleCyclePageRequest(params: { cycleId: number; pageIndex: number; chunkIndex: number }) {
    return {
      method: SAT_GATEWAY_METHODS.settleCyclePage,
      params,
    };
  }

  buildFinalizeCycleSettlementRequest(params: { cycleId: number }) {
    return {
      method: SAT_GATEWAY_METHODS.finalizeCycleSettlement,
      params,
    };
  }

  buildScoreCyclePageRequest(params: { cycleId: number; pageIndex: number; chunkIndex: number }) {
    return {
      method: SAT_GATEWAY_METHODS.scoreCyclePage,
      params,
    };
  }

  buildDistributeCyclePageRequest(params: {
    cycleId: number;
    pageIndex: number;
    chunkIndex: number;
  }) {
    return {
      method: SAT_GATEWAY_METHODS.distributeCyclePage,
      params,
    };
  }

  buildRetargetUnlockRequest(params: { cycleId: number }) {
    return {
      method: SAT_GATEWAY_METHODS.retargetUnlock,
      params,
    };
  }

  buildGetEpochRequest(params: { epochId: number }) {
    return {
      method: SAT_GATEWAY_METHODS.getEpoch,
      params,
    };
  }

  buildGetRecoverySummaryRequest(params: {
    epochId: number;
    microRoundId: number;
    validatorAuthority: string;
  }) {
    return {
      method: SAT_GATEWAY_METHODS.getRecoverySummary,
      params,
    };
  }

  buildResolveDisputeRequest(params: {
    disputeAuthority: string;
    targetAuthority: string;
    epochId: number;
    microRoundId: number;
    statusFlag: number;
  }) {
    return {
      method: SAT_GATEWAY_METHODS.resolveDispute,
      params,
    };
  }

  buildRepublishEpochRootsRequest(params: {
    epochId: number;
    bucketRoot: string;
    scoreRoot: string;
    coordinationRoot: string;
  }) {
    return {
      method: SAT_GATEWAY_METHODS.republishEpochRoots,
      params,
    };
  }

  buildGetValidatorAttestationRequest(params: {
    validatorAuthority: string;
    targetAuthority: string;
    epochId: number;
    microRoundId: number;
  }) {
    return {
      method: SAT_GATEWAY_METHODS.getValidatorAttestation,
      params,
    };
  }

  buildGetDisputeRequest(params: {
    validatorAuthority: string;
    targetAuthority: string;
    epochId: number;
    microRoundId: number;
  }) {
    return {
      method: SAT_GATEWAY_METHODS.getDispute,
      params,
    };
  }

  buildListValidatorAttestationsRequest(params: {
    validatorAuthority: string;
    epochId: number;
    microRoundId: number;
    reasonCode?: number;
    decisionFlag?: number;
    requireNonzeroSlashPenalty?: boolean;
    sortBy?: string;
    sortOrder?: "asc" | "desc";
  }) {
    return {
      method: SAT_GATEWAY_METHODS.listValidatorAttestations,
      params,
    };
  }

  buildListDisputesRequest(params: {
    validatorAuthority: string;
    epochId: number;
    microRoundId: number;
    reasonCode?: number;
    requireNonzeroSlashPenalty?: boolean;
    sortBy?: string;
    sortOrder?: "asc" | "desc";
  }) {
    return {
      method: SAT_GATEWAY_METHODS.listDisputes,
      params,
    };
  }

  buildSubmitValidatorAttestationRequest(params: {
    targetAuthority?: string;
    epochId: number;
    microRoundId: number;
    decisionFlag: number;
    reasonCode: number;
    bucketRoot: string;
    scoreRoot: string;
    coordinationRoot: string;
    evidenceHash: string;
  }) {
    return {
      method: SAT_GATEWAY_METHODS.submitValidatorAttestation,
      params,
    };
  }

  buildOpenDisputeRequest(params: {
    targetAuthority?: string;
    epochId: number;
    microRoundId: number;
    reasonCode: number;
    evidenceHash: string;
    targetRoot: string;
  }) {
    return {
      method: SAT_GATEWAY_METHODS.openDispute,
      params,
    };
  }
}
