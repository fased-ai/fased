import { describe, expect, it } from "vitest";
import { verifyDependencyRemediation } from "./ci-dependency-integrity.mjs";

const baseManifests = {
  "package.json": {
    name: "@fased/fased",
    dependencies: { tar: "7.5.19" },
    scripts: { test: "vitest" },
    pnpm: {
      overrides: {
        hono: "4.12.27",
        tar: "7.5.19",
        "undici@6": "6.27.0",
      },
    },
  },
  "ui/package.json": {
    name: "fased-control-ui",
    dependencies: { dompurify: "3.4.11" },
    scripts: { test: "vitest" },
  },
};
const baseLockfile = `lockfileVersion: '9.0'

overrides:
  hono: 4.12.27
  tar: 7.5.19
  undici@6: 6.27.0

importers:
`;

function verify(
  headManifests = structuredClone(baseManifests),
  headLockfile = baseLockfile,
  changedEntries = ["M\tpackage.json", "M\tpnpm-lock.yaml", "M\tui/package.json"],
) {
  return verifyDependencyRemediation({
    changedEntries,
    baseManifests,
    headManifests,
    baseLockfile,
    headLockfile,
  });
}

describe("dependency integrity", () => {
  it("accepts version-only remediation across root and workspace manifests", () => {
    const head = structuredClone(baseManifests);
    head["package.json"].dependencies.tar = "7.5.21";
    head["package.json"].pnpm.overrides.hono = "4.12.34";
    head["package.json"].pnpm.overrides.tar = "7.5.21";
    head["package.json"].pnpm.overrides["undici@6"] = "6.28.0";
    head["ui/package.json"].dependencies.dompurify = "3.4.13";
    const result = verify(
      head,
      baseLockfile
        .replace("hono: 4.12.27", "hono: 4.12.34")
        .replace("tar: 7.5.19", "tar: 7.5.21")
        .replace("undici@6: 6.27.0", "undici@6: 6.28.0"),
    );

    expect(
      [...new Set(result.remediations.map(({ dependency }) => dependency))].toSorted(
        (left, right) => left.localeCompare(right),
      ),
    ).toEqual(["dompurify", "hono", "tar", "undici"]);
  });

  it("accepts a bounded new root override", () => {
    const head = { "package.json": structuredClone(baseManifests["package.json"]) };
    head["package.json"].pnpm.overrides.nanoid = "3.3.17";
    const result = verifyDependencyRemediation({
      changedEntries: ["M\tpackage.json", "M\tpnpm-lock.yaml"],
      baseManifests: { "package.json": baseManifests["package.json"] },
      headManifests: head,
      baseLockfile,
      headLockfile: baseLockfile.replace("overrides:\n", "overrides:\n  nanoid: 3.3.17\n"),
    });
    expect(result.remediations).toContainEqual({
      dependency: "nanoid",
      field: "pnpm.overrides.nanoid",
      fromVersion: null,
      manifest: "package.json",
      toVersion: "3.3.17",
    });
  });

  it("rejects package script drift", () => {
    const head = structuredClone(baseManifests);
    head["package.json"].pnpm.overrides.hono = "4.12.34";
    head["package.json"].scripts.test = "vitest --watch";
    expect(() => verify(head, baseLockfile.replace("hono: 4.12.27", "hono: 4.12.34"))).toThrow(
      /outside dependency versions/u,
    );
  });

  it("rejects downgrades and version-range widening", () => {
    const downgrade = structuredClone(baseManifests);
    downgrade["package.json"].dependencies.tar = "7.5.18";
    expect(() => verify(downgrade, `${baseLockfile}\n# changed`)).toThrow(
      /not a version increase/u,
    );

    const widened = structuredClone(baseManifests);
    widened["ui/package.json"].dependencies.dompurify = "^3.4.13";
    expect(() => verify(widened, `${baseLockfile}\n# changed`)).toThrow(/version-range prefix/u);
  });

  it("rejects source files outside manifests and the lockfile", () => {
    const head = structuredClone(baseManifests);
    head["package.json"].pnpm.overrides.hono = "4.12.34";
    expect(() =>
      verify(head, baseLockfile.replace("hono: 4.12.27", "hono: 4.12.34"), [
        "M\tpackage.json",
        "M\tpnpm-lock.yaml",
        "M\tsrc/index.ts",
        "M\tui/package.json",
      ]),
    ).toThrow(/outside package manifests/u);
  });
});
