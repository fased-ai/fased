import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertManagedComponentPackBudget,
  normalizedManagedPluginTreeDigest,
} from "./build-hosted-component-packs.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("managed component pack identity", () => {
  it("bundles implementation-only runtime entrypoints and removes source entrypoints", async () => {
    const source = await fs.readFile(
      path.join(import.meta.dirname, "build-hosted-component-packs.ts"),
      "utf8",
    );
    expect(source).toContain('import { rolldown } from "rolldown"');
    expect(source).toContain('params.componentId === "browser-runtime"');
    expect(source).toContain('params.componentId === "speech-runtime"');
    expect(source).toContain('entryFileNames: "index.mjs"');
    expect(source).toContain('extensions: ["./index.mjs"]');
    expect(source).toContain('fs.rm(path.join(params.deployRoot, "index.ts"), { force: true })');
    expect(source).not.toContain('node_modules", ".bin", "esbuild"');
  });

  it("binds normalized immutable extraction modes and exact file bytes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-component-identity-"));
    roots.push(root);
    await fs.mkdir(path.join(root, "demo"));
    await fs.writeFile(path.join(root, "demo", "index.js"), "export default {};\n", {
      mode: 0o644,
    });
    const first = await normalizedManagedPluginTreeDigest(root);
    await fs.chmod(path.join(root, "demo", "index.js"), 0o444);
    await expect(normalizedManagedPluginTreeDigest(root)).resolves.toBe(first);
    await fs.chmod(path.join(root, "demo", "index.js"), 0o644);
    await fs.writeFile(path.join(root, "demo", "index.js"), "export default { id: 'demo' };\n");
    await expect(normalizedManagedPluginTreeDigest(root)).resolves.not.toBe(first);
  });

  it("rejects symbolic-link aliases before producing a managed identity", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-component-alias-"));
    roots.push(root);
    await fs.writeFile(path.join(root, "source.js"), "export default {};\n");
    await fs.symlink(path.join(root, "source.js"), path.join(root, "alias.js"));
    await expect(normalizedManagedPluginTreeDigest(root)).rejects.toThrow(
      "managed component contains a symbolic link",
    );
  });

  it("rejects any component pack that exceeds the exact P6 transaction limits", () => {
    expect(() =>
      assertManagedComponentPackBudget({
        packId: "diagnostics",
        budgets: {
          maximumArchiveBytes: 10,
          maximumExpandedBytes: 20,
          maximumTarStreamBytes: 30,
          maximumEntries: 40,
        },
        usage: { archiveBytes: 10, expandedBytes: 20, tarStreamBytes: 30, entries: 41 },
      }),
    ).toThrow("component pack diagnostics exceeds P6 transaction budgets");
  });
});
