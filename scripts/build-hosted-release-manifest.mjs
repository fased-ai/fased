#!/usr/bin/env node

import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;

export const HOSTED_SIGNER_CAPABILITIES_V2 = Object.freeze({
  protocol: Object.freeze({ current: 2, min: 2, max: 2 }),
  nativeFeeReservationLamports: 5_000_000,
  intentTypes: Object.freeze([
    "solana.nativeTransfer",
    "solana.splTransferChecked",
    "solana.satAction",
    "solana.vaultBondAction",
    "federation.bondChallenge",
    "solana.jupiter.swap",
    "solana.jupiter.trigger.create",
    "solana.jupiter.trigger.cancel",
  ]),
  operationStates: Object.freeze(["reserved", "broadcast", "confirmed", "failed", "unknown"]),
  features: Object.freeze([
    "failClosedPolicies",
    "policyHashes",
    "applicationPolicyTightening",
    "vaultReviewedOnly",
    "durableCaps",
    "atomicMultiAssetCaps",
    "signerControlledNativeFeeCaps",
    "atomicIdempotency",
    "ambiguousBroadcastReconciliation",
    "signerOwnedKeys",
    "signerOwnedSuccessorRotation",
    "permanentRetiredWalletPolicies",
    "signerOwnedRPC",
    "typedSolanaTransactions",
    "idempotentAssociatedTokenCreation",
    "typedSATActions",
    "typedVaultBondActions",
    "domainSeparatedFederationBondChallenges",
    "federationBondChallengeWrapperV2",
    "signerOwnedWebAuthn",
    "signerOwnedWebAuthnCredentialRevocation",
    "singleUseReviewedAuthorization",
    "typedJupiterSemantics",
    "signerOwnedReviewPrepareExecute",
    "exactPreparedTransactions",
    "reviewedVaultBondActions",
    "reviewedFederationBondChallenges",
    "signerOwnedStateRecheck",
    "durableReviewAuthorization",
    "signerOwnedJupiterTriggerV2",
    "signerOwnedJupiterTriggerHistory",
    "jupiterTriggerSecretsNeverCrossSocket",
    "jupiterTriggerDurablePhases",
  ]),
});

function canonicalJSON(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJSON(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function digestJSON(value) {
  return `sha256:${createHash("sha256").update(canonicalJSON(value)).digest("hex")}`;
}

async function sha256(filePath) {
  const hash = createHash("sha256");
  hash.update(await fsp.readFile(filePath));
  return hash.digest("hex");
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).toSorted().join(",");
  if (actual !== [...expected].toSorted((left, right) => left.localeCompare(right)).join(",")) {
    throw new Error(`${label} contains unsupported or missing fields`);
  }
}

function parseAppIdentity(value, expectedVersion, expectedCommit) {
  exactKeys(
    value,
    ["schemaVersion", "version", "commit", "architecture", "dependencyHash", "app", "dependencies"],
    "hosted application identity",
  );
  exactKeys(value.app, ["asset", "sha256"], "hosted application artifact identity");
  exactKeys(value.dependencies, ["asset", "sha256"], "hosted dependency artifact identity");
  if (
    value.schemaVersion !== 1 ||
    value.version !== expectedVersion ||
    value.commit !== expectedCommit ||
    !new Set(["x64", "arm64"]).has(value.architecture) ||
    !DIGEST_PATTERN.test(value.dependencyHash || "") ||
    !DIGEST_PATTERN.test(value.app.sha256 || "") ||
    !DIGEST_PATTERN.test(value.dependencies.sha256 || "")
  ) {
    throw new Error("hosted application identity is malformed or mismatched");
  }
  return value;
}

function parseSignerIdentity(value, expectedVersion, expectedCommit) {
  exactKeys(
    value,
    ["schemaVersion", "version", "commit", "buildInputDigest", "development"],
    "native signer identity",
  );
  if (
    value.schemaVersion !== 1 ||
    value.version !== expectedVersion ||
    value.commit !== expectedCommit ||
    !/^sha256:[a-f0-9]{64}$/u.test(value.buildInputDigest || "") ||
    value.development !== false
  ) {
    throw new Error("native signer identity is malformed or mismatched");
  }
  return value;
}

async function readJSON(filePath) {
  return JSON.parse(await fsp.readFile(filePath, "utf8"));
}

export async function buildHostedReleaseManifest({ assetsDir, version, commit }) {
  if (!VERSION_PATTERN.test(version || "") || !COMMIT_PATTERN.test(commit || "")) {
    throw new Error("release version or commit is not canonical");
  }
  const application = {};
  for (const architecture of ["x64", "arm64"]) {
    const identityName = `fased-hosted-app-linux-${architecture}-v${version}.tar.gz.release.json`;
    const identity = parseAppIdentity(
      await readJSON(path.join(assetsDir, identityName)),
      version,
      commit,
    );
    if (identity.architecture !== architecture) {
      throw new Error(`hosted application identity architecture mismatch for ${architecture}`);
    }
    for (const artifact of [identity.app, identity.dependencies]) {
      const actual = await sha256(path.join(assetsDir, artifact.asset));
      if (actual !== artifact.sha256) {
        throw new Error(`artifact digest mismatch while assembling release: ${artifact.asset}`);
      }
    }
    application[architecture] = {
      artifact: identity.app,
      dependencies: {
        dependencyHash: identity.dependencyHash,
        ...identity.dependencies,
      },
    };
  }

  const signerIdentity = parseSignerIdentity(
    await readJSON(path.join(assetsDir, "fased-signerd-release.json")),
    version,
    commit,
  );
  const signerPlatforms = {};
  for (const [platform, asset] of [
    ["linux-amd64", "fased-signerd-linux-amd64"],
    ["linux-arm64", "fased-signerd-linux-arm64"],
    ["darwin-amd64", "fased-signerd-darwin-amd64"],
    ["darwin-arm64", "fased-signerd-darwin-arm64"],
  ]) {
    signerPlatforms[platform] = { asset, sha256: await sha256(path.join(assetsDir, asset)) };
  }

  return {
    schemaVersion: 2,
    release: { version, tag: `v${version}`, commit },
    application: { linux: application },
    signer: {
      release: {
        version,
        commit,
        buildInputDigest: signerIdentity.buildInputDigest,
        development: false,
      },
      capabilities: HOSTED_SIGNER_CAPABILITIES_V2,
      capabilitiesDigest: digestJSON(HOSTED_SIGNER_CAPABILITIES_V2),
      platforms: signerPlatforms,
    },
  };
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) {
      throw new Error(
        "usage: build-hosted-release-manifest --assets DIR --version X.Y.Z --commit SHA --output FILE",
      );
    }
    values.set(key, value);
  }
  for (const required of ["--assets", "--version", "--commit", "--output"]) {
    if (!values.has(required)) {
      throw new Error(`missing ${required}`);
    }
  }
  return {
    assetsDir: path.resolve(values.get("--assets")),
    version: values.get("--version"),
    commit: values.get("--commit"),
    output: path.resolve(values.get("--output")),
  };
}

async function main(argv) {
  const options = parseArgs(argv);
  const manifest = await buildHostedReleaseManifest(options);
  await fsp.writeFile(options.output, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`build-hosted-release-manifest: ${error.message}\n`);
    process.exitCode = 1;
  });
}
