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

function githubReleaseExists(tag) {
  const repository = process.env.GITHUB_REPOSITORY;
  assert.match(
    repository ?? "",
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u,
    "GITHUB_REPOSITORY is required",
  );
  try {
    execFileSync("gh", ["api", `repos/${repository}/releases/tags/${tag}`], {
      cwd: resolve("."),
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

export function assertLatestPublishedBaseRestore({
  allowObsoleteTaggedCandidate = false,
  base,
  previousVersion,
  releaseExists = githubReleaseExists,
  repoRoot,
  version,
}) {
  const previousTag = `refs/tags/v${previousVersion}`;
  try {
    execFileSync("git", ["show-ref", "--verify", "--quiet", previousTag], { cwd: repoRoot });
  } catch {
    // A failed candidate must remain untagged.
    const tagRef = `refs/tags/v${version}`;
    execFileSync("git", ["merge-base", "--is-ancestor", tagRef, base], { cwd: repoRoot });
    const latestPublishedTag = execFileSync(
      "git",
      ["tag", "--merged", base, "--list", "v*", "--sort=-v:refname"],
      { cwd: repoRoot, encoding: "utf8" },
    )
      .split(/\r?\n/u)
      .find((tag) => tag.startsWith("v") && VERSION_RE.test(tag.slice(1)));
    assert.equal(
      latestPublishedTag,
      `v${version}`,
      "version restore target is not the latest published ancestor",
    );
    return;
  }
  if (allowObsoleteTaggedCandidate) {
    execFileSync("git", ["merge-base", "--is-ancestor", previousTag, base], { cwd: repoRoot });
    execFileSync("git", ["merge-base", "--is-ancestor", `refs/tags/v${version}`, base], {
      cwd: repoRoot,
    });
    assert.equal(releaseExists(`v${previousVersion}`), false, "obsolete candidate is published");
    assert.equal(releaseExists(`v${version}`), true, "restore target is not published");
    return;
  }
  throw new Error(`failed candidate version v${previousVersion} is already tagged`);
}

export function validateVersionOnlyDiff(
  base,
  paths,
  repoRoot = resolve("."),
  {
    allowExactTag = false,
    allowObsoleteTaggedCandidateRestore = false,
    allowPublishedBaseRestore = false,
  } = {},
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
  if (allowPublishedBaseRestore) {
    assertLatestPublishedBaseRestore({
      allowObsoleteTaggedCandidate: allowObsoleteTaggedCandidateRestore,
      base,
      previousVersion: previousRoot.version,
      repoRoot,
      version,
    });
    return version;
  }
  throw new Error(`release tag v${version} already exists`);
}

function main() {
  const args = process.argv.slice(2);
  const inventoryOnly = args.length === 1 && args[0] === "--inventory-only";
  const allowExactTag = args.length === 1 && args[0] === "--allow-exact-tag";
  const allowPublishedBaseRestore =
    args.length === 1 && args[0] === "--allow-published-base-restore";
  const allowObsoleteTaggedCandidateRestore =
    args.length === 1 && args[0] === "--allow-obsolete-tagged-candidate-restore";
  if (
    args.length > 0 &&
    !inventoryOnly &&
    !allowExactTag &&
    !allowPublishedBaseRestore &&
    !allowObsoleteTaggedCandidateRestore
  ) {
    throw new Error(`unsupported arguments: ${args.join(" ")}`);
  }
  if (inventoryOnly) {
    const version = validateCurrentVersionInventory(resolve("."));
    console.log(`ci-version-identity: ${version} has one synchronized release identity`);
    return;
  }
  const base = diffBase();
  const paths = changedPathsFromGit();
  const version = validateVersionOnlyDiff(base, paths, resolve("."), {
    allowExactTag,
    allowObsoleteTaggedCandidateRestore,
    allowPublishedBaseRestore: allowPublishedBaseRestore || allowObsoleteTaggedCandidateRestore,
  });
  const identityMode = allowExactTag
    ? "immutable-tagged"
    : allowObsoleteTaggedCandidateRestore
      ? "unpublished-obsolete-tag-restored-to-latest-published-base"
      : allowPublishedBaseRestore
        ? "untagged-or-latest-published-base-restored"
        : "untagged";
  console.log(`ci-version-identity: ${version} is an exact ${identityMode} version-only change`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
