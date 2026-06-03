import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDiffViewTool } from "./diff-view-tool.js";

const originalStateDir = process.env.FASED_STATE_DIR;

afterEach(() => {
  if (originalStateDir === undefined) {
    delete process.env.FASED_STATE_DIR;
  } else {
    process.env.FASED_STATE_DIR = originalStateDir;
  }
});

describe("diff_view tool", () => {
  it("writes a canvas-style diff artifact for before/after text", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-diff-view-"));
    process.env.FASED_STATE_DIR = stateDir;
    const tool = createDiffViewTool();

    const result = await tool.execute("diff-1", {
      title: "Smoke Diff",
      before: "one\ntwo\n",
      after: "one\nthree\n",
    });

    expect(result.details).toMatchObject({
      ok: true,
      title: "Smoke Diff",
      added: 1,
      removed: 1,
    });
    const details = result.details as { filePath: string; canvasUrl: string };
    expect(details.canvasUrl).toMatch(/^\/__fased__\/canvas\/diffs\/smoke-diff-/u);
    const html = await fs.readFile(details.filePath, "utf8");
    expect(html).toContain("Smoke Diff");
    expect(html).toContain("three");
  });

  it("accepts unified diff input", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-diff-view-"));
    process.env.FASED_STATE_DIR = stateDir;
    const tool = createDiffViewTool();

    const result = await tool.execute("diff-2", {
      unifiedDiff: "@@ -1 +1 @@\n-old\n+new",
    });

    expect(result.details).toMatchObject({ ok: true, added: 1, removed: 1 });
  });
});
