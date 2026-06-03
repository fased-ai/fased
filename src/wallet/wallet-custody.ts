import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FasedAgentConfig } from "../config/config.js";
import { tryResolveSatRuntimeIds } from "../config/sat-runtime-ids.js";
import type { WalletChain } from "../config/types.wallet.js";
import { lockLocalSignerCustody, unlockLocalSignerCustody } from "./local-socket-signer-custody.js";
import {
  consumeWalletApprovalGrant,
  resolveWalletApprovalAuthMode,
} from "./wallet-approval-auth.js";
import { applyWalletPolicyConfig, resolveWalletRolePolicyProfile } from "./wallet-policy.js";
import { readWalletProviderRegistry, resolveWalletUserRole } from "./wallet-provider-registry.js";
import { resolveWalletProviderId } from "./wallet-provider-resolver.js";
import { walletDiagnosticErrorMessage } from "./wallet-redaction.js";
import {
  ensureWalletStateDir,
  resolveWalletRuntimeConfig,
  type ResolvedWalletRuntimeConfig,
} from "./wallet-runtime-config.js";

export type WalletCustodyRole = "mining" | "agent" | "vault";

export type WalletCustodyScope = {
  walletId: string;
  role: WalletCustodyRole;
  chains: WalletChain[];
  allowPrograms: string[];
  solana: {
    maxPerTx: string;
    maxDaily: string;
  };
};

type WalletCustodyUnlockSession = {
  id: string;
  host: string;
  walletId: string;
  role: WalletCustodyRole;
  chains: WalletChain[];
  allowPrograms: string[];
  solanaMaxPerTx: string;
  solanaMaxDaily: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt?: string;
};

type WalletCustodyState = {
  version: 1;
  unlockSessions: WalletCustodyUnlockSession[];
};

type WalletCustodyShareStateV1 = {
  version: 1;
  scheme: "xor-3of3-v1";
  secretBytes: number;
  hotShare: string;
  coldShare: string;
  deviceShareHash: string;
  secretChecksum: string;
  walletId?: string;
  role?: WalletCustodyRole;
  createdAt: string;
  updatedAt: string;
};

type WalletCustodyShareStateV2 = {
  version: 2;
  scheme: "shamir-2of3-v1";
  secretBytes: number;
  hostShare: string;
  deviceShareHash: string;
  recoveryShareHash: string;
  secretChecksum: string;
  walletId?: string;
  role?: WalletCustodyRole;
  createdAt: string;
  updatedAt: string;
};

type WalletCustodyEnrolledDevice = {
  id: string;
  label?: string;
  shareX: number;
  shareHash: string;
  createdAt: string;
  revokedAt?: string;
};

type WalletCustodyShareStateV3 = {
  version: 3;
  scheme: "shamir-2ofn-v1";
  secretBytes: number;
  hostShare: string;
  recoveryShareHash: string;
  secretChecksum: string;
  devices: WalletCustodyEnrolledDevice[];
  walletId?: string;
  role?: WalletCustodyRole;
  createdAt: string;
  updatedAt: string;
};

type WalletCustodyShareState =
  | WalletCustodyShareStateV1
  | WalletCustodyShareStateV2
  | WalletCustodyShareStateV3;

type WalletCustodyUnlockMaterial = {
  sessionId: string;
  host: string;
  expiresAtMs: number;
};

export type WalletCustodyStatus = {
  mode: "single-key" | "split-key-scaffold" | "split-key-active";
  target: {
    walletId: string;
    role: WalletCustodyRole;
  };
  scope: {
    chains: WalletChain[];
    allowPrograms: string[];
    solana: {
      maxPerTx: string;
      maxDaily: string;
    };
  };
  unlock: {
    active: boolean;
    sessionId?: string;
    host?: string;
    expiresAt?: string;
  };
  phase2: {
    complete: boolean;
    splitKeyEnabled: boolean;
    passkeyCeremonyEnabled: boolean;
    ephemeralReconstructionEnabled: boolean;
    notes: string[];
  };
  ceremony?: {
    initialized: boolean;
    scheme?: string;
    secretBytes?: number;
    devices?: Array<{
      id: string;
      label?: string;
      createdAt: string;
      revokedAt?: string;
    }>;
    path: string;
    updatedAt?: string;
  };
};

const DEFAULT_UNLOCK_TTL_SECONDS = 15 * 60;
const MAX_UNLOCK_TTL_SECONDS = 60 * 60;
const MANUAL_UNLOCK_EXPIRES_AT = "9999-12-31T23:59:59.000Z";
const CUSTODY_SECRET_BYTES = 32;
const SOLANA_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SOLANA_TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const SOLANA_ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const unlockMaterialBySession = new Map<string, WalletCustodyUnlockMaterial>();

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

function nowMs(): number {
  return Date.now();
}

function isNonNull<T>(value: T | null): value is T {
  return value !== null;
}

function sha256Hex(input: Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

function normalizeWalletIdForState(value: string | undefined): string {
  const raw = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!raw) {
    return "default";
  }
  const normalized = raw
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized || "default";
}

function normalizeChainList(value: Iterable<string>): WalletChain[] {
  const seen = new Set<WalletChain>();
  for (const entry of value) {
    if (entry === "solana") {
      seen.add(entry);
    }
  }
  return [...seen];
}

function normalizeAddressList(values: Iterable<string | undefined>): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = String(value ?? "")
      .trim()
      .toLowerCase();
    if (!normalized) {
      continue;
    }
    seen.add(normalized);
  }
  return [...seen];
}

function normalizeWalletCustodyRole(value: unknown): WalletCustodyRole | undefined {
  return value === "mining" || value === "agent" || value === "vault" ? value : undefined;
}

function normalizeDeviceLabel(value: string | undefined): string | undefined {
  const normalized = String(value ?? "")
    .trim()
    .replace(/\s+/g, " ");
  return normalized ? normalized.slice(0, 80) : undefined;
}

function createCustodyDeviceId(): string {
  return randomBytes(8).toString("hex");
}

function normalizeDeviceShareX(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 2 &&
    value <= 255 &&
    value !== 3
    ? value
    : null;
}

function normalizeEnrolledDevice(raw: unknown): WalletCustodyEnrolledDevice | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const value = raw as Record<string, unknown>;
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const shareX = normalizeDeviceShareX(value.shareX);
  const shareHash = typeof value.shareHash === "string" ? value.shareHash.trim() : "";
  const createdAt = typeof value.createdAt === "string" ? value.createdAt : "";
  if (!id || !shareX || !shareHash || !createdAt) {
    return null;
  }
  return {
    id,
    label: normalizeDeviceLabel(typeof value.label === "string" ? value.label : undefined),
    shareX,
    shareHash,
    createdAt,
    revokedAt: typeof value.revokedAt === "string" ? value.revokedAt : undefined,
  };
}

function listActiveEnrolledDevices(
  shareState: WalletCustodyShareState | null | undefined,
): WalletCustodyEnrolledDevice[] {
  if (!shareState) {
    return [];
  }
  if (shareState.version === 3 && shareState.scheme === "shamir-2ofn-v1") {
    return shareState.devices.filter((device) => !device.revokedAt);
  }
  if (shareState.version === 2 && shareState.scheme === "shamir-2of3-v1") {
    return [
      {
        id: "primary",
        label: "Primary device",
        shareX: 2,
        shareHash: shareState.deviceShareHash,
        createdAt: shareState.createdAt,
      },
    ];
  }
  if (shareState.version === 1 && shareState.scheme === "xor-3of3-v1") {
    return [
      {
        id: "legacy-primary",
        label: "Primary device",
        shareX: 2,
        shareHash: shareState.deviceShareHash,
        createdAt: shareState.createdAt,
      },
    ];
  }
  return [];
}

function allocateNextDeviceShareX(devices: WalletCustodyEnrolledDevice[]): number {
  const used = new Set<number>(devices.map((device) => device.shareX));
  for (let candidate = 2; candidate <= 255; candidate += 1) {
    if (candidate === 3 || used.has(candidate)) {
      continue;
    }
    return candidate;
  }
  throw new Error("no available device-share slots remain for this wallet");
}

function resolveLegacyCustodyStatePath(env: NodeJS.ProcessEnv = process.env): string {
  const walletPaths = ensureWalletStateDir(env);
  return path.join(walletPaths.rootDir, "wallet-custody-state.json");
}

function resolveLegacyCustodyShareStatePath(env: NodeJS.ProcessEnv = process.env): string {
  const walletPaths = ensureWalletStateDir(env);
  return path.join(walletPaths.rootDir, "wallet-custody-shares.v1.json");
}

function resolveCustodyWalletDir(
  walletId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const walletPaths = ensureWalletStateDir(env);
  return path.join(walletPaths.rootDir, "custody", normalizeWalletIdForState(walletId));
}

function resolveCustodyStatePath(
  walletId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(resolveCustodyWalletDir(walletId, env), "state.json");
}

function resolveCustodyShareStatePath(
  walletId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(resolveCustodyWalletDir(walletId, env), "shares.v1.json");
}

function locateCustodyStatePath(
  walletId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const scopedPath = resolveCustodyStatePath(walletId, env);
  if (fs.existsSync(scopedPath)) {
    return scopedPath;
  }
  const legacyPath = resolveLegacyCustodyStatePath(env);
  return fs.existsSync(legacyPath) ? legacyPath : scopedPath;
}

