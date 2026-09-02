import { createHash } from "node:crypto";
import { z } from "zod";
import { CapitalPolicySchema, type CapitalPolicy } from "./agent-profile-contracts.js";
import {
  verifySignedFirstPartyCapabilityManifest,
  type SignedFirstPartyCapabilityManifest,
} from "./capability-manifest.js";
import { stableStringify } from "./stable-stringify.js";

const Identifier = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u)
  .max(96);
const AtomicAmount = z.string().regex(/^\d+$/u).max(80);
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const CanonicalTimestamp = z.string().refine((value) => {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}, "must be a canonical ISO timestamp");

export const FirstPartyAdapterSignerRequestSchema = z
  .object({
    schema: z.literal("fased.first-party-adapter-signer-request.v1"),
    requestId: Identifier,
    capabilityId: Identifier,
    adapterId: Identifier,
    operation: Identifier,
    installedArtifactSha256: Sha256,
    chain: z.string().trim().min(1).max(64),
    walletId: z.string().trim().min(1).max(128),
    walletRole: z.string().trim().min(1).max(64),
    programId: z.string().trim().min(1).max(128),
    assetId: z.string().trim().min(1).max(128),
    destination: z.string().trim().min(1).max(256),
    amountAtoms: AtomicAmount,
    slippageBps: z.number().int().min(0).max(10_000),
    ownerApproved: z.boolean(),
    policyGeneration: z.number().int().positive().max(1_000_000),
    policyDigest: Sha256,
    signerPolicyVersion: z.number().int().positive().max(1_000_000),
    signerPolicyHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    requestedAt: CanonicalTimestamp,
    expiresAt: CanonicalTimestamp,
  })
  .strict();

export type FirstPartyAdapterSignerRequest = z.infer<typeof FirstPartyAdapterSignerRequestSchema>;

export type VerifiedFirstPartyAdapterSignerRequest = {
  manifest: SignedFirstPartyCapabilityManifest["manifest"];
  request: FirstPartyAdapterSignerRequest;
  manifestDigest: string;
};

function requireIncludes(values: readonly string[], expected: string, error: string): void {
  if (!values.includes(expected)) {
    throw new Error(error);
  }
}

export function authorizeFirstPartyAdapterSignerRequest(params: {
  envelope: unknown;
  trustedSignerKeys: Readonly<Record<string, string>>;
  request: unknown;
  capitalPolicy: CapitalPolicy;
  capitalPolicyRef: { generation: number; digest: string };
  usage: {
    dailySpentAtoms: string;
    rollingSpentAtoms: string;
    cadenceToday: number;
    currentDrawdownBps: number;
  };
  now?: Date;
}): VerifiedFirstPartyAdapterSignerRequest {
  const now = params.now ?? new Date();
  const envelope = verifySignedFirstPartyCapabilityManifest({
    envelope: params.envelope,
    trustedSignerKeys: params.trustedSignerKeys,
    now,
  });
  const request = FirstPartyAdapterSignerRequestSchema.parse(params.request);
  const policy = CapitalPolicySchema.parse(params.capitalPolicy);
  const manifest = envelope.manifest;

  if (
    request.policyGeneration !== params.capitalPolicyRef.generation ||
    request.policyDigest !== params.capitalPolicyRef.digest
  ) {
    throw new Error("adapter signer request does not match the active CapitalPolicy generation");
  }
  if (
    Date.parse(request.requestedAt) > now.getTime() ||
    Date.parse(request.expiresAt) <= now.getTime() ||
    Date.parse(request.expiresAt) - Date.parse(request.requestedAt) > 5 * 60_000
  ) {
    throw new Error("adapter signer request is outside its bounded execution window");
  }

  if (manifest.capabilityId !== request.capabilityId || manifest.adapterId !== request.adapterId) {
    throw new Error("adapter signer request does not match the verified capability manifest");
  }
  requireIncludes(
    manifest.adapterOperations,
    request.operation,
    "adapter signer operation is not declared by the verified capability manifest",
  );
  if (manifest.artifactSha256 !== request.installedArtifactSha256) {
    throw new Error("adapter artifact does not match the verified capability manifest");
  }
  requireIncludes(
    manifest.permissions.walletRoles,
    request.walletRole,
    "adapter wallet role is not declared by the verified capability manifest",
  );
  requireIncludes(
    manifest.permissions.programIds,
    request.programId,
    "adapter program is not declared by the verified capability manifest",
  );
  requireIncludes(
    manifest.permissions.assetIds,
    request.assetId,
    "adapter asset is not declared by the verified capability manifest",
  );

  if (policy.mode !== "allowlisted") {
    throw new Error("capital policy denies all adapter signer requests");
  }
  if (policy.expiresAt && Date.parse(policy.expiresAt) <= now.getTime()) {
    throw new Error("capital policy is expired");
  }
  requireIncludes(policy.allowedChains, request.chain, "capital policy denies adapter chain");
  requireIncludes(
    policy.allowedWalletIds,
    request.walletId,
    "capital policy denies adapter wallet",
  );
  requireIncludes(
    policy.allowedPrograms,
    request.programId,
    "capital policy denies adapter program",
  );
  requireIncludes(policy.allowedAssets, request.assetId, "capital policy denies adapter asset");
  requireIncludes(
    policy.allowedDestinations,
    request.destination,
    "capital policy denies adapter destination",
  );
  if (BigInt(request.amountAtoms) > BigInt(policy.perActionLimitAtoms)) {
    throw new Error("capital policy per-action limit exceeded");
  }
  if (
    BigInt(params.usage.dailySpentAtoms) + BigInt(request.amountAtoms) >
    BigInt(policy.dailyLimitAtoms)
  ) {
    throw new Error("capital policy daily limit exceeded");
  }
  if (
    BigInt(params.usage.rollingSpentAtoms) + BigInt(request.amountAtoms) >
    BigInt(policy.rollingLimitAtoms)
  ) {
    throw new Error("capital policy rolling limit exceeded");
  }
  if (params.usage.cadenceToday + 1 > policy.maxCadencePerDay) {
    throw new Error("capital policy cadence limit exceeded");
  }
  if (params.usage.currentDrawdownBps > policy.maxDrawdownBps) {
    throw new Error("capital policy drawdown limit exceeded");
  }
  if (request.slippageBps > policy.maxSlippageBps) {
    throw new Error("capital policy slippage limit exceeded");
  }
  if (policy.ownerApprovalRequired && !request.ownerApproved) {
    throw new Error("capital policy requires owner approval");
  }

  return {
    manifest,
    request,
    manifestDigest: createHash("sha256").update(stableStringify(manifest)).digest("hex"),
  };
}
