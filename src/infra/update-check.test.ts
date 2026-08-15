import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkUpdateStatus, compareSemverStrings } from "./update-check.js";

describe("compareSemverStrings", () => {
  it("handles stable and prerelease precedence for both legacy and beta formats", () => {
    expect(compareSemverStrings("1.0.0", "1.0.0")).toBe(0);
    expect(compareSemverStrings("v1.0.0", "1.0.0")).toBe(0);

    expect(compareSemverStrings("1.0.0", "1.0.0-beta.1")).toBe(1);
    expect(compareSemverStrings("1.0.0-beta.2", "1.0.0-beta.1")).toBe(1);

    expect(compareSemverStrings("1.0.0-2", "1.0.0-1")).toBe(1);
    expect(compareSemverStrings("1.0.0-1", "1.0.0-beta.1")).toBe(-1);
    expect(compareSemverStrings("1.0.0.beta.2", "1.0.0-beta.1")).toBe(1);
    expect(compareSemverStrings("1.0.0", "1.0.0.beta.1")).toBe(1);
  });

  it("returns null for invalid inputs", () => {
    expect(compareSemverStrings("1.0", "1.0.0")).toBeNull();
    expect(compareSemverStrings("latest", "1.0.0")).toBeNull();
  });
});

describe("checkUpdateStatus", () => {
  it("does not invent an npm-global owner for an old package-cache path", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-hosted-update-check-"));
    const pkgRoot = path.join(
      root,
      ".fased",
      "install-cache",
      "npm-global",
      "lib",
      "node_modules",
      "@fased",
      "fased",
    );
    await fs.mkdir(pkgRoot, { recursive: true });
    await fs.writeFile(
      path.join(pkgRoot, "package.json"),
      JSON.stringify({ name: "@fased/fased", version: "1.0.0", packageManager: "pnpm@10.23.0" }),
      "utf-8",
    );

    try {
      const status = await checkUpdateStatus({
        root: pkgRoot,
        timeoutMs: 1000,
        fetchGit: false,
        includeRegistry: false,
      });

      expect(status.installKind).toBe("package");
      expect(status.packageManager).toBe("pnpm");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
