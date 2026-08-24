#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

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

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] !== "--inventory-only") {
    throw new Error("ci-version-identity requires --inventory-only");
  }
  const version = validateCurrentVersionInventory(resolve("."));
  console.log(`ci-version-identity: ${version} has one synchronized release identity`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