function locateCustodyShareStatePath(
  walletId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const scopedPath = resolveCustodyShareStatePath(walletId, env);
  if (fs.existsSync(scopedPath)) {
    return scopedPath;
  }
  const legacyPath = resolveLegacyCustodyShareStatePath(env);
  return fs.existsSync(legacyPath) ? legacyPath : scopedPath;
}

function listCustodyStateTargets(env: NodeJS.ProcessEnv = process.env): Array<string | undefined> {
  const walletPaths = ensureWalletStateDir(env);
  const custodyRoot = path.join(walletPaths.rootDir, "custody");
  const targets = new Set<string>();
  if (fs.existsSync(custodyRoot)) {
    for (const entry of fs.readdirSync(custodyRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.trim()) {
        targets.add(entry.name.trim());
      }
    }
  }
  const out: Array<string | undefined> = [...targets];
  if (fs.existsSync(resolveLegacyCustodyStatePath(env)) || out.length === 0) {
    out.push(undefined);
  }
  return out;
}

function readUnlockTtlSeconds(
  env: NodeJS.ProcessEnv = process.env,
  requestedTtlSeconds?: number,
): number {
  const raw =
    typeof requestedTtlSeconds === "number" && Number.isFinite(requestedTtlSeconds)
      ? requestedTtlSeconds
      : Number.parseInt(String(env.FASED_WALLET_CUSTODY_UNLOCK_TTL_SECONDS ?? ""), 10);
  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_UNLOCK_TTL_SECONDS;
  }
  return Math.min(MAX_UNLOCK_TTL_SECONDS, Math.max(30, Math.floor(raw)));
}

function resolveUnlockExpiresAt(
  env: NodeJS.ProcessEnv = process.env,
  requestedTtlSeconds?: number,
): string {
  if (requestedTtlSeconds === 0) {
    return MANUAL_UNLOCK_EXPIRES_AT;
  }
  return new Date(nowMs() + readUnlockTtlSeconds(env, requestedTtlSeconds) * 1000).toISOString();
}

function readBooleanFlag(env: NodeJS.ProcessEnv, key: string): boolean {
  const value = String(env[key] ?? "")
    .trim()
    .toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function normalizeWalletIdForCustodyEnv(value: string | undefined): string {
  const raw = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!raw) {
    return "default";
  }
  return raw.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "default";
}

function readCustodyWalletSet(env: NodeJS.ProcessEnv): Set<string> {
  const out = new Set<string>();
  for (const part of String(env.FASED_WALLET_CUSTODY_WALLETS ?? "").split(",")) {
    if (!part.trim()) {
      continue;
    }
    const normalized = normalizeWalletIdForCustodyEnv(part);
    if (normalized) {
      out.add(normalized);
    }
  }
  return out;
}

function decodeBase64Share(raw: string): Buffer | null {
  const value = raw.trim();
  if (!value) {
    return null;
  }
  for (const encoding of ["base64url", "base64"] as const) {
    try {
      const decoded = Buffer.from(value, encoding);
      if (decoded.length > 0) {
        return decoded;
      }
    } catch {
      // try next encoding
    }
  }
  return null;
}

