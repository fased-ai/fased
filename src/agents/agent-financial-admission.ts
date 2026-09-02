import { createHash } from "node:crypto";
import { z } from "zod";
import type { LocalSocketSignerPolicyV2 } from "../wallet/local-socket-signer-protocol.js";
import { readActiveAgentProfile, readAgentProfileState } from "./agent-profile-store.js";
import { admitAndAppendFinancialAction, type AgentFinancialUsage } from "./agent-truth-store.js";
import {
  authorizeFirstPartyAdapterSignerRequest,
  FirstPartyAdapterSignerRequestSchema,
} from "./capability-adapter-authorization.js";
import type { SignedFirstPartyCapabilityManifest } from "./capability-manifest.js";
import { stableStringify } from "./stable-stringify.js";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const CanonicalTimestamp = z.string().refine((value) => {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}, "must be a canonical ISO timestamp");

export const ReconciledRiskSnapshotSchema = z
  .object({
    schema: z.literal("fased.reconciled-risk-snapshot.v1"),
    financialRoot: Digest.nullable(),
    currentDrawdownBps: z.number().int().min(0).max(10_000),
    observedAt: CanonicalTimestamp,
    expiresAt: CanonicalTimestamp,
  })
  .strict();

export type ReconciledRiskSnapshot = z.infer<typeof ReconciledRiskSnapshotSchema>;

function digestValue(domain: string, value: unknown): string {
  return createHash("sha256")
    .update(domain)
    .update("\0")
    .update(stableStringify(value))
    .digest("hex");
}

function assertSignerPolicyMatches(params: {
  signer: LocalSocketSignerPolicyV2;
  request: z.infer<typeof FirstPartyAdapterSignerRequestSchema>;
  usage: AgentFinancialUsage;
}): void {
  if (
    params.signer.walletId !== params.request.walletId ||
    params.signer.role !== params.request.walletRole ||
    params.signer.version !== params.request.signerPolicyVersion ||
    params.signer.hash !== params.request.signerPolicyHash ||
    !params.signer.operations.includes(params.request.operation) ||
    !params.signer.programs.includes(params.request.programId)
  ) {
    throw new Error("native signer policy does not match the adapter request");
  }
  const asset = params.signer.assets.find(
    (candidate) => candidate.asset === params.request.assetId,
  );
  if (!asset || !asset.destinations.includes(params.request.destination)) {
    throw new Error("native signer policy denies the adapter asset or destination");
  }
  if (BigInt(params.request.amountAtoms) > BigInt(asset.maxPerTx)) {
    throw new Error("native signer policy per-transaction limit exceeded");
  }
  if (
    BigInt(params.usage.dailySpentAtoms) + BigInt(params.request.amountAtoms) >
    BigInt(asset.maxDaily)
  ) {
    throw new Error("native signer policy daily limit exceeded");
  }
}

export async function admitAgentFinancialAction(params: {
  agentId: string;
  envelope: SignedFirstPartyCapabilityManifest;
  trustedSignerKeys: Readonly<Record<string, string>>;
  request: unknown;
  signerPolicyReader: {
    getSignerPolicy(walletId: string): Promise<LocalSocketSignerPolicyV2>;
  };
  riskSnapshot: unknown;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const profileState = readAgentProfileState({ agentId: params.agentId, env: params.env });
  if (!profileState) {
    throw new Error("Agent profiles are unavailable; refusing financial admission");
  }
  const capitalPolicy = readActiveAgentProfile(profileState, "capitalPolicy");
  const capitalPolicyRef = profileState.active.capitalPolicy;
  const request = FirstPartyAdapterSignerRequestSchema.parse(params.request);
  const signer = await params.signerPolicyReader.getSignerPolicy(request.walletId);
  const risk = ReconciledRiskSnapshotSchema.parse(params.riskSnapshot);
  if (Date.parse(risk.observedAt) > now.getTime() || Date.parse(risk.expiresAt) <= now.getTime()) {
    throw new Error("reconciled risk snapshot is stale or invalid");
  }
  const intentDigest = digestValue("fased.agent-financial-admission.v1", {
    request,
    signerPolicyHash: signer.hash,
    riskSnapshot: risk,
  });
  const event = {
    eventId: `admission-${request.requestId}`,
    kind: "order" as const,
    writer: "typed-first-party-adapter" as const,
    status: "pending" as const,
    asset: request.assetId,
    quantityMinor: request.amountAtoms,
    intentDigest,
    requestId: request.requestId,
    walletId: request.walletId,
    operation: request.operation,
    destination: request.destination,
    policyGeneration: request.policyGeneration,
    policyDigest: request.policyDigest,
    signerPolicyRevision: signer.version,
    signerPolicyHash: signer.hash,
  };
  return await admitAndAppendFinancialAction({
    agentId: params.agentId,
    event,
    currentDrawdownBps: risk.currentDrawdownBps,
    env: params.env,
    now,
    admit: (usage: AgentFinancialUsage) => {
      if (usage.financialRoot !== risk.financialRoot) {
        throw new Error("reconciled risk snapshot does not match the objective ledger root");
      }
      assertSignerPolicyMatches({ signer, request, usage });
      authorizeFirstPartyAdapterSignerRequest({
        envelope: params.envelope,
        trustedSignerKeys: params.trustedSignerKeys,
        request,
        capitalPolicy,
        capitalPolicyRef,
        usage,
        now,
      });
    },
  });
}
