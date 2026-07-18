import crypto from "node:crypto";
import fs from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import type { AuthRateLimiter } from "../gateway/auth-rate-limit.js";
import { createAuthRateLimiter } from "../gateway/auth-rate-limit.js";
import { isLoopbackHost } from "../gateway/net.js";
import {
  deriveDeviceIdFromPublicKey,
  loadOrCreateDeviceIdentity,
  normalizeDevicePublicKeyBase64Url,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
  verifyDeviceSignature,
  type DeviceIdentity,
} from "../infra/device-identity.js";
import { withFileLock } from "../infra/file-lock.js";
import { readResponseWithLimit } from "../media/read-response-with-limit.js";

export const FEDERATION_PEER_PROTOCOL_VERSION = "2";
export const FEDERATION_PEER_PROTOCOL_DOMAIN = "fased:federation-peer-request:v2";
export const FEDERATION_PEER_MAX_CLOCK_SKEW_MS = 2 * 60_000;

export const FEDERATION_MARKETPLACE_ORDER_PATH = "/api/federation/marketplace/orders";
export const FEDERATION_MARKETPLACE_DELIVERY_PATH = "/api/federation/marketplace/deliveries";
export const FEDERATION_A2A_RPC_PATH = "/a2a";

export const FEDERATION_PEER_HEADERS = {
  protocolVersion: "x-fased-protocol-version",
  senderHandle: "x-fased-sender-handle",
  recipientHandle: "x-fased-recipient-handle",
  timestamp: "x-fased-request-ts",
  nonce: "x-fased-request-nonce",
  bodySha256: "x-fased-content-sha256",
  publicKey: "x-fased-device-public-key",
  signature: "x-fased-request-signature",
} as const;

const DEFAULT_REPLAY_TTL_MS = 10 * 60_000;
const MAX_REPLAY_RESERVATIONS = 10_000;
const MAX_DIRECTORY_RESPONSE_BYTES = 256 * 1024;
const DIRECTORY_TIMEOUT_MS = 5_000;
const INGRESS_RATE_LIMIT_SCOPE = "federation-peer-v2";

type JsonScalar = string | number | boolean | null;
type CanonicalJsonValue = JsonScalar | CanonicalJsonValue[] | { [key: string]: CanonicalJsonValue };

export type FederationPeerDirectoryIdentity = {
  status: string;
  nodeId: string;
  handle?: string;
  nodeEndpoint?: string;
  bondTier?: "none" | "basic-bond" | "operator-bond";
  supportsProtocolV2?: boolean;
};

export type FederationPeerDirectoryLookup = (params: {
  senderHandle: string;
  baseUrl: string;
  apiToken?: string;
  fetchImpl: typeof fetch;
}) => Promise<FederationPeerDirectoryIdentity>;

export type FederationPeerReplayReservation = (params: {
  senderHandle: string;
  nodeId: string;
  nonce: string;
  timestampMs: number;
  nowMs: number;
  env: NodeJS.ProcessEnv;
}) => Promise<{ ok: true } | { ok: false; reason: "replay" | "unavailable" }>;

export type FederationPeerVerifyDeps = {
  now?: () => number;
  fetchImpl?: typeof fetch;
  directoryLookup?: FederationPeerDirectoryLookup;
  reserveReplay?: FederationPeerReplayReservation;
  rateLimiter?: Pick<AuthRateLimiter, "check" | "recordFailure">;
};

type FederationPeerRejection = Extract<FederationPeerAuthorizationResult, { ok: false }>;
export type FederationPeerAuthorizedRequest = Extract<
  FederationPeerAuthorizationResult,
  { ok: true }
>;

export type FederationPeerAuthorizationResult =
  | {
      ok: true;
      senderHandle: string;
      recipientHandle: string;
      nodeId: string;
      nonce: string;
      timestampMs: number;
      bodySha256: string;
      bondTier?: "none" | "basic-bond" | "operator-bond";
    }
  | {
      ok: false;
      statusCode: 401 | 409 | 429 | 503;
      code:
        | "peer_auth_invalid"
        | "peer_auth_stale"
        | "peer_auth_directory_unavailable"
        | "peer_auth_unverified"
        | "peer_auth_replay"
        | "peer_auth_replay_unavailable"
        | "peer_auth_rate_limited";
      reason: string;
      retryAfterMs?: number;
    };

