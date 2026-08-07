import { describe, expect, it } from "vitest";
import { verifyDependencyRemediation } from "./ci-dependency-integrity.mjs";

const basePackage = {
  name: "@fased/fased",
  dependencies: { undici: "7.28.0" },
  engines: { node: ">=22.14.0" },
  scripts: { test: "vitest" },
  pnpm: {
    overrides: {
      "fast-uri": "3.1.4",
      "ip-address": "10.2.0",
      "undici@7": "7.28.0",
    },
  },
};
const baseZaloPackage = { name: "@fased/zalo", dependencies: { undici: "7.28.0" } };
const baseLockfile = `lockfileVersion: '9.0'

overrides:
  fast-uri: 3.1.4
  ip-address: 10.2.0
  undici@7: 7.28.0

importers:
`;

function verify(
  headPackage = structuredClone(basePackage),
  headLockfile = baseLockfile,
  changedEntries = ["M\tpackage.json", "M\tpnpm-lock.yaml"],
  headZaloPackage = structuredClone(baseZaloPackage),
) {
  return verifyDependencyRemediation({
    changedEntries,
    basePackage,
    headPackage,
    baseLockfile,
    headLockfile,
    baseZaloPackage,
    headZaloPackage,
  });
}

describe("dependency integrity", () => {
  it("accepts one named advisory override mirrored by the lockfile", () => {
    const head = structuredClone(basePackage);
    head.pnpm.overrides["fast-uri"] = "3.1.5";
    expect(verify(head, baseLockfile.replace("3.1.4", "3.1.5"))).toEqual({
      remediations: [{ dependency: "fast-uri", fromVersion: "3.1.4", toVersion: "3.1.5" }],
    });
  });

  it("accepts the bounded nanoid override addition used by the production audit repair", () => {
    const head = structuredClone(basePackage);
    head.pnpm.overrides.nanoid = "3.3.17";
    expect(
      verify(head, baseLockfile.replace("overrides:\n", "overrides:\n  nanoid: 3.3.17\n")),
    ).toEqual({
      remediations: [{ dependency: "nanoid", fromVersion: null, toVersion: "3.3.17" }],
    });
  });

  it("accepts the bounded four-advisory remediation with aligned Undici manifests", () => {
    const head = structuredClone(basePackage);
    head.pnpm.overrides["fast-uri"] = "3.1.5";
    head.pnpm.overrides["ip-address"] = "10.3.1";
    head.pnpm.overrides["undici@7"] = "7.29.0";
    head.pnpm.overrides["undici@8"] = "8.9.0";
    head.dependencies.undici = "7.29.0";
    head.engines.node = ">=22.19.0";
    const headZalo = structuredClone(baseZaloPackage);
    headZalo.dependencies.undici = "7.29.0";
    const headLock = baseLockfile
      .replace("fast-uri: 3.1.4", "fast-uri: 3.1.5")
      .replace("ip-address: 10.2.0", "ip-address: 10.3.1")
      .replace("undici@7: 7.28.0", "undici@7: 7.29.0\n  undici@8: 8.9.0");
    expect(
      verify(
        head,
        headLock,
        ["M\textensions/zalo/package.json", "M\tpackage.json", "M\tpnpm-lock.yaml"],
        headZalo,
      ).remediations,
    ).toHaveLength(4);
  });

  it("rejects package script drift in the dependency lane", () => {
    const head = structuredClone(basePackage);
    head.pnpm.overrides["fast-uri"] = "3.1.5";
    head.scripts.test = "vitest --watch";
    expect(() => verify(head, baseLockfile.replace("3.1.4", "3.1.5"))).toThrow(
      /outside the named advisory remediation/u,
    );
  });
});
