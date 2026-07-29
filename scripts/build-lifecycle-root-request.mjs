#!/usr/bin/env node

import { createPublicKey } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseTrustKeyRecord } from "./lifecycle-trust-crypto.mjs";
import {
  canonicalTrustBytes,
  ed25519PublicKeyRecord,
  failTrust,
  lifecycleTrustKeyId,
  trustMetadataDigest,
} from "./lifecycle-trust-policy.mjs";
import {
  PRODUCTION_ROOT_KEYSET_DIRECTORY,
  loadLifecycleRootKeyset,
} from "./lifecycle-trust-production-roots.mjs";
import { LIFECYCLE_DELEGATED_ROLES, parseLifecycleRootEnvelope } from "./lifecycle-trust-root.mjs";

const MAX_HSM_SIGNING_PAYLOAD_BYTES = 8 * 1024;

function publicKeyRecord(value, label) {
  if (
    value &&
    typeof value === "object" &&
    value.keyType === "ed25519" &&
    value.scheme === "ed25519"
  ) {
    return parseTrustKeyRecord(value, label).record;
  }
  if (value?.type && value.type !== "public") {
    failTrust(`${label} must not contain private key material`);
  }
  if (
    (Buffer.isBuffer(value) || typeof value === "string") &&
    String(value).includes("PRIVATE KEY")
  ) {
    failTrust(`${label} must not contain private key material`);
  }
  let publicKey;
  try {
    publicKey = value?.type === "public" ? value : createPublicKey(value);
  } catch (error) {
    throw new Error(`${label} is invalid`, { cause: error });
  }
  return ed25519PublicKeyRecord(publicKey);
}

function normalizeRevocations(value = {}) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) => !new Set(["keyIds", "releaseVersions", "targetDigests"]).has(key),
    )
  ) {
    failTrust("initial lifecycle root revocations contain unsupported fields");
  }
  return {
    keyIds: [...(value.keyIds ?? [])].toSorted((left, right) => left.localeCompare(right)),
    releaseVersions: [...(value.releaseVersions ?? [])].toSorted((left, right) =>
      left.localeCompare(right),
    ),
    targetDigests: [...(value.targetDigests ?? [])].toSorted((left, right) =>
      left.localeCompare(right),
    ),
  };
}

export function buildLifecycleRootSigningRequest({
  rootKeyset,
  delegatedPublicKeys,
  version,
  issuedAt,
  expiresAt,
  revocations = {},
  now = Date.now(),
}) {
  if (
    rootKeyset?.schemaVersion !== 1 ||
    rootKeyset?.threshold !== 2 ||
    !Array.isArray(rootKeyset?.roots) ||
    rootKeyset.roots.length !== 3
  ) {
    failTrust("production lifecycle root keyset is invalid");
  }
  if (
    !delegatedPublicKeys ||
    typeof delegatedPublicKeys !== "object" ||
    Array.isArray(delegatedPublicKeys) ||
    Object.keys(delegatedPublicKeys).toSorted().join(",") !==
      [...LIFECYCLE_DELEGATED_ROLES].toSorted().join(",")
  ) {
    failTrust("lifecycle delegated public keys do not declare the complete role set");
  }

  const allKeys = new Map();
  const rootIds = [];
  for (const root of rootKeyset.roots) {
    const keyId = lifecycleTrustKeyId(root.publicKey);
    if (keyId !== root.keyId || allKeys.has(keyId)) {
      failTrust("production lifecycle root keyset contains a mismatched or duplicate key");
    }
    allKeys.set(keyId, root.publicKey);
    rootIds.push(keyId);
  }

  const delegatedRoles = [];
  for (const role of LIFECYCLE_DELEGATED_ROLES) {
    const record = publicKeyRecord(delegatedPublicKeys[role], `lifecycle ${role} public key`);
    const keyId = lifecycleTrustKeyId(record);
    if (allKeys.has(keyId)) {
      failTrust("lifecycle root and delegated roles must use distinct keys");
    }
    allKeys.set(keyId, record);
    delegatedRoles.push([role, { keyIds: [keyId], threshold: 1 }]);
  }

  const signed = {
    schemaVersion: 1,
    type: "fased-lifecycle-root",
    version,
    issuedAt,
    expiresAt,
    keys: Object.fromEntries(
      [...allKeys.entries()].toSorted(([left], [right]) => left.localeCompare(right)),
    ),
    roles: Object.fromEntries(
      [["root", { keyIds: rootIds.toSorted(), threshold: 2 }], ...delegatedRoles].toSorted(
        ([left], [right]) => left.localeCompare(right),
      ),
    ),
    revocations: normalizeRevocations(revocations),
  };
  parseLifecycleRootEnvelope({ schemaVersion: 1, signed, signatures: [] }, now);
  const payload = canonicalTrustBytes(signed);
  if (payload.length > MAX_HSM_SIGNING_PAYLOAD_BYTES) {
    failTrust("lifecycle root signing payload exceeds the fixed 8 KiB signing bound");
  }
  return Object.freeze({
    request: Object.freeze({
      schemaVersion: 1,
      type: "fased-lifecycle-root-signing-request",
      payloadSha256: trustMetadataDigest(signed),
      signed,
    }),
    payload,
  });
}

