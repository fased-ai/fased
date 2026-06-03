import fs from "node:fs/promises";
import {
  deriveSatAllocationHash,
  deriveSatCommitHash,
  deriveSatCoordinationHash,
  deriveSatDifficultyHash,
  deriveSatTraceRoot,
} from "./hash-spec.js";
import type { SatValidatorArtifact } from "./validator-artifacts.js";

export type SatReplayResult = {
  roundKey: string;
  metadata: {
    targetAuthority: string | null;
  };
  checks: {
    allocationHashMatches: boolean;
    difficultyHashMatches: boolean;
    coordinationHashMatches: boolean;
    traceRootMatches: boolean;
    commitHashMatches: boolean;
  };
  recomputed: {
    allocationHash: string;
    difficultyHash: string;
    coordinationHash: string;
    traceRoot: string;
    commitHash: string;
  };
};

export async function readSatValidatorArtifact(filePath: string): Promise<SatValidatorArtifact> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as SatValidatorArtifact;
}

export function recomputeSatValidatorArtifact(artifact: SatValidatorArtifact): SatReplayResult {
  const plan = artifact.payload.audit.plan;
  const context = artifact.payload.audit.context;
  if (!plan || !context) {
    throw new Error("validator artifact is missing plan or context needed for replay");
  }
  const allocationHash = deriveSatAllocationHash({
    epochId: context.epochId,
    microRoundId: context.microRoundId,
    bucketHash: context.bucketHash,
    allocationSum: plan.allocationSum,
    allocationFp: plan.allocationFp,
  });
  const difficultyHash = deriveSatDifficultyHash({
    epochId: context.epochId,
    microRoundId: context.microRoundId,
    allocationSum: plan.allocationSum,
    allocationFp: plan.allocationFp,
  });
  const coordinationHash = deriveSatCoordinationHash({
    epochId: context.epochId,
    microRoundId: context.microRoundId,
    coordinationGroupHash: plan.coordinationGroupHash,
    coordinationMessageRoot: plan.coordinationMessageRoot,
    coordinationPeerCount: plan.coordinationPeerCount,
    coordinationIntent: plan.coordinationIntent,
  });
  const traceRoot = deriveSatTraceRoot({
    epochId: context.epochId,
    microRoundId: context.microRoundId,
    allocationHash,
    difficultyHash,
    coordinationHash,
  });
  const commitHash = deriveSatCommitHash({
    epochId: context.epochId,
    microRoundId: context.microRoundId,
    bucketHash: context.bucketHash,
    allocationHash,
    difficultyHash,
    coordinationHash,
    traceRoot,
  });

  return {
    roundKey: artifact.roundKey,
    metadata: {
      targetAuthority: artifact.payload.metadata.targetAuthority,
    },
    checks: {
      allocationHashMatches: allocationHash === plan.allocationHash,
      difficultyHashMatches: difficultyHash === plan.difficultyHash,
      coordinationHashMatches: coordinationHash === plan.coordinationHash,
      traceRootMatches: traceRoot === plan.traceRoot,
      commitHashMatches: commitHash === plan.commitHash,
    },
    recomputed: {
      allocationHash,
      difficultyHash,
      coordinationHash,
      traceRoot,
      commitHash,
    },
  };
}
