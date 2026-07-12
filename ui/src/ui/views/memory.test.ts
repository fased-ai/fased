import { describe, expect, it, vi } from "vitest";

type LitTemplateLike = {
  strings?: ArrayLike<string>;
  values?: unknown[];
};

function flattenTemplateText(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((entry) => flattenTemplateText(entry)).join(" ");
  }
  if (value && typeof value === "object") {
    const template = value as LitTemplateLike;
    if (template.strings && Array.isArray(template.values)) {
      return [
        ...Array.from(template.strings),
        ...template.values.map((entry) => flattenTemplateText(entry)),
      ].join(" ");
    }
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  return "";
}

function buildProps() {
  return {
    loading: false,
    error: null,
    inventory: {
      agentId: "main",
      workspace: {
        path: "/tmp/fased/main",
        exists: true,
        memoryRoots: [
          {
            id: "MEMORY.md",
            path: "/tmp/fased/main/MEMORY.md",
            exists: true,
            kind: "file",
          },
          {
            id: "memory.md",
            path: "/tmp/fased/main/memory.md",
            exists: false,
            kind: "missing",
          },
          {
            id: "memory-dir",
            path: "/tmp/fased/main/memory",
            exists: true,
            kind: "directory",
            markdownFiles: 3,
          },
        ],
      },
      backend: {
        configured: "builtin",
        active: "builtin",
        citations: "auto",
        files: 2,
        chunks: 8,
      },
      qmd: {
        enabled: true,
        collections: [
          {
            name: "memory",
            pattern: "memory/**/*.md",
            collectionKind: "memory",
            path: "/tmp/fased/main/memory",
            exists: true,
            kind: "directory",
          },
        ],
        sessions: { enabled: true },
      },
      sessionMemory: {
        hookConfigured: true,
        enabled: true,
        messages: 24,
        llmSlug: false,
        memoryDir: {
          path: "/tmp/fased/main/memory",
          exists: true,
          kind: "directory",
          markdownFiles: 3,
        },
        filenameDiagnostics: {
          checked: true,
          status: "suffixes-present",
          groups: [
            {
              stem: "2026-05-07-1240",
              state: "collision-suffixed",
              files: [
                { name: "2026-05-07-1240.md", suffix: 0 },
                { name: "2026-05-07-1240-1.md", suffix: 1 },
              ],
            },
          ],
        },
      },
      memoryPlugin: {
        configuredSlot: null,
        enabled: false,
        registryLoaded: true,
        reason: "No active memory plugin loaded.",
      },
    },
    agentsList: {
      defaultId: "main",
      mainKey: "main",
      scope: "test",
      agents: [
        { id: "main", name: "Assistant" },
        { id: "research", name: "Research" },
      ],
    },
    selectedAgentId: "main",
    validation: {
      agentId: "main",
      ok: false,
      summary: { errors: 0, warnings: 1, info: 1 },
      findings: [
        {
          severity: "warn",
          code: "session-memory.suffixes-present",
          area: "session-memory",
          message: "Suffixed session archives are present.",
        },
      ],
    },
    dreamingStatusLoading: false,
    dreamingStatusError: null,
    dreamingStatus: {
      enabled: true,
      verboseLogging: false,
      storageMode: "inline",
      separateReports: false,
      shortTermCount: 4,
      recallSignalCount: 2,
      dailySignalCount: 1,
      totalSignalCount: 7,
      phaseSignalCount: 3,
      lightPhaseHitCount: 1,
      remPhaseHitCount: 1,
      promotedTotal: 2,
      promotedToday: 1,
      phases: {
        light: {
          enabled: true,
          cron: "0 * * * *",
          managedCronPresent: true,
          lookbackDays: 2,
          limit: 10,
        },
        deep: {
          enabled: true,
          cron: "0 2 * * *",
          managedCronPresent: true,
          limit: 10,
          minScore: 0.5,
          minRecallCount: 1,
          minUniqueQueries: 1,
          recencyHalfLifeDays: 7,
        },
        rem: {
          enabled: true,
          cron: "0 4 * * *",
          managedCronPresent: true,
          lookbackDays: 7,
          limit: 10,
          minPatternStrength: 0.5,
        },
      },
    },
    dreamDiaryLoading: false,
    dreamDiaryError: null,
    dreamDiaryPath: "DREAMS.md",
    dreamDiaryContent: "# Dream Diary\n\n*May 7, 2026*\n\nMemory links were organized.",
    onSelectAgent: vi.fn(),
    onRefresh: vi.fn(),
    onOpenDebug: vi.fn(),
  };
}

describe("renderMemory", () => {
  it("shows user-facing memory controls without exposing repair execution", async () => {
    const { renderMemory } = await import("./memory.ts");
    const text = flattenTemplateText(renderMemory(buildProps() as never));

    expect(text).toContain("Memory overview");
    expect(text).toContain("Agent-owned archive controls live in Agent > Memory.");
    expect(text).toContain("Agent");
    expect(text).toContain("Assistant");
    expect(text).toContain("Research");
    expect(text).toContain("Session Archives");
    expect(text).toContain("Semantic Recall");
    expect(text).toContain("FTS only");
    expect(text).toContain("Enabled");
    expect(text).toContain("Citations");
    expect(text).toContain("QMD");
    expect(text).toContain("Workspace memory roots");
    expect(text).toContain("optional legacy root not present");
    expect(text).toContain("optional");
    expect(text).toContain("2026-05-07-1240-1.md");
    expect(text).not.toContain("Dream Diary");
    expect(text).not.toContain("Memory links were organized.");
    expect(text).toContain("Repair preview and repair execution remain in Debug");
    expect(text).not.toContain("doctor.memory.repair.execute");
    expect(text).not.toContain("doctor.memory.dreamDiary");
  });
});