async function readDelegatedPublicKey(filePath, role) {
  const resolved = path.resolve(filePath);
  const info = await fsp.lstat(resolved);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    failTrust(`lifecycle ${role} public key must be one regular single-link file`);
  }
  return await fsp.readFile(resolved);
}

function parseArgs(argv) {
  const values = new Map();
  const delegated = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!value) {
      failTrust("lifecycle root request arguments must use --name value pairs");
    }
    if (key === "--delegated") {
      const separator = value.indexOf("=");
      const role = value.slice(0, separator);
      const filePath = value.slice(separator + 1);
      if (
        separator <= 0 ||
        !LIFECYCLE_DELEGATED_ROLES.includes(role) ||
        !filePath ||
        delegated.has(role)
      ) {
        failTrust("each lifecycle delegated role must map to one public-key file");
      }
      delegated.set(role, filePath);
      continue;
    }
    if (
      !new Set([
        "--root-keyset",
        "--version",
        "--issued-at",
        "--expires-at",
        "--request",
        "--payload",
      ]).has(key) ||
      values.has(key)
    ) {
      failTrust("lifecycle root request contains an unsupported or duplicate argument");
    }
    values.set(key, value);
  }
  for (const required of ["--version", "--issued-at", "--expires-at", "--request", "--payload"]) {
    if (!values.has(required)) {
      failTrust(`lifecycle root request is missing ${required}`);
    }
  }
  if (
    [...LIFECYCLE_DELEGATED_ROLES].some((role) => !delegated.has(role)) ||
    delegated.size !== LIFECYCLE_DELEGATED_ROLES.length
  ) {
    failTrust("lifecycle root request requires one public key for every delegated role");
  }
  const version = Number(values.get("--version"));
  return {
    rootKeysetDirectory: path.resolve(
      values.get("--root-keyset") ?? PRODUCTION_ROOT_KEYSET_DIRECTORY,
    ),
    delegated,
    version,
    issuedAt: values.get("--issued-at"),
    expiresAt: values.get("--expires-at"),
    requestPath: path.resolve(values.get("--request")),
    payloadPath: path.resolve(values.get("--payload")),
  };
}

async function main(argv) {
  const options = parseArgs(argv);
  const rootKeyset = await loadLifecycleRootKeyset(options.rootKeysetDirectory);
  const delegatedPublicKeys = Object.fromEntries(
    await Promise.all(
      LIFECYCLE_DELEGATED_ROLES.map(async (role) => [
        role,
        await readDelegatedPublicKey(options.delegated.get(role), role),
      ]),
    ),
  );
  const result = buildLifecycleRootSigningRequest({
    rootKeyset,
    delegatedPublicKeys,
    version: options.version,
    issuedAt: options.issuedAt,
    expiresAt: options.expiresAt,
  });
  await fsp.writeFile(options.requestPath, `${JSON.stringify(result.request, null, 2)}\n`, {
    flag: "wx",
    mode: 0o644,
  });
  await fsp.writeFile(options.payloadPath, result.payload, { flag: "wx", mode: 0o444 });
  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: 1,
      request: options.requestPath,
      payload: options.payloadPath,
      payloadSha256: result.request.payloadSha256,
      payloadBytes: result.payload.length,
      requiredRootSignatures: rootKeyset.threshold,
    })}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`build-lifecycle-root-request: ${error.message}\n`);
    process.exitCode = 1;
  });
}

export const __testing = Object.freeze({ MAX_HSM_SIGNING_PAYLOAD_BYTES, parseArgs });
