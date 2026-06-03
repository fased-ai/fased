import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FasedAgentConfig } from "../config/types.fased.js";
import { ensureWalletStateDir } from "./wallet-runtime-config.js";

export type WalletApprovalAuthMode = "none" | "webauthn";

export type WalletPasskeyMetadata = {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt?: string;
};

type WalletPasskeyRecord = WalletPasskeyMetadata & {
  publicKeySpki: string;
  publicKeyAlgorithm: number;
  signCount: number;
  transports?: string[];
};

type WalletApprovalChallengeRecord = {
  id: string;
  kind: "register" | "assert";
  challenge: string;
  host: string;
  rpId: string;
  operation?: string;
  requestId?: string;
  label?: string;
  createdAt: string;
  expiresAt: string;
  status: "pending" | "consumed" | "expired";
};

type WalletApprovalGrantRecord = {
  tokenHash: string;
  host: string;
  operation: string;
  requestId?: string;
  createdAt: string;
  expiresAt: string;
};

type WalletApprovalAuthState = {
  version: 2;
  passkeys: WalletPasskeyRecord[];
  challenges: WalletApprovalChallengeRecord[];
  grants: WalletApprovalGrantRecord[];
};

const DEFAULT_CHALLENGE_TTL_SECONDS = 300;
const MAX_CHALLENGE_TTL_SECONDS = 3600;
const DEFAULT_APPROVAL_GRANT_TTL_SECONDS = 120;
const MAX_APPROVAL_GRANT_TTL_SECONDS = 900;

