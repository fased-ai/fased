import type {
  CronJob,
  CronRunStatus,
  CronTaskCoordinationEvidence,
  CronTaskSourceAuthority,
  CronTaskSourceQualityBand,
  CronTaskSourceRole,
  CronTaskSourceVerificationStatus,
  CronTaskWorkflowGraphNodeKind,
} from "./types.js";

export type CronTaskGraphContextItem = {
  nodeId: string;
  nodeKind?: CronTaskWorkflowGraphNodeKind;
  label?: string;
  optional?: boolean;
  sourceRole?: CronTaskSourceRole;
  sourcePriority?: number;
  sourceFreshness?: "static" | "runtime" | "live";
  sourceExpectedOutputType?: string;
  trustedSourceId?: string;
  toolName?: string;
  status?: CronRunStatus;
  summary?: string;
  outputText?: string;
  error?: string;
  sourceQualityScore?: number;
  sourceQualityBand?: CronTaskSourceQualityBand;
  sourceAuthority?: CronTaskSourceAuthority;
  sourceQualityRationale?: string[];
  verificationStatus?: CronTaskSourceVerificationStatus;
  sourceConflictCount?: number;
  needsReview?: boolean;
  evaluatorSignal?: string;
  coordinationEvidence?: CronTaskCoordinationEvidence[];
};

export type CronGraphNodeHandlerResult = {
  status: CronRunStatus;
  summary?: string;
  outputText?: string;
  error?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  rawResult?: unknown;
  coordinationEvidence?: CronTaskCoordinationEvidence[];
};

export type CronGraphNodeHandlerParams = {
  job: CronJob;
  message: string;
  runId: string;
  nodeId: string;
  nodeKind: CronTaskWorkflowGraphNodeKind;
  graphContext: CronTaskGraphContextItem[];
  abortSignal?: AbortSignal;
};
