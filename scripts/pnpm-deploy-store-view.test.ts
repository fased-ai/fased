import { lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWritablePnpmDeployStoreView } from "./pnpm-deploy-store-view.js";

const cleanup: string[] = [];

afterEach(() => {
  for (const target of cleanup.splice(0)) {
    rmSync(target, { recursive: true, force: true });
  }
});

describe("writable pnpm deploy store view", () => {
  it("keeps dependency content read-only while isolating pnpm project bookkeeping", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "fased-pnpm-store-view-"));
    cleanup.push(root);
    const source = path.join(root, "source", "v10");
    const parent = path.join(root, "parent");
    for (const name of ["files", "index", "projects", "tmp", "git-package"]) {
      mkdirSync(path.join(source, name), { recursive: true });
    }
    writeFileSync(path.join(source, "files", "content"), "immutable\n");
    mkdirSync(parent);

    const view = createWritablePnpmDeployStoreView(source, parent);

    for (const name of ["files", "index", "git-package"]) {
      const target = path.join(view, "v10", name);
      expect(lstatSync(target).isSymbolicLink()).toBe(true);
      expect(readlinkSync(target)).toBe(path.join(source, name));
    }
    for (const name of ["projects", "tmp"]) {
      const target = path.join(view, "v10", name);
      expect(lstatSync(target).isDirectory()).toBe(true);
      expect(lstatSync(target).isSymbolicLink()).toBe(false);
    }
    expect(lstatSync(view).mode & 0o777).toBe(0o700);
  });
});