function nowMs(): number {
  return Date.now();
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function base64UrlToBytes(value: string): Uint8Array | null {
  try {
    return new Uint8Array(Buffer.from(value, "base64url"));
  } catch {
    return null;
  }
}

function resolveStatePath(env: NodeJS.ProcessEnv = process.env): string {
  const walletPaths = ensureWalletStateDir(env);
  return path.join(walletPaths.rootDir, "wallet-approval-auth.json");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function resolveChallengeTtlSeconds(ttlSeconds?: number): number {
  if (typeof ttlSeconds !== "number" || !Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    return DEFAULT_CHALLENGE_TTL_SECONDS;
  }
  return Math.min(MAX_CHALLENGE_TTL_SECONDS, Math.max(30, Math.floor(ttlSeconds)));
}

function resolveGrantTtlSeconds(raw?: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_APPROVAL_GRANT_TTL_SECONDS;
  }
  return Math.min(MAX_APPROVAL_GRANT_TTL_SECONDS, Math.max(30, Math.floor(raw)));
}

function normalizeHost(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  try {
    const withScheme = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
    const parsed = new URL(withScheme);
    const hostname = parsed.hostname.toLowerCase();
    if (!parsed.port || parsed.port === "443") {
      return hostname;
    }
    return `${hostname}:${parsed.port}`;
  } catch {
    return "";
  }
}

function rpIdFromHost(host: string): string {
  const normalized = normalizeHost(host);
  if (!normalized) {
    return "";
  }
  if (!normalized.includes(":")) {
    return normalized;
  }
  try {
    const parsed = new URL(`https://${normalized}`);
    return parsed.hostname.toLowerCase();
  } catch {
    return normalized.split(":")[0] ?? "";
  }
}

function normalizeState(input: unknown): WalletApprovalAuthState {
  if (!input || typeof input !== "object") {
    return { version: 2, passkeys: [], challenges: [], grants: [] };
  }
  const parsed = input as Partial<WalletApprovalAuthState> & {
    version?: number;
    passkeys?: unknown;
    challenges?: unknown;
    grants?: unknown;
  };
  if (parsed.version !== 2) {
    return { version: 2, passkeys: [], challenges: [], grants: [] };
  }
  const passkeys: WalletPasskeyRecord[] = Array.isArray(parsed.passkeys)
    ? (parsed.passkeys
        .map((entry) => {
          if (!entry || typeof entry !== "object") {
            return null;
          }
          const value = entry as Partial<WalletPasskeyRecord>;
          if (
            typeof value.id !== "string" ||
            !value.id ||
            typeof value.label !== "string" ||
            !value.label ||
            typeof value.createdAt !== "string" ||
            !value.createdAt ||
            typeof value.publicKeySpki !== "string" ||
            !value.publicKeySpki ||
            typeof value.publicKeyAlgorithm !== "number"
          ) {
            return null;
          }
          return {
            id: value.id,
            label: value.label,
            createdAt: value.createdAt,
            lastUsedAt: typeof value.lastUsedAt === "string" ? value.lastUsedAt : undefined,
            publicKeySpki: value.publicKeySpki,
            publicKeyAlgorithm: Math.floor(value.publicKeyAlgorithm),
            signCount: Number.isFinite(value.signCount)
              ? Math.max(0, Math.floor(value.signCount!))
              : 0,
            transports: Array.isArray(value.transports)
              ? value.transports.map((v) => String(v))
              : undefined,
          } satisfies WalletPasskeyRecord;
        })
        .filter((entry) => entry !== null) as WalletPasskeyRecord[])
    : [];

  const challenges: WalletApprovalChallengeRecord[] = Array.isArray(parsed.challenges)
    ? (parsed.challenges
        .map((entry) => {
          if (!entry || typeof entry !== "object") {
            return null;
          }
          const value = entry as Partial<WalletApprovalChallengeRecord>;
          if (
            typeof value.id !== "string" ||
            typeof value.kind !== "string" ||
            typeof value.challenge !== "string" ||
            typeof value.host !== "string" ||
            typeof value.rpId !== "string" ||
            typeof value.createdAt !== "string" ||
            typeof value.expiresAt !== "string" ||
            typeof value.status !== "string"
          ) {
            return null;
          }
          if (value.kind !== "register" && value.kind !== "assert") {
            return null;
          }
          if (
            value.status !== "pending" &&
            value.status !== "consumed" &&
            value.status !== "expired"
          ) {
            return null;
          }
          return {
            id: value.id,
            kind: value.kind,
            challenge: value.challenge,
            host: normalizeHost(value.host),
            rpId: value.rpId.toLowerCase(),
            operation: typeof value.operation === "string" ? value.operation : undefined,
            requestId: typeof value.requestId === "string" ? value.requestId : undefined,
            label: typeof value.label === "string" ? value.label : undefined,
            createdAt: value.createdAt,
            expiresAt: value.expiresAt,
            status: value.status,
          } satisfies WalletApprovalChallengeRecord;
        })
        .filter((entry) => entry !== null) as WalletApprovalChallengeRecord[])
    : [];

  const grants: WalletApprovalGrantRecord[] = Array.isArray(parsed.grants)
    ? (parsed.grants
        .map((entry) => {
          if (!entry || typeof entry !== "object") {
            return null;
          }
          const value = entry as Partial<WalletApprovalGrantRecord>;
          if (
            typeof value.tokenHash !== "string" ||
            !value.tokenHash ||
            typeof value.host !== "string" ||
            !value.host ||
            typeof value.operation !== "string" ||
            !value.operation ||
            typeof value.createdAt !== "string" ||
            typeof value.expiresAt !== "string"
          ) {
            return null;
          }
          return {
            tokenHash: value.tokenHash,
            host: normalizeHost(value.host),
            operation: value.operation,
            requestId: typeof value.requestId === "string" ? value.requestId : undefined,
            createdAt: value.createdAt,
            expiresAt: value.expiresAt,
          } satisfies WalletApprovalGrantRecord;
        })
        .filter((entry) => entry !== null) as WalletApprovalGrantRecord[])
    : [];

  return { version: 2, passkeys, challenges, grants };
}

function loadState(env: NodeJS.ProcessEnv = process.env): WalletApprovalAuthState {
  const statePath = resolveStatePath(env);
  if (!fs.existsSync(statePath)) {
    return { version: 2, passkeys: [], challenges: [], grants: [] };
  }
  try {
    const raw = fs.readFileSync(statePath, "utf8");
    return normalizeState(JSON.parse(raw) as unknown);
  } catch {
    return { version: 2, passkeys: [], challenges: [], grants: [] };
  }
}

function saveState(state: WalletApprovalAuthState, env: NodeJS.ProcessEnv = process.env): void {
  const statePath = resolveStatePath(env);
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    fs.chmodSync(statePath, 0o600);
  } catch {
    // best effort
  }
}

