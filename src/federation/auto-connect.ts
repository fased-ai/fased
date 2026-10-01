import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { buildAttestation } from "./attestation.js";
import {
  enforceFederationStateFileMode,
  ensureFederationStateDirectory,
  federationStateFileMode,
} from "./federation-state-permissions.js";
import {
  resolveAgentPublicOrigin,
  resolveFederationBaseUrl,
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
  await ensureFederationStateDirectory(dir, env);
  await fs.writeFile(tmpPath, `${JSON.stringify(tokenToPersist, null, 2)}\n`, {
    mode: federationStateFileMode(env),
  });
  await fs.rename(tmpPath, tokenPath);
  await enforceFederationStateFileMode(tokenPath, env);
  return tokenToPersist;
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