function buffersEqualHex(leftHex: string, rightHex: string): boolean {
  try {
    const left = Buffer.from(leftHex, "hex");
    const right = Buffer.from(rightHex, "hex");
    if (left.length === 0 || right.length === 0 || left.length !== right.length) {
      return false;
    }
    return timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

function xorBuffers(buffers: Buffer[]): Buffer {
  if (buffers.length === 0) {
    return Buffer.alloc(0);
  }
  const length = buffers[0].length;
  const out = Buffer.alloc(length, 0);
  for (const buffer of buffers) {
    if (buffer.length !== length) {
      throw new Error("buffer length mismatch");
    }
    for (let i = 0; i < length; i += 1) {
      out[i] ^= buffer[i];
    }
  }
  return out;
}

function gf256Multiply(left: number, right: number): number {
  let a = left & 0xff;
  let b = right & 0xff;
  let out = 0;
  while (b > 0) {
    if (b & 1) {
      out ^= a;
    }
    const hiBit = a & 0x80;
    a = (a << 1) & 0xff;
    if (hiBit) {
      a ^= 0x1b;
    }
    b >>= 1;
  }
  return out & 0xff;
}

function gf256Pow(value: number, exponent: number): number {
  let result = 1;
  let base = value & 0xff;
  let power = Math.max(0, Math.floor(exponent));
  while (power > 0) {
    if (power & 1) {
      result = gf256Multiply(result, base);
    }
    base = gf256Multiply(base, base);
    power >>= 1;
  }
  return result & 0xff;
}

function gf256Inverse(value: number): number {
  if (value === 0) {
    throw new Error("cannot invert zero in GF(256)");
  }
  return gf256Pow(value, 254);
}

function gf256Divide(left: number, right: number): number {
  if (left === 0) {
    return 0;
  }
  return gf256Multiply(left, gf256Inverse(right));
}

function encodeTypedCustodyShare(type: "device" | "recovery", share: Buffer): string {
  return `${type === "device" ? "d" : "r"}.${share.toString("base64url")}`;
}

function decodeTypedCustodyShare(raw: string): {
  type: "device" | "recovery" | "unknown";
  bytes: Buffer | null;
} {
  const value = raw.trim();
  if (!value) {
    return { type: "unknown", bytes: null };
  }
  const match = /^([dr])\.(.+)$/i.exec(value);
  if (!match) {
    return { type: "unknown", bytes: decodeBase64Share(value) };
  }
  return {
    type: match[1]?.toLowerCase() === "r" ? "recovery" : "device",
    bytes: decodeBase64Share(match[2] ?? ""),
  };
}

function splitSecretShamir2of3(secret: Buffer): {
  hostShare: Buffer;
  deviceShare: Buffer;
  recoveryShare: Buffer;
} {
  const slope = randomBytes(secret.length);
  const hostShare = deriveSecretShamirShare(secret, slope, 1);
  const deviceShare = deriveSecretShamirShare(secret, slope, 2);
  const recoveryShare = deriveSecretShamirShare(secret, slope, 3);
  slope.fill(0);
  return { hostShare, deviceShare, recoveryShare };
}

function deriveSecretShamirShare(secret: Buffer, slope: Buffer, x: number): Buffer {
  if (secret.length !== slope.length) {
    throw new Error("share length mismatch");
  }
  const share = Buffer.alloc(secret.length, 0);
  for (let i = 0; i < secret.length; i += 1) {
    const s = secret[i] ?? 0;
    const m = slope[i] ?? 0;
    share[i] = s ^ gf256Multiply(m, x);
  }
  return share;
}

function splitSecretShamir2of3WithDeviceShare(
  secret: Buffer,
  deviceShare: Buffer,
): {
  hostShare: Buffer;
  recoveryShare: Buffer;
} {
  if (secret.length !== deviceShare.length) {
    throw new Error("share length mismatch");
  }
  const slope = Buffer.alloc(secret.length, 0);
  for (let i = 0; i < secret.length; i += 1) {
    const s = secret[i] ?? 0;
    const d = deviceShare[i] ?? 0;
    slope[i] = gf256Divide(s ^ d, 2);
  }
  const hostShare = deriveSecretShamirShare(secret, slope, 1);
  const recoveryShare = deriveSecretShamirShare(secret, slope, 3);
  slope.fill(0);
  return { hostShare, recoveryShare };
}

function reconstructSecretShamir2ofN(params: {
  hostShare: Buffer;
  otherShare: Buffer;
  otherX: number;
}): Buffer {
  const { hostShare, otherShare, otherX } = params;
  if (hostShare.length !== otherShare.length) {
    throw new Error("share length mismatch");
  }
  const out = Buffer.alloc(hostShare.length, 0);
  const denominator = 1 ^ otherX;
  const weightHost = gf256Divide(otherX, denominator);
  const weightOther = gf256Divide(1, denominator);
  for (let i = 0; i < hostShare.length; i += 1) {
    const left = gf256Multiply(hostShare[i] ?? 0, weightHost);
    const right = gf256Multiply(otherShare[i] ?? 0, weightOther);
    out[i] = left ^ right;
  }
  return out;
}

function zeroizeBuffers(buffers: Array<Buffer | null | undefined>) {
  for (const buffer of buffers) {
    if (!buffer || buffer.length === 0) {
      continue;
    }
    buffer.fill(0);
  }
}

function removeUnlockMaterial(sessionId: string) {
  const existing = unlockMaterialBySession.get(sessionId);
  if (!existing) {
    return;
  }
  unlockMaterialBySession.delete(sessionId);
}

function pruneUnlockMaterialStore(now = nowMs()) {
  for (const [sessionId, entry] of unlockMaterialBySession.entries()) {
    if (entry.expiresAtMs <= now) {
      removeUnlockMaterial(sessionId);
    }
  }
}

function setUnlockMaterial(params: { sessionId: string; host: string; expiresAt: string }) {
  removeUnlockMaterial(params.sessionId);
  const expiresAtMs = Date.parse(params.expiresAt);
  unlockMaterialBySession.set(params.sessionId, {
    sessionId: params.sessionId,
    host: params.host,
    expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : nowMs() + 30_000,
  });
}

function hasActiveUnlockMaterial(params: { sessionId: string; host: string }): boolean {
  pruneUnlockMaterialStore();
  const entry = unlockMaterialBySession.get(params.sessionId);
  if (!entry) {
    return false;
  }
  if (entry.host !== params.host || entry.expiresAtMs <= nowMs()) {
    removeUnlockMaterial(params.sessionId);
    return false;
  }
  return true;
}

export async function withWalletCustodySigningMaterial<T>(params: {
  sessionId: string;
  host: string;
  handler: (material: { sessionId: string; host: string }) => Promise<T> | T;
}): Promise<
  { ok: true; value: T } | { ok: false; code: "custody_unlock_required"; message: string }
> {
  pruneUnlockMaterialStore();
  const entry = unlockMaterialBySession.get(params.sessionId);
  if (!entry || entry.host !== params.host || entry.expiresAtMs <= nowMs()) {
    removeUnlockMaterial(params.sessionId);
    return {
      ok: false,
      code: "custody_unlock_required",
      message: "custody unlock signing material is unavailable; re-run passkey unlock",
    };
  }
  try {
    const value = await params.handler({
      sessionId: entry.sessionId,
      host: entry.host,
    });
    return { ok: true, value };
  } finally {
    // No signing key material is retained in the gateway process once signer custody is active.
  }
}

function inferWalletChains(params: {
  wallet: ResolvedWalletRuntimeConfig;
  env: NodeJS.ProcessEnv;
  walletId: string;
}): WalletChain[] {
  try {
    const registry = readWalletProviderRegistry(params.env);
    const namedWallet = registry.wallets.find((entry) => entry.id === params.walletId);
    const inferred = normalizeChainList([namedWallet?.addresses?.solana ? "solana" : ""]);
    if (inferred.length > 0) {
      return inferred;
    }
  } catch {
    // fall through
  }
  return params.wallet.chains.length > 0 ? params.wallet.chains : ["solana"];
}

function resolveWalletCustodyScope(params: {
  wallet?: ResolvedWalletRuntimeConfig;
  env?: NodeJS.ProcessEnv;
  cfg?: FasedAgentConfig;
  walletId?: string;
}): WalletCustodyScope {
  const env = params.env ?? process.env;
  const wallet =
    params.wallet ?? resolveWalletRuntimeConfig(params.cfg ?? ({} as FasedAgentConfig), env);
  const registry = readWalletProviderRegistry(env);
  const configuredMiningWalletId =
    typeof params.cfg?.plugins?.entries?.["sat-mining"]?.config?.walletId === "string"
      ? params.cfg.plugins.entries["sat-mining"]?.config?.walletId.trim()
      : "";
  const explicitWalletId = params.walletId?.trim() || "";
  const walletId =
    explicitWalletId ||
    registry.defaultWalletId?.trim() ||
    configuredMiningWalletId ||
    registry.wallets.find((entry) => entry.providerId === "local-socket-signer")?.id ||
    "default";
  const registryWallet = registry.wallets.find((entry) => entry.id === walletId);
  const walletPurpose = resolveWalletUserRole(registryWallet);
  const role: WalletCustodyRole =
    walletId === configuredMiningWalletId || walletPurpose === "mining"
      ? "mining"
      : walletId === registry.defaultWalletId || walletPurpose === "agent"
        ? "agent"
        : "vault";
  const effectiveWallet = applyWalletPolicyConfig({
    config: wallet,
    cfg: params.cfg,
    env,
    walletId,
  });
  const roleProfile = resolveWalletRolePolicyProfile(role, env);
  const chains: WalletChain[] =
    role === "mining"
      ? ["solana"]
      : inferWalletChains({
          wallet: effectiveWallet,
          env,
          walletId,
        });
  const allowPrograms = new Set<string>(
    normalizeAddressList(effectiveWallet.policy.solana.allowPrograms),
  );
  if (role === "mining") {
    const ids = tryResolveSatRuntimeIds(env);
    if (ids?.programId) {
      allowPrograms.add(ids.programId.toLowerCase());
    }
  } else if (chains.includes("solana")) {
    allowPrograms.add(SOLANA_TOKEN_PROGRAM_ID.toLowerCase());
    allowPrograms.add(SOLANA_TOKEN_2022_PROGRAM_ID.toLowerCase());
    allowPrograms.add(SOLANA_ASSOCIATED_TOKEN_PROGRAM_ID.toLowerCase());
  }
  for (const program of roleProfile.defaults.solana.allowPrograms) {
    allowPrograms.add(program.toLowerCase());
  }
  const solanaMaxPerTx =
    role === "mining"
      ? roleProfile.defaults.solana.maxPerTx
      : effectiveWallet.policy.solana.caps.maxPerTx.toString();
  const solanaMaxDaily =
    role === "mining"
      ? roleProfile.defaults.solana.maxDaily
      : effectiveWallet.policy.solana.caps.maxDaily.toString();
  return {
    walletId,
    role,
    chains,
    allowPrograms: [...allowPrograms],
    solana: {
      maxPerTx: solanaMaxPerTx,
      maxDaily: solanaMaxDaily,
    },
  };
}

function loadShareState(
  walletId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): WalletCustodyShareState | null {
  const filePath = locateCustodyShareStatePath(walletId, env);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(
      fs.readFileSync(filePath, "utf8"),
    ) as Partial<WalletCustodyShareState>;
    if (
      parsed.version === 1 &&
      parsed.scheme === "xor-3of3-v1" &&
      typeof parsed.secretBytes === "number" &&
      parsed.secretBytes > 0 &&
      typeof parsed.hotShare === "string" &&
      typeof parsed.coldShare === "string" &&
      typeof parsed.deviceShareHash === "string" &&
      typeof parsed.secretChecksum === "string" &&
      typeof parsed.createdAt === "string" &&
      typeof parsed.updatedAt === "string"
    ) {
      const hot = decodeBase64Share(parsed.hotShare);
      const cold = decodeBase64Share(parsed.coldShare);
      if (
        !hot ||
        !cold ||
        hot.length !== parsed.secretBytes ||
        cold.length !== parsed.secretBytes
      ) {
        return null;
      }
      return {
        version: 1,
        scheme: "xor-3of3-v1",
        secretBytes: parsed.secretBytes,
        hotShare: parsed.hotShare,
        coldShare: parsed.coldShare,
        deviceShareHash: parsed.deviceShareHash,
        secretChecksum: parsed.secretChecksum,
        walletId:
          typeof parsed.walletId === "string" ? parsed.walletId.trim() || undefined : undefined,
        role: normalizeWalletCustodyRole(parsed.role),
        createdAt: parsed.createdAt,
        updatedAt: parsed.updatedAt,
      };
    }
    if (
      parsed.version === 2 &&
      parsed.scheme === "shamir-2of3-v1" &&
      typeof parsed.secretBytes === "number" &&
      parsed.secretBytes > 0 &&
      typeof parsed.hostShare === "string" &&
      typeof parsed.deviceShareHash === "string" &&
      typeof parsed.recoveryShareHash === "string" &&
      typeof parsed.secretChecksum === "string" &&
      typeof parsed.createdAt === "string" &&
      typeof parsed.updatedAt === "string"
    ) {
      const host = decodeBase64Share(parsed.hostShare);
      if (!host || host.length !== parsed.secretBytes) {
        return null;
      }
      return {
        version: 2,
        scheme: "shamir-2of3-v1",
        secretBytes: parsed.secretBytes,
        hostShare: parsed.hostShare,
        deviceShareHash: parsed.deviceShareHash,
        recoveryShareHash: parsed.recoveryShareHash,
        secretChecksum: parsed.secretChecksum,
        walletId:
          typeof parsed.walletId === "string" ? parsed.walletId.trim() || undefined : undefined,
        role: normalizeWalletCustodyRole(parsed.role),
        createdAt: parsed.createdAt,
        updatedAt: parsed.updatedAt,
      };
    }
    if (
      parsed.version === 3 &&
      parsed.scheme === "shamir-2ofn-v1" &&
      typeof parsed.secretBytes === "number" &&
      parsed.secretBytes > 0 &&
      typeof parsed.hostShare === "string" &&
      typeof parsed.recoveryShareHash === "string" &&
      typeof parsed.secretChecksum === "string" &&
      typeof parsed.createdAt === "string" &&
      typeof parsed.updatedAt === "string" &&
      Array.isArray((parsed as Partial<WalletCustodyShareStateV3>).devices)
    ) {
      const host = decodeBase64Share(parsed.hostShare);
      if (!host || host.length !== parsed.secretBytes) {
        return null;
      }
      const devices = ((parsed as Partial<WalletCustodyShareStateV3>).devices ?? [])
        .map(normalizeEnrolledDevice)
        .filter(isNonNull);
      return {
        version: 3,
        scheme: "shamir-2ofn-v1",
        secretBytes: parsed.secretBytes,
        hostShare: parsed.hostShare,
        recoveryShareHash: parsed.recoveryShareHash,
        secretChecksum: parsed.secretChecksum,
        devices,
        walletId:
          typeof parsed.walletId === "string" ? parsed.walletId.trim() || undefined : undefined,
        role: normalizeWalletCustodyRole(parsed.role),
        createdAt: parsed.createdAt,
        updatedAt: parsed.updatedAt,
      };
    }
    return null;
  } catch {
    return null;
  }
}

function saveShareState(
  state: WalletCustodyShareState,
  walletId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
) {
  const filePath = resolveCustodyShareStatePath(walletId, env);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best effort
  }
}