function pruneState(state: WalletApprovalAuthState): boolean {
  const now = nowMs();
  let changed = false;
  for (const challenge of state.challenges) {
    if (challenge.status !== "pending") {
      continue;
    }
    const expiresAt = Date.parse(challenge.expiresAt);
    if (Number.isFinite(expiresAt) && expiresAt <= now) {
      challenge.status = "expired";
      changed = true;
    }
  }
  const beforeChallenges = state.challenges.length;
  state.challenges = state.challenges.filter((challenge) => {
    if (challenge.status === "pending") {
      return true;
    }
    const createdAt = Date.parse(challenge.createdAt);
    if (!Number.isFinite(createdAt)) {
      return false;
    }
    return now - createdAt < 24 * 60 * 60 * 1000;
  });
  if (state.challenges.length !== beforeChallenges) {
    changed = true;
  }

  const beforeGrants = state.grants.length;
  state.grants = state.grants.filter((grant) => {
    const expiresAt = Date.parse(grant.expiresAt);
    return Number.isFinite(expiresAt) && expiresAt > now;
  });
  if (state.grants.length !== beforeGrants) {
    changed = true;
  }
  return changed;
}

function decodeClientData(clientDataJsonBase64Url: string): {
  type: string;
  challenge: string;
  origin: string;
} | null {
  const bytes = base64UrlToBytes(clientDataJsonBase64Url);
  if (!bytes) {
    return null;
  }
  try {
    const json = JSON.parse(Buffer.from(bytes).toString("utf8")) as {
      type?: unknown;
      challenge?: unknown;
      origin?: unknown;
    };
    if (
      typeof json.type !== "string" ||
      typeof json.challenge !== "string" ||
      typeof json.origin !== "string"
    ) {
      return null;
    }
    return { type: json.type, challenge: json.challenge, origin: json.origin };
  } catch {
    return null;
  }
}

function parseAuthenticatorData(authenticatorDataBase64Url: string): {
  rpIdHash: Uint8Array;
  flags: number;
  signCount: number;
  raw: Uint8Array;
} | null {
  const raw = base64UrlToBytes(authenticatorDataBase64Url);
  if (!raw || raw.length < 37) {
    return null;
  }
  return {
    rpIdHash: raw.slice(0, 32),
    flags: raw[32] ?? 0,
    signCount:
      ((raw[33] ?? 0) << 24) | ((raw[34] ?? 0) << 16) | ((raw[35] ?? 0) << 8) | (raw[36] ?? 0),
    raw,
  };
}

function rpIdHashMatches(rpId: string, actualHash: Uint8Array): boolean {
  const expected = createHash("sha256").update(rpId).digest();
  if (expected.length !== actualHash.length) {
    return false;
  }
  return timingSafeEqual(expected, Buffer.from(actualHash));
}

function challengeMatches(expected: string, actual: string): boolean {
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
  } catch {
    return false;
  }
}

function originMatchesHost(origin: string, host: string): boolean {
  const originHost = normalizeHost(origin);
  if (!originHost || !host) {
    return false;
  }
  return originHost === host;
}

function assertUpUv(flags: number): { ok: boolean; reason?: string } {
  const up = (flags & 0x01) !== 0;
  const uv = (flags & 0x04) !== 0;
  if (!up) {
    return { ok: false, reason: "user presence flag missing" };
  }
  if (!uv) {
    return { ok: false, reason: "user verification flag missing" };
  }
  return { ok: true };
}

function verifyAssertionSignature(params: {
  passkey: WalletPasskeyRecord;
  authenticatorDataRaw: Uint8Array;
  clientDataJsonBase64Url: string;
  signatureBase64Url: string;
}): boolean {
  const signature = base64UrlToBytes(params.signatureBase64Url);
  const clientData = base64UrlToBytes(params.clientDataJsonBase64Url);
  if (!signature || !clientData) {
    return false;
  }
  const clientHash = createHash("sha256").update(Buffer.from(clientData)).digest();
  const signedData = Buffer.concat([Buffer.from(params.authenticatorDataRaw), clientHash]);
  try {
    const key = createPublicKey({
      key: Buffer.from(params.passkey.publicKeySpki, "base64url"),
      format: "der",
      type: "spki",
    });
    if (params.passkey.publicKeyAlgorithm === -8) {
      return verify(null, signedData, key, Buffer.from(signature));
    }
    return verify("sha256", signedData, key, Buffer.from(signature));
  } catch {
    return false;
  }
}

