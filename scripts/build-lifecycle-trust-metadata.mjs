#!/usr/bin/env node

import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { trustMetadataDigest } from "./lifecycle-trust-crypto.mjs";
import { verifyInitialLifecycleRoot } from "./lifecycle-trust-root.mjs";

const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const TARGET_NAMES = Object.freeze({
  bootstrap: "install.sh",
  lifecycleLinuxX64: "fased-lifecycled-linux-amd64",
  lifecycleLinuxArm64: "fased-lifecycled-linux-arm64",
  evidenceVerifier: "fased-privileged-release-evidence.mjs",
});
const EVIDENCE_NAMES = Object.freeze({
  provenance: "fased-privileged-provenance-v1.intoto.json",
  sbom: "fased-privileged-sbom-v1.spdx.json",
  vex: "fased-privileged-vex-v1.openvex.json",
});
const MAX_VALIDITY_MS = 400 * 24 * 60 * 60 * 1000;

async function sha256(filePath) {
  return createHash("sha256")
    .update(await fsp.readFile(filePath))
    .digest("hex");
}

function parseInstant(value, label) {
  const text = String(value ?? "").trim();
  const milliseconds = Date.parse(text);
  if (!text || !Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== text) {
    throw new Error(`${label} must be one canonical ISO-8601 UTC instant`);
  }
  return { text, milliseconds };
}

export async function buildLifecycleTrustMetadata({
  assetsDir,
  rootPolicyPath,
  version,
  commit,
  issuedAt,
  expiresAt,
}) {
  if (!VERSION_PATTERN.test(version || "") || !COMMIT_PATTERN.test(commit || "")) {
    throw new Error("lifecycle trust metadata release identity is not canonical");
  }
  const issued = parseInstant(issuedAt, "issuedAt");
  const expires = parseInstant(expiresAt, "expiresAt");
  if (
    expires.milliseconds <= issued.milliseconds ||
    expires.milliseconds - issued.milliseconds > MAX_VALIDITY_MS
  ) {
    throw new Error("lifecycle trust metadata validity must be positive and at most 400 days");
  }
  const rootPolicyInfo = await fsp.lstat(rootPolicyPath);
  if (
    !rootPolicyInfo.isFile() ||
    rootPolicyInfo.isSymbolicLink() ||
    rootPolicyInfo.nlink !== 1 ||
    rootPolicyInfo.size <= 0 ||
    rootPolicyInfo.size > 1024 * 1024
  ) {
    throw new Error("lifecycle root policy must be one bounded regular single-link file");
  }
  let rootPolicy;
  try {
    rootPolicy = JSON.parse(await fsp.readFile(rootPolicyPath, "utf8"));
  } catch (error) {
    throw new Error("lifecycle root policy must be valid JSON", { cause: error });
  }
  if (
    !rootPolicy ||
    typeof rootPolicy !== "object" ||
    Array.isArray(rootPolicy) ||
    Object.keys(rootPolicy).toSorted().join(",") !== "schemaVersion,signatures,signed" ||
    rootPolicy.schemaVersion !== 1
  ) {
    throw new Error("lifecycle root policy envelope is malformed");
  }
  const selfKeyIds = new Set(rootPolicy.signed?.root?.keyIds ?? []);
  const selfSignedEnvelope = {
    ...rootPolicy,
    signatures: rootPolicy.signatures.filter((signature) => selfKeyIds.has(signature?.keyId)),
  };
  verifyInitialLifecycleRoot(selfSignedEnvelope, {
    pinnedSha256: trustMetadataDigest(selfSignedEnvelope),
  });

  const targets = {};
  for (const [role, asset] of Object.entries(TARGET_NAMES)) {
    const candidate = path.join(assetsDir, asset);
    const info = await fsp.lstat(candidate);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
      throw new Error(`lifecycle ${role} target must be one regular single-link file`);
    }
    targets[role] = { asset, sha256: await sha256(candidate) };
  }
  const evidence = {};
  for (const [role, asset] of Object.entries(EVIDENCE_NAMES)) {
    const candidate = path.join(assetsDir, asset);
    const info = await fsp.lstat(candidate);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      info.size <= 0 ||
      info.size > 32 * 1024 * 1024
    ) {
      throw new Error(`lifecycle ${role} evidence must be one bounded regular single-link file`);
    }
    evidence[role] = { asset, sha256: await sha256(candidate) };
  }

  return {
    schemaVersion: 1,
    role: "fased-lifecycle-targets",
    rootPolicy,
    release: {
      version,
      tag: `v${version}`,
      commit,
    },
    validity: {
      issuedAt: issued.text,
      expiresAt: expires.text,
    },
    policy: {
      channels: version.includes("-") ? ["beta"] : ["beta", "stable"],
      platforms: ["linux-arm64", "linux-x64"],
      lifecycleProtocol: 1,
    },
    targets,
    evidence,
  };
}

function parseArgs(argv) {
  const values = new Map();
  const allowed = new Set([
    "--assets",
    "--root-policy",
    "--version",
    "--commit",
    "--issued-at",
    "--expires-at",
    "--output",
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(key) || !value || values.has(key)) {
      throw new Error(
        "usage: build-lifecycle-trust-metadata --assets DIR --root-policy FILE --version X.Y.Z --commit SHA --issued-at INSTANT --expires-at INSTANT --output FILE",
      );
    }
    values.set(key, value);
  }
  for (const required of [
    "--assets",
    "--root-policy",
    "--version",
    "--commit",
    "--issued-at",
    "--expires-at",
    "--output",
  ]) {
    if (!values.has(required)) {
      throw new Error(`missing ${required}`);
    }
  }
  return {
    assetsDir: path.resolve(values.get("--assets")),
    rootPolicyPath: path.resolve(values.get("--root-policy")),
    version: values.get("--version"),
    commit: values.get("--commit"),
    issuedAt: values.get("--issued-at"),
    expiresAt: values.get("--expires-at"),
    output: path.resolve(values.get("--output")),
  };
}

async function main(argv) {
  const options = parseArgs(argv);
  const metadata = await buildLifecycleTrustMetadata(options);
  await fsp.writeFile(options.output, `${JSON.stringify(metadata, null, 2)}\n`, {
    mode: 0o644,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`build-lifecycle-trust-metadata: ${error.message}\n`);
    process.exitCode = 1;
  });
}
