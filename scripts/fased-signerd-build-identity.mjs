#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SEMVER_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;

async function listRegularFiles(root, relative) {
  const absolute = path.join(root, relative);
  const stat = await fsp.lstat(absolute);
  if (stat.isSymbolicLink()) {
    throw new Error(`signer build input must not be a symlink: ${relative}`);
  }
  if (stat.isFile()) {
    return [relative];
  }
  if (!stat.isDirectory()) {
    throw new Error(`unsupported signer build input: ${relative}`);
  }
  const entries = await fsp.readdir(absolute);
  const files = [];
  for (const entry of entries.toSorted()) {
    files.push(...(await listRegularFiles(root, path.join(relative, entry))));
  }
  return files;
}

export async function computeSignerBuildInputDigest(root) {
  const hash = createHash("sha256");
  const files = [
    "package.json",
    ...(await listRegularFiles(root, path.join("tools", "fased-signerd"))),
  ];
  for (const relative of files.toSorted((left, right) => left.localeCompare(right))) {
    const normalized = relative.split(path.sep).join("/");
    const contents = await fsp.readFile(path.join(root, relative));
    hash.update(`${Buffer.byteLength(normalized)}:${normalized}:${contents.length}:`, "utf8");
    hash.update(contents);
    hash.update("\0", "utf8");
  }
  return `sha256:${hash.digest("hex")}`;
}

function gitCommit(root) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

export function validateSignerBuildIdentity(identity) {
  const version = String(identity.version ?? "").trim();
  const commit = String(identity.commit ?? "").trim();
  const buildInputDigest = String(identity.buildInputDigest ?? "").trim();
  const development = identity.development;
  if (typeof development !== "boolean") {
    throw new Error("signer build development marker must be true or false");
  }
  if (development) {
    if (version !== "dev" && !SEMVER_PATTERN.test(version)) {
      throw new Error("development signer build version is invalid");
    }
    if (commit !== "unknown" && !COMMIT_PATTERN.test(commit)) {
      throw new Error("development signer build commit is invalid");
    }
    if (buildInputDigest !== "unknown" && !DIGEST_PATTERN.test(buildInputDigest)) {
      throw new Error("development signer build-input digest is invalid");
    }
  } else if (
    !SEMVER_PATTERN.test(version) ||
    !COMMIT_PATTERN.test(commit) ||
    !DIGEST_PATTERN.test(buildInputDigest)
  ) {
    throw new Error(
      "release signer identity requires canonical version, full lowercase commit, and sha256 build-input digest",
    );
  }
  return Object.freeze({ version, commit, buildInputDigest, development });
}

export async function resolveSignerBuildIdentity({
  root,
  env = process.env,
  developmentDefault = true,
}) {
  const packageJSON = JSON.parse(await fsp.readFile(path.join(root, "package.json"), "utf8"));
  const developmentRaw = String(env.FASED_SIGNER_BUILD_DEVELOPMENT ?? developmentDefault).trim();
  if (developmentRaw !== "true" && developmentRaw !== "false") {
    throw new Error("FASED_SIGNER_BUILD_DEVELOPMENT must be true or false");
  }
  return validateSignerBuildIdentity({
    version: String(env.FASED_SIGNER_BUILD_VERSION ?? packageJSON.version ?? "dev"),
    commit: String(env.FASED_SIGNER_BUILD_COMMIT ?? gitCommit(root)),
    buildInputDigest: String(
      env.FASED_SIGNER_BUILD_INPUT_DIGEST ?? (await computeSignerBuildInputDigest(root)),
    ),
    development: developmentRaw === "true",
  });
}

export function signerIdentityLDFlags(identity) {
  const resolved = validateSignerBuildIdentity(identity);
  return [
    `-X main.signerBuildVersion=${resolved.version}`,
    `-X main.signerBuildCommit=${resolved.commit}`,
    `-X main.signerBuildInputDigest=${resolved.buildInputDigest}`,
    `-X main.signerBuildDevelopment=${String(resolved.development)}`,
  ].join(" ");
}

async function main(argv = process.argv.slice(2)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const identity = await resolveSignerBuildIdentity({ root });
  if (argv.length === 0 || argv[0] === "--json") {
    process.stdout.write(`${JSON.stringify(identity)}\n`);
    return;
  }
  if (argv[0] === "--ldflags" && argv.length === 1) {
    process.stdout.write(`${signerIdentityLDFlags(identity)}\n`);
    return;
  }
  if (argv[0] === "--github-output" && argv.length === 1) {
    process.stdout.write(
      [
        `version=${identity.version}`,
        `commit=${identity.commit}`,
        `build_input_digest=${identity.buildInputDigest}`,
        `development=${String(identity.development)}`,
      ].join("\n") + "\n",
    );
    return;
  }
  throw new Error("usage: fased-signerd-build-identity.mjs [--json|--ldflags|--github-output]");
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    process.stderr.write(
      `fased-signerd-build-identity: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
