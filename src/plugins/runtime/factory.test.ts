import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useManagedFreshCoreRuntime } from "./factory.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("managed plugin runtime selection", () => {
  it("uses the minimal runtime only for an exact bundled-only managed lock", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fased-core-runtime-"));
    roots.push(root);
    const lockPath = path.join(root, "plugin.lock.json");
    fs.writeFileSync(
      lockPath,
      `${JSON.stringify({
        schemaVersion: 1,
        type: "fased-plugin-lock",
        entries: [
          {
            id: "memory-core",
            origin: "bundled",
            digest: `sha256:${"a".repeat(64)}`,
            apiCapability: "fased.plugin.v1",
            required: true,
          },
        ],
      })}\n`,
    );
    expect(
      useManagedFreshCoreRuntime({
        FASED_MANAGED_INTERNAL: "1",
        FASED_PLUGIN_LOCK_PATH: lockPath,
      }),
    ).toBe(true);
    fs.writeFileSync(
      lockPath,
      `${JSON.stringify({
        schemaVersion: 1,
        type: "fased-plugin-lock",
        entries: [
          {
            id: "optional-pack",
            origin: "store",
            digest: `sha256:${"b".repeat(64)}`,
            apiCapability: "fased.plugin.v1",
            required: false,
          },
        ],
      })}\n`,
    );
    expect(
      useManagedFreshCoreRuntime({
        FASED_MANAGED_INTERNAL: "1",
        FASED_PLUGIN_LOCK_PATH: lockPath,
      }),
    ).toBe(false);
    fs.writeFileSync(
      lockPath,
      `${JSON.stringify({ schemaVersion: 1, type: "fased-plugin-lock", entries: [] })}\n`,
    );
    expect(
      useManagedFreshCoreRuntime({
        FASED_MANAGED_INTERNAL: "1",
        FASED_PLUGIN_LOCK_PATH: lockPath,
      }),
    ).toBe(false);
  });

  it("fails closed to the full runtime for missing, malformed, or unmanaged state", () => {
    expect(useManagedFreshCoreRuntime({})).toBe(false);
    expect(
      useManagedFreshCoreRuntime({
        FASED_MANAGED_INTERNAL: "1",
        FASED_PLUGIN_LOCK_PATH: "/missing/plugin.lock.json",
      }),
    ).toBe(false);
  });
});
