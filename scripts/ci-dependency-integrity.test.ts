import { describe, expect, it } from "vitest";
import { verifyDependencyRemediation } from "./ci-dependency-integrity.mjs";

const basePackage = {
  name: "@fased/fased",
  scripts: { test: "vitest" },
  pnpm: { overrides: { "brace-expansion": "5.0.8", postcss: "8.5.18" } },
};
const baseLockfile = `lockfileVersion: '9.0'

overrides:
  brace-expansion: 5.0.8
  postcss: 8.5.18

importers:
`;

function verify(headPackage = structuredClone(basePackage), headLockfile = baseLockfile) {
  return verifyDependencyRemediation({
    changedEntries: ["M\tpackage.json", "M\tpnpm-lock.yaml"],
    basePackage,
    headPackage,
    baseLockfile,
    headLockfile,
  });
}

describe("dependency integrity", () => {
  it("accepts one higher exact override mirrored by the lockfile", () => {
    const head = structuredClone(basePackage);
    head.pnpm.overrides["brace-expansion"] = "5.0.9";
    expect(verify(head, baseLockfile.replace("5.0.8", "5.0.9"))).toEqual({
      dependency: "brace-expansion",
      fromVersion: "5.0.8",
      toVersion: "5.0.9",
    });
  });

  it("rejects package script drift in the dependency lane", () => {
    const head = structuredClone(basePackage);
    head.pnpm.overrides["brace-expansion"] = "5.0.9";
    head.scripts.test = "vitest --watch";
    expect(() => verify(head, baseLockfile.replace("5.0.8", "5.0.9"))).toThrow(
      /outside the one override/u,
    );
  });
});