type ReplayState = {
  version: 2;
  reservations: Record<string, number>;
};

const DEFAULT_INGRESS_RATE_LIMITER = createAuthRateLimiter({
  maxAttempts: 60,
  windowMs: 60_000,
  lockoutMs: 60_000,
  exemptLoopback: false,
});

let replayReservationQueue: Promise<void> = Promise.resolve();

function normalizeHandle(value: string): string {
  return value.trim().toLowerCase();
}

export function isTrustedFederationPeerUrl(url: URL): boolean {
  if (url.username || url.password) {
    return false;
  }
  return url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHost(url.hostname));
}

function serializeCanonicalJson(value: CanonicalJsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => serializeCanonicalJson(entry)).join(",")}]`;
  }
  return `{${Object.keys(value)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${serializeCanonicalJson(value[key])}`)
    .join(",")}}`;
}

export function canonicalizeFederationPeerJson(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw new Error("federation peer request body must be JSON-serializable");
  }
  return serializeCanonicalJson(JSON.parse(json) as CanonicalJsonValue);
}

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function buildSignaturePayload(params: {
  senderHandle: string;
  recipientHandle: string;
  method: string;
  path: string;
  timestampMs: number;
  nonce: string;
  bodySha256: string;
  publicKey: string;
}): string {
  return canonicalizeFederationPeerJson({
    protocol: FEDERATION_PEER_PROTOCOL_DOMAIN,
    version: FEDERATION_PEER_PROTOCOL_VERSION,
    sender: normalizeHandle(params.senderHandle),
    recipient: normalizeHandle(params.recipientHandle),
    method: params.method.trim().toUpperCase(),
    path: params.path,
    timestamp: params.timestampMs,
    nonce: params.nonce,
    bodySha256: params.bodySha256,
    publicKey: params.publicKey,
  });
}

function resolveIdentity(env: NodeJS.ProcessEnv, identity?: DeviceIdentity): DeviceIdentity {
  return (
    identity ??
    loadOrCreateDeviceIdentity(path.join(resolveStateDir(env), "identity", "device.json"))
  );
}

export function buildSignedFederationPeerRequest(params: {
  senderHandle: string;
  recipientHandle: string;
  path:
    | typeof FEDERATION_MARKETPLACE_ORDER_PATH
    | typeof FEDERATION_MARKETPLACE_DELIVERY_PATH
    | typeof FEDERATION_A2A_RPC_PATH;
  body: unknown;
  method?: "POST";
  nowMs?: number;
  nonce?: string;
  env?: NodeJS.ProcessEnv;
  identity?: DeviceIdentity;
}): { body: string; headers: Record<string, string> } {
  const senderHandle = normalizeHandle(params.senderHandle);
  const recipientHandle = normalizeHandle(params.recipientHandle);
  if (!senderHandle || senderHandle.length > 256) {
    throw new Error("federation peer sender handle is required");
  }
  if (!recipientHandle || recipientHandle.length > 256) {
    throw new Error("federation peer recipient handle is required");
  }
  const method = params.method ?? "POST";
  const timestampMs = params.nowMs ?? Date.now();
  if (!Number.isSafeInteger(timestampMs) || timestampMs <= 0) {
    throw new Error("federation peer request timestamp is invalid");
  }
  const nonce = params.nonce?.trim() || crypto.randomUUID();
  if (!/^[A-Za-z0-9_-]{16,128}$/u.test(nonce)) {
    throw new Error("federation peer request nonce is invalid");
  }
  const body = canonicalizeFederationPeerJson(params.body);
  const bodySha256 = sha256Hex(body);
  const identity = resolveIdentity(params.env ?? process.env, params.identity);
  const publicKey = publicKeyRawBase64UrlFromPem(identity.publicKeyPem);
  const signature = signDevicePayload(
    identity.privateKeyPem,
    buildSignaturePayload({
      senderHandle,
      recipientHandle,
      method,
      path: params.path,
      timestampMs,
      nonce,
      bodySha256,
      publicKey,
    }),
  );
  return {
    body,
    headers: {
      [FEDERATION_PEER_HEADERS.protocolVersion]: FEDERATION_PEER_PROTOCOL_VERSION,
      [FEDERATION_PEER_HEADERS.senderHandle]: senderHandle,
      [FEDERATION_PEER_HEADERS.recipientHandle]: recipientHandle,
      [FEDERATION_PEER_HEADERS.timestamp]: String(timestampMs),
      [FEDERATION_PEER_HEADERS.nonce]: nonce,
      [FEDERATION_PEER_HEADERS.bodySha256]: bodySha256,
      [FEDERATION_PEER_HEADERS.publicKey]: publicKey,
      [FEDERATION_PEER_HEADERS.signature]: signature,
    },
  };
}

