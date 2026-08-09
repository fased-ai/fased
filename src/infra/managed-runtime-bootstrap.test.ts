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

  it("selects the updater adjacent to a Go-managed immutable runtime", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fased-go-runtime-"));
    const runtimeRoot = path.join(root, "current", "payload", "runtime");
    const updaterPath = path.join(runtimeRoot, "scripts", "fased-managed-updater.mjs");
    fs.mkdirSync(path.dirname(updaterPath), { recursive: true });
    fs.writeFileSync(updaterPath, "// updater\n");
    try {
      await expect(
        ensureManagedRuntimeBootstrap({
          packageRoot: runtimeRoot,
          env: {
            ...process.env,
            FASED_RUNTIME_SOURCE: "go-lifecycle",
            FASED_MANAGED_RUNTIME_ROOT: runtimeRoot,
          },
        }),
      ).resolves.toEqual({
        installed: false,
        manifestPath: null,
        updaterPath,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not bootstrap an owner-side mutation runtime", async () => {
    await expect(
      ensureManagedRuntimeBootstrap({ packageRoot: "/unrelated/git/checkout" }),
    ).resolves.toEqual({ installed: false, manifestPath: null, updaterPath: null });
  });
});
