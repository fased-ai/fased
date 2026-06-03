import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { SkillStatusEntry, SkillStatusReport } from "../types.ts";
import { renderSkills, type SkillsProps } from "./skills.ts";

function text(node: Element | DocumentFragment): string {
  return node.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

function createSkill(overrides: Partial<SkillStatusEntry> = {}): SkillStatusEntry {
  return {
    name: "Repo Skill",
    description: "Skill description",
    source: "workspace",
    filePath: "/tmp/skill/SKILL.md",
    baseDir: "/tmp/skill",
    skillKey: "repo-skill",
    bundled: false,
    primaryEnv: undefined,
    emoji: undefined,
    homepage: undefined,
    always: false,
    disabled: false,
    blockedByAllowlist: false,
    eligible: true,
    requirements: { bins: [], env: [], config: [], os: [] },
    missing: { bins: [], env: [], config: [], os: [] },
    configChecks: [],
    install: [],
    ...overrides,
  };
}

function createProps(overrides: Partial<SkillsProps> = {}): SkillsProps {
  const report: SkillStatusReport = {
    workspaceDir: "/tmp/workspace",
    managedSkillsDir: "/tmp/skills",
    skills: [createSkill()],
  };
  return {
    connected: true,
    loading: false,
    report,
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
    createAgentId: "",
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
    clawhubResults: null,
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
    clawhubInstallTarget: "default-agent",
    agentsList: {
      defaultId: "main",
      mainKey: "main",
      scope: "test",
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
    onSaveRootConfig: () => undefined,
    onClawHubQueryChange: () => undefined,
    onClawHubDetailOpen: () => undefined,
    onClawHubDetailClose: () => undefined,
    onClawHubInstall: () => undefined,
    onClawHubTargetChange: () => undefined,
    onClawHubUpdatePreview: () => undefined,
    onClawHubReviewClose: () => undefined,
    onClawHubReviewConfirm: () => undefined,
    ...overrides,
  };
}

describe("skills view browser", () => {
  it("shows the install plan and exposes a Test skill action in the skill modal", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const onTestSkill = vi.fn();
    render(
      renderSkills(
        createProps({
          detailKey: "repo-skill",
          onTestSkill,
          report: {
            workspaceDir: "/tmp/workspace",
            managedSkillsDir: "/tmp/skills",
            skills: [
              createSkill({
                missing: { bins: ["mcporter"], env: [], config: [], os: [] },
                install: [
                  {
                    id: "node",
                    kind: "node",
                    label: "Install mcporter (npm)",
                    bins: ["mcporter"],
                    external: true,
                    pinned: false,
                    integrityPinned: false,
                    trustWarnings: [],
                    plan: {
                      manager: "npm",
                      packageRef: "mcporter",
                      command: ["npm", "install", "-g", "--ignore-scripts", "mcporter"],
                      commandPreview: "npm install -g --ignore-scripts mcporter",
                      toolchainAvailable: true,
                      pathTargets: ["/home/fc/.npm-global/bin/mcporter"],
                      bins: [
                        {
                          bin: "mcporter",
                          available: false,
                          pathTargets: ["/home/fc/.npm-global/bin/mcporter"],
                        },
                      ],
                    },
                  },
                ],
              }),
            ],
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    expect(text(container)).toContain("Install plan");
    expect(text(container)).toContain("npm install -g --ignore-scripts mcporter");
    container.querySelector<HTMLButtonElement>('[data-testid="skill-test-repo-skill"]')?.click();
    expect(onTestSkill).toHaveBeenCalledWith("repo-skill", "Repo Skill");

    render(null, container);
    container.remove();
  });
});
