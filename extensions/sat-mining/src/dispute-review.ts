import type { SatAuditArtifact } from "./audit-store.js";

export type SatDisputeReview = {
  recordLocator: {
    roundKey: string;
    epochId: number | null;
    microRoundId: number | null;
    validatorAuthority: string | null;
    targetAuthority: string | null;
  };
  reasons: string[];
  evidenceBundle: {
    roundKey: string;
    targetAuthority: string | null;
    bucketHash: string | null;
    coordinationHash: string | null;
    coordinationGroupHash: string | null;
    coordinationMessageRoot: string | null;
    coordinationPeerCount: number | null;
    coordinationIntent: number | null;
  };
};

export function buildSatDisputeReview(
  audit: SatAuditArtifact,
  options?: { targetAuthority?: string; validatorAuthority?: string },
): SatDisputeReview {
  const reasons: string[] = [];
  if (audit.execution && !audit.execution.participationSubmitted) {
    reasons.push("R009_LATE_REVEAL");
  }
  if (audit.coordinationEvidence) {
    if (
      !audit.coordinationEvidence.coordinationHash ||
      /^0+$/.test(audit.coordinationEvidence.coordinationHash)
    ) {
      reasons.push("R010_INVALID_DISPUTE_EVIDENCE");
    }
    if (
      audit.coordinationEvidence.coordinationIntent > 0 &&
      audit.coordinationEvidence.coordinationPeerCount <= 0
    ) {
      reasons.push("R010_INVALID_DISPUTE_EVIDENCE");
    }
  }
  if (reasons.length === 0) {
    reasons.push("R003_MALICIOUS_ATTESTATION");
  }

  return {
    recordLocator: {
      roundKey: audit.roundKey,
      epochId: audit.context?.epochId ?? null,
      microRoundId: audit.context?.microRoundId ?? null,
      validatorAuthority: options?.validatorAuthority?.trim() || null,
      targetAuthority: options?.targetAuthority?.trim() || null,
    },
    reasons,
    evidenceBundle: {
      roundKey: audit.roundKey,
      targetAuthority: options?.targetAuthority?.trim() || null,
      bucketHash: audit.context?.bucketHash ?? null,
      coordinationHash: audit.coordinationEvidence?.coordinationHash ?? null,
      coordinationGroupHash: audit.coordinationEvidence?.coordinationGroupHash ?? null,
      coordinationMessageRoot: audit.coordinationEvidence?.coordinationMessageRoot ?? null,
      coordinationPeerCount: audit.coordinationEvidence?.coordinationPeerCount ?? null,
      coordinationIntent: audit.coordinationEvidence?.coordinationIntent ?? null,
    },
  };
}