function readSingleHeader(req: IncomingMessage, name: string): string {
  const value = req.headers[name];
  return typeof value === "string" ? value.trim() : "";
}

function directoryEntryCandidates(body: unknown): Record<string, unknown>[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return [];
  }
  const record = body as Record<string, unknown>;
  return [record, record.entry, record.record, record.directory, record.node].filter(
    (entry): entry is Record<string, unknown> =>
      Boolean(entry && typeof entry === "object" && !Array.isArray(entry)),
  );
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
    : [];
}

function supportsFederationPeerProtocolV2(entry: Record<string, unknown>): boolean {
  const advertised = [
    typeof entry.protocolVersion === "string" ? entry.protocolVersion : "",
    typeof entry.peerProtocolVersion === "string" ? entry.peerProtocolVersion : "",
    typeof entry.federationPeerProtocolVersion === "string"
      ? entry.federationPeerProtocolVersion
      : "",
    ...readStringArray(entry.protocolVersions),
    ...readStringArray(entry.supportedProtocols),
    ...readStringArray(entry.capabilities),
  ].map((value) => value.trim().toLowerCase());
  return advertised.some(
    (value) =>
      value === "2" ||
      value === "v2" ||
      value === "protocol-v2" ||
      value === "federation-peer-v2" ||
      value === FEDERATION_PEER_PROTOCOL_DOMAIN,
  );
}

function readDirectoryIdentity(body: unknown): FederationPeerDirectoryIdentity | null {
  for (const entry of directoryEntryCandidates(body)) {
    const statusValue =
      typeof entry.trustState === "string"
        ? entry.trustState
        : typeof entry.status === "string"
          ? entry.status
          : "";
    const nodeId = typeof entry.nodeId === "string" ? entry.nodeId.trim() : "";
    if (!statusValue.trim() || !nodeId) {
      continue;
    }
    return {
      status: statusValue.trim().toLowerCase(),
      nodeId,
      handle: typeof entry.handle === "string" ? normalizeHandle(entry.handle) : undefined,
      nodeEndpoint:
        typeof entry.nodeEndpoint === "string"
          ? entry.nodeEndpoint.trim()
          : typeof entry.endpoint === "string"
            ? entry.endpoint.trim()
            : typeof entry.publicUrl === "string"
              ? entry.publicUrl.trim()
              : undefined,
      bondTier:
        entry.bondTier === "none" ||
        entry.bondTier === "basic-bond" ||
        entry.bondTier === "operator-bond"
          ? entry.bondTier
          : undefined,
      supportsProtocolV2: supportsFederationPeerProtocolV2(entry),
    };
  }
  return null;
}

