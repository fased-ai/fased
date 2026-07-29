#!/usr/bin/env node

import { createPublicKey } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { KEY_ID_PATTERN } from "./lifecycle-trust-crypto.mjs";
import {
  ed25519PublicKeyRecord,
  exactTrustKeys,
  failTrust,
  lifecycleTrustKeyId,
} from "./lifecycle-trust-policy.mjs";

export const PRODUCTION_ROOT_KEYSET_DIRECTORY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../release/lifecycle-trust/root-v1",
);

const EXPECTED_ROOT_NAMES = Object.freeze(["root-1", "root-2", "root-3"]);

async function readRegularFile(filePath, label) {
  const info = await fsp.lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    failTrust(`${label} must be one regular single-link file`);
  }
  return await fsp.readFile(filePath);
}

export async function loadLifecycleRootKeyset(keysetDirectory = PRODUCTION_ROOT_KEYSET_DIRECTORY) {
  const directory = path.resolve(keysetDirectory);
  const directoryInfo = await fsp.lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    failTrust("lifecycle root keyset must be one real directory");
  }
  const manifestPath = path.join(directory, "manifest.json");
  const manifest = JSON.parse(
    (await readRegularFile(manifestPath, "lifecycle root keyset manifest")).toString("utf8"),
  );
  exactTrustKeys(
    manifest,
    ["schemaVersion", "type", "threshold", "keys"],
    "lifecycle root keyset manifest",
  );
  if (
    manifest.schemaVersion !== 1 ||
    manifest.type !== "fased-lifecycle-root-keyset" ||
    manifest.threshold !== 2 ||
    !Array.isArray(manifest.keys) ||
    manifest.keys.length !== 3
  ) {
    failTrust("lifecycle root keyset manifest is incompatible");
  }

  const roots = [];
  for (const entry of manifest.keys) {
    exactTrustKeys(entry, ["name", "keyId", "publicKey"], "lifecycle root key entry");
    if (
      !EXPECTED_ROOT_NAMES.includes(entry.name) ||
      !KEY_ID_PATTERN.test(entry.keyId || "") ||
      path.basename(entry.publicKey || "") !== entry.publicKey ||
      !/^root-[123]\.public\.pem$/u.test(entry.publicKey)
    ) {
      failTrust("lifecycle root key entry is invalid");
    }
    const publicKeyPath = path.join(directory, entry.publicKey);
    const publicKeyPem = await readRegularFile(publicKeyPath, `lifecycle ${entry.name} public key`);
    let publicKey;
    try {
      publicKey = createPublicKey(publicKeyPem);
    } catch (error) {
      throw new Error(`lifecycle ${entry.name} public key is invalid`, { cause: error });
    }
    const record = ed25519PublicKeyRecord(publicKey);
    const keyId = lifecycleTrustKeyId(record);
    if (keyId !== entry.keyId) {
      failTrust(`lifecycle ${entry.name} fingerprint does not match its public key`);
    }
    roots.push(
      Object.freeze({
        name: entry.name,
        keyId,
        publicKey: record,
        publicKeyPath,
      }),
    );
  }

  if (
    roots.map((entry) => entry.name).join(",") !== EXPECTED_ROOT_NAMES.join(",") ||
    new Set(roots.map((entry) => entry.keyId)).size !== 3
  ) {
    failTrust("lifecycle root keyset must contain three distinct ordered roots");
  }
  return Object.freeze({
    schemaVersion: 1,
    threshold: 2,
    roots: Object.freeze(roots),
  });
}

async function main() {
  const keyset = await loadLifecycleRootKeyset(process.argv[2]);
  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: keyset.schemaVersion,
        threshold: keyset.threshold,
        roots: keyset.roots.map(({ name, keyId, publicKey }) => ({
          name,
          keyId,
          publicKey,
        })),
      },
      null,
      2,
    )}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`lifecycle-trust-production-roots: ${error.message}\n`);
    process.exitCode = 1;
  });
}
