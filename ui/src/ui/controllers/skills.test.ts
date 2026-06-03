import { describe, expect, it, vi } from "vitest";
import {
  confirmClawHubMarketplaceReview,
  closeSkillEditor,
  createSkill,
  installSkill,
  installFromClawHub,
  openSkillEditor,
  previewClawHubUpdate,
  saveSkillConfig,
  saveSkillEditor,
  saveSkillEnv,
  setClawHubInstallTarget,
  searchClawHub,
  setClawHubSearchQuery,
  updateSkillEditorDraft,
  updateSkillEnabled,
  type SkillsState,
} from "./skills.ts";

function createState(): { state: SkillsState; request: ReturnType<typeof vi.fn> } {
  const request = vi.fn();
  const state: SkillsState = {
    client: {
      request,
    } as unknown as SkillsState["client"],
    connected: true,
    skillsLoading: false,
    skillsReport: null,
    skillsError: null,
    skillsBusyKey: null,
    skillEdits: {},
    skillEnvEdits: {},
    skillConfigEdits: {},
    skillMessages: {},
    skillCreateOpen: false,
    skillCreateName: "",
    skillCreateDescription: "",
    skillCreateAgentId: "",
    skillCreateTemplate: "general",
    skillCreateBusy: false,
    skillCreateError: null,
    skillEditor: null,
    skillEditorDraft: "",
    skillEditorLoading: false,
    skillEditorSaving: false,
    skillEditorError: null,
    clawhubSearchQuery: "github",
    clawhubSearchResults: [
      {
        score: 0.9,
        slug: "github",
        displayName: "GitHub",
        summary: "Previous result",
        version: "1.0.0",
      },
    ],
    clawhubSearchLoading: false,
    clawhubSearchError: "old error",
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
  };
  return { state, request };
}

describe("searchClawHub", () => {
  it("clears stale query state immediately when the input changes", () => {
    const { state } = createState();

    state.clawhubSearchLoading = true;
    state.clawhubInstallMessage = { kind: "success", text: "Installed github" };

    setClawHubSearchQuery(state, "github app");

    expect(state.clawhubSearchQuery).toBe("github app");
    expect(state.clawhubSearchResults).toBeNull();
    expect(state.clawhubSearchError).toBeNull();
    expect(state.clawhubSearchLoading).toBe(false);
    expect(state.clawhubInstallMessage).toBeNull();
  });

  it("clears stale results as soon as a new search starts", async () => {
    const { state, request } = createState();
    type SearchResponse = { results: SkillsState["clawhubSearchResults"] };
    let resolveRequest: (value: SearchResponse) => void = () => {
      throw new Error("expected search request promise to be pending");
    };
    request.mockImplementation(
      () =>
        new Promise<SearchResponse>((resolve) => {
          resolveRequest = resolve;
        }),
    );

    const pending = searchClawHub(state, "github");

    expect(state.clawhubSearchResults).toBeNull();
    expect(state.clawhubSearchLoading).toBe(true);
    expect(state.clawhubSearchError).toBeNull();
    expect(request).toHaveBeenCalledWith("skills.search", { query: "github", limit: 20 });

    resolveRequest({
      results: [
        {
          score: 0.95,
          slug: "github-new",
          displayName: "GitHub New",
          summary: "Fresh result",
          version: "2.0.0",
        },
      ],
    });
    await pending;

    expect(state.clawhubSearchResults).toEqual([
      {
        score: 0.95,
        slug: "github-new",
        displayName: "GitHub New",
        summary: "Fresh result",
        version: "2.0.0",
      },
    ]);
    expect(state.clawhubSearchLoading).toBe(false);
  });

  it("clears stale results when the query is emptied", async () => {
    const { state, request } = createState();

    await searchClawHub(state, "   ");

    expect(request).not.toHaveBeenCalled();
    expect(state.clawhubSearchResults).toBeNull();
    expect(state.clawhubSearchError).toBeNull();
    expect(state.clawhubSearchLoading).toBe(false);
  });
});