export function resolveWalletApprovalAuthMode(
  env: NodeJS.ProcessEnv = process.env,
  cfg?: FasedAgentConfig,
): WalletApprovalAuthMode {
  const fromConfig = cfg?.wallet?.approvalAuth?.mode;
  if (fromConfig === "webauthn") {
    return "webauthn";
  }
  if (fromConfig === "none") {
    return "none";
  }
  const raw = String(env.FASED_WALLET_APPROVAL_AUTH ?? "")
    .trim()
    .toLowerCase();
  if (raw === "webauthn") {
    return "webauthn";
  }
  return "none";
}

function resolveChallengeTtlFromConfigOrEnv(
  env: NodeJS.ProcessEnv = process.env,
  cfg?: FasedAgentConfig,
): number {
  const fromConfig = cfg?.wallet?.approvalAuth?.challengeTtlSeconds;
  if (typeof fromConfig === "number" && Number.isFinite(fromConfig)) {
    return resolveChallengeTtlSeconds(fromConfig);
  }
  const raw = Number.parseInt(String(env.FASED_WALLET_APPROVAL_CHALLENGE_TTL_SECONDS ?? ""), 10);
  return resolveChallengeTtlSeconds(raw);
}

function resolveGrantTtlFromConfigOrEnv(
  env: NodeJS.ProcessEnv = process.env,
  cfg?: FasedAgentConfig,
): number {
  const fromConfig = cfg?.wallet?.approvalAuth?.grantTtlSeconds;
  if (typeof fromConfig === "number" && Number.isFinite(fromConfig)) {
    return resolveGrantTtlSeconds(fromConfig);
  }
  const raw = Number.parseInt(String(env.FASED_WALLET_APPROVAL_GRANT_TTL_SECONDS ?? ""), 10);
  return resolveGrantTtlSeconds(raw);
}

export function resolveWalletApprovalChallengeTtlSeconds(
  env: NodeJS.ProcessEnv = process.env,
  cfg?: FasedAgentConfig,
): number {
  return resolveChallengeTtlFromConfigOrEnv(env, cfg);
}

export function resolveWalletApprovalGrantTtlSeconds(
  env: NodeJS.ProcessEnv = process.env,
  cfg?: FasedAgentConfig,
): number {
  return resolveGrantTtlFromConfigOrEnv(env, cfg);
}

export type WalletApprovalAuthSnapshot = {
  mode: WalletApprovalAuthMode;
  passkeyCount: number;
  ready: boolean;
  notes: string[];
  passkeys: WalletPasskeyMetadata[];
  statePath: string;
};

export function readWalletApprovalAuthSnapshot(
  env: NodeJS.ProcessEnv = process.env,
  cfg?: FasedAgentConfig,
): WalletApprovalAuthSnapshot {
  const mode = resolveWalletApprovalAuthMode(env, cfg);
  const state = loadState(env);
  const changed = pruneState(state);
  if (changed) {
    saveState(state, env);
  }
  const passkeys = state.passkeys.map((entry) => ({
    id: entry.id,
    label: entry.label,
    createdAt: entry.createdAt,
    lastUsedAt: entry.lastUsedAt,
  }));
  const notes: string[] = [];
  if (mode === "none") {
    notes.push("approval auth mode disabled");
  } else if (passkeys.length === 0) {
    notes.push("WebAuthn passkey mode is enabled but no passkeys are registered yet");
    notes.push(
      "sensitive wallet approvals are blocked until a passkey is enrolled or mode is disabled",
    );
  } else {
    notes.push(
      "WebAuthn passkey verification is required for send/approve/reset/rotate/execution-mode",
    );
  }
  return {
    mode,
    passkeyCount: passkeys.length,
    ready: mode === "none" ? true : passkeys.length > 0,
    notes,
    passkeys,
    statePath: resolveStatePath(env),
  };
}

