import { render } from "lit";
import { describe, expect, it } from "vitest";
import type { SkillStatusEntry } from "../types.ts";
import { renderAgentSkills, renderAgentTools } from "./agents-panels-tools-skills.ts";

function createBaseParams(overrides: Partial<Parameters<typeof renderAgentTools>[0]> = {}) {
  return {
    agentId: "main",
    configForm: {
      agents: {
        list: [{ id: "main", tools: { profile: "full" } }],
      },
    } as Record<string, unknown>,
    configLoading: false,
    configSaving: false,
    configDirty: false,
    toolsCatalogLoading: false,
    toolsCatalogError: null,
    toolsCatalogResult: null,
    toolsEffectiveLoading: false,
    toolsEffectiveError: null,
    toolsEffectiveResult: null,
    runtimeSessionKey: "main",
    runtimeSessionMatchesSelectedAgent: true,
    onProfileChange: () => undefined,
    onOverridesChange: () => undefined,
    onConfigReload: () => undefined,
    onConfigSave: () => undefined,
    ...overrides,
  };
}

function createSkill(name: string): SkillStatusEntry {
  return {
    name,
    description: `${name} skill`,
    source: "workspace",
    filePath: `/tmp/${name}/SKILL.md`,
    baseDir: `/tmp/${name}`,
    skillKey: name.toLowerCase(),
    always: false,
    disabled: false,
    blockedByAllowlist: false,
    eligible: true,
    requirements: { bins: [], env: [], config: [], os: [] },
    missing: { bins: [], env: [], config: [], os: [] },
    configChecks: [],
    install: [],
  };
}

function createSkillsParams(overrides: Partial<Parameters<typeof renderAgentSkills>[0]> = {}) {
  return {
    agentId: "main",
    report: {
      workspaceDir: "/tmp/workspace",
      managedSkillsDir: "/tmp/workspace/skills",
      skills: [createSkill("Wallet"), createSkill("Mining")],
    },
    loading: false,
    error: null,
    activeAgentId: "main",
    configForm: { agents: { list: [{ id: "main" }] } },
    configLoading: false,
    configSaving: false,
    configDirty: false,
    filter: "",
    onFilterChange: () => undefined,
    onRefresh: () => undefined,
    onToggle: () => undefined,
    onClear: () => undefined,
    onNarrowToSelected: () => undefined,
    onDisableAll: () => undefined,
    onConfigReload: () => undefined,
    onConfigSave: () => undefined,
    ...overrides,
  };
}

function createSkillLibraryProps(overrides: Record<string, unknown> = {}) {
  return {
    connected: true,
    loading: false,
    report: null,
    error: null,
    libraryPanel: "skills",
    filter: "",
    statusFilter: "all",
    edits: {},
    envEdits: {},
    configEdits: {},
    busyKey: null,
    messages: {},
    createOpen: false,
    createName: "",
    createDescription: "",
    createAgentId: "main",
    createTemplate: "general",
    createBusy: false,
    createError: null,
    skillEditor: null,
    skillEditorDraft: "",
    skillEditorLoading: false,
    skillEditorSaving: false,
    skillEditorError: null,
    detailKey: null,
    attachAgentId: "main",
    configForm: null,
    clawhubQuery: "",
    clawhubResults: [],
    clawhubSearchLoading: false,
    clawhubSearchError: null,
    clawhubDetail: null,
    clawhubDetailSlug: null,
    clawhubDetailLoading: false,
    clawhubDetailError: null,
    clawhubInstallSlug: null,
    clawhubInstallMessage: null,
    clawhubReview: null,
    clawhubReviewLoading: false,
    clawhubReviewError: null,
    clawhubInstallTarget: "agent:main",
    agentsList: {
      mainKey: "main",
      defaultId: "main",
      agents: [{ id: "main", name: "Assistant" }],
    },
    onLibraryPanelChange: () => undefined,
    onFilterChange: () => undefined,
    onStatusFilterChange: () => undefined,
    onRefresh: () => undefined,
    onToggle: () => undefined,
    onEdit: () => undefined,
    onEnvEdit: () => undefined,
    onConfigEdit: () => undefined,
    onSaveKey: () => undefined,
    onSaveEnv: () => undefined,
    onSaveConfig: () => undefined,
    onInstall: () => undefined,
    onTestSkill: () => undefined,
    onCopyToWorkspace: () => undefined,
    onCreateOpen: () => undefined,
    onCreateClose: () => undefined,
    onCreateDraftChange: () => undefined,
    onCreateSave: () => undefined,
    onOpenEditor: () => undefined,
    onCloseEditor: () => undefined,
    onEditorDraftChange: () => undefined,
    onSaveEditor: () => undefined,
    onDetailOpen: () => undefined,
    onDetailClose: () => undefined,
    onAttachAgentChange: () => undefined,
    onAttachToAgent: () => undefined,
    onOpenAgentSkills: () => undefined,
    onOpenAgentTools: () => undefined,
    onClawHubQueryChange: () => undefined,
    onClawHubDetailOpen: () => undefined,
    onClawHubDetailClose: () => undefined,
    onClawHubInstall: () => undefined,
    onClawHubTargetChange: () => undefined,
    onClawHubUpdatePreview: () => undefined,
    onClawHubReviewClose: () => undefined,
    onClawHubReviewConfirm: () => undefined,
    ...overrides,
  } as unknown as Parameters<typeof renderAgentSkills>[0]["skillsLibrary"];
}

