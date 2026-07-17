import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { FasedAgentConfig } from "../config/config.js";
import { resolveFederationBondWalletId } from "../federation/runtime.js";
import type { LocalSocketSignerPolicyV2 } from "./local-socket-signer-protocol.js";
import {
  assertSecureLocalSignerSocket,
  callLocalSocketSigner,
  requireLocalSocketSignerPath,
} from "./providers/local-socket-signer-adapter.js";
import type {
  WalletProviderJupiterExecutionV2,
  WalletProviderJupiterReviewV2,
  WalletProviderSignerReviewAuthorizationV2,
} from "./wallet-provider-adapter.js";
import { readWalletProviderRegistry } from "./wallet-provider-registry.js";
import { createSignerReviewApprovalRequest } from "./wallet-send-approvals.js";

const FEDERATION_BOND_INTENT = "federation.bondChallenge" as const;
export const FEDERATION_BOND_POLICY_DOMAIN = "domain:fased:federation-bond-challenge-v1";
const REQUIRED_FEDERATION_SIGNER_FEATURES = [
  "failClosedPolicies",
  "policyHashes",
  "durableCaps",
  "atomicIdempotency",
  "signerOwnedKeys",
  "domainSeparatedFederationBondChallenges",
  "signerOwnedWebAuthn",
  "singleUseReviewedAuthorization",
  "signerOwnedReviewPrepareExecute",
  "exactPreparedTransactions",
  "reviewedFederationBondChallenges",
  "durableReviewAuthorization",
] as const;

export class FederationBondReviewAuthorizationRequiredError extends Error {
  readonly review: WalletProviderJupiterReviewV2;
  readonly approvalId: string;

  constructor(review: WalletProviderJupiterReviewV2, approvalId: string) {
    super(
      `federation signer review ${review.requestId} is pending in Wallet Approvals and requires signer-owned WebAuthn authorization`,
    );
    this.name = "FederationBondReviewAuthorizationRequiredError";
    this.review = review;
    this.approvalId = approvalId;
  }
}

export type ResolvedBondWallet = {
  walletId: string;
  walletAddress: string;
  providerId?: string;
  socketPath: string;
};

function nativeSignerWalletId(walletId: string): string {
  const normalized = walletId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "default";
}

function federationOrigin(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("federation bond signing requires a valid HTTPS federation origin");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== "/" && parsed.pathname !== "")
  ) {
    throw new Error(
      "federation bond signing requires an HTTPS origin without path, credentials, query, or fragment",
    );
  }
  return parsed.origin;
}

export function federationBondChallengeRequestId(challengeId: string): string {
  const normalized = challengeId.trim();
  if (!normalized || normalized !== challengeId || normalized.length > 256) {
    throw new Error("federation bond challengeId is invalid");
  }
  return `federation-bond:${createHash("sha256").update(normalized, "utf8").digest("hex")}`;
}

export function buildFederationBondChallengeIntent(params: {
  challengeId: string;
  federationOrigin: string;
  payloadBase64: string;
  handle: string;
  nodeId: string;
  tokenId: string;
  bondId: string;
  tier: "none" | "basic-bond" | "operator-bond";
  amountRaw?: string;
  expiresAt: string;
}) {
  return {
    type: FEDERATION_BOND_INTENT,
    federation: {
      challengeId: params.challengeId,
      federationOrigin: federationOrigin(params.federationOrigin),
      handle: params.handle,
      nodeId: params.nodeId,
      tokenId: params.tokenId,
      bondId: params.bondId,
      tier: params.tier,
      ...(params.amountRaw !== undefined ? { amountRaw: params.amountRaw } : {}),
      expiresAt: params.expiresAt,
      payloadBase64: params.payloadBase64,
    },
  } as const;
}

async function requireFederationSigner(socketPath: string): Promise<void> {
  assertSecureLocalSignerSocket(socketPath);
  const health = await callLocalSocketSigner<{
    ready?: boolean;
    capabilities?: {
      protocol?: { current?: number; min?: number; max?: number };
      intentTypes?: string[];
      features?: string[];
    };
  }>(socketPath, { op: "v2.capabilities" });
  const capabilities = health.capabilities;
  const features = new Set(capabilities?.features ?? []);
  const missing = REQUIRED_FEDERATION_SIGNER_FEATURES.filter((feature) => !features.has(feature));
  if (
    health.ready !== true ||
    capabilities?.protocol?.current !== 2 ||
    typeof capabilities.protocol.min !== "number" ||
    capabilities.protocol.min > 2 ||
    typeof capabilities.protocol.max !== "number" ||
    capabilities.protocol.max < 2 ||
    !capabilities.intentTypes?.includes(FEDERATION_BOND_INTENT) ||
    missing.length > 0
  ) {
    throw new Error(
      `local-socket-signer does not support secure federation bond challenges${
        missing.length > 0 ? `; missing features: ${missing.join(", ")}` : ""
      }`,
    );
  }
}

