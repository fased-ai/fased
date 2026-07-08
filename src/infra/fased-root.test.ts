import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveFasedAgentPackageRoot, resolveFasedAgentPackageRootSync } from "./fased-root.js";

let root: string;

const fx = (...parts: string[]) => path.join(root, ...parts);

function writePackageJson(dir: string, name: string) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name }), "utf-8");
}

describe("resolveFasedAgentPackageRoot", () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "fased-root-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("resolves package root from .bin argv1", () => {
    const project = fx("bin-scenario");
    const argv1 = path.join(project, "node_modules", ".bin", "fased");
    const pkgRoot = path.join(project, "node_modules", "fased");
    writePackageJson(pkgRoot, "fased");

    expect(resolveFasedAgentPackageRootSync({ argv1 })).toBe(pkgRoot);
  });

  it("resolves scoped package root from .bin argv1", () => {
    const project = fx("scoped-bin-scenario");
    const argv1 = path.join(project, "node_modules", ".bin", "fased");
    const pkgRoot = path.join(project, "node_modules", "fased");
    writePackageJson(pkgRoot, "@fased/fased");

    expect(resolveFasedAgentPackageRootSync({ argv1 })).toBe(pkgRoot);
  });

  it("resolves package root via symlinked argv1", () => {
    const project = fx("symlink-scenario");
    const bin = path.join(project, "bin", "fased");
    const realPkg = path.join(project, "real-pkg");
    writePackageJson(realPkg, "fased");
    fs.writeFileSync(path.join(realPkg, "fased.mjs"), "", "utf-8");
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.symlinkSync(path.join(realPkg, "fased.mjs"), bin);

    expect(resolveFasedAgentPackageRootSync({ argv1: bin })).toBe(realPkg);
  });

  it("falls back when argv1 does not exist", () => {
    const project = fx("missing-bin-scenario");
    const argv1 = path.join(project, "node_modules", ".bin", "fased");
    const pkgRoot = path.join(project, "node_modules", "fased");
    writePackageJson(pkgRoot, "fased");

    expect(resolveFasedAgentPackageRootSync({ argv1 })).toBe(pkgRoot);
  });

  it("prefers moduleUrl candidates", () => {
    const pkgRoot = fx("moduleurl");
    writePackageJson(pkgRoot, "fased");
    const moduleUrl = pathToFileURL(path.join(pkgRoot, "dist", "index.js")).toString();

    expect(resolveFasedAgentPackageRootSync({ moduleUrl })).toBe(pkgRoot);
  });

  it("returns null for non-fased package roots", () => {
    const pkgRoot = fx("not-fased");
    writePackageJson(pkgRoot, "not-fased");

    expect(resolveFasedAgentPackageRootSync({ cwd: pkgRoot })).toBeNull();
  });

  it("async resolver matches sync behavior", async () => {
    const pkgRoot = fx("async");
    writePackageJson(pkgRoot, "fased");

    await expect(resolveFasedAgentPackageRoot({ cwd: pkgRoot })).resolves.toBe(pkgRoot);
  });

  it("async resolver returns null when no package roots exist", async () => {
    await expect(resolveFasedAgentPackageRoot({ cwd: fx("missing") })).resolves.toBeNull();
  });
});
