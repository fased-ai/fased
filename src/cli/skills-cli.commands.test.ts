import { Command } from "commander";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const loadConfigMock = vi.fn();
const readConfigFileSnapshotForWriteMock = vi.fn();
const writeConfigFileMock = vi.fn();
const resolveAgentWorkspaceDirMock = vi.fn();
const resolveDefaultAgentIdMock = vi.fn();
const buildWorkspaceSkillStatusMock = vi.fn();
const readTrackedClawHubSkillSlugsMock = vi.fn();
const readClawHubSkillOriginMock = vi.fn();
const installSkillFromClawHubMock = vi.fn();
const previewSkillInstallFromClawHubMock = vi.fn();
const previewSkillsUpdateFromClawHubMock = vi.fn();
const updateSkillsFromClawHubMock = vi.fn();
const formatSkillsListMock = vi.fn();
const formatSkillInfoMock = vi.fn();
const formatSkillsCheckMock = vi.fn();

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

vi.mock("../config/config.js", () => ({
  loadConfig: loadConfigMock,
  readConfigFileSnapshotForWrite: readConfigFileSnapshotForWriteMock,
  writeConfigFile: writeConfigFileMock,
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: resolveAgentWorkspaceDirMock,
  resolveDefaultAgentId: resolveDefaultAgentIdMock,
}));

vi.mock("../agents/skills-status.js", () => ({
  buildWorkspaceSkillStatus: buildWorkspaceSkillStatusMock,
}));

vi.mock("../agents/skills-clawhub.js", () => ({
  installSkillFromClawHub: installSkillFromClawHubMock,
  previewSkillInstallFromClawHub: previewSkillInstallFromClawHubMock,
  previewSkillsUpdateFromClawHub: previewSkillsUpdateFromClawHubMock,
  readTrackedClawHubSkillSlugs: readTrackedClawHubSkillSlugsMock,
  readClawHubSkillOrigin: readClawHubSkillOriginMock,
  updateSkillsFromClawHub: updateSkillsFromClawHubMock,
}));

vi.mock("./skills-cli.format.js", () => ({
  formatSkillsList: formatSkillsListMock,
  formatSkillInfo: formatSkillInfoMock,
  formatSkillsCheck: formatSkillsCheckMock,
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: runtime,
}));

let registerSkillsCli: typeof import("./skills-cli.js").registerSkillsCli;

beforeAll(async () => {
  ({ registerSkillsCli } = await import("./skills-cli.js"));
});

