import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { convergeInstalledPluginAccess } from "./install.js";

const cleanup: string[] = [];

describe("convergeInstalledPluginAccess", () => {
  afterEach(async () => {
    for (const root of cleanup.splice(0)) {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("converges only one canonical plugin tree for shared Gateway access", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-plugin-access-"));
    cleanup.push(root);
    const extensionsDir = path.join(root, "extensions");
    const targetDir = path.join(extensionsDir, "demo");
    const executable = path.join(targetDir, "bin", "tool");
    const source = path.join(targetDir, "index.js");
    await fs.mkdir(path.dirname(executable), { recursive: true });
    await fs.writeFile(executable, "#!/bin/sh\n", { mode: 0o700 });
    await fs.writeFile(source, "export {};\n", { mode: 0o600 });

    await convergeInstalledPluginAccess({ extensionsDir, targetDir });

    expect((await fs.stat(extensionsDir)).mode & 0o2777).toBe(0o2770);
    expect((await fs.stat(targetDir)).mode & 0o2777).toBe(0o2750);
    expect((await fs.stat(executable)).mode & 0o777).toBe(0o750);
    expect((await fs.stat(source)).mode & 0o777).toBe(0o640);
    expect((await fs.stat(source)).gid).toBe((await fs.stat(extensionsDir)).gid);
  });

  it("rejects a plugin symlink that escapes the canonical install tree", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-plugin-access-link-"));
    cleanup.push(root);
    const extensionsDir = path.join(root, "extensions");
    const targetDir = path.join(extensionsDir, "demo");
    await fs.mkdir(targetDir, { recursive: true });
    await fs.symlink("/etc/passwd", path.join(targetDir, "escape"));

    await expect(convergeInstalledPluginAccess({ extensionsDir, targetDir })).rejects.toThrow(
      "outside its canonical install tree",
    );
  });
});
