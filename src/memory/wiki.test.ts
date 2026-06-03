import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FasedAgentConfig } from "../config/config.js";
import { buildMemoryWiki, getMemoryWikiStatus } from "./wiki.js";

let tempDir = "";
let previousStateDir: string | undefined;

async function makeTempDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "fased-memory-wiki-"));
}

describe("memory wiki export", () => {
  beforeEach(async () => {
    tempDir = await makeTempDir();
    previousStateDir = process.env.FASED_STATE_DIR;
    process.env.FASED_STATE_DIR = path.join(tempDir, "state");
  });

  afterEach(async () => {
    if (previousStateDir === undefined) {
      delete process.env.FASED_STATE_DIR;
    } else {
      process.env.FASED_STATE_DIR = previousStateDir;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("compiles canonical memory files into state-dir markdown without writing workspace files", async () => {
    const workspace = path.join(tempDir, "workspace");
    await fs.mkdir(path.join(workspace, "memory"), { recursive: true });
    await fs.writeFile(
      path.join(workspace, "MEMORY.md"),
      "# Core Memory\n\nRemember launch.",
      "utf8",
    );
    await fs.writeFile(
      path.join(workspace, "memory", "2026-05-21-1200.md"),
      "# Session Note\n\nFollow the Agent-first setup.",
      "utf8",
    );
    const cfg = {
      agents: {
        list: [{ id: "main", name: "Assistant", workspace }],
      },
    } as FasedAgentConfig;

    const result = await buildMemoryWiki({ cfg, agentId: "main" });

    expect(result.sources).toBe(2);
    expect(result.pages).toBe(3);
    expect(result.outputDir).toContain(path.join("state", "memory-wiki", "main"));
    await expect(fs.readFile(result.indexPath, "utf8")).resolves.toContain("Core Memory");
    await expect(
      fs.readFile(path.join(result.outputDir, "sources", "core-memory.md"), "utf8"),
    ).resolves.toContain("Remember launch.");
    await expect(fs.stat(path.join(workspace, "sources"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    const status = await getMemoryWikiStatus({ cfg, agentId: "main" });
    expect(status).toMatchObject({
      agentId: "main",
      built: true,
      sources: 2,
      pages: 3,
    });
  });

  it("caps unsafe page names and ignores missing optional roots", async () => {
    const workspace = path.join(tempDir, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(
      path.join(workspace, "MEMORY.md"),
      "# ../../../../very long heading that should not escape roots and should be trimmed safely\n\nBody",
      "utf8",
    );
    const cfg = {
      agents: {
        list: [{ id: "main", workspace }],
      },
    } as FasedAgentConfig;

    const result = await buildMemoryWiki({ cfg, agentId: "main" });

    expect(result.sources).toBe(1);
    expect(result.sourceFiles[0]?.pagePath).toMatch(/^sources\/[-a-z0-9._]+\.md$/);
    expect(result.sourceFiles[0]?.pagePath).not.toContain("..");
    await expect(fs.readFile(result.indexPath, "utf8")).resolves.toContain("## Sources");
  });
});
