import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const cleanupRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map(async (root) => await fs.rm(root, { recursive: true, force: true })),
  );
});

describe("managed CLI launcher", () => {
  it("dispatches update without reading protected application configuration", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-managed-launcher-"));
    cleanupRoots.push(root);
    const stateDir = path.join(root, ".fased");
    const binDir = path.join(stateDir, "bin");
    const updaterDir = path.join(stateDir, "updater");
    const launcher = path.join(binDir, "fased");
    const updater = path.join(updaterDir, "fased-managed-updater.mjs");
    const resultPath = path.join(root, "launcher-result.json");
    await Promise.all([
      fs.mkdir(binDir, { recursive: true }),
      fs.mkdir(updaterDir, { recursive: true }),
    ]);
    await fs.copyFile(path.join(import.meta.dirname, "fased-managed-launcher.sh"), launcher);
    await fs.chmod(launcher, 0o755);
    await fs.writeFile(path.join(stateDir, "fased.json"), "{not-json\n", { mode: 0o000 });
    await fs.writeFile(
      updater,
      [
        "import fs from 'node:fs';",
        "fs.writeFileSync(process.env.FASED_TEST_RESULT_PATH, JSON.stringify({",
        "  profilePresent: Object.hasOwn(process.env, 'FASED_HOST_PROFILE'),",
        "  socketPresent: Object.hasOwn(process.env, 'FASED_HOST_UPDATER_SOCKET'),",
        "  stateDir: process.env.FASED_STATE_DIR,",
        "  configPath: process.env.FASED_CONFIG_PATH,",
        "}));",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    expect(await fs.readFile(updater, "utf8")).toContain("FASED_TEST_RESULT_PATH");

    await execFileAsync(launcher, ["update", "status"], {
      env: {
        HOME: root,
        PATH: process.env.PATH,
        FASED_NODE: process.execPath,
        FASED_TEST_RESULT_PATH: resultPath,
      },
    });
    expect(JSON.parse(await fs.readFile(resultPath, "utf8"))).toEqual({
      profilePresent: false,
      socketPresent: false,
      stateDir,
      configPath: path.join(stateDir, "fased.json"),
    });
  });

  it("still loads protected application configuration for runtime commands", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-managed-launcher-runtime-"));
    cleanupRoots.push(root);
    const stateDir = path.join(root, ".fased");
    const binDir = path.join(stateDir, "bin");
    const runtimeRoot = path.join(stateDir, "runtime", "releases", "1.2.3");
    const launcher = path.join(binDir, "fased");
    const resultPath = path.join(root, "runtime-result.json");
    const instanceId = "0123456789abcdef";
    await Promise.all([
      fs.mkdir(binDir, { recursive: true }),
      fs.mkdir(runtimeRoot, { recursive: true }),
    ]);
    await fs.copyFile(path.join(import.meta.dirname, "fased-managed-launcher.sh"), launcher);
    await fs.chmod(launcher, 0o755);
    await fs.symlink(runtimeRoot, path.join(stateDir, "runtime", "current"), "dir");
    await fs.writeFile(
      path.join(stateDir, "fased.json"),
      `${JSON.stringify({
        env: {
          vars: {
            FASED_HOST_PROFILE: "local",
            FASED_PROTECTED_LOCAL: "1",
            FASED_PROTECTED_LOCAL_INSTANCE: instanceId,
            FASED_HOST_UPDATER_SOCKET: `/run/fased-local-controller/${instanceId}/request.sock`,
          },
        },
      })}\n`,
      { mode: 0o600 },
    );
    await fs.writeFile(
      path.join(runtimeRoot, "fased.mjs"),
      [
        "import fs from 'node:fs';",
        "fs.writeFileSync(process.env.FASED_TEST_RESULT_PATH, JSON.stringify({",
        "  profile: process.env.FASED_HOST_PROFILE,",
        "  instanceId: process.env.FASED_PROTECTED_LOCAL_INSTANCE,",
        "  socket: process.env.FASED_HOST_UPDATER_SOCKET,",
        "}));",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    await execFileAsync(launcher, ["doctor", "--non-interactive"], {
      env: {
        HOME: root,
        PATH: process.env.PATH,
        FASED_NODE: process.execPath,
        FASED_TEST_RESULT_PATH: resultPath,
      },
    });
    expect(JSON.parse(await fs.readFile(resultPath, "utf8"))).toEqual({
      profile: "local",
      instanceId,
      socket: `/run/fased-local-controller/${instanceId}/request.sock`,
    });
  });
});
