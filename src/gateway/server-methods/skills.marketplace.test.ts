import { beforeEach, describe, expect, it, vi } from "vitest";

const searchSkillsFromClawHub = vi.hoisted(() => vi.fn());
const installSkillFromClawHub = vi.hoisted(() => vi.fn());
const previewSkillInstallFromClawHub = vi.hoisted(() => vi.fn());
const previewSkillsUpdateFromClawHub = vi.hoisted(() => vi.fn());
const updateSkillsFromClawHub = vi.hoisted(() => vi.fn());
const fetchClawHubSkillDetail = vi.hoisted(() => vi.fn());
const buildSkillsMarketplaceRows = vi.hoisted(() => vi.fn());
const buildWalletActionsGrant = vi.hoisted(() => vi.fn());
const applySkillWalletGrantConfig = vi.hoisted(() => vi.fn());
const clearSkillWalletGrantConfig = vi.hoisted(() => vi.fn());
const writeConfigFile = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("../../config/config.js", () => ({
  loadConfig: vi.fn(() => ({
    agents: {
      list: [{ id: "main" }, { id: "research" }],
    },
    skills: {
      marketplace: {
        allowRegistries: ["https://clawhub.com"],
      },
    },
  })),
  writeConfigFile,
}));

vi.mock("../../agents/agent-scope.js", () => ({
  listAgentIds: vi.fn(() => ["main", "research"]),
  resolveDefaultAgentId: vi.fn(() => "main"),
  resolveAgentWorkspaceDir: vi.fn((_config, agentId = "main") => `/tmp/fased-workspace-${agentId}`),
}));

vi.mock("../../utils.js", () => ({
  CONFIG_DIR: "/tmp/fased-config",
}));

vi.mock("../../agents/skills-clawhub.js", () => ({
  searchSkillsFromClawHub,
  installSkillFromClawHub,
  previewSkillInstallFromClawHub,
  previewSkillsUpdateFromClawHub,
  updateSkillsFromClawHub,
}));

vi.mock("../../infra/clawhub.js", () => ({
  fetchClawHubSkillDetail,
}));

vi.mock("../../cli/skills-marketplace-list.js", () => ({
  buildSkillsMarketplaceRows,
}));

vi.mock("../../cli/skills-wallet-grant.js", () => ({
  buildWalletActionsGrant,
  applySkillWalletGrantConfig,
  clearSkillWalletGrantConfig,
}));

const { skillsHandlers } = await import("./skills.js");

type RespondCall = [boolean, unknown?, { code: number; message: string }?];

function createInvoke(method: keyof typeof skillsHandlers, params: Record<string, unknown>) {
  const respond = vi.fn();
  return {
    respond,
    invoke: async () =>
      await skillsHandlers[method]({
        params,
        respond: respond as never,
        context: {} as never,
        client: null,
        req: { type: "req", id: "req-1", method },
        isWebchatConnect: () => false,
      }),
  };
}

