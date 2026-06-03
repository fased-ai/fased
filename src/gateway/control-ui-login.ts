import { createHash, createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { safeEqualSecret } from "../security/secret-equal.js";

const STORE_VERSION = 1;
const GRANT_PURPOSE = "control-ui-login";
const GRANT_CLOCK_SKEW_MS = 5 * 60 * 1000;
const CONSUMED_GRANT_GRACE_MS = 60_000;

export const CONTROL_UI_LOGIN_DEFAULT_GRANT_TTL_MS = 10 * 60 * 1000;
export const CONTROL_UI_LOGIN_DEFAULT_IDLE_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;
export const CONTROL_UI_LOGIN_DEFAULT_MAX_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

type LoginGrantClaims = {
  v: 1;
  purpose: typeof GRANT_PURPOSE;
  jti: string;
  iat: number;
  exp: number;
  host: string;
};

type StoredSession = {
  host: string;
  createdAtMs: number;
  lastSeenAtMs: number;
  idleTimeoutMs: number;
  maxLifetimeMs: number;
};

type LoginStateStore = {
  version: number;
  consumedGrantJti: Record<string, number>;
  sessions: Record<string, StoredSession>;
};

export type LoginGrantVerifyError =
  | "invalid_grant"
  | "expired_grant"
  | "host_mismatch"
  | "unsupported_grant";

export type LoginGrantVerifyResult =
  | { ok: true; claims: LoginGrantClaims }
  | { ok: false; code: LoginGrantVerifyError };

export type LoginGrantExchangeError =
  | "invalid_grant"
  | "expired_grant"
  | "host_mismatch"
  | "invalid_or_used_grant";

export type LoginGrantExchangeResult =
  | {
      ok: true;
      sessionToken: string;
      expiresAtMs: number;
      idleTimeoutMs: number;
    }
  | { ok: false; code: LoginGrantExchangeError };

export type SessionTokenAuthError =
  | "invalid_session_token"
  | "expired_session_token"
  | "invalid_session_host";

export type SessionTokenAuthResult =
  | {
      ok: true;
      expiresAtMs: number;
    }
  | {
      ok: false;
      code: SessionTokenAuthError;
    };

export type SessionTokenRevokeError = "invalid_session_token" | "invalid_session_host";

export type SessionTokenRevokeResult =
  | {
      ok: true;
    }
  | {
      ok: false;
      code: SessionTokenRevokeError;
    };

export type SessionTokenIssueResult =
  | {
      ok: true;
      sessionToken: string;
      expiresAtMs: number;
      idleTimeoutMs: number;
    }
  | {
      ok: false;
      code: "invalid_session_host";
    };

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function toBase64Url(raw: string): string {
  return Buffer.from(raw, "utf8").toString("base64url");
}

function fromBase64Url(raw: string): string | null {
  try {
    return Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

function parseHost(raw: string): { hostname: string; port: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const withScheme = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
    const parsed = new URL(withScheme);
    return { hostname: parsed.hostname.toLowerCase(), port: parsed.port };
  } catch {
    return null;
  }
}

export function normalizePublicHost(raw: string): string {
  const parsed = parseHost(raw);
  if (!parsed) {
    return "";
  }
  if (!parsed.port || parsed.port === "443") {
    return parsed.hostname;
  }
  return `${parsed.hostname}:${parsed.port}`;
}

function deriveSigningKey(gatewayToken: string): Buffer {
  return createHash("sha256").update("fased-control-ui-login-v1:").update(gatewayToken).digest();
}

function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function signGrantPayload(payload: string, gatewayToken: string): string {
  return createHmac("sha256", deriveSigningKey(gatewayToken)).update(payload).digest("base64url");
}

function buildEmptyState(): LoginStateStore {
  return {
    version: STORE_VERSION,
    consumedGrantJti: {},
    sessions: {},
  };
}

function normalizeClaims(input: unknown): LoginGrantClaims | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const val = input as Partial<LoginGrantClaims>;
  if (val.v !== 1 || val.purpose !== GRANT_PURPOSE) {
    return null;
  }
  if (
    typeof val.jti !== "string" ||
    typeof val.iat !== "number" ||
    typeof val.exp !== "number" ||
    typeof val.host !== "string"
  ) {
    return null;
  }
  const host = normalizePublicHost(val.host);
  if (!host || !Number.isFinite(val.iat) || !Number.isFinite(val.exp) || val.exp <= val.iat) {
    return null;
  }
  return {
    v: 1,
    purpose: GRANT_PURPOSE,
    jti: val.jti,
    iat: Math.floor(val.iat),
    exp: Math.floor(val.exp),
    host,
  };
}

function normalizeState(input: unknown): LoginStateStore {
  if (!input || typeof input !== "object") {
    return buildEmptyState();
  }
  const parsed = input as Partial<LoginStateStore>;
  if (parsed.version !== STORE_VERSION) {
    return buildEmptyState();
  }
  const consumedRaw =
    parsed.consumedGrantJti && typeof parsed.consumedGrantJti === "object"
      ? parsed.consumedGrantJti
      : {};
  const sessionsRaw = parsed.sessions && typeof parsed.sessions === "object" ? parsed.sessions : {};

  const consumedGrantJti: Record<string, number> = {};
  for (const [jti, exp] of Object.entries(consumedRaw)) {
    if (typeof jti !== "string" || !jti) {
      continue;
    }
    if (typeof exp !== "number" || !Number.isFinite(exp)) {
      continue;
    }
    consumedGrantJti[jti] = Math.floor(exp);
  }

  const sessions: Record<string, StoredSession> = {};
  for (const [tokenHash, session] of Object.entries(sessionsRaw)) {
    if (!tokenHash || typeof session !== "object" || !session) {
      continue;
    }
    const row = session as Partial<StoredSession>;
    const host = typeof row.host === "string" ? normalizePublicHost(row.host) : "";
    if (!host) {
      continue;
    }
    if (
      typeof row.createdAtMs !== "number" ||
      typeof row.lastSeenAtMs !== "number" ||
      typeof row.idleTimeoutMs !== "number" ||
      typeof row.maxLifetimeMs !== "number"
    ) {
      continue;
    }
    if (!Number.isFinite(row.createdAtMs) || !Number.isFinite(row.lastSeenAtMs)) {
      continue;
    }
    if (
      !Number.isFinite(row.idleTimeoutMs) ||
      row.idleTimeoutMs <= 0 ||
      !Number.isFinite(row.maxLifetimeMs) ||
      row.maxLifetimeMs <= 0
    ) {
      continue;
    }
    sessions[tokenHash] = {
      host,
      createdAtMs: Math.floor(row.createdAtMs),
      lastSeenAtMs: Math.floor(row.lastSeenAtMs),
      idleTimeoutMs: Math.floor(row.idleTimeoutMs),
      maxLifetimeMs: Math.floor(row.maxLifetimeMs),
    };
  }

  return {
    version: STORE_VERSION,
    consumedGrantJti,
    sessions,
  };
}

function resolveSessionExpiry(session: StoredSession): number {
  const idleExpiry = session.lastSeenAtMs + session.idleTimeoutMs;
  const absoluteExpiry = session.createdAtMs + session.maxLifetimeMs;
  return Math.min(idleExpiry, absoluteExpiry);
}

function pruneState(state: LoginStateStore, nowMs: number): boolean {
  let changed = false;
  for (const [jti, exp] of Object.entries(state.consumedGrantJti)) {
    if (exp + CONSUMED_GRANT_GRACE_MS < nowMs) {
      delete state.consumedGrantJti[jti];
      changed = true;
    }
  }
  for (const [tokenHash, session] of Object.entries(state.sessions)) {
    if (resolveSessionExpiry(session) <= nowMs) {
      delete state.sessions[tokenHash];
      changed = true;
    }
  }
  return changed;
}

export function resolveControlUiLoginStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "control-ui-login.json");
}

