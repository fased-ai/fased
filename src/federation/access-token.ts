import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import {
  enforceFederationStateFileMode,
  ensureFederationStateDirectory,
  federationStateFileMode,
} from "./federation-state-permissions.js";

export type FederationTrustState = "pending" | "verified" | "revoked" | "blocked";
export type FederationHostedState = "disabled" | "pending" | "ready" | "missing";

export type PersistedFederationToken = {
  tokenId: string;
  nodeId: string;
  handle: string;
  issuedAt: string;
  expiresAt: string;
  scopes: string[];
  signature: string;
  trustState?: FederationTrustState;
  hostedState?: FederationHostedState;
  agentSlug?: string;
  publicUrl?: string;
  zrokToken?: string;
  zrokTokenPresent?: boolean;
  lastAttestOrRenewAt?: string;
  paidFlowEligible?: boolean;
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

export function resolveFederationTokenPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicitPath = env.FASED_FEDERATION_TOKEN_PATH?.trim();
  if (explicitPath) {
    return explicitPath;
  }
  return path.join(resolveStateDir(env), "federation", "access-token.json");
}

export async function loadPersistedFederationToken(
  env: NodeJS.ProcessEnv = process.env,
): Promise<PersistedFederationToken | null> {
  const tokenPath = resolveFederationTokenPath(env);
  try {
    const raw = await fs.readFile(tokenPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const token = parsed as Partial<PersistedFederationToken>;
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
      trustState:
        token.trustState === "pending" ||
        token.trustState === "verified" ||
        token.trustState === "revoked" ||
        token.trustState === "blocked"
          ? token.trustState
          : undefined,
      hostedState:
        token.hostedState === "disabled" ||
        token.hostedState === "pending" ||
        token.hostedState === "ready" ||
        token.hostedState === "missing"
          ? token.hostedState
          : undefined,
      agentSlug: typeof token.agentSlug === "string" ? token.agentSlug : undefined,
      publicUrl: typeof token.publicUrl === "string" ? token.publicUrl : undefined,
      zrokToken: typeof token.zrokToken === "string" ? token.zrokToken : undefined,
      zrokTokenPresent:
        typeof token.zrokTokenPresent === "boolean" ? token.zrokTokenPresent : undefined,
      lastAttestOrRenewAt:
        typeof token.lastAttestOrRenewAt === "string" ? token.lastAttestOrRenewAt : undefined,
      paidFlowEligible:
        typeof token.paidFlowEligible === "boolean" ? token.paidFlowEligible : undefined,
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
  } catch {
    return null;
  }
}

function mergePersistedFederationTokenMetadata(params: {
  next: PersistedFederationToken;
  previous: PersistedFederationToken | null;
}): PersistedFederationToken {
  const previous = params.previous;
  if (!previous) {
    return params.next;
  }
  return {
    ...params.next,
    hostedState: params.next.hostedState ?? previous.hostedState,
    agentSlug: params.next.agentSlug ?? previous.agentSlug,
    publicUrl: params.next.publicUrl ?? previous.publicUrl,
    zrokToken: params.next.zrokToken ?? previous.zrokToken,
    zrokTokenPresent: params.next.zrokTokenPresent ?? previous.zrokTokenPresent,
  };
}

export async function persistFederationAccessToken(
  token: PersistedFederationToken,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PersistedFederationToken> {
  const tokenPath = resolveFederationTokenPath(env);
  const previous = await loadPersistedFederationToken(env);
  const next = mergePersistedFederationTokenMetadata({ next: token, previous });
  await ensureFederationStateDirectory(path.dirname(tokenPath), env);
  const tmpPath = `${tokenPath}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(next, null, 2)}\n`, {
    mode: federationStateFileMode(env),
  });
  await fs.rename(tmpPath, tokenPath);
  await enforceFederationStateFileMode(tokenPath, env);
  return next;
}

export async function loadFederationBearerToken(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const token = await loadPersistedFederationToken(env);
  if (!token?.tokenId) {
    return "";
  }
  const expiresAtMs = Date.parse(token.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    return "";
  }
  return token.tokenId;
}