export const lookupFederationPeerDirectory: FederationPeerDirectoryLookup = async (params) => {
  let url: URL;
  try {
    url = new URL(
      `/api/federation/directory/${encodeURIComponent(params.senderHandle)}`,
      params.baseUrl,
    );
  } catch {
    throw new Error("federation directory URL is invalid");
  }
  if (!isTrustedFederationPeerUrl(url)) {
    throw new Error(
      "federation directory must use HTTPS (plain HTTP is allowed only for an explicit loopback URL)",
    );
  }
  const headers: Record<string, string> = { accept: "application/json" };
  const apiToken = params.apiToken?.trim();
  if (apiToken) {
    headers.authorization = apiToken.toLowerCase().startsWith("bearer ")
      ? apiToken
      : `Bearer ${apiToken}`;
  }
  const response = await params.fetchImpl(url, {
    method: "GET",
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(DIRECTORY_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`federation directory lookup failed with HTTP ${response.status}`);
  }
  const responseText = (
    await readResponseWithLimit(response, MAX_DIRECTORY_RESPONSE_BYTES, {
      onOverflow: () => new Error("federation directory response is too large"),
    })
  ).toString("utf8");
  let body: unknown;
  try {
    body = JSON.parse(responseText) as unknown;
  } catch {
    throw new Error("federation directory response is not valid JSON");
  }
  const identity = readDirectoryIdentity(body);
  if (!identity) {
    throw new Error("federation directory response is missing status or nodeId");
  }
  return identity;
};

function resolveReplayStatePath(env: NodeJS.ProcessEnv): string {
  const explicit = env.FASED_FEDERATION_REPLAY_STATE_PATH?.trim();
  return explicit || path.join(resolveStateDir(env), "federation", "peer-replay-v2.json");
}

async function readReplayState(statePath: string): Promise<ReplayState> {
  try {
    const raw = await fs.readFile(statePath, "utf8");
    const value = JSON.parse(raw) as Partial<ReplayState>;
    if (
      value.version !== 2 ||
      !value.reservations ||
      typeof value.reservations !== "object" ||
      Array.isArray(value.reservations)
    ) {
      throw new Error("invalid replay state schema");
    }
    const reservations: Record<string, number> = {};
    for (const [key, expiresAtMs] of Object.entries(value.reservations)) {
      if (!/^[a-f0-9]{64}$/u.test(key) || !Number.isSafeInteger(expiresAtMs)) {
        throw new Error("invalid replay reservation");
      }
      reservations[key] = expiresAtMs;
    }
    return { version: 2, reservations };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 2, reservations: {} };
    }
    throw error;
  }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  try {
    const handle = await fs.open(directoryPath, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Some supported filesystems do not allow directory fsync. The state file
    // itself is still fsynced before the atomic rename.
  }
}

