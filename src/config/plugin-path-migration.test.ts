import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { repairMovedRepoPluginPaths } from "./plugin-path-migration.js";

const tempRoots: string[] = [];

async function createRepoPair() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fased-plugin-path-migration-"));
  tempRoots.push(root);
  const newRepo = path.join(root, "fased");
  const oldNestedRepo = path.join(root, "agent", "fased");
  const oldHostedRepo = path.join(root, "agent");
  await fsp.mkdir(path.join(newRepo, "extensions", "feishu"), { recursive: true });
  await fsp.mkdir(path.join(newRepo, "extensions", "discord"), { recursive: true });
  await fsp.writeFile(path.join(newRepo, "package.json"), "{}", "utf-8");
  await fsp.writeFile(path.join(newRepo, "extensions", "feishu", "index.ts"), "", "utf-8");
  await fsp.writeFile(path.join(newRepo, "extensions", "discord", "index.ts"), "", "utf-8");
  return { root, newRepo, oldNestedRepo, oldHostedRepo };
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true })),
  );
});

describe("repairMovedRepoPluginPaths", () => {
  it("rewrites plugin load paths from the old nested repo path", async () => {
    const { newRepo, oldNestedRepo } = await createRepoPair();

    const result = repairMovedRepoPluginPaths(
      {
        plugins: {
          load: { paths: [path.join(oldNestedRepo, "extensions", "feishu")] },
        },
      },
      { repoRoot: newRepo, pathExists: fs.existsSync },
    );

    expect(result.changed).toBe(true);
    expect(result.config.plugins?.load?.paths).toEqual([
      path.join(newRepo, "extensions", "feishu"),
    ]);
  });

  it("rewrites plugin admin RPC source paths from the old nested repo path", async () => {
    const { newRepo, oldNestedRepo } = await createRepoPair();

    const result = repairMovedRepoPluginPaths(
      {
        plugins: {
          entries: {
            discord: {
              runtime: {
                adminRpcActions: {
                  allow: [
                    {
                      method: "chat.inject",
                      sources: [
                        `source:${path.join(oldNestedRepo, "extensions", "discord", "index.ts")}`,
                      ],
                      requireOperatorApproval: true,
                    },
                  ],
                },
              },
            },
          },
        },
      },
      { repoRoot: newRepo, pathExists: fs.existsSync },
    );

    expect(result.changed).toBe(true);
    expect(
      result.config.plugins?.entries?.discord?.runtime?.adminRpcActions?.allow?.[0]?.sources,
    ).toEqual([`source:${path.join(newRepo, "extensions", "discord", "index.ts")}`]);
  });

  it("rewrites hosted paths from /home/app/agent-style repo moves", async () => {
    const { newRepo, oldHostedRepo } = await createRepoPair();

    const result = repairMovedRepoPluginPaths(
      {
        plugins: {
          load: { paths: [path.join(oldHostedRepo, "extensions", "feishu")] },
        },
      },
      { repoRoot: newRepo, pathExists: fs.existsSync },
    );

    expect(result.changed).toBe(true);
    expect(result.config.plugins?.load?.paths).toEqual([
      path.join(newRepo, "extensions", "feishu"),
    ]);
  });

  it("leaves paths unchanged when the target path does not exist", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fased-plugin-path-migration-"));
    tempRoots.push(root);
    const newRepo = path.join(root, "fased");
    const oldRepo = path.join(root, "agent", "fased");
    const oldPath = path.join(oldRepo, "extensions", "missing");
    await fsp.mkdir(newRepo, { recursive: true });

    const result = repairMovedRepoPluginPaths(
      {
        plugins: {
          load: { paths: [oldPath] },
        },
      },
      { repoRoot: newRepo, pathExists: fs.existsSync },
    );

    expect(result.changed).toBe(false);
    expect(result.config.plugins?.load?.paths).toEqual([oldPath]);
  });
});
