import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  describeJsonShape,
  expectNoExecutableRepairFields,
  expectNoMemoryDoctorTranscriptLeak,
} from "../memory/memory-doctor-readonly-test-helpers.js";

const getMemorySearchManager = vi.fn();
const loadConfig = vi.fn(() => ({}));
const resolveDefaultAgentId = vi.fn(() => "main");
const resolveAgentWorkspaceDir = vi.fn(
  (cfg: { agents?: { list?: Array<{ id?: string; workspace?: string }> } }, agentId: string) => {
    return (
      cfg.agents?.list?.find((entry) => entry.id === agentId)?.workspace ??
      path.join(os.tmpdir(), "fased")
    );
  },
);

vi.mock("../memory/index.js", () => ({
  getMemorySearchManager,
}));

vi.mock("../config/config.js", () => ({
  loadConfig,
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveDefaultAgentId,
  resolveAgentWorkspaceDir,
}));

let registerMemoryCli: typeof import("./memory-cli.js").registerMemoryCli;
let defaultRuntime: typeof import("../runtime.js").defaultRuntime;
let isVerbose: typeof import("../globals.js").isVerbose;
let setVerbose: typeof import("../globals.js").setVerbose;

beforeAll(async () => {
  ({ registerMemoryCli } = await import("./memory-cli.js"));
  ({ defaultRuntime } = await import("../runtime.js"));
  ({ isVerbose, setVerbose } = await import("../globals.js"));
});

afterEach(() => {
  vi.restoreAllMocks();
  getMemorySearchManager.mockClear();
  process.exitCode = undefined;
  setVerbose(false);
});