export function deleteWalletCustodyCeremony(params?: {
  env?: NodeJS.ProcessEnv;
  walletId?: string;
  wallet?: ResolvedWalletRuntimeConfig;
  cfg?: FasedAgentConfig;
}): { ok: true; walletId: string; removed: boolean; statePath: string } {
  const env = params?.env ?? process.env;
  const scope =
    params?.wallet && params?.cfg
      ? resolveWalletCustodyScope({
          wallet: params.wallet,
          cfg: params.cfg,
          env,
          walletId: params.walletId,
        })
      : {
          walletId: params?.walletId?.trim() || "default",
          role: "vault" as const,
        };
  const statePath = locateCustodyShareStatePath(scope.walletId, env);
  const existed = fs.existsSync(statePath);
  if (existed) {
    fs.rmSync(statePath, { force: true });
    try {
      fs.rmdirSync(path.dirname(statePath));
    } catch {
      // Keep non-empty custody directories intact.
    }
  }
  return {
    ok: true,
    walletId: scope.walletId,
    removed: existed,
    statePath,
  };
}

function encodeCustodyShareStateV3(params: {
  shareState: WalletCustodyShareState | null | undefined;
  walletId: string;
  role: WalletCustodyRole;
  hostShare: Buffer;
  recoveryShareHash: string;
  secretChecksum: string;
  createdAt: string;
  updatedAt: string;
  devices: WalletCustodyEnrolledDevice[];
}): WalletCustodyShareStateV3 {
  const secretBytes =
    params.shareState?.secretBytes && params.shareState.secretBytes > 0
      ? params.shareState.secretBytes
      : params.hostShare.length;
  return {
    version: 3,
    scheme: "shamir-2ofn-v1",
    secretBytes,
    hostShare: params.hostShare.toString("base64url"),
    recoveryShareHash: params.recoveryShareHash,
    secretChecksum: params.secretChecksum,
    devices: params.devices.map((device) => ({
      id: device.id,
      label: normalizeDeviceLabel(device.label),
      shareX: device.shareX,
      shareHash: device.shareHash,
      createdAt: device.createdAt,
      revokedAt: device.revokedAt,
    })),
    walletId: params.walletId,
    role: params.role,
    createdAt: params.createdAt,
    updatedAt: params.updatedAt,
  };
}

export function initializeWalletCustodyCeremony(params?: {
  env?: NodeJS.ProcessEnv;
  force?: boolean;
  deviceShare?: string;
  deviceLabel?: string;
  walletId?: string;
  wallet?: ResolvedWalletRuntimeConfig;
  cfg?: FasedAgentConfig;
}) {
  const env = params?.env ?? process.env;
  const scope =
    params?.wallet && params?.cfg
      ? resolveWalletCustodyScope({
          wallet: params.wallet,
          cfg: params.cfg,
          env,
          walletId: params.walletId,
        })
      : {
          walletId: params?.walletId?.trim() || "default",
          role: "vault" as const,
        };
  const existing = loadShareState(scope.walletId, env);
  if (existing && !params?.force) {
    return {
      ok: false as const,
      code: "ceremony_exists",
      message: "wallet custody ceremony is already initialized",
      statePath: locateCustodyShareStatePath(scope.walletId, env),
    };
  }

  const secret = randomBytes(CUSTODY_SECRET_BYTES);
  let hostShare: Buffer | null = null;
  let deviceShare: Buffer | null = null;
  let recoveryShare: Buffer | null = null;
  try {
    const requested = decodeTypedCustodyShare(params?.deviceShare ?? "");
    const requestedDeviceShare = requested.bytes;
    if (requestedDeviceShare && requestedDeviceShare.length !== CUSTODY_SECRET_BYTES) {
      return {
        ok: false as const,
        code: "invalid_device_share",
        message: `device share must be ${CUSTODY_SECRET_BYTES} bytes (base64/base64url)`,
      };
    }
    if (requestedDeviceShare) {
      deviceShare = Buffer.from(requestedDeviceShare);
      const split = splitSecretShamir2of3WithDeviceShare(secret, deviceShare);
      hostShare = split.hostShare;
      recoveryShare = split.recoveryShare;
    } else {
      const split = splitSecretShamir2of3(secret);
      hostShare = split.hostShare;
      deviceShare = split.deviceShare;
      recoveryShare = split.recoveryShare;
    }

    const nowIso = new Date().toISOString();
    const record = encodeCustodyShareStateV3({
      shareState: existing,
      walletId: scope.walletId,
      role: scope.role,
      hostShare,
      recoveryShareHash: sha256Hex(recoveryShare),
      secretChecksum: sha256Hex(secret),
      createdAt: existing?.createdAt ?? nowIso,
      updatedAt: nowIso,
      devices: [
        {
          id: createCustodyDeviceId(),
          label: normalizeDeviceLabel(params?.deviceLabel) ?? "Primary device",
          shareX: 2,
          shareHash: sha256Hex(deviceShare),
          createdAt: nowIso,
        },
      ],
    });
    saveShareState(record, scope.walletId, env);
    return {
      ok: true as const,
      statePath: resolveCustodyShareStatePath(scope.walletId, env),
      scheme: record.scheme,
      walletId: scope.walletId,
      role: scope.role,
      deviceShare: encodeTypedCustodyShare("device", deviceShare),
      recoveryShare: encodeTypedCustodyShare("recovery", recoveryShare),
      secretBytes: CUSTODY_SECRET_BYTES,
      updatedAt: record.updatedAt,
    };
  } finally {
    zeroizeBuffers([secret, hostShare, deviceShare, recoveryShare]);
  }
}

export function recoverWalletCustodyCeremony(params?: {
  env?: NodeJS.ProcessEnv;
  recoveryShare?: string;
  deviceShare?: string;
  deviceLabel?: string;
  walletId?: string;
  wallet?: ResolvedWalletRuntimeConfig;
  cfg?: FasedAgentConfig;
}) {
  const env = params?.env ?? process.env;
  const scope =
    params?.wallet && params?.cfg
      ? resolveWalletCustodyScope({
          wallet: params.wallet,
          cfg: params.cfg,
          env,
          walletId: params.walletId,
        })
      : {
          walletId: params?.walletId?.trim() || "default",
          role: "vault" as const,
        };
  const existing = loadShareState(scope.walletId, env);
  if (!existing) {
    return {
      ok: false as const,
      code: "custody_ceremony_required",
      message: "split-key custody ceremony is not initialized",
      statePath: locateCustodyShareStatePath(scope.walletId, env),
    };
  }
  const reconstructed = reconstructCustodySigningKey({
    env,
    recoveryShare: params?.recoveryShare,
    walletId: scope.walletId,
  });
  if (!reconstructed.ok) {
    return reconstructed;
  }

  let deviceShare: Buffer | null = null;
  let hostShare: Buffer | null = null;
  let recoveryShare: Buffer | null = null;
  try {
    const requested = decodeTypedCustodyShare(params?.deviceShare ?? "");
    const requestedDeviceShare = requested.bytes;
    if (requestedDeviceShare && requestedDeviceShare.length !== CUSTODY_SECRET_BYTES) {
      return {
        ok: false as const,
        code: "invalid_device_share",
        message: `device share must be ${CUSTODY_SECRET_BYTES} bytes (base64/base64url)`,
      };
    }
    if (requestedDeviceShare) {
      deviceShare = Buffer.from(requestedDeviceShare);
      const split = splitSecretShamir2of3WithDeviceShare(reconstructed.signingKey, deviceShare);
      hostShare = split.hostShare;
      recoveryShare = split.recoveryShare;
    } else {
      const split = splitSecretShamir2of3(reconstructed.signingKey);
      hostShare = split.hostShare;
      deviceShare = split.deviceShare;
      recoveryShare = split.recoveryShare;
    }

    const updatedAt = new Date().toISOString();
    const record = encodeCustodyShareStateV3({
      shareState: existing,
      walletId: scope.walletId,
      role: scope.role,
      hostShare,
      recoveryShareHash: sha256Hex(recoveryShare),
      secretChecksum: sha256Hex(reconstructed.signingKey),
      createdAt: existing.createdAt,
      updatedAt,
      devices: [
        {
          id: createCustodyDeviceId(),
          label: normalizeDeviceLabel(params?.deviceLabel) ?? "Recovered device",
          shareX: 2,
          shareHash: sha256Hex(deviceShare),
          createdAt: updatedAt,
        },
      ],
    });
    saveShareState(record, scope.walletId, env);
    return {
      ok: true as const,
      statePath: resolveCustodyShareStatePath(scope.walletId, env),
      scheme: record.scheme,
      walletId: scope.walletId,
      role: scope.role,
      deviceShare: encodeTypedCustodyShare("device", deviceShare),
      recoveryShare: encodeTypedCustodyShare("recovery", recoveryShare),
      secretBytes: CUSTODY_SECRET_BYTES,
      updatedAt,
    };
  } finally {
    zeroizeBuffers([reconstructed.signingKey, deviceShare, hostShare, recoveryShare]);
  }
}

