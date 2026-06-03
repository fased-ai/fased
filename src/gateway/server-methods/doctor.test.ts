import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FasedAgentConfig } from "../../config/config.js";
import type {
  DoctorMemoryInventoryPayload,
  DoctorMemoryRepairPreviewPayload,
  DoctorMemoryValidationPayload,
} from "../../memory/inventory.js";
import { DOCTOR_MEMORY_REPAIR_EXECUTION_METHOD } from "../../memory/repair-execution-request-contract.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";

const loadConfig = vi.hoisted(() => vi.fn(() => ({}) as FasedAgentConfig));
const resolveDefaultAgentId = vi.hoisted(() => vi.fn(() => "main"));
const resolveAgentWorkspaceDir = vi.hoisted(() =>
  vi.fn((_cfg?: FasedAgentConfig, _agentId?: string) => "/tmp/fased"),
);
const getMemorySearchManager = vi.hoisted(() => vi.fn());

vi.mock("../../config/config.js", () => ({
  loadConfig,
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
}));

vi.mock("../../memory/index.js", () => ({
  getMemorySearchManager,
}));

import { doctorHandlers } from "./doctor.js";

describe("doctor.memory repair execution boundary", () => {
  it("registers read-only memory doctor handlers plus gated admin repair execute", () => {
    const closedRepairMethods = [
      "doctor.memory.repair.preflight",
      "doctor.memory.repair.preflight.pipeline",
      "doctor.memory.repair.preflight.cli-preview",
      "doctor.memory.repair.preflight.dashboard-preview",
    ];
    for (const method of closedRepairMethods) {
      expect(doctorHandlers[method]).toBeUndefined();
    }
    expect(
      Object.keys(doctorHandlers).filter((method) => method.startsWith("doctor.memory.")),
    ).toEqual([
      "doctor.memory.status",
      "doctor.memory.inventory",
      "doctor.memory.validate",
      "doctor.memory.wiki.status",
      "doctor.memory.wiki.rebuild",
      "doctor.memory.repair.preview",
      DOCTOR_MEMORY_REPAIR_EXECUTION_METHOD,
    ]);
    expect(doctorHandlers[DOCTOR_MEMORY_REPAIR_EXECUTION_METHOD]).toBeTypeOf("function");
  });
});

const invokeDoctorMemoryStatus = async (
  respond: ReturnType<typeof vi.fn>,
  params: Record<string, unknown> = {},
) => {
  await doctorHandlers["doctor.memory.status"]({
    req: {} as never,
    params: params as never,
    respond: respond as never,
    context: {} as never,
    client: null,
    isWebchatConnect: () => false,
  });
};

const invokeDoctorMemoryInventory = async (
  respond: ReturnType<typeof vi.fn>,
  params: Record<string, unknown> = {},
) => {
  await doctorHandlers["doctor.memory.inventory"]({
    req: {} as never,
    params: params as never,
    respond: respond as never,
    context: {} as never,
    client: null,
    isWebchatConnect: () => false,
  });
};

const invokeDoctorMemoryValidate = async (
  respond: ReturnType<typeof vi.fn>,
  params: Record<string, unknown> = {},
) => {
  await doctorHandlers["doctor.memory.validate"]({
    req: {} as never,
    params: params as never,
    respond: respond as never,
    context: {} as never,
    client: null,
    isWebchatConnect: () => false,
  });
};

const invokeDoctorMemoryRepairPreview = async (
  respond: ReturnType<typeof vi.fn>,
  params: Record<string, unknown> = {},
) => {
  await doctorHandlers["doctor.memory.repair.preview"]({
    req: {} as never,
    params: params as never,
    respond: respond as never,
    context: {} as never,
    client: null,
    isWebchatConnect: () => false,
  });
};

const expectEmbeddingErrorResponse = (respond: ReturnType<typeof vi.fn>, error: string) => {
  expect(respond).toHaveBeenCalledWith(
    true,
    {
      agentId: "main",
      embedding: {
        ok: false,
        error,
      },
      dreaming: expect.objectContaining({
        enabled: false,
        storageMode: "inline",
        shortTermCount: 0,
      }),
    },
    undefined,
  );
};

