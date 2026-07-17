import fs from "node:fs/promises";
import path from "node:path";
import type { FasedAgentConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { isTruthyEnvValue } from "../infra/env.js";
import {
  resolveFederationBondWallet,
  signFederationBondChallenge,
} from "../wallet/solana-bond-signing.js";
import type { WalletProviderJupiterReviewV2 } from "../wallet/wallet-provider-adapter.js";
import { buildAttestation } from "./attestation.js";
import {
  resolveAgentPublicOrigin,
  resolveFederationBaseUrl,
  resolveFederationBondWalletId,
  resolveFederationHandle,
} from "./runtime.js";

const DEFAULT_RENEW_INTERVAL_MS = 45 * 60 * 1000;
const DEFAULT_TOKEN_SKEW_MS = 30_000;
const DEFAULT_HTTP_TIMEOUT_MS = 15_000;

type FederationLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

type FederationAccessToken = {
  tokenId: string;
  nodeId: string;
  handle: string;
  issuedAt: string;
  expiresAt: string;
  scopes: string[];
  signature: string;
  trustState?: "pending" | "verified" | "revoked" | "blocked";
  hostedState?: "disabled" | "pending" | "ready" | "missing";
  paidFlowEligible?: boolean;
  zrokToken?: string;
  agentSlug?: string;
  publicUrl?: string;
  bondId?: string;
  bondWallet?: {
    chain: string;
    address: string;
  };
  bondStatus?: "missing" | "active" | "unlocking" | "unlocked";
  bondTier?: "none" | "basic-bond" | "operator-bond";
  bondAmountRaw?: string;
  bondUnlockAvailableAt?: string;
  bondQuotaBand?: "standard" | "boosted" | "operator";
  bondDerivedScopes?: string[];
};

type AutoConnectResult = {
  enabled: boolean;
  handle?: string;
  baseUrl?: string;
  nodeEndpoint?: string;
  reason?: string;
};

type PostResult = {
  ok: boolean;
  status: number;
  bodyText: string;
  json?: unknown;
};

type FederationBondChallengeResult = {
  status?: string;
  challengeId?: string;
  nonce?: string;
  expiresAt?: string;
  payload?: string;
  payloadBase64?: string;
};

type FederationBondVerifyResult = {
  status?: string;
  reason?: string;
  token?: unknown;
  binding?: {
    verifiedAt?: string;
    status?: "missing" | "active" | "unlocking" | "unlocked";
    tier?: "none" | "basic-bond" | "operator-bond";
    amountRaw?: string;
    unlockAvailableAt?: string;
    quotaBand?: "standard" | "boosted" | "operator";
    derivedScopes?: string[];
  };
};

export type PersistedFederationBondProof = {
  challengeId: string;
  bondId: string;
  walletId: string;
  walletAddress: string;
  handle: string;
  nodeId: string;
  federationBaseUrl: string;
  expiresAt: string;
  payload: string;
  payloadBase64: string;
  signatureBase64: string;
  signedAt: string;
  verifiedAt?: string;
  bondStatus?: "missing" | "active" | "unlocking" | "unlocked";
  bondTier?: "none" | "basic-bond" | "operator-bond";
  bondAmountRaw?: string;
  bondUnlockAvailableAt?: string;
  bondQuotaBand?: "standard" | "boosted" | "operator";
  bondDerivedScopes?: string[];
};

function buildAuthHeaders(apiToken?: string): Record<string, string> {
  if (!apiToken) {
    return {};
  }
  return { Authorization: `Bearer ${apiToken}` };
}

function describeHttpError(prefix: string, status: number, body: string): string {
  const payload = body.trim();
  if (!payload) {
    return `${prefix}: HTTP ${status}`;
  }
  return `${prefix}: HTTP ${status} - ${payload.slice(0, 300)}`;
}

async function postJson(params: {
  url: string;
  body: unknown;
  apiToken?: string;
  timeoutMs?: number;
}): Promise<PostResult> {
  const timeoutMs = Math.max(1_000, params.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS);
  const response = await fetch(params.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...buildAuthHeaders(params.apiToken),
    },
    body: JSON.stringify(params.body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const bodyText = await response.text();
  let json: unknown;
  try {
    json = bodyText ? (JSON.parse(bodyText) as unknown) : undefined;
  } catch {
    json = undefined;
  }
  return {
    ok: response.ok,
    status: response.status,
    bodyText,
    json,
  };
}

function parseIssuedToken(value: unknown): FederationAccessToken | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const body = value as { status?: unknown; token?: unknown };
  if (body.status !== "accepted" || typeof body.token !== "object" || body.token === null) {
    return null;
  }
  const token = body.token as Partial<FederationAccessToken>;
  if (
    typeof token.tokenId !== "string" ||
    typeof token.nodeId !== "string" ||
    typeof token.handle !== "string" ||
    typeof token.issuedAt !== "string" ||
    typeof token.expiresAt !== "string" ||
    !Array.isArray(token.scopes) ||
    typeof token.signature !== "string"
  ) {
    return null;
  }
  return {
    tokenId: token.tokenId,
    nodeId: token.nodeId,
    handle: token.handle,
    issuedAt: token.issuedAt,
    expiresAt: token.expiresAt,
    scopes: token.scopes.filter((scope): scope is string => typeof scope === "string"),
    signature: token.signature,
    trustState: typeof token.trustState === "string" ? token.trustState : undefined,
    hostedState: typeof token.hostedState === "string" ? token.hostedState : undefined,
    paidFlowEligible:
      typeof token.paidFlowEligible === "boolean" ? token.paidFlowEligible : undefined,
    zrokToken:
      ((body as Record<string, unknown>).zrokToken as string | undefined) ??
      ((token as Record<string, unknown>).zrokToken as string | undefined),
    agentSlug:
      ((body as Record<string, unknown>).agentSlug as string | undefined) ??
      ((token as Record<string, unknown>).agentSlug as string | undefined),
    publicUrl:
      ((body as Record<string, unknown>).publicUrl as string | undefined) ??
      ((token as Record<string, unknown>).publicUrl as string | undefined),
    bondId: typeof token.bondId === "string" ? token.bondId : undefined,
    bondWallet:
      token.bondWallet &&
      typeof token.bondWallet === "object" &&
      typeof (token.bondWallet as { chain?: unknown }).chain === "string" &&
      typeof (token.bondWallet as { address?: unknown }).address === "string"
        ? {
            chain: (token.bondWallet as { chain: string }).chain,
            address: (token.bondWallet as { address: string }).address,
          }
        : undefined,
    bondStatus:
      token.bondStatus === "missing" ||
      token.bondStatus === "active" ||
      token.bondStatus === "unlocking" ||
      token.bondStatus === "unlocked"
        ? token.bondStatus
        : undefined,
    bondTier:
      token.bondTier === "none" ||
      token.bondTier === "basic-bond" ||
      token.bondTier === "operator-bond"
        ? token.bondTier
        : undefined,
    bondAmountRaw: typeof token.bondAmountRaw === "string" ? token.bondAmountRaw : undefined,
    bondUnlockAvailableAt:
      typeof token.bondUnlockAvailableAt === "string" ? token.bondUnlockAvailableAt : undefined,
    bondQuotaBand:
      token.bondQuotaBand === "standard" ||
      token.bondQuotaBand === "boosted" ||
      token.bondQuotaBand === "operator"
        ? token.bondQuotaBand
        : undefined,
    bondDerivedScopes: Array.isArray(token.bondDerivedScopes)
      ? token.bondDerivedScopes.filter((scope): scope is string => typeof scope === "string")
      : undefined,
  };
}

function isTokenUsable(token: FederationAccessToken | null): boolean {
  if (!token) {
    return false;
  }
  const expiresAtMs = Date.parse(token.expiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    return false;
  }
  return expiresAtMs > Date.now() + DEFAULT_TOKEN_SKEW_MS;
}

function resolveFederationTokenPath(env: NodeJS.ProcessEnv): string {
  const explicitPath = env.FASED_FEDERATION_TOKEN_PATH?.trim();
  if (explicitPath) {
    return explicitPath;
  }
  return path.join(resolveStateDir(env), "federation", "access-token.json");
}

function resolveFederationBondProofPath(env: NodeJS.ProcessEnv): string {
  const explicitPath = env.FASED_FEDERATION_BOND_PROOF_PATH?.trim();
  if (explicitPath) {
    return explicitPath;
  }
  return path.join(resolveStateDir(env), "federation", "bond-proof.json");
}

export async function loadPersistedFederationBondProof(
  env: NodeJS.ProcessEnv,
): Promise<PersistedFederationBondProof | null> {
  const proofPath = resolveFederationBondProofPath(env);
  try {
    const raw = await fs.readFile(proofPath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<PersistedFederationBondProof>;
    if (
      typeof parsed.challengeId !== "string" ||
      typeof parsed.bondId !== "string" ||
      typeof parsed.walletId !== "string" ||
      typeof parsed.walletAddress !== "string" ||
      typeof parsed.handle !== "string" ||
      typeof parsed.nodeId !== "string" ||
      typeof parsed.federationBaseUrl !== "string" ||
      typeof parsed.expiresAt !== "string" ||
      typeof parsed.payload !== "string" ||
      typeof parsed.payloadBase64 !== "string" ||
      typeof parsed.signatureBase64 !== "string" ||
      typeof parsed.signedAt !== "string"
    ) {
      return null;
    }
    return {
      challengeId: parsed.challengeId,
      bondId: parsed.bondId,
      walletId: parsed.walletId,
      walletAddress: parsed.walletAddress,
      handle: parsed.handle,
      nodeId: parsed.nodeId,
      federationBaseUrl: parsed.federationBaseUrl,
      expiresAt: parsed.expiresAt,
      payload: parsed.payload,
      payloadBase64: parsed.payloadBase64,
      signatureBase64: parsed.signatureBase64,
      signedAt: parsed.signedAt,
      verifiedAt: typeof parsed.verifiedAt === "string" ? parsed.verifiedAt : undefined,
      bondStatus:
        parsed.bondStatus === "missing" ||
        parsed.bondStatus === "active" ||
        parsed.bondStatus === "unlocking" ||
        parsed.bondStatus === "unlocked"
          ? parsed.bondStatus
          : undefined,
      bondTier:
        parsed.bondTier === "none" ||
        parsed.bondTier === "basic-bond" ||
        parsed.bondTier === "operator-bond"
          ? parsed.bondTier
          : undefined,
      bondAmountRaw: typeof parsed.bondAmountRaw === "string" ? parsed.bondAmountRaw : undefined,
      bondUnlockAvailableAt:
        typeof parsed.bondUnlockAvailableAt === "string" ? parsed.bondUnlockAvailableAt : undefined,
      bondQuotaBand:
        parsed.bondQuotaBand === "standard" ||
        parsed.bondQuotaBand === "boosted" ||
        parsed.bondQuotaBand === "operator"
          ? parsed.bondQuotaBand
          : undefined,
      bondDerivedScopes: Array.isArray(parsed.bondDerivedScopes)
        ? parsed.bondDerivedScopes.filter((scope): scope is string => typeof scope === "string")
        : undefined,
    };
  } catch {
    return null;
  }
}

async function loadPersistedFederationToken(
  env: NodeJS.ProcessEnv,
  opts?: { includeExpired?: boolean },
): Promise<FederationAccessToken | null> {
  const tokenPath = resolveFederationTokenPath(env);
  try {
    const raw = await fs.readFile(tokenPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    const token = parseIssuedToken({ status: "accepted", token: parsed });
    if (!opts?.includeExpired && !isTokenUsable(token)) {
      return null;
    }
    return token;
  } catch {
    return null;
  }
}

function mergeFederationTunnelMetadata(params: {
  next: FederationAccessToken;
  previous: FederationAccessToken | null;
}): FederationAccessToken {
  const previous = params.previous;
  if (!previous) {
    return params.next;
  }
  return {
    ...params.next,
    hostedState: params.next.hostedState ?? previous.hostedState,
    zrokToken: params.next.zrokToken ?? previous.zrokToken,
    agentSlug: params.next.agentSlug ?? previous.agentSlug,
    publicUrl: params.next.publicUrl ?? previous.publicUrl,
  };
}

async function persistFederationToken(
  env: NodeJS.ProcessEnv,
  token: FederationAccessToken,
): Promise<FederationAccessToken> {
  const previous = await loadPersistedFederationToken(env, { includeExpired: true });
  const tokenToPersist = mergeFederationTunnelMetadata({
    next: token,
    previous,
  });
  const tokenPath = resolveFederationTokenPath(env);
  const dir = path.dirname(tokenPath);
  const tmpPath = `${tokenPath}.tmp`;
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.writeFile(tmpPath, `${JSON.stringify(tokenToPersist, null, 2)}\n`, {
    mode: 0o600,
  });
  await fs.rename(tmpPath, tokenPath);
  return tokenToPersist;
}

async function persistFederationBondProof(
  env: NodeJS.ProcessEnv,
  proof: PersistedFederationBondProof,
): Promise<PersistedFederationBondProof> {
  const proofPath = resolveFederationBondProofPath(env);
  const dir = path.dirname(proofPath);
  const tmpPath = `${proofPath}.tmp`;
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.writeFile(tmpPath, `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tmpPath, proofPath);
  return proof;
}

async function syncHostedEndpointOverride(params: {
  baseUrl: string;
  token: FederationAccessToken;
  fallbackUrl: string;
  log?: FederationLogger;
}): Promise<void> {
  const publicUrl = params.token.publicUrl?.trim() || "";
  if (!publicUrl || params.token.hostedState !== "ready") {
    return;
  }
  const fallbackUrl = params.fallbackUrl.trim();
  if (!fallbackUrl || fallbackUrl === publicUrl) {
    return;
  }
  const update = await postJson({
    url: `${params.baseUrl}/api/federation/endpoint/update`,
    apiToken: params.token.tokenId,
    body: {
      endpoint: publicUrl,
      fallbackUrl,
    },
  });
  if (!update.ok) {
    params.log?.warn?.(
      describeHttpError("federation endpoint update failed", update.status, update.bodyText),
    );
    return;
  }
  params.log?.info?.(`Endpoint updated: ${params.token.handle} -> ${publicUrl}`);
}

async function runEnrollmentCycle(params: {
  baseUrl: string;
  handle: string;
  nodeEndpoint: string;
  apiToken?: string;
  mode: "attest" | "renew";
  log?: FederationLogger;
}): Promise<{ ok: boolean; status: number; token?: FederationAccessToken }> {
  if (params.mode === "attest") {
    const registerUrl = `${params.baseUrl}/api/federation/registry/handles`;
    const register = await postJson({
      url: registerUrl,
      apiToken: params.apiToken,
      body: {
        requestedHandle: params.handle,
        nodeEndpoint: params.nodeEndpoint,
      },
    });
    if (!register.ok) {
      params.log?.warn?.(
        describeHttpError("federation register failed", register.status, register.bodyText),
      );
    }
  }

  const attestation = buildAttestation({ handle: params.handle });
  const path =
    params.mode === "renew"
      ? "/api/federation/admission/renew"
      : "/api/federation/admission/attest";
  const admissionUrl = `${params.baseUrl}${path}`;
  const admissionBody = params.mode === "renew" ? { attestation } : attestation;
  const admission = await postJson({
    url: admissionUrl,
    apiToken: params.apiToken,
    body: admissionBody,
  });
  if (!admission.ok) {
    params.log?.warn?.(
      describeHttpError(`federation ${params.mode} failed`, admission.status, admission.bodyText),
    );
    return { ok: false, status: admission.status };
  }

  const issuedToken = parseIssuedToken(admission.json);
  params.log?.info?.(
    `${params.mode === "renew" ? "Renewal confirmed" : "Attestation confirmed"}: ${
      params.handle
    } -> ${params.nodeEndpoint}`,
  );
  return { ok: true, status: admission.status, token: issuedToken ?? undefined };
}

async function runChallengeEnroll(params: {
  env: NodeJS.ProcessEnv;
  baseUrl: string;
  handle: string;
  nodeEndpoint: string;
  log?: FederationLogger;
}): Promise<{ ok: boolean; token?: FederationAccessToken; reason?: string }> {
  const challenge = await postJson({
    url: `${params.baseUrl}/api/federation/admission/challenge`,
    body: {
      handle: params.handle,
      nodeEndpoint: params.nodeEndpoint,
      nodeId: buildAttestation({ handle: params.handle }).nodeId,
    },
  });
  if (!challenge.ok) {
    return {
      ok: false,
      reason: describeHttpError(
        "federation challenge failed",
        challenge.status,
        challenge.bodyText,
      ),
    };
  }
  const challengeBody = challenge.json as { challengeId?: string; nonce?: string } | undefined;
  const challengeId = challengeBody?.challengeId?.trim();
  const challengeNonce = challengeBody?.nonce?.trim();
  if (!challengeId) {
    return { ok: false, reason: "federation challenge failed: missing challengeId" };
  }
  if (!challengeNonce) {
    return { ok: false, reason: "federation challenge failed: missing nonce" };
  }
  const attestation = buildAttestation({
    handle: params.handle,
    challengeNonce,
  });

  const enroll = await postJson({
    url: `${params.baseUrl}/api/federation/admission/enroll`,
    body: {
      challengeId,
      attestation,
    },
  });
  if (!enroll.ok) {
    return {
      ok: false,
      reason: describeHttpError("federation enroll failed", enroll.status, enroll.bodyText),
    };
  }
  const token = parseIssuedToken(enroll.json);
  if (!token) {
    return { ok: false, reason: "federation enroll failed: missing issued token" };
  }
  const persistedToken = await persistFederationToken(params.env, token);
  await syncHostedEndpointOverride({
    baseUrl: params.baseUrl,
    token: persistedToken,
    fallbackUrl: params.nodeEndpoint,
    log: params.log,
  });
  params.log?.info?.(`Enrollment confirmed: ${params.handle} -> ${params.nodeEndpoint}`);
  return { ok: true, token };
}

export async function createFederationBondProof(opts?: {
  env?: NodeJS.ProcessEnv;
  cfg?: FasedAgentConfig;
  log?: FederationLogger;
  bondId?: string;
  walletId?: string;
  amountRaw?: string;
  tier?: "none" | "basic-bond" | "operator-bond";
}): Promise<PersistedFederationBondProof> {
  const env = opts?.env ?? process.env;
  const baseUrl = resolveFederationBaseUrl(env);
  if (!baseUrl) {
    throw new Error("invalid federation base URL");
  }
  const federationToken = await loadPersistedFederationToken(env);
  if (!federationToken?.tokenId) {
    throw new Error("missing federation access token");
  }
  const walletId =
    opts?.walletId?.trim() || resolveFederationBondWalletId({ env, cfg: opts?.cfg }) || "default";
  const resolvedWallet = await resolveFederationBondWallet({
    env,
    cfg: opts?.cfg,
    walletId,
  });
  const bondId =
    opts?.bondId?.trim() ||
    env.FASED_FEDERATION_BOND_ID?.trim() ||
    env.FASED_BOND_ID?.trim() ||
    `bond:${resolvedWallet.walletAddress}`;
  const challenge = await postJson({
    url: `${baseUrl}/api/federation/bond/challenge`,
    apiToken: federationToken.tokenId,
    body: {
      bondId,
      wallet: {
        chain: "solana",
        address: resolvedWallet.walletAddress,
      },
      ...(opts?.amountRaw?.trim() ? { amountRaw: opts.amountRaw.trim() } : {}),
      ...(opts?.tier ? { tier: opts.tier } : {}),
    },
  });
  if (!challenge.ok) {
    throw new Error(
      describeHttpError("federation bond challenge failed", challenge.status, challenge.bodyText),
    );
  }
  const challengeBody = (challenge.json ?? {}) as FederationBondChallengeResult;
  const challengeId = challengeBody.challengeId?.trim();
  const expiresAt = challengeBody.expiresAt?.trim();
  let payloadBase64 = challengeBody.payloadBase64?.trim() ?? "";
  let payload = challengeBody.payload ?? "";
  if (payloadBase64) {
    const decoded = Buffer.from(payloadBase64, "base64");
    if (decoded.toString("base64") !== payloadBase64) {
      throw new Error("federation bond challenge failed: payloadBase64 is not canonical");
    }
    const decodedPayload = decoded.toString("utf-8");
    if (payload && payload !== decodedPayload) {
      throw new Error("federation bond challenge failed: payload encodings disagree");
    }
    payload = decodedPayload;
  } else if (payload) {
    payloadBase64 = Buffer.from(payload, "utf-8").toString("base64");
  }
  if (!challengeId || !expiresAt || !payload || !payloadBase64) {
    throw new Error("federation bond challenge failed: incomplete challenge payload");
  }
  if (!opts?.tier) {
    throw new Error("federation bond challenge requires the locally reviewed bond tier");
  }
  const signedWallet = await signFederationBondChallenge({
    challengeId,
    federationOrigin: baseUrl,
    payloadBase64,
    handle: federationToken.handle,
    nodeId: federationToken.nodeId,
    tokenId: federationToken.tokenId,
    bondId,
    tier: opts.tier,
    ...(opts.amountRaw?.trim() ? { amountRaw: opts.amountRaw.trim() } : {}),
    expiresAt,
    env,
    cfg: opts?.cfg,
    walletId: resolvedWallet.walletId,
  });
  const proof: PersistedFederationBondProof = {
    challengeId,
    bondId,
    walletId: signedWallet.walletId,
    walletAddress: signedWallet.walletAddress,
    handle: federationToken.handle,
    nodeId: federationToken.nodeId,
    federationBaseUrl: baseUrl,
    expiresAt,
    payload,
    payloadBase64,
    signatureBase64: signedWallet.signatureBase64,
    signedAt: new Date().toISOString(),
  };
  await persistFederationBondProof(env, proof);
  opts?.log?.info?.(
    `federation bond proof prepared (${proof.handle} -> ${proof.walletAddress}, bond=${proof.bondId})`,
  );
  return proof;
}

export async function persistFederationBondProofFromSignerReview(params: {
  review: WalletProviderJupiterReviewV2;
  signatureBase64: string;
  walletId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<PersistedFederationBondProof> {
  const env = params.env ?? process.env;
  const review = params.review;
  if (
    review.state !== "signed" ||
    review.intentType !== "federation.bondChallenge" ||
    review.semanticIntent.type !== "federation.bondChallenge" ||
    review.artifactKind !== "domain-separated-message" ||
    review.asset !== "federation:bond-challenge" ||
    review.amount !== "1" ||
    review.policyOperation !== "federation.bondChallenge" ||
    review.requiredRole !== "vault" ||
    review.requiredPrograms.length !== 1 ||
    review.requiredPrograms[0] !== "domain:fased:federation-bond-challenge-v1"
  ) {
    throw new Error("signed signer review is not an exact federation bond challenge");
  }
  const federation = review.semanticIntent.federation;
  if (
    !review.walletPublicKey ||
    review.destination !== review.walletPublicKey ||
    review.messageBase64 !== federation.payloadBase64 ||
    review.signature !== params.signatureBase64
  ) {
    throw new Error("signed federation review artifact does not match its wallet or payload");
  }
  const signature = Buffer.from(params.signatureBase64, "base64");
  if (signature.length !== 64 || signature.toString("base64") !== params.signatureBase64) {
    throw new Error("signed federation review returned a non-canonical Ed25519 signature");
  }
  const payloadBytes = Buffer.from(federation.payloadBase64, "base64");
  if (payloadBytes.toString("base64") !== federation.payloadBase64) {
    throw new Error("signed federation review payload is not canonical base64");
  }
  const payload = payloadBytes.toString("utf8");
  if (!Buffer.from(payload, "utf8").equals(payloadBytes)) {
    throw new Error("signed federation review payload is not valid UTF-8");
  }
  const challengeExpiresAt = Date.parse(federation.expiresAt);
  if (!Number.isFinite(challengeExpiresAt) || challengeExpiresAt <= Date.now()) {
    throw new Error("signed federation review challenge has expired");
  }
  const token = await loadPersistedFederationToken(env, { includeExpired: true });
  if (
    !token ||
    token.tokenId !== federation.tokenId ||
    token.nodeId !== federation.nodeId ||
    token.handle !== federation.handle
  ) {
    throw new Error("signed federation review does not match the persisted federation identity");
  }
  const configuredOrigin = resolveFederationBaseUrl(env);
  if (!configuredOrigin || new URL(configuredOrigin).origin !== federation.federationOrigin) {
    throw new Error("signed federation review does not match the configured federation origin");
  }
  return await persistFederationBondProof(env, {
    challengeId: federation.challengeId,
    bondId: federation.bondId,
    walletId: params.walletId,
    walletAddress: review.walletPublicKey,
    handle: federation.handle,
    nodeId: federation.nodeId,
    federationBaseUrl: federation.federationOrigin,
    expiresAt: federation.expiresAt,
    payload,
    payloadBase64: federation.payloadBase64,
    signatureBase64: params.signatureBase64,
    signedAt: review.updatedAt,
  });
}

export async function submitFederationBondProof(opts?: {
  env?: NodeJS.ProcessEnv;
  cfg?: FasedAgentConfig;
  log?: FederationLogger;
  proof?: PersistedFederationBondProof;
}): Promise<{ proof: PersistedFederationBondProof; token: FederationAccessToken }> {
  const env = opts?.env ?? process.env;
  const proof = opts?.proof ?? (await loadPersistedFederationBondProof(env));
  if (!proof) {
    throw new Error("missing federation bond proof");
  }
  const federationToken = await loadPersistedFederationToken(env);
  if (!federationToken?.tokenId) {
    throw new Error("missing federation access token");
  }
  const verify = await postJson({
    url: `${proof.federationBaseUrl}/api/federation/bond/verify`,
    apiToken: federationToken.tokenId,
    body: {
      challengeId: proof.challengeId,
      payloadBase64: proof.payloadBase64,
      signatureBase64: proof.signatureBase64,
    },
  });
  if (!verify.ok) {
    throw new Error(
      describeHttpError("federation bond verify failed", verify.status, verify.bodyText),
    );
  }
  const verifyBody = (verify.json ?? {}) as FederationBondVerifyResult;
  if (verifyBody.status !== "accepted") {
    throw new Error(
      verifyBody.reason?.trim() || "federation bond verify failed: missing acceptance result",
    );
  }
  const issuedToken = parseIssuedToken({
    status: verifyBody.status,
    token: verifyBody.token,
  });
  if (!issuedToken) {
    throw new Error("federation bond verify failed: missing updated token");
  }
  const persistedToken = await persistFederationToken(env, issuedToken);
  const verifiedProof: PersistedFederationBondProof = {
    ...proof,
    verifiedAt: verifyBody.binding?.verifiedAt ?? new Date().toISOString(),
    bondStatus: verifyBody.binding?.status,
    bondTier: verifyBody.binding?.tier,
    bondAmountRaw: verifyBody.binding?.amountRaw,
    bondUnlockAvailableAt: verifyBody.binding?.unlockAvailableAt,
    bondQuotaBand: verifyBody.binding?.quotaBand,
    bondDerivedScopes: verifyBody.binding?.derivedScopes,
  };
  await persistFederationBondProof(env, verifiedProof);
  opts?.log?.info?.(
    `federation bond proof verified (${verifiedProof.handle} -> ${verifiedProof.walletAddress}, tier=${verifiedProof.bondTier ?? "none"})`,
  );
  return {
    proof: verifiedProof,
    token: persistedToken,
  };
}

export async function createAndSubmitFederationBondProof(opts?: {
  env?: NodeJS.ProcessEnv;
  cfg?: FasedAgentConfig;
  log?: FederationLogger;
  bondId?: string;
  walletId?: string;
  amountRaw?: string;
  tier?: "none" | "basic-bond" | "operator-bond";
}): Promise<{ proof: PersistedFederationBondProof; token: FederationAccessToken }> {
  const proof = await createFederationBondProof(opts);
  return await submitFederationBondProof({
    env: opts?.env,
    cfg: opts?.cfg,
    log: opts?.log,
    proof,
  });
}

export async function runFederationAutoConnectOnce(opts?: {
  env?: NodeJS.ProcessEnv;
  log?: FederationLogger;
}): Promise<AutoConnectResult> {
  const env = opts?.env ?? process.env;
  const autoConnect =
    env.FASED_FEDERATION_AUTO_CONNECT == null
      ? true
      : isTruthyEnvValue(env.FASED_FEDERATION_AUTO_CONNECT);
  if (!autoConnect) {
    return { enabled: false, reason: "disabled" };
  }

  const baseUrl = resolveFederationBaseUrl(env);
  if (!baseUrl) {
    return { enabled: false, reason: "invalid federation base URL" };
  }
  const baseDomain = new URL(baseUrl).hostname;
  const nodeEndpoint = resolveAgentPublicOrigin(env);
  const handle = resolveFederationHandle({
    env,
    fallbackDomain: baseDomain,
  });
  const envApiToken = env.FASED_FEDERATION_API_TOKEN?.trim();
  const persistedToken = await loadPersistedFederationToken(env);
  const bootstrapToken =
    envApiToken || (isTokenUsable(persistedToken) ? persistedToken?.tokenId : "");

  try {
    if (bootstrapToken) {
      const cycle = await runEnrollmentCycle({
        baseUrl,
        handle,
        nodeEndpoint,
        apiToken: bootstrapToken,
        mode: "attest",
        log: opts?.log,
      });
      if (cycle.ok) {
        let effectiveToken = cycle.token;
        if (!envApiToken && cycle.token) {
          effectiveToken = await persistFederationToken(env, cycle.token);
        }
        if (effectiveToken) {
          await syncHostedEndpointOverride({
            baseUrl,
            token: effectiveToken,
            fallbackUrl: nodeEndpoint,
            log: opts?.log,
          });
        }
        return { enabled: true, baseUrl, handle, nodeEndpoint };
      }
      if (cycle.status !== 401 || envApiToken) {
        return {
          enabled: true,
          baseUrl,
          handle,
          nodeEndpoint,
          reason: `attest failed (${cycle.status})`,
        };
      }
    }

    const enrolled = await runChallengeEnroll({
      env,
      baseUrl,
      handle,
      nodeEndpoint,
      log: opts?.log,
    });
    if (!enrolled.ok) {
      opts?.log?.warn?.(enrolled.reason ?? "federation enroll failed");
      return {
        enabled: true,
        baseUrl,
        handle,
        nodeEndpoint,
        reason: enrolled.reason,
      };
    }
    return { enabled: true, baseUrl, handle, nodeEndpoint };
  } catch (err) {
    opts?.log?.warn?.(`federation auto-connect failed: ${String(err)}`);
    return {
      enabled: true,
      baseUrl,
      handle,
      nodeEndpoint,
      reason: String(err),
    };
  }
}

export function startFederationAutoConnect(opts?: {
  env?: NodeJS.ProcessEnv;
  log?: FederationLogger;
}): { stop: () => void; state: AutoConnectResult } | null {
  const env = opts?.env ?? process.env;
  const autoConnect =
    env.FASED_FEDERATION_AUTO_CONNECT == null
      ? true
      : isTruthyEnvValue(env.FASED_FEDERATION_AUTO_CONNECT);
  if (!autoConnect) {
    return null;
  }

  const baseUrl = resolveFederationBaseUrl(env);
  if (!baseUrl) {
    opts?.log?.warn?.("federation auto-connect disabled: invalid federation base URL");
    return null;
  }
  const baseDomain = new URL(baseUrl).hostname;
  const nodeEndpoint = resolveAgentPublicOrigin(env);
  const handle = resolveFederationHandle({
    env,
    fallbackDomain: baseDomain,
  });
  const envApiToken = env.FASED_FEDERATION_API_TOKEN?.trim();
  const renewIntervalRaw = Number(env.FASED_FEDERATION_RENEW_INTERVAL_MS ?? "");
  const renewIntervalMs =
    Number.isFinite(renewIntervalRaw) && renewIntervalRaw >= 60_000
      ? Math.floor(renewIntervalRaw)
      : DEFAULT_RENEW_INTERVAL_MS;

  let stopped = false;
  let inFlight = false;
  let runtimeToken = envApiToken || "";

  const runBoot = async () => {
    if (!runtimeToken) {
      const persistedToken = await loadPersistedFederationToken(env);
      if (isTokenUsable(persistedToken)) {
        runtimeToken = persistedToken?.tokenId ?? "";
      }
    }

    if (runtimeToken) {
      const boot = await runEnrollmentCycle({
        baseUrl,
        handle,
        nodeEndpoint,
        apiToken: runtimeToken,
        mode: "attest",
        log: opts?.log,
      });
      if (boot.ok) {
        let effectiveToken = boot.token;
        if (!envApiToken && boot.token) {
          effectiveToken = await persistFederationToken(env, boot.token);
          runtimeToken = boot.token.tokenId;
        }
        if (effectiveToken) {
          await syncHostedEndpointOverride({
            baseUrl,
            token: effectiveToken,
            fallbackUrl: nodeEndpoint,
            log: opts?.log,
          });
        }
        return;
      }
      if (boot.status !== 401 || envApiToken) {
        return;
      }
    }

    const enrolled = await runChallengeEnroll({
      env,
      baseUrl,
      handle,
      nodeEndpoint,
      log: opts?.log,
    });
    if (enrolled.ok && enrolled.token && !envApiToken) {
      runtimeToken = enrolled.token.tokenId;
    }
  };

  const runRenew = async () => {
    if (stopped || inFlight) {
      return;
    }
    inFlight = true;
    try {
      if (!runtimeToken && !envApiToken) {
        const persistedToken = await loadPersistedFederationToken(env);
        if (isTokenUsable(persistedToken)) {
          runtimeToken = persistedToken?.tokenId ?? "";
        }
      }

      const tokenToUse = envApiToken || runtimeToken;
      if (!tokenToUse) {
        const enrolled = await runChallengeEnroll({
          env,
          baseUrl,
          handle,
          nodeEndpoint,
          log: opts?.log,
        });
        if (enrolled.ok && enrolled.token && !envApiToken) {
          runtimeToken = enrolled.token.tokenId;
        }
        return;
      }

      const renew = await runEnrollmentCycle({
        baseUrl,
        handle,
        nodeEndpoint,
        apiToken: tokenToUse,
        mode: "renew",
        log: opts?.log,
      });
      if (renew.ok) {
        let effectiveToken = renew.token;
        if (!envApiToken && renew.token) {
          effectiveToken = await persistFederationToken(env, renew.token);
          runtimeToken = renew.token.tokenId;
        }
        if (effectiveToken) {
          await syncHostedEndpointOverride({
            baseUrl,
            token: effectiveToken,
            fallbackUrl: nodeEndpoint,
            log: opts?.log,
          });
        }
        return;
      }

      if (renew.status === 401 && !envApiToken) {
        const enrolled = await runChallengeEnroll({
          env,
          baseUrl,
          handle,
          nodeEndpoint,
          log: opts?.log,
        });
        if (enrolled.ok && enrolled.token) {
          runtimeToken = enrolled.token.tokenId;
        }
      }
    } finally {
      inFlight = false;
    }
  };

  void runBoot();
  const renewTimer = setInterval(() => {
    void runRenew();
  }, renewIntervalMs);

  return {
    state: { enabled: true, baseUrl, handle, nodeEndpoint },
    stop: () => {
      stopped = true;
      clearInterval(renewTimer);
    },
  };
}
