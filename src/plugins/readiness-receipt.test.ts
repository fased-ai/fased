import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writePluginReadinessReceipt } from "./readiness-receipt.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function fixture(status: "loaded" | "disabled" | "error" = "loaded") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fased-plugin-ready-"));
  roots.push(root);
  const lock = {
    schemaVersion: 1,
    type: "fased-plugin-lock",
    entries: [
      {
        id: "demo",
        origin: "store",
        digest: `sha256:${"b".repeat(64)}`,
        apiCapability: "plugin.v1",
        required: true,
      },
    ],
  } as const;
  const lockPath = path.join(root, "plugin.lock.json");
  fs.writeFileSync(lockPath, `${JSON.stringify(lock)}\n`, { mode: 0o600 });
  const outputPath = path.join(root, "cache", "plugin-readiness.json");
  const registry = {
    plugins: [{ id: "demo", status }],
    diagnostics: [],
  } as never;
  return { root, lock, lockPath, outputPath, registry };
}

describe("managed plugin readiness receipt", () => {
  it("binds the exact lock, generation, digest and mandatory load outcome", () => {
    const current = fixture();
    const generationId = `sha256:${"a".repeat(64)}`;
    const fsync = vi.spyOn(fs, "fsyncSync");
    writePluginReadinessReceipt({ ...current, generationId });
    const receipt = JSON.parse(fs.readFileSync(current.outputPath, "utf8"));
    expect(receipt).toEqual({
      schemaVersion: 1,
      type: "fased-plugin-readiness",
      generationId,
      lockDigest: `sha256:${createHash("sha256").update(JSON.stringify(current.lock)).digest("hex")}`,
      entries: [{ ...current.lock.entries[0], status: "loaded" }],
    });
    expect(fsync).toHaveBeenCalledTimes(2);
    expect(fs.readdirSync(path.dirname(current.outputPath))).toEqual(["plugin-readiness.json"]);
    fsync.mockRestore();
  });

  it("fails closed on unsorted lock entries", () => {
    const current = fixture();
    const lock = {
      ...current.lock,
      entries: [
        { ...current.lock.entries[0], id: "z" },
        { ...current.lock.entries[0], id: "a" },
      ],
    };
    fs.writeFileSync(current.lockPath, JSON.stringify(lock));
    expect(() =>
      writePluginReadinessReceipt({ ...current, generationId: `sha256:${"a".repeat(64)}` }),
    ).toThrow(/canonical/);
  });
});