describe("doctor.memory.status", () => {
  beforeEach(() => {
    loadConfig.mockClear();
    resolveDefaultAgentId.mockClear();
    resolveAgentWorkspaceDir.mockClear();
    getMemorySearchManager.mockReset();
    resetPluginRuntimeStateForTest();
  });

  it("returns gateway embedding probe status for the default agent", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    getMemorySearchManager.mockResolvedValue({
      manager: {
        status: () => ({ provider: "gemini" }),
        probeEmbeddingAvailability: vi.fn().mockResolvedValue({ ok: true }),
        close,
      },
    });
    const respond = vi.fn();

    await invokeDoctorMemoryStatus(respond);

    expect(getMemorySearchManager).toHaveBeenCalledWith({
      cfg: expect.any(Object),
      agentId: "main",
      purpose: "status",
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        agentId: "main",
        provider: "gemini",
        embedding: { ok: true },
        dreaming: expect.objectContaining({
          enabled: false,
          storageMode: "inline",
          shortTermCount: 0,
        }),
      }),
      undefined,
    );
    expect(close).toHaveBeenCalled();
  });

  it("uses an explicit agent for gateway embedding status", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    getMemorySearchManager.mockResolvedValue({
      manager: {
        status: () => ({ provider: "builtin" }),
        probeEmbeddingAvailability: vi.fn().mockResolvedValue({ ok: true }),
        close,
      },
    });
    const respond = vi.fn();

    await invokeDoctorMemoryStatus(respond, { agentId: "research" });

    expect(getMemorySearchManager).toHaveBeenCalledWith({
      cfg: expect.any(Object),
      agentId: "research",
      purpose: "status",
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        agentId: "research",
        provider: "builtin",
        embedding: { ok: true },
        dreaming: expect.objectContaining({
          enabled: false,
          storageMode: "inline",
          shortTermCount: 0,
        }),
      }),
      undefined,
    );
    expect(close).toHaveBeenCalled();
  });

  it("returns memory-core dreaming status from plugin config", async () => {
    loadConfig.mockReturnValueOnce({
      plugins: {
        entries: {
          "memory-core": {
            config: {
              dreaming: {
                enabled: true,
                timezone: "UTC",
                storageMode: "both",
                verboseLogging: true,
                separateReports: true,
                phases: {
                  light: { enabled: true, cron: "15 2 * * *", lookbackDays: 3, limit: 8 },
                  deep: {
                    enabled: true,
                    cron: "30 3 * * *",
                    limit: 5,
                    minScore: 0.7,
                    minRecallCount: 4,
                    minUniqueQueries: 2,
                    recencyHalfLifeDays: 14,
                  },
                  rem: {
                    enabled: true,
                    cron: "45 4 * * *",
                    lookbackDays: 9,
                    limit: 6,
                    minPatternStrength: 0.8,
                  },
                },
              },
            },
          },
        },
      },
    } as FasedAgentConfig);
    const close = vi.fn().mockResolvedValue(undefined);
    getMemorySearchManager.mockResolvedValue({
      manager: {
        status: () => ({ provider: "builtin" }),
        probeEmbeddingAvailability: vi.fn().mockResolvedValue({ ok: true }),
        close,
      },
    });
    const respond = vi.fn();

    await invokeDoctorMemoryStatus(respond, { agentId: "research" });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        agentId: "research",
        dreaming: expect.objectContaining({
          enabled: true,
          timezone: "UTC",
          storageMode: "both",
          verboseLogging: true,
          separateReports: true,
          phases: expect.objectContaining({
            light: expect.objectContaining({
              enabled: true,
              cron: "15 2 * * *",
              lookbackDays: 3,
              limit: 8,
            }),
            deep: expect.objectContaining({
              enabled: true,
              cron: "30 3 * * *",
              minScore: 0.7,
            }),
            rem: expect.objectContaining({
              enabled: true,
              cron: "45 4 * * *",
              minPatternStrength: 0.8,
            }),
          }),
        }),
      }),
      undefined,
    );
  });

  it("returns unavailable when memory manager is missing", async () => {
    getMemorySearchManager.mockResolvedValue({
      manager: null,
      error: "memory search unavailable",
    });
    const respond = vi.fn();

    await invokeDoctorMemoryStatus(respond);

    expectEmbeddingErrorResponse(respond, "memory search unavailable");
  });

  it("returns probe failure when manager probe throws", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    getMemorySearchManager.mockResolvedValue({
      manager: {
        status: () => ({ provider: "openai" }),
        probeEmbeddingAvailability: vi.fn().mockRejectedValue(new Error("timeout")),
        close,
      },
    });
    const respond = vi.fn();

    await invokeDoctorMemoryStatus(respond);

    expectEmbeddingErrorResponse(respond, "gateway memory probe failed: timeout");
    expect(close).toHaveBeenCalled();
  });
});