export function beginWalletPasskeyRegistration(params: {
  host: string;
  label?: string;
  env?: NodeJS.ProcessEnv;
  cfg?: FasedAgentConfig;
}) {
  const env = params.env ?? process.env;
  const mode = resolveWalletApprovalAuthMode(env, params.cfg);
  if (mode !== "webauthn") {
    return {
      ok: false as const,
      code: "approval_auth_disabled",
      message: "wallet approval auth mode is disabled",
    };
  }
  const host = normalizeHost(params.host);
  const rpId = rpIdFromHost(host);
  if (!host || !rpId) {
    return { ok: false as const, code: "invalid_host", message: "invalid host for passkey rpId" };
  }
  const state = loadState(env);
  if (pruneState(state)) {
    saveState(state, env);
  }

  const challenge = bytesToBase64Url(randomBytes(32));
  const challengeId = randomBytes(12).toString("hex");
  const userId = bytesToBase64Url(randomBytes(16));
  const now = nowMs();
  const ttlSeconds = resolveChallengeTtlFromConfigOrEnv(env, params.cfg);
  const label = params.label?.trim() || "Wallet Operator";
  const record: WalletApprovalChallengeRecord = {
    id: challengeId,
    kind: "register",
    challenge,
    host,
    rpId,
    label,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlSeconds * 1000).toISOString(),
    status: "pending",
  };
  state.challenges.push(record);
  saveState(state, env);

  return {
    ok: true as const,
    challengeId,
    challengeTtlSeconds: ttlSeconds,
    options: {
      challenge,
      rp: {
        id: rpId,
        name: "FasedAgent Wallet",
      },
      user: {
        id: userId,
        name: `wallet@${rpId}`,
        displayName: label,
      },
      pubKeyCredParams: [
        { type: "public-key" as const, alg: -7 },
        { type: "public-key" as const, alg: -257 },
      ],
      timeoutMs: 60_000,
      attestation: "none" as const,
      authenticatorSelection: {
        residentKey: "preferred" as const,
        userVerification: "required" as const,
      },
      excludeCredentialIds: state.passkeys.map((entry) => entry.id),
    },
  };
}

export function finishWalletPasskeyRegistration(params: {
  host: string;
  challengeId: string;
  credentialId: string;
  clientDataJSON: string;
  authenticatorData: string;
  publicKeySpki: string;
  publicKeyAlgorithm: number;
  transports?: string[];
  env?: NodeJS.ProcessEnv;
  cfg?: FasedAgentConfig;
}) {
  const env = params.env ?? process.env;
  const mode = resolveWalletApprovalAuthMode(env, params.cfg);
  if (mode !== "webauthn") {
    return {
      ok: false as const,
      code: "approval_auth_disabled",
      message: "wallet approval auth mode is disabled",
    };
  }
  const host = normalizeHost(params.host);
  const state = loadState(env);
  if (pruneState(state)) {
    saveState(state, env);
  }
  const challenge = state.challenges.find(
    (entry) =>
      entry.kind === "register" &&
      entry.status === "pending" &&
      entry.id === params.challengeId &&
      entry.host === host,
  );
  if (!challenge) {
    return {
      ok: false as const,
      code: "invalid_challenge",
      message: "registration challenge not found or expired",
    };
  }
  const clientData = decodeClientData(params.clientDataJSON);
  if (!clientData) {
    return { ok: false as const, code: "invalid_client_data", message: "invalid clientDataJSON" };
  }
  if (clientData.type !== "webauthn.create") {
    return { ok: false as const, code: "invalid_client_type", message: "expected webauthn.create" };
  }
  if (!challengeMatches(challenge.challenge, clientData.challenge)) {
    return {
      ok: false as const,
      code: "challenge_mismatch",
      message: "registration challenge mismatch",
    };
  }
  if (!originMatchesHost(clientData.origin, challenge.host)) {
    return { ok: false as const, code: "origin_mismatch", message: "registration origin mismatch" };
  }
  const authData = parseAuthenticatorData(params.authenticatorData);
  if (!authData) {
    return {
      ok: false as const,
      code: "invalid_authenticator_data",
      message: "invalid authenticator data",
    };
  }
  if (!rpIdHashMatches(challenge.rpId, authData.rpIdHash)) {
    return { ok: false as const, code: "rp_id_mismatch", message: "rpId hash mismatch" };
  }
  const upUv = assertUpUv(authData.flags);
  if (!upUv.ok) {
    return {
      ok: false as const,
      code: "verification_required",
      message: upUv.reason ?? "uv required",
    };
  }
  if (!base64UrlToBytes(params.credentialId)) {
    return { ok: false as const, code: "invalid_credential_id", message: "invalid credential id" };
  }
  if (!base64UrlToBytes(params.publicKeySpki)) {
    return { ok: false as const, code: "invalid_public_key", message: "invalid public key spki" };
  }

  const nowIso = new Date().toISOString();
  const credentialId = params.credentialId.trim();
  const existingIdx = state.passkeys.findIndex((entry) => entry.id === credentialId);
  const label = challenge.label?.trim() || "Wallet Operator";
  const record: WalletPasskeyRecord = {
    id: credentialId,
    label,
    createdAt: existingIdx >= 0 ? state.passkeys[existingIdx].createdAt : nowIso,
    lastUsedAt: nowIso,
    publicKeySpki: params.publicKeySpki.trim(),
    publicKeyAlgorithm: Math.floor(params.publicKeyAlgorithm || -7),
    signCount: authData.signCount,
    transports: Array.isArray(params.transports)
      ? params.transports.map((value) => String(value).trim()).filter(Boolean)
      : undefined,
  };
  if (existingIdx >= 0) {
    state.passkeys[existingIdx] = record;
  } else {
    state.passkeys.push(record);
  }
  challenge.status = "consumed";
  saveState(state, env);
  return {
    ok: true as const,
    passkey: {
      id: record.id,
      label: record.label,
      createdAt: record.createdAt,
      lastUsedAt: record.lastUsedAt,
    } satisfies WalletPasskeyMetadata,
    snapshot: readWalletApprovalAuthSnapshot(env, params.cfg),
  };
}

