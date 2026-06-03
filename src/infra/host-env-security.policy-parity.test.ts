import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

type HostEnvSecurityPolicy = {
  blockedEverywhereKeys?: string[];
  blockedOverrideOnlyKeys?: string[];
  allowedInheritedOverrideOnlyKeys?: string[];
  blockedKeys?: string[];
  blockedOverrideKeys?: string[];
  blockedOverridePrefixes?: string[];
  blockedPrefixes: string[];
};

function parseSwiftStringArray(source: string, marker: string): string[] {
  const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${escapedMarker}[\\s\\S]*?=\\s*\\[([\\s\\S]*?)\\]`, "m");
  const match = source.match(re);
  if (!match) {
    throw new Error(`Failed to parse Swift array for marker: ${marker}`);
  }
  return Array.from(match[1].matchAll(/"([^"]+)"/g), (m) => m[1]);
}

function sortUniqueUpper(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.toUpperCase()))).toSorted((a, b) =>
    a.localeCompare(b),
  );
}

describe("host env security policy parity", () => {
  it("keeps generated macOS host env policy in sync with shared JSON policy", () => {
    const repoRoot = process.cwd();
    const policyPath = path.join(repoRoot, "src/infra/host-env-security-policy.json");
    const generatedSwiftPaths = [
      path.join(repoRoot, "apps/macos/Sources/FasedAgent/HostEnvSecurityPolicy.generated.swift"),
    ];
    const sanitizerSwiftPath = path.join(
      repoRoot,
      "apps/macos/Sources/FasedAgent/HostEnvSanitizer.swift",
    );

    const policy = JSON.parse(fs.readFileSync(policyPath, "utf8")) as HostEnvSecurityPolicy;
    const blockedKeys = sortUniqueUpper(policy.blockedEverywhereKeys ?? policy.blockedKeys ?? []);
    const blockedOverrideKeys = sortUniqueUpper(
      policy.blockedOverrideOnlyKeys ?? policy.blockedOverrideKeys ?? [],
    );
    const allowedInheritedOverrideOnlyKeys = new Set(
      sortUniqueUpper(policy.allowedInheritedOverrideOnlyKeys ?? []),
    );
    const blockedInheritedKeys = sortUniqueUpper([
      ...blockedKeys,
      ...blockedOverrideKeys.filter((key) => !allowedInheritedOverrideOnlyKeys.has(key)),
    ]);
    const blockedPrefixes = sortUniqueUpper(policy.blockedPrefixes);
    const blockedInheritedPrefixes = blockedPrefixes;
    const blockedOverridePrefixes = sortUniqueUpper(policy.blockedOverridePrefixes ?? []);
    const sanitizerSource = fs.readFileSync(sanitizerSwiftPath, "utf8");

    for (const generatedSwiftPath of generatedSwiftPaths) {
      const generatedSource = fs.readFileSync(generatedSwiftPath, "utf8");

      const swiftBlockedInheritedKeys = parseSwiftStringArray(
        generatedSource,
        "static let blockedInheritedKeys",
      );
      const swiftBlockedInheritedPrefixes = parseSwiftStringArray(
        generatedSource,
        "static let blockedInheritedPrefixes",
      );
      const swiftBlockedKeys = parseSwiftStringArray(generatedSource, "static let blockedKeys");
      const swiftBlockedOverrideKeys = parseSwiftStringArray(
        generatedSource,
        "static let blockedOverrideKeys",
      );
      const swiftBlockedOverridePrefixes = parseSwiftStringArray(
        generatedSource,
        "static let blockedOverridePrefixes",
      );
      const swiftBlockedPrefixes = parseSwiftStringArray(
        generatedSource,
        "static let blockedPrefixes",
      );

      expect(swiftBlockedInheritedKeys).toEqual(blockedInheritedKeys);
      expect(swiftBlockedInheritedPrefixes).toEqual(blockedInheritedPrefixes);
      expect(swiftBlockedKeys).toEqual(blockedKeys);
      expect(swiftBlockedOverrideKeys).toEqual(blockedOverrideKeys);
      expect(swiftBlockedOverridePrefixes).toEqual(blockedOverridePrefixes);
      expect(swiftBlockedPrefixes).toEqual(blockedPrefixes);
    }

    expect(sanitizerSource).toContain(
      "private static let blockedInheritedKeys = HostEnvSecurityPolicy.blockedInheritedKeys",
    );
    expect(sanitizerSource).toContain(
      "private static let blockedInheritedPrefixes = HostEnvSecurityPolicy.blockedInheritedPrefixes",
    );
    expect(sanitizerSource).toContain(
      "private static let blockedKeys = HostEnvSecurityPolicy.blockedKeys",
    );
    expect(sanitizerSource).toContain(
      "private static let blockedOverrideKeys = HostEnvSecurityPolicy.blockedOverrideKeys",
    );
    expect(sanitizerSource).toContain(
      "private static let blockedOverridePrefixes = HostEnvSecurityPolicy.blockedOverridePrefixes",
    );
    expect(sanitizerSource).toContain(
      "private static let blockedPrefixes = HostEnvSecurityPolicy.blockedPrefixes",
    );
  });
});