describe("skills ClawHub marketplace RPC handlers", () => {
  beforeEach(() => {
    searchSkillsFromClawHub.mockReset();
    installSkillFromClawHub.mockReset();
    previewSkillInstallFromClawHub.mockReset();
    previewSkillsUpdateFromClawHub.mockReset();
    updateSkillsFromClawHub.mockReset();
    fetchClawHubSkillDetail.mockReset();
    buildSkillsMarketplaceRows.mockReset();
    buildWalletActionsGrant.mockReset();
    applySkillWalletGrantConfig.mockReset();
    clearSkillWalletGrantConfig.mockReset();
    writeConfigFile.mockClear();
  });

  it("does not register public marketplace acquisition handlers", () => {
    for (const method of [
      "skills.search",
      "skills.detail",
      "skills.marketplace.install",
      "skills.marketplace.install.preview",
      "skills.marketplace.update",
      "skills.marketplace.update.preview",
    ]) {
      expect(skillsHandlers).not.toHaveProperty(method);
    }
    expect(searchSkillsFromClawHub).not.toHaveBeenCalled();
    expect(installSkillFromClawHub).not.toHaveBeenCalled();
    expect(updateSkillsFromClawHub).not.toHaveBeenCalled();
  });

  it("lists wallet skill grants from tracked marketplace skills and config-only grants", async () => {
    buildSkillsMarketplaceRows.mockResolvedValue([
      {
        skillId: "daily-dca",
        source: "clawhub",
        registry: "https://clawhub.com",
        version: "1.0.0",
        requestedWalletActions: { actions: ["swap"], roles: ["agent"] },
        requestedToolAccess: null,
        requestedInstall: null,
        requestedPermissionRisky: true,
        requestedPermissionDigest: "digest",
        grantedWalletActions: null,
        installScan: null,
        lastUpdateReview: null,
        autonomousRequested: false,
        autonomousGranted: false,
        cronRequested: false,
        cronGranted: false,
      },
      {
        skillId: "docs-helper",
        source: "clawhub",
        registry: "https://clawhub.com",
        version: "1.0.0",
        requestedWalletActions: null,
        requestedToolAccess: ["docs.read"],
        requestedInstall: null,
        requestedPermissionRisky: false,
        requestedPermissionDigest: null,
        grantedWalletActions: null,
        installScan: null,
        lastUpdateReview: null,
        autonomousRequested: false,
        autonomousGranted: false,
        cronRequested: false,
        cronGranted: false,
      },
    ]);

    const { respond, invoke } = createInvoke("skills.wallet.grants", {
      agentId: "research",
    });
    await invoke();

    expect(buildSkillsMarketplaceRows).toHaveBeenCalledWith({
      workspaceDir: "/tmp/fased-workspace-research",
      config: expect.any(Object),
    });
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    expect(call?.[1]).toMatchObject({
      workspaceDir: "/tmp/fased-workspace-research",
      rows: [{ skillId: "daily-dca", source: "clawhub" }],
    });
    expect(JSON.stringify(call?.[1])).not.toContain("docs-helper");
  });

  it("sets wallet skill grants through validated CLI grant helpers", async () => {
    const grant = { actions: ["swap"], roles: ["agent"], chains: ["solana"], maxAmount: "1000" };
    const nextConfig = {
      skills: { entries: { "daily-dca": { config: { walletActions: grant } } } },
    };
    buildWalletActionsGrant.mockReturnValue(grant);
    applySkillWalletGrantConfig.mockReturnValue(nextConfig);
    buildSkillsMarketplaceRows.mockResolvedValue([]);

    const { respond, invoke } = createInvoke("skills.wallet.grant.set", {
      skillId: "daily-dca",
      actions: ["swap"],
      walletId: ["agent-1"],
      chain: ["solana"],
      maxAmount: "1000",
    });
    await invoke();

    expect(buildWalletActionsGrant).toHaveBeenCalledWith({
      actions: ["swap"],
      registry: undefined,
      walletId: ["agent-1"],
      chain: ["solana"],
      inputMint: undefined,
      outputMint: undefined,
      maxAmount: "1000",
      maxSlippageBps: undefined,
      autonomous: undefined,
      cron: undefined,
    });
    expect(applySkillWalletGrantConfig).toHaveBeenCalledWith({
      config: expect.any(Object),
      skillId: "daily-dca",
      grant,
    });
    expect(writeConfigFile).toHaveBeenCalledWith(nextConfig);
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
  });

  it("clears wallet skill grants", async () => {
    const nextConfig = { skills: { entries: { "daily-dca": { config: {} } } } };
    clearSkillWalletGrantConfig.mockReturnValue(nextConfig);
    buildSkillsMarketplaceRows.mockResolvedValue([]);

    const { respond, invoke } = createInvoke("skills.wallet.grant.clear", {
      skillId: "daily-dca",
    });
    await invoke();

    expect(clearSkillWalletGrantConfig).toHaveBeenCalledWith({
      config: expect.any(Object),
      skillId: "daily-dca",
    });
    expect(writeConfigFile).toHaveBeenCalledWith(nextConfig);
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
  });
});
