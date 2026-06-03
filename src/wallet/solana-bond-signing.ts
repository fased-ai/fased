import crypto from "node:crypto";
import { scryptSync } from "node:crypto";
import fs from "node:fs/promises";
import type { FasedAgentConfig } from "../config/config.js";
import { resolveFederationBondWalletId } from "../federation/runtime.js";
import { readWalletProviderRegistry } from "./wallet-provider-registry.js";

type SolanaKeystoreEnvelopeV1 = {
  kind: "fased-solana-keypair";
  version: 1;
  kdf: "scrypt";
  cipher: "aes-256-gcm";
  salt: string;
  iv: string;
  authTag: string;
  ciphertext: string;
  publicKey: string;
};

export type ResolvedBondWallet = {
  walletId: string;
  walletAddress: string;
  providerId?: string;
  keystorePath: string;
};

function normalizeWalletIdForEnvSuffix(walletId?: string): string | undefined {
  const raw = String(walletId ?? "")
    .trim()
    .toLowerCase();
  if (!raw) {
    return undefined;
  }
  const normalized = raw.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized || undefined;
}

function resolveScopedSolanaKeystorePath(env: NodeJS.ProcessEnv, walletId?: string): string {
  const suffix = normalizeWalletIdForEnvSuffix(walletId)?.toUpperCase();
  const scoped = suffix
    ? String(env[`FASED_WALLET_SOLANA_KEYSTORE_PATH__${suffix}`] ?? "").trim()
    : "";
  return scoped || String(env.FASED_WALLET_SOLANA_KEYSTORE_PATH ?? "").trim();
}

async function resolveWalletPassphrase(env: NodeJS.ProcessEnv): Promise<string> {
  const filePath = String(env.FASED_WALLET_PASSPHRASE_FILE ?? "").trim();
  if (filePath) {
    return (await fs.readFile(filePath, "utf-8")).trim();
  }
  return String(env.FASED_WALLET_PASSPHRASE ?? "").trim();
}

function parseSolanaKeystoreEnvelope(raw: string): SolanaKeystoreEnvelopeV1 {
  const parsed = JSON.parse(raw) as Partial<SolanaKeystoreEnvelopeV1>;
  if (
    parsed.kind !== "fased-solana-keypair" ||
    parsed.version !== 1 ||
    parsed.kdf !== "scrypt" ||
    parsed.cipher !== "aes-256-gcm" ||
    typeof parsed.salt !== "string" ||
    typeof parsed.iv !== "string" ||
    typeof parsed.authTag !== "string" ||
    typeof parsed.ciphertext !== "string" ||
    typeof parsed.publicKey !== "string"
  ) {
    throw new Error("invalid Solana keystore envelope");
  }
  return parsed as SolanaKeystoreEnvelopeV1;
}

function decryptSolanaKeypairEnvelope(
  envelope: SolanaKeystoreEnvelopeV1,
  passphrase: string,
): Uint8Array {
  const salt = Buffer.from(envelope.salt, "base64url");
  const iv = Buffer.from(envelope.iv, "base64url");
  const authTag = Buffer.from(envelope.authTag, "base64url");
  const ciphertext = Buffer.from(envelope.ciphertext, "base64url");
  const key = scryptSync(passphrase, salt, 32);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  if (plaintext.length !== 64) {
    throw new Error("invalid Solana secret key length");
  }
  return Uint8Array.from(plaintext);
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function signEd25519Message(message: Buffer, secretKey: Uint8Array): string {
  const seed = secretKey.slice(0, 32);
  const publicKey = secretKey.slice(32, 64);
  const privateKey = crypto.createPrivateKey({
    key: {
      kty: "OKP",
      crv: "Ed25519",
      d: base64url(seed),
      x: base64url(publicKey),
    },
    format: "jwk",
  });
  return crypto.sign(null, message, privateKey).toString("base64");
}

export async function resolveFederationBondWallet(params?: {
  env?: NodeJS.ProcessEnv;
  cfg?: FasedAgentConfig;
  walletId?: string;
}): Promise<ResolvedBondWallet> {
  const env = params?.env ?? process.env;
  const registry = readWalletProviderRegistry(env);
  const walletId =
    params?.walletId?.trim() ||
    resolveFederationBondWalletId({ env, cfg: params?.cfg }) ||
    "default";
  const registryWallet = registry.wallets.find((entry) => entry.id === walletId);
  const keystorePath = resolveScopedSolanaKeystorePath(env, walletId);
  if (!keystorePath) {
    throw new Error(`bond Vault ${walletId} has no Solana keystore path configured`);
  }
  const raw = await fs.readFile(keystorePath, "utf-8");
  const envelope = parseSolanaKeystoreEnvelope(raw);
  const walletAddress =
    registryWallet?.addresses?.solana?.trim() || envelope.publicKey.trim() || "";
  if (!walletAddress) {
    throw new Error(`bond Vault ${walletId} has no Solana address`);
  }
  return {
    walletId,
    walletAddress,
    providerId: registryWallet?.providerId,
    keystorePath,
  };
}

export async function signFederationBondChallenge(params: {
  payload: string;
  env?: NodeJS.ProcessEnv;
  cfg?: FasedAgentConfig;
  walletId?: string;
}): Promise<ResolvedBondWallet & { signatureBase64: string }> {
  const env = params.env ?? process.env;
  const resolved = await resolveFederationBondWallet({
    env,
    cfg: params.cfg,
    walletId: params.walletId,
  });
  const passphrase = await resolveWalletPassphrase(env);
  if (!passphrase) {
    throw new Error("wallet passphrase is required to sign federation bond challenge");
  }
  const raw = await fs.readFile(resolved.keystorePath, "utf-8");
  const envelope = parseSolanaKeystoreEnvelope(raw);
  const secretKey = decryptSolanaKeypairEnvelope(envelope, passphrase);
  if (envelope.publicKey.trim() && envelope.publicKey.trim() !== resolved.walletAddress) {
    throw new Error("bond Vault address does not match keystore public key");
  }
  return {
    ...resolved,
    signatureBase64: signEd25519Message(Buffer.from(params.payload, "utf-8"), secretKey),
  };
}
