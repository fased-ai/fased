#!/usr/bin/env node

import net from "node:net";
import { pathToFileURL } from "node:url";

const MAX_RESPONSE_BYTES = 1 << 20;
const REQUIRED_FEATURES = [
  "failClosedPolicies",
  "durableCaps",
  "atomicMultiAssetCaps",
  "signerControlledNativeFeeCaps",
  "atomicIdempotency",
  "signerOwnedKeys",
  "typedSolanaTransactions",
];
const NATIVE_FEE_RESERVATION_LAMPORTS = 6_500_000;
const RELEASE_VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const RELEASE_COMMIT_RE = /^[a-f0-9]{40}$/u;
const RELEASE_DIGEST_RE = /^sha256:[a-f0-9]{64}$/u;

function validateReleaseIdentity(release, options = {}) {
  if (!release || typeof release !== "object" || typeof release.development !== "boolean") {
    return false;
  }
  const version = typeof release.version === "string" ? release.version : "";
  const commit = typeof release.commit === "string" ? release.commit : "";
  const digest = typeof release.buildInputDigest === "string" ? release.buildInputDigest : "";
  if (release.development) {
    if (
      (version !== "dev" && !RELEASE_VERSION_RE.test(version)) ||
      (commit !== "unknown" && !RELEASE_COMMIT_RE.test(commit)) ||
      (digest !== "unknown" && !RELEASE_DIGEST_RE.test(digest))
    ) {
      return false;
    }
  } else if (
    !RELEASE_VERSION_RE.test(version) ||
    !RELEASE_COMMIT_RE.test(commit) ||
    !RELEASE_DIGEST_RE.test(digest)
  ) {
    return false;
  }
  if (options.requireProduction === true && release.development) {
    return false;
  }
  return (
    (!options.expectedVersion || version === options.expectedVersion) &&
    (!options.expectedCommit || commit === options.expectedCommit) &&
    (!options.expectedBuildInputDigest || digest === options.expectedBuildInputDigest) &&
    (options.expectedDevelopment === undefined ||
      release.development === options.expectedDevelopment)
  );
}

export function validateDockerSignerHealthEnvelope(envelope, options = {}) {
  if (!envelope || typeof envelope !== "object" || envelope.ok !== true) {
    return false;
  }
  const result = envelope.result;
  const protocol = result?.capabilities?.protocol;
  const features = new Set(
    Array.isArray(result?.capabilities?.features) ? result.capabilities.features : [],
  );
  return (
    result?.ready === true &&
    protocol?.current === 2 &&
    Number(protocol?.min) <= 2 &&
    Number(protocol?.max) >= 2 &&
    result?.capabilities?.nativeFeeReservationLamports === NATIVE_FEE_RESERVATION_LAMPORTS &&
    validateReleaseIdentity(result?.release, options) &&
    REQUIRED_FEATURES.every((feature) => features.has(feature))
  );
}

export async function checkDockerSignerHealth(socketPath, options = {}) {
  const timeoutMs = options.timeoutMs ?? 3_000;
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    let buffer = "";
    let settled = false;
    const finish = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const timer = setTimeout(
      () => finish(new Error(`native signer health timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write('{"op":"v2.capabilities"}\n'));
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_RESPONSE_BYTES) {
        finish(new Error("native signer health response is too large"));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        return;
      }
      try {
        const envelope = JSON.parse(buffer.slice(0, newline));
        finish(
          validateDockerSignerHealthEnvelope(envelope, options)
            ? undefined
            : new Error("native signer did not acknowledge required protocol-v2 capabilities"),
        );
      } catch {
        finish(new Error("native signer returned invalid health JSON"));
      }
    });
    socket.once("error", (error) => finish(error));
    socket.once("end", () => {
      if (!settled) {
        finish(new Error("native signer closed before returning health"));
      }
    });
  });
}

async function main(argv = process.argv.slice(2)) {
  const args = [...argv];
  const socketPath = String(
    args.shift() ?? process.env.FASED_WALLET_LOCAL_SIGNER_SOCKET ?? "",
  ).trim();
  if (!socketPath.startsWith("/")) {
    throw new Error("an absolute native signer socket path is required");
  }
  let expectedVersion;
  let expectedCommit;
  let expectedBuildInputDigest;
  let expectedDevelopment;
  let requireProduction = false;
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--expected-version") {
      expectedVersion = String(args.shift() ?? "").trim();
      if (expectedVersion !== "dev" && !RELEASE_VERSION_RE.test(expectedVersion)) {
        throw new Error("--expected-version requires canonical semver or dev");
      }
      continue;
    }
    if (arg === "--expected-commit") {
      expectedCommit = String(args.shift() ?? "").trim();
      if (expectedCommit !== "unknown" && !RELEASE_COMMIT_RE.test(expectedCommit)) {
        throw new Error("--expected-commit requires a full lowercase Git commit or unknown");
      }
      continue;
    }
    if (arg === "--expected-build-input-digest") {
      expectedBuildInputDigest = String(args.shift() ?? "").trim();
      if (
        expectedBuildInputDigest !== "unknown" &&
        !RELEASE_DIGEST_RE.test(expectedBuildInputDigest)
      ) {
        throw new Error(
          "--expected-build-input-digest requires sha256:<64 lowercase hex> or unknown",
        );
      }
      continue;
    }
    if (arg === "--expected-development") {
      const value = String(args.shift() ?? "").trim();
      if (value !== "true" && value !== "false") {
        throw new Error("--expected-development requires true or false");
      }
      expectedDevelopment = value === "true";
      continue;
    }
    if (arg === "--require-production") {
      requireProduction = true;
      continue;
    }
    throw new Error(`unknown argument: ${String(arg)}`);
  }
  await checkDockerSignerHealth(socketPath, {
    expectedVersion,
    expectedCommit,
    expectedBuildInputDigest,
    expectedDevelopment,
    requireProduction,
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    process.stderr.write(
      `fased-signerd unhealthy: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
