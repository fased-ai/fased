/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SkillStatusEntry, SkillStatusReport } from "../types.ts";
import { renderSkills, type SkillsProps } from "./skills.ts";

const dialogRestores: Array<() => void> = [];

function normalizeText(node: Element | DocumentFragment): string {
  return node.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

function createSkill(overrides: Partial<SkillStatusEntry> = {}): SkillStatusEntry {
  return {
    name: "Repo Skill",
    description: "Skill description",
    source: "workspace",
    filePath: "/tmp/skill",
    baseDir: "/tmp",
    skillKey: "repo-skill",
    bundled: false,
    primaryEnv: "OPENAI_API_KEY",
    emoji: undefined,
    homepage: "https://example.com",
    always: false,
    disabled: false,
    blockedByAllowlist: false,
    eligible: true,
    requirements: {
      bins: [],
      env: [],
      config: [],
      os: [],
    },
    missing: {
      bins: [],
      env: [],
      config: [],
      os: [],
    },
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
    configForm: { agents: { list: [{ id: "main", skills: ["Other Skill"] }] } },
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
      agents: [
        { id: "main", name: "Assistant" },
        { id: "research", name: "Research" },
      ],
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
  };
}

describe("renderSkills", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    while (dialogRestores.length > 0) {
      dialogRestores.pop()?.();
    }
  });

  it("opens the skill detail dialog as a modal", async () => {
    const container = document.createElement("div");
    const showModal = vi.fn(function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    });
    installDialogMethod("showModal", showModal);

    render(
      renderSkills(
        createProps({
          detailKey: "repo-skill",
        }),
      ),
      container,
    );
    await Promise.resolve();

    expect(showModal).toHaveBeenCalledTimes(1);
    expect(container.querySelector("dialog")?.hasAttribute("open")).toBe(true);
    const text = normalizeText(container);
    expect(text).toContain("Agent use");
    expect(text).toContain("Agent skills");
    expect(text).toContain("Tool grants");
  });

  it("renders a ClawHub install target selector with Agent names", () => {
    const container = document.createElement("div");
    const onTargetChange = vi.fn();

    render(
      renderSkills(
        createProps({
          libraryPanel: "clawhub",
          clawhubInstallTarget: "agent:research",
          onClawHubTargetChange: onTargetChange,
        }),
      ),
      container,
    );

    const select = container.querySelector<HTMLSelectElement>(
      '[data-testid="clawhub-install-target"]',
    );
    expect(select?.value).toBe("agent:research");
    expect(normalizeText(container)).toContain("Shared library - reusable");
    expect(normalizeText(container)).toContain("Research");
    expect(normalizeText(container)).not.toContain("Research workspace");

    select!.value = "shared";
    select!.dispatchEvent(new Event("change"));

    expect(onTargetChange).toHaveBeenCalledWith("shared");
  });

  it("renders ClawHub marketplace safety status in skill details", async () => {
    const container = document.createElement("div");
    installDialogMethod("showModal", function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    });

    render(
      renderSkills(
        createProps({
          detailKey: "repo-skill",
          report: {
            workspaceDir: "/tmp/workspace",
            managedSkillsDir: "/tmp/skills",
            skills: [
              createSkill({
                marketplace: {
                  source: "clawhub",
                  registry: "https://clawhub.com",
                  slug: "repo-skill",
                  installedVersion: "1.2.3",
                  installedAt: 1_700_000_000,
                  requestedRisky: true,
                  requestedWalletActions: true,
                  requestedToolAccess: ["web.fetch"],
                  requestedInstallKinds: ["node"],
                  scanBlocked: false,
                  scanWarnings: 1,
                  scanBlocks: 0,
                  updateApprovalRequired: true,
                  updateReviewReasons: ["permission digest changed"],
                },
              }),
            ],
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    const text = normalizeText(container);
    expect(text).toContain("ClawHub marketplace review");
    expect(text).toContain("repo-skill v1.2.3");
    expect(text).toContain("wallet actions");
    expect(text).toContain("tools: web.fetch");
    expect(text).toContain("Archive scan: 1 warning");
    expect(text).toContain("approval required: permission digest changed");
    expect(text).toContain("Review update");
  });

  it("shows dependency install plan and runs the Test skill action from the detail modal", async () => {
    const container = document.createElement("div");
    const onTestSkill = vi.fn();
    installDialogMethod("showModal", function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    });

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
                missing: {
                  bins: ["mcporter"],
                  env: [],
                  config: [],
                  os: [],
                },
                install: [
                  {
                    id: "node",
                    kind: "node",
                    label: "Install mcporter (npm)",
                    bins: ["mcporter"],
                    external: true,
                    pinned: false,
                    integrityPinned: false,
                    trustWarnings: ["package version is not pinned to an exact immutable version"],
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

    const text = normalizeText(container);
    expect(text).toContain("Install plan");
    expect(text).toContain("npm install -g --ignore-scripts mcporter");
    expect(text).toContain("missing from gateway PATH");

    container.querySelector<HTMLButtonElement>('[data-testid="skill-test-repo-skill"]')?.click();
    expect(onTestSkill).toHaveBeenCalledWith("repo-skill", "Repo Skill");
  });

  it("renders external package trust warnings before dependency install", async () => {
    const container = document.createElement("div");
    installDialogMethod("showModal", function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    });

    render(
      renderSkills(
        createProps({
          detailKey: "repo-skill",
          report: {
            workspaceDir: "/tmp/workspace",
            managedSkillsDir: "/tmp/skills",
            skills: [
              createSkill({
                eligible: false,
                primaryEnv: undefined,
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
                    trustWarnings: [
                      "external package manager install: review the npm package source before running",
                      "package version is not pinned to an exact immutable version",
                      "source integrity is not pinned with integrity, sha256, or shasum metadata",
                    ],
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

    const text = normalizeText(container);
    expect(text).toContain("External package trust");
    expect(text).toContain("Unpinned version");
    expect(text).toContain("No integrity pin");
    expect(text).toContain("does not grant Agent tools");
  });

  it("shows Agent attachment controls in skill details", async () => {
    const container = document.createElement("div");
    const onAttach = vi.fn();
    installDialogMethod("showModal", function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    });

    render(
      renderSkills(
        createProps({
          detailKey: "repo-skill",
          onAttachToAgent: onAttach,
        }),
      ),
      container,
    );
    await Promise.resolve();

    const text = normalizeText(container);
    expect(text).toContain("Agent Skills");
    expect(text).toContain("Allow Assistant to use this skill");

    container.querySelector<HTMLButtonElement>(".md-preview-dialog__body .btn.primary")?.click();
    expect(onAttach).toHaveBeenCalledWith("repo-skill", "main");
  });

  it("opens a create skill modal for workspace skills", async () => {
    const container = document.createElement("div");
    const onDraft = vi.fn();
    const onSave = vi.fn();
    installDialogMethod("showModal", function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    });

    render(
      renderSkills(
        createProps({
          createOpen: true,
          createName: "Research Helper",
          createDescription: "Use for source review.",
          createAgentId: "research",
          onCreateDraftChange: onDraft,
          onCreateSave: onSave,
        }),
      ),
      container,
    );
    await Promise.resolve();

    expect(normalizeText(container)).toContain("Create skill");
    expect(container.querySelector("dialog")?.hasAttribute("open")).toBe(true);
    expect(normalizeText(container)).toContain("Save in Agent");
    expect(normalizeText(container)).not.toContain("Assistant workspace");
    expect(
      container.querySelector<HTMLInputElement>('input[placeholder="Research helper"]')?.value,
    ).toBe("Research Helper");

    container.querySelector<HTMLButtonElement>(".md-preview-dialog__body .btn.primary")?.click();
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("renders skill env and typed config controls", async () => {
    const container = document.createElement("div");
    const onEnvEdit = vi.fn();
    const onConfigEdit = vi.fn();
    const onSaveEnv = vi.fn();
    const onSaveConfig = vi.fn();
    installDialogMethod("showModal", function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    });

    render(
      renderSkills(
        createProps({
          detailKey: "repo-skill",
          onEnvEdit,
          onConfigEdit,
          onSaveEnv,
          onSaveConfig,
          configForm: {
            skills: {
              entries: {
                "repo-skill": {
                  env: { EXTRA_TOKEN: "saved" },
                  config: { mode: "strict" },
                },
              },
            },
          },
          report: {
            workspaceDir: "/tmp/workspace",
            managedSkillsDir: "/tmp/skills",
            skills: [
              createSkill({
                requirements: {
                  bins: [],
                  env: ["OPENAI_API_KEY", "EXTRA_TOKEN"],
                  config: ["skills.entries.repo-skill.config.mode"],
                  os: [],
                },
                configChecks: [{ path: "skills.entries.repo-skill.config.mode", satisfied: true }],
              }),
            ],
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    const text = normalizeText(container);
    expect(text).toContain("Skill config");
    expect(text).toContain("EXTRA_TOKEN");
    expect(text).toContain("Typed config");
    expect(text).toContain("Advanced JSON");
    expect(text).toContain("skills.entries.repo-skill.config.mode ok");

    const envInput = Array.from(container.querySelectorAll<HTMLInputElement>("input")).find(
      (input) => input.placeholder === "Saved in config",
    );
    envInput!.value = "next";
    envInput!.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onEnvEdit).toHaveBeenCalledWith("repo-skill", "EXTRA_TOKEN", "next");

    const modeInput = Array.from(container.querySelectorAll<HTMLInputElement>("input")).find(
      (input) => input.value === "strict",
    );
    modeInput!.value = "loose";
    modeInput!.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onConfigEdit).toHaveBeenCalledWith("repo-skill", '{\n  "mode": "loose"\n}');

    const textarea = Array.from(container.querySelectorAll<HTMLTextAreaElement>("textarea")).find(
      (candidate) => candidate.value.includes('"mode"'),
    );
    textarea!.value = '{"mode":"loose"}';
    textarea!.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onConfigEdit).toHaveBeenCalledWith("repo-skill", '{"mode":"loose"}');

    Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Save env"))
      ?.click();
    Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Save config"))
      ?.click();
    expect(onSaveEnv).toHaveBeenCalledWith("repo-skill");
    expect(onSaveConfig).toHaveBeenCalledWith("repo-skill");
  });

  it("renders skills with status dots instead of emoji glyphs", () => {
    const container = document.createElement("div");
    render(
      renderSkills(
        createProps({
          report: {
            workspaceDir: "/tmp/workspace",
            managedSkillsDir: "/tmp/skills",
            skills: [
              createSkill({
                name: "1password",
                skillKey: "1password",
                emoji: "🔐",
              }),
            ],
          },
        }),
      ),
      container,
    );

    const title = container.querySelector(".list-title");
    expect(title?.textContent).toContain("1password");
    expect(title?.textContent).not.toContain("🔐");
    expect(title?.querySelector(".statusDot")).not.toBeNull();
  });

  it("renders clear readiness states and simple fix actions", () => {
    const container = document.createElement("div");
    const onDetailOpen = vi.fn();
    const onInstall = vi.fn();
    const onToggle = vi.fn();

    render(
      renderSkills(
        createProps({
          onDetailOpen,
          onInstall,
          onToggle,
          report: {
            workspaceDir: "/tmp/workspace",
            managedSkillsDir: "/tmp/skills",
            skills: [
              createSkill({
                name: "Bundled Ready",
                skillKey: "bundled-ready",
                bundled: true,
                source: "fased-bundled",
                primaryEnv: undefined,
              }),
              createSkill({
                name: "Needs API",
                skillKey: "needs-api",
                eligible: false,
                missing: { bins: [], env: ["OPENAI_API_KEY"], config: [], os: [] },
              }),
              createSkill({
                name: "Needs Dependency",
                skillKey: "needs-dependency",
                eligible: false,
                primaryEnv: undefined,
                missing: { bins: ["gh"], env: [], config: [], os: [] },
                install: [{ id: "node", kind: "node", label: "Install gh", bins: ["gh"] }],
              }),
              createSkill({
                name: "Needs Config",
                skillKey: "needs-config",
                eligible: false,
                primaryEnv: undefined,
                missing: { bins: [], env: [], config: ["token"], os: [] },
              }),
              createSkill({
                name: "Disabled Skill",
                skillKey: "disabled-skill",
                disabled: true,
                eligible: false,
                primaryEnv: undefined,
              }),
              createSkill({
                name: "ClawHub Skill",
                skillKey: "clawhub-skill",
                primaryEnv: undefined,
                marketplace: {
                  source: "clawhub",
                  registry: "https://clawhub.com",
                  slug: "clawhub-skill",
                  installedVersion: "1.0.0",
                  installedAt: 1,
                  requestedRisky: true,
                  requestedWalletActions: false,
                  requestedToolAccess: [],
                  requestedInstallKinds: [],
                  scanBlocked: false,
                  scanWarnings: 2,
                  scanBlocks: 0,
                  updateApprovalRequired: true,
                  updateReviewReasons: ["permission digest changed"],
                },
              }),
            ],
          },
        }),
      ),
      container,
    );

    const installedText =
      container.querySelector(".skills-card")?.textContent?.replace(/\s+/g, " ").trim() ?? "";
    expect(installedText).toContain("bundled");
    expect(installedText).toContain("Ready");
    expect(installedText).toContain("Needs API key");
    expect(installedText).toContain("Needs dependency");
    expect(installedText).toContain("Needs config");
    expect(installedText).toContain("Hidden");
    expect(installedText).toContain("Add API key");
    expect(installedText).toContain("Install dependency");
    expect(installedText).toContain("Configure");
    expect(installedText).toContain("Show in library");
    expect(installedText).not.toContain("Archive scan");
    expect(installedText).not.toContain("scan warning");

    const buttons = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".skills-card button"),
    );
    buttons.find((button) => button.textContent?.includes("Add API key"))?.click();
    buttons.find((button) => button.textContent?.includes("Install dependency"))?.click();
    buttons.find((button) => button.textContent?.includes("Configure"))?.click();
    buttons.find((button) => button.textContent?.includes("Show in library"))?.click();

    expect(onDetailOpen).toHaveBeenCalledWith("needs-api");
    expect(onDetailOpen).toHaveBeenCalledWith("needs-dependency");
    expect(onDetailOpen).toHaveBeenCalledWith("needs-config");
    expect(onInstall).not.toHaveBeenCalled();
    expect(onToggle).toHaveBeenCalledWith("disabled-skill", true);
  });

  it("closes the skill detail dialog through the dialog close event", async () => {
    const container = document.createElement("div");
    const onDetailClose = vi.fn();

    installDialogMethod("showModal", function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    });
    installDialogMethod("close", function (this: HTMLDialogElement) {
      this.removeAttribute("open");
      this.dispatchEvent(new Event("close"));
    });

    render(
      renderSkills(
        createProps({
          detailKey: "repo-skill",
          onDetailClose,
        }),
      ),
      container,
    );
    await Promise.resolve();

    container.querySelector<HTMLButtonElement>(".md-preview-dialog__header .btn")?.click();

    expect(onDetailClose).toHaveBeenCalledTimes(1);
  });

  it("renders ClawHub search results and routes detail/review actions", async () => {
    const container = document.createElement("div");
    const onClawHubDetailOpen = vi.fn();
    const onClawHubInstall = vi.fn();

    render(
      renderSkills(
        createProps({
          libraryPanel: "clawhub",
          clawhubQuery: "git",
          clawhubResults: [
            {
              score: 0.95,
              slug: "github",
              displayName: "GitHub",
              summary: "GitHub integration for FasedAgent",
              version: "1.2.3",
            },
          ],
          onClawHubDetailOpen,
          onClawHubInstall,
        }),
      ),
      container,
    );
    await Promise.resolve();

    const text = normalizeText(container);
    expect(text).toContain("GitHub");
    expect(text).toContain("GitHub integration for FasedAgent");
    expect(text).toContain("v1.2.3");
    expect(text).toContain("Review");
    expect(text).toContain("Click for details");

    container.querySelector<HTMLElement>(".skills-results-list .list-item")?.click();
    container
      .querySelector<HTMLButtonElement>(".skills-results-list .list-item .btn.btn--sm")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onClawHubDetailOpen).toHaveBeenCalledTimes(1);
    expect(onClawHubDetailOpen).toHaveBeenCalledWith("github");
    expect(onClawHubInstall).toHaveBeenCalledTimes(1);
    expect(onClawHubInstall).toHaveBeenCalledWith("github");
  });

  it("opens the ClawHub detail dialog and renders install feedback", async () => {
    const container = document.createElement("div");
    const showModal = vi.fn(function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    });
    const onClawHubInstall = vi.fn();
    installDialogMethod("showModal", showModal);

    render(
      renderSkills(
        createProps({
          clawhubSearchError: "rate limited",
          clawhubInstallMessage: { kind: "success", text: "Installed github" },
          clawhubDetailSlug: "github",
          clawhubDetail: {
            skill: {
              slug: "github",
              displayName: "GitHub",
              summary: "GitHub integration for FasedAgent",
              createdAt: 1_700_000_000,
              updatedAt: 1_700_000_100,
            },
            latestVersion: {
              version: "1.2.3",
              createdAt: 1_700_000_200,
              changelog: "Added search support",
            },
            metadata: {
              os: ["macos", "linux"],
            },
            owner: {
              displayName: "FasedAgent",
              handle: "fased",
            },
          },
          onClawHubInstall,
        }),
      ),
      container,
    );
    await Promise.resolve();

    expect(showModal).toHaveBeenCalledTimes(1);
    const text = normalizeText(container);
    expect(text).toContain("rate limited");
    expect(text).toContain("Installed github");
    expect(text).toContain("By FasedAgent (@fased)");
    expect(text).toContain("Latest: v1.2.3");
    expect(text).toContain("Platforms: macos, linux");
    expect(text).toContain("Added search support");
    expect(text).toContain("Review install for GitHub");

    container
      .querySelector<HTMLButtonElement>(".md-preview-dialog__body .btn.primary")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onClawHubInstall).toHaveBeenCalledTimes(1);
    expect(onClawHubInstall).toHaveBeenCalledWith("github");
  });

  it("renders ClawHub permission review before install", async () => {
    const container = document.createElement("div");
    const showModal = vi.fn(function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    });
    const onClawHubReviewConfirm = vi.fn();
    installDialogMethod("showModal", showModal);

    render(
      renderSkills(
        createProps({
          clawhubReview: {
            ok: true,
            mode: "install",
            slug: "github",
            version: "1.2.3",
            targetDir: "/tmp/workspace/skills/github",
            sourceTrust: {
              registry: "https://clawhub.com",
              trusted: true,
              mode: "allowlist",
              allowlist: ["https://clawhub.com"],
            },
            permissions: {
              version: 1,
              risky: true,
              digest: "abcdef1234567890",
              walletActions: {
                actions: ["quote", "swap"],
                roles: ["agent"],
                chains: ["solana"],
                maxSlippageBps: 50,
              },
              toolAccess: ["web.fetch"],
            },
            installScan: {
              version: 1,
              fileCount: 3,
              totalBytes: 2048,
              files: ["SKILL.md", "package.json", "src/index.ts"],
              blocked: false,
              findings: [
                {
                  severity: "warn",
                  code: "dependency_manifest",
                  path: "package.json",
                  message: "dependency manifest present",
                },
              ],
            },
            updateReview: {
              version: 1,
              approvalRequired: false,
              reasons: [],
              permissionDigestChanged: true,
              nextPermissionDigest: "abcdef1234567890",
              addedScanFindings: [],
            },
          },
          onClawHubReviewConfirm,
        }),
      ),
      container,
    );
    await Promise.resolve();

    const text = normalizeText(container);
    expect(text).toContain("Install github");
    expect(text).toContain("Source trust");
    expect(text).toContain("https://clawhub.com");
    expect(text).toContain("registry allowlist");
    expect(text).toContain("wallet: actions quote, swap");
    expect(text).toContain("tools: web.fetch");
    expect(text).toContain("SKILL.md");
    expect(text).toContain("src/index.ts");
    expect(text).toContain("Warning: dependency_manifest");
    expect(text).toContain("Dependency/script policy");
    expect(text).toContain("dependency manifests 1");
    expect(text).toContain("script files 0");

    container
      .querySelector<HTMLButtonElement>(".md-preview-dialog__body .btn.primary")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onClawHubReviewConfirm).toHaveBeenCalledTimes(1);
  });

  it("disables review confirmation when archive scan blocks install", async () => {
    const container = document.createElement("div");
    installDialogMethod("showModal", function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    });

    render(
      renderSkills(
        createProps({
          clawhubReview: {
            ok: true,
            mode: "install",
            slug: "blocked",
            version: "1.0.0",
            targetDir: "/tmp/workspace/skills/blocked",
            permissions: { version: 1, risky: false, digest: "digest" },
            installScan: {
              version: 1,
              fileCount: 1,
              totalBytes: 64,
              blocked: true,
              findings: [
                {
                  severity: "block",
                  code: "sensitive_file",
                  path: ".env",
                  message: "contains sensitive file",
                },
              ],
            },
            updateReview: {
              version: 1,
              approvalRequired: false,
              reasons: [],
              permissionDigestChanged: true,
              nextPermissionDigest: "digest",
              addedScanFindings: [],
            },
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    const button = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (candidate) => candidate.textContent?.includes("Blocked by scan"),
    );
    expect(button?.disabled).toBe(true);
  });

  it("renders update permission and scan diffs before approval", async () => {
    const container = document.createElement("div");
    installDialogMethod("showModal", function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    });

    render(
      renderSkills(
        createProps({
          clawhubReview: {
            ok: true,
            mode: "update",
            slug: "trader",
            previousVersion: "1.0.0",
            version: "1.1.0",
            changed: true,
            targetDir: "/tmp/workspace/skills/trader",
            sourceTrust: {
              registry: "https://clawhub.com",
              trusted: true,
              mode: "allowlist",
              allowlist: ["https://clawhub.com"],
            },
            permissions: {
              version: 1,
              risky: true,
              digest: "next-digest",
              walletActions: {
                actions: ["swap"],
                roles: ["agent"],
                chains: ["solana"],
              },
              toolAccess: ["web.fetch"],
            },
            installScan: {
              version: 1,
              fileCount: 4,
              totalBytes: 4096,
              blocked: false,
              findings: [
                {
                  severity: "warn",
                  code: "script_file",
                  path: "bin/trade.sh",
                  message: "script file present",
                },
              ],
            },
            updateReview: {
              version: 1,
              approvalRequired: true,
              reasons: ["requested permissions changed", "archive scan added reviewable findings"],
              permissionDigestChanged: true,
              previousPermissionDigest: "prev-digest",
              nextPermissionDigest: "next-digest",
              permissionDiff: {
                added: ["wallet action: swap", "tool access: web.fetch"],
                removed: ["tool access: old.tool"],
              },
              addedScanFindings: [
                {
                  severity: "warn",
                  code: "script_file",
                  path: "bin/trade.sh",
                  message: "script file present",
                },
              ],
            },
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    const text = normalizeText(container);
    expect(text).toContain("Update trader");
    expect(text).toContain("1.0.0 -> 1.1.0");
    expect(text).toContain("Source trust");
    expect(text).toContain("registry allowlist");
    expect(text).toContain("Dependency/script policy");
    expect(text).toContain("script files 1");
    expect(text).toContain("Approval required: requested permissions changed");
    expect(text).toContain("Added permissions");
    expect(text).toContain("wallet action: swap");
    expect(text).toContain("Removed permissions");
    expect(text).toContain("tool access: old.tool");
    expect(text).toContain("New archive warnings");
    expect(text).toContain("Warning: script_file");
  });
});

function installDialogMethod(
  name: "showModal" | "close",
  value: (this: HTMLDialogElement) => void,
) {
  const proto = HTMLDialogElement.prototype as HTMLDialogElement & Record<string, unknown>;
  const original = Object.getOwnPropertyDescriptor(proto, name);
  Object.defineProperty(proto, name, {
    configurable: true,
    writable: true,
    value,
  });
  dialogRestores.push(() => {
    if (original) {
      Object.defineProperty(proto, name, original);
      return;
    }
    delete proto[name];
  });
}
