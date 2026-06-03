const KEY = "fased.wallet.custody.device-shares.v2";

type WalletCustodyEncryptedShareRecord = {
  version: 2;
  scheme: "webauthn-prf-aes-gcm-v1";
  credentialId: string;
  iv: string;
  ciphertext: string;
  updatedAt: string;
};

type WalletCustodyStoredShareRecord = string | WalletCustodyEncryptedShareRecord;

type WalletCustodyDeviceShareStore = {
  version: 2;
  sharesByGateway: Record<string, Record<string, WalletCustodyStoredShareRecord>>;
};

function getLocalStorageSafe(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function normalizeScope(gatewayUrl?: string): string {
  const explicit = gatewayUrl?.trim().toLowerCase();
  if (explicit) {
    return explicit;
  }
  if (typeof window !== "undefined" && window.location?.origin) {
    return window.location.origin.trim().toLowerCase();
  }
  return "default";
}

function toBase64Url(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string): ArrayBuffer {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const pad = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  const binary = atob(normalized + pad);
  const buffer = new ArrayBuffer(binary.length);
  const out = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return buffer;
}

function loadStore(): WalletCustodyDeviceShareStore {
  const storage = getLocalStorageSafe();
  const raw = storage?.getItem(KEY) ?? "";
  if (!raw) {
    return { version: 2, sharesByGateway: {} };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<WalletCustodyDeviceShareStore>;
    if (
      parsed.version !== 2 ||
      typeof parsed.sharesByGateway !== "object" ||
      !parsed.sharesByGateway
    ) {
      return { version: 2, sharesByGateway: {} };
    }
    const sharesByGateway: Record<string, Record<string, WalletCustodyStoredShareRecord>> = {};
    for (const [scope, scopedRaw] of Object.entries(parsed.sharesByGateway)) {
      if (!scopedRaw || typeof scopedRaw !== "object" || Array.isArray(scopedRaw)) {
        continue;
      }
      const scoped: Record<string, WalletCustodyStoredShareRecord> = {};
      for (const [walletId, recordRaw] of Object.entries(scopedRaw as Record<string, unknown>)) {
        if (typeof recordRaw === "string") {
          scoped[walletId] = recordRaw;
          continue;
        }
        if (
          recordRaw &&
          typeof recordRaw === "object" &&
          !Array.isArray(recordRaw) &&
          (recordRaw as Partial<WalletCustodyEncryptedShareRecord>).version === 2 &&
          (recordRaw as Partial<WalletCustodyEncryptedShareRecord>).scheme ===
            "webauthn-prf-aes-gcm-v1" &&
          typeof (recordRaw as Partial<WalletCustodyEncryptedShareRecord>).credentialId ===
            "string" &&
          typeof (recordRaw as Partial<WalletCustodyEncryptedShareRecord>).iv === "string" &&
          typeof (recordRaw as Partial<WalletCustodyEncryptedShareRecord>).ciphertext ===
            "string" &&
          typeof (recordRaw as Partial<WalletCustodyEncryptedShareRecord>).updatedAt === "string"
        ) {
          scoped[walletId] = recordRaw as WalletCustodyEncryptedShareRecord;
        }
      }
      sharesByGateway[scope] = scoped;
    }
    return {
      version: 2,
      sharesByGateway,
    };
  } catch {
    return { version: 2, sharesByGateway: {} };
  }
}

function saveStore(store: WalletCustodyDeviceShareStore) {
  const storage = getLocalStorageSafe();
  storage?.setItem(KEY, JSON.stringify(store));
}

function readStoredRecord(
  gatewayUrl: string | undefined,
  walletId: string | undefined,
): WalletCustodyStoredShareRecord | null {
  const normalizedWalletId = walletId?.trim() || "";
  if (!normalizedWalletId) {
    return null;
  }
  const store = loadStore();
  const scope = normalizeScope(gatewayUrl);
  const scoped = store.sharesByGateway[scope];
  if (!scoped) {
    return null;
  }
  return scoped[normalizedWalletId] ?? null;
}

export function buildWalletCustodyStorageBinding(
  gatewayUrl: string | undefined,
  walletId: string | undefined,
): string {
  const normalizedWalletId = walletId?.trim() || "";
  const scope = normalizeScope(gatewayUrl);
  return `fased.wallet.custody-storage.v1:${scope}:${normalizedWalletId}`;
}

export function hasStoredWalletCustodyDeviceShare(
  gatewayUrl: string | undefined,
  walletId: string | undefined,
): boolean {
  return Boolean(readStoredRecord(gatewayUrl, walletId));
}

export function getStoredWalletCustodyDeviceShareCredentialId(
  gatewayUrl: string | undefined,
  walletId: string | undefined,
): string {
  const record = readStoredRecord(gatewayUrl, walletId);
  if (!record || typeof record === "string") {
    return "";
  }
  return record.credentialId.trim();
}

export function loadStoredWalletCustodyDeviceShare(
  gatewayUrl: string | undefined,
  walletId: string | undefined,
): string {
  const record = readStoredRecord(gatewayUrl, walletId);
  return typeof record === "string" ? record.trim() : "";
}

async function importAesKey(storageKeyBase64: string): Promise<CryptoKey> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Web Crypto is required for encrypted custody device share storage.");
  }
  return await globalThis.crypto.subtle.importKey(
    "raw",
    fromBase64Url(storageKeyBase64),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
}

