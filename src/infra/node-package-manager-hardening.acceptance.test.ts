import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { reexecWithSupportedNodeIfNeeded } from "../../scripts/fased-launcher-runtime.mjs";
import { runtimeSatisfies, type RuntimeDetails } from "./runtime-guard.js";
import { runGatewayUpdate } from "./update-runner.js";

type CommandResult = { stdout: string; stderr: string; code: number | null };
type FakeDirent = { name: string; isDirectory: () => boolean };

function createLauncherFs(params: { home: string; existing: Set<string>; nvmVersions?: string[] }) {
  const versionsDir = path.join(params.home, ".nvm", "versions", "node");
  return {
    existsSync(candidate: string) {
      return params.existing.has(path.resolve(candidate));
    },
    readdirSync(candidate: string): FakeDirent[] {
      if (path.resolve(candidate) !== path.resolve(versionsDir)) {
        throw new Error(`unexpected readdir ${candidate}`);
      }
      return (params.nvmVersions ?? []).map((name) => ({
        name,
        isDirectory: () => true,
      }));
    },
  };
}

function missingSqliteRequire(specifier: string) {
  if (specifier === "node:sqlite") {
    throw new Error("node:sqlite unavailable");
  }
  return {};
}

describe("Lane 6 Node/package-manager hardening", () => {
  let fixtureRoot = "";
  let tempDir = "";
  let caseId = 0;

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "fased-node-pm-hardening-"));
  });

  afterAll(async () => {
    if (fixtureRoot) {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  beforeEach(async () => {
    tempDir = path.join(fixtureRoot, `case-${caseId++}`);
    await fs.mkdir(path.join(tempDir, ".git"), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, "package.json"),
      JSON.stringify({ name: "fased", version: "1.0.0", packageManager: "npm@10.8.0" }),
      "utf-8",
    );
    await fs.writeFile(path.join(tempDir, "fased.mjs"), "export {};\n", "utf-8");
    const uiIndexPath = path.join(tempDir, "dist", "control-ui", "index.html");
    await fs.mkdir(path.dirname(uiIndexPath), { recursive: true });
    await fs.writeFile(uiIndexPath, "<html></html>\n", "utf-8");
  });

  it("keeps node:sqlite mandatory even when the Node major version is high enough", () => {
    const node24MissingSqlite: RuntimeDetails = {
      kind: "node",
      version: "24.15.0",
      execPath: "/opt/node-v24/bin/node",
      pathEnv: "/opt/node-v24/bin",
      sqliteAvailable: false,
    };
    const node22WithSqlite: RuntimeDetails = {
      ...node24MissingSqlite,
      version: "22.14.0",
      sqliteAvailable: true,
    };

    expect(runtimeSatisfies(node24MissingSqlite)).toBe(false);
    expect(runtimeSatisfies(node22WithSqlite)).toBe(true);
  });

  it("uses the declared package manager for git checkout install/build/UI steps", async () => {
    const calls: string[] = [];
    const stableTag = "v2.0.0";
    const doctorKey = `${process.execPath} ${path.join(tempDir, "fased.mjs")} doctor --non-interactive --fix`;

    const runCommand = async (argv: string[]): Promise<CommandResult> => {
      const key = argv.join(" ");
      calls.push(key);

      if (key === `git -C ${tempDir} rev-parse --show-toplevel`) {
        return { stdout: tempDir, stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} rev-parse HEAD`) {
        return { stdout: "abc123", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} status --porcelain -- :!dist/control-ui/`) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} fetch --all --prune --tags`) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} tag --list v* --sort=-v:refname`) {
        return { stdout: `${stableTag}\n`, stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} checkout --detach ${stableTag}`) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === doctorKey) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === "npm install" || key === "npm run build" || key === "npm run ui:build") {
        return { stdout: "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };

    const result = await runGatewayUpdate({
      cwd: tempDir,
      channel: "stable",
      runCommand: async (argv) => runCommand(argv),
      timeoutMs: 5000,
    });

    expect(result.status).toBe("ok");
    expect(calls).toContain("npm install");
    expect(calls).toContain("npm run build");
    expect(calls).toContain("npm run ui:build");
    expect(calls).toContain(doctorKey);
    expect(calls).not.toContain("pnpm install");
    expect(calls).not.toContain("pnpm build");
    expect(calls).not.toContain("pnpm ui:build");
  });

  it("re-execs the launcher with FASED_NODE before scanning nvm candidates", () => {
    const home = path.join(tempDir, "home");
    const fasedNode = path.join(tempDir, "node24", "bin", "node");
    const selfPath = path.join(tempDir, "fased.mjs");
    const calls: Array<{ candidate: string; args: string[] }> = [];
    const exits: number[] = [];

    const fsImpl = createLauncherFs({
      home,
      existing: new Set([path.resolve(fasedNode)]),
      nvmVersions: ["v24.15.0"],
    });

    const spawnSyncImpl = (candidate: string, args: string[]) => {
      calls.push({ candidate, args });
      if (args[0] === "-e") {
        return { status: candidate === fasedNode ? 0 : 1 };
      }
      return { status: 7 };
    };

    expect(() =>
      reexecWithSupportedNodeIfNeeded({
        argv: ["node", selfPath, "mining", "status"],
        env: { HOME: home, FASED_NODE: fasedNode },
        execPath: path.join(tempDir, "node23", "bin", "node"),
        exit: (code?: number) => {
          exits.push(code ?? 0);
          throw new Error(`exit:${code}`);
        },
        fsImpl,
        nodeVersion: "23.3.0",
        requireFn: missingSqliteRequire,
        selfPath,
        spawnSyncImpl,
      }),
    ).toThrow("exit:7");

    expect(calls).toEqual([
      { candidate: fasedNode, args: ["-e", expect.any(String) as string] },
      { candidate: fasedNode, args: [selfPath, "mining", "status"] },
    ]);
    expect(exits).toEqual([7]);
  });

  it("re-execs the launcher with the highest supported nvm Node when FASED_NODE is absent", () => {
    const home = path.join(tempDir, "home");
    const selfPath = path.join(tempDir, "fased.mjs");
    const currentNode = path.join(home, ".nvm", "versions", "node", "v23.3.0", "bin", "node");
    const node23 = currentNode;
    const node24 = path.join(home, ".nvm", "versions", "node", "v24.15.0", "bin", "node");
    const node22 = path.join(home, ".nvm", "versions", "node", "v22.14.0", "bin", "node");
    const calls: Array<{ candidate: string; args: string[] }> = [];

    const fsImpl = createLauncherFs({
      home,
      existing: new Set([path.resolve(node23), path.resolve(node24), path.resolve(node22)]),
      nvmVersions: ["v22.14.0", "v23.3.0", "v24.15.0"],
    });

    const spawnSyncImpl = (candidate: string, args: string[]) => {
      calls.push({ candidate, args });
      if (args[0] === "-e") {
        return { status: candidate === node24 ? 0 : 1 };
      }
      return { status: 0 };
    };

    expect(() =>
      reexecWithSupportedNodeIfNeeded({
        argv: ["node", selfPath, "wallet", "balance"],
        env: { HOME: home },
        execPath: currentNode,
        exit: (code?: number) => {
          throw new Error(`exit:${code}`);
        },
        fsImpl,
        nodeVersion: "23.3.0",
        requireFn: missingSqliteRequire,
        selfPath,
        spawnSyncImpl,
      }),
    ).toThrow("exit:0");

    expect(calls).toEqual([
      { candidate: node24, args: ["-e", expect.any(String) as string] },
      { candidate: node24, args: [selfPath, "wallet", "balance"] },
    ]);
  });
});