describe("installSkill", () => {
  it("uses the current skills.install RPC schema", async () => {
    const { state, request } = createState();
    request.mockImplementation(async (method: string) => {
      if (method === "skills.install") {
        return { ok: true, message: "Installed dependency" };
      }
      if (method === "skills.status") {
        return {
          workspaceDir: "/tmp/workspace",
          managedSkillsDir: "/tmp/skills",
          skills: [],
        };
      }
      throw new Error(`unexpected method ${method}`);
    });

    await installSkill(state, "repo-skill", "Repo Skill", "node");

    expect(request).toHaveBeenCalledWith("skills.install", {
      name: "Repo Skill",
      installId: "node",
      timeoutMs: 120000,
    });
    expect(request).not.toHaveBeenCalledWith(
      "skills.install",
      expect.objectContaining({ dangerouslyForceUnsafeInstall: expect.anything() }),
    );
    expect(state.skillMessages["repo-skill"]).toEqual({
      kind: "success",
      message: "Installed dependency",
    });
  });

  it("does not show success when skills.install returns ok false", async () => {
    const { state, request } = createState();
    request.mockImplementation(async (method: string) => {
      if (method === "skills.install") {
        return {
          ok: false,
          message:
            'Install command completed, but "mcporter" is still not visible to the gateway PATH.',
          stderr: "npm warning prefix is not in PATH",
        };
      }
      if (method === "skills.status") {
        return {
          workspaceDir: "/tmp/workspace",
          managedSkillsDir: "/tmp/skills",
          skills: [],
        };
      }
      throw new Error(`unexpected method ${method}`);
    });

    await installSkill(state, "mcporter", "mcporter", "node");

    expect(request).toHaveBeenCalledWith("skills.install", {
      name: "mcporter",
      installId: "node",
      timeoutMs: 120000,
    });
    expect(state.skillMessages["mcporter"]).toEqual({
      kind: "error",
      message:
        'Install command completed, but "mcporter" is still not visible to the gateway PATH. stderr: npm warning prefix is not in PATH',
    });
    expect(state.skillsError).toContain("mcporter");
  });
});

describe("createSkill and generic config", () => {
  it("creates a workspace skill through the skills.create RPC", async () => {
    const { state, request } = createState();
    state.skillCreateOpen = true;
    state.skillCreateName = "Research Helper";
    state.skillCreateDescription = "Use for source review.";
    state.skillCreateAgentId = "research";
    state.skillCreateTemplate = "research";
    request.mockImplementation(async (method: string) => {
      if (method === "skills.create") {
        return {
          ok: true,
          skillKey: "research-helper",
          name: "Research Helper",
          filePath: "/tmp/workspace/skills/research-helper/SKILL.md",
        };
      }
      if (method === "skills.status") {
        return {
          workspaceDir: "/tmp/workspace",
          managedSkillsDir: "/tmp/skills",
          skills: [],
        };
      }
      throw new Error(`unexpected method ${method}`);
    });

    await createSkill(state);

    expect(request).toHaveBeenCalledWith("skills.create", {
      name: "Research Helper",
      description: "Use for source review.",
      agentId: "research",
      template: "research",
    });
    expect(state.skillCreateOpen).toBe(false);
    expect(state.skillCreateName).toBe("");
    expect(state.skillMessages["research-helper"]).toEqual({
      kind: "success",
      message: "Created Research Helper",
    });
  });

  it("saves generic env and JSON config through skills.update", async () => {
    const { state, request } = createState();
    state.skillEnvEdits = { "repo-skill": { EXTRA_TOKEN: "secret" } };
    state.skillConfigEdits = { "repo-skill": '{ "mode": "strict" }' };
    request.mockImplementation(async (method: string) => {
      if (method === "skills.update") {
        return { ok: true };
      }
      if (method === "skills.status") {
        return {
          workspaceDir: "/tmp/workspace",
          managedSkillsDir: "/tmp/skills",
          skills: [],
        };
      }
      throw new Error(`unexpected method ${method}`);
    });

    await saveSkillEnv(state, "repo-skill");
    await saveSkillConfig(state, "repo-skill");

    expect(request).toHaveBeenCalledWith("skills.update", {
      skillKey: "repo-skill",
      env: { EXTRA_TOKEN: "secret" },
    });
    expect(request).toHaveBeenCalledWith("skills.update", {
      skillKey: "repo-skill",
      config: { mode: "strict" },
    });
  });
});

