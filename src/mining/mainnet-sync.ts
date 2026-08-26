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
import { VERSION } from "../version.js";
import { callLocalSocketSigner } from "../wallet/providers/local-socket-signer-adapter.js";
import {
  verifySatReleaseDescriptor,
  type SatReleaseAcknowledgement,
} from "./sat-release-descriptor.js";

const DEFAULT_MANIFEST_URL = "https://satcoin.app/.well-known/sat-mainnet-addresses.json";
const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_MANIFEST_BYTES = 512 * 1024;
const MAX_SIDECAR_BYTES = 1024;

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
    publicKeyBase64Url: "F-Kv6SBcZHvs1LQ0LNHwYQ6VuKidpkv1nkgRqggn1kk", // pragma: allowlist secret
    fingerprintSha256: "7fc6f335e13fbba3cee2f833e4ab656a19fd8c0715b9d9097a3e196f0e3a0ebd", // pragma: allowlist secret
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
  releaseDescriptorDigest?: string;
  installedDescriptorDigest?: string | null;
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
  releaseDescriptor?: unknown;
};

type SatMainnetSyncOptions = {
  env?: NodeJS.ProcessEnv;
  manifestUrl?: string;
  signerAcknowledgement?: SatReleaseAcknowledgement | null;
  verifiedManifestSink?: (manifest: {
    raw: string;
    manifestSha256: string;
    signature: string;
    signerAcknowledgementState: string | null;
  }) => void;
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

async function fetchText(
  url: string,
  opts?: { required?: boolean; timeoutMs?: number; maxBytes?: number },
): Promise<string | null> {
  const response = await fetch(url, {
    cache: "no-store",
    redirect: "error",
    signal: timeoutSignal(opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  if (!response.ok) {
    if (opts?.required === false) {
      return null;
    }
    throw new Error(`fetch ${url} failed with HTTP ${response.status}`);
  }
  const maxBytes = opts?.maxBytes ?? MAX_MANIFEST_BYTES;
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new Error(`fetch ${url} exceeded the ${maxBytes}-byte limit`);
  }
  if (!response.body) {
    return "";
  }
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    bytesRead += value.byteLength;
    if (bytesRead > maxBytes) {
      await reader.cancel();
      throw new Error(`fetch ${url} exceeded the ${maxBytes}-byte limit`);
    }
    chunks.push(value);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
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

type VerifiedManifestFetch = {
  raw: string | null;
  manifestSha256: string | null;
  signature: string | null;
  verification: SatMainnetSyncVerification;
  trustKeySource: "embedded" | "environment" | "missing";
};

async function fetchVerifiedManifest(params: {
  manifestUrl: string;
  env: NodeJS.ProcessEnv;
}): Promise<VerifiedManifestFetch> {
  const configuredTrustKeySource = resolveConfiguredTrustKeySource(params.env);
  const expectedHash = parseSha256(
    await fetchText(`${params.manifestUrl}.sha256`, {
      required: false,
      maxBytes: MAX_SIDECAR_BYTES,
    }),
  );
  if (!expectedHash) {
    return {
      raw: null,
      manifestSha256: null,
      signature: null,
      verification: { hash: "missing", signature: "missing" },
      trustKeySource: configuredTrustKeySource,
    };
  }
  const signature = await fetchText(`${params.manifestUrl}.sig`, {
    required: false,
    maxBytes: MAX_SIDECAR_BYTES,
  });
  if (!signature?.trim()) {
    return {
      raw: null,
      manifestSha256: expectedHash,
      signature: null,
      verification: { hash: "valid", signature: "missing" },
      trustKeySource: configuredTrustKeySource,
    };
  }
  const raw = await fetchText(params.manifestUrl, {
    required: true,
    maxBytes: MAX_MANIFEST_BYTES,
  });
  if (raw == null || sha256Hex(raw) !== expectedHash) {
    return {
      raw: null,
      manifestSha256: expectedHash,
      signature: signature.trim(),
      verification: { hash: "invalid", signature: "missing" },
      trustKeySource: configuredTrustKeySource,
    };
  }
  const trustedKeys = resolveTrustedKeys(params.env);
  const verifiedKey = verifyDetachedEd25519Signature({
    payload: raw,
    signatureBase64: signature.trim(),
    trustedKeys,
  });
  if (!verifiedKey) {
    return {
      raw: null,
      manifestSha256: expectedHash,
      signature: signature.trim(),
      verification: { hash: "valid", signature: "invalid" },
      trustKeySource: configuredTrustKeySource,
    };
  }
  return {
    raw,
    manifestSha256: expectedHash,
    signature: signature.trim(),
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

async function readSignerAcknowledgement(
  env: NodeJS.ProcessEnv,
  supplied: SatReleaseAcknowledgement | null | undefined,
): Promise<SatReleaseAcknowledgement | null> {
  if (supplied !== undefined) {
    return supplied;
  }
  const socketPath = String(env.FASED_WALLET_LOCAL_SIGNER_SOCKET ?? "").trim();
  if (!socketPath) {
    return null;
  }
  try {
    const result = await callLocalSocketSigner<{ satRelease?: SatReleaseAcknowledgement }>(
      socketPath,
      { op: "v2.capabilities" },
    );
    return result.satRelease ?? null;
  } catch {
    return null;
  }
}

async function readInstalledDescriptorDigest(env: NodeJS.ProcessEnv): Promise<string | null> {
  const manifestPath = String(env[SAT_RUNTIME_TRUST_ENV_KEYS.manifestPath] ?? "").trim();
  const expectedSha256 = String(env[SAT_RUNTIME_TRUST_ENV_KEYS.manifestSha256] ?? "")
    .trim()
    .toLowerCase();
  if (!manifestPath || !/^[0-9a-f]{64}$/u.test(expectedSha256)) {
    return null;
  }
  try {
    const raw = await fs.readFile(manifestPath, "utf8");
    if (sha256Hex(raw) !== expectedSha256) {
      return null;
    }
    const manifest = JSON.parse(raw) as RawManifest;
    const descriptor = manifest.releaseDescriptor;
    if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
      return null;
    }
    const digest = (descriptor as Record<string, unknown>).descriptorDigest;
    return typeof digest === "string" && /^sha256:[0-9a-f]{64}$/u.test(digest) ? digest : null;
  } catch {
    return null;
  }
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

export async function getSatMainnetSyncStatus(
  opts?: SatMainnetSyncOptions,
): Promise<SatMainnetSyncStatus> {
  const env = opts?.env ?? process.env;
  const manifestUrl = opts?.manifestUrl?.trim() || resolveManifestUrl(env);
  const checkedAt = new Date().toISOString();
  try {
    const verifiedManifest = await fetchVerifiedManifest({ manifestUrl, env });
    const { verification, trustKeySource } = verifiedManifest;
    if (
      verification.hash !== "valid" ||
      verification.signature !== "valid" ||
      verifiedManifest.raw == null ||
      verifiedManifest.manifestSha256 == null ||
      verifiedManifest.signature == null
    ) {
      return {
        ok: false,
        state: "failed",
        manifestUrl,
        checkedAt,
        message: "Mainnet manifest is not verified.",
        localIds: readLocalIds(env),
        officialIds: null,
        needsSync: false,
        verification,
        trustKeySource,
        error:
          trustKeySource === "missing"
            ? "This Fased release has no trusted SAT mainnet manifest key. Update Fased before syncing or mining."
            : "Signed manifest verification failed.",
      };
    }
    const raw = verifiedManifest.raw;
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
        verification,
        trustKeySource,
      };
    }
    const officialIds = readOfficialIds(manifest);
    if (!officialIds) {
      throw new Error("live manifest is missing the complete SAT runtime id tuple");
    }
    const localIds = readLocalIds(env);
    const signerAcknowledgement = await readSignerAcknowledgement(env, opts?.signerAcknowledgement);
    let releaseDescriptor;
    try {
      releaseDescriptor = verifySatReleaseDescriptor({
        descriptor: manifest.releaseDescriptor,
        officialIds,
        manifestSourceCommit: readString(manifest.sourceCommit),
        currentFasedVersion: VERSION,
        signerAcknowledgement,
      });
    } catch (error) {
      return {
        ok: false,
        state: "failed",
        manifestUrl,
        checkedAt,
        manifestStatus,
        releaseTag: readString(manifest.releaseTag) || undefined,
        sourceCommit: readString(manifest.sourceCommit) || undefined,
        message: "Signed SAT mainnet manifest lacks a complete compatible release binding.",
        localIds,
        officialIds,
        needsSync: false,
        verification,
        trustKeySource,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    opts?.verifiedManifestSink?.({
      raw,
      manifestSha256: verifiedManifest.manifestSha256,
      signature: verifiedManifest.signature,
      signerAcknowledgementState: signerAcknowledgement?.state ?? null,
    });
    const installedDescriptorDigest = await readInstalledDescriptorDigest(env);
    const synced =
      signerAcknowledgement?.state === "ACTIVE" &&
      idsEqual(localIds, officialIds) &&
      installedDescriptorDigest === releaseDescriptor.descriptorDigest;
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
        : installedDescriptorDigest === releaseDescriptor.descriptorDigest &&
            signerAcknowledgement?.state !== "ACTIVE"
          ? "Signed SAT release is installed, but its generated Mining contract remains inactive."
          : "Signed SAT mainnet manifest is verified and ready to apply.",
      localIds,
      officialIds,
      needsSync: !synced,
      runtimeFile: resolveWritableSatRuntimeDefaultsFile(env),
      releaseDescriptorDigest: releaseDescriptor.descriptorDigest,
      installedDescriptorDigest,
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

export async function syncSatMainnetRuntimeIds(
  opts?: SatMainnetSyncOptions,
): Promise<SatMainnetSyncStatus> {
  const env = opts?.env ?? process.env;
  let verifiedManifest:
    | {
        raw: string;
        manifestSha256: string;
        signature: string;
        signerAcknowledgementState: string | null;
      }
    | undefined;
  const before = await getSatMainnetSyncStatus({
    env,
    manifestUrl: opts?.manifestUrl,
    signerAcknowledgement: opts?.signerAcknowledgement,
    verifiedManifestSink: (manifest) => {
      verifiedManifest = manifest;
    },
  });
  if (before.state !== "available" || !before.officialIds || !verifiedManifest) {
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
  const runtimeFile = await writeRuntimeIds(before.officialIds, env, {
    rawManifest: verifiedManifest.raw,
    manifestSha256: verifiedManifest.manifestSha256,
    signature: verifiedManifest.signature,
  });
  const installedDescriptorDigest = await readInstalledDescriptorDigest(env);
  const synced =
    verifiedManifest.signerAcknowledgementState === "ACTIVE" &&
    installedDescriptorDigest === before.releaseDescriptorDigest;
  return {
    ...before,
    state: synced ? "synced" : "available",
    needsSync: !synced,
    runtimeFile,
    message: synced
      ? "SAT mainnet IDs synced."
      : installedDescriptorDigest === before.releaseDescriptorDigest
        ? "Signed SAT release is installed, but its generated Mining contract remains inactive."
        : "SAT mainnet IDs were written, but local descriptor persistence did not verify.",
    installedDescriptorDigest,
  };
}
