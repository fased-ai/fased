import { EventEmitter } from "node:events";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-run-node-"));
  try {
    return await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("run-node script", () => {
  it.runIf(process.platform !== "win32")(
    "anchors default cwd to the repo that contains run-node.mjs",
    async () => {
      const spawnCalls: Array<{ cmd: string; args: string[]; cwd?: string }> = [];

      const spawn = (cmd: string, args: string[], options: unknown) => {
        const spawnOptions = options as { cwd?: string } | undefined;
        spawnCalls.push({ cmd, args, cwd: spawnOptions?.cwd });
        return {
          on: (event: string, cb: (code: number | null, signal: string | null) => void) => {
            if (event === "exit") {
              queueMicrotask(() => cb(0, null));
            }
            return undefined;
          },
        };
      };

      const { runNodeMain } = await import("../../scripts/run-node.mjs");
      const exitCode = await runNodeMain({
        args: ["wallet", "setup", "--json"],
        env: {
          ...process.env,
          FASED_SKIP_BUILD: "1",
          FASED_RUNNER_LOG: "0",
        },
        spawn,
        execPath: process.execPath,
        platform: process.platform,
      });

      const expectedRepoRoot = path.resolve(
        path.dirname(fileURLToPath(new URL("../../scripts/run-node.mjs", import.meta.url))),
        "..",
      );

      expect(exitCode).toBe(0);
      expect(spawnCalls).toEqual([
        {
          cmd: process.execPath,
          args: ["fased.mjs", "wallet", "setup", "--json"],
          cwd: expectedRepoRoot,
        },
      ]);
    },
  );

  it.runIf(process.platform !== "win32")(
    "preserves control-ui assets by building with tsdown --no-clean",
    async () => {
      await withTempDir(async (tmp) => {
        const argsPath = path.join(tmp, ".pnpm-args.txt");
        const indexPath = path.join(tmp, "dist", "control-ui", "index.html");

        await fs.mkdir(path.dirname(indexPath), { recursive: true });
        await fs.writeFile(indexPath, "<html>sentinel</html>\n", "utf-8");

        const nodeCalls: string[][] = [];
        const spawn = (cmd: string, args: string[]) => {
          if (cmd === "pnpm") {
            fsSync.writeFileSync(argsPath, args.join(" "), "utf-8");
            if (!args.includes("--no-clean")) {
              fsSync.rmSync(path.join(tmp, "dist", "control-ui"), { recursive: true, force: true });
            }
          }
          if (cmd === process.execPath) {
            nodeCalls.push([cmd, ...args]);
          }
          return {
            on: (event: string, cb: (code: number | null, signal: string | null) => void) => {
              if (event === "exit") {
                queueMicrotask(() => cb(0, null));
              }
              return undefined;
            },
          };
        };

        const { runNodeMain } = await import("../../scripts/run-node.mjs");
        const exitCode = await runNodeMain({
          cwd: tmp,
          args: ["--version"],
          env: {
            ...process.env,
            FASED_FORCE_BUILD: "1",
            FASED_RUNNER_LOG: "0",
          },
          spawn: spawn as never,
          execPath: process.execPath,
          platform: process.platform,
        });

        expect(exitCode).toBe(0);
        await expect(fs.readFile(argsPath, "utf-8")).resolves.toContain("exec tsdown --no-clean");
        await expect(fs.readFile(indexPath, "utf-8")).resolves.toContain("sentinel");
        expect(nodeCalls).toEqual([[process.execPath, "fased.mjs", "--version"]]);
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "keeps forced rebuild chatter on stderr when CLI args request json output",
    async () => {
      await withTempDir(async (tmp) => {
        const buildStdios: unknown[] = [];
        const stderrChunks: string[] = [];

        const spawn = (cmd: string, args: string[], options: unknown) => {
          const spawnOptions = options as { stdio?: unknown } | undefined;
          const proc = new EventEmitter() as EventEmitter & {
            stdout?: EventEmitter;
            stderr?: EventEmitter;
          };
          if (cmd === "pnpm") {
            buildStdios.push(spawnOptions?.stdio);
            proc.stdout = new EventEmitter();
            proc.stderr = new EventEmitter();
            queueMicrotask(() => {
              proc.stdout?.emit("data", Buffer.from("build stdout\n"));
              proc.stderr?.emit("data", Buffer.from("build stderr\n"));
              proc.emit("exit", 0, null);
            });
            return proc;
          }
          queueMicrotask(() => proc.emit("exit", 0, null));
          return proc;
        };

        const { runNodeMain } = await import("../../scripts/run-node.mjs");
        const exitCode = await runNodeMain({
          cwd: tmp,
          args: ["wallet", "status", "--json"],
          env: {
            ...process.env,
            FASED_FORCE_BUILD: "1",
            FASED_RUNNER_LOG: "0",
          },
          spawn: spawn as never,
          execPath: process.execPath,
          platform: process.platform,
          stderr: {
            write(chunk: string | Uint8Array) {
              stderrChunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
              return true;
            },
          },
        });

        expect(exitCode).toBe(0);
        expect(buildStdios).toEqual([["ignore", "pipe", "pipe"]]);
        expect(stderrChunks.join("")).toContain("build stdout\n");
        expect(stderrChunks.join("")).toContain("build stderr\n");
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "rebuilds when an extension file is newer than the build stamp",
    async () => {
      await withTempDir(async (tmp) => {
        const oldDate = new Date("2026-01-01T00:00:00.000Z");
        const stampDate = new Date("2026-01-01T00:10:00.000Z");
        const extensionDate = new Date("2026-01-01T00:20:00.000Z");
        const paths = {
          src: path.join(tmp, "src", "index.ts"),
          extension: path.join(tmp, "extensions", "sat-mining", "index.ts"),
          tsconfig: path.join(tmp, "tsconfig.json"),
          packageJson: path.join(tmp, "package.json"),
          distEntry: path.join(tmp, "dist", "entry.js"),
          buildStamp: path.join(tmp, "dist", ".buildstamp"),
        };
        for (const filePath of Object.values(paths)) {
          await fs.mkdir(path.dirname(filePath), { recursive: true });
        }
        await fs.writeFile(paths.src, "export {};\n", "utf-8");
        await fs.writeFile(paths.extension, "export {};\n", "utf-8");
        await fs.writeFile(paths.tsconfig, "{}\n", "utf-8");
        await fs.writeFile(paths.packageJson, "{}\n", "utf-8");
        await fs.writeFile(paths.distEntry, "export {};\n", "utf-8");
        await fs.writeFile(paths.buildStamp, '{"head":null}\n', "utf-8");
        for (const filePath of [
          paths.src,
          paths.tsconfig,
          paths.packageJson,
          paths.distEntry,
          paths.buildStamp,
        ]) {
          fsSync.utimesSync(filePath, oldDate, filePath === paths.buildStamp ? stampDate : oldDate);
        }
        fsSync.utimesSync(paths.extension, extensionDate, extensionDate);

        const spawnCalls: string[][] = [];
        const spawn = (cmd: string, args: string[]) => {
          spawnCalls.push([cmd, ...args]);
          return {
            on: (event: string, cb: (code: number | null, signal: string | null) => void) => {
              if (event === "exit") {
                queueMicrotask(() => cb(0, null));
              }
              return undefined;
            },
          };
        };

        const { runNodeMain } = await import("../../scripts/run-node.mjs");
        const exitCode = await runNodeMain({
          cwd: tmp,
          args: ["gateway", "call", "health", "--json"],
          env: {
            ...process.env,
            FASED_RUNNER_LOG: "0",
          },
          spawn: spawn as never,
          execPath: process.execPath,
          platform: process.platform,
        });

        expect(exitCode).toBe(0);
        expect(spawnCalls[0]).toEqual(["pnpm", "exec", "tsdown", "--no-clean"]);
        expect(spawnCalls[1]).toEqual([
          process.execPath,
          "fased.mjs",
          "gateway",
          "call",
          "health",
          "--json",
        ]);
      });
    },
  );
});
