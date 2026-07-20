import { createHash, createPublicKey, verify } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  resolveSatRuntimeIds,
  resolveWritableSatRuntimeDefaultsFile,
  SAT_RUNTIME_ENV_KEYS,
  SAT_RUNTIME_TRUST_ENV_KEYS,
  type SatRuntimeIds,
} from "../config/sat-runtime-ids.js";

const DEFAULT_MANIFEST_URL = "https://satcoin.app/.well-known/sat-mainnet-addresses.json";
const DEFAULT_TIMEOUT_MS = 12_000;

type ManifestStatus = "not_live" | "live";

type TrustedManifestKey = {
  id: string;
  publicKeyBase64Url: string;
};

type EmbeddedTrustedManifestKey = TrustedManifestKey & {
  fingerprintSha256: string;
};

type ResolvedTrustedManifestKey = TrustedManifestKey & {
  source: "embedded" | "environment";
};

// Populated only with public keys approved for the official SAT manifest publisher.
// Never add a placeholder key here: live mainnet remains fail-closed until a
// release contains an official trust anchor.
const EMBEDDED_TRUSTED_KEYS: EmbeddedTrustedManifestKey[] = [
  {
    id: "sat-mainnet-2026-01",
    publicKeyBase64Url: "F-Kv6SBcZHvs1LQ0LNHwYQ6VuKidpkv1nkgRqggn1kk",
    fingerprintSha256: "7fc6f335e13fbba3cee2f833e4ab656a19fd8c0715b9d9097a3e196f0e3a0ebd",
  },
];

for (const key of EMBEDDED_TRUSTED_KEYS) {
  const publicKeyBytes = Buffer.from(key.publicKeyBase64Url, "base64url");
  const fingerprint = createHash("sha256").update(publicKeyBytes).digest("hex");
  if (publicKeyBytes.length !== 32 || fingerprint !== key.fingerprintSha256) {
    throw new Error(`Invalid embedded SAT mainnet manifest key: ${key.id}`);
  }
}

export type SatMainnetSyncState = "not_live" | "available" | "synced" | "failed";

export type SatMainnetSyncVerification = {
  hash: "valid" | "missing" | "invalid" | "not_required";
  signature: "valid" | "missing" | "invalid" | "not_required";
};

export type SatMainnetSyncStatus = {
  ok: boolean;
  state: SatMainnetSyncState;
  manifestUrl: string;
  checkedAt: string;
  message: string;
  manifestStatus?: ManifestStatus;
  releaseTag?: string;
  sourceCommit?: string;
  localIds?: SatRuntimeIds | null;
  officialIds?: SatRuntimeIds | null;
  needsSync?: boolean;
  runtimeFile?: string;
  verification: SatMainnetSyncVerification;
  trustKeySource?: "embedded" | "environment" | "missing" | "not_required";
  error?: string;
};

type RawManifest = {
  schema?: unknown;
  network?: unknown;
  status?: unknown;
  releaseTag?: unknown;
  sourceCommit?: unknown;
  sat?: {
    mint?: unknown;
    programId?: unknown;
    mintProgramId?: unknown;
    bondProgramId?: unknown;
  };
};

function trustedKeysFromEnv(env: NodeJS.ProcessEnv): ResolvedTrustedManifestKey[] {
  const raw = String(env.FASED_SAT_MAINNET_MANIFEST_PUBLIC_KEY ?? "").trim();
  const id = String(env.FASED_SAT_MAINNET_MANIFEST_PUBLIC_KEY_ID ?? "env").trim() || "env";
  const rotated = String(env.FASED_SAT_MAINNET_MANIFEST_PUBLIC_KEYS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((publicKeyBase64Url, index) => ({
      id: `${id}-${index + 1}`,
      publicKeyBase64Url,
      source: "environment" as const,
    }));
  return [
    ...(raw ? [{ id, publicKeyBase64Url: raw, source: "environment" as const }] : []),
    ...rotated,
  ];
}

function resolveTrustedKeys(env: NodeJS.ProcessEnv): ResolvedTrustedManifestKey[] {
  return [
    ...EMBEDDED_TRUSTED_KEYS.map((key) => ({ ...key, source: "embedded" as const })),
    ...trustedKeysFromEnv(env),
  ];
}

function resolveConfiguredTrustKeySource(
  env: NodeJS.ProcessEnv,
): "embedded" | "environment" | "missing" {
  if (EMBEDDED_TRUSTED_KEYS.length > 0) {
    return "embedded";
  }
  return trustedKeysFromEnv(env).length > 0 ? "environment" : "missing";
}

function resolveManifestUrl(env: NodeJS.ProcessEnv): string {
  return String(env.FASED_SAT_MAINNET_MANIFEST_URL ?? "").trim() || DEFAULT_MANIFEST_URL;
}

function timeoutSignal(timeoutMs: number): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const maybeUnref = timer as unknown as { unref?: () => void };
  maybeUnref.unref?.();
  return controller.signal;
}