export function enrollWalletCustodyDevice(params?: {
  env?: NodeJS.ProcessEnv;
  walletId?: string;
  wallet?: ResolvedWalletRuntimeConfig;
  cfg?: FasedAgentConfig;
  deviceShare?: string;
  recoveryShare?: string;
  label?: string;
}) {
  const env = params?.env ?? process.env;
  const scope = resolveWalletCustodyScope({
    wallet: params?.wallet,
    cfg: params?.cfg,
    env,
    walletId: params?.walletId,
  });
  const shareState = loadShareState(scope.walletId, env);
  if (!shareState) {
    return {
      ok: false as const,
      code: "custody_ceremony_required",
      message: "split-key custody ceremony is not initialized",
    };
  }
  if (shareState.scheme === "xor-3of3-v1") {
    return {
      ok: false as const,
      code: "custody_scheme_unsupported",
      message:
        "legacy custody scheme does not support second-device enrollment; recover the wallet first",
    };
  }
  const reconstructed = reconstructCustodySigningKey({
    env,
    walletId: scope.walletId,
    deviceShare: params?.deviceShare,
    recoveryShare: params?.recoveryShare,
  });
  if (!reconstructed.ok) {
    return reconstructed;
  }
  let hostShare: Buffer | null = null;
  let slope: Buffer | null = null;
  let newDeviceShare: Buffer | null = null;
  try {
    hostShare = decodeBase64Share(shareState.hostShare);
    if (!hostShare || hostShare.length !== CUSTODY_SECRET_BYTES) {
      return {
        ok: false as const,
        code: "custody_shares_invalid",
        message: "stored split-key share payload is invalid",
      };
    }
    const activeDevices = listActiveEnrolledDevices(shareState);
    const shareX = allocateNextDeviceShareX(activeDevices);
    slope = Buffer.alloc(reconstructed.signingKey.length, 0);
    for (let i = 0; i < reconstructed.signingKey.length; i += 1) {
      slope[i] = (reconstructed.signingKey[i] ?? 0) ^ (hostShare[i] ?? 0);
    }
    newDeviceShare = deriveSecretShamirShare(reconstructed.signingKey, slope, shareX);
    const updatedAt = new Date().toISOString();
    const newDevice: WalletCustodyEnrolledDevice = {
      id: createCustodyDeviceId(),
      label: normalizeDeviceLabel(params?.label) ?? `Device ${activeDevices.length + 1}`,
      shareX,
      shareHash: sha256Hex(newDeviceShare),
      createdAt: updatedAt,
    };
    const record = encodeCustodyShareStateV3({
      shareState,
      walletId: scope.walletId,
      role: scope.role,
      hostShare,
      recoveryShareHash: shareState.recoveryShareHash,
      secretChecksum: shareState.secretChecksum,
      createdAt: shareState.createdAt,
      updatedAt,
      devices: [...activeDevices, newDevice],
    });
    saveShareState(record, scope.walletId, env);
    return {
      ok: true as const,
      walletId: scope.walletId,
      role: scope.role,
      deviceId: newDevice.id,
      label: newDevice.label,
      deviceShare: encodeTypedCustodyShare("device", newDeviceShare),
      statePath: resolveCustodyShareStatePath(scope.walletId, env),
      updatedAt,
    };
  } finally {
    zeroizeBuffers([reconstructed.signingKey, hostShare, slope, newDeviceShare]);
  }
}

export function revokeWalletCustodyDevice(params?: {
  env?: NodeJS.ProcessEnv;
  walletId?: string;
  wallet?: ResolvedWalletRuntimeConfig;
  cfg?: FasedAgentConfig;
  deviceShare?: string;
  recoveryShare?: string;
  deviceId?: string;
}) {
  const env = params?.env ?? process.env;
  const scope = resolveWalletCustodyScope({
    wallet: params?.wallet,
    cfg: params?.cfg,
    env,
    walletId: params?.walletId,
  });
  const shareState = loadShareState(scope.walletId, env);
  if (!shareState) {
    return {
      ok: false as const,
      code: "custody_ceremony_required",
      message: "split-key custody ceremony is not initialized",
    };
  }
  if (shareState.scheme === "xor-3of3-v1") {
    return {
      ok: false as const,
      code: "custody_scheme_unsupported",
      message:
        "legacy custody scheme does not support per-device revocation; recover the wallet first",
    };
  }
  const targetDeviceId = String(params?.deviceId ?? "").trim();
  if (!targetDeviceId) {
    return {
      ok: false as const,
      code: "custody_device_id_required",
      message: "device id is required",
    };
  }
  const reconstructed = reconstructCustodySigningKey({
    env,
    walletId: scope.walletId,
    deviceShare: params?.deviceShare,
    recoveryShare: params?.recoveryShare,
  });
  if (!reconstructed.ok) {
    return reconstructed;
  }
  let hostShare: Buffer | null = null;
  try {
    hostShare = decodeBase64Share(shareState.hostShare);
    if (!hostShare || hostShare.length !== CUSTODY_SECRET_BYTES) {
      return {
        ok: false as const,
        code: "custody_shares_invalid",
        message: "stored split-key share payload is invalid",
      };
    }
    const activeDevices = listActiveEnrolledDevices(shareState);
    const target = activeDevices.find((device) => device.id === targetDeviceId) ?? null;
    if (!target) {
      return {
        ok: false as const,
        code: "custody_device_not_found",
        message: "device is not enrolled for this wallet",
      };
    }
    if (activeDevices.length <= 1) {
      return {
        ok: false as const,
        code: "custody_last_device_forbidden",
        message: "cannot revoke the last enrolled device; recover the wallet instead",
      };
    }
    const updatedAt = new Date().toISOString();
    const record = encodeCustodyShareStateV3({
      shareState,
      walletId: scope.walletId,
      role: scope.role,
      hostShare,
      recoveryShareHash: shareState.recoveryShareHash,
      secretChecksum: shareState.secretChecksum,
      createdAt: shareState.createdAt,
      updatedAt,
      devices: activeDevices.filter((device) => device.id !== targetDeviceId),
    });
    saveShareState(record, scope.walletId, env);
    return {
      ok: true as const,
      walletId: scope.walletId,
      role: scope.role,
      removedDeviceId: target.id,
      removedDeviceLabel: target.label,
      updatedAt,
    };
  } finally {
    zeroizeBuffers([reconstructed.signingKey, hostShare]);
  }
}

function loadState(
  walletId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): WalletCustodyState {
  const filePath = locateCustodyStatePath(walletId, env);
  if (!fs.existsSync(filePath)) {
    return { version: 1, unlockSessions: [] };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<WalletCustodyState>;
    if (parsed.version !== 1 || !Array.isArray(parsed.unlockSessions)) {
      return { version: 1, unlockSessions: [] };
    }
    return {
      version: 1,
      unlockSessions: parsed.unlockSessions
        .map((entry) => {
          if (!entry || typeof entry !== "object") {
            return null;
          }
          const value = entry as Partial<WalletCustodyUnlockSession>;
          if (
            typeof value.id !== "string" ||
            typeof value.host !== "string" ||
            typeof value.walletId !== "string" ||
            typeof value.createdAt !== "string" ||
            typeof value.expiresAt !== "string"
          ) {
            return null;
          }
          const chains = normalizeChainList(
            Array.isArray((value as { chains?: unknown }).chains)
              ? ((value as { chains?: unknown[] }).chains ?? []).map((entry) => String(entry))
              : [],
          );
          const allowPrograms = normalizeAddressList(
            Array.isArray((value as { allowPrograms?: unknown }).allowPrograms)
              ? ((value as { allowPrograms?: unknown[] }).allowPrograms ?? []).map((entry) =>
                  String(entry),
                )
              : [],
          );
          return {
            id: value.id,
            host: normalizeHost(value.host),
            walletId: value.walletId.trim() || "default",
            role: normalizeWalletCustodyRole(value.role) ?? "vault",
            chains,
            allowPrograms,
            solanaMaxPerTx: typeof value.solanaMaxPerTx === "string" ? value.solanaMaxPerTx : "0",
            solanaMaxDaily: typeof value.solanaMaxDaily === "string" ? value.solanaMaxDaily : "0",
            createdAt: value.createdAt,
            expiresAt: value.expiresAt,
            lastUsedAt: typeof value.lastUsedAt === "string" ? value.lastUsedAt : undefined,
          };
        })
        .filter(isNonNull),
    };
  } catch {
    return { version: 1, unlockSessions: [] };
  }
}

function saveState(
  state: WalletCustodyState,
  walletId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
) {
  const filePath = resolveCustodyStatePath(walletId, env);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best effort
  }
}

function pruneState(state: WalletCustodyState): boolean {
  const now = nowMs();
  const active: WalletCustodyUnlockSession[] = [];
  let changed = false;
  for (const entry of state.unlockSessions) {
    const expiresAt = Date.parse(entry.expiresAt);
    if (Number.isFinite(expiresAt) && expiresAt > now) {
      active.push(entry);
      continue;
    }
    removeUnlockMaterial(entry.id);
    changed = true;
  }
  if (changed) {
    state.unlockSessions = active;
  }
  return changed;
}

