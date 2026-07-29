#!/usr/bin/env node

import fsp from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { KEY_ID_PATTERN } from "./lifecycle-trust-crypto.mjs";
import {
  exactTrustKeys,
  failTrust,
  trustMetadataDigest,
  verifyInitialLifecycleRoot,
} from "./lifecycle-trust-policy.mjs";

export function finalizeLifecycleRootMetadata({ request, signatures, now = Date.now() }) {
  exactTrustKeys(
    request,
    ["schemaVersion", "type", "payloadSha256", "signed"],
    "lifecycle root signing request",
  );
  if (
    request.schemaVersion !== 1 ||
    request.type !== "fased-lifecycle-root-signing-request" ||
    request.payloadSha256 !== trustMetadataDigest(request.signed)
  ) {
    failTrust("lifecycle root signing request payload identity is invalid");
  }
  if (!Array.isArray(signatures) || signatures.length < 2 || signatures.length > 3) {
    failTrust("lifecycle root finalization requires two or three root signatures");
  }
  const rootIds = new Set(request.signed?.roles?.root?.keyIds ?? []);
  const envelopeSignatures = signatures
    .map(({ keyId, signature }) => {
      if (
        !KEY_ID_PATTERN.test(keyId || "") ||
        !rootIds.has(keyId) ||
        !Buffer.isBuffer(signature) ||
        signature.length !== 64
      ) {
        failTrust("lifecycle root signature is not a canonical root signature");
      }
      return { keyId, signature: signature.toString("base64") };
    })
    .toSorted((left, right) => left.keyId.localeCompare(right.keyId));
  if (new Set(envelopeSignatures.map(({ keyId }) => keyId)).size !== envelopeSignatures.length) {
    failTrust("lifecycle root signatures must use distinct root keys");
  }
  const envelope = {
    schemaVersion: 1,
    signed: request.signed,
    signatures: envelopeSignatures,
  };
  const pinnedSha256 = trustMetadataDigest(envelope);
  verifyInitialLifecycleRoot(envelope, { pinnedSha256, now });
  return Object.freeze({ envelope: Object.freeze(envelope), pinnedSha256 });
}

function parseArgs(argv) {
  const values = new Map();
  const signatures = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!value) {
      failTrust("lifecycle root finalization arguments must use --name value pairs");
    }
    if (key === "--signature") {
      const separator = value.indexOf("=");
      const keyId = value.slice(0, separator);
      const signaturePath = value.slice(separator + 1);
      if (
        separator <= 0 ||
        !KEY_ID_PATTERN.test(keyId) ||
        !signaturePath ||
        signatures.has(keyId)
      ) {
        failTrust("each lifecycle root signature must map one key ID to one signature file");
      }
      signatures.set(keyId, path.resolve(signaturePath));
      continue;
    }
    if (!new Set(["--request", "--output", "--pin-output"]).has(key) || values.has(key)) {
      failTrust("lifecycle root finalization contains an unsupported or duplicate argument");
    }
    values.set(key, value);
  }
  for (const required of ["--request", "--output", "--pin-output"]) {
    if (!values.has(required)) {
      failTrust(`lifecycle root finalization is missing ${required}`);
    }
  }
  if (signatures.size < 2 || signatures.size > 3) {
    failTrust("lifecycle root finalization requires two or three --signature arguments");
  }
  return {
    requestPath: path.resolve(values.get("--request")),
    outputPath: path.resolve(values.get("--output")),
    pinOutputPath: path.resolve(values.get("--pin-output")),
    signatures,
  };
}

async function readSignature(filePath) {
  const info = await fsp.lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size !== 64) {
    failTrust("lifecycle root signature file must be one 64-byte regular single-link file");
  }
  return await fsp.readFile(filePath);
}

async function main(argv) {
  const options = parseArgs(argv);
  const request = JSON.parse(await fsp.readFile(options.requestPath, "utf8"));
  const signatures = await Promise.all(
    [...options.signatures.entries()].map(async ([keyId, signaturePath]) => ({
      keyId,
      signature: await readSignature(signaturePath),
    })),
  );
  const result = finalizeLifecycleRootMetadata({ request, signatures });
  await fsp.writeFile(options.outputPath, `${JSON.stringify(result.envelope, null, 2)}\n`, {
    flag: "wx",
    mode: 0o644,
  });
  await fsp.writeFile(options.pinOutputPath, `${result.pinnedSha256}\n`, {
    flag: "wx",
    mode: 0o644,
  });
  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: 1,
      rootMetadata: options.outputPath,
      pinnedSha256: result.pinnedSha256,
      signatures: result.envelope.signatures.map(({ keyId }) => keyId),
    })}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`finalize-lifecycle-root-metadata: ${error.message}\n`);
    process.exitCode = 1;
  });
}

export const __testing = Object.freeze({ parseArgs });