export function createLoginGrant(params: {
  gatewayToken: string;
  host: string;
  nowMs?: number;
  ttlMs?: number;
}): string {
  const gatewayToken = params.gatewayToken.trim();
  if (!gatewayToken) {
    throw new Error("gateway token is required to create login grants");
  }
  const host = normalizePublicHost(params.host);
  if (!host) {
    throw new Error("public host is required for login grant creation");
  }
  const nowMs = params.nowMs ?? Date.now();
  const ttlMs = Math.max(1, Math.floor(params.ttlMs ?? CONTROL_UI_LOGIN_DEFAULT_GRANT_TTL_MS));
  const claims: LoginGrantClaims = {
    v: 1,
    purpose: GRANT_PURPOSE,
    jti: randomBytes(16).toString("hex"),
    iat: nowMs,
    exp: nowMs + ttlMs,
    host,
  };
  const payload = JSON.stringify(claims);
  const payloadEncoded = toBase64Url(payload);
  const signature = signGrantPayload(payload, gatewayToken);
  return `${payloadEncoded}.${signature}`;
}

export function verifyLoginGrant(params: {
  grant: string;
  gatewayToken: string;
  host: string;
  nowMs?: number;
}): LoginGrantVerifyResult {
  const nowMs = params.nowMs ?? Date.now();
  const host = normalizePublicHost(params.host);
  const gatewayToken = params.gatewayToken.trim();
  if (!host || !gatewayToken) {
    return { ok: false, code: "invalid_grant" };
  }

  const grantRaw = params.grant.trim();
  const firstDot = grantRaw.indexOf(".");
  if (firstDot <= 0 || firstDot === grantRaw.length - 1) {
    return { ok: false, code: "invalid_grant" };
  }
  const payloadEncoded = grantRaw.slice(0, firstDot);
  const signature = grantRaw.slice(firstDot + 1);
  const payloadJson = fromBase64Url(payloadEncoded);
  if (!payloadJson) {
    return { ok: false, code: "invalid_grant" };
  }
  const expectedSignature = signGrantPayload(payloadJson, gatewayToken);
  if (!safeEqualSecret(signature, expectedSignature)) {
    return { ok: false, code: "invalid_grant" };
  }
  const claims = normalizeClaims(safeJsonParse(payloadJson));
  if (!claims) {
    return { ok: false, code: "unsupported_grant" };
  }
  if (claims.host !== host) {
    return { ok: false, code: "host_mismatch" };
  }
  if (claims.iat - GRANT_CLOCK_SKEW_MS > nowMs || claims.exp <= nowMs) {
    return { ok: false, code: "expired_grant" };
  }
  return { ok: true, claims };
}

