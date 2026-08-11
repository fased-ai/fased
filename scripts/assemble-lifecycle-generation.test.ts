import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeBundledPluginLock } from "./assemble-lifecycle-generation.mjs";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("lifecycle generation plugin lock", () => {
  it("binds the required bundled plugins into one canonical lock", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-plugin-lock-"));
    roots.push(root);
    for (const id of ["sat-mining", "memory-core"]) {
      const pluginRoot = path.join(root, "extensions", id);
      await fs.mkdir(pluginRoot, { recursive: true });
      await fs.writeFile(path.join(pluginRoot, "fased.plugin.json"), `${JSON.stringify({ id })}\n`);
      await fs.writeFile(
        path.join(pluginRoot, "index.js"),
        `export default ${JSON.stringify(id)};\n`,
      );
    }

    const digest = await writeBundledPluginLock(root);
    const raw = await fs.readFile(path.join(root, "plugin.lock.json"), "utf8");
    const lock = JSON.parse(raw) as {
      entries: Array<{ id: string; required: boolean; digest: string }>;
    };

    expect(lock.entries.map((entry) => entry.id)).toEqual(["memory-core", "sat-mining"]);
    expect(lock.entries.every((entry) => entry.required)).toBe(true);
    expect(lock.entries.every((entry) => /^sha256:[0-9a-f]{64}$/.test(entry.digest))).toBe(true);
    expect(digest).toBe(
      `sha256:${createHash("sha256")
        .update(JSON.stringify(JSON.parse(raw)))
        .digest("hex")}`,
    );
  });

  it("rejects a runtime missing a required bundled plugin", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-plugin-lock-"));
    roots.push(root);
    const pluginRoot = path.join(root, "extensions", "memory-core");
    await fs.mkdir(pluginRoot, { recursive: true });
    await fs.writeFile(path.join(pluginRoot, "fased.plugin.json"), '{"id":"memory-core"}\n');

    await expect(writeBundledPluginLock(root)).rejects.toThrow(
      "required bundled plugins are missing",
    );
  });
});
