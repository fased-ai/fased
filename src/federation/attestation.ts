import crypto from "node:crypto";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
} from "../infra/device-identity.js";
import { resolveCommitHash } from "../infra/git-commit.js";
import { VERSION } from "../version.js";

export const FEDERATION_ATTESTATION_SCHEMA_URL = "https://domain.com/schemas/attestation-v1.json";

export type AttestationPluginRef = {
  name: string;
  version: string;
  hash: string;
};

export type AttestationPayload = {
  schema: string;
  nodeId: string;
  handle: string;
  version: string;
  coreHash: string;
  plugins: AttestationPluginRef[];
  wallet: { chain: string; address: string };
  issuedAt: string;
  expiresAt: string;
  challengeNonce?: string;
  signature: { type: "ed25519"; publicKey: string; value: string };
};

export type AttestationOptions = {
  handle: string;
  ttlMs?: number;
  schemaUrl?: string;
  walletChain?: string;
  walletAddress?: string;
  plugins?: AttestationPluginRef[];
  now?: Date;
  challengeNonce?: string;
};

function computeCoreHash(): string {
  const commit = resolveCommitHash();
  const payload = JSON.stringify({ version: VERSION, commit: commit ?? null });
  const hash = crypto.createHash("sha256").update(payload).digest("hex");
  return `sha256:${hash}`;
}

function canonicalizePayload(payload: Omit<AttestationPayload, "signature">): string {
  const plugins = [...payload.plugins].toSorted((a, b) => a.name.localeCompare(b.name));
  const ordered: Omit<AttestationPayload, "signature"> = {
    schema: payload.schema,
    nodeId: payload.nodeId,
    handle: payload.handle,
    version: payload.version,
    coreHash: payload.coreHash,
    plugins,
    wallet: payload.wallet,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
    ...(payload.challengeNonce ? { challengeNonce: payload.challengeNonce } : {}),
  };
  return JSON.stringify(ordered);
}

export function buildAttestation(options: AttestationOptions): AttestationPayload {
  const handle = options.handle.trim();
  if (!handle) {
    throw new Error("handle is required");
  }
  const identity = loadOrCreateDeviceIdentity();
  const issuedAt = options.now ?? new Date();
  const ttlMs =
    options.ttlMs ?? Number(process.env.FASED_FEDERATION_ATTESTATION_TTL_MS ?? "3600000");
  const expiresAt = new Date(issuedAt.getTime() + ttlMs);
  const schemaUrl =
    options.schemaUrl?.trim() ||
    process.env.FASED_FEDERATION_SCHEMA_URL?.trim() ||
    FEDERATION_ATTESTATION_SCHEMA_URL;
  const walletChain =
    options.walletChain?.trim() || process.env.FASED_FEDERATION_WALLET_CHAIN?.trim() || "solana";
  const walletAddress =
    options.walletAddress?.trim() ||
    process.env.FASED_FEDERATION_WALLET_ADDRESS?.trim() ||
    identity.deviceId;
  const payload: Omit<AttestationPayload, "signature"> = {
    schema: schemaUrl,
    nodeId: identity.deviceId,
    handle,
    version: VERSION,
    coreHash: computeCoreHash(),
    plugins: options.plugins ?? [],
    wallet: { chain: walletChain, address: walletAddress },
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    ...(options.challengeNonce?.trim() ? { challengeNonce: options.challengeNonce.trim() } : {}),
  };
  const signaturePayload = canonicalizePayload(payload);
  const signatureValue = signDevicePayload(identity.privateKeyPem, signaturePayload);
  return {
    ...payload,
    signature: {
      type: "ed25519",
      publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
      value: signatureValue,
    },
  };
}
