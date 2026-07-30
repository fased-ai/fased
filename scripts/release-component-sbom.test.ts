import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildGoComponentSbomFromModules,
  buildNodeComponentSbom,
} from "./release-component-sbom.mjs";

const created = "2026-07-29T00:00:00.000Z";

describe("release component SBOM generation", () => {
  it("derives deterministic production Node components from the installed lock", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fased-node-sbom-"));
    const packageLockPath = path.join(root, "package-lock.json");
    await Promise.all([
      fsp.mkdir(path.join(root, "node_modules", "@scope", "example"), { recursive: true }),
      fsp.mkdir(path.join(root, "node_modules", "example"), { recursive: true }),
    ]);
    await fsp.writeFile(
      packageLockPath,
      `${JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { name: "@fased/fased", version: "1.2.3" },
          "node_modules/@scope/example": {
            version: "2.0.0",
            license: "MIT",
            resolved: "https://registry.npmjs.org/@scope/example/-/example-2.0.0.tgz",
          },
          "node_modules/example": {
            name: "example",
            version: "1.0.0",
            license: "Apache-2.0",
          },
        },
      })}\n`,
    );
    const first = await buildNodeComponentSbom({
      packageLockPath,
      version: "1.2.3",
      architecture: "x64",
      created,
    });
    const second = await buildNodeComponentSbom({
      packageLockPath,
      version: "1.2.3",
      architecture: "x64",
      created,
    });
    expect(second).toEqual(first);
    expect(first.packages.map((entry) => entry.externalRefs[0].referenceLocator)).toEqual([
      "pkg:npm/%40scope/example@2.0.0",
      "pkg:npm/example@1.0.0",
    ]);
  });

  it("normalizes the exact signer module graph and rejects mutable versions", () => {
    const sbom = buildGoComponentSbomFromModules({
      modules: [
        { Path: "fased-signerd", Main: true },
        { Path: "golang.org/x/crypto", Version: "v0.52.0" },
      ],
      version: "1.2.3",
      commit: "a".repeat(40),
      created,
    });
    expect(sbom.packages.map((entry) => entry.externalRefs[0].referenceLocator)).toEqual([
      "pkg:golang/fased-signerd@1.2.3%2Baaaaaaaaaaaa",
      "pkg:golang/golang.org/x/crypto@v0.52.0",
    ]);
    expect(() =>
      buildGoComponentSbomFromModules({
        modules: [{ Path: "example.invalid/mutable" }],
        version: "1.2.3",
        commit: "a".repeat(40),
        created,
      }),
    ).toThrow("no immutable version");
  });
});
