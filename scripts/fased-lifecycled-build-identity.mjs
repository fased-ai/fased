#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const OID = /^[a-f0-9]{40}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;

async function files(root, relative) {
  const absolute = path.join(root, relative);
  const stat = await fsp.lstat(absolute);
  if (stat.isSymbolicLink()) {
    throw new Error(`lifecycle build input must not be a symlink: ${relative}`);
  }
  if (stat.isFile()) {
    return [relative];
  }
  if (!stat.isDirectory()) {
    throw new Error(`unsupported lifecycle build input: ${relative}`);
  }
  const result = [];
  for (const entry of (await fsp.readdir(absolute)).toSorted()) {
    result.push(...(await files(root, path.join(relative, entry))));
  }
  return result;
}

export async function computeLifecycleBuildInputDigest(root) {
  const hash = createHash("sha256");
  for (const relative of (await files(root, path.join("tools", "fased-lifecycled"))).toSorted()) {
    const name = relative.split(path.sep).join("/");
    const data = await fsp.readFile(path.join(root, relative));
    hash.update(`${Buffer.byteLength(name)}:${name}:${data.length}:`);
    hash.update(data);
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function git(root, args, fallback) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return fallback;
  }
}

export function validateLifecycleBuildIdentity(value) {
  const identity = {
    version: String(value.version ?? "").trim(),
    commit: String(value.commit ?? "").trim(),
    tree: String(value.tree ?? "").trim(),
    buildInputDigest: String(value.buildInputDigest ?? "").trim(),
    development: value.development,
  };
  if (typeof identity.development !== "boolean") {
    throw new Error("lifecycle build development marker must be boolean");
  }
  if (identity.development) {
    if (identity.version !== "dev" && !SEMVER.test(identity.version)) {
      throw new Error("invalid lifecycle development version");
    }
    for (const [name, candidate] of [
      ["commit", identity.commit],
      ["tree", identity.tree],
    ]) {
      if (candidate !== "unknown" && !OID.test(candidate)) {
        throw new Error(`invalid lifecycle development ${name}`);
      }
    }
    if (identity.buildInputDigest !== "unknown" && !DIGEST.test(identity.buildInputDigest)) {
      throw new Error("invalid lifecycle development input digest");
    }
  } else if (
    !SEMVER.test(identity.version) ||
    !OID.test(identity.commit) ||
    !OID.test(identity.tree) ||
    !DIGEST.test(identity.buildInputDigest)
  ) {
    throw new Error(
      "release lifecycle identity requires version, full commit, full tree, and sha256 input digest",
    );
  }
  return Object.freeze(identity);
}

export async function resolveLifecycleBuildIdentity({
  root,
  env = process.env,
  developmentDefault = true,
}) {
  const packageJSON = JSON.parse(await fsp.readFile(path.join(root, "package.json"), "utf8"));
  const developmentRaw = String(env.FASED_LIFECYCLE_BUILD_DEVELOPMENT ?? developmentDefault);
  if (developmentRaw !== "true" && developmentRaw !== "false") {
    throw new Error("FASED_LIFECYCLE_BUILD_DEVELOPMENT must be true or false");
  }
  return validateLifecycleBuildIdentity({
    version: env.FASED_LIFECYCLE_BUILD_VERSION ?? packageJSON.version ?? "dev",
    commit: env.FASED_LIFECYCLE_BUILD_COMMIT ?? git(root, ["rev-parse", "HEAD"], "unknown"),
    tree: env.FASED_LIFECYCLE_BUILD_TREE ?? git(root, ["rev-parse", "HEAD^{tree}"], "unknown"),
    buildInputDigest:
      env.FASED_LIFECYCLE_BUILD_INPUT_DIGEST ?? (await computeLifecycleBuildInputDigest(root)),
    development: developmentRaw === "true",
  });
}

export function lifecycleIdentityLDFlags(value) {
  const identity = validateLifecycleBuildIdentity(value);
  return [
    `-X main.lifecycleBuildVersion=${identity.version}`,
    `-X main.lifecycleBuildCommit=${identity.commit}`,
    `-X main.lifecycleBuildTree=${identity.tree}`,
    `-X main.lifecycleBuildInputDigest=${identity.buildInputDigest}`,
    `-X main.lifecycleBuildDevelopment=${String(identity.development)}`,
  ].join(" ");
}

async function main(argv = process.argv.slice(2)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const identity = await resolveLifecycleBuildIdentity({ root });
  if (argv.length === 0 || argv[0] === "--json") {
    process.stdout.write(`${JSON.stringify(identity)}\n`);
  } else if (argv[0] === "--ldflags" && argv.length === 1) {
    process.stdout.write(`${lifecycleIdentityLDFlags(identity)}\n`);
  } else {
    throw new Error("usage: fased-lifecycled-build-identity.mjs [--json|--ldflags]");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(
      `fased-lifecycled-build-identity: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
