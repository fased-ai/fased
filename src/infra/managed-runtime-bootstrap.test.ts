import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureManagedRuntimeBootstrap,
  resolveManagedPrefixForPackageRoot,
} from "./managed-runtime-bootstrap.js";

describe("managed runtime bootstrap", () => {
  it("derives the installer-owned prefix without consulting cwd", () => {
    expect(
      resolveManagedPrefixForPackageRoot(
        "/home/app/.fased/install-cache/npm-global/lib/node_modules/@fased/fased",
      ),
    ).toBe("/home/app/.fased/install-cache/npm-global");
  });

  it("does not migrate source checkouts or unrelated global packages", () => {
    expect(resolveManagedPrefixForPackageRoot("/home/app/fased")).toBeNull();
    expect(
      resolveManagedPrefixForPackageRoot(path.resolve("node_modules/@fased/fased")),
    ).toBeNull();
  });

  it("reuses an existing schema-v2 managed updater without consulting cwd", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fased-managed-bootstrap-v2-"));
    const stateDir = path.join(root, ".fased");
    const updaterPath = path.join(stateDir, "updater", "fased-managed-updater.mjs");
    fs.mkdirSync(path.dirname(updaterPath), { recursive: true });
    fs.mkdirSync(path.join(stateDir, "bin"), { recursive: true });
    fs.writeFileSync(path.join(stateDir, "install.json"), '{"schemaVersion":2}\n');
    fs.writeFileSync(updaterPath, "// updater\n");
    fs.writeFileSync(path.join(stateDir, "bin", "fased"), "#!/bin/sh\n");
    fs.writeFileSync(path.join(stateDir, "bin", "fased-service"), "#!/bin/sh\n");
    try {
      await expect(
        ensureManagedRuntimeBootstrap({
          packageRoot: "/unrelated/git/checkout",
          env: { ...process.env, FASED_STATE_DIR: stateDir },
        }),
      ).resolves.toEqual({
        installed: false,
        manifestPath: path.join(stateDir, "install.json"),
        updaterPath,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
