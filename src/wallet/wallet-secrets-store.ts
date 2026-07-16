import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import type { WalletProviderId } from "../config/types.wallet.js";

const SECRETS_DIR_MODE = 0o700;
const SECRET_FILE_MODE = 0o600;
const MASTER_KEY_BYTES = 32;
const IV_BYTES = 12;
const WALLET_RPC_SECRET_FILENAME = "wallet-rpc.v1.enc.json";
const MASTER_KEY_FILENAME = "master.key";

export type WalletRpcSecretChain = "solana" | "multi";

export type WalletRpcSecretRecord = {
  chain: WalletRpcSecretChain;
  provider: string;
  apiKey: string;
  rpcUrl?: string;
  createdAt: string;
  updatedAt: string;
};

type EncryptedSecretFile = {
  version: 1;
  algorithm: "aes-256-gcm";
  iv: string;
  authTag: string;
  ciphertext: string;
};

export type WalletProviderSecretRecord = {
  providerId: WalletProviderId;
  credentials: Record<string, string>;
  createdAt: string;
  updatedAt: string;
};

export type WalletProviderSecretStatus = {
  configured: boolean;
  providerId: WalletProviderId;
  updatedAt?: string;
  fields: string[];
  path: string;
};

export type WalletRpcSecretStatus = {
  configured: boolean;
  providerId?: WalletProviderId;
  chain?: WalletRpcSecretChain;
  provider?: string;
  updatedAt?: string;
  path: string;
};

function ensureSecretsDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = path.join(resolveStateDir(env), "secrets");
  fs.mkdirSync(dir, { recursive: true, mode: SECRETS_DIR_MODE });
  try {
    fs.chmodSync(dir, SECRETS_DIR_MODE);
  } catch {
    // best effort
  }
  return dir;
}

function resolveMasterKeyPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(ensureSecretsDir(env), MASTER_KEY_FILENAME);
}

function resolveWalletRpcSecretPath(
  env: NodeJS.ProcessEnv = process.env,
  providerId?: WalletProviderId,
): string {
  if (providerId) {
    const safeProvider = providerId.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
    return path.join(ensureSecretsDir(env), `wallet-rpc-${safeProvider}.v1.enc.json`);
  }
  return path.join(ensureSecretsDir(env), WALLET_RPC_SECRET_FILENAME);
}

function resolveWalletProviderSecretPath(
  providerId: WalletProviderId,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const safeProvider = providerId.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  return path.join(ensureSecretsDir(env), `wallet-provider-${safeProvider}.v1.enc.json`);
}

function readOrCreateMasterKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const keyPath = resolveMasterKeyPath(env);
  if (fs.existsSync(keyPath)) {
    const raw = fs.readFileSync(keyPath, "utf8").trim();
    const parsed = Buffer.from(raw, "hex");
    if (parsed.length === MASTER_KEY_BYTES) {
      return parsed;
    }
  }
  const key = randomBytes(MASTER_KEY_BYTES);
  fs.writeFileSync(keyPath, `${key.toString("hex")}\n`, {
    mode: SECRET_FILE_MODE,
    encoding: "utf8",
  });
  try {
    fs.chmodSync(keyPath, SECRET_FILE_MODE);
  } catch {
    // best effort
  }
  return key;
}

function encryptPayload(
  payload: WalletRpcSecretRecord,
  env: NodeJS.ProcessEnv = process.env,
): EncryptedSecretFile {
  const key = readOrCreateMasterKey(env);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    version: 1,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64url"),
    authTag: authTag.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
}

