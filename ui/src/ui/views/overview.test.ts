import { beforeEach, describe, expect, it, vi } from "vitest";

function installBrowserGlobals() {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem(key: string) {
      return storage.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      storage.set(key, value);
    },
    removeItem(key: string) {
      storage.delete(key);
    },
    clear() {
      storage.clear();
    },
  });
  vi.stubGlobal("navigator", { language: "en-US" });
}

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

function createOverviewProps(overrides: Record<string, unknown> = {}) {
  return {
    onboarding: false,
    managedMode: false,
    basePath: "",
    connected: true,
    hello: {
      ok: true,
      snapshot: {
        uptimeMs: 120_000,
        policy: { tickIntervalMs: 250 },
        authMode: "token",
      },
    },
    settings: {
      gatewayUrl: "ws://127.0.0.1:18789",
      token: "owner-token-for-overview-tests",
      sessionKey: "main",
      lastActiveSessionKey: "main",
      theme: "claw",
      themeMode: "system",
      chatFocusMode: false,
      chatShowThinking: true,
      chatShowToolCalls: true,
      splitRatio: 0.6,
      navCollapsed: false,
      navWidth: 220,
      navGroupsCollapsed: {},
      borderRadius: 50,
      locale: "en",
    },
    password: "",
    canSignOut: true,
    loginGrantInput: "",
    loginGrantPending: false,
    loginGrantError: null,
    lastError: null,
    authNotice: null,
    authSessionExpiresAt: null,
    authSessionIdleTimeoutSeconds: null,
    overviewAdvancedUnlocked: false,
    overviewSecretsRevealUntilMs: 0,
    presenceCount: 1,
    presenceEntries: [
      {
        host: "fc",
        ip: "172.17.110.221",
        mode: "gateway",
        version: "0.1.1",
        lastInputSeconds: 180,
        reason: "self",
        roles: ["gateway"],
        scopes: [],
      },
    ],
    sessionsCount: 3,
    cronEnabled: true,
    cronJobs: 0,
    cronActiveTasks: 0,
    cronNext: null,
    lastChannelsRefresh: null,
    federationToken: null,
    federationStatus: null,
    walletStatus: null,
    walletNamedWallets: [],
    defaultWalletId: null,
    miningAttachedWalletId: null,
    miningProfile: null,
    miningReadiness: null,
    miningStatus: null,
    miningHistory: null,
    agentsList: {
      defaultId: "main",
      mainKey: "main",
      scope: "workspace",
      agents: [{ id: "main", name: "Assistant" }],
    },
    usageResult: {
      updatedAt: Date.now(),
      startDate: "2026-05-18",
      endDate: "2026-05-19",
      sessions: [
        {
          key: "main:webchat:direct:test",
          agentId: "main",
          source: "chat",
          usage: {
            input: 1000,
            output: 500,
            cacheRead: 250,
            cacheWrite: 0,
            totalTokens: 1750,
            totalCost: 0,
            inputCost: 0,
            outputCost: 0,
            cacheReadCost: 0,
            cacheWriteCost: 0,
            missingCostEntries: 1,
          },
        },
      ],
      totals: {
        input: 1000,
        output: 500,
        cacheRead: 250,
        cacheWrite: 0,
        totalTokens: 1750,
        totalCost: 0,
        inputCost: 0,
        outputCost: 0,
        cacheReadCost: 0,
        cacheWriteCost: 0,
        missingCostEntries: 1,
      },
      aggregates: {
        messages: {
          total: 0,
          user: 0,
          assistant: 0,
          toolCalls: 0,
          toolResults: 0,
          errors: 0,
        },
        tools: { totalCalls: 0, uniqueTools: 0, tools: [] },
        byModel: [],
        byProvider: [],
        byAgent: [],
        byChannel: [],
        daily: [],
      },
    },
    usageLoading: false,
    dashboardLayout: {
      version: 1,
      columns: [
        { id: "work", title: "Tasks", width: "wide", widgets: ["agents", "usage"] },
        { id: "network", title: "Network", width: "normal", widgets: ["wallet", "mining"] },
      ],
    },
    dashboardWidgetDrawerOpen: false,
    onSettingsChange: () => undefined,
    onPasswordChange: () => undefined,
    onAuthStorageModeChange: () => undefined,
    onLoginGrantInputChange: () => undefined,
    onLoginGrantExchange: () => undefined,
    onSignOut: () => undefined,
    onUnlockAdvanced: () => undefined,
    onLockAdvanced: () => undefined,
    onRevealSecrets: () => undefined,
    onConnect: () => undefined,
    onRefresh: () => undefined,
    onNavigate: vi.fn(),
    onOpenAdminControl: vi.fn(),
    onOpenTaskPayment: vi.fn(),
    onOpenMining: vi.fn(),
    onOpenFederationReview: vi.fn(),
    onDashboardLayoutChange: vi.fn(),
    onDashboardWidgetDrawerOpen: vi.fn(),
    ...overrides,
  } as Record<string, unknown>;
}

