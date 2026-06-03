#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = new Set(process.argv.slice(2));
const checkOnly = args.has("--check");
const writeMode = args.has("--write") || !checkOnly;

if (checkOnly && args.has("--write")) {
  console.error("Use either --check or --write, not both.");
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const policyPath = path.join(repoRoot, "src", "infra", "host-env-security-policy.json");
const outputPaths = [
  path.join(
    repoRoot,
    "apps",
    "macos",
    "Sources",
    "FasedAgent",
    "HostEnvSecurityPolicy.generated.swift",
  ),
];

/**
 * @type {{
 *   blockedEverywhereKeys?: string[];
 *   blockedOverrideOnlyKeys?: string[];
 *   allowedInheritedOverrideOnlyKeys?: string[];
 *   blockedKeys?: string[];
 *   blockedOverrideKeys?: string[];
 *   blockedOverridePrefixes?: string[];
 *   blockedPrefixes: string[];
 * }}
 */
const rawPolicy = JSON.parse(fs.readFileSync(policyPath, "utf8"));

const sortUniqueUpper = (items) =>
  Array.from(new Set(items.map((item) => item.toUpperCase()))).sort((a, b) => a.localeCompare(b));
const blockedKeys = sortUniqueUpper(rawPolicy.blockedEverywhereKeys ?? rawPolicy.blockedKeys ?? []);
const blockedOverrideKeys = sortUniqueUpper(
  rawPolicy.blockedOverrideOnlyKeys ?? rawPolicy.blockedOverrideKeys ?? [],
);
const allowedInheritedOverrideOnlyKeys = new Set(
  sortUniqueUpper(rawPolicy.allowedInheritedOverrideOnlyKeys ?? []),
);
const blockedInheritedKeys = sortUniqueUpper([
  ...blockedKeys,
  ...blockedOverrideKeys.filter((key) => !allowedInheritedOverrideOnlyKeys.has(key)),
]);
const blockedPrefixes = sortUniqueUpper(rawPolicy.blockedPrefixes);
const blockedInheritedPrefixes = blockedPrefixes;
const blockedOverridePrefixes = sortUniqueUpper(rawPolicy.blockedOverridePrefixes ?? []);

const renderSwiftStringArray = (items) => items.map((item) => `        "${item}"`).join(",\n");

const generated = `// Generated file. Do not edit directly.
// Source: src/infra/host-env-security-policy.json
// Regenerate: node scripts/generate-host-env-security-policy-swift.mjs --write

import Foundation

enum HostEnvSecurityPolicy {
    static let blockedInheritedKeys: Set<String> = [
${renderSwiftStringArray(blockedInheritedKeys)}
    ]

    static let blockedInheritedPrefixes: [String] = [
${renderSwiftStringArray(blockedInheritedPrefixes)}
    ]

    static let blockedKeys: Set<String> = [
${renderSwiftStringArray(blockedKeys)}
    ]

    static let blockedOverrideKeys: Set<String> = [
${renderSwiftStringArray(blockedOverrideKeys)}
    ]

    static let blockedOverridePrefixes: [String] = [
${renderSwiftStringArray(blockedOverridePrefixes)}
    ]

    static let blockedPrefixes: [String] = [
${renderSwiftStringArray(blockedPrefixes)}
    ]
}
`;

if (checkOnly) {
  const stale = [];
  for (const outputPath of outputPaths) {
    const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : null;
    if (current === generated) {
      console.log(`OK ${path.relative(repoRoot, outputPath)}`);
    } else {
      stale.push(path.relative(repoRoot, outputPath));
    }
  }
  if (stale.length > 0) {
    console.error(
      ["Out of date generated host env policy files:", ...stale, ""].join("\n") +
        "Run: node scripts/generate-host-env-security-policy-swift.mjs --write",
    );
    process.exit(1);
  }
  process.exit(0);
}

if (writeMode) {
  for (const outputPath of outputPaths) {
    const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : null;
    if (current !== generated) {
      fs.writeFileSync(outputPath, generated);
    }
    console.log(`Wrote ${path.relative(repoRoot, outputPath)}`);
  }
}