function decryptPayload(
  encrypted: EncryptedSecretFile,
  env: NodeJS.ProcessEnv = process.env,
): WalletRpcSecretRecord | null {
  if (
    encrypted.version !== 1 ||
    encrypted.algorithm !== "aes-256-gcm" ||
    typeof encrypted.iv !== "string" ||
    typeof encrypted.authTag !== "string" ||
    typeof encrypted.ciphertext !== "string"
  ) {
    return null;
  }
  try {
    const key = readOrCreateMasterKey(env);
    const iv = Buffer.from(encrypted.iv, "base64url");
    const authTag = Buffer.from(encrypted.authTag, "base64url");
    const ciphertext = Buffer.from(encrypted.ciphertext, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const parsed = JSON.parse(plaintext.toString("utf8")) as Partial<WalletRpcSecretRecord>;
    const chain = parsed.chain;
    if (chain !== "solana" && chain !== "multi") {
      return null;
    }
    const provider = typeof parsed.provider === "string" ? parsed.provider.trim() : "";
    const apiKey = typeof parsed.apiKey === "string" ? parsed.apiKey.trim() : "";
    const createdAt = typeof parsed.createdAt === "string" ? parsed.createdAt : "";
    const updatedAt = typeof parsed.updatedAt === "string" ? parsed.updatedAt : "";
    if (!provider || !apiKey || !createdAt || !updatedAt) {
      return null;
    }
    return {
      chain,
      provider,
      apiKey,
      rpcUrl:
        typeof parsed.rpcUrl === "string" && parsed.rpcUrl.trim()
          ? parsed.rpcUrl.trim()
          : undefined,
      createdAt,
      updatedAt,
    };
  } catch {
    return null;
  }
}

function decryptProviderPayload(
  encrypted: EncryptedSecretFile,
  env: NodeJS.ProcessEnv = process.env,
): WalletProviderSecretRecord | null {
  if (
    encrypted.version !== 1 ||
    encrypted.algorithm !== "aes-256-gcm" ||
    typeof encrypted.iv !== "string" ||
    typeof encrypted.authTag !== "string" ||
    typeof encrypted.ciphertext !== "string"
  ) {
    return null;
  }
  try {
    const key = readOrCreateMasterKey(env);
    const iv = Buffer.from(encrypted.iv, "base64url");
    const authTag = Buffer.from(encrypted.authTag, "base64url");
    const ciphertext = Buffer.from(encrypted.ciphertext, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const parsed = JSON.parse(plaintext.toString("utf8")) as Partial<WalletProviderSecretRecord>;
    const providerId = ((): WalletProviderId | null => {
      switch ((parsed.providerId ?? "").trim()) {
        case "embedded-keystore":
        case "local-socket-signer":
        case "alchemy":
        case "turnkey":
        case "wallet-standard":
        case "privy":
          return parsed.providerId as WalletProviderId;
        default:
          return null;
      }
    })();
    if (!providerId || typeof parsed.credentials !== "object" || parsed.credentials == null) {
      return null;
    }
    const createdAt = typeof parsed.createdAt === "string" ? parsed.createdAt : "";
    const updatedAt = typeof parsed.updatedAt === "string" ? parsed.updatedAt : "";
    if (!createdAt || !updatedAt) {
      return null;
    }
    const credentials: Record<string, string> = {};
    for (const [keyName, value] of Object.entries(parsed.credentials as Record<string, unknown>)) {
      if (typeof value !== "string") {
        continue;
      }
      const normalizedKey = keyName.trim();
      const normalizedValue = value.trim();
      if (!normalizedKey || !normalizedValue) {
        continue;
      }
      credentials[normalizedKey] = normalizedValue;
    }
    if (Object.keys(credentials).length === 0) {
      return null;
    }
    return {
      providerId,
      credentials,
      createdAt,
      updatedAt,
    };
  } catch {
    return null;
  }
}

function encryptProviderPayload(
  payload: WalletProviderSecretRecord,
  env: NodeJS.ProcessEnv = process.env,
): EncryptedSecretFile {
  const key = readOrCreateMasterKey(env);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    version: 1,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64url"),
    authTag: authTag.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
}

export function saveWalletRpcSecret(
  input: {
    chain: WalletRpcSecretChain;
    providerId?: WalletProviderId;
    provider: string;
    apiKey: string;
    rpcUrl?: string;
  },
  env: NodeJS.ProcessEnv = process.env,
): WalletRpcSecretRecord {
  const provider = input.provider.trim();
  const apiKey = input.apiKey.trim();
  if (!provider) {
    throw new Error("provider is required");
  }
  if (!apiKey) {
    throw new Error("apiKey is required");
  }
  const now = new Date().toISOString();
  const existing = loadWalletRpcSecret(env, { providerId: input.providerId });
  const record: WalletRpcSecretRecord = {
    chain: input.chain,
    provider,
    apiKey,
    rpcUrl: input.rpcUrl?.trim() || undefined,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  const encrypted = encryptPayload(record, env);
  const secretPath = resolveWalletRpcSecretPath(env, input.providerId);
  fs.writeFileSync(secretPath, `${JSON.stringify(encrypted, null, 2)}\n`, {
    mode: SECRET_FILE_MODE,
    encoding: "utf8",
  });
  try {
    fs.chmodSync(secretPath, SECRET_FILE_MODE);
  } catch {
    // best effort
  }
  return record;
}

export function saveWalletProviderSecret(
  input: {
    providerId: WalletProviderId;
    credentials: Record<string, string>;
  },
  env: NodeJS.ProcessEnv = process.env,
): WalletProviderSecretRecord {
  const providerId = input.providerId;
  const credentials: Record<string, string> = {};
  for (const [keyName, value] of Object.entries(input.credentials ?? {})) {
    const normalizedKey = keyName.trim();
    const normalizedValue = String(value ?? "").trim();
    if (!normalizedKey || !normalizedValue) {
      continue;
    }
    credentials[normalizedKey] = normalizedValue;
  }
  if (Object.keys(credentials).length === 0) {
    throw new Error("at least one provider credential is required");
  }
  const now = new Date().toISOString();
  const existing = loadWalletProviderSecret(providerId, env);
  const record: WalletProviderSecretRecord = {
    providerId,
    credentials,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  const encrypted = encryptProviderPayload(record, env);
  const secretPath = resolveWalletProviderSecretPath(providerId, env);
  fs.writeFileSync(secretPath, `${JSON.stringify(encrypted, null, 2)}\n`, {
    mode: SECRET_FILE_MODE,
    encoding: "utf8",
  });
  try {
    fs.chmodSync(secretPath, SECRET_FILE_MODE);
  } catch {
    // best effort
  }
  return record;
}

export function loadWalletRpcSecret(
  env: NodeJS.ProcessEnv = process.env,
  options?: { providerId?: WalletProviderId },
): WalletRpcSecretRecord | null {
  const candidatePaths = options?.providerId
    ? [resolveWalletRpcSecretPath(env, options.providerId), resolveWalletRpcSecretPath(env)]
    : [resolveWalletRpcSecretPath(env)];
  for (const secretPath of candidatePaths) {
    if (!fs.existsSync(secretPath)) {
      continue;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(secretPath, "utf8")) as EncryptedSecretFile;
      const decrypted = decryptPayload(parsed, env);
      if (decrypted) {
        return decrypted;
      }
    } catch {
      // fall through and try next path
    }
  }
  return null;
}

export function loadWalletProviderSecret(
  providerId: WalletProviderId,
  env: NodeJS.ProcessEnv = process.env,
): WalletProviderSecretRecord | null {
  const secretPath = resolveWalletProviderSecretPath(providerId, env);
  if (!fs.existsSync(secretPath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(secretPath, "utf8")) as EncryptedSecretFile;
    const value = decryptProviderPayload(parsed, env);
    if (!value || value.providerId !== providerId) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

export function deleteWalletRpcSecret(env: NodeJS.ProcessEnv = process.env): {
  removed: boolean;
  path: string;
  removedPaths?: string[];
} {
  const dir = ensureSecretsDir(env);
  const legacyPath = resolveWalletRpcSecretPath(env);
  const candidatePaths = [
    legacyPath,
    ...fs
      .readdirSync(dir, { withFileTypes: true })
      .filter(
        (entry) => entry.isFile() && /^wallet-rpc-[a-z0-9-]+\.v1\.enc\.json$/i.test(entry.name),
      )
      .map((entry) => path.join(dir, entry.name)),
  ];
  const removedPaths: string[] = [];
  for (const secretPath of candidatePaths) {
    if (!fs.existsSync(secretPath)) {
      continue;
    }
    fs.rmSync(secretPath, { force: true });
    removedPaths.push(secretPath);
  }
  return {
    removed: removedPaths.length > 0,
    path: legacyPath,
    removedPaths: removedPaths.length > 0 ? removedPaths : undefined,
  };
}

export function deleteWalletRpcSecretForProvider(
  providerId: WalletProviderId,
  env: NodeJS.ProcessEnv = process.env,
): {
  removed: boolean;
  path: string;
} {
  const secretPath = resolveWalletRpcSecretPath(env, providerId);
  if (!fs.existsSync(secretPath)) {
    return { removed: false, path: secretPath };
  }
  fs.rmSync(secretPath, { force: true });
  return { removed: true, path: secretPath };
}

export function deleteWalletProviderSecret(
  providerId: WalletProviderId,
  env: NodeJS.ProcessEnv = process.env,
): { removed: boolean; path: string } {
  const secretPath = resolveWalletProviderSecretPath(providerId, env);
  if (!fs.existsSync(secretPath)) {
    return { removed: false, path: secretPath };
  }
  fs.rmSync(secretPath, { force: true });
  return { removed: true, path: secretPath };
}

export function readWalletRpcSecretStatus(
  env: NodeJS.ProcessEnv = process.env,
  options?: { providerId?: WalletProviderId },
): WalletRpcSecretStatus {
  const providerId = options?.providerId;
  const secretPath = resolveWalletRpcSecretPath(env, providerId);
  const secret = loadWalletRpcSecret(env, { providerId });
  if (!secret) {
    return { configured: false, providerId, path: secretPath };
  }
  return {
    configured: true,
    providerId,
    chain: secret.chain,
    provider: secret.provider,
    updatedAt: secret.updatedAt,
    path: secretPath,
  };
}

export function readWalletProviderSecretStatus(
  providerId: WalletProviderId,
  env: NodeJS.ProcessEnv = process.env,
): WalletProviderSecretStatus {
  const secretPath = resolveWalletProviderSecretPath(providerId, env);
  const secret = loadWalletProviderSecret(providerId, env);
  if (!secret) {
    return {
      configured: false,
      providerId,
      fields: [],
      path: secretPath,
    };
  }
  return {
    configured: true,
    providerId,
    updatedAt: secret.updatedAt,
    fields: Object.keys(secret.credentials).toSorted(),
    path: secretPath,
  };
}