describe("renderOverview dashboard", () => {
  beforeEach(() => {
    installBrowserGlobals();
  });

  it("starts with an Agents summary and leaves dashboard actions to the app topbar", async () => {
    const { renderOverview } = await import("./overview.ts");
    const text = flattenTemplateText(renderOverview(createOverviewProps() as never));

    expect(text).toContain("Agents");
    expect(text).not.toContain("Assistant");
    expect(text).toContain("Tasks");
    expect(text).not.toContain("Active tasks");
    expect(text).toContain("Sessions");
    expect(text).toContain("Tokens");
    expect(text).toContain("1.8K");
    expect(text).not.toContain("1 session");
    expect(text).not.toContain("Refresh dashboard");
    expect(text).not.toContain("Launch");
    expect(text).not.toContain("Start chat");
    expect(text).not.toContain("Catalog");
    expect(text).not.toContain("Provider catalog detail");
    expect(text).not.toContain("Plugin runtime detail");
  });

  it("renders dashboard usage from 7 day daily ledger data", async () => {
    const { renderOverview } = await import("./overview.ts");
    const text = flattenTemplateText(
      renderOverview(
        createOverviewProps({
          usageResult: {
            updatedAt: Date.now(),
            startDate: "2026-05-13",
            endDate: "2026-05-19",
            sessions: [
              {
                key: "session-1",
                source: "chat",
                label: "Chat",
                updatedAt: Date.parse("2026-05-19T00:00:00.000Z"),
                usage: {
                  input: 350,
                  output: 350,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 700,
                  totalCost: 0,
                  inputCost: 0,
                  outputCost: 0,
                  cacheReadCost: 0,
                  cacheWriteCost: 0,
                  missingCostEntries: 1,
                },
              },
            ],
            totals: {
              input: 1000,
              output: 1000,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2000,
              totalCost: 0,
              inputCost: 0,
              outputCost: 0,
              cacheReadCost: 0,
              cacheWriteCost: 0,
              missingCostEntries: 1,
            },
            aggregates: {
              messages: {
                total: 0,
                user: 0,
                assistant: 0,
                toolCalls: 0,
                toolResults: 0,
                errors: 0,
              },
              tools: { totalCalls: 0, uniqueTools: 0, tools: [] },
              byModel: [],
              byProvider: [],
              byAgent: [],
              byChannel: [],
              daily: [
                { date: "2026-05-13", tokens: 100, cost: 0, messages: 0, toolCalls: 0, errors: 0 },
                { date: "2026-05-14", tokens: 100, cost: 0, messages: 0, toolCalls: 0, errors: 0 },
                { date: "2026-05-15", tokens: 100, cost: 0, messages: 0, toolCalls: 0, errors: 0 },
                { date: "2026-05-16", tokens: 100, cost: 0, messages: 0, toolCalls: 0, errors: 0 },
                { date: "2026-05-17", tokens: 100, cost: 0, messages: 0, toolCalls: 0, errors: 0 },
                { date: "2026-05-18", tokens: 100, cost: 0, messages: 0, toolCalls: 0, errors: 0 },
                { date: "2026-05-19", tokens: 100, cost: 0, messages: 0, toolCalls: 0, errors: 0 },
              ],
            },
          },
        }) as never,
      ),
    );

    expect(text).toContain("Tokens");
    expect(text).toContain("700");
    expect(text).not.toContain("1 session");
    expect(text).toContain("7d tokens");
    expect(text).toContain("7d 2026-05-19: 100 tokens");
    expect(text).not.toContain("2.0K");
  });

  it("groups dashboard wallets by role with loaded balances", async () => {
    const { renderOverview } = await import("./overview.ts");
    const text = flattenTemplateText(
      renderOverview(
        createOverviewProps({
          walletNamedWallets: [
            {
              id: "agent-wallet",
              name: "Agent wallet",
              providerId: "local-socket-signer",
              metadata: { role: "agent" },
              addresses: { solana: "agent-sol" },
              readiness: { keystore: true, rpc: true },
              createdAt: "2026-05-19T00:00:00.000Z",
              updatedAt: "2026-05-19T00:00:00.000Z",
            },
            {
              id: "mining-wallet",
              name: "Mining wallet",
              providerId: "local-socket-signer",
              metadata: { role: "mining" },
              addresses: { solana: "mining-sol" },
              balances: { solana: "2000000000" },
              readiness: { keystore: true, rpc: true },
              createdAt: "2026-05-19T00:00:00.000Z",
              updatedAt: "2026-05-19T00:00:00.000Z",
            },
            {
              id: "vault-wallet",
              name: "Vault wallet",
              providerId: "local-socket-signer",
              metadata: { role: "vault" },
              addresses: { solana: "vault-sol" },
              balances: { solana: "500000000" },
              readiness: { keystore: true, rpc: true },
              createdAt: "2026-05-19T00:00:00.000Z",
              updatedAt: "2026-05-19T00:00:00.000Z",
            },
          ],
          walletStatus: {
            wallets: [
              {
                id: "agent-wallet",
                name: "Agent wallet",
                providerId: "local-socket-signer",
                balances: { solana: "1500000000" },
                readiness: { keystore: true, rpc: true },
              },
            ],
          },
          defaultWalletId: "agent-wallet",
          miningAttachedWalletId: "mining-wallet",
        }) as never,
      ),
    );

    expect(text).toContain("Agent");
    expect(text).toContain("Mining");
    expect(text).toContain("Vault");
    expect(text).toContain("1.5 SOL");
    expect(text).toContain("2 SOL");
    expect(text).toContain("0.5 SOL");
    expect(text).not.toContain("250 SAT");
    expect(text).not.toContain("SAT n/a");
    expect(text).not.toContain("Source: wallet.status");
    expect(text).not.toContain("wallet status unavailable");
  });

  it("renders mining card with inline status, SAT history, and capital counters", async () => {
    const { renderOverview } = await import("./overview.ts");
    const text = flattenTemplateText(
      renderOverview(
        createOverviewProps({
          miningStatus: {
            running: true,
            enabledWanted: true,
            network: "devnet",
            riskMode: "balanced",
            blocked: false,
            currentSatBalanceRaw: "123000000000",
            currentCapitalLockedLamports: "250000000",
          },
          miningHistory: {
            window: "7d",
            activityWindow: "7d",
            latestCycleId: 2,
            totalStoredOutcomeCount: 2,
            matchingOutcomeCount: 2,
            sampled: false,
            windowStartAt: null,
            dataStartAt: null,
            dataEndAt: null,
            outcomes: [
              { cycleId: 1, totalSatEarnedRaw: "100000000000", netLiveCostLamports: "0" },
              { cycleId: 2, totalSatEarnedRaw: "200000000000", netLiveCostLamports: "0" },
            ],
            activityOutcomes: [],
            totalStoredActionCount: 0,
            matchingActionCount: 0,
            actionWindowStartAt: null,
            actionDataStartAt: null,
            actionDataEndAt: null,
            actions: [],
            updatedAt: "2026-05-19T00:00:00.000Z",
          },
        }) as never,
      ),
    );

    expect(text).toContain("Mining");
    expect(text).toContain("Started");
    expect(text).toContain("SAT");
    expect(text).not.toContain("Satcoin");
    expect(text).toContain("1.23");
    expect(text).toContain("Capital");
    expect(text).toContain("0.25");
    expect(text).toContain("0.25 locked");
    expect(text).not.toContain("0.25 SOL");
    expect(text).toContain("7d SAT");
    expect(text).not.toContain("Source: sat.mining.status");
    expect(text).not.toContain("Mining runtime");
  });

  it("renders mining dashboard capital as funded capital, not only locked capital", async () => {
    const { renderOverview } = await import("./overview.ts");
    const text = flattenTemplateText(
      renderOverview(
        createOverviewProps({
          miningStatus: {
            running: true,
            enabledWanted: true,
            network: "devnet",
            riskMode: "balanced",
            blocked: false,
            currentSatBalanceRaw: "0",
            currentCapitalFundedLamports: "9998215011",
            currentCapitalLockedLamports: "7950000000",
          },
          miningReadiness: {
            ok: true,
            selectedWalletId: "mining",
            selectedAddress: "miner",
            signerCapability: "background-ready",
            checks: [],
            warnings: [],
            balances: {
              satBalanceRaw: "28618000000000",
              minerCapitalFundedLamports: "9998215011",
              minerCapitalLockedLamports: "7950000000",
            },
          },
        }) as never,
      ),
    );

    expect(text).toContain("SAT");
    expect(text).toContain("286.18");
    expect(text).toContain("Capital");
    expect(text).toContain("9.998");
    expect(text).toContain("7.95 locked");
  });

  it("renders Fased Network as a compact card with URL path and bond counters", async () => {
    const { renderOverview } = await import("./overview.ts");
    const text = flattenTemplateText(
      renderOverview(
        createOverviewProps({
          dashboardLayout: {
            version: 1,
            columns: [{ id: "network", title: "Network", width: "normal", widgets: ["network"] }],
          },
          federationStatus: {
            managed: true,
            sourcePath: "/home/fc/.fased/fased.json",
            joined: true,
            lifecycle: "active",
            checkedAt: "2026-05-19T00:00:00.000Z",
            token: {
              tokenId: "token-1",
              nodeId: "node-1",
              handle: "very-long-fased-network-handle",
              issuedAt: "2026-05-19T00:00:00.000Z",
              expiresAt: "2026-06-19T00:00:00.000Z",
              scopes: ["marketplace"],
              signature: "sig",
              trustState: "verified",
              hostedState: "ready",
              publicUrl: "https://ff1.fased.app/@fased-agent-399384eb6814",
              paidFlowEligible: true,
              bondStatus: "active",
              bondTier: "operator-bond",
              bondAmountRaw: "250000000000000",
            },
            bond: {
              exists: true,
              source: "token",
              status: "active",
              tier: "operator-bond",
              amountRaw: "250000000000000",
              staking: {
                position: {
                  exists: true,
                  status: "active",
                  estimatedClaimableRewardRaw: "15892931913534",
                  claimableRewardRaw: "0",
                },
              },
            },
          },
        }) as never,
      ),
    );

    expect(text).toContain("@fase...6814");
    expect(text).toContain("2.5K");
    expect(text).toContain("Bond");
    expect(text).toContain("158.93");
    expect(text).toContain("Claim");
    expect(text).not.toContain("Fased Network");
    expect(text).not.toContain("Copy Fased Network URL");
    expect(text).not.toContain("ff1.fased.app/@fased-agent-399384eb6814");
    expect(text).not.toContain("very-long-fased-network-handle");
    expect(text).not.toContain("very-long-...ork-handle");
    expect(text).not.toContain("Trust state: verified");
    expect(text).not.toContain("Public reachability: ready");
    expect(text).not.toContain("Paid flow: eligible");
    expect(text).not.toContain("Bond state: active · operator-bond");
    expect(text).not.toContain("Source: federation.status");
    expect(text).not.toContain("Checked 2026-05-19T00:00:00.000Z");
  });

  it("does not render removed gateway, runtime, or memory widgets", async () => {
    const { renderOverview } = await import("./overview.ts");
    const text = flattenTemplateText(
      renderOverview(
        createOverviewProps({
          memoryInventory: {
            agentId: "main",
            workspace: {
              path: "/tmp/fased/main",
              exists: true,
              memoryRoots: [],
            },
            backend: {
              configured: "builtin",
              active: "builtin",
              citations: "auto",
              files: 2,
              chunks: 8,
            },
            qmd: { enabled: false },
            sessionMemory: {
              hookConfigured: true,
              enabled: true,
              messages: 24,
              llmSlug: false,
              memoryDir: {
                path: "/tmp/fased/main/memory",
                exists: true,
                kind: "directory",
              },
            },
            memoryPlugin: {
              configuredSlot: null,
              enabled: false,
              registryLoaded: true,
              reason: "No active memory plugin loaded.",
            },
          },
          memoryValidation: {
            agentId: "main",
            ok: false,
            summary: { errors: 0, warnings: 2, info: 1 },
            findings: [],
          },
        }) as never,
      ),
    );

    expect(text).not.toContain("Gateway Access");
    expect(text).not.toContain("127.0.0.1:18789");
    expect(text).not.toContain("token ...ests");
    expect(text).not.toContain("auth token");
    expect(text).not.toContain("Runtime Clients");
    expect(text).not.toContain("1 recently active");
    expect(text).not.toContain("Sign out");
    expect(text).not.toContain("Memory");
    expect(text).not.toContain("2 warnings");
    expect(text).not.toContain("session archive enabled");
    expect(text).not.toContain("dry-run proposals");
  });

  it("keeps removed provider and extension widgets out of Overview", async () => {
    const { renderOverview } = await import("./overview.ts");
    const text = flattenTemplateText(
      renderOverview(
        createOverviewProps({
          modelCatalogStatus: {
            checkedAtMs: Date.now(),
            cache: { modelCatalog: "shared-loader", providerExtensionCatalog: "fresh-status-load" },
            totalProviders: 2,
            totalModels: 9,
            configuredProviders: 1,
            availableProviders: 1,
            reasoningModels: 4,
            visionModels: 2,
            capabilityCounts: {
              textModels: 9,
              visionModels: 2,
              reasoningModels: 4,
              toolsModels: 6,
              jsonModels: 6,
              audioModels: 0,
            },
            sourceCounts: { runtime: 3, "provider-index": 6 },
            providers: [],
            providerExtensionCatalog: {
              totalEntries: 0,
              loadedEntries: 0,
              skippedUntrustedEntries: 0,
              emptyEntries: 0,
              errorEntries: 0,
              modelCount: 6,
              loadedProviderIds: [],
              warnings: [],
              entries: [],
            },
            providerExtensionManifest: {
              upstreamProviderCount: 0,
              mappedProviderCount: 0,
              deferredProviderCount: 0,
              mappedProviderIds: [],
              deferredProviderIds: [],
              missingMappedProviderIds: [],
            },
          },
          pluginsMarketplace: {
            workspaceDir: "/tmp/fased/plugins",
            diagnostics: [],
            plugins: [
              {
                id: "demo",
                name: "Demo",
                version: "1.0.0",
                status: "loaded",
                origin: "workspace",
                discovered: true,
                managed: true,
                loaded: true,
                enabled: true,
                hasInstallRecord: true,
                install: null,
                channels: [],
                providers: [],
                toolNames: [],
                hookNames: [],
                gatewayMethods: [],
                cliCommands: [],
                services: [],
                commands: [],
                httpHandlers: 0,
                hookCount: 0,
                installOptions: {},
                runtimeHelpers: { sessions: { read: false } },
                actions: ["status"],
              },
            ],
          },
        }) as never,
      ),
    );

    expect(text).not.toContain("Providers");
    expect(text).not.toContain("1/2");
    expect(text).not.toContain("9 models");
    expect(text).not.toContain("Extensions");
    expect(text).not.toContain("1/1");
    expect(text).not.toContain("provider-index");
    expect(text).not.toContain("Command catalog detail");
  });
});