export class ControlUiLoginService {
  private readonly statePath: string;
  private readonly gatewayToken: string;
  private readonly idleTimeoutMs: number;
  private readonly maxLifetimeMs: number;
  private state: LoginStateStore | null = null;

  constructor(params: {
    gatewayToken: string;
    statePath?: string;
    idleTimeoutMs?: number;
    maxLifetimeMs?: number;
    env?: NodeJS.ProcessEnv;
  }) {
    const gatewayToken = params.gatewayToken.trim();
    if (!gatewayToken) {
      throw new Error("gateway token is required for control-ui login service");
    }
    this.gatewayToken = gatewayToken;
    this.statePath = params.statePath ?? resolveControlUiLoginStatePath(params.env);
    this.idleTimeoutMs = Math.max(
      1,
      Math.floor(params.idleTimeoutMs ?? CONTROL_UI_LOGIN_DEFAULT_IDLE_TIMEOUT_MS),
    );
    this.maxLifetimeMs = Math.max(
      this.idleTimeoutMs,
      Math.floor(params.maxLifetimeMs ?? CONTROL_UI_LOGIN_DEFAULT_MAX_LIFETIME_MS),
    );
  }

  createLoginGrant(params: { host: string; ttlMs?: number; nowMs?: number }): string {
    return createLoginGrant({
      gatewayToken: this.gatewayToken,
      host: params.host,
      ttlMs: params.ttlMs,
      nowMs: params.nowMs,
    });
  }

  exchangeGrant(params: { grant: string; host: string; nowMs?: number }): LoginGrantExchangeResult {
    const nowMs = params.nowMs ?? Date.now();
    const state = this.loadState(nowMs);
    const verified = verifyLoginGrant({
      grant: params.grant,
      gatewayToken: this.gatewayToken,
      host: params.host,
      nowMs,
    });
    if (!verified.ok) {
      if (verified.code === "expired_grant") {
        return { ok: false, code: "expired_grant" };
      }
      if (verified.code === "host_mismatch") {
        return { ok: false, code: "host_mismatch" };
      }
      return { ok: false, code: "invalid_grant" };
    }

    const existing = state.consumedGrantJti[verified.claims.jti];
    if (typeof existing === "number" && existing >= nowMs) {
      return { ok: false, code: "invalid_or_used_grant" };
    }

    state.consumedGrantJti[verified.claims.jti] = verified.claims.exp;
    return this.createSession({ host: verified.claims.host, nowMs });
  }

