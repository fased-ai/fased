import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { FasedAgentConfig } from "../config/config.js";
import handler, {
  flushSessionMemoryWritesForTest,
} from "../hooks/bundled/session-memory/handler.js";
import { createHookEvent } from "../hooks/hooks.js";
import { writeFileWithinRoot } from "../infra/fs-safe.js";
import { makeTempWorkspace } from "../test-helpers/workspace.js";
import {
  buildMemoryInventory,
  previewMemoryInventoryRepair,
  validateMemoryInventory,
} from "./inventory.js";
import {
  collectObjectKeys,
  describeJsonShape,
  expectNoExecutableRepairFields,
  expectNoUnsafeMemoryDoctorFields,
} from "./memory-doctor-readonly-test-helpers.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function readSource(relativePath: string): Promise<string> {
  return fs.readFile(path.join(repoRoot, relativePath), "utf-8");
}

async function runSessionMemoryCapture(params: {
  workspaceDir: string;
  sessionId: string;
  timestamp: Date;
}): Promise<void> {
  const event = createHookEvent("command", "new", "agent:main:main", {
    cfg: {
      agents: { defaults: { workspace: params.workspaceDir } },
    } satisfies FasedAgentConfig,
    previousSessionEntry: {
      sessionId: params.sessionId,
    },
  });
  event.timestamp = params.timestamp;
  await handler(event);
  await flushSessionMemoryWritesForTest();
}