describe("registerSkillsCli", () => {
  const report = {
    workspaceDir: "/tmp/workspace",
    managedSkillsDir: "/tmp/workspace/.skills",
    skills: [],
  };

  async function runCli(args: string[]) {
    const program = new Command();
    registerSkillsCli(program);
    await program.parseAsync(args, { from: "user" });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    loadConfigMock.mockReturnValue({ gateway: {} });
    readConfigFileSnapshotForWriteMock.mockResolvedValue({
      snapshot: {
        valid: true,
        exists: true,
        path: "/tmp/fased.json",
        config: {},
        resolved: {},
        issues: [],
        legacyIssues: [],
      },
      writeOptions: {
        expectedConfigPath: "/tmp/fased.json",
      },
    });
    writeConfigFileMock.mockResolvedValue(undefined);
    resolveDefaultAgentIdMock.mockReturnValue("main");
    resolveAgentWorkspaceDirMock.mockReturnValue("/tmp/workspace");
    readTrackedClawHubSkillSlugsMock.mockResolvedValue([]);
    readClawHubSkillOriginMock.mockResolvedValue(null);
    installSkillFromClawHubMock.mockResolvedValue({
      ok: true,
      slug: "daily-dca",
      version: "1.0.0",
      targetDir: "/tmp/workspace/skills/daily-dca",
      permissions: {
        version: 1,
        risky: false,
        digest: "digest",
      },
      installScan: {
        version: 1,
        fileCount: 1,
        totalBytes: 10,
        findings: [],
        blocked: false,
      },
      updateReview: {
        version: 1,
        approvalRequired: false,
        reasons: [],
        permissionDigestChanged: false,
        nextPermissionDigest: "digest",
        addedScanFindings: [],
      },
    });
    previewSkillInstallFromClawHubMock.mockResolvedValue({
      ok: true,
      slug: "daily-dca",
      version: "1.0.0",
      targetDir: "/tmp/workspace/skills/daily-dca",
      permissions: {
        version: 1,
        risky: true,
        digest: "digest-preview",
        walletActions: {
          actions: ["swap"],
        },
      },
      installScan: {
        version: 1,
        fileCount: 2,
        totalBytes: 20,
        findings: [
          {
            severity: "warn",
            code: "package-json",
            path: "package.json",
            message: "dependency manifest requires review",
          },
        ],
        blocked: false,
      },
      updateReview: {
        version: 1,
        approvalRequired: false,
        reasons: [],
        permissionDigestChanged: false,
        nextPermissionDigest: "digest-preview",
        permissionDiff: {
          added: ["wallet action: swap"],
          removed: [],
        },
        addedScanFindings: [],
      },
    });
    previewSkillsUpdateFromClawHubMock.mockResolvedValue([]);
    updateSkillsFromClawHubMock.mockResolvedValue([]);
    buildWorkspaceSkillStatusMock.mockReturnValue(report);
    formatSkillsListMock.mockReturnValue("skills-list-output");
    formatSkillInfoMock.mockReturnValue("skills-info-output");
    formatSkillsCheckMock.mockReturnValue("skills-check-output");
  });

  it("runs list command with resolved report and formatter options", async () => {
    await runCli(["skills", "list", "--eligible", "--verbose", "--json"]);

    expect(buildWorkspaceSkillStatusMock).toHaveBeenCalledWith("/tmp/workspace", {
      config: { gateway: {} },
      eligibility: { remote: undefined },
    });
    expect(formatSkillsListMock).toHaveBeenCalledWith(
      report,
      expect.objectContaining({
        eligible: true,
        verbose: true,
        json: true,
      }),
    );
    expect(runtime.log).toHaveBeenCalledWith("skills-list-output");
  });

  it("runs info command and forwards skill name", async () => {
    await runCli(["skills", "info", "peekaboo", "--json"]);

    expect(formatSkillInfoMock).toHaveBeenCalledWith(
      report,
      "peekaboo",
      expect.objectContaining({ json: true }),
    );
    expect(runtime.log).toHaveBeenCalledWith("skills-info-output");
  });

  it("runs inspect command as a skill info alias", async () => {
    await runCli(["skills", "inspect", "peekaboo", "--json"]);

    expect(formatSkillInfoMock).toHaveBeenCalledWith(
      report,
      "peekaboo",
      expect.objectContaining({ json: true }),
    );
    expect(runtime.log).toHaveBeenCalledWith("skills-info-output");
  });

  it("runs check command and writes formatter output", async () => {
    await runCli(["skills", "check"]);

    expect(formatSkillsCheckMock).toHaveBeenCalledWith(report, expect.any(Object));
    expect(runtime.log).toHaveBeenCalledWith("skills-check-output");
  });

  it("uses list formatter for default skills action", async () => {
    await runCli(["skills"]);

    expect(formatSkillsListMock).toHaveBeenCalledWith(report, {});
    expect(runtime.log).toHaveBeenCalledWith("skills-list-output");
  });

  it("reports runtime errors when report loading fails", async () => {
    loadConfigMock.mockImplementationOnce(() => {
      throw new Error("config exploded");
    });

    await runCli(["skills", "list"]);

    expect(runtime.error).toHaveBeenCalledWith("Error: config exploded");
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(buildWorkspaceSkillStatusMock).not.toHaveBeenCalled();
  });

  it("does not register remote marketplace or direct wallet-authority commands", () => {
    const program = new Command();
    registerSkillsCli(program);
    const skills = program.commands.find((command) => command.name() === "skills");
    const commandNames = skills?.commands.map((command) => command.name()) ?? [];
    expect(commandNames).not.toContain("marketplace");
    expect(commandNames).not.toContain("wallet");
  });

  it.skip("legacy: listed marketplace skill source and wallet permission state", async () => {
    readTrackedClawHubSkillSlugsMock.mockResolvedValueOnce(["daily-dca"]);
    readClawHubSkillOriginMock.mockResolvedValueOnce({
      version: 1,
      registry: "https://clawhub.com",
      slug: "daily-dca",
      installedVersion: "1.2.3",
      installedAt: 123,
      permissions: {
        version: 1,
        walletActions: {
          actions: ["quote", "swap"],
          autonomous: true,
        },
        risky: true,
        digest: "digest",
      },
    });
    loadConfigMock.mockReturnValueOnce({
      skills: {
        entries: {
          "daily-dca": {
            config: {
              walletActions: {
                actions: ["quote"],
                autonomous: false,
              },
            },
          },
        },
      },
    });

    await runCli(["skills", "marketplace", "list", "--json"]);

    expect(runtime.log).toHaveBeenCalledWith(
      JSON.stringify(
        {
          skills: [
            {
              skillId: "daily-dca",
              source: "clawhub",
              registry: "https://clawhub.com",
              version: "1.2.3",
              requestedWalletActions: {
                actions: ["quote", "swap"],
                autonomous: true,
              },
              requestedToolAccess: null,
              requestedInstall: null,
              requestedPermissionRisky: true,
              requestedPermissionDigest: "digest",
              grantedWalletActions: {
                actions: ["quote"],
                autonomous: false,
              },
              installScan: null,
              lastUpdateReview: null,
              autonomousRequested: true,
              autonomousGranted: false,
              cronRequested: false,
              cronGranted: false,
            },
          ],
        },
        null,
        2,
      ),
    );
  });

  it("shows marketplace permissions for one skill", async () => {
    readTrackedClawHubSkillSlugsMock.mockResolvedValueOnce(["daily-dca"]);
    readClawHubSkillOriginMock.mockResolvedValueOnce({
      version: 1,
      registry: "https://clawhub.com",
      slug: "daily-dca",
      installedVersion: "1.2.3",
      installedAt: 123,
      permissions: {
        version: 1,
        walletActions: {
          actions: ["quote", "swap"],
          autonomous: true,
        },
        risky: true,
        digest: "digest",
      },
      lastUpdateReview: {
        version: 1,
        approvalRequired: false,
        reasons: [],
        permissionDigestChanged: false,
        nextPermissionDigest: "digest",
        addedScanFindings: [],
      },
    });

    await runCli(["skills", "permissions", "daily-dca"]);

    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("daily-dca"));
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("review: clean"));
  });

  it.skip("legacy: installed ClawHub skills through marketplace checks", async () => {
    await runCli([
      "skills",
      "marketplace",
      "install",
      "daily-dca",
      "--version",
      "1.2.3",
      "--registry",
      "https://clawhub.com",
    ]);

    expect(installSkillFromClawHubMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/tmp/workspace",
        slug: "daily-dca",
        version: "1.2.3",
        baseUrl: "https://clawhub.com",
        allowPermissionChanges: false,
        force: false,
      }),
    );
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("Installed daily-dca@1.0.0"));
  });

  it.skip("legacy: previewed ClawHub skill installs", async () => {
    await runCli([
      "skills",
      "marketplace",
      "install",
      "daily-dca",
      "--version",
      "1.2.3",
      "--registry",
      "https://clawhub.com",
      "--dry-run",
    ]);

    expect(previewSkillInstallFromClawHubMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/tmp/workspace",
        slug: "daily-dca",
        version: "1.2.3",
        baseUrl: "https://clawhub.com",
      }),
    );
    expect(installSkillFromClawHubMock).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("Install preview daily-dca@1.0.0"),
    );
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("Permissions: wallet actions: swap"),
    );
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("Archive:"));
  });

  it.skip("legacy: previewed ClawHub skill updates", async () => {
    previewSkillsUpdateFromClawHubMock.mockResolvedValueOnce([
      {
        ok: true,
        slug: "daily-dca",
        previousVersion: "1.0.0",
        version: "1.1.0",
        changed: true,
        targetDir: "/tmp/workspace/skills/daily-dca",
        permissions: {
          version: 1,
          risky: true,
          digest: "digest2",
          walletActions: {
            actions: ["swap"],
          },
        },
        installScan: {
          version: 1,
          fileCount: 2,
          totalBytes: 20,
          findings: [],
          blocked: false,
        },
        updateReview: {
          version: 1,
          approvalRequired: true,
          reasons: ["requested permissions changed"],
          permissionDigestChanged: true,
          previousPermissionDigest: "digest",
          nextPermissionDigest: "digest2",
          addedScanFindings: [],
        },
      },
    ]);

    await runCli(["skills", "marketplace", "update", "daily-dca", "--dry-run"]);

    expect(previewSkillsUpdateFromClawHubMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/tmp/workspace",
        slug: "daily-dca",
      }),
    );
    expect(updateSkillsFromClawHubMock).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("approval required: requested permissions changed"),
    );
  });

  it.skip("legacy: updated ClawHub skills", async () => {
    updateSkillsFromClawHubMock.mockResolvedValueOnce([
      {
        ok: true,
        slug: "daily-dca",
        previousVersion: "1.0.0",
        version: "1.1.0",
        changed: true,
        targetDir: "/tmp/workspace/skills/daily-dca",
        permissions: {
          version: 1,
          risky: true,
          digest: "digest2",
        },
        installScan: {
          version: 1,
          fileCount: 2,
          totalBytes: 20,
          findings: [],
          blocked: false,
        },
        updateReview: {
          version: 1,
          approvalRequired: true,
          reasons: ["requested permissions changed"],
          permissionDigestChanged: true,
          previousPermissionDigest: "digest",
          nextPermissionDigest: "digest2",
          addedScanFindings: [],
        },
      },
    ]);

    await runCli(["skills", "marketplace", "update", "--approve-permission-change"]);

    expect(updateSkillsFromClawHubMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/tmp/workspace",
        slug: undefined,
        allowPermissionChanges: true,
      }),
    );
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("approval required: requested permissions changed"),
    );
  });
});