export async function decryptStoredWalletCustodyDeviceShare(params: {
  gatewayUrl: string | undefined;
  walletId: string | undefined;
  storageKeyBase64: string;
}): Promise<string> {
  const record = readStoredRecord(params.gatewayUrl, params.walletId);
  if (!record) {
    return "";
  }
  if (typeof record === "string") {
    return record.trim();
  }
  const key = await importAesKey(params.storageKeyBase64);
  try {
    const plaintext = await globalThis.crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: fromBase64Url(record.iv),
      },
      key,
      fromBase64Url(record.ciphertext),
    );
    return new TextDecoder().decode(plaintext).trim();
  } catch {
    throw new Error(
      "Stored device share could not be decrypted with this passkey. Use the original passkey for this browser-stored share or paste the device share manually.",
    );
  }
}

export async function saveStoredWalletCustodyDeviceShare(params: {
  gatewayUrl: string | undefined;
  walletId: string | undefined;
  deviceShare: string | undefined;
  storageKeyBase64: string;
  credentialId: string;
}) {
  const normalizedWalletId = params.walletId?.trim() || "";
  const normalizedShare = params.deviceShare?.trim() || "";
  const normalizedCredentialId = params.credentialId.trim();
  if (
    !normalizedWalletId ||
    !normalizedShare ||
    !params.storageKeyBase64.trim() ||
    !normalizedCredentialId
  ) {
    return;
  }
  if (!globalThis.crypto?.getRandomValues || !globalThis.crypto?.subtle) {
    throw new Error("Web Crypto is required for encrypted custody device share storage.");
  }
  const key = await importAesKey(params.storageKeyBase64);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await globalThis.crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
    },
    key,
    new TextEncoder().encode(normalizedShare),
  );
  const store = loadStore();
  const scope = normalizeScope(params.gatewayUrl);
  const scoped = { ...store.sharesByGateway[scope] };
  scoped[normalizedWalletId] = {
    version: 2,
    scheme: "webauthn-prf-aes-gcm-v1",
    credentialId: normalizedCredentialId,
    iv: toBase64Url(iv),
    ciphertext: toBase64Url(ciphertext),
    updatedAt: new Date().toISOString(),
  };
  store.sharesByGateway[scope] = scoped;
  saveStore(store);
}

export function clearStoredWalletCustodyDeviceShare(
  gatewayUrl: string | undefined,
  walletId: string | undefined,
) {
  const normalizedWalletId = walletId?.trim() || "";
  if (!normalizedWalletId) {
    return;
  }
  const store = loadStore();
  const scope = normalizeScope(gatewayUrl);
  const scoped = { ...store.sharesByGateway[scope] };
  delete scoped[normalizedWalletId];
  if (Object.keys(scoped).length === 0) {
    delete store.sharesByGateway[scope];
  } else {
    store.sharesByGateway[scope] = scoped;
  }
  saveStore(store);
}
