#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  requireCurrentLifecycleRoot,
  trustMetadataDigest,
  verifyInitialLifecycleRoot,
  verifyLifecycleRootRotation,
} from "./lifecycle-trust-policy.mjs";
import { INITIAL_LIFECYCLE_ROOT_SHA256 } from "./lifecycle-trust-runtime.mjs";

const ROOT_NAME = /^fased-lifecycle-root-v([1-9][0-9]*)\.json$/u;
const DIGEST = /^[a-f0-9]{64}$/u;

async function readRegular(file, label) {
  const info = await fs.lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size <= 0) {
    throw new Error(`${label} must be one non-empty regular single-link file`);
  }
  return fs.readFile(file);
}

export async function verifyLifecycleRootChain({ directory, pinPath, now = Date.now() }) {
  const resolved = path.resolve(directory);
  const info = await fs.lstat(resolved);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("lifecycle root chain directory must be one real directory");
  }
  const names = (await fs.readdir(resolved))
    .filter((name) => ROOT_NAME.test(name))
    .toSorted(
      (left, right) => Number(left.match(ROOT_NAME)[1]) - Number(right.match(ROOT_NAME)[1]),
    );
  if (names.length === 0) {
    throw new Error("lifecycle root chain is empty");
  }
  const pin = (await readRegular(path.resolve(pinPath), "lifecycle root pin"))
    .toString("utf8")
    .trim();
  if (!DIGEST.test(pin)) {
    throw new Error("lifecycle root pin is malformed");
  }

  let trustedEnvelope;
  let trusted;
  for (let index = 0; index < names.length; index += 1) {
    const expectedVersion = index + 1;
    const name = names[index];
    const version = Number(name.match(ROOT_NAME)[1]);
    if (version !== expectedVersion) {
      throw new Error(`lifecycle root chain is not contiguous at version ${expectedVersion}`);
    }
    const envelope = JSON.parse(
      (await readRegular(path.join(resolved, name), `lifecycle root v${version}`)).toString("utf8"),
    );
    if (index === 0) {
      const rawDigest = createHash("sha256")
        .update(await readRegular(path.join(resolved, name), "lifecycle root v1"))
        .digest("hex");
      if (rawDigest !== pin) {
        throw new Error("initial lifecycle root bytes do not match the release asset pin");
      }
      trusted = verifyInitialLifecycleRoot(envelope, {
        pinnedSha256: INITIAL_LIFECYCLE_ROOT_SHA256,
        now: null,
      });
    } else {
      trusted = verifyLifecycleRootRotation(trustedEnvelope, envelope, { now: null });
    }
    if (trusted.version !== version) {
      throw new Error(`lifecycle root asset name and signed version disagree at v${version}`);
    }
    trustedEnvelope = envelope;
  }
  requireCurrentLifecycleRoot(trusted, now);
  return Object.freeze({
    version: trusted.version,
    digest: trustMetadataDigest(trustedEnvelope),
    names: Object.freeze(names),
  });
}

async function main(argv) {
  let directory;
  let pinPath;
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!value || !["--directory", "--pin"].includes(key)) {
      throw new Error("usage: verify-lifecycle-root-chain.mjs --directory <path> --pin <path>");
    }
    if (key === "--directory") {
      directory = value;
    }
    if (key === "--pin") {
      pinPath = value;
    }
  }
  if (!directory || !pinPath) {
    throw new Error("usage: verify-lifecycle-root-chain.mjs --directory <path> --pin <path>");
  }
  const result = await verifyLifecycleRootChain({ directory, pinPath });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`verify-lifecycle-root-chain: ${error.message}\n`);
    process.exitCode = 1;
  });
}
