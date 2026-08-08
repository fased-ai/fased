#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { classifyChangedPaths, changedPathsFromGit } from "./ci-change-scope.mjs";

const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function readGitFile(ref, path) {
  return execFileSync("git", ["show", `${ref}:${path}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function diffBase(env = process.env) {
  if (env.GITHUB_EVENT_NAME === "push") {
    const before = env.GITHUB_EVENT_BEFORE?.trim();
    return before && !/^0+$/.test(before) ? before : "HEAD^";
  }
  if (env.GITHUB_EVENT_NAME === "pull_request") {
    const baseRef = env.GITHUB_BASE_REF?.trim();
    if (baseRef) {
      try {
        return execFileSync("git", ["merge-base", `origin/${baseRef}`, "HEAD"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
      } catch {
        // Fall through to the event base SHA.
      }
    }
    if (env.GITHUB_BASE_SHA?.trim()) {
      return env.GITHUB_BASE_SHA.trim();
    }
  }
  return "HEAD^";
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function assertPackageVersionOnlyChange(before, after, path) {
  const normalized = clone(after);
  normalized.version = before.version;

  if (path.startsWith("extensions/")) {
    const beforePeer = before.peerDependencies?.["@fased/fased"];
    if (beforePeer === undefined) {
      if (normalized.peerDependencies) {
        delete normalized.peerDependencies["@fased/fased"];
        if (Object.keys(normalized.peerDependencies).length === 0) {
          delete normalized.peerDependencies;
        }
      }
    } else {
      normalized.peerDependencies ??= {};
      normalized.peerDependencies["@fased/fased"] = beforePeer;
    }
  }

  assert.deepEqual(normalized, before, `${path} contains a non-version package change`);
}

export function assertBrandVersionOnlyChange(before, after, expectedVersion) {
  const versionPattern = /(FASED_PRODUCT_VERSION\s*=\s*")[^"]+(")/;
  const match = versionPattern.exec(after);
  assert.equal(match?.[0]?.includes(`"${expectedVersion}"`), true, "src/brand.ts version mismatch");
  assert.equal(
    after.replace(versionPattern, "$1<VERSION>$2"),
    before.replace(versionPattern, "$1<VERSION>$2"),
    "src/brand.ts contains a non-version change",
  );
}

export function isLineSubsequence(before, after) {
  const previous = before.split(/\r?\n/);
  const current = after.split(/\r?\n/);
  let cursor = 0;
  for (const line of current) {
    if (line === previous[cursor]) {
      cursor += 1;
    }
  }
  return cursor === previous.length;
}

export function validateCurrentVersionInventory(repoRoot = resolve(".")) {
  const rootPackage = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const version = rootPackage.version;
  assert.equal(typeof version, "string", "root package version is missing");
  assert.match(version, VERSION_RE, "root package version is not exact semver");

  const brand = readFileSync(join(repoRoot, "src/brand.ts"), "utf8");
  assert.match(
    brand,
    new RegExp(`FASED_PRODUCT_VERSION\\s*=\\s*"${version.replaceAll(".", "\\.")}"`),
    "brand version does not match package.json",
  );

  for (const entry of readdirSync(join(repoRoot, "extensions"), { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const packagePath = join(repoRoot, "extensions", entry.name, "package.json");
    let extension;
    try {
      extension = JSON.parse(readFileSync(packagePath, "utf8"));
    } catch {
      continue;
    }
    if (!extension.name) {
      continue;
    }
    assert.equal(extension.version, version, `${entry.name} version does not match core`);
    const peer = extension.peerDependencies?.["@fased/fased"];
    if (peer !== undefined) {
      assert.equal(peer, `^${version}`, `${entry.name} core peer does not match core`);
    }
  }

  return version;
}

export function validateVersionOnlyDiff(
  base,
  paths,
  repoRoot = resolve("."),
  { allowExactTag = false } = {},
) {
  const scope = classifyChangedPaths(paths);
  assert.equal(scope.versionOnly, true, "changed paths are not an exact version-only release set");

  const version = validateCurrentVersionInventory(repoRoot);
  const previousRoot = JSON.parse(readGitFile(base, "package.json"));
  assert.notEqual(previousRoot.version, version, "release version did not change");

  for (const path of paths) {
    const before = readGitFile(base, path);
    const after = readFileSync(join(repoRoot, path), "utf8");
    if (path === "package.json" || path.endsWith("/package.json")) {
      assertPackageVersionOnlyChange(JSON.parse(before), JSON.parse(after), path);
      continue;
    }
    if (path === "src/brand.ts") {
      assertBrandVersionOnlyChange(before, after, version);
      continue;
    }
    assert.equal(
      isLineSubsequence(before, after),
      true,
      `${path} deletes or rewrites existing changelog content`,
    );
    assert.match(after, new RegExp(`^##\\s+v?${version.replaceAll(".", "\\.")}\\s*$`, "m"));
  }

  const tagRef = `refs/tags/v${version}`;
  try {
    execFileSync("git", ["show-ref", "--verify", "--quiet", tagRef], { cwd: repoRoot });
  } catch {
    return version;
  }
  if (allowExactTag) {
    const tagCommit = execFileSync("git", ["rev-parse", `${tagRef}^{commit}`], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    const headCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    assert.equal(tagCommit, headCommit, `release tag v${version} does not resolve to HEAD`);
    return version;
  }
  throw new Error(`release tag v${version} already exists`);
}

function main() {
  const args = process.argv.slice(2);
  const allowExactTag = args.length === 1 && args[0] === "--allow-exact-tag";
  if (args.length > 0 && !allowExactTag) {
    throw new Error(`unsupported arguments: ${args.join(" ")}`);
  }
  const base = diffBase();
  const paths = changedPathsFromGit();
  const version = validateVersionOnlyDiff(base, paths, resolve("."), { allowExactTag });
  console.log(
    `ci-version-identity: ${version} is an exact ${
      allowExactTag ? "immutable-tagged" : "untagged"
    } version-only change`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