  issueSession(params: { host: string; nowMs?: number }): SessionTokenIssueResult {
    const host = normalizePublicHost(params.host);
    if (!host) {
      return { ok: false, code: "invalid_session_host" };
    }
    return this.createSession({ host, nowMs: params.nowMs ?? Date.now() });
  }

  authorizeSessionToken(params: {
    token: string;
    host: string;
    nowMs?: number;
  }): SessionTokenAuthResult {
    const token = params.token.trim();
    if (!token) {
      return { ok: false, code: "invalid_session_token" };
    }
    const host = normalizePublicHost(params.host);
    if (!host) {
      return { ok: false, code: "invalid_session_host" };
    }
    const nowMs = params.nowMs ?? Date.now();
    const state = this.loadState(nowMs);
    const tokenHash = hashSessionToken(token);
    const session = state.sessions[tokenHash];
    if (!session) {
      return { ok: false, code: "invalid_session_token" };
    }
    if (session.host !== host) {
      return { ok: false, code: "invalid_session_host" };
    }
    const expiresAtMs = resolveSessionExpiry(session);
    if (expiresAtMs <= nowMs) {
      delete state.sessions[tokenHash];
      this.persistState();
      return { ok: false, code: "expired_session_token" };
    }
    session.lastSeenAtMs = nowMs;
    this.persistState();
    return {
      ok: true,
      expiresAtMs: resolveSessionExpiry(session),
    };
  }

  revokeSessionToken(params: {
    token: string;
    host: string;
    nowMs?: number;
  }): SessionTokenRevokeResult {
    const token = params.token.trim();
    if (!token) {
      return { ok: false, code: "invalid_session_token" };
    }
    const host = normalizePublicHost(params.host);
    if (!host) {
      return { ok: false, code: "invalid_session_host" };
    }
    const nowMs = params.nowMs ?? Date.now();
    const state = this.loadState(nowMs);
    const tokenHash = hashSessionToken(token);
    const session = state.sessions[tokenHash];
    if (!session) {
      return { ok: false, code: "invalid_session_token" };
    }
    if (session.host !== host) {
      return { ok: false, code: "invalid_session_host" };
    }
    delete state.sessions[tokenHash];
    this.persistState();
    return { ok: true };
  }

  private createSession(params: { host: string; nowMs: number }): {
    ok: true;
    sessionToken: string;
    expiresAtMs: number;
    idleTimeoutMs: number;
  } {
    const state = this.loadState(params.nowMs);
    const sessionToken = randomBytes(32).toString("base64url");
    const tokenHash = hashSessionToken(sessionToken);
    state.sessions[tokenHash] = {
      host: params.host,
      createdAtMs: params.nowMs,
      lastSeenAtMs: params.nowMs,
      idleTimeoutMs: this.idleTimeoutMs,
      maxLifetimeMs: this.maxLifetimeMs,
    };
    const expiresAtMs = resolveSessionExpiry(state.sessions[tokenHash]);
    this.persistState();
    return {
      ok: true,
      sessionToken,
      expiresAtMs,
      idleTimeoutMs: this.idleTimeoutMs,
    };
  }

  private loadState(nowMs: number): LoginStateStore {
    if (!this.state) {
      this.state = this.readState();
    }
    const pruned = pruneState(this.state, nowMs);
    if (pruned) {
      this.persistState();
    }
    return this.state;
  }

  private readState(): LoginStateStore {
    try {
      if (!fs.existsSync(this.statePath)) {
        return buildEmptyState();
      }
      const raw = fs.readFileSync(this.statePath, "utf8");
      return normalizeState(safeJsonParse(raw));
    } catch {
      return buildEmptyState();
    }
  }

  private persistState(): void {
    if (!this.state) {
      return;
    }
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    const tmpPath = `${this.statePath}.${process.pid}.${Date.now()}.tmp`;
    const body = `${JSON.stringify(this.state, null, 2)}\n`;
    fs.writeFileSync(tmpPath, body, { mode: 0o600 });
    fs.renameSync(tmpPath, this.statePath);
    try {
      fs.chmodSync(this.statePath, 0o600);
    } catch {
      // best-effort
    }
  }
}