async function writeReplayState(statePath: string, state: ReplayState): Promise<void> {
  const directory = path.dirname(statePath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700).catch(() => undefined);
  const tmpPath = `${statePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const handle = await fs.open(tmpPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(state)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(tmpPath, statePath);
    await fs.chmod(statePath, 0o600);
    await syncDirectory(directory);
  } catch (error) {
    await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function inReplayReservationQueue<T>(fn: () => Promise<T>): Promise<T> {
  const previous = replayReservationQueue;
  let release: (() => void) | undefined;
  replayReservationQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release?.();
  }
}

export const reserveFederationPeerReplay: FederationPeerReplayReservation = async (params) => {
  const reservationKey = sha256Hex(
    canonicalizeFederationPeerJson({
      protocol: FEDERATION_PEER_PROTOCOL_DOMAIN,
      sender: normalizeHandle(params.senderHandle),
      nodeId: params.nodeId.toLowerCase(),
      nonce: params.nonce,
    }),
  );
  const statePath = resolveReplayStatePath(params.env);
  try {
    return await inReplayReservationQueue(
      async () =>
        await withFileLock(
          statePath,
          {
            retries: {
              retries: 20,
              factor: 1.25,
              minTimeout: 10,
              maxTimeout: 100,
              randomize: true,
            },
            stale: 30_000,
          },
          async () => {
            const state = await readReplayState(statePath);
            const reservations = Object.fromEntries(
              Object.entries(state.reservations).filter(
                ([, expiresAtMs]) =>
                  Number.isSafeInteger(expiresAtMs) && expiresAtMs > params.nowMs,
              ),
            );
            if (reservations[reservationKey]) {
              return { ok: false, reason: "replay" as const };
            }
            if (Object.keys(reservations).length >= MAX_REPLAY_RESERVATIONS) {
              return { ok: false, reason: "unavailable" as const };
            }
            reservations[reservationKey] =
              Math.max(params.nowMs, params.timestampMs) + DEFAULT_REPLAY_TTL_MS;
            await writeReplayState(statePath, { version: 2, reservations });
            return { ok: true } as const;
          },
        ),
    );
  } catch {
    return { ok: false, reason: "unavailable" };
  }
};

function rejectInvalid(reason: string): FederationPeerAuthorizationResult {
  return { ok: false, statusCode: 401, code: "peer_auth_invalid", reason };
}

export function checkFederationPeerIngressBudget(params: {
  clientIp?: string;
  rateLimiter?: Pick<AuthRateLimiter, "check" | "recordFailure">;
}): { ok: true } | FederationPeerRejection {
  const rateLimiter = params.rateLimiter ?? DEFAULT_INGRESS_RATE_LIMITER;
  const rateLimit = rateLimiter.check(params.clientIp, INGRESS_RATE_LIMIT_SCOPE);
  if (!rateLimit.allowed) {
    return {
      ok: false,
      statusCode: 429,
      code: "peer_auth_rate_limited",
      reason: "federation peer authentication rate limit exceeded",
      retryAfterMs: rateLimit.retryAfterMs,
    };
  }
  // This is a public-request budget, so every attempt is counted before any
  // body parsing, signature work, or directory request.
  rateLimiter.recordFailure(params.clientIp, INGRESS_RATE_LIMIT_SCOPE);
  return { ok: true };
}

export async function reserveAuthorizedFederationPeerRequest(params: {
  authorization: FederationPeerAuthorizedRequest;
  env?: NodeJS.ProcessEnv;
  deps?: Pick<FederationPeerVerifyDeps, "now" | "reserveReplay">;
}): Promise<FederationPeerAuthorizationResult> {
  const nowMs = params.deps?.now?.() ?? Date.now();
  const replay = await (params.deps?.reserveReplay ?? reserveFederationPeerReplay)({
    senderHandle: params.authorization.senderHandle,
    nodeId: params.authorization.nodeId,
    nonce: params.authorization.nonce,
    timestampMs: params.authorization.timestampMs,
    nowMs,
    env: params.env ?? process.env,
  });
  if (replay.ok) {
    return params.authorization;
  }
  if (replay.reason === "replay") {
    return {
      ok: false,
      statusCode: 409,
      code: "peer_auth_replay",
      reason: "federation peer request nonce was already used",
    };
  }
  return {
    ok: false,
    statusCode: 503,
    code: "peer_auth_replay_unavailable",
    reason: "federation peer replay state is unavailable",
  };
}

export async function authorizeFederationPeerRequestV2(params: {
  req: IncomingMessage;
  body: unknown;
  recipientHandle: string;
  expectedPath:
    | typeof FEDERATION_MARKETPLACE_ORDER_PATH
    | typeof FEDERATION_MARKETPLACE_DELIVERY_PATH
    | typeof FEDERATION_A2A_RPC_PATH;
  directoryBaseUrl: string;
  directoryApiToken?: string;
  clientIp?: string;
  env?: NodeJS.ProcessEnv;
  deps?: FederationPeerVerifyDeps;
  ingressBudgetApplied?: boolean;
  deferReplayReservation?: boolean;
}): Promise<FederationPeerAuthorizationResult> {
  const env = params.env ?? process.env;
  const nowMs = params.deps?.now?.() ?? Date.now();
  const clientIp = params.clientIp ?? params.req.socket?.remoteAddress;
  if (!params.ingressBudgetApplied) {
    const ingressBudget = checkFederationPeerIngressBudget({
      clientIp,
      rateLimiter: params.deps?.rateLimiter,
    });
    if (!ingressBudget.ok) {
      return ingressBudget;
    }
  }

  if (params.req.method !== "POST" || params.req.url !== params.expectedPath) {
    return rejectInvalid("federation peer request method or canonical path is invalid");
  }

  const protocolVersion = readSingleHeader(params.req, FEDERATION_PEER_HEADERS.protocolVersion);
  const senderHandle = normalizeHandle(
    readSingleHeader(params.req, FEDERATION_PEER_HEADERS.senderHandle),
  );
  const recipientHandle = normalizeHandle(
    readSingleHeader(params.req, FEDERATION_PEER_HEADERS.recipientHandle),
  );
  const timestampRaw = readSingleHeader(params.req, FEDERATION_PEER_HEADERS.timestamp);
  const nonce = readSingleHeader(params.req, FEDERATION_PEER_HEADERS.nonce);
  const claimedBodySha256 = readSingleHeader(params.req, FEDERATION_PEER_HEADERS.bodySha256);
  const publicKeyRaw = readSingleHeader(params.req, FEDERATION_PEER_HEADERS.publicKey);
  const signature = readSingleHeader(params.req, FEDERATION_PEER_HEADERS.signature);

  if (protocolVersion !== FEDERATION_PEER_PROTOCOL_VERSION) {
    return rejectInvalid("signed federation peer protocol v2 is required");
  }
  if (!senderHandle || senderHandle.length > 256) {
    return rejectInvalid("federation peer sender handle is invalid");
  }
  if (!recipientHandle || recipientHandle.length > 256) {
    return rejectInvalid("federation peer recipient handle is invalid");
  }
  if (recipientHandle !== normalizeHandle(params.recipientHandle)) {
    return rejectInvalid("federation peer recipient does not match this node");
  }
  if (!/^[0-9]{13}$/u.test(timestampRaw)) {
    return rejectInvalid("federation peer timestamp is invalid");
  }
  const timestampMs = Number(timestampRaw);
  if (
    !Number.isSafeInteger(timestampMs) ||
    Math.abs(nowMs - timestampMs) > FEDERATION_PEER_MAX_CLOCK_SKEW_MS
  ) {
    return {
      ok: false,
      statusCode: 401,
      code: "peer_auth_stale",
      reason: "federation peer request timestamp is outside the allowed clock skew",
    };
  }
  if (!/^[A-Za-z0-9_-]{16,128}$/u.test(nonce)) {
    return rejectInvalid("federation peer nonce is invalid");
  }
  if (!/^[a-f0-9]{64}$/u.test(claimedBodySha256)) {
    return rejectInvalid("federation peer body digest is invalid");
  }
  const canonicalBody = canonicalizeFederationPeerJson(params.body);
  const actualBodySha256 = sha256Hex(canonicalBody);
  if (claimedBodySha256 !== actualBodySha256) {
    return rejectInvalid("federation peer body digest does not match the request");
  }
  const publicKey = normalizeDevicePublicKeyBase64Url(publicKeyRaw);
  if (!publicKey || publicKey.length > 128 || !signature || signature.length > 128) {
    return rejectInvalid("federation peer signing key or signature is invalid");
  }
  const nodeId = deriveDeviceIdFromPublicKey(publicKey);
  if (!nodeId) {
    return rejectInvalid("federation peer signing key is invalid");
  }
  const signaturePayload = buildSignaturePayload({
    senderHandle,
    recipientHandle,
    method: "POST",
    path: params.expectedPath,
    timestampMs,
    nonce,
    bodySha256: claimedBodySha256,
    publicKey,
  });
  if (!verifyDeviceSignature(publicKey, signaturePayload, signature)) {
    return rejectInvalid("federation peer request signature is invalid");
  }

  const directoryBaseUrl = params.directoryBaseUrl.trim();
  if (!directoryBaseUrl) {
    return {
      ok: false,
      statusCode: 503,
      code: "peer_auth_directory_unavailable",
      reason: "federation directory is not configured",
    };
  }
  let directoryIdentity: FederationPeerDirectoryIdentity;
  try {
    directoryIdentity = await (params.deps?.directoryLookup ?? lookupFederationPeerDirectory)({
      senderHandle,
      baseUrl: directoryBaseUrl,
      apiToken: params.directoryApiToken,
      fetchImpl: params.deps?.fetchImpl ?? fetch,
    });
  } catch (error) {
    return {
      ok: false,
      statusCode: 503,
      code: "peer_auth_directory_unavailable",
      reason: error instanceof Error ? error.message : "federation directory lookup failed",
    };
  }
  if (
    directoryIdentity.status.trim().toLowerCase() !== "verified" ||
    directoryIdentity.nodeId.trim().toLowerCase() !== nodeId.toLowerCase() ||
    (directoryIdentity.handle && normalizeHandle(directoryIdentity.handle) !== senderHandle)
  ) {
    return {
      ok: false,
      statusCode: 401,
      code: "peer_auth_unverified",
      reason: "federation peer identity is not verified by the directory",
    };
  }

  const authorization: FederationPeerAuthorizedRequest = {
    ok: true,
    senderHandle,
    recipientHandle,
    nodeId,
    nonce,
    timestampMs,
    bodySha256: claimedBodySha256,
    ...(directoryIdentity.bondTier ? { bondTier: directoryIdentity.bondTier } : {}),
  };
  if (params.deferReplayReservation) {
    return authorization;
  }
  return await reserveAuthorizedFederationPeerRequest({
    authorization,
    env,
    deps: params.deps,
  });
}