describe("memory cli", () => {
  function spyRuntimeLogs() {
    return vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
  }

  function spyRuntimeErrors() {
    return vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
  }

  function firstLoggedJson(log: ReturnType<typeof vi.spyOn>) {
    return JSON.parse(String(log.mock.calls[0]?.[0] ?? "null")) as Record<string, unknown>;
  }

  function expectCliSync(sync: ReturnType<typeof vi.fn>) {
    expect(sync).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "cli", force: false, progress: expect.any(Function) }),
    );
  }

  function makeMemoryStatus(overrides: Record<string, unknown> = {}) {
    return {
      files: 0,
      chunks: 0,
      dirty: false,
      workspaceDir: "/tmp/fased",
      dbPath: "/tmp/memory.sqlite",
      provider: "openai",
      model: "text-embedding-3-small",
      requestedProvider: "openai",
      vector: { enabled: true, available: true },
      ...overrides,
    };
  }

  function mockManager(manager: Record<string, unknown>) {
    getMemorySearchManager.mockResolvedValueOnce({ manager });
  }

  async function runMemoryCli(args: string[]) {
    const program = new Command();
    program.name("test");
    registerMemoryCli(program);
    await program.parseAsync(["memory", ...args], { from: "user" });
  }

  function createRegisteredMemoryProgram() {
    const program = new Command();
    program.name("test");
    registerMemoryCli(program);
    return program;
  }

  async function withQmdIndexDb(content: string, run: (dbPath: string) => Promise<void>) {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-cli-qmd-index-"));
    const dbPath = path.join(tmpDir, "index.sqlite");
    try {
      await fs.writeFile(dbPath, content, "utf-8");
      await run(dbPath);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }

  async function withMemoryDoctorWorkspace(run: (workspaceDir: string) => Promise<void>) {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-cli-doctor-"));
    try {
      await fs.mkdir(path.join(tmpDir, "memory"), { recursive: true });
      await fs.writeFile(path.join(tmpDir, "MEMORY.md"), "# Memory\n", "utf-8");
      await run(tmpDir);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }

  async function expectCloseFailureAfterCommand(params: {
    args: string[];
    manager: Record<string, unknown>;
    beforeExpect?: () => void;
  }) {
    const close = vi.fn(async () => {
      throw new Error("close boom");
    });
    mockManager({ ...params.manager, close });

    const error = spyRuntimeErrors();
    await runMemoryCli(params.args);

    params.beforeExpect?.();
    expect(close).toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("Memory manager close failed: close boom"),
    );
    expect(process.exitCode).toBeUndefined();
  }

  it("prints vector status when available", async () => {
    const close = vi.fn(async () => {});
    mockManager({
      probeVectorAvailability: vi.fn(async () => true),
      status: () =>
        makeMemoryStatus({
          files: 2,
          chunks: 5,
          cache: { enabled: true, entries: 123, maxEntries: 50000 },
          fts: { enabled: true, available: true },
          vector: {
            enabled: true,
            available: true,
            extensionPath: "/opt/sqlite-vec.dylib",
            dims: 1024,
          },
        }),
      close,
    });

    const log = spyRuntimeLogs();
    await runMemoryCli(["status"]);

    expect(log).toHaveBeenCalledWith(expect.stringContaining("Vector: ready"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Vector dims: 1024"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Vector path: /opt/sqlite-vec.dylib"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("FTS: ready"));
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("Embedding cache: enabled (123 entries)"),
    );
    expect(close).toHaveBeenCalled();
  });

  it("prints vector error when unavailable", async () => {
    const close = vi.fn(async () => {});
    mockManager({
      probeVectorAvailability: vi.fn(async () => false),
      status: () =>
        makeMemoryStatus({
          dirty: true,
          vector: {
            enabled: true,
            available: false,
            loadError: "load failed",
          },
        }),
      close,
    });

    const log = spyRuntimeLogs();
    await runMemoryCli(["status", "--agent", "main"]);

    expect(log).toHaveBeenCalledWith(expect.stringContaining("Vector: unavailable"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Vector error: load failed"));
    expect(close).toHaveBeenCalled();
  });

  it("prints embeddings status when deep", async () => {
    const close = vi.fn(async () => {});
    const probeEmbeddingAvailability = vi.fn(async () => ({ ok: true }));
    mockManager({
      probeVectorAvailability: vi.fn(async () => true),
      probeEmbeddingAvailability,
      status: () => makeMemoryStatus({ files: 1, chunks: 1 }),
      close,
    });

    const log = spyRuntimeLogs();
    await runMemoryCli(["status", "--deep"]);

    expect(probeEmbeddingAvailability).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Embeddings: ready"));
    expect(close).toHaveBeenCalled();
  });

  it("enables verbose logging with --verbose", async () => {
    const close = vi.fn(async () => {});
    mockManager({
      probeVectorAvailability: vi.fn(async () => true),
      status: () => makeMemoryStatus(),
      close,
    });

    await runMemoryCli(["status", "--verbose"]);

    expect(isVerbose()).toBe(true);
  });

  it("logs close failure after status", async () => {
    await expectCloseFailureAfterCommand({
      args: ["status"],
      manager: {
        probeVectorAvailability: vi.fn(async () => true),
        status: () => makeMemoryStatus({ files: 1, chunks: 1 }),
      },
    });
  });

  it("prints read-only memory doctor diagnostics", async () => {
    await withMemoryDoctorWorkspace(async (workspaceDir) => {
      await fs.writeFile(path.join(workspaceDir, "memory", "2026-01-01-0430.md"), "# First\n");
      await fs.writeFile(path.join(workspaceDir, "memory", "2026-01-01-0430-2.md"), "# Second\n");
      loadConfig.mockReturnValueOnce({
        agents: { list: [{ id: "main", default: true, workspace: workspaceDir }] },
      });
      const close = vi.fn(async () => {});
      mockManager({
        status: () =>
          makeMemoryStatus({
            files: 1,
            chunks: 2,
            workspaceDir,
            dbPath: path.join(workspaceDir, "memory.sqlite"),
          }),
        close,
      });

      const log = spyRuntimeLogs();
      await runMemoryCli(["doctor"]);

      const output = log.mock.calls.map((call) => String(call[0])).join("\n");
      expect(output).toContain("Memory Doctor");
      expect(output).toContain("Workspace");
      expect(output).toContain("Validation");
      expect(output).toContain("Repair preview");
      expect(output).toContain("filename diagnostics suffixes present (1 group, 2 files)");
      expect(output).toContain("Dry-run proposals");
      expect(output).toContain("plugin.memory.unavailable");
      expect(output).not.toContain("repair --apply");
      expect(close).toHaveBeenCalled();
    });
  });

  it("registers gated memory repair execution outside the read-only doctor command", async () => {
    const program = createRegisteredMemoryProgram();
    const memoryCommand = program.commands.find((command) => command.name() === "memory");
    expect(memoryCommand).toBeTruthy();

    const subcommands = memoryCommand?.commands.map((command) => command.name()) ?? [];
    expect(subcommands).toContain("doctor");
    expect(subcommands).toContain("repair");
    expect(subcommands).not.toContain("execute");
    expect(subcommands).not.toContain("preflight");

    const doctorCommand = memoryCommand?.commands.find((command) => command.name() === "doctor");
    expect(doctorCommand).toBeTruthy();
    const doctorFlags = doctorCommand?.options.map((option) => option.flags).join(" ") ?? "";
    expect(doctorFlags).toContain("--agent <id>");
    expect(doctorFlags).toContain("--json");
    expect(doctorFlags).not.toMatch(/--(?:apply|execute|preflight|repair|write|yes)\b/);

    const repairCommand = memoryCommand?.commands.find((command) => command.name() === "repair");
    expect(repairCommand).toBeTruthy();
    const repairSubcommands = repairCommand?.commands.map((command) => command.name()) ?? [];
    expect(repairSubcommands).toContain("execute");
    const executeCommand = repairCommand?.commands.find((command) => command.name() === "execute");
    const executeFlags = executeCommand?.options.map((option) => option.flags).join(" ") ?? "";
    expect(executeFlags).toContain("--proposal-id <id>");
    expect(executeFlags).toContain("--yes");
    expect(executeFlags).toContain("--json");

    await expect(
      runMemoryCli(["repair", "execute", "--proposal-id", "proposal-1"]),
    ).rejects.toThrow("requires --yes");
  });

  it("prints read-only memory doctor diagnostics as json", async () => {
    await withMemoryDoctorWorkspace(async (workspaceDir) => {
      loadConfig.mockReturnValueOnce({
        agents: { list: [{ id: "main", default: true, workspace: workspaceDir }] },
      });
      const close = vi.fn(async () => {});
      mockManager({
        status: () =>
          makeMemoryStatus({
            files: 1,
            chunks: 2,
            workspaceDir,
            dbPath: path.join(workspaceDir, "memory.sqlite"),
          }),
        close,
      });

      const log = spyRuntimeLogs();
      await runMemoryCli(["doctor", "--json"]);

      const payload = firstLoggedJson(log);
      const reports = payload.reports as Array<Record<string, unknown>>;
      expect(reports).toHaveLength(1);
      const report = reports[0];
      expect(report.agentId).toBe("main");
      expect(Object.keys(report).toSorted()).toEqual([
        "agentId",
        "inventory",
        "repairPreview",
        "validation",
      ]);

      const inventory = report.inventory as Record<string, unknown>;
      const validation = report.validation as { findings?: unknown[] };
      const repairPreview = report.repairPreview as {
        dryRun?: unknown;
        proposals?: Array<Record<string, unknown>>;
      };
      expect(Object.keys(inventory).toSorted()).toEqual([
        "agentId",
        "backend",
        "memoryPlugin",
        "qmd",
        "sessionMemory",
        "workspace",
      ]);
      const sessionMemory = inventory.sessionMemory as {
        filenameDiagnostics?: { checked?: unknown; status?: unknown; groups?: unknown[] };
      };
      expect(sessionMemory.filenameDiagnostics).toMatchObject({
        checked: true,
        status: "none",
        groups: [],
      });
      expect(validation.findings?.length).toBeGreaterThan(0);
      expect(Object.keys(repairPreview).toSorted()).toEqual([
        "agentId",
        "dryRun",
        "ok",
        "proposals",
        "summary",
        "validation",
      ]);
      expect(repairPreview.dryRun).toBe(true);
      expect(repairPreview.proposals?.length).toBeGreaterThan(0);
      for (const proposal of repairPreview.proposals ?? []) {
        expect(proposal.dryRun).toBe(true);
        expect(proposal.wouldMutate).toBe(true);
        expect(proposal.requiresOperatorWrite).toBe(true);
      }

      expectNoExecutableRepairFields(repairPreview);
      expect(JSON.stringify(report)).not.toMatch(
        /doctor\.memory\.repair\.execute|execute repair|repair executor|gateway handler/i,
      );
      expect(close).toHaveBeenCalled();
    });
  });

  it("snapshots the memory doctor json envelope as read-only shape metadata", async () => {
    await withMemoryDoctorWorkspace(async (workspaceDir) => {
      loadConfig.mockReturnValueOnce({
        agents: { list: [{ id: "main", default: true, workspace: workspaceDir }] },
      });
      const close = vi.fn(async () => {});
      mockManager({
        status: () =>
          makeMemoryStatus({
            files: 1,
            chunks: 2,
            workspaceDir,
            dbPath: path.join(workspaceDir, "memory.sqlite"),
          }),
        close,
      });

      const log = spyRuntimeLogs();
      await runMemoryCli(["doctor", "--json"]);

      const payload = firstLoggedJson(log);
      expectNoExecutableRepairFields(payload);
      expect(describeJsonShape(payload)).toMatchInlineSnapshot(`
        {
          "reports": [
            {
              "agentId": "string",
              "inventory": {
                "agentId": "string",
                "backend": {
                  "chunks": "number",
                  "citations": "string",
                  "configured": "string",
                  "db": {
                    "exists": "boolean",
                    "kind": "string",
                    "path": "string",
                  },
                  "dirty": "boolean",
                  "files": "number",
                  "model": "string",
                  "provider": "string",
                  "requestedProvider": "string",
                },
                "memoryPlugin": {
                  "configuredSlot": "string",
                  "enabled": "boolean",
                  "reason": "string",
                  "registryLoaded": "boolean",
                },
                "qmd": {
                  "enabled": "boolean",
                },
                "sessionMemory": {
                  "enabled": "boolean",
                  "filenameDiagnostics": {
                    "checked": "boolean",
                    "groups": [],
                    "status": "string",
                  },
                  "hookConfigured": "boolean",
                  "memoryDir": {
                    "exists": "boolean",
                    "kind": "string",
                    "markdownFiles": "number",
                    "path": "string",
                  },
                },
                "workspace": {
                  "exists": "boolean",
                  "memoryRoots": [
                    {
                      "exists": "boolean",
                      "id": "string",
                      "kind": "string",
                      "markdownFiles": "number",
                      "path": "string",
                    },
                  ],
                  "path": "string",
                },
              },
              "repairPreview": {
                "agentId": "string",
                "dryRun": "boolean",
                "ok": "boolean",
                "proposals": [
                  {
                    "action": "string",
                    "area": "string",
                    "blockReason": "string",
                    "description": "string",
                    "dryRun": "boolean",
                    "id": "string",
                    "requiresOperatorWrite": "boolean",
                    "severity": "string",
                    "sourceCode": "string",
                    "supported": "boolean",
                    "targetPath": "string",
                    "wouldMutate": "boolean",
                  },
                ],
                "summary": {
                  "blocked": "number",
                  "proposals": "number",
                  "supported": "number",
                },
                "validation": {
                  "errors": "number",
                  "info": "number",
                  "warnings": "number",
                },
              },
              "validation": {
                "agentId": "string",
                "findings": [
                  {
                    "area": "string",
                    "code": "string",
                    "message": "string",
                    "path": "string",
                    "severity": "string",
                  },
                ],
                "ok": "boolean",
                "summary": {
                  "errors": "number",
                  "info": "number",
                  "warnings": "number",
                },
              },
            },
          ],
        }
      `);
      expect(close).toHaveBeenCalled();
    });
  });

  it("does not leak transcript bodies or executable repair fields in memory doctor json", async () => {
    await withMemoryDoctorWorkspace(async (workspaceDir) => {
      const secretBody =
        "SECRET_TRANSCRIPT_BODY: customer said the seed phrase is not for diagnostics";
      await fs.writeFile(path.join(workspaceDir, "memory", "transcript.md"), secretBody, "utf-8");
      loadConfig.mockReturnValueOnce({
        agents: { list: [{ id: "main", default: true, workspace: workspaceDir }] },
      });
      const close = vi.fn(async () => {});
      mockManager({
        status: () =>
          makeMemoryStatus({
            files: 2,
            chunks: 4,
            workspaceDir,
            dbPath: path.join(workspaceDir, "memory.sqlite"),
          }),
        close,
      });

      const log = spyRuntimeLogs();
      await runMemoryCli(["doctor", "--json"]);

      const payload = firstLoggedJson(log);
      const serialized = JSON.stringify(payload);
      const reports = payload.reports as Array<Record<string, unknown>>;
      const report = reports[0];
      expect(reports).toHaveLength(1);
      expect(report.agentId).toBe("main");
      expectNoMemoryDoctorTranscriptLeak(payload, secretBody);
      expectNoExecutableRepairFields(report.repairPreview);
      expect(serialized).not.toMatch(
        /doctor\.memory\.repair\.execute|execute repair|repair executor|gateway handler/i,
      );
      expect(close).toHaveBeenCalled();
    });
  });

  it("does not leak transcript bodies or executable fields from inventory and validation json", async () => {
    await withMemoryDoctorWorkspace(async (workspaceDir) => {
      const secretBody =
        "SECRET_TRANSCRIPT_BODY: validation should never echo transcript message body";
      await fs.writeFile(path.join(workspaceDir, "memory", "transcript.md"), secretBody, "utf-8");
      loadConfig.mockReturnValueOnce({
        agents: { list: [{ id: "main", default: true, workspace: workspaceDir }] },
      });
      const close = vi.fn(async () => {});
      mockManager({
        status: () =>
          makeMemoryStatus({
            files: 2,
            chunks: 4,
            workspaceDir,
            dbPath: path.join(workspaceDir, "memory.sqlite"),
          }),
        close,
      });

      const log = spyRuntimeLogs();
      await runMemoryCli(["doctor", "--json"]);

      const payload = firstLoggedJson(log);
      const reports = payload.reports as Array<Record<string, unknown>>;
      expect(reports).toHaveLength(1);
      const report = reports[0];
      const inventory = report.inventory as Record<string, unknown>;
      const validation = report.validation as Record<string, unknown>;

      expectNoMemoryDoctorTranscriptLeak(inventory, secretBody);
      expectNoMemoryDoctorTranscriptLeak(validation, secretBody);
      expectNoExecutableRepairFields(inventory);
      expectNoExecutableRepairFields(validation);
      expect(JSON.stringify({ inventory, validation })).not.toMatch(
        /doctor\.memory\.repair\.execute|execute repair|repair executor|gateway handler/i,
      );
      expect(JSON.stringify({ inventory, validation })).not.toMatch(
        /wouldMutate|requiresOperatorWrite|dryRun|proposal/i,
      );
      expect(close).toHaveBeenCalled();
    });
  });

  it("reindexes on status --index", async () => {
    const close = vi.fn(async () => {});
    const sync = vi.fn(async () => {});
    const probeEmbeddingAvailability = vi.fn(async () => ({ ok: true }));
    mockManager({
      probeVectorAvailability: vi.fn(async () => true),
      probeEmbeddingAvailability,
      sync,
      status: () => makeMemoryStatus({ files: 1, chunks: 1 }),
      close,
    });

    spyRuntimeLogs();
    await runMemoryCli(["status", "--index"]);

    expectCliSync(sync);
    expect(probeEmbeddingAvailability).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });

  it("closes manager after index", async () => {
    const close = vi.fn(async () => {});
    const sync = vi.fn(async () => {});
    mockManager({ sync, close });

    const log = spyRuntimeLogs();
    await runMemoryCli(["index"]);

    expectCliSync(sync);
    expect(close).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("Memory index updated (main).");
  });

  it("logs qmd index file path and size after index", async () => {
    const close = vi.fn(async () => {});
    const sync = vi.fn(async () => {});
    await withQmdIndexDb("sqlite-bytes", async (dbPath) => {
      mockManager({ sync, status: () => ({ backend: "qmd", dbPath }), close });

      const log = spyRuntimeLogs();
      await runMemoryCli(["index"]);

      expectCliSync(sync);
      expect(log).toHaveBeenCalledWith(expect.stringContaining("QMD index: "));
      expect(log).toHaveBeenCalledWith("Memory index updated (main).");
      expect(close).toHaveBeenCalled();
    });
  });

  it("fails index when qmd db file is empty", async () => {
    const close = vi.fn(async () => {});
    const sync = vi.fn(async () => {});
    await withQmdIndexDb("", async (dbPath) => {
      mockManager({ sync, status: () => ({ backend: "qmd", dbPath }), close });

      const error = spyRuntimeErrors();
      await runMemoryCli(["index"]);

      expectCliSync(sync);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("Memory index failed (main): QMD index file is empty"),
      );
      expect(close).toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });
  });

  it("logs close failures without failing the command", async () => {
    const sync = vi.fn(async () => {});
    await expectCloseFailureAfterCommand({
      args: ["index"],
      manager: { sync },
      beforeExpect: () => {
        expectCliSync(sync);
      },
    });
  });

  it("logs close failure after search", async () => {
    const search = vi.fn(async () => [
      {
        path: "memory/2026-01-12.md",
        startLine: 1,
        endLine: 2,
        score: 0.5,
        snippet: "Hello",
      },
    ]);
    await expectCloseFailureAfterCommand({
      args: ["search", "hello"],
      manager: { search },
      beforeExpect: () => {
        expect(search).toHaveBeenCalled();
      },
    });
  });

  it("closes manager after search error", async () => {
    const close = vi.fn(async () => {});
    const search = vi.fn(async () => {
      throw new Error("boom");
    });
    mockManager({ search, close });

    const error = spyRuntimeErrors();
    await runMemoryCli(["search", "oops"]);

    expect(search).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Memory search failed: boom"));
    expect(process.exitCode).toBe(1);
  });

  it("prints status json output when requested", async () => {
    const close = vi.fn(async () => {});
    mockManager({
      probeVectorAvailability: vi.fn(async () => true),
      status: () => makeMemoryStatus({ workspaceDir: undefined }),
      close,
    });

    const log = spyRuntimeLogs();
    await runMemoryCli(["status", "--json"]);

    const payload = firstLoggedJson(log);
    expect(Array.isArray(payload)).toBe(true);
    expect((payload[0] as Record<string, unknown>)?.agentId).toBe("main");
    expect(close).toHaveBeenCalled();
  });

  it("logs default message when memory manager is missing", async () => {
    getMemorySearchManager.mockResolvedValueOnce({ manager: null });

    const log = spyRuntimeLogs();
    await runMemoryCli(["status"]);

    expect(log).toHaveBeenCalledWith("Memory search disabled.");
  });

  it("logs backend unsupported message when index has no sync", async () => {
    const close = vi.fn(async () => {});
    mockManager({
      status: () => makeMemoryStatus(),
      close,
    });

    const log = spyRuntimeLogs();
    await runMemoryCli(["index"]);

    expect(log).toHaveBeenCalledWith("Memory backend does not support manual reindex.");
    expect(close).toHaveBeenCalled();
  });

  it("prints no matches for empty search results", async () => {
    const close = vi.fn(async () => {});
    const search = vi.fn(async () => []);
    mockManager({ search, close });

    const log = spyRuntimeLogs();
    await runMemoryCli(["search", "hello"]);

    expect(search).toHaveBeenCalledWith("hello", {
      maxResults: undefined,
      minScore: undefined,
    });
    expect(log).toHaveBeenCalledWith("No matches.");
    expect(close).toHaveBeenCalled();
  });

  it("accepts --query for memory search", async () => {
    const close = vi.fn(async () => {});
    const search = vi.fn(async () => []);
    mockManager({ search, close });

    const log = spyRuntimeLogs();
    await runMemoryCli(["search", "--query", "deployment notes"]);

    expect(search).toHaveBeenCalledWith("deployment notes", {
      maxResults: undefined,
      minScore: undefined,
    });
    expect(log).toHaveBeenCalledWith("No matches.");
    expect(close).toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("prefers --query when positional and flag are both provided", async () => {
    const close = vi.fn(async () => {});
    const search = vi.fn(async () => []);
    mockManager({ search, close });

    spyRuntimeLogs();
    await runMemoryCli(["search", "positional", "--query", "flagged"]);

    expect(search).toHaveBeenCalledWith("flagged", {
      maxResults: undefined,
      minScore: undefined,
    });
    expect(close).toHaveBeenCalled();
  });

  it("fails when neither positional query nor --query is provided", async () => {
    const error = spyRuntimeErrors();
    await runMemoryCli(["search"]);

    expect(error).toHaveBeenCalledWith(
      "Missing search query. Provide a positional query or use --query <text>.",
    );
    expect(getMemorySearchManager).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("prints search results as json when requested", async () => {
    const close = vi.fn(async () => {});
    const search = vi.fn(async () => [
      {
        path: "memory/2026-01-12.md",
        startLine: 1,
        endLine: 2,
        score: 0.5,
        snippet: "Hello",
      },
    ]);
    mockManager({ search, close });

    const log = spyRuntimeLogs();
    await runMemoryCli(["search", "hello", "--json"]);

    const payload = firstLoggedJson(log);
    expect(Array.isArray(payload.results)).toBe(true);
    expect(payload.results as unknown[]).toHaveLength(1);
    expect(close).toHaveBeenCalled();
  });
});
