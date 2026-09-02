import {
  admitAgentFinancialAction,
  type ReconciledRiskSnapshot,
} from "../../../src/agents/agent-financial-admission.js";
import type { MiningReadyAgentProjection } from "../../../src/agents/agent-mining-ready-projection.js";
import { appendFinancialEvent } from "../../../src/agents/agent-truth-store.js";
import type { FirstPartyAdapterSignerRequest } from "../../../src/agents/capability-adapter-authorization.js";
import type { SignedFirstPartyCapabilityManifest } from "../../../src/agents/capability-manifest.js";
import type { LocalSocketSignerPolicyV2 } from "../../../src/wallet/local-socket-signer-protocol.js";
import { runWithSatSubmissionWorkflow } from "./submission-service.js";

export const GUARDED_MINING_OPERATIONS = [
  "cycle.commit",
  "cycle.reveal",
  "cycle.recover",
  "cycle.claim",
  "capital.drain",
] as const;

export type GuardedMiningOperation = (typeof GUARDED_MINING_OPERATIONS)[number];

export type GuardedMiningExecutionResult = {
  requestId: string;
  state: "confirmed" | "failed" | "unknown";
  signature?: string;
  canonicalRef?: string;
  detail?: string;
};

const CONTINUATION_OPERATIONS = new Set<GuardedMiningOperation>([
  "cycle.reveal",
  "cycle.recover",
  "cycle.claim",
  "capital.drain",
]);

function assertLifecycleAuthority(params: {
  projection: MiningReadyAgentProjection;
  operation: GuardedMiningOperation;
}): void {
  const { projection, operation } = params;
  if (projection.mode !== "guarded-auto") {
    throw new Error("guarded mining execution requires guarded-auto mode");
  }
  if (projection.authority.capitalPolicyMode !== "allowlisted") {
    throw new Error("guarded mining execution requires an allowlisted CapitalPolicy");
  }
  if (projection.mining.integrity === "conflict") {
    throw new Error("guarded mining execution refuses conflicting Agent and Mining identity");
  }

  if (operation === "cycle.commit") {
    if (
      projection.qualification.status !== "pass" ||
      projection.mining.entryState !== "enabled" ||
      projection.mining.lifecycle !== "active"
    ) {
      throw new Error("new mining entry is unavailable until Mining qualification passes");
    }
    if (projection.privateMining.operatingReserveState !== "healthy") {
      throw new Error("new mining entry requires a healthy Operating Reserve");
    }
    if (projection.privateMining.lifecycleState !== "idle") {
      throw new Error("new mining entry requires an idle private lifecycle");
    }
    return;
  }

  if (!CONTINUATION_OPERATIONS.has(operation)) {
    throw new Error(`unsupported guarded mining operation ${operation}`);
  }
}

function settledKind(operation: GuardedMiningOperation) {
  if (operation === "cycle.claim") return "claim" as const;
  if (operation === "capital.drain") return "withdrawal" as const;
  if (operation === "cycle.commit") return "position" as const;
  return "reconciliation" as const;
}

function canonicalExecutionRef(result: GuardedMiningExecutionResult): string {
  const value = result.canonicalRef?.trim() || result.signature?.trim();
  if (!value || !/^[a-zA-Z0-9._:@/-]{1,160}$/u.test(value)) {
    throw new Error("confirmed guarded mining execution requires a canonical reference");
  }
  return value;
}

export async function executeGuardedMiningLifecycle(params: {
  agentId: string;
  projection: MiningReadyAgentProjection;
  operation: GuardedMiningOperation;
  envelope: SignedFirstPartyCapabilityManifest;
  trustedSignerKeys: Readonly<Record<string, string>>;
  request: FirstPartyAdapterSignerRequest;
  signerPolicyReader: {
    getSignerPolicy(walletId: string): Promise<LocalSocketSignerPolicyV2>;
  };
  riskSnapshot: ReconciledRiskSnapshot;
  execute: (input: {
    workflowId: string;
    requestId: string;
    operation: GuardedMiningOperation;
  }) => Promise<GuardedMiningExecutionResult>;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}): Promise<GuardedMiningExecutionResult> {
  if (params.projection.agentId !== params.agentId) {
    throw new Error("guarded mining projection belongs to another Agent");
  }
  if (params.request.operation !== params.operation) {
    throw new Error("guarded mining operation does not match the signer request");
  }
  if (
    params.projection.capability.capabilityId !== params.request.capabilityId ||
    params.projection.capability.adapterId !== params.request.adapterId
  ) {
    throw new Error("guarded mining request does not match the projected capability");
  }
  assertLifecycleAuthority({ projection: params.projection, operation: params.operation });

  const admission = await admitAgentFinancialAction({
    agentId: params.agentId,
    envelope: params.envelope,
    trustedSignerKeys: params.trustedSignerKeys,
    request: params.request,
    signerPolicyReader: params.signerPolicyReader,
    riskSnapshot: params.riskSnapshot,
    env: params.env,
    now: params.now,
  });
  const workflowId = `agent:${params.agentId}:${params.request.requestId}`;
  const result = await runWithSatSubmissionWorkflow(workflowId, () =>
    params.execute({
      workflowId,
      requestId: params.request.requestId,
      operation: params.operation,
    }),
  );
  if (result.requestId !== params.request.requestId) {
    throw new Error("guarded mining executor returned another durable request id");
  }
  if (result.state !== "confirmed") {
    return result;
  }

  const canonicalRef = canonicalExecutionRef(result);
  await appendFinancialEvent({
    agentId: params.agentId,
    eventId: `settlement-${params.request.requestId}`,
    kind: settledKind(params.operation),
    writer: "canonical-indexer",
    status: "settled",
    asset: params.request.assetId,
    quantityMinor: params.request.amountAtoms,
    intentDigest: admission.intentDigest,
    canonicalRef,
    requestId: params.request.requestId,
    walletId: params.request.walletId,
    operation: params.operation,
    destination: params.request.destination,
    policyGeneration: params.request.policyGeneration,
    policyDigest: params.request.policyDigest,
    signerPolicyRevision: params.request.signerPolicyVersion,
    signerPolicyHash: params.request.signerPolicyHash,
    env: params.env,
    now: params.now,
  });
  return { ...result, canonicalRef };
}
