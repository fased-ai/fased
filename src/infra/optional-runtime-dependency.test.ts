import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const originalEnvironment = {
  codeRoot: process.env.FASED_PLUGIN_CODE_ROOT,
  lockPath: process.env.FASED_PLUGIN_LOCK_PATH,
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  if (originalEnvironment.codeRoot === undefined) {
    delete process.env.FASED_PLUGIN_CODE_ROOT;
  } else {
    process.env.FASED_PLUGIN_CODE_ROOT = originalEnvironment.codeRoot;
  }
  if (originalEnvironment.lockPath === undefined) {
    delete process.env.FASED_PLUGIN_LOCK_PATH;
  } else {
    process.env.FASED_PLUGIN_LOCK_PATH = originalEnvironment.lockPath;
  }
});

describe("optional runtime dependency loader", () => {
  beforeEach(async () => {
    const { resetOptionalRuntimeDependencyCacheForTest } =
      await import("./optional-runtime-dependency.js");
    resetOptionalRuntimeDependencyCacheForTest();
  });

  it("uses a dependency already available to the core runtime", async () => {
    const { importOptionalRuntimeDependency } = await import("./optional-runtime-dependency.js");
    const module = await importOptionalRuntimeDependency<typeof import("node:path")>({
      componentId: "test-runtime",
      packageName: "@fased/test-runtime",
      dependency: "node:path",
    });
    expect(typeof module.join).toBe("function");
  });

  it("routes a missing bundled dependency to verified generation repair", async () => {
    const { importOptionalRuntimeDependency } = await import("./optional-runtime-dependency.js");
    await expect(
      importOptionalRuntimeDependency({
        componentId: "media-runtime",
        packageName: "@fased/media-runtime",
        dependency: "fased-package-that-does-not-exist",
      }),
    ).rejects.toThrow("Install or update media-runtime through `fased plugins`");
  });

  it("resolves optional dependencies only from the exact digest-bound P6 component", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-managed-component-"));
    roots.push(root);
    const codeRoot = path.join(root, "plugin-code");
    const digest = `sha256:${"a".repeat(64)}`;
    const componentRoot = path.join(codeRoot, digest.slice("sha256:".length), "browser-runtime");
    const dependencyRoot = path.join(componentRoot, "node_modules", "fixture-browser");
    await fs.mkdir(dependencyRoot, { recursive: true });
    await fs.writeFile(
      path.join(componentRoot, "package.json"),
      `${JSON.stringify({ name: "@fased/browser-runtime", type: "module" })}\n`,
    );
    await fs.writeFile(
      path.join(dependencyRoot, "package.json"),
      `${JSON.stringify({ name: "fixture-browser", type: "module", exports: "./index.js" })}\n`,
    );
    await fs.writeFile(path.join(dependencyRoot, "index.js"), "export const source = 'p6';\n");
    const lockPath = path.join(root, "plugin-lock.json");
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        schemaVersion: 1,
        type: "fased-plugin-lock",
        entries: [
          {
            id: "browser-runtime",
            origin: "store",
            digest,
            apiCapability: "fased.plugin.v1",
            required: false,
          },
        ],
      }),
    );
    process.env.FASED_PLUGIN_CODE_ROOT = codeRoot;
    process.env.FASED_PLUGIN_LOCK_PATH = lockPath;
    const { importOptionalRuntimeDependency } = await import("./optional-runtime-dependency.js");
    await expect(
      importOptionalRuntimeDependency<{ source: string }>({
        componentId: "browser-runtime",
        packageName: "@fased/browser-runtime",
        dependency: "fixture-browser",
      }),
    ).resolves.toMatchObject({ source: "p6" });
  });

  it("fails closed when a managed component dependency resolves outside its digest root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-managed-component-escape-"));
    roots.push(root);
    const codeRoot = path.join(root, "plugin-code");
    const digest = `sha256:${"b".repeat(64)}`;
    const componentRoot = path.join(codeRoot, digest.slice("sha256:".length), "speech-runtime");
    await fs.mkdir(componentRoot, { recursive: true });
    await fs.writeFile(
      path.join(componentRoot, "package.json"),
      `${JSON.stringify({ name: "@fased/speech-runtime", type: "module" })}\n`,
    );
    const lockPath = path.join(root, "plugin-lock.json");
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        schemaVersion: 1,
        type: "fased-plugin-lock",
        entries: [
          {
            id: "speech-runtime",
            origin: "store",
            digest,
            apiCapability: "fased.plugin.v1",
            required: false,
          },
        ],
      }),
    );
    process.env.FASED_PLUGIN_CODE_ROOT = codeRoot;
    process.env.FASED_PLUGIN_LOCK_PATH = lockPath;
    const { importOptionalRuntimeDependency } = await import("./optional-runtime-dependency.js");
    await expect(
      importOptionalRuntimeDependency({
        componentId: "speech-runtime",
        packageName: "@fased/speech-runtime",
        dependency: "node:path",
      }),
    ).rejects.toThrow("managed component dependency escapes speech-runtime");
  });
});