export function beginWalletApprovalAssertion(params: {
  host: string;
  operation: string;
  requestId?: string;
  env?: NodeJS.ProcessEnv;
  cfg?: FasedAgentConfig;
}) {
  const env = params.env ?? process.env;
  const mode = resolveWalletApprovalAuthMode(env, params.cfg);
  if (mode !== "webauthn") {
    return {
      ok: false as const,
      code: "approval_auth_disabled",
      message: "wallet approval auth mode is disabled",
    };
  }
  const host = normalizeHost(params.host);
  const rpId = rpIdFromHost(host);
  if (!host || !rpId) {
    return { ok: false as const, code: "invalid_host", message: "invalid host for passkey rpId" };
  }
  const state = loadState(env);
  if (pruneState(state)) {
    saveState(state, env);
  }
  if (state.passkeys.length === 0) {
    return {
      ok: false as const,
      code: "webauthn_not_ready",
      message: "no passkeys registered",
    };
  }
  const challenge = bytesToBase64Url(randomBytes(32));
  const challengeId = randomBytes(12).toString("hex");
  const ttlSeconds = resolveChallengeTtlFromConfigOrEnv(env, params.cfg);
  const now = nowMs();
  state.challenges.push({
    id: challengeId,
    kind: "assert",
    challenge,
    host,
    rpId,
    operation: params.operation.trim(),
    requestId: params.requestId?.trim() || undefined,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlSeconds * 1000).toISOString(),
    status: "pending",
  });
  saveState(state, env);
  return {
    ok: true as const,
    challengeId,
    challengeTtlSeconds: ttlSeconds,
    options: {
      challenge,
      rpId,
      timeoutMs: 60_000,
      userVerification: "required" as const,
      allowCredentialIds: state.passkeys.map((entry) => entry.id),
    },
  };
}

function issueApprovalGrant(params: {
  state: WalletApprovalAuthState;
  host: string;
  operation: string;
  requestId?: string;
  env: NodeJS.ProcessEnv;
  cfg?: FasedAgentConfig;
}) {
  const ttlSeconds = resolveGrantTtlFromConfigOrEnv(params.env, params.cfg);
  const token = bytesToBase64Url(randomBytes(32));
  const now = nowMs();
  params.state.grants.push({
    tokenHash: hashToken(token),
    host: normalizeHost(params.host),
    operation: params.operation,
    requestId: params.requestId?.trim() || undefined,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlSeconds * 1000).toISOString(),
  });
  return {
    token,
    expiresAt: new Date(now + ttlSeconds * 1000).toISOString(),
    ttlSeconds,
  };
}

