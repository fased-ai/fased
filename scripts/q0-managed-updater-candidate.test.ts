import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const cleanupRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupRoots
      .splice(0)
      .map(async (root) => await fsp.rm(root, { recursive: true, force: true })),
  );
});

describe("Q0 managed control-plane candidate", () => {
  it("activates and restores the launcher and updater as one transaction", async () => {
    if (process.platform === "win32" || typeof process.getuid !== "function") {
      return;
    }
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fased-q0-control-plane-"));
    cleanupRoots.push(root);
    const home = path.join(root, "home");
    const sourceRoot = path.join(root, "source");
    const stateDir = path.join(home, ".fased");
    const updaterPath = path.join(stateDir, "updater", "fased-managed-updater.mjs");
    const launcherPath = path.join(stateDir, "bin", "fased");
    const sourceUpdaterPath = path.join(sourceRoot, "scripts", "fased-managed-updater.mjs");
    const sourceLauncherPath = path.join(sourceRoot, "scripts", "fased-managed-launcher.sh");
    await Promise.all([
      fsp.mkdir(path.dirname(updaterPath), { recursive: true }),
      fsp.mkdir(path.dirname(launcherPath), { recursive: true }),
      fsp.mkdir(path.dirname(sourceUpdaterPath), { recursive: true }),
    ]);
    await Promise.all([
      fsp.writeFile(updaterPath, "original updater\n", { mode: 0o755 }),
      fsp.writeFile(launcherPath, "original launcher\n", { mode: 0o755 }),
      fsp.writeFile(sourceUpdaterPath, "candidate updater\n", { mode: 0o755 }),
      fsp.writeFile(sourceLauncherPath, "candidate launcher\n", { mode: 0o755 }),
    ]);
    const harness = path.join(import.meta.dirname, "q0-managed-updater-candidate.mjs");
    const env = { HOME: home, PATH: process.env.PATH };

    await execFileAsync(process.execPath, [harness, "activate", "--source-root", sourceRoot], {
      env,
    });
    expect(await fsp.readFile(updaterPath, "utf8")).toBe("candidate updater\n");
    expect(await fsp.readFile(launcherPath, "utf8")).toBe("candidate launcher\n");

    await execFileAsync(process.execPath, [harness, "restore"], { env });
    expect(await fsp.readFile(updaterPath, "utf8")).toBe("original updater\n");
    expect(await fsp.readFile(launcherPath, "utf8")).toBe("original launcher\n");
    await expect(
      fsp.lstat(path.join(stateDir, "updater", "q0-managed-updater-backup.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