async function fetchText(url: string, opts?: { required?: boolean; timeoutMs?: number }) {
  const response = await fetch(url, {
    cache: "no-store",
    signal: timeoutSignal(opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  if (!response.ok) {
    if (opts?.required === false) {
      return null;
    }
    throw new Error(`fetch ${url} failed with HTTP ${response.status}`);
  }
  return await response.text();
}

function sha256Hex(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function parseSha256(raw: string | null): string | null {
  const match = raw?.match(/\b[a-f0-9]{64}\b/i);
  return match?.[0]?.toLowerCase() ?? null;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readManifestStatus(manifest: RawManifest): ManifestStatus {
  const status = readString(manifest.status);
  if (status === "live" || status === "not_live") {
    return status;
  }
  return manifest.sat?.mint && manifest.sat?.programId && manifest.sat?.mintProgramId
    ? "live"
    : "not_live";
}

function readOfficialIds(manifest: RawManifest): SatRuntimeIds | null {
  const sat = manifest.sat;
  const ids = {
    programId: readString(sat?.programId),
    bondProgramId: readString(sat?.bondProgramId),
    mintAddress: readString(sat?.mint),
    mintProgramId: readString(sat?.mintProgramId),
  };
  return ids.programId && ids.bondProgramId && ids.mintAddress && ids.mintProgramId ? ids : null;
}

function normalizeBase64Url(raw: string): string {
  return raw.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function verifyDetachedEd25519Signature(params: {
  payload: string;
  signatureBase64: string;
  trustedKeys: ResolvedTrustedManifestKey[];
}): ResolvedTrustedManifestKey | null {
  const signature = Buffer.from(params.signatureBase64, "base64");
  for (const trustedKey of params.trustedKeys) {
    try {
      const publicKey = createPublicKey({
        format: "jwk",
        key: {
          kty: "OKP",
          crv: "Ed25519",
          x: normalizeBase64Url(trustedKey.publicKeyBase64Url),
        },
      });
      if (verify(null, Buffer.from(params.payload), publicKey, signature)) {
        return trustedKey;
      }
    } catch {}
  }
  return null;
}

async function verifyLiveManifest(params: {
  manifestUrl: string;
  raw: string;
  env: NodeJS.ProcessEnv;
}): Promise<{
  verification: SatMainnetSyncVerification;
  trustKeySource: "embedded" | "environment" | "missing";
}> {
  const configuredTrustKeySource = resolveConfiguredTrustKeySource(params.env);
  const expectedHash = parseSha256(
    await fetchText(`${params.manifestUrl}.sha256`, { required: false }).catch(() => null),
  );
  if (!expectedHash) {
    return {
      verification: { hash: "missing", signature: "missing" },
      trustKeySource: configuredTrustKeySource,
    };
  }
  if (sha256Hex(params.raw) !== expectedHash) {
    return {
      verification: { hash: "invalid", signature: "missing" },
      trustKeySource: configuredTrustKeySource,
    };
  }
  const signature = await fetchText(`${params.manifestUrl}.sig`, { required: false }).catch(
    () => null,
  );
  if (!signature?.trim()) {
    return {
      verification: { hash: "valid", signature: "missing" },
      trustKeySource: configuredTrustKeySource,
    };
  }
  const trustedKeys = resolveTrustedKeys(params.env);
  const verifiedKey = verifyDetachedEd25519Signature({
    payload: params.raw,
    signatureBase64: signature.trim(),
    trustedKeys,
  });
  if (!verifiedKey) {
    return {
      verification: { hash: "valid", signature: "invalid" },
      trustKeySource: configuredTrustKeySource,
    };
  }
  return {
    verification: { hash: "valid", signature: "valid" },
    trustKeySource: verifiedKey.source,
  };
}

function readLocalIds(env: NodeJS.ProcessEnv): SatRuntimeIds | null {
  try {
    return resolveSatRuntimeIds(env);
  } catch {
    return null;
  }
}

function idsEqual(left: SatRuntimeIds | null, right: SatRuntimeIds | null): boolean {
  return Boolean(
    left &&
    right &&
    left.programId === right.programId &&
    left.bondProgramId === right.bondProgramId &&
    left.mintAddress === right.mintAddress &&
    left.mintProgramId === right.mintProgramId,
  );
}

function buildEnvFile(
  ids: SatRuntimeIds,
  trust: { manifestPath: string; manifestSha256: string; manifestSignaturePath: string },
): string {
  return [
    "# Managed by Fased Agent official SAT mainnet sync.",
    `${SAT_RUNTIME_ENV_KEYS.programId}=${ids.programId}`,
    `${SAT_RUNTIME_ENV_KEYS.bondProgramId}=${ids.bondProgramId}`,
    `${SAT_RUNTIME_ENV_KEYS.mintAddress}=${ids.mintAddress}`,
    `${SAT_RUNTIME_ENV_KEYS.mintProgramId}=${ids.mintProgramId}`,
    `${SAT_RUNTIME_TRUST_ENV_KEYS.manifestPath}=${trust.manifestPath}`,
    `${SAT_RUNTIME_TRUST_ENV_KEYS.manifestSha256}=${trust.manifestSha256}`,
    `${SAT_RUNTIME_TRUST_ENV_KEYS.manifestSignaturePath}=${trust.manifestSignaturePath}`,
    "",
  ].join("\n");
}

async function writeRuntimeIds(
  ids: SatRuntimeIds,
  env: NodeJS.ProcessEnv,
  trust: { rawManifest: string; manifestSha256: string; signature: string },
): Promise<string> {
  const runtimeFile = resolveWritableSatRuntimeDefaultsFile(env);
  const manifestPath = `${runtimeFile}.manifest.json`;
  const manifestSignaturePath = `${runtimeFile}.manifest.sig`;
  await fs.mkdir(path.dirname(runtimeFile), { recursive: true });
  await fs.writeFile(manifestPath, trust.rawManifest, { mode: 0o600 });
  await fs.writeFile(manifestSignaturePath, `${trust.signature.trim()}\n`, { mode: 0o600 });
  await fs.writeFile(
    runtimeFile,
    buildEnvFile(ids, {
      manifestPath,
      manifestSha256: trust.manifestSha256,
      manifestSignaturePath,
    }),
    { mode: 0o600 },
  );
  await Promise.all([
    fs.chmod(manifestPath, 0o600),
    fs.chmod(manifestSignaturePath, 0o600),
    fs.chmod(runtimeFile, 0o600),
  ]);
  env[SAT_RUNTIME_ENV_KEYS.programId] = ids.programId;
  env[SAT_RUNTIME_ENV_KEYS.bondProgramId] = ids.bondProgramId;
  env[SAT_RUNTIME_ENV_KEYS.mintAddress] = ids.mintAddress;
  env[SAT_RUNTIME_ENV_KEYS.mintProgramId] = ids.mintProgramId;
  env[SAT_RUNTIME_TRUST_ENV_KEYS.manifestPath] = manifestPath;
  env[SAT_RUNTIME_TRUST_ENV_KEYS.manifestSha256] = trust.manifestSha256;
  env[SAT_RUNTIME_TRUST_ENV_KEYS.manifestSignaturePath] = manifestSignaturePath;
  return runtimeFile;
}

export async function getSatMainnetSyncStatus(opts?: {
  env?: NodeJS.ProcessEnv;
  manifestUrl?: string;
}): Promise<SatMainnetSyncStatus> {
  const env = opts?.env ?? process.env;
  const manifestUrl = opts?.manifestUrl?.trim() || resolveManifestUrl(env);
  const checkedAt = new Date().toISOString();
  try {
    const raw = await fetchText(manifestUrl, { required: true });
    if (raw == null) {
      throw new Error("manifest response was empty");
    }
    const manifest = JSON.parse(raw) as RawManifest;
    if (readString(manifest.schema) !== "sat-mainnet-addresses.v1") {
      throw new Error("manifest schema is not sat-mainnet-addresses.v1");
    }
    if (readString(manifest.network) !== "mainnet-beta") {
      throw new Error("manifest network is not mainnet-beta");
    }
    const manifestStatus = readManifestStatus(manifest);
    if (manifestStatus === "not_live") {
      return {
        ok: true,
        state: "not_live",
        manifestUrl,
        checkedAt,
        manifestStatus,
        message: "Satcoin mainnet is not live yet.",
        localIds: readLocalIds(env),
        officialIds: null,
        needsSync: false,
        verification: { hash: "not_required", signature: "not_required" },
        trustKeySource: "not_required",
      };
    }
    const officialIds = readOfficialIds(manifest);
    if (!officialIds) {
      throw new Error("live manifest is missing the complete SAT runtime id tuple");
    }
    const verifiedManifest = await verifyLiveManifest({ manifestUrl, raw, env });
    const { verification, trustKeySource } = verifiedManifest;
    const localIds = readLocalIds(env);
    if (verification.hash !== "valid" || verification.signature !== "valid") {
      return {
        ok: false,
        state: "failed",
        manifestUrl,
        checkedAt,
        manifestStatus,
        releaseTag: readString(manifest.releaseTag) || undefined,
        sourceCommit: readString(manifest.sourceCommit) || undefined,
        message: "Mainnet manifest is live but not verified.",
        localIds,
        officialIds,
        needsSync: false,
        verification,
        trustKeySource,
        error:
          trustKeySource === "missing"
            ? "This Fased release has no trusted SAT mainnet manifest key. Update Fased before syncing or mining."
            : "Signed manifest verification failed.",
      };
    }
    const synced = idsEqual(localIds, officialIds);
    return {
      ok: true,
      state: synced ? "synced" : "available",
      manifestUrl,
      checkedAt,
      manifestStatus,
      releaseTag: readString(manifest.releaseTag) || undefined,
      sourceCommit: readString(manifest.sourceCommit) || undefined,
      message: synced
        ? "Fased Agent is synced to the signed SAT mainnet manifest."
        : "Signed SAT mainnet manifest is verified and ready to apply.",
      localIds,
      officialIds,
      needsSync: !synced,
      runtimeFile: resolveWritableSatRuntimeDefaultsFile(env),
      verification,
      trustKeySource,
    };
  } catch (error) {
    return {
      ok: false,
      state: "failed",
      manifestUrl,
      checkedAt,
      message: "SAT mainnet sync check failed.",
      localIds: readLocalIds(env),
      officialIds: null,
      needsSync: false,
      verification: { hash: "missing", signature: "missing" },
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function syncSatMainnetRuntimeIds(opts?: {
  env?: NodeJS.ProcessEnv;
  manifestUrl?: string;
}): Promise<SatMainnetSyncStatus> {
  const env = opts?.env ?? process.env;
  const before = await getSatMainnetSyncStatus({ env, manifestUrl: opts?.manifestUrl });
  if (before.state !== "available" || !before.officialIds) {
    return before.state === "synced"
      ? before
      : {
          ...before,
          ok: false,
          message:
            before.state === "not_live"
              ? "Satcoin mainnet is not live yet."
              : before.message || "SAT mainnet manifest is not ready to apply.",
        };
  }
  const manifestUrl = opts?.manifestUrl?.trim() || resolveManifestUrl(env);
  const rawManifest = await fetchText(manifestUrl, { required: true });
  const manifestSha256 = parseSha256(await fetchText(`${manifestUrl}.sha256`, { required: true }));
  const signature = await fetchText(`${manifestUrl}.sig`, { required: true });
  if (!rawManifest || !manifestSha256 || !signature?.trim()) {
    return {
      ...before,
      ok: false,
      state: "failed",
      message: "Verified SAT manifest artifacts could not be persisted for the native signer.",
      error: "signed SAT runtime manifest, hash, or detached signature is missing",
    };
  }
  const finalVerification = await verifyLiveManifest({ manifestUrl, raw: rawManifest, env });
  if (
    finalVerification.verification.hash !== "valid" ||
    finalVerification.verification.signature !== "valid" ||
    sha256Hex(rawManifest) !== manifestSha256
  ) {
    return {
      ...before,
      ok: false,
      state: "failed",
      message: "SAT manifest changed before signer runtime persistence.",
      verification: finalVerification.verification,
      trustKeySource: finalVerification.trustKeySource,
      error: "signed SAT runtime manifest verification raced or failed",
    };
  }
  const persistedManifest = JSON.parse(rawManifest) as RawManifest;
  if (!idsEqual(readOfficialIds(persistedManifest), before.officialIds)) {
    return {
      ...before,
      ok: false,
      state: "failed",
      message: "SAT manifest IDs changed before signer runtime persistence.",
      error: "signed SAT runtime ID tuple changed during sync",
    };
  }
  const runtimeFile = await writeRuntimeIds(before.officialIds, env, {
    rawManifest,
    manifestSha256,
    signature,
  });
  const after = await getSatMainnetSyncStatus({ env, manifestUrl: opts?.manifestUrl });
  return {
    ...after,
    runtimeFile,
    message:
      after.state === "synced"
        ? "SAT mainnet IDs synced."
        : "SAT mainnet IDs were written, but status did not confirm synced state.",
  };
}