export function finishWalletApprovalAssertion(params: {
  host: string;
  challengeId: string;
  credentialId: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
  env?: NodeJS.ProcessEnv;
  cfg?: FasedAgentConfig;
}) {
  const env = params.env ?? process.env;
  const mode = resolveWalletApprovalAuthMode(env, params.cfg);
  if (mode !== "webauthn") {
    return {
      ok: false as const,
      code: "approval_auth_disabled",
      message: "wallet approval auth mode is disabled",
    };
  }
  const host = normalizeHost(params.host);
  const state = loadState(env);
  if (pruneState(state)) {
    saveState(state, env);
  }
  const challenge = state.challenges.find(
    (entry) =>
      entry.kind === "assert" &&
      entry.status === "pending" &&
      entry.id === params.challengeId &&
      entry.host === host,
  );
  if (!challenge) {
    return {
      ok: false as const,
      code: "invalid_challenge",
      message: "assertion challenge missing",
    };
  }
  const clientData = decodeClientData(params.clientDataJSON);
  if (!clientData) {
    return { ok: false as const, code: "invalid_client_data", message: "invalid clientDataJSON" };
  }
  if (clientData.type !== "webauthn.get") {
    return { ok: false as const, code: "invalid_client_type", message: "expected webauthn.get" };
  }
  if (!challengeMatches(challenge.challenge, clientData.challenge)) {
    return {
      ok: false as const,
      code: "challenge_mismatch",
      message: "assertion challenge mismatch",
    };
  }
  if (!originMatchesHost(clientData.origin, challenge.host)) {
    return { ok: false as const, code: "origin_mismatch", message: "assertion origin mismatch" };
  }
  const authData = parseAuthenticatorData(params.authenticatorData);
  if (!authData) {
    return {
      ok: false as const,
      code: "invalid_authenticator_data",
      message: "invalid authenticator data",
    };
  }
  if (!rpIdHashMatches(challenge.rpId, authData.rpIdHash)) {
    return { ok: false as const, code: "rp_id_mismatch", message: "rpId hash mismatch" };
  }
  const upUv = assertUpUv(authData.flags);
  if (!upUv.ok) {
    return {
      ok: false as const,
      code: "verification_required",
      message: upUv.reason ?? "uv required",
    };
  }
  const credentialId = params.credentialId.trim();
  const passkey = state.passkeys.find((entry) => entry.id === credentialId);
  if (!passkey) {
    return {
      ok: false as const,
      code: "unknown_credential",
      message: "credential is not enrolled",
    };
  }
  const signatureOk = verifyAssertionSignature({
    passkey,
    authenticatorDataRaw: authData.raw,
    clientDataJsonBase64Url: params.clientDataJSON,
    signatureBase64Url: params.signature,
  });
  if (!signatureOk) {
    return {
      ok: false as const,
      code: "invalid_signature",
      message: "passkey assertion signature invalid",
    };
  }

  if (authData.signCount > passkey.signCount) {
    passkey.signCount = authData.signCount;
  }
  passkey.lastUsedAt = new Date().toISOString();
  challenge.status = "consumed";

  const grant = issueApprovalGrant({
    state,
    env,
    cfg: params.cfg,
    host: challenge.host,
    operation: challenge.operation ?? "wallet.approve",
    requestId: challenge.requestId,
  });
  saveState(state, env);
  return {
    ok: true as const,
    approvalToken: grant.token,
    expiresAt: grant.expiresAt,
    ttlSeconds: grant.ttlSeconds,
    operation: challenge.operation ?? "wallet.approve",
    requestId: challenge.requestId,
  };
}