describe("doctor.memory.inventory", () => {
  beforeEach(() => {
    loadConfig.mockClear();
    resolveDefaultAgentId.mockClear();
    resolveAgentWorkspaceDir.mockClear();
    getMemorySearchManager.mockReset();
    resetPluginRuntimeStateForTest();
  });

  it("returns read-only memory artifact inventory without transcript content", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-memory-inventory-"));
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    const memoryDir = path.join(workspaceDir, "memory");
    const sessionExportDir = path.join(stateDir, "qmd-sessions");
    const qmdIndexPath = path.join(
      stateDir,
      "agents",
      "main",
      "qmd",
      "xdg-cache",
      "qmd",
      "index.sqlite",
    );
    const previousStateDir = process.env.FASED_STATE_DIR;
    process.env.FASED_STATE_DIR = stateDir;
    try {
      await fs.mkdir(path.join(memoryDir, "nested"), { recursive: true });
      await fs.mkdir(path.dirname(qmdIndexPath), { recursive: true });
      await fs.mkdir(sessionExportDir, { recursive: true });
      await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "secret root memory", "utf-8");
      await fs.writeFile(path.join(memoryDir, "one.md"), "secret transcript one", "utf-8");
      await fs.writeFile(
        path.join(memoryDir, "nested", "two.md"),
        "secret transcript two",
        "utf-8",
      );
      await fs.writeFile(path.join(memoryDir, "ignored.txt"), "secret ignored", "utf-8");
      await fs.writeFile(qmdIndexPath, "", "utf-8");
      await fs.writeFile(path.join(sessionExportDir, "session.md"), "secret qmd session", "utf-8");

      const cfg = {
        agents: { list: [{ id: "main", default: true, workspace: workspaceDir }] },
        memory: {
          backend: "qmd",
          qmd: {
            paths: [{ path: "memory", name: "session-memory-files" }],
            sessions: { enabled: true, exportDir: sessionExportDir, retentionDays: 14 },
          },
        },
        hooks: {
          internal: {
            enabled: true,
            entries: {
              "session-memory": { enabled: true, messages: 7, llmSlug: false },
            },
          },
        },
        plugins: { slots: { memory: "memory-core" } },
      } satisfies FasedAgentConfig;
      loadConfig.mockReturnValue(cfg);
      resolveAgentWorkspaceDir.mockReturnValue(workspaceDir);

      const registry = createEmptyPluginRegistry();
      registry.plugins.push({
        id: "memory-core",
        name: "Memory (Core)",
        kind: "memory",
        origin: "bundled",
        source: path.join(root, "extensions", "memory-core", "index.js"),
        enabled: true,
        status: "loaded",
        toolNames: ["memory_search", "memory_get"],
        hookNames: [],
        channelIds: [],
        providerIds: [],
        gatewayMethods: [],
        cliCommands: [],
        services: [],
        commands: [],
        httpHandlers: 0,
        hookCount: 0,
        configSchema: true,
      });
      setActivePluginRegistry(registry);

      const close = vi.fn().mockResolvedValue(undefined);
      getMemorySearchManager.mockResolvedValue({
        manager: {
          status: () => ({
            backend: "qmd",
            provider: "qmd",
            model: "qmd",
            requestedProvider: "qmd",
            files: 3,
            chunks: 4,
            dirty: false,
            workspaceDir,
            dbPath: qmdIndexPath,
            sources: ["memory"],
            sourceCounts: [{ source: "memory", files: 3, chunks: 4 }],
          }),
          close,
        },
      });
      const respond = vi.fn();

      await invokeDoctorMemoryInventory(respond);

      expect(getMemorySearchManager).toHaveBeenCalledWith({
        cfg,
        agentId: "main",
        purpose: "status",
      });
      const payload = respond.mock.calls[0]?.[1] as DoctorMemoryInventoryPayload;
      expect(payload.agentId).toBe("main");
      expect(payload.backend.error).toBeUndefined();
      expect(payload.backend).toMatchObject({
        configured: "qmd",
        active: "qmd",
        provider: "qmd",
        files: 3,
        chunks: 4,
      });
      expect(payload.workspace.path).toBe(workspaceDir);
      expect(payload.workspace.memoryRoots.find((entry) => entry.id === "MEMORY.md")).toMatchObject(
        {
          exists: true,
          kind: "file",
          markdownFiles: 1,
        },
      );
      expect(
        payload.workspace.memoryRoots.find((entry) => entry.id === "memory-dir"),
      ).toMatchObject({
        exists: true,
        kind: "directory",
        markdownFiles: 2,
      });
      expect(payload.qmd).toMatchObject({
        enabled: true,
        sessions: {
          enabled: true,
          retentionDays: 14,
          exportDir: {
            exists: true,
            kind: "directory",
            markdownFiles: 1,
          },
        },
      });
      expect(payload.sessionMemory).toMatchObject({
        hookConfigured: true,
        enabled: true,
        messages: 7,
        llmSlug: false,
        memoryDir: {
          markdownFiles: 2,
        },
      });
      expect(payload.memoryPlugin).toMatchObject({
        configuredSlot: "memory-core",
        enabled: true,
        active: {
          id: "memory-core",
          status: "loaded",
          toolNames: ["memory_search", "memory_get"],
        },
      });
      expect(JSON.stringify(payload)).not.toContain("secret transcript");
      expect(JSON.stringify(payload)).not.toContain("secret qmd session");
      expect(close).toHaveBeenCalled();
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.FASED_STATE_DIR;
      } else {
        process.env.FASED_STATE_DIR = previousStateDir;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("honors an explicit agentId for inventory", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-memory-agent-inventory-"));
    const mainWorkspace = path.join(root, "main");
    const researchWorkspace = path.join(root, "research");
    const stateDir = path.join(root, "state");
    const previousStateDir = process.env.FASED_STATE_DIR;
    process.env.FASED_STATE_DIR = stateDir;
    try {
      await fs.mkdir(mainWorkspace, { recursive: true });
      await fs.mkdir(path.join(researchWorkspace, "memory"), { recursive: true });
      await fs.writeFile(path.join(researchWorkspace, "MEMORY.md"), "research memory", "utf-8");
      const cfg = {
        agents: {
          list: [
            { id: "main", default: true, workspace: mainWorkspace },
            { id: "research", workspace: researchWorkspace },
          ],
        },
      } satisfies FasedAgentConfig;
      loadConfig.mockReturnValue(cfg);
      resolveAgentWorkspaceDir.mockImplementation(
        (_: FasedAgentConfig | undefined, agentId?: string) =>
          agentId === "research" ? researchWorkspace : mainWorkspace,
      );
      getMemorySearchManager.mockResolvedValue({ manager: null, error: "not configured" });
      const respond = vi.fn();

      await invokeDoctorMemoryInventory(respond, { agentId: "research" });

      expect(resolveDefaultAgentId).not.toHaveBeenCalled();
      expect(getMemorySearchManager).toHaveBeenCalledWith({
        cfg,
        agentId: "research",
        purpose: "status",
      });
      const payload = respond.mock.calls[0]?.[1] as DoctorMemoryInventoryPayload;
      expect(payload.agentId).toBe("research");
      expect(payload.workspace.path).toBe(researchWorkspace);
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.FASED_STATE_DIR;
      } else {
        process.env.FASED_STATE_DIR = previousStateDir;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("doctor.memory.validate", () => {
  beforeEach(() => {
    loadConfig.mockClear();
    resolveDefaultAgentId.mockClear();
    resolveAgentWorkspaceDir.mockClear();
    getMemorySearchManager.mockReset();
    resetPluginRuntimeStateForTest();
  });

  it("returns read-only validation findings for missing memory artifacts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-memory-validate-"));
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    const previousStateDir = process.env.FASED_STATE_DIR;
    process.env.FASED_STATE_DIR = stateDir;
    try {
      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.writeFile(path.join(workspaceDir, "note.txt"), "secret non-memory content", "utf-8");
      const cfg = {
        agents: { list: [{ id: "main", default: true, workspace: workspaceDir }] },
        memory: {
          backend: "qmd",
          qmd: {
            sessions: { enabled: true, exportDir: path.join(stateDir, "missing-sessions") },
          },
        },
        hooks: {
          internal: {
            enabled: true,
            entries: {
              "session-memory": { enabled: true, messages: 5 },
            },
          },
        },
        plugins: { slots: { memory: "memory-core" } },
      } satisfies FasedAgentConfig;
      loadConfig.mockReturnValue(cfg);
      resolveAgentWorkspaceDir.mockReturnValue(workspaceDir);
      getMemorySearchManager.mockResolvedValue({
        manager: null,
        error: "qmd unavailable",
      });
      const respond = vi.fn();

      await invokeDoctorMemoryValidate(respond);

      const payload = respond.mock.calls[0]?.[1] as DoctorMemoryValidationPayload;
      const codes = payload.findings.map((finding) => finding.code);
      expect(payload.ok).toBe(false);
      expect(payload.summary.errors).toBeGreaterThanOrEqual(1);
      expect(codes).toContain("backend.status.unavailable");
      expect(codes).toContain("workspace.memory.empty");
      expect(codes).toContain("qmd.index.missing");
      expect(codes).toContain("qmd.sessions.exportDir.missing");
      expect(codes).toContain("sessionMemory.memoryDir.missing");
      expect(codes).toContain("plugin.memory.unavailable");
      expect(JSON.stringify(payload)).not.toContain("secret non-memory content");
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.FASED_STATE_DIR;
      } else {
        process.env.FASED_STATE_DIR = previousStateDir;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("doctor.memory.repair.preview", () => {
  beforeEach(() => {
    loadConfig.mockClear();
    resolveDefaultAgentId.mockClear();
    resolveAgentWorkspaceDir.mockClear();
    getMemorySearchManager.mockReset();
    resetPluginRuntimeStateForTest();
  });

  it("returns a dry-run repair plan without writing memory artifacts or reading body content", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-memory-repair-preview-"));
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    const sessionExportDir = path.join(stateDir, "missing-sessions");
    const memoryDir = path.join(workspaceDir, "memory");
    const previousStateDir = process.env.FASED_STATE_DIR;
    process.env.FASED_STATE_DIR = stateDir;
    try {
      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.writeFile(path.join(workspaceDir, "note.txt"), "secret preview content", "utf-8");
      const cfg = {
        agents: { list: [{ id: "main", default: true, workspace: workspaceDir }] },
        memory: {
          backend: "qmd",
          qmd: {
            sessions: { enabled: true, exportDir: sessionExportDir },
          },
        },
        hooks: {
          internal: {
            enabled: true,
            entries: {
              "session-memory": { enabled: true, messages: 5 },
            },
          },
        },
        plugins: { slots: { memory: "memory-core" } },
      } satisfies FasedAgentConfig;
      loadConfig.mockReturnValue(cfg);
      resolveAgentWorkspaceDir.mockReturnValue(workspaceDir);
      getMemorySearchManager.mockResolvedValue({
        manager: null,
        error: "qmd unavailable",
      });
      const respond = vi.fn();

      await invokeDoctorMemoryRepairPreview(respond);

      const payload = respond.mock.calls[0]?.[1] as DoctorMemoryRepairPreviewPayload;
      const proposalsByCode = new Map(
        payload.proposals.map((proposal) => [proposal.sourceCode, proposal]),
      );
      expect(payload.dryRun).toBe(true);
      expect(payload.ok).toBe(false);
      expect(payload.summary.proposals).toBeGreaterThan(0);
      expect(proposalsByCode.get("workspace.MEMORY.md.missing")).toMatchObject({
        action: "create_file",
        dryRun: true,
        wouldMutate: true,
        requiresOperatorWrite: true,
        supported: true,
      });
      expect(proposalsByCode.get("workspace.memory-dir.missing")).toMatchObject({
        action: "create_directory",
        targetPath: memoryDir,
        dryRun: true,
        wouldMutate: true,
      });
      expect(proposalsByCode.get("qmd.index.missing")).toMatchObject({
        action: "rebuild_index",
        supported: true,
      });
      expect(proposalsByCode.get("backend.status.unavailable")).toMatchObject({
        action: "review_backend",
        supported: false,
      });
      expect(await pathExists(path.join(workspaceDir, "MEMORY.md"))).toBe(false);
      expect(await pathExists(memoryDir)).toBe(false);
      expect(await pathExists(sessionExportDir)).toBe(false);
      expect(JSON.stringify(payload)).not.toContain("secret preview content");
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.FASED_STATE_DIR;
      } else {
        process.env.FASED_STATE_DIR = previousStateDir;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}
