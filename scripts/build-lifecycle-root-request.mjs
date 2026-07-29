#!/usr/bin/env node

import fsp from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  canonicalTrustBytes,
  failTrust,
  lifecycleTrustKeyId,
  trustMetadataDigest,
} from "./lifecycle-trust-policy.mjs";
import {
  PRODUCTION_ROOT_KEYSET_DIRECTORY,
  loadLifecycleRootKeyset,
} from "./lifecycle-trust-production-roots.mjs";
import {
  OFFICIAL_GITHUB_RELEASE_AUTHORITY,
  parseLifecycleRootEnvelope,
} from "./lifecycle-trust-root.mjs";

const MAX_ROOT_SIGNING_PAYLOAD_BYTES = 8 * 1024;

function normalizeRevocations(value = {}) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !new Set(["releaseVersions", "targetDigests"]).has(key))
  ) {
    failTrust("initial lifecycle root revocations contain unsupported fields");
  }
  return {
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
  version,
  issuedAt,
  expiresAt,
  releaseAuthority = OFFICIAL_GITHUB_RELEASE_AUTHORITY,
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

  const keys = new Map();
  const rootIds = [];
  for (const root of rootKeyset.roots) {
    const keyId = lifecycleTrustKeyId(root.publicKey);
    if (keyId !== root.keyId || keys.has(keyId)) {
      failTrust("production lifecycle root keyset contains a mismatched or duplicate key");
    }
    keys.set(keyId, root.publicKey);
    rootIds.push(keyId);
  }

  const signed = {
    schemaVersion: 1,
    type: "fased-lifecycle-root",
    version,
    issuedAt,
    expiresAt,
    keys: Object.fromEntries(
      [...keys.entries()].toSorted(([left], [right]) => left.localeCompare(right)),
    ),
    root: { keyIds: rootIds.toSorted(), threshold: 2 },
    releaseAuthority,
    revocations: normalizeRevocations(revocations),
  };
  parseLifecycleRootEnvelope({ schemaVersion: 1, signed, signatures: [] }, now);
  const payload = canonicalTrustBytes(signed);
  if (payload.length > MAX_ROOT_SIGNING_PAYLOAD_BYTES) {
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

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (
      !value ||
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
      failTrust("lifecycle root request arguments must use supported --name value pairs");
    }
    values.set(key, value);
  }
  for (const required of ["--version", "--issued-at", "--expires-at", "--request", "--payload"]) {
    if (!values.has(required)) {
      failTrust(`lifecycle root request is missing ${required}`);
    }
  }
  const version = Number(values.get("--version"));
  return {
    rootKeysetDirectory: path.resolve(
      values.get("--root-keyset") ?? PRODUCTION_ROOT_KEYSET_DIRECTORY,
    ),
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
  const result = buildLifecycleRootSigningRequest({
    rootKeyset,
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

export const __testing = Object.freeze({ MAX_ROOT_SIGNING_PAYLOAD_BYTES, parseArgs });