function getActiveUnlockSession(params: {
  host: string;
  walletId: string;
  env?: NodeJS.ProcessEnv;
}): WalletCustodyUnlockSession | null {
  const env = params.env ?? process.env;
  const host = normalizeHost(params.host);
  if (!host) {
    return null;
  }
  const state = loadState(params.walletId, env);
  const changed = pruneState(state);
  const active =
    state.unlockSessions.find(
      (entry) => entry.host === host && entry.walletId === params.walletId,
    ) ?? null;
  if (changed) {
    saveState(state, params.walletId, env);
  }
  return active;
}

function touchUnlockSession(params: {
  sessionId: string;
  walletId: string;
  env?: NodeJS.ProcessEnv;
}): WalletCustodyUnlockSession | null {
  const env = params.env ?? process.env;
  const state = loadState(params.walletId, env);
  const changed = pruneState(state);
  const session = state.unlockSessions.find((entry) => entry.id === params.sessionId) ?? null;
  if (!session) {
    if (changed) {
      saveState(state, params.walletId, env);
    }
    removeUnlockMaterial(params.sessionId);
    return null;
  }
  session.lastUsedAt = new Date().toISOString();
  saveState(state, params.walletId, env);
  return session;
}

function openUnlockSession(params: {
  host: string;
  scope: WalletCustodyScope;
  env?: NodeJS.ProcessEnv;
  ttlSeconds?: number;
}): WalletCustodyUnlockSession {
  const env = params.env ?? process.env;
  const state = loadState(params.scope.walletId, env);
  pruneState(state);
  const createdAt = new Date().toISOString();
  const expiresAt = resolveUnlockExpiresAt(env, params.ttlSeconds);
  const session: WalletCustodyUnlockSession = {
    id: randomBytes(12).toString("hex"),
    host: normalizeHost(params.host),
    walletId: params.scope.walletId,
    role: params.scope.role,
    chains: params.scope.chains,
    allowPrograms: params.scope.allowPrograms,
    solanaMaxPerTx: params.scope.solana.maxPerTx,
    solanaMaxDaily: params.scope.solana.maxDaily,
    createdAt,
    expiresAt,
    lastUsedAt: createdAt,
  };
  for (const existing of state.unlockSessions) {
    if (existing.walletId === session.walletId) {
      removeUnlockMaterial(existing.id);
    }
  }
  state.unlockSessions = state.unlockSessions.filter(
    (entry) => entry.walletId !== session.walletId,
  );
  state.unlockSessions.push(session);
  saveState(state, params.scope.walletId, env);
  return session;
}

function clearLocalUnlockSessions(params?: {
  host?: string;
  walletId?: string;
  env?: NodeJS.ProcessEnv;
}) {
  const env = params?.env ?? process.env;
  const requestedHost = params?.host?.trim() ? normalizeHost(params.host) : "";
  const requestedWalletId = params?.walletId?.trim() || "";
  if (params?.host?.trim() && !requestedHost) {
    return {
      ok: false as const,
      code: "invalid_host",
      message: "host is invalid for custody lock",
    };
  }
  let removed = 0;
  let remaining = 0;
  const targets = requestedWalletId ? [requestedWalletId] : listCustodyStateTargets(env);
  for (const target of targets) {
    const state = loadState(target, env);
    const changedByPrune = pruneState(state);
    const before = state.unlockSessions.length;
    if (!requestedHost && !requestedWalletId) {
      for (const session of state.unlockSessions) {
        removeUnlockMaterial(session.id);
      }
      state.unlockSessions = [];
    } else {
      state.unlockSessions = state.unlockSessions.filter((session) => {
        if (requestedHost && session.host !== requestedHost) {
          return true;
        }
        if (requestedWalletId && session.walletId !== requestedWalletId) {
          return true;
        }
        removeUnlockMaterial(session.id);
        return false;
      });
    }
    removed += before - state.unlockSessions.length;
    remaining += state.unlockSessions.length;
    if (changedByPrune || before !== state.unlockSessions.length) {
      saveState(state, target, env);
    }
  }
  return {
    ok: true as const,
    host: requestedHost || undefined,
    walletId: requestedWalletId || undefined,
    removed,
    remaining,
  };
}

export function recoverWalletCustodyPassphrase(params?: {
  env?: NodeJS.ProcessEnv;
  deviceShare?: string;
  recoveryShare?: string;
  walletId?: string;
}): { ok: true; passphrase: string } | { ok: false; code: string; message: string } {
  const reconstructed = reconstructCustodySigningKey({
    env: params?.env ?? process.env,
    deviceShare: params?.deviceShare,
    recoveryShare: params?.recoveryShare,
    walletId: params?.walletId,
  });
  if (!reconstructed.ok) {
    return reconstructed;
  }
  try {
    return {
      ok: true,
      passphrase: Buffer.from(reconstructed.signingKey).toString("base64url"),
    };
  } finally {
    zeroizeBuffers([reconstructed.signingKey]);
  }
}