export async function resolveFederationBondWallet(params?: {
  env?: NodeJS.ProcessEnv;
  cfg?: FasedAgentConfig;
  walletId?: string;
}): Promise<ResolvedBondWallet> {
  const env = params?.env ?? process.env;
  const registry = readWalletProviderRegistry(env);
  const walletId =
    params?.walletId?.trim() ||
    resolveFederationBondWalletId({ env, cfg: params?.cfg }) ||
    "default";
  const registryWallet = registry.wallets.find((entry) => entry.id === walletId);
  const socketPath = requireLocalSocketSignerPath(env);
  await requireFederationSigner(socketPath);
  const wallet = await callLocalSocketSigner<{ walletId: string; publicKey: string }>(socketPath, {
    op: "v2.wallet.get",
    walletId,
  });
  const walletAddress = wallet.publicKey.trim();
  if (!walletAddress || wallet.walletId !== nativeSignerWalletId(walletId)) {
    throw new Error(`bond Vault ${walletId} is not available in the native signer`);
  }
  const registryAddress = registryWallet?.addresses?.solana?.trim();
  if (registryAddress && registryAddress !== walletAddress) {
    throw new Error(`bond Vault ${walletId} registry address does not match the native signer`);
  }
  return {
    walletId,
    walletAddress,
    providerId: registryWallet?.providerId,
    socketPath,
  };
}

export async function signFederationBondChallenge(params: {
  challengeId: string;
  federationOrigin: string;
  payloadBase64: string;
  handle: string;
  nodeId: string;
  tokenId: string;
  bondId: string;
  tier: "none" | "basic-bond" | "operator-bond";
  amountRaw?: string;
  expiresAt: string;
  env?: NodeJS.ProcessEnv;
  cfg?: FasedAgentConfig;
  walletId?: string;
  authorization?: WalletProviderSignerReviewAuthorizationV2;
}): Promise<ResolvedBondWallet & { signatureBase64: string; requestId: string }> {
  const env = params.env ?? process.env;
  const resolved = await resolveFederationBondWallet({
    env,
    cfg: params.cfg,
    walletId: params.walletId,
  });
  const requestId = federationBondChallengeRequestId(params.challengeId);
  const policy = await callLocalSocketSigner<LocalSocketSignerPolicyV2>(resolved.socketPath, {
    op: "v2.policy.get",
    walletId: resolved.walletId,
  });
  if (
    policy.role !== "vault" ||
    !policy.operations.includes(FEDERATION_BOND_INTENT) ||
    !policy.programs.includes(FEDERATION_BOND_POLICY_DOMAIN) ||
    !policy.hash.startsWith("sha256:")
  ) {
    throw new Error(
      `bond Vault ${resolved.walletId} does not have an explicit reviewed federation challenge policy`,
    );
  }
  const intent = buildFederationBondChallengeIntent(params);
  let review: WalletProviderJupiterReviewV2;
  try {
    review = await callLocalSocketSigner<WalletProviderJupiterReviewV2>(resolved.socketPath, {
      op: "v2.review.get",
      walletId: resolved.walletId,
      request: { requestId },
    });
  } catch (error) {
    if (!String(error).includes("signer review not found; review.prepare is required")) {
      throw error;
    }
    review = await callLocalSocketSigner<WalletProviderJupiterReviewV2>(resolved.socketPath, {
      op: "v2.review.prepare",
      walletId: resolved.walletId,
      request: {
        requestId,
        policyHash: policy.hash,
        mode: "reviewed",
        intent,
      },
    });
  }
  if (
    review.requestId !== requestId ||
    review.walletId !== nativeSignerWalletId(resolved.walletId) ||
    review.walletPublicKey !== resolved.walletAddress ||
    review.intentType !== FEDERATION_BOND_INTENT ||
    !isDeepStrictEqual(review.semanticIntent, intent) ||
    review.policyHash !== policy.hash ||
    review.mode !== "reviewed" ||
    review.artifactKind !== "domain-separated-message" ||
    review.messageBase64 !== params.payloadBase64 ||
    review.asset !== "federation:bond-challenge" ||
    review.amount !== "1" ||
    review.destination !== resolved.walletAddress ||
    review.policyOperation !== FEDERATION_BOND_INTENT ||
    review.requiredPrograms.length !== 1 ||
    review.requiredPrograms[0] !== FEDERATION_BOND_POLICY_DOMAIN ||
    review.requiredRole !== "vault"
  ) {
    throw new Error(`federation signer review ${requestId} does not match the exact challenge`);
  }
  if (review.state === "prepared" && !params.authorization) {
    const approval = createSignerReviewApprovalRequest({
      review,
      role: "vault",
      walletId: resolved.walletId,
      requestedBy: "federation-bond",
      walletName: resolved.walletId,
      assetName: "Federation bond proof",
      assetSymbol: "Proof",
      memo: `Federation bond challenge for ${params.handle}`,
      env,
    });
    throw new FederationBondReviewAuthorizationRequiredError(review, approval.id);
  }
  const executed = await callLocalSocketSigner<WalletProviderJupiterExecutionV2>(
    resolved.socketPath,
    {
      op: "v2.review.execute",
      walletId: resolved.walletId,
      request: { requestId, authorization: params.authorization },
    },
  );
  if (
    executed.operation.state !== "confirmed" ||
    !executed.signatureBase64 ||
    executed.review.artifactKind !== "domain-separated-message" ||
    executed.review.artifactDigest !== review.artifactDigest
  ) {
    throw new Error(
      `federation signer request ${requestId} did not complete one exact reviewed message signature`,
    );
  }
  return { ...resolved, requestId, signatureBase64: executed.signatureBase64 };
}