describe("agents tools panel (browser)", () => {
  it("renders per-tool provenance badges and optional marker", async () => {
    const container = document.createElement("div");
    render(
      renderAgentTools(
        createBaseParams({
          toolsCatalogResult: {
            agentId: "main",
            profiles: [
              { id: "minimal", label: "Minimal" },
              { id: "coding", label: "Coding" },
              { id: "messaging", label: "Messaging" },
              { id: "full", label: "Full" },
            ],
            groups: [
              {
                id: "media",
                label: "Media",
                source: "core",
                tools: [
                  {
                    id: "tts",
                    label: "tts",
                    description: "Text-to-speech conversion",
                    source: "core",
                    defaultProfiles: [],
                  },
                ],
              },
              {
                id: "plugin:voice-call",
                label: "voice-call",
                source: "plugin",
                pluginId: "voice-call",
                tools: [
                  {
                    id: "voice_call",
                    label: "voice_call",
                    description: "Voice call tool",
                    source: "plugin",
                    pluginId: "voice-call",
                    optional: true,
                    defaultProfiles: [],
                  },
                ],
              },
            ],
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    const text = container.textContent ?? "";
    expect(text).toContain("core");
    expect(text).toContain("plugin:voice-call");
    expect(text).toContain("optional");
  });

  it("shows fallback warning when runtime catalog fails", async () => {
    const container = document.createElement("div");
    render(
      renderAgentTools(
        createBaseParams({
          toolsCatalogError: "unavailable",
          toolsCatalogResult: null,
        }),
      ),
      container,
    );
    await Promise.resolve();

    expect(container.textContent ?? "").toContain("Could not load runtime tool catalog");
  });

  it("points service credential availability failures to Services", async () => {
    const container = document.createElement("div");
    render(
      renderAgentTools(
        createBaseParams({
          toolsEffectiveError: "web_search unavailable: missing API key",
        }),
      ),
      container,
    );
    await Promise.resolve();

    const text = container.textContent ?? "";
    expect(text).toContain("service connector is missing");
    expect(text).toContain("Open Services");
    expect(text).toContain("web_search unavailable");
  });

  it("points extension runtime availability failures to Extensions", async () => {
    const container = document.createElement("div");
    render(
      renderAgentTools(
        createBaseParams({
          toolsEffectiveError: "plugin voice-call runtime is not loaded",
        }),
      ),
      container,
    );
    await Promise.resolve();

    const text = container.textContent ?? "";
    expect(text).toContain("extension runtime is missing");
    expect(text).toContain("Open Extensions");
    expect(text).toContain("voice-call runtime");
  });

  it("renders effective runtime tools separately from the config catalog", async () => {
    const container = document.createElement("div");
    render(
      renderAgentTools(
        createBaseParams({
          toolsEffectiveResult: {
            agentId: "main",
            profile: "messaging",
            groups: [
              {
                id: "channel",
                label: "Channel tools",
                source: "channel",
                tools: [
                  {
                    id: "message",
                    label: "Message Actions",
                    description: "Send and manage messages in this channel",
                    rawDescription: "Send and manage messages in this channel",
                    source: "channel",
                    channelId: "discord",
                  },
                ],
              },
            ],
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    const text = container.textContent ?? "";
    expect(text).toContain("Available Right Now");
    expect(text).toContain("Message Actions");
    expect(text).toContain("Channel: discord");
  });

  it("collapses runtime availability and catalog tool groups by default", async () => {
    const container = document.createElement("div");
    render(
      renderAgentTools(
        createBaseParams({
          toolsCatalogResult: {
            agentId: "main",
            profiles: [{ id: "full", label: "Full" }],
            groups: [
              {
                id: "core",
                label: "Core",
                source: "core",
                tools: [
                  {
                    id: "common.reloadConfig",
                    label: "common.reloadConfig",
                    description: "Reload config",
                    source: "core",
                    defaultProfiles: ["full"],
                  },
                  {
                    id: "read_file",
                    label: "Read File",
                    description: "Read from workspace",
                    source: "core",
                    defaultProfiles: ["full"],
                  },
                ],
              },
            ],
          },
          toolsEffectiveResult: {
            agentId: "main",
            profile: "full",
            groups: [
              {
                id: "runtime",
                label: "Runtime",
                source: "core",
                tools: [
                  {
                    id: "runtime.tool",
                    label: "Runtime Tool",
                    description: "Loaded in this session",
                    rawDescription: "Loaded in this session",
                    source: "core",
                  },
                ],
              },
            ],
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    expect(container.textContent ?? "").not.toContain("common.reloadConfig");
    const runtime = container.querySelector<HTMLDetailsElement>(
      "details.agent-tools-section-details--runtime",
    );
    expect(runtime).toBeTruthy();
    expect(runtime?.open).toBe(false);
    expect(runtime?.querySelector(".agent-pill")?.textContent?.trim()).toBe("1 tools");

    const sections = Array.from(
      container.querySelectorAll<HTMLDetailsElement>("details.agent-tools-section-details"),
    );
    expect(sections.length).toBeGreaterThanOrEqual(2);
    expect(sections.every((section) => !section.open)).toBe(true);

    const catalogSummary = Array.from(
      container.querySelectorAll("summary.agent-tools-section-summary"),
    ).find((entry) => entry.textContent?.includes("Core"));
    expect(catalogSummary?.textContent ?? "").toContain("1/1");
  });

  it("shows compact Agent skill access counters", async () => {
    const inherited = document.createElement("div");
    render(renderAgentSkills(createSkillsParams()), inherited);
    await Promise.resolve();

    expect(inherited.textContent ?? "").toContain("2/2 allowed");
    expect(inherited.textContent ?? "").toContain("Inherits all library skills");
    expect(inherited.textContent ?? "").toContain("All(2)");
    expect(inherited.textContent ?? "").toContain("Ready(2)");
    expect(inherited.textContent ?? "").not.toContain("Narrow selected");
    expect(inherited.textContent ?? "").not.toContain("Allow all");
    expect(inherited.textContent ?? "").not.toContain("shown");
    expect(
      Array.from(inherited.querySelectorAll("button")).some(
        (button) => button.textContent?.trim() === "Enable all",
      ),
    ).toBe(true);
    expect(
      Array.from(inherited.querySelectorAll("button")).some(
        (button) => button.textContent?.trim() === "Disable all",
      ),
    ).toBe(true);

    const selected = document.createElement("div");
    render(
      renderAgentSkills(
        createSkillsParams({
          configForm: { agents: { list: [{ id: "main", skills: ["Wallet"] }] } },
        }),
      ),
      selected,
    );
    await Promise.resolve();
    expect(selected.textContent ?? "").toContain("1/2 allowed");

    const disabled = document.createElement("div");
    render(
      renderAgentSkills(
        createSkillsParams({
          configForm: { agents: { list: [{ id: "main", skills: [] }] } },
        }),
      ),
      disabled,
    );
    await Promise.resolve();
    expect(disabled.textContent ?? "").toContain("0/2 allowed");
    expect(disabled.textContent ?? "").toContain("No skills are allowed");
  });

  it("opens the shared skill detail flow from Agent Skills", async () => {
    const opened: string[] = [];
    const container = document.createElement("div");
    render(
      renderAgentSkills(
        createSkillsParams({
          onOpenSkillDetail: (skillKey) => opened.push(skillKey),
        }),
      ),
      container,
    );
    await Promise.resolve();

    const row = container.querySelector<HTMLElement>('[data-testid="agent-skill-row-wallet"]');
    expect(row).toBeTruthy();
    row?.click();

    expect(opened).toEqual(["wallet"]);
  });

  it("keeps Agent Skills as one Agent-scoped list and moves ClawHub into the tab", async () => {
    const panelChanges: string[] = [];
    const container = document.createElement("div");
    render(
      renderAgentSkills(
        createSkillsParams({
          skillsLibrary: createSkillLibraryProps({
            onLibraryPanelChange: (panel: string) => panelChanges.push(panel),
          }),
        }),
      ),
      container,
    );
    await Promise.resolve();

    expect(container.querySelectorAll('[data-testid^="agent-skill-row-"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-testid^="skill-row-"]')).toHaveLength(0);

    Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "ClawHub")
      ?.click();
    expect(panelChanges).toEqual(["clawhub"]);

    render(
      renderAgentSkills(
        createSkillsParams({
          skillsLibrary: createSkillLibraryProps({ libraryPanel: "clawhub" }),
        }),
      ),
      container,
    );
    await Promise.resolve();

    expect(container.querySelectorAll('[data-testid^="agent-skill-row-"]')).toHaveLength(0);
    expect(container.textContent ?? "").not.toContain("Install target Assistant");
    expect(container.textContent ?? "").not.toContain(
      "Search, review, and install skills for this Agent.",
    );
    expect(container.querySelector<HTMLInputElement>('input[name="clawhub-search"]')).toBeTruthy();
  });
});