export function consumeWalletApprovalGrant(params: {
  host: string;
  operation: string;
  requestId?: string;
  token: string;
  env?: NodeJS.ProcessEnv;
  cfg?: FasedAgentConfig;
}) {
  const env = params.env ?? process.env;
  const mode = resolveWalletApprovalAuthMode(env, params.cfg);
  if (mode !== "webauthn") {
    return { ok: true as const };
  }
  const token = params.token.trim();
  const host = normalizeHost(params.host);
  const state = loadState(env);
  if (pruneState(state)) {
    saveState(state, env);
  }
  if (state.passkeys.length === 0) {
    return {
      ok: false as const,
      code: "wallet_control_passkey_not_ready",
      message:
        "Wallet Control Passkey is enabled but no passkey is enrolled. Enroll a passkey or turn passkey approval off.",
    };
  }
  if (!token) {
    return {
      ok: false as const,
      code: "approval_token_required",
      message: "passkey approval token is required",
    };
  }
  const tokenHash = hashToken(token);
  const idx = state.grants.findIndex((entry) => entry.tokenHash === tokenHash);
  if (idx < 0) {
    return {
      ok: false as const,
      code: "invalid_approval_token",
      message: "passkey approval token is invalid or expired",
    };
  }
  const grant = state.grants[idx];
  if (grant.host !== host) {
    return { ok: false as const, code: "host_mismatch", message: "approval token host mismatch" };
  }
  if (grant.operation !== params.operation.trim()) {
    return {
      ok: false as const,
      code: "operation_mismatch",
      message: "approval token operation mismatch",
    };
  }
  const expectedRequestId = grant.requestId?.trim() || "";
  const actualRequestId = params.requestId?.trim() || "";
  if (expectedRequestId !== actualRequestId) {
    return {
      ok: false as const,
      code: "request_mismatch",
      message: "approval token request mismatch",
    };
  }
  state.grants.splice(idx, 1);
  saveState(state, env);
  return { ok: true as const };
}

export function listWalletPasskeys(
  env: NodeJS.ProcessEnv = process.env,
  cfg?: FasedAgentConfig,
): WalletPasskeyMetadata[] {
  return readWalletApprovalAuthSnapshot(env, cfg).passkeys;
}

export function removeWalletPasskey(params: {
  credentialId: string;
  env?: NodeJS.ProcessEnv;
  cfg?: FasedAgentConfig;
}) {
  const env = params.env ?? process.env;
  const credentialId = params.credentialId.trim();
  if (!credentialId) {
    return { ok: false as const, code: "invalid_passkey", message: "passkey id is required" };
  }
  const state = loadState(env);
  if (pruneState(state)) {
    saveState(state, env);
  }
  const idx = state.passkeys.findIndex((entry) => entry.id === credentialId);
  if (idx < 0) {
    return { ok: false as const, code: "passkey_not_found", message: "passkey not found" };
  }
  const [removed] = state.passkeys.splice(idx, 1);
  saveState(state, env);
  return {
    ok: true as const,
    passkey: {
      id: removed?.id ?? credentialId,
      label: removed?.label ?? credentialId,
      createdAt: removed?.createdAt ?? new Date().toISOString(),
      lastUsedAt: removed?.lastUsedAt,
    } satisfies WalletPasskeyMetadata,
    snapshot: readWalletApprovalAuthSnapshot(env, params.cfg),
  };
}

export function createWalletApprovalChallenge(params?: {
  requestId?: string;
  operation?: string;
  ttlSeconds?: number;
  host?: string;
  env?: NodeJS.ProcessEnv;
  cfg?: FasedAgentConfig;
}) {
  const env = params?.env ?? process.env;
  const host = normalizeHost(params?.host ?? env.FASED_A2A_ORIGIN ?? "localhost");
  const operation = params?.operation?.trim() || "wallet.approve";
  const started = beginWalletApprovalAssertion({
    host,
    operation,
    requestId: params?.requestId?.trim() || undefined,
    env,
    cfg: params?.cfg,
  });
  if (!started.ok) {
    return started;
  }
  return {
    ok: true as const,
    challenge: {
      id: started.challengeId,
      challenge: started.options.challenge,
      requestId: params?.requestId?.trim() || undefined,
      operation,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + started.challengeTtlSeconds * 1000).toISOString(),
      status: "pending" as const,
    },
    challengeTtlSeconds: started.challengeTtlSeconds,
  };
}
