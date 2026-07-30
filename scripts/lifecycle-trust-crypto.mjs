import { createHash, createPublicKey, sign as signBytes, verify as verifyBytes } from "node:crypto";

export const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
export const KEY_ID_PATTERN = /^[a-f0-9]{64}$/u;
export const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;

export function failTrust(message) {
  throw new Error(message);
}

export function isPlainTrustObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function exactTrustKeys(value, expected, label) {
  if (
    !isPlainTrustObject(value) ||
    Object.keys(value)
      .toSorted((left, right) => left.localeCompare(right))
      .join(",") !== [...expected].toSorted((left, right) => left.localeCompare(right)).join(",")
  ) {
    failTrust(`${label} contains unsupported or missing fields`);
  }
}

function canonicalValue(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      failTrust("trust metadata numbers must be safe integers");
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalValue(entry)).join(",")}]`;
  }
  if (isPlainTrustObject(value)) {
    return `{${Object.keys(value)
      .toSorted((left, right) => left.localeCompare(right))
      .map((key) => `${JSON.stringify(key)}:${canonicalValue(value[key])}`)
      .join(",")}}`;
  }
  failTrust("trust metadata contains a non-canonical value");
}

export function canonicalTrustBytes(value) {
  return Buffer.from(canonicalValue(value), "utf8");
}

export function trustMetadataDigest(value) {
  return createHash("sha256").update(canonicalTrustBytes(value)).digest("hex");
}

function canonicalBase64(value, label) {
  const text = String(value ?? "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(text) || text.length % 4 !== 0) {
    failTrust(`${label} is not canonical base64`);
  }
  const bytes = Buffer.from(text, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== text) {
    failTrust(`${label} is not canonical base64`);
  }
  return bytes;
}

export function ed25519PublicKeyRecord(publicKey) {
  const key = publicKey?.type === "public" ? publicKey : createPublicKey(publicKey);
  if (key.asymmetricKeyType !== "ed25519") {
    failTrust("lifecycle trust keys must use Ed25519");
  }
  const bytes = key.export({ format: "der", type: "spki" });
  return Object.freeze({
    keyType: "ed25519",
    scheme: "ed25519",
    publicKey: Buffer.from(bytes).toString("base64"),
  });
}

export function parseTrustKeyRecord(value, label) {
  exactTrustKeys(value, ["keyType", "scheme", "publicKey"], label);
  if (value.keyType !== "ed25519" || value.scheme !== "ed25519") {
    failTrust(`${label} must use Ed25519`);
  }
  const bytes = canonicalBase64(value.publicKey, `${label} public key`);
  let key;
  try {
    key = createPublicKey({ key: bytes, format: "der", type: "spki" });
  } catch (error) {
    throw new Error(`${label} public key is invalid`, { cause: error });
  }
  if (
    key.asymmetricKeyType !== "ed25519" ||
    !Buffer.from(key.export({ format: "der", type: "spki" })).equals(bytes)
  ) {
    failTrust(`${label} public key is not canonical Ed25519 SPKI`);
  }
  return Object.freeze({ record: value, bytes, key });
}

export function lifecycleTrustKeyId(record) {
  const parsed = parseTrustKeyRecord(record, "lifecycle trust key");
  return createHash("sha256").update(parsed.bytes).digest("hex");
}

export function parseTrustInstant(value, label) {
  const text = String(value ?? "");
  const milliseconds = Date.parse(text);
  if (!text || !Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== text) {
    failTrust(`${label} must be one canonical ISO-8601 UTC instant`);
  }
  return Object.freeze({ text, milliseconds });
}

export function parsePositiveMetadataVersion(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    failTrust(`${label} must be a positive integer`);
  }
  return value;
}

export function parseTrustEnvelope(value, label) {
  exactTrustKeys(value, ["schemaVersion", "signed", "signatures"], label);
  if (
    value.schemaVersion !== 1 ||
    !isPlainTrustObject(value.signed) ||
    !Array.isArray(value.signatures)
  ) {
    failTrust(`${label} is malformed`);
  }
  let priorKeyId = null;
  const signatures = value.signatures.map((signature, index) => {
    exactTrustKeys(signature, ["keyId", "signature"], `${label} signature`);
    const keyId = String(signature.keyId ?? "");
    if (
      !KEY_ID_PATTERN.test(keyId) ||
      (priorKeyId !== null && priorKeyId.localeCompare(keyId) >= 0)
    ) {
      failTrust(`${label} signatures must use unique sorted key IDs`);
    }
    priorKeyId = keyId;
    const bytes = canonicalBase64(signature.signature, `${label} signature ${index + 1}`);
    if (bytes.length !== 64) {
      failTrust(`${label} Ed25519 signatures must be 64 bytes`);
    }
    return Object.freeze({ keyId, bytes });
  });
  return Object.freeze({ envelope: value, signed: value.signed, signatures });
}

export function signTrustEnvelope(signed, signingKeys) {
  if (!Array.isArray(signingKeys) || signingKeys.length === 0) {
    failTrust("at least one signing key is required");
  }
  const payload = canonicalTrustBytes(signed);
  const signatures = signingKeys
    .map(({ keyId, privateKey }) => {
      if (!KEY_ID_PATTERN.test(keyId || "")) {
        failTrust("signing key ID is invalid");
      }
      const signature = signBytes(null, payload, privateKey);
      if (signature.length !== 64) {
        failTrust("Ed25519 signing returned an invalid signature");
      }
      return { keyId, signature: signature.toString("base64") };
    })
    .toSorted((left, right) => left.keyId.localeCompare(right.keyId));
  for (let index = 1; index < signatures.length; index += 1) {
    if (signatures[index - 1].keyId === signatures[index].keyId) {
      failTrust("a trust envelope cannot contain duplicate signing keys");
    }
  }
  return Object.freeze({ schemaVersion: 1, signed, signatures });
}

export function verifyKnownTrustSignatures(parsedEnvelope, roots) {
  const keyRecords = new Map();
  for (const root of roots) {
    for (const [keyId, key] of root.keys) {
      const existing = keyRecords.get(keyId);
      if (existing && !existing.bytes.equals(key.bytes)) {
        failTrust("lifecycle roots disagree about a key ID");
      }
      keyRecords.set(keyId, key);
    }
  }
  const verified = new Set();
  const payload = canonicalTrustBytes(parsedEnvelope.signed);
  for (const signature of parsedEnvelope.signatures) {
    const key = keyRecords.get(signature.keyId);
    if (!key) {
      failTrust("trust envelope contains a signature from an unknown key");
    }
    if (!verifyBytes(null, payload, key.key, signature.bytes)) {
      failTrust("trust envelope contains an invalid Ed25519 signature");
    }
    verified.add(signature.keyId);
  }
  return verified;
}
