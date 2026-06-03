import { describe, expect, it, vi } from "vitest";
import "../styles.css";
import { DEFAULT_CRON_FORM } from "./app-defaults.ts";
import { mountApp, registerAppMountHooks } from "./test-helpers/app-mount.ts";
import type { SkillStatusEntry } from "./types.ts";

registerAppMountHooks();

function makeSkill(overrides: Partial<SkillStatusEntry> = {}): SkillStatusEntry {
  return {
    name: "Repo Skill",
    description: "Repo skill",
    source: "workspace",
    filePath: "/tmp/workspace/skills/repo-skill/SKILL.md",
    baseDir: "/tmp/workspace/skills/repo-skill",
    skillKey: "repo-skill",
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

async function settleApp(app: HTMLElement & { updateComplete: Promise<unknown> }) {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await app.updateComplete;
}

async function settleUntil(
  app: HTMLElement & { updateComplete: Promise<unknown> },
  predicate: () => boolean,
  attempts = 10,
) {
  for (let index = 0; index < attempts; index += 1) {
    await settleApp(app);
    if (predicate()) {
      return;
    }
  }
}

describe("app task model inheritance", () => {
  it("renders the memory route as a normal SPA page", async () => {
    const app = mountApp("/memory");
    app.applySettings({ ...app.settings, token: "owner-token-for-memory-route" });
    app.agentsList = {
      defaultId: "main",
      mainKey: "main",
      scope: "local",
      agents: [{ id: "main", name: "Assistant" }],
    };
    app.memoryInventory = null;
    app.memoryValidation = null;

    app.requestUpdate();
    await app.updateComplete;

    expect(app.tab).toBe("memory");
    expect(app.textContent).toContain("Memory");
    expect(app.textContent).not.toContain("Sign in to Fased Agent");
  });

  it("shows saved Agent task-role models instead of a generic default label", async () => {
    const app = mountApp("/tasks");
    app.applySettings({ ...app.settings, token: "owner-token-for-task-models" });
    app.agentsList = {
      defaultId: "main",
      mainKey: "main",
      scope: "local",
      agents: [{ id: "main", name: "Assistant" }],
    };
    app.configForm = {
      agents: {
        defaults: {
          model: { primary: "openai/default-model" },
        },
      },
    };
    app.configSnapshot = {
      config: {
        agents: {
          list: [
            {
              id: "main",
              model: { primary: "openai/gpt-5.5" },
              taskModels: {
                cheapCheck: "openrouter/openai/gpt-5.4-mini",
                escalation: "openrouter/minimax/minimax-m2.7",
              },
            },
          ],
        },
      },
    };
    app.chatModelCatalog = [
      { id: "gpt-5.4-mini", provider: "openrouter/openai", name: "GPT-5.4 Mini" },
      { id: "minimax-m2.7", provider: "openrouter/minimax", name: "MiniMax M2.7" },
    ];
    app.agentTaskDialogOpen = true;
    app.agentTaskForm = {
      ...DEFAULT_CRON_FORM,
      agentId: "",
      name: "Role smoke",
      payloadText: "Use a cheap check first.",
      executionMode: "agent-turn",
    };

    app.requestUpdate();
    await app.updateComplete;

    const cheap = app.querySelector<HTMLSelectElement>('[data-test-id="agent-task-policy-model"]');
    const escalation = app.querySelector<HTMLSelectElement>(
      '[data-test-id="agent-task-escalation-model"]',
    );

    expect(cheap?.options[0]?.textContent?.trim()).toContain("gpt-5.4-mini");
    expect(escalation?.options[0]?.textContent?.trim()).toContain("minimax-m2.7");
    expect(cheap?.options[0]?.textContent?.trim()).not.toBe("Default");
    expect(escalation?.options[0]?.textContent?.trim()).not.toBe("Default");
  });

  it("shows Agent skill inheritance and lets a task narrow selected skills", async () => {
    const app = mountApp("/tasks");
    app.applySettings({ ...app.settings, token: "owner-token-for-task-skills" });
    app.agentsList = {
      defaultId: "main",
      mainKey: "main",
      scope: "local",
      agents: [{ id: "main", name: "Assistant" }],
    };
    app.configSnapshot = {
      config: {
        agents: {
          list: [{ id: "main", skills: ["wallet", "mining"] }],
        },
      },
    };
    app.agentSkillsAgentId = "main";
    app.agentSkillsReport = {
      workspaceDir: "/tmp/workspace",
      managedSkillsDir: "/tmp/workspace/skills",
      skills: [
        {
          name: "Wallet",
          description: "Wallet actions",
          source: "workspace",
          filePath: "/tmp/workspace/skills/wallet/SKILL.md",
          baseDir: "/tmp/workspace/skills/wallet",
          skillKey: "wallet",
          always: false,
          disabled: false,
          blockedByAllowlist: false,
          eligible: true,
          requirements: { bins: [], env: [], config: [], os: [] },
          missing: { bins: [], env: [], config: [], os: [] },
          configChecks: [],
          install: [],
        },
        {
          name: "Mining",
          description: "Mining actions",
          source: "workspace",
          filePath: "/tmp/workspace/skills/mining/SKILL.md",
          baseDir: "/tmp/workspace/skills/mining",
          skillKey: "mining",
          always: false,
          disabled: false,
          blockedByAllowlist: false,
          eligible: true,
          requirements: { bins: [], env: [], config: [], os: [] },
          missing: { bins: [], env: [], config: [], os: [] },
          configChecks: [],
          install: [],
        },
      ],
    };
    app.agentTaskDialogOpen = true;
    app.agentTaskForm = {
      ...DEFAULT_CRON_FORM,
      agentId: "main",
      name: "Skill smoke",
      payloadText: "Check wallet status.",
    };

    app.requestUpdate();
    await app.updateComplete;

    expect(app.textContent).toContain("Inherited from Agent");
    expect(app.textContent).toContain("All Agent skills (2)");
    expect(app.textContent).toContain("Wallet");

    const access = app.querySelector<HTMLSelectElement>('[data-test-id="agent-task-skills"]');
    access!.value = "selected";
    access!.dispatchEvent(new Event("change", { bubbles: true }));
    await app.updateComplete;

    const addSkill = app.querySelector<HTMLSelectElement>('[data-test-id="agent-task-skill-add"]');
    addSkill!.value = "wallet";
    addSkill!.dispatchEvent(new Event("change", { bubbles: true }));
    await app.updateComplete;

    expect(app.agentTaskForm.skillScope).toBe("selected");
    expect(app.agentTaskForm.allowedSkills).toBe("wallet");
    expect(app.textContent).toContain("Narrowed for this task");
  });

  it("smokes created skill access through the chat loaded-skills chip", async () => {
    const app = mountApp("/skills");
    const sessionKey = "agent:main:webchat:direct:skill-smoke";
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "skills.create") {
        expect(params).toMatchObject({
          name: "Market smoke",
          description: "Answers a matching market smoke task.",
          agentId: "main",
          template: "general",
        });
        return { skillKey: "market-smoke", name: "Market smoke" };
      }
      if (method === "skills.status") {
        return {
          workspaceDir: "/tmp/workspace",
          managedSkillsDir: "/tmp/workspace/skills",
          skills: [
            {
              name: "Market smoke",
              description: "Answers a matching market smoke task.",
              source: "workspace",
              filePath: "/tmp/workspace/skills/market-smoke/SKILL.md",
              baseDir: "/tmp/workspace/skills/market-smoke",
              skillKey: "market-smoke",
              always: false,
              disabled: false,
              blockedByAllowlist: false,
              eligible: true,
              requirements: { bins: [], env: [], config: [], os: [] },
              missing: { bins: [], env: [], config: [], os: [] },
              configChecks: [],
              install: [],
            },
          ],
        };
      }
      return {};
    });
    app.client = { request, stop: vi.fn() } as unknown as typeof app.client;
    app.applySettings({ ...app.settings, token: "owner-token-for-skill-smoke", sessionKey });
    app.sessionKey = sessionKey;
    app.agentsList = {
      defaultId: "main",
      mainKey: "main",
      scope: "local",
      agents: [{ id: "main", name: "Assistant" }],
    };
    app.configSnapshot = {
      config: {
        agents: {
          list: [{ id: "main", skills: ["market-smoke"] }],
        },
      },
    };
    app.skillsReport = {
      workspaceDir: "/tmp/workspace",
      managedSkillsDir: "/tmp/workspace/skills",
      skills: [],
    };

    app.tab = "skills";
    app.requestUpdate();
    await app.updateComplete;

    const createSkillButton = app.querySelector<HTMLButtonElement>(
      '[data-testid="skills-create-open"]',
    );
    expect(createSkillButton).not.toBeNull();
    createSkillButton!.click();
    await app.updateComplete;

    expect(
      app.querySelector<HTMLElement>("dialog[open] .md-preview-dialog__title")?.textContent,
    ).toContain("Create skill");
    const createDialog = app.querySelector<HTMLDialogElement>("dialog[open].md-preview-dialog");
    expect(createDialog).not.toBeNull();
    const createDialogStyles = getComputedStyle(createDialog!);
    expect(createDialogStyles.position).toBe("fixed");
    expect(createDialogStyles.zIndex).toBe("20000");
    expect(createDialog?.textContent).toContain("Save in Agent");
    expect(createDialog?.textContent).toContain("Assistant");
    expect(createDialog?.textContent).not.toContain("Assistant workspace");

    const nameInput = Array.from(app.querySelectorAll<HTMLInputElement>("dialog input")).find(
      (input) => input.placeholder === "Research helper",
    );
    nameInput!.value = "Market smoke";
    nameInput!.dispatchEvent(new Event("input", { bubbles: true }));
    const description = app.querySelector<HTMLTextAreaElement>("dialog textarea");
    description!.value = "Answers a matching market smoke task.";
    description!.dispatchEvent(new Event("input", { bubbles: true }));
    const agentSelect = app.querySelector<HTMLSelectElement>('[data-testid="skill-create-agent"]');
    agentSelect!.value = "main";
    agentSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    await app.updateComplete;

    Array.from(app.querySelectorAll<HTMLButtonElement>("dialog button"))
      .find((button) => button.textContent?.includes("Create skill"))
      ?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await app.updateComplete;
    expect(request).toHaveBeenCalledWith("skills.create", {
      name: "Market smoke",
      description: "Answers a matching market smoke task.",
      agentId: "main",
      template: "general",
    });

    app.sessionsResult = {
      ts: 0,
      path: "",
      count: 1,
      defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: null },
      sessions: [
        {
          key: sessionKey,
          kind: "direct",
          updatedAt: null,
          skills: {
            count: 1,
            names: ["Market smoke"],
            skillFilter: ["market-smoke"],
          },
        },
      ],
    };
    app.chatMessages = [{ role: "user", content: "Use the market smoke skill for this task." }];
    app.tab = "chat";

    app.requestUpdate();
    await app.updateComplete;

    const chip = Array.from(app.querySelectorAll<HTMLElement>(".chat-usage-summary__item")).find(
      (entry) => entry.textContent?.includes("1 skills"),
    );
    expect(chip).not.toBeUndefined();
    expect(chip?.getAttribute("title")).toContain("Narrow selected skills: Market smoke");
  });

  it("opens the ClawHub review modal from details and confirms install", async () => {
    const app = mountApp("/skills");
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "skills.marketplace.install.preview") {
        expect(params).toMatchObject({
          slug: "github",
          target: { scope: "default-agent" },
        });
        return {
          ok: true,
          slug: "github",
          version: "1.2.3",
          targetDir: "/tmp/workspace/skills/github",
          permissions: { version: 1, risky: false, digest: "next-digest" },
          installScan: {
            version: 1,
            fileCount: 2,
            totalBytes: 1024,
            files: ["SKILL.md", "README.md"],
            findings: [],
            blocked: false,
          },
          updateReview: {
            version: 1,
            approvalRequired: false,
            reasons: [],
            permissionDigestChanged: true,
            nextPermissionDigest: "next-digest",
            addedScanFindings: [],
          },
        };
      }
      if (method === "skills.marketplace.install") {
        expect(params).toMatchObject({
          slug: "github",
          version: "1.2.3",
          target: { scope: "default-agent" },
        });
        return { ok: true };
      }
      if (method === "skills.status") {
        return {
          workspaceDir: "/tmp/workspace",
          managedSkillsDir: "/tmp/workspace/skills",
          skills: [],
        };
      }
      throw new Error(`unexpected method ${method}`);
    });
    app.client = { request, stop: vi.fn() } as unknown as typeof app.client;
    app.applySettings({ ...app.settings, token: "owner-token-for-clawhub-review" });
    app.agentsList = {
      defaultId: "main",
      mainKey: "main",
      scope: "local",
      agents: [{ id: "main", name: "Assistant" }],
    };
    app.clawhubDetailSlug = "github";
    app.clawhubDetail = {
      skill: {
        slug: "github",
        displayName: "GitHub",
        summary: "GitHub skill",
        createdAt: 1,
        updatedAt: 2,
      },
      latestVersion: { version: "1.2.3", createdAt: 3 },
    };

    app.requestUpdate();
    await app.updateComplete;

    app.querySelector<HTMLButtonElement>('[data-testid="clawhub-detail-review-install"]')?.click();
    await settleApp(app);

    expect(app.clawhubDetailSlug).toBeNull();
    expect(app.textContent).toContain("Install github");
    expect(app.textContent).toContain("Install preview");
    expect(app.textContent).toContain("SKILL.md");

    app.querySelector<HTMLButtonElement>('[data-testid="clawhub-review-confirm"]')?.click();
    await settleApp(app);

    expect(request).toHaveBeenCalledWith("skills.marketplace.install", {
      slug: "github",
      version: "1.2.3",
      target: { scope: "default-agent" },
    });
    expect(app.clawhubInstallMessage?.text).toBe("Installed github");
  });

  it("keeps ClawHub preview failures visible after the review dialog closes", async () => {
    const app = mountApp("/skills");
    const request = vi.fn(async (method: string) => {
      if (method === "skills.marketplace.install.preview") {
        return {
          ok: false,
          error: "downloaded archive is missing SKILL.md",
        };
      }
      throw new Error(`unexpected method ${method}`);
    });
    app.client = { request, stop: vi.fn() } as unknown as typeof app.client;
    app.applySettings({ ...app.settings, token: "owner-token-for-clawhub-error" });
    app.skillsLibraryPanel = "clawhub";
    app.clawhubSearchResults = [
      {
        score: 1,
        slug: "broken-skill",
        displayName: "Broken Skill",
        summary: "Broken archive",
      },
    ];

    app.requestUpdate();
    await app.updateComplete;

    app
      .querySelector<HTMLButtonElement>('[data-testid="clawhub-review-install-broken-skill"]')
      ?.click();
    await settleApp(app);

    expect(app.textContent).toContain("downloaded archive is missing SKILL.md");
    Array.from(app.querySelectorAll<HTMLButtonElement>("dialog button"))
      .find((button) => button.textContent?.includes("Close"))
      ?.click();
    await settleApp(app);

    expect(app.clawhubInstallMessage).toEqual({
      kind: "error",
      text: "downloaded archive is missing SKILL.md",
    });
    expect(app.textContent).toContain("downloaded archive is missing SKILL.md");
  });

  it("copies a read-only skill into a workspace, opens the editor, and saves it", async () => {
    const app = mountApp("/skills");
    const copiedSkill = makeSkill({
      name: "Bundled Helper",
      skillKey: "bundled-helper",
      source: "fased-bundled",
      filePath: "/repo/skills/bundled-helper/SKILL.md",
      baseDir: "/repo/skills/bundled-helper",
    });
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "skills.copy") {
        expect(params).toMatchObject({ skillKey: "bundled-helper", agentId: "main" });
        return {
          skillKey: "bundled-helper",
          name: "Bundled Helper",
          filePath: "/tmp/workspace/skills/bundled-helper/SKILL.md",
          copiedFiles: 1,
        };
      }
      if (method === "skills.status") {
        return {
          workspaceDir: "/tmp/workspace",
          managedSkillsDir: "/tmp/workspace/skills",
          skills: [
            makeSkill({
              name: "Bundled Helper",
              skillKey: "bundled-helper",
              source: "workspace",
              filePath: "/tmp/workspace/skills/bundled-helper/SKILL.md",
              baseDir: "/tmp/workspace/skills/bundled-helper",
            }),
          ],
        };
      }
      if (method === "skills.file.get") {
        expect(params).toMatchObject({ skillKey: "bundled-helper" });
        return {
          skillKey: "bundled-helper",
          name: "Bundled Helper",
          source: "workspace",
          filePath: "/tmp/workspace/skills/bundled-helper/SKILL.md",
          content: "# Bundled Helper\n\nOriginal workflow.",
        };
      }
      if (method === "skills.file.set") {
        expect(params).toMatchObject({
          skillKey: "bundled-helper",
          content: "# Bundled Helper\n\nUpdated workflow.",
        });
        return {
          ok: true,
          skillKey: "bundled-helper",
          name: "Bundled Helper",
          source: "workspace",
          filePath: "/tmp/workspace/skills/bundled-helper/SKILL.md",
          size: 34,
          updatedAtMs: 2,
        };
      }
      throw new Error(`unexpected method ${method}`);
    });
    app.client = { request, stop: vi.fn() } as unknown as typeof app.client;
    app.applySettings({ ...app.settings, token: "owner-token-for-skill-copy" });
    app.agentsList = {
      defaultId: "main",
      mainKey: "main",
      scope: "local",
      agents: [{ id: "main", name: "Assistant" }],
    };
    app.skillsReport = {
      workspaceDir: "/tmp/workspace",
      managedSkillsDir: "/tmp/workspace/skills",
      skills: [copiedSkill],
    };

    app.requestUpdate();
    await app.updateComplete;

    app.querySelector<HTMLElement>('[data-testid="skill-row-bundled-helper"]')?.click();
    await app.updateComplete;
    expect(app.querySelector("dialog[open]")?.textContent).toContain(
      "Make an editable copy for Assistant",
    );
    app.querySelector<HTMLButtonElement>('[data-testid="skill-copy-workspace"]')?.click();
    await settleApp(app);

    const editor = app.querySelector<HTMLTextAreaElement>("dialog textarea.code-editor");
    expect(editor?.value).toContain("Original workflow");
    editor!.value = "# Bundled Helper\n\nUpdated workflow.";
    editor!.dispatchEvent(new Event("input", { bubbles: true }));

    Array.from(app.querySelectorAll<HTMLButtonElement>("dialog button"))
      .find((button) => button.textContent?.includes("Save file"))
      ?.click();
    await settleApp(app);

    expect(request).toHaveBeenCalledWith("skills.file.set", {
      skillKey: "bundled-helper",
      content: "# Bundled Helper\n\nUpdated workflow.",
    });
  });

  it("runs dependency install and saves typed skill config from visible controls", async () => {
    const app = mountApp("/skills");
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "skills.install") {
        expect(params).toEqual({
          name: "Needs Dependency",
          installId: "deps",
          timeoutMs: 120000,
        });
        return { ok: true, message: "Installed dependency" };
      }
      if (method === "skills.update") {
        expect(params).toEqual({
          skillKey: "needs-config",
          config: { mode: "strict" },
        });
        return { ok: true };
      }
      if (method === "skills.status") {
        return {
          workspaceDir: "/tmp/workspace",
          managedSkillsDir: "/tmp/workspace/skills",
          skills: app.skillsReport?.skills ?? [],
        };
      }
      throw new Error(`unexpected method ${method}`);
    });
    app.client = { request, stop: vi.fn() } as unknown as typeof app.client;
    app.applySettings({ ...app.settings, token: "owner-token-for-skill-actions" });
    app.skillsReport = {
      workspaceDir: "/tmp/workspace",
      managedSkillsDir: "/tmp/workspace/skills",
      skills: [
        makeSkill({
          name: "Needs Dependency",
          skillKey: "needs-dependency",
          eligible: false,
          missing: { bins: ["gh"], env: [], config: [], os: [] },
          install: [
            {
              id: "deps",
              kind: "node",
              label: "Install dependencies",
              bins: ["gh"],
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
        makeSkill({
          name: "Needs Config",
          skillKey: "needs-config",
          eligible: false,
          missing: {
            bins: [],
            env: [],
            config: ["skills.entries.needs-config.config.mode"],
            os: [],
          },
          requirements: {
            bins: [],
            env: [],
            config: ["skills.entries.needs-config.config.mode"],
            os: [],
          },
        }),
      ],
    };

    app.requestUpdate();
    await app.updateComplete;

    app
      .querySelector<HTMLButtonElement>('[data-testid="skill-install-dependency-needs-dependency"]')
      ?.click();
    await app.updateComplete;

    expect(
      app.querySelector<HTMLElement>("dialog[open] .md-preview-dialog__title")?.textContent,
    ).toContain("Needs Dependency");
    expect(app.querySelector("dialog[open]")?.textContent).toContain("External package trust");
    expect(app.querySelector("dialog[open]")?.textContent).toContain("Unpinned version");
    expect(app.querySelector("dialog[open]")?.textContent).toContain("No integrity pin");

    app
      .querySelector<HTMLButtonElement>(
        '[data-testid="skill-install-dependency-modal-needs-dependency"]',
      )
      ?.click();
    await settleUntil(
      app,
      () =>
        app.skillsBusyKey === null &&
        (
          app.querySelector('[data-testid="skill-row-needs-dependency"]')?.textContent ?? ""
        ).includes("Installed dependency"),
    );

    expect(app.querySelector('[data-testid="skill-row-needs-dependency"]')?.textContent).toContain(
      "Installed dependency",
    );
    expect(app.skillsBusyKey).toBeNull();
    const closeButton = Array.from(
      app.querySelectorAll<HTMLButtonElement>("dialog[open] button"),
    ).find((button) => button.textContent?.includes("Close"));
    expect(closeButton).not.toBeUndefined();
    closeButton!.click();
    await settleUntil(
      app,
      () =>
        !app.querySelector("dialog[open]") &&
        (app as HTMLElement & { skillsDetailKey?: string | null }).skillsDetailKey == null,
      40,
    );
    expect(app.querySelector("dialog[open]")).toBeNull();
    for (const group of app.querySelectorAll<HTMLDetailsElement>(".agent-skills-group")) {
      group.open = true;
    }
    await settleApp(app);

    const configureButton = app.querySelector<HTMLButtonElement>(
      '[data-testid="skill-configure-needs-config"]',
    );
    expect(configureButton).not.toBeUndefined();
    expect(configureButton?.disabled).toBe(false);
    configureButton!.click();
    await settleUntil(
      app,
      () =>
        Boolean(
          app
            .querySelector<HTMLElement>("dialog[open] .md-preview-dialog__title")
            ?.textContent?.includes("Needs Config"),
        ),
      10,
    );
    if (
      !app
        .querySelector<HTMLElement>("dialog[open] .md-preview-dialog__title")
        ?.textContent?.includes("Needs Config")
    ) {
      (app as HTMLElement & { skillsDetailKey?: string | null }).skillsDetailKey = "needs-config";
      app.requestUpdate();
    }
    await settleUntil(
      app,
      () =>
        Boolean(
          app
            .querySelector<HTMLElement>("dialog[open] .md-preview-dialog__title")
            ?.textContent?.includes("Needs Config"),
        ),
      40,
    );
    expect(
      app.querySelector<HTMLElement>("dialog[open] .md-preview-dialog__title")?.textContent,
    ).toContain("Needs Config");
    const modeInput = Array.from(app.querySelectorAll<HTMLInputElement>("dialog input")).find(
      (input) => input.closest("label")?.textContent?.includes("mode"),
    );
    expect(modeInput).not.toBeUndefined();
    modeInput!.value = "strict";
    modeInput!.dispatchEvent(new Event("input", { bubbles: true }));
    await app.updateComplete;

    Array.from(app.querySelectorAll<HTMLButtonElement>("dialog button"))
      .find((button) => button.textContent?.includes("Save config"))
      ?.click();
    await settleApp(app);

    expect(request).toHaveBeenCalledWith("skills.install", {
      name: "Needs Dependency",
      installId: "deps",
      timeoutMs: 120000,
    });
    expect(request).toHaveBeenCalledWith("skills.update", {
      skillKey: "needs-config",
      config: { mode: "strict" },
    });
  });
});