describe("Lane 5 session-memory filename collisions audit", () => {
  it("maps adopted collision suffix behavior against Fased session-memory writes", async () => {
    const handlerSource = await readSource("src/hooks/bundled/session-memory/handler.ts");
    expect(handlerSource).toContain("flushSessionMemoryWritesForTest");
    expect(handlerSource).toContain("resolveAvailableMemoryFilename");
    expect(handlerSource).toContain("const base = `${params.dateStr}-${params.slug}`;");
    expect(handlerSource).toContain("suffix += 1");
    expect(handlerSource).toContain(
      "const filename = await resolveAvailableMemoryFilename({ memoryDir, dateStr, slug });",
    );
    expect(handlerSource).toContain("await writeFileWithinRoot({");
    expect(handlerSource).toContain("rootDir: memoryDir");
    expect(handlerSource).toContain("relativePath: filename");
    expect(handlerSource).toContain("data: entry");
    expect(handlerSource).toContain('encoding: "utf8"');
    expect(handlerSource).not.toContain('await fs.writeFile(memoryFilePath, entry, "utf-8");');
    expect(handlerSource).toContain("allowLlmSlug");

    const handlerTestSource = await readSource("src/hooks/bundled/session-memory/handler.test.ts");
    expect(handlerTestSource).toContain(
      "does not call the model provider for a filename slug by default",
    );
    expect(handlerTestSource).toContain("does not block reset command handling");
    expect(handlerTestSource).toContain(
      "creates memory file with session content on /reset command",
    );
    expect(handlerTestSource).not.toContain("same-minute fallback timestamp captures");
    expect(handlerTestSource).not.toContain("0430-2.md");
  });

  it("maps Memory Doctor filename diagnostics visibility", async () => {
    const inventorySource = await readSource("src/memory/inventory.ts");
    expect(inventorySource).toContain("sessionMemory: {");
    expect(inventorySource).toContain("hookConfigured: Boolean(hookConfig)");
    expect(inventorySource).toContain("enabled: cfg.hooks?.internal?.enabled === true");
    expect(inventorySource).toContain("hookConfig?.llmSlug");
    expect(inventorySource).toContain("filenameDiagnostics?: SessionMemoryFilenameDiagnostics");
    expect(inventorySource).toContain("summarizeSessionMemoryFilenameDiagnostics");
    expect(inventorySource).not.toContain("filenameCollision");
    expect(inventorySource).not.toContain("collisionSuffix");

    const memoryCliSource = await readSource("src/cli/memory-cli.ts");
    expect(memoryCliSource).toContain("Memory Doctor");
    expect(memoryCliSource).toContain("inventory.sessionMemory.enabled");
    expect(memoryCliSource).toContain("inventory.sessionMemory.memoryDir");
    expect(memoryCliSource).toContain("formatPathState(inventory.sessionMemory.memoryDir)");
    expect(memoryCliSource).toContain("formatSessionMemoryFilenameDiagnostics");
    expect(memoryCliSource).toContain("filename diagnostics");
    expect(memoryCliSource).not.toContain("filename collision");
    expect(memoryCliSource).not.toContain("collision suffix");

    const memoryCliTestSource = await readSource("src/cli/memory-cli.test.ts");
    expect(memoryCliTestSource).toContain("prints read-only memory doctor diagnostics");
    expect(memoryCliTestSource).toContain("snapshots the memory doctor json envelope");
    expect(memoryCliTestSource).toContain("sessionMemory");
    expect(memoryCliTestSource).not.toContain("filename collision");
  });

  it("maps read-only Memory Doctor collision diagnostics without repair behavior", async () => {
    const workspaceDir = await makeTempWorkspace("fased-session-memory-doctor-collision-");
    const memoryDir = path.join(workspaceDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "# Memory\n", "utf-8");
    await fs.writeFile(path.join(memoryDir, "2026-01-01-0430.md"), "# First\n", "utf-8");
    await fs.writeFile(path.join(memoryDir, "2026-01-01-0430-2.md"), "# Second\n", "utf-8");

    const inventory = await buildMemoryInventory({
      agentId: "main",
      cfg: {
        agents: { defaults: { workspace: workspaceDir } },
        hooks: {
          internal: {
            enabled: true,
            entries: { "session-memory": { enabled: true } },
          },
        },
      } satisfies FasedAgentConfig,
    });
    const diagnostics = inventory.sessionMemory.filenameDiagnostics;
    expect(diagnostics).toEqual({
      checked: true,
      status: "suffixes-present",
      groups: [
        {
          stem: "2026-01-01-0430",
          state: "collision-suffixed",
          files: [
            { name: "2026-01-01-0430.md", suffix: 0 },
            { name: "2026-01-01-0430-2.md", suffix: 2 },
          ],
        },
      ],
    });

    const validation = validateMemoryInventory(inventory);
    expect(validation.findings.map((finding) => finding.code)).not.toContain(
      "sessionMemory.filenameSuffix.present",
    );
    expect(validation.findings.map((finding) => finding.code)).not.toContain(
      "sessionMemory.filenameDiagnostics.present",
    );
    const repairPreview = previewMemoryInventoryRepair(inventory);
    expect(repairPreview.proposals.map((proposal) => proposal.sourceCode)).not.toContain(
      "sessionMemory.filenameSuffix.present",
    );

    const diagnosticEnvelope = {
      inventory: {
        sessionMemory: {
          filenameDiagnostics: diagnostics,
        },
      },
    } as const;

    expectNoUnsafeMemoryDoctorFields(diagnosticEnvelope);
    expectNoExecutableRepairFields(repairPreview);
    expect([...collectObjectKeys(diagnosticEnvelope)].toSorted()).toEqual([
      "checked",
      "filenameDiagnostics",
      "files",
      "groups",
      "inventory",
      "name",
      "sessionMemory",
      "state",
      "status",
      "stem",
      "suffix",
    ]);
    expect(describeJsonShape(diagnosticEnvelope)).toMatchInlineSnapshot(`
      {
        "inventory": {
          "sessionMemory": {
            "filenameDiagnostics": {
              "checked": "boolean",
              "groups": [
                {
                  "files": [
                    {
                      "name": "string",
                      "suffix": "number",
                    },
                  ],
                  "state": "string",
                  "stem": "string",
                },
              ],
              "status": "string",
            },
          },
        },
      }
    `);
    expect(JSON.stringify({ diagnosticEnvelope, repairPreview })).not.toMatch(
      /doctor\.memory\.repair\.execute|repair --apply|--yes|writeFileWithinRoot/i,
    );
  });

  it("keeps future collision handling bounded to Fased-owned hook and doctor surfaces", async () => {
    const fsSafeSource = await readSource("src/infra/fs-safe.ts");
    expect(fsSafeSource).toContain("export async function writeFileWithinRoot");
    expect(fsSafeSource).toContain("path escapes root");
    expect(fsSafeSource).toContain("hardlinked path not allowed");

    const qmdManagerSource = await readSource("src/memory/qmd-manager.ts");
    expect(qmdManagerSource).toContain("private async exportSessions()");
    expect(qmdManagerSource).toContain(
      'const target = path.join(exportDir, `${path.basename(sessionFile, ".jsonl")}.md`);',
    );

    const qmdScopeSource = await readSource("src/memory/qmd-scope.ts");
    expect(qmdScopeSource).toContain("isQmdScopeAllowed");
    expect(qmdScopeSource).toContain("resolveQmdScopeDenial");
  });

  it("keeps repeated same-minute session-memory captures by adding numeric filename suffixes", async () => {
    const workspaceDir = await makeTempWorkspace("fased-session-memory-collision-");
    const timestamp = new Date("2026-01-01T04:30:15.000Z");

    await runSessionMemoryCapture({
      workspaceDir,
      timestamp,
      sessionId: "first-session",
    });
    await runSessionMemoryCapture({
      workspaceDir,
      timestamp,
      sessionId: "second-session",
    });

    const memoryDir = path.join(workspaceDir, "memory");
    const files = (await fs.readdir(memoryDir)).toSorted();
    expect(files).toEqual(["2026-01-01-0430-2.md", "2026-01-01-0430.md"]);
    await expect(
      fs.readFile(path.join(memoryDir, "2026-01-01-0430.md"), "utf-8"),
    ).resolves.toContain("- **Session ID**: first-session");
    await expect(
      fs.readFile(path.join(memoryDir, "2026-01-01-0430-2.md"), "utf-8"),
    ).resolves.toContain("- **Session ID**: second-session");
  });

  it("maps Fased safe-write behavior for collision-safe session-memory archive writes", async () => {
    const workspaceDir = await makeTempWorkspace("fased-session-memory-safe-write-");
    const memoryDir = path.join(workspaceDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });

    await writeFileWithinRoot({
      rootDir: memoryDir,
      relativePath: "2026-01-01-0430-2.md",
      data: "# Session Memory\n",
      encoding: "utf8",
      mkdir: true,
    });
    await expect(fs.readFile(path.join(memoryDir, "2026-01-01-0430-2.md"), "utf-8")).resolves.toBe(
      "# Session Memory\n",
    );
    await expect(
      writeFileWithinRoot({
        rootDir: memoryDir,
        relativePath: "../escape.md",
        data: "escape",
        encoding: "utf8",
        mkdir: true,
      }),
    ).rejects.toMatchObject({ code: "invalid-path" });

    const fsSafeSource = await readSource("src/infra/fs-safe.ts");
    expect(fsSafeSource).toContain("export async function writeFileWithinRoot");
    expect(fsSafeSource).toContain("OPEN_WRITE_FLAGS");
    expect(fsSafeSource).toContain("assertNoPathAliasEscape");
    expect(fsSafeSource).toContain("symlink open blocked");
    expect(fsSafeSource).toContain("hardlinked path not allowed");
    expect(fsSafeSource).toContain("path escapes root");

    const handlerSource = await readSource("src/hooks/bundled/session-memory/handler.ts");
    expect(handlerSource).toContain("resolveAvailableMemoryFilename");
    expect(handlerSource).toContain("await writeFileWithinRoot({");
    expect(handlerSource).toContain("rootDir: memoryDir");
    expect(handlerSource).toContain("relativePath: filename");
    expect(handlerSource).toContain("data: entry");
    expect(handlerSource).not.toContain('await fs.writeFile(memoryFilePath, entry, "utf-8");');

    const qmdSource = await readSource("src/memory/qmd-manager.ts");
    expect(qmdSource).toContain("private async exportSessions()");
    expect(qmdSource).toContain(
      'await fs.writeFile(target, this.renderSessionMarkdown(entry), "utf-8");',
    );
    expect(qmdSource).not.toContain("writeFileWithinRoot");
  });
});