describe("skill file editor", () => {
  it("opens and saves editable skill files through the skills file RPCs", async () => {
    const { state, request } = createState();
    state.skillsReport = {
      workspaceDir: "/tmp/workspace",
      managedSkillsDir: "/tmp/skills",
      skills: [
        {
          name: "Repo Skill",
          description: "Skill description",
          source: "fased-workspace",
          filePath: "/tmp/workspace/skills/repo/SKILL.md",
          baseDir: "/tmp/workspace/skills/repo",
          skillKey: "repo-skill",
          bundled: false,
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
    request.mockImplementation(async (method: string) => {
      if (method === "skills.file.get") {
        return {
          skillKey: "repo-skill",
          name: "Repo Skill",
          source: "fased-workspace",
          filePath: "/tmp/workspace/skills/repo/SKILL.md",
          content: "# Repo Skill\n",
        };
      }
      if (method === "skills.file.set") {
        return { ok: true };
      }
      if (method === "skills.status") {
        return {
          workspaceDir: "/tmp/workspace",
          managedSkillsDir: "/tmp/skills",
          skills: state.skillsReport?.skills ?? [],
        };
      }
      throw new Error(`unexpected method ${method}`);
    });

    await openSkillEditor(state, "repo-skill");
    expect(request).toHaveBeenCalledWith("skills.file.get", { skillKey: "repo-skill" });
    expect(state.skillEditorDraft).toBe("# Repo Skill\n");

    updateSkillEditorDraft(state, "# Repo Skill\nUpdated\n");
    await saveSkillEditor(state);

    expect(request).toHaveBeenCalledWith("skills.file.set", {
      skillKey: "repo-skill",
      content: "# Repo Skill\nUpdated\n",
    });
    expect(state.skillMessages["repo-skill"]).toEqual({
      kind: "success",
      message: "Skill file saved",
    });

    closeSkillEditor(state);
    expect(state.skillEditor).toBeNull();
  });
});

describe("installFromClawHub", () => {
  it("previews the marketplace install before mutating skill files", async () => {
    const { state, request } = createState();
    request.mockImplementation(async (method: string) => {
      if (method === "skills.marketplace.install.preview") {
        return {
          ok: true,
          slug: "github",
          version: "1.0.0",
          targetDir: "/tmp/workspace/skills/github",
          permissions: { version: 1, risky: false, digest: "digest" },
          installScan: { version: 1, fileCount: 1, totalBytes: 100, findings: [], blocked: false },
          updateReview: {
            version: 1,
            approvalRequired: false,
            reasons: [],
            permissionDigestChanged: true,
            nextPermissionDigest: "digest",
            addedScanFindings: [],
          },
        };
      }
      throw new Error(`unexpected method ${method}`);
    });

    await installFromClawHub(state, "github");

    expect(request).toHaveBeenCalledWith("skills.marketplace.install.preview", {
      slug: "github",
      target: { scope: "default-agent" },
    });
    expect(state.clawhubReview).toMatchObject({
      ok: true,
      mode: "install",
      slug: "github",
      version: "1.0.0",
    });
    expect(state.clawhubReviewLoading).toBe(false);
  });

  it("confirms an install review through the mutating RPC", async () => {
    const { state, request } = createState();
    state.clawhubReview = {
      ok: true,
      mode: "install",
      slug: "github",
      version: "1.0.0",
      targetDir: "/tmp/workspace/skills/github",
      permissions: { version: 1, risky: false, digest: "digest" },
      installScan: { version: 1, fileCount: 1, totalBytes: 100, findings: [], blocked: false },
      updateReview: {
        version: 1,
        approvalRequired: false,
        reasons: [],
        permissionDigestChanged: true,
        nextPermissionDigest: "digest",
        addedScanFindings: [],
      },
    };
    request.mockImplementation(async (method: string) => {
      if (method === "skills.marketplace.install") {
        return { ok: true };
      }
      if (method === "skills.status") {
        return {
          workspaceDir: "/tmp/workspace",
          managedSkillsDir: "/tmp/skills",
          skills: [],
        };
      }
      throw new Error(`unexpected method ${method}`);
    });

    await confirmClawHubMarketplaceReview(state);

    expect(request).toHaveBeenCalledWith("skills.marketplace.install", {
      slug: "github",
      version: "1.0.0",
      target: undefined,
    });
    expect(state.clawhubInstallMessage).toEqual({ kind: "success", text: "Installed github" });
    expect(state.clawhubReview).toBeNull();
  });

  it("previews and confirms ClawHub updates with explicit permission approval", async () => {
    const { state, request } = createState();
    request.mockImplementation(async (method: string) => {
      if (method === "skills.marketplace.update.preview") {
        return {
          results: [
            {
              ok: true,
              slug: "github",
              previousVersion: "1.0.0",
              version: "1.1.0",
              changed: true,
              targetDir: "/tmp/workspace/skills/github",
              permissions: { version: 1, risky: true, digest: "next" },
              installScan: {
                version: 1,
                fileCount: 1,
                totalBytes: 100,
                findings: [],
                blocked: false,
              },
              updateReview: {
                version: 1,
                approvalRequired: true,
                reasons: ["requested permissions changed"],
                permissionDigestChanged: true,
                previousPermissionDigest: "prev",
                nextPermissionDigest: "next",
                addedScanFindings: [],
              },
            },
          ],
        };
      }
      if (method === "skills.marketplace.update") {
        return { results: [{ ok: true }] };
      }
      if (method === "skills.status") {
        return {
          workspaceDir: "/tmp/workspace",
          managedSkillsDir: "/tmp/skills",
          skills: [],
        };
      }
      throw new Error(`unexpected method ${method}`);
    });

    await previewClawHubUpdate(state, "github");
    expect(state.clawhubReview).toMatchObject({
      ok: true,
      mode: "update",
      slug: "github",
      version: "1.1.0",
    });

    await confirmClawHubMarketplaceReview(state);
    expect(request).toHaveBeenCalledWith("skills.marketplace.update", {
      slug: "github",
      target: { scope: "default-agent" },
      allowPermissionChanges: true,
    });
  });

  it("previews and confirms ClawHub installs for the selected target", async () => {
    const { state, request } = createState();
    setClawHubInstallTarget(state, "agent:research");
    request.mockImplementation(async (method: string) => {
      if (method === "skills.marketplace.install.preview") {
        return {
          ok: true,
          slug: "github",
          version: "1.0.0",
          targetDir: "/tmp/research/skills/github",
          permissions: { version: 1, risky: false, digest: "digest" },
          installScan: { version: 1, fileCount: 1, totalBytes: 100, findings: [], blocked: false },
          updateReview: {
            version: 1,
            approvalRequired: false,
            reasons: [],
            permissionDigestChanged: true,
            nextPermissionDigest: "digest",
            addedScanFindings: [],
          },
        };
      }
      if (method === "skills.marketplace.install") {
        return { ok: true };
      }
      if (method === "skills.status") {
        return {
          workspaceDir: "/tmp/research",
          managedSkillsDir: "/tmp/research/skills",
          skills: [],
        };
      }
      throw new Error(`unexpected method ${method}`);
    });

    await installFromClawHub(state, "github");
    state.clawhubInstallTarget = "shared";
    await confirmClawHubMarketplaceReview(state);

    expect(request).toHaveBeenCalledWith("skills.marketplace.install.preview", {
      slug: "github",
      target: { scope: "agent", agentId: "research" },
    });
    expect(request).toHaveBeenCalledWith("skills.marketplace.install", {
      slug: "github",
      version: "1.0.0",
      target: { scope: "agent", agentId: "research" },
    });
  });

  it("blocks enabling ClawHub skills that require marketplace review", async () => {
    const { state, request } = createState();
    state.skillsReport = {
      workspaceDir: "/tmp/workspace",
      managedSkillsDir: "/tmp/skills",
      skills: [
        {
          name: "GitHub",
          description: "GitHub skill",
          source: "clawhub",
          filePath: "/tmp/workspace/skills/github/SKILL.md",
          baseDir: "/tmp/workspace/skills/github",
          skillKey: "github",
          bundled: false,
          always: false,
          disabled: true,
          blockedByAllowlist: false,
          eligible: false,
          requirements: { bins: [], env: [], config: [], os: [] },
          missing: { bins: [], env: [], config: [], os: [] },
          configChecks: [],
          install: [],
          marketplace: {
            source: "clawhub",
            registry: "https://clawhub.com",
            slug: "github",
            installedVersion: "1.0.0",
            installedAt: 1,
            requestedRisky: true,
            requestedWalletActions: false,
            requestedToolAccess: [],
            requestedInstallKinds: [],
            scanBlocked: false,
            scanWarnings: 0,
            scanBlocks: 0,
            updateApprovalRequired: true,
            updateReviewReasons: ["requested permissions changed"],
          },
        },
      ],
    };

    await updateSkillEnabled(state, "github", true);

    expect(request).not.toHaveBeenCalled();
    expect(state.skillMessages.github?.kind).toBe("error");
    expect(state.skillMessages.github?.message).toContain("Review this ClawHub skill update");
  });
});