export async function lockWalletCustodyUnlockSessions(params?: {
  host?: string;
  walletId?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<
  | { ok: true; host?: string; walletId?: string; removed: number; remaining: number }
  | {
      ok: false;
      code: string;
      message: string;
      removed?: number;
      remaining?: number;
      host?: string;
      walletId?: string;
    }
> {
  const env = params?.env ?? process.env;
  const localResult = clearLocalUnlockSessions({
    host: params?.host,
    walletId: params?.walletId,
    env,
  });
  if (!localResult.ok) {
    return localResult;
  }
  const splitKeyActive =
    String(env.FASED_WALLET_CUSTODY_MODE ?? "")
      .trim()
      .toLowerCase() === "split-key" &&
    readBooleanFlag(env, "FASED_WALLET_CUSTODY_PASSKEY_CEREMONY") &&
    readBooleanFlag(env, "FASED_WALLET_CUSTODY_EPHEMERAL_RECONSTRUCTION") &&
    readBooleanFlag(env, "FASED_WALLET_CUSTODY_PHASE2_COMPLETE");
  if (!splitKeyActive) {
    return localResult;
  }
  try {
    await lockLocalSignerCustody({
      host: localResult.host,
      walletId: localResult.walletId,
      env,
    });
    return localResult;
  } catch (err) {
    return {
      ok: false,
      code: "custody_signer_lock_failed",
      message: walletDiagnosticErrorMessage(err),
      host: localResult.host,
      walletId: localResult.walletId,
      removed: localResult.removed,
      remaining: localResult.remaining,
    };
  }
}

function reconstructCustodySigningKey(params: {
  env?: NodeJS.ProcessEnv;
  deviceShare?: string;
  recoveryShare?: string;
  walletId?: string;
}): { ok: true; signingKey: Buffer } | { ok: false; code: string; message: string } {
  const env = params.env ?? process.env;
  const shareState = loadShareState(params.walletId, env);
  if (!shareState) {
    return {
      ok: false,
      code: "custody_ceremony_required",
      message: "split-key custody ceremony is not initialized",
    };
  }
  let hot: Buffer | null = null;
  let cold: Buffer | null = null;
  let host: Buffer | null = null;
  let providedShare: Buffer | null = null;
  let secret: Buffer | null = null;
  try {
    if (shareState.scheme === "xor-3of3-v1") {
      hot = decodeBase64Share(shareState.hotShare);
      cold = decodeBase64Share(shareState.coldShare);
      providedShare = decodeTypedCustodyShare(
        params.deviceShare?.trim() || String(env.FASED_WALLET_CUSTODY_DEVICE_SHARE ?? "").trim(),
      ).bytes;
      if (
        !hot ||
        !cold ||
        hot.length !== shareState.secretBytes ||
        cold.length !== shareState.secretBytes
      ) {
        return {
          ok: false,
          code: "custody_shares_invalid",
          message: "stored split-key share payload is invalid",
        };
      }
      if (!providedShare || providedShare.length !== shareState.secretBytes) {
        return {
          ok: false,
          code: "custody_device_share_required",
          message: "device share is required to unlock split-key custody",
        };
      }
      const deviceHash = sha256Hex(providedShare);
      if (!buffersEqualHex(deviceHash, shareState.deviceShareHash)) {
        return {
          ok: false,
          code: "custody_device_share_mismatch",
          message: "device share does not match split-key ceremony state",
        };
      }
      secret = xorBuffers([hot, cold, providedShare]);
    } else {
      host = decodeBase64Share(shareState.hostShare);
      const provided = decodeTypedCustodyShare(
        params.deviceShare?.trim() ||
          params.recoveryShare?.trim() ||
          String(env.FASED_WALLET_CUSTODY_DEVICE_SHARE ?? "").trim(),
      );
      providedShare = provided.bytes;
      if (!host || host.length !== shareState.secretBytes) {
        return {
          ok: false,
          code: "custody_shares_invalid",
          message: "stored split-key share payload is invalid",
        };
      }
      if (!providedShare || providedShare.length !== shareState.secretBytes) {
        return {
          ok: false,
          code: "custody_device_share_required",
          message: "device share or recovery share is required to unlock split-key custody",
        };
      }
      const providedHash = sha256Hex(providedShare);
      const activeDevices = listActiveEnrolledDevices(shareState);
      const matchingDevice =
        shareState.version === 3
          ? (activeDevices.find((device) => buffersEqualHex(providedHash, device.shareHash)) ??
            null)
          : buffersEqualHex(providedHash, shareState.deviceShareHash)
            ? (activeDevices[0] ?? null)
            : null;
      const matchesRecoveryShare = buffersEqualHex(providedHash, shareState.recoveryShareHash);
      const shareType = matchesRecoveryShare
        ? ("recovery" as const)
        : matchingDevice
          ? ("device" as const)
          : null;
      if (!shareType) {
        return {
          ok: false,
          code: "custody_device_share_mismatch",
          message: "provided custody share does not match device or recovery share state",
        };
      }
      if (provided.type !== "unknown" && provided.type !== shareType) {
        return {
          ok: false,
          code: "custody_device_share_mismatch",
          message: "provided custody share type does not match stored ceremony state",
        };
      }
      secret = reconstructSecretShamir2ofN({
        hostShare: host,
        otherShare: providedShare,
        otherX: shareType === "recovery" ? 3 : (matchingDevice?.shareX ?? 2),
      });
    }
    if (!buffersEqualHex(sha256Hex(secret), shareState.secretChecksum)) {
      return {
        ok: false,
        code: "custody_share_integrity_failed",
        message: "split-key reconstruction failed integrity check",
      };
    }
    return {
      ok: true,
      signingKey: Buffer.from(secret),
    };
  } finally {
    zeroizeBuffers([hot, cold, host, providedShare, secret]);
  }
}

export async function activateWalletCustodyUnlockSession(params: {
  host: string;
  approvalToken: string;
  env?: NodeJS.ProcessEnv;
  cfg?: FasedAgentConfig;
  wallet?: ResolvedWalletRuntimeConfig;
  walletId?: string;
  deviceShare?: string;
  ttlSeconds?: number;
}): Promise<
  { ok: true; session: WalletCustodyUnlockSession } | { ok: false; code: string; message: string }
> {
  const env = params.env ?? process.env;
  const host = normalizeHost(params.host);
  if (!host) {
    return {
      ok: false as const,
      code: "invalid_host",
      message: "host is required for custody unlock",
    };
  }
  const consumed = consumeWalletApprovalGrant({
    host,
    operation: "wallet.custody-unlock",
    token: params.approvalToken,
    env,
    cfg: params.cfg,
  });
  if (!consumed.ok) {
    return consumed;
  }
  const scope =
    params.wallet && params.cfg
      ? resolveWalletCustodyScope({
          wallet: params.wallet,
          cfg: params.cfg,
          env,
          walletId: params.walletId,
        })
      : {
          walletId: params.walletId?.trim() || "default",
          role: "vault" as const,
          chains: ["solana"] as WalletChain[],
          allowPrograms: [],
          solana: { maxPerTx: "0", maxDaily: "0" },
        };
  const status = params.wallet
    ? readWalletCustodyStatus({
        wallet: params.wallet,
        env,
        cfg: params.cfg,
        walletId: scope.walletId,
      })
    : null;
  let custodyPassphrase = "";
  if (status?.mode === "split-key-active") {
    const reconstructed = recoverWalletCustodyPassphrase({
      env,
      deviceShare: params.deviceShare,
      walletId: scope.walletId,
    });
    if (!reconstructed.ok) {
      return reconstructed;
    }
    custodyPassphrase = reconstructed.passphrase;
  }
  const session = openUnlockSession({ host, env, scope, ttlSeconds: params.ttlSeconds });
  if (custodyPassphrase) {
    try {
      await unlockLocalSignerCustody({
        sessionId: session.id,
        host: session.host,
        walletId: session.walletId,
        role: session.role,
        chains: session.chains,
        allowPrograms: session.allowPrograms,
        expiresAt: session.expiresAt,
        passphrase: custodyPassphrase,
        solanaMaxPerTx: session.solanaMaxPerTx,
        solanaMaxDaily: session.solanaMaxDaily,
        env,
      });
    } catch (err) {
      clearLocalUnlockSessions({ host: session.host, walletId: session.walletId, env });
      return {
        ok: false,
        code: "custody_signer_unlock_failed",
        message: walletDiagnosticErrorMessage(err),
      };
    }
  }
  setUnlockMaterial({
    sessionId: session.id,
    host: session.host,
    expiresAt: session.expiresAt,
  });
  return {
    ok: true as const,
    session,
  };
}

export async function refreshWalletCustodyUnlockSession(params: {
  host: string;
  env?: NodeJS.ProcessEnv;
  cfg?: FasedAgentConfig;
  wallet?: ResolvedWalletRuntimeConfig;
  walletId?: string;
  deviceShare?: string;
  ttlSeconds?: number;
}): Promise<
  { ok: true; session: WalletCustodyUnlockSession } | { ok: false; code: string; message: string }
> {
  const env = params.env ?? process.env;
  const host = normalizeHost(params.host);
  if (!host) {
    return {
      ok: false as const,
      code: "invalid_host",
      message: "host is required for custody refresh",
    };
  }
  const scope =
    params.wallet && params.cfg
      ? resolveWalletCustodyScope({
          wallet: params.wallet,
          cfg: params.cfg,
          env,
          walletId: params.walletId,
        })
      : {
          walletId: params.walletId?.trim() || "default",
          role: "vault" as const,
          chains: ["solana"] as WalletChain[],
          allowPrograms: [],
          solana: { maxPerTx: "0", maxDaily: "0" },
        };
  const active = getActiveUnlockSession({
    host,
    walletId: scope.walletId,
    env,
  });
  if (!active) {
    return {
      ok: false,
      code: "custody_unlock_required",
      message: `split-key custody for wallet ${scope.walletId} is locked`,
    };
  }
  const status = params.wallet
    ? readWalletCustodyStatus({
        wallet: params.wallet,
        env,
        cfg: params.cfg,
        walletId: scope.walletId,
      })
    : null;
  let custodyPassphrase = "";
  if (status?.mode === "split-key-active") {
    const reconstructed = recoverWalletCustodyPassphrase({
      env,
      deviceShare: params.deviceShare,
      walletId: scope.walletId,
    });
    if (!reconstructed.ok) {
      return reconstructed;
    }
    custodyPassphrase = reconstructed.passphrase;
  }
  const session = openUnlockSession({ host, env, scope, ttlSeconds: params.ttlSeconds });
  if (custodyPassphrase) {
    try {
      await unlockLocalSignerCustody({
        sessionId: session.id,
        host: session.host,
        walletId: session.walletId,
        role: session.role,
        chains: session.chains,
        allowPrograms: session.allowPrograms,
        expiresAt: session.expiresAt,
        passphrase: custodyPassphrase,
        solanaMaxPerTx: session.solanaMaxPerTx,
        solanaMaxDaily: session.solanaMaxDaily,
        env,
      });
    } catch (err) {
      clearLocalUnlockSessions({ host: session.host, walletId: session.walletId, env });
      return {
        ok: false,
        code: "custody_signer_unlock_failed",
        message: walletDiagnosticErrorMessage(err),
      };
    }
  }
  setUnlockMaterial({
    sessionId: session.id,
    host: session.host,
    expiresAt: session.expiresAt,
  });
  return {
    ok: true as const,
    session,
  };
}

export async function enforceWalletCustodyForAutonomousSend(params: {
  wallet: ResolvedWalletRuntimeConfig;
  env?: NodeJS.ProcessEnv;
  cfg?: FasedAgentConfig;
  walletId?: string;
  approvalToken?: string;
  approvalHost?: string;
  deviceShare?: string;
}): Promise<
  | {
      ok: true;
      custodyMode: WalletCustodyStatus["mode"];
      session?: WalletCustodyUnlockSession;
    }
  | {
      ok: false;
      code: string;
      message: string;
    }
> {
  const env = params.env ?? process.env;
  const scope = resolveWalletCustodyScope({
    wallet: params.wallet,
    cfg: params.cfg,
    env,
    walletId: params.walletId,
  });
  const status = readWalletCustodyStatus({
    wallet: params.wallet,
    env,
    cfg: params.cfg,
    walletId: scope.walletId,
  });
  if (status.mode === "single-key") {
    return { ok: true as const, custodyMode: status.mode };
  }
  if (status.mode !== "split-key-active") {
    return {
      ok: false as const,
      code: "custody_phase2_incomplete",
      message:
        "split-key custody is configured but phase-2 controls are incomplete; autonomous signing is blocked",
    };
  }
  const runtimeGuard = enforceSplitKeyRuntimeGuard({
    wallet: params.wallet,
    cfg: params.cfg,
    env,
  });
  if (!runtimeGuard.ok) {
    return runtimeGuard;
  }
  if (resolveWalletApprovalAuthMode(env, params.cfg) !== "webauthn") {
    return {
      ok: false as const,
      code: "custody_webauthn_required",
      message: "split-key custody requires wallet approval auth mode=webauthn",
    };
  }
  const host = normalizeHost(params.approvalHost?.trim() || "127.0.0.1");
  const active = getActiveUnlockSession({ host, walletId: scope.walletId, env });
  if (active) {
    touchUnlockSession({ sessionId: active.id, walletId: scope.walletId, env });
    if (!hasActiveUnlockMaterial({ sessionId: active.id, host })) {
      return {
        ok: false as const,
        code: "custody_unlock_required",
        message:
          "split-key unlock session exists without ephemeral signing material; unlock custody again",
      };
    }
    return {
      ok: true as const,
      custodyMode: status.mode,
      session: active,
    };
  }
  const token = params.approvalToken?.trim() ?? "";
  if (!token) {
    return {
      ok: false as const,
      code: "custody_unlock_required",
      message:
        "split-key custody requires an active unlock session; provide a passkey approval token for operation wallet.custody-unlock",
    };
  }
  const activated = await activateWalletCustodyUnlockSession({
    host,
    approvalToken: token,
    env,
    cfg: params.cfg,
    wallet: params.wallet,
    walletId: scope.walletId,
    deviceShare: params.deviceShare,
  });
  if (!activated.ok) {
    return activated;
  }
  return {
    ok: true as const,
    custodyMode: status.mode,
    session: activated.session,
  };
}

function enforceSplitKeyRuntimeGuard(params: {
  wallet: ResolvedWalletRuntimeConfig;
  cfg?: FasedAgentConfig;
  env?: NodeJS.ProcessEnv;
}):
  | {
      ok: true;
    }
  | {
      ok: false;
      code:
        | "custody_config_required"
        | "custody_provider_unsupported"
        | "custody_runtime_unsupported"
        | "custody_stack_unconfigured"
        | "custody_stack_unhealthy";
      message: string;
    } {
  const env = params.env ?? process.env;
  if (!params.cfg) {
    return {
      ok: false,
      code: "custody_config_required",
      message: "split-key custody requires runtime config to verify signer backend",
    };
  }
  const providerId = resolveWalletProviderId(params.cfg, env);
  if (providerId !== "local-socket-signer") {
    return {
      ok: false,
      code: "custody_provider_unsupported",
      message: "split-key custody requires local-socket-signer",
    };
  }
  if (!params.wallet.enabled) {
    return {
      ok: false,
      code: "custody_stack_unconfigured",
      message: "split-key custody requires wallet runtime to be enabled",
    };
  }
  return { ok: true };
}

export function readWalletCustodyStatus(params: {
  wallet: ResolvedWalletRuntimeConfig;
  cfg?: FasedAgentConfig;
  walletId?: string;
  approvalHost?: string;
  env?: NodeJS.ProcessEnv;
}): WalletCustodyStatus {
  const env = params.env ?? process.env;
  const scope = resolveWalletCustodyScope({
    wallet: params.wallet,
    cfg: params.cfg,
    env,
    walletId: params.walletId,
  });
  const requestedSplitKey =
    String(env.FASED_WALLET_CUSTODY_MODE ?? "")
      .trim()
      .toLowerCase() === "split-key";
  const passkeyCeremonyEnabled = readBooleanFlag(env, "FASED_WALLET_CUSTODY_PASSKEY_CEREMONY");
  const ephemeralReconstructionEnabled = readBooleanFlag(
    env,
    "FASED_WALLET_CUSTODY_EPHEMERAL_RECONSTRUCTION",
  );
  const phase2CompleteFlag = readBooleanFlag(env, "FASED_WALLET_CUSTODY_PHASE2_COMPLETE");
  const shareState = loadShareState(scope.walletId, env);
  const ceremonyInitialized = Boolean(shareState);
  const custodyWallets = readCustodyWalletSet(env);
  const roleAllowsSplitKey = scope.role === "vault";
  const splitKeyEnabled =
    requestedSplitKey &&
    roleAllowsSplitKey &&
    (custodyWallets.size === 0
      ? ceremonyInitialized
      : custodyWallets.has(normalizeWalletIdForCustodyEnv(scope.walletId)));
  const splitKeyActive =
    splitKeyEnabled &&
    phase2CompleteFlag &&
    passkeyCeremonyEnabled &&
    ephemeralReconstructionEnabled &&
    ceremonyInitialized;
  const complete = splitKeyActive;
  const activeUnlock = getActiveUnlockSession({
    host: String(
      params.approvalHost ??
        env.FASED_WALLET_CUSTODY_ACTIVE_HOST ??
        env.FASED_A2A_ORIGIN ??
        "127.0.0.1",
    ),
    walletId: scope.walletId,
    env,
  });

  const notes: string[] = [];
  if (splitKeyEnabled && !splitKeyActive) {
    notes.push("split-key custody is configured but full runtime prerequisites are not complete.");
  }
  if (!splitKeyEnabled) {
    notes.push("single-key custody active (phase-2 split-key disabled).");
  }
  if (splitKeyEnabled && !passkeyCeremonyEnabled) {
    notes.push("split-key mode enabled without passkey ceremony flag.");
  }
  if (splitKeyEnabled && !ephemeralReconstructionEnabled) {
    notes.push("split-key mode enabled without ephemeral reconstruction flag.");
  }
  if (splitKeyEnabled && !phase2CompleteFlag) {
    notes.push("split-key mode enabled without phase-2 completion flag.");
  }
  if (splitKeyEnabled && !ceremonyInitialized) {
    notes.push(
      `split-key ceremony is not initialized for wallet ${scope.walletId}; run \`fased wallet custody-init --wallet ${scope.walletId}\` to generate host/device/recovery shares.`,
    );
  }
  if (splitKeyActive && activeUnlock) {
    notes.push(`split-key custody unlock session is active for wallet ${scope.walletId}.`);
    if (!hasActiveUnlockMaterial({ sessionId: activeUnlock.id, host: activeUnlock.host })) {
      notes.push("unlock session exists but ephemeral signing material is missing; unlock again.");
    }
  }

  return {
    mode: splitKeyActive
      ? "split-key-active"
      : splitKeyEnabled
        ? "split-key-scaffold"
        : "single-key",
    target: {
      walletId: scope.walletId,
      role: scope.role,
    },
    scope: {
      chains: scope.chains,
      allowPrograms: scope.allowPrograms,
      solana: scope.solana,
    },
    unlock: {
      active: Boolean(activeUnlock),
      sessionId: activeUnlock?.id,
      host: activeUnlock?.host,
      expiresAt: activeUnlock?.expiresAt,
    },
    phase2: {
      complete,
      splitKeyEnabled,
      passkeyCeremonyEnabled,
      ephemeralReconstructionEnabled,
      notes,
    },
    ceremony: {
      initialized: ceremonyInitialized,
      scheme: shareState?.scheme,
      secretBytes: shareState?.secretBytes,
      devices: listActiveEnrolledDevices(shareState).map((device) => ({
        id: device.id,
        label: device.label,
        createdAt: device.createdAt,
        revokedAt: device.revokedAt,
      })),
      updatedAt: shareState?.updatedAt,
      path: locateCustodyShareStatePath(scope.walletId, env),
    },
  };
}

export function listSplitKeyWalletCustodyStatuses(params: {
  wallet: ResolvedWalletRuntimeConfig;
  cfg?: FasedAgentConfig;
  env?: NodeJS.ProcessEnv;
}): WalletCustodyStatus[] {
  const env = params.env ?? process.env;
  const walletIds = new Set<string | undefined>();
  const registry = readWalletProviderRegistry(env);
  const registryWalletIds = new Set(
    registry.wallets.map((wallet) => wallet.id.trim()).filter(Boolean),
  );
  const normalizedRegistryWalletIds = new Set(
    [...registryWalletIds].map((walletId) => normalizeWalletIdForCustodyEnv(walletId)),
  );
  const hasNamedWalletRegistry = registry.wallets.length > 0;
  const configuredMiningWalletId =
    typeof params.cfg?.plugins?.entries?.["sat-mining"]?.config?.walletId === "string"
      ? params.cfg.plugins.entries["sat-mining"]?.config?.walletId.trim()
      : "";
  const custodyWallets = readCustodyWalletSet(env);
  for (const wallet of registry.wallets) {
    if (wallet.id.trim()) {
      walletIds.add(wallet.id.trim());
    }
  }
  if (registry.defaultWalletId?.trim()) {
    walletIds.add(registry.defaultWalletId.trim());
  }
  for (const raw of String(env.FASED_WALLET_CUSTODY_WALLETS ?? "").split(",")) {
    if (raw.trim()) {
      walletIds.add(raw.trim());
    }
  }
  for (const target of listCustodyStateTargets(env)) {
    walletIds.add(target);
  }
  if (walletIds.size === 0) {
    walletIds.add(undefined);
  }

  const seen = new Set<string>();
  const out: WalletCustodyStatus[] = [];
  for (const walletId of walletIds) {
    const walletIdValue = walletId?.trim() ?? "";
    const normalizedTarget = normalizeWalletIdForCustodyEnv(walletId);
    const shareState = loadShareState(walletId, env);
    const isCurrentWallet =
      walletId === undefined ||
      registryWalletIds.has(walletIdValue) ||
      normalizedRegistryWalletIds.has(normalizedTarget) ||
      registry.defaultWalletId?.trim() === walletIdValue ||
      configuredMiningWalletId === walletIdValue ||
      normalizeWalletIdForCustodyEnv(configuredMiningWalletId) === normalizedTarget ||
      normalizedTarget === "default" ||
      normalizedTarget === "vault" ||
      (!hasNamedWalletRegistry &&
        (custodyWallets.has(normalizedTarget) || shareState?.role !== undefined));
    if (!isCurrentWallet) {
      continue;
    }
    const status = readWalletCustodyStatus({
      wallet: params.wallet,
      cfg: params.cfg,
      env,
      walletId,
    });
    if (status.mode === "single-key") {
      continue;
    }
    const key = normalizeWalletIdForState(status.target.walletId);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(status);
  }
  return out;
}
