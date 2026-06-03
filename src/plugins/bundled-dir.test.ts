import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import { resolveBundledPluginsDir } from "./bundled-dir.js";

async function writePluginManifest(dir: string) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "fased.plugin.json"),
    JSON.stringify({
      id: "memory-core",
      kind: "memory",
      configSchema: { type: "object", additionalProperties: false },
    }),
    "utf-8",
  );
}

describe("resolveBundledPluginsDir", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    envSnapshot = captureEnv(["FASED_BUNDLED_PLUGINS_DIR"]);
  });

  afterEach(() => {
    envSnapshot.restore();
  });

  it("returns FASED_BUNDLED_PLUGINS_DIR override when set", async () => {
    const overrideDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-bundled-plugins-"));
    process.env.FASED_BUNDLED_PLUGINS_DIR = ` ${overrideDir} `;

    expect(resolveBundledPluginsDir()).toBe(overrideDir);
  });

  it("resolves package extensions from the executed entrypoint when loaded from another chunk", async () => {
    delete process.env.FASED_BUNDLED_PLUGINS_DIR;

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-package-root-"));
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fased" }));
    await writePluginManifest(path.join(root, "extensions", "memory-core"));

    const distDir = path.join(root, "dist");
    await fs.mkdir(distDir, { recursive: true });
    const argv1 = path.join(distDir, "entry.js");
    await fs.writeFile(argv1, "// stub", "utf-8");

    const chunkRoot = await fs.mkdtemp(path.join(os.tmpdir(), "fased-plugin-sdk-chunk-"));
    const moduleUrl = pathToFileURL(path.join(chunkRoot, "plugin-sdk", "config.js")).href;

    const resolved = resolveBundledPluginsDir({
      argv1,
      moduleUrl,
      cwd: chunkRoot,
      execPath: path.join(root, "bin", "node"),
    });

    expect(resolved).toBe(path.join(root, "extensions"));
  });
});
