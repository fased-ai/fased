import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentsProps } from "./agents.ts";

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
  vi.stubGlobal("navigator", { language: "en-US", clipboard: { writeText: vi.fn() } });
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

function createSkill() {
  return {
    name: "Repo Skill",
    description: "Skill description",
    source: "workspace",
    filePath: "/tmp/skill",
    baseDir: "/tmp",
    skillKey: "repo-skill",
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
  };
}

function createProps(overrides: Record<string, unknown> = {}): AgentsProps {
  return {
    basePath: "",
    loading: false,
    error: null,
    agentsList: {
      defaultId: "alpha",
      mainKey: "main",
      scope: "workspace",
      agents: [{ id: "alpha", name: "Alpha" } as never, { id: "beta", name: "Beta" } as never],
    },
    selectedAgentId: "beta",
    activePanel: "overview",
    config: {
      form: null,
      loading: false,
      saving: false,
      dirty: false,
    },
    connected: true,
    channelRuntimeBusy: {},
    configSchema: null,
    configSchemaLoading: false,
    configUiHints: {},
    channels: {
      snapshot: null,
      loading: false,
      error: null,
      lastSuccess: null,
    },
    sessions: {
      result: null,
      loading: false,
      error: null,
    },
    cron: {
      status: null,
      jobs: [],
      loading: false,
      error: null,
    },
    agentFiles: {
      list: null,
      loading: false,
      error: null,
      active: null,
      contents: {},
      drafts: {},
      saving: false,
    },
    agentIdentityLoading: false,
    agentIdentityError: null,
    agentIdentityById: {},
    agentSkills: {
      report: null,
      loading: false,
      error: null,
      agentId: null,
      filter: "",
    },
    toolsCatalog: {
      loading: false,
      error: null,
      result: null,
    },
    toolsEffective: {
      loading: false,
      error: null,
      result: null,
    },
    memory: {
      inventory: null,
      validation: null,
      loading: false,
      error: null,
    },
    providers: {
      catalogStatus: null,
      authStatus: null,
    },
    usage: {
      result: null,
      loading: false,
      error: null,
    },
    plugins: {
      marketplace: null,
    },
    wallet: {
      status: null,
      namedWallets: [],
      defaultWalletId: null,
    },
    mining: {
      attachedWalletId: null,
      profile: null,
      readiness: null,
      status: null,
    },
    federation: {
      token: null,
      status: null,
    },
    runtimeSessionKey: "main",
    runtimeSessionMatchesSelectedAgent: false,
    modelCatalog: [],
    skillEdits: {},
    skillsBusyKey: null,
    onNavigate: () => undefined,
    onOpenUsageForAgent: () => undefined,
    onRefresh: () => undefined,
    onSelectAgent: () => undefined,
    onSelectPanel: () => undefined,
    onLoadFiles: () => undefined,
    onSelectFile: () => undefined,
    onFileDraftChange: () => undefined,
    onFileReset: () => undefined,
    onFileSave: () => undefined,
    onToolsProfileChange: () => undefined,
    onToolsOverridesChange: () => undefined,
    onConfigPatch: () => undefined,
    onConfigRemove: () => undefined,
    onConfigReload: () => undefined,
    onConfigSave: () => undefined,
    onModelChange: () => undefined,
    onModelFallbacksChange: () => undefined,
    onTaskModelsChange: () => undefined,
    onAgentIdentityAvatarChange: () => undefined,
    onActiveModelProviderChange: () => undefined,
    onModelProviderChange: () => undefined,
    onSessionsRefresh: () => undefined,
    onSessionPatch: () => undefined,
    onSessionDelete: () => undefined,
    onSessionBranchCheckpoint: () => undefined,
    onSessionRestoreCheckpoint: () => undefined,
    onChannelsRefresh: () => undefined,
    onChannelEnable: () => undefined,
    onChannelStart: () => undefined,
    onChannelStop: () => undefined,
    onChannelLogout: () => undefined,
    onCronRefresh: () => undefined,
    onCronEdit: () => undefined,
    onCronRunNow: () => undefined,
    onCronToggle: () => undefined,
    onCronRepair: () => undefined,
    onCronQueueControl: () => undefined,
    onCronRemove: () => undefined,
    onCronCreate: () => undefined,
    onSkillsFilterChange: () => undefined,
    onSkillsRefresh: () => undefined,
    onAgentSkillToggle: () => undefined,
    onAgentSkillsClear: () => undefined,
    onAgentSkillsNarrowToSelected: () => undefined,
    onAgentSkillsDisableAll: () => undefined,
    onSkillEdit: () => undefined,
    onSkillSaveKey: () => undefined,
    onSkillInstall: () => undefined,
    onSkillEnabledChange: () => undefined,
    onSessionMemoryEnabledChange: () => undefined,
    onSetDefault: () => undefined,
    agentCreateBusy: false,
    agentCreateMessage: null,
    onCreateAgent: () => undefined,
    ...overrides,
  } as unknown as AgentsProps;
}

describe("renderAgents", () => {
  beforeEach(() => {
    installBrowserGlobals();
  });

  it("shows the skills count only for the selected agent's report", async () => {
    const { renderAgents } = await import("./agents.ts");
    const text = flattenTemplateText(
      renderAgents(
        createProps({
          agentSkills: {
            report: {
              workspaceDir: "/tmp/workspace",
              managedSkillsDir: "/tmp/skills",
              skills: [createSkill()],
            },
            loading: false,
            error: null,
            agentId: "alpha",
            filter: "",
          },
        }),
      ),
    );

    expect(text).toContain("Skills");
    expect(text).not.toContain("Skills(1)");
  });

  it("shows the selected agent's skills count when the report matches", async () => {
    const { renderAgents } = await import("./agents.ts");
    const text = flattenTemplateText(
      renderAgents(
        createProps({
          agentSkills: {
            report: {
              workspaceDir: "/tmp/workspace",
              managedSkillsDir: "/tmp/skills",
              skills: [createSkill()],
            },
            loading: false,
            error: null,
            agentId: "beta",
            filter: "",
          },
        }),
      ),
    );

    expect(text).toContain("Skills");
    expect(text).toContain("1 ready");
  });

  it("renders the setup checklist with compact live operations metrics", async () => {
    const { renderAgents } = await import("./agents.ts");
    const text = flattenTemplateText(
      renderAgents(
        createProps({
          providers: {
            catalogStatus: {
              totalProviders: 2,
              configuredProviders: 1,
              totalModels: 12,
              providers: [],
            },
            authStatus: {
              storePath: "/tmp/auth-profiles.json",
              warnAfterMs: 86_400_000,
              providers: [
                {
                  provider: "openai",
                  status: "ok",
                  effective: { kind: "profiles", detail: "default profile" },
                  profiles: [],
                },
                {
                  provider: "anthropic",
                  status: "missing",
                  effective: { kind: "missing", detail: "no credential" },
                  profiles: [],
                },
              ],
            },
          },
          memory: {
            loading: false,
            error: null,
            inventory: {
              agentId: "main",
              workspace: { path: "/tmp/ws", exists: true, memoryRoots: [] },
              backend: {
                configured: "builtin",
                active: "builtin",
                citations: "auto",
                files: 1,
                chunks: 2,
              },
              qmd: { enabled: false },
              sessionMemory: {
                hookConfigured: false,
                enabled: false,
                messages: 0,
                llmSlug: false,
                memoryDir: {
                  path: "/tmp/ws/memory",
                  exists: true,
                  kind: "directory",
                  markdownFiles: 0,
                },
                filenameDiagnostics: { checked: true, status: "ok", groups: [] },
              },
              memoryPlugin: { configuredSlot: null, enabled: false, registryLoaded: true },
            },
            validation: {
              agentId: "main",
              ok: true,
              summary: { errors: 0, warnings: 0, info: 0 },
              findings: [],
            },
          },
          wallet: {
            status: {
              enabled: true,
              managedMode: true,
              mode: "managed",
              runtime: "local-socket-signer",
              settlement: {
                class: "real-chain",
                realChainReady: true,
                summary: "Solana ready",
              },
              service: { host: "127.0.0.1", port: 1, healthy: true },
              chains: ["solana"],
              policy: {
                executionMode: "manual",
                directSigning: false,
                toolAccessMode: "owner-only",
                allowAgents: [],
                solana: { allowPrograms: [], maxPerTx: "0", maxDaily: "0" },
              },
              approvalAuth: {
                mode: "none",
                ready: false,
                passkeyCount: 0,
                notes: [],
                passkeys: [],
                statePath: "",
              },
              custody: {
                mode: "single-key",
                target: { walletId: "agent", role: "agent" },
                scope: {
                  chains: ["solana"],
                  allowPrograms: [],
                  solana: { maxPerTx: "0", maxDaily: "0" },
                },
                unlock: { active: false },
                phase2: {
                  complete: false,
                  splitKeyEnabled: false,
                  passkeyCeremonyEnabled: false,
                  ephemeralReconstructionEnabled: false,
                  notes: [],
                },
              },
              paths: { rootDir: "", keysPath: "", pidPath: "" },
              checkedAt: "2026-05-07T00:00:00Z",
              startupState: "healthy",
              authState: "ok",
            },
            namedWallets: [{ id: "agent", name: "Agent", providerId: "local-socket-signer" }],
            defaultWalletId: "agent",
          },
          mining: {
            attachedWalletId: "miner",
            profile: { walletId: "miner", network: "devnet", riskMode: "balanced" },
            readiness: { ok: true, checks: [], warnings: [], balances: {} },
            status: { running: false, walletId: "miner", network: "devnet", riskMode: "balanced" },
          },
          federation: {
            token: null,
            status: {
              managed: false,
              sourcePath: "/tmp/federation.json",
              joined: true,
              lifecycle: "active",
              checkedAt: "2026-05-07T00:00:00Z",
            },
          },
        }),
      ),
    );

    expect(text).toContain("Agent");
    expect(text).toContain("Models");
    expect(text).toContain("OpenAI");
    expect(text).toContain("Memory");
    expect(text).toContain("Skills");
    expect(text).toContain("Channels");
    expect(text).toContain("Tasks");
    expect(text).toContain("Sessions");
    expect(text).not.toContain("Wallet");
    expect(text).not.toContain("Mining");
    expect(text).not.toContain("Network");
  });

  it("presents agents as assembly with services and subagent boundaries", async () => {
    const { renderAgents } = await import("./agents.ts");
    const text = flattenTemplateText(
      renderAgents(
        createProps({
          providers: {
            catalogStatus: null,
            authStatus: {
              storePath: "/tmp/auth-profiles.json",
              warnAfterMs: 86_400_000,
              providers: [
                {
                  provider: "openai",
                  status: "ok",
                  effective: { kind: "profiles", detail: "openai:default" },
                  profiles: [],
                },
              ],
            },
          },
          modelCatalog: [{ id: "gpt-5.4-mini", name: "GPT-5.4 Mini", provider: "openai" }],
        }),
      ),
    );

    expect(text).toContain("Agent");
    expect(text).toContain("Name");
    expect(text).toContain("Generated ID");
    expect(text).toContain("Workspace");
    expect(text).toContain("Provider");
    expect(text).toContain("Default model");
    expect(text).toContain("GPT-5.4 Mini");
    expect(text).not.toContain("Delete Agent");
    expect(text).not.toContain("Select Agent");
    expect(text).toContain("Agent");
    expect(text).toContain("Models");
    expect(text).toContain("Channels");
    expect(text).toContain("Tasks");
    expect(text).toContain("Sessions");
    expect(text).not.toContain("Connect services");
    expect(text).not.toContain("Gmail, calendars, GitHub, web/search");
    expect(text).not.toContain("Subagents are runtime delegation workers");
  });

  it("makes provider-backed model attachment and source pages explicit", async () => {
    const { renderAgents } = await import("./agents.ts");
    const text = flattenTemplateText(
      renderAgents(
        createProps({
          config: {
            form: {
              agents: {
                defaults: { model: "openai/gpt-5.4-mini" },
                list: [{ id: "beta", name: "Beta", model: "anthropic/claude-sonnet-4-5" }],
              },
            },
            loading: false,
            saving: false,
            dirty: false,
          },
          providers: {
            catalogStatus: {
              totalProviders: 2,
              configuredProviders: 2,
              totalModels: 24,
              providers: [],
            },
            authStatus: {
              storePath: "/tmp/auth-profiles.json",
              warnAfterMs: 86_400_000,
              providers: [
                {
                  provider: "openai",
                  status: "ok",
                  effective: { kind: "profiles", detail: "openai:api" },
                  profiles: [],
                },
                {
                  provider: "anthropic",
                  status: "ok",
                  effective: { kind: "profiles", detail: "anthropic:api" },
                  profiles: [],
                },
              ],
            },
          },
          modelCatalog: [
            { id: "gpt-5.4-mini", name: "GPT-5.4 Mini", provider: "openai" },
            {
              id: "anthropic.claude-sonnet-4",
              name: "Legacy Bedrock Claude",
              provider: "amazon-bedrock",
            },
            {
              id: "claude-sonnet-4-5",
              name: "Claude Sonnet 4.5",
              provider: "anthropic",
            },
          ],
        }),
      ),
    );

    expect(text).toContain("Provider");
    expect(text).toContain("Default model");
    expect(text).toContain("anthropic/claude-sonnet-4-5");
    expect(text).not.toContain("Legacy Bedrock Claude");
    expect(text).not.toContain("amazon-bedrock");
    expect(text).toContain("Models");
    expect(text).not.toContain("Source pages stay separate");
  });

  it("shows the selected Agent's inbound channel routes and cron bindings", async () => {
    const { renderAgents } = await import("./agents.ts");
    const text = flattenTemplateText(
      renderAgents(
        createProps({
          config: {
            form: {
              bindings: [
                { agentId: "beta", match: { channel: "telegram", accountId: "ops" } },
                {
                  agentId: "beta",
                  match: {
                    channel: "discord",
                    accountId: "guild",
                    peer: { kind: "channel", id: "dev" },
                  },
                },
                { agentId: "alpha", match: { channel: "telegram", accountId: "sales" } },
              ],
            },
            loading: false,
            saving: false,
            dirty: false,
          },
          channels: {
            snapshot: {
              ts: 0,
              channelOrder: ["telegram", "discord"],
              channelLabels: { telegram: "Telegram", discord: "Discord" },
              channels: {},
              channelAccounts: {
                telegram: [
                  { accountId: "ops", name: "Ops Bot", configured: true, running: true },
                  { accountId: "sales", name: "Sales Bot", configured: true, running: true },
                ],
                discord: [
                  { accountId: "guild", name: "Guild Bot", configured: true, running: false },
                ],
              },
              channelDefaultAccountId: { telegram: "ops", discord: "guild" },
            },
            loading: false,
            error: null,
            lastSuccess: 0,
          },
          cron: {
            status: { enabled: true, jobs: 2, nextWakeAtMs: null },
            jobs: [
              { id: "job-1", name: "Daily report", agentId: "beta", enabled: true } as never,
              { id: "job-2", name: "Alpha cleanup", agentId: "alpha", enabled: true } as never,
            ],
            loading: false,
            error: null,
          },
        }),
      ),
    );

    expect(text).toContain("Channels");
    expect(text).toContain("Telegram");
    expect(text).toContain("Discord");
    expect(text).toContain("Tasks");
    expect(text).toContain("Task");
    expect(text).not.toContain("Agent routes");
    expect(text).not.toContain("Scheduled work for this Agent");
    expect(text).not.toContain("Sales Bot");
    expect(text).not.toContain("Alpha cleanup");
  });

  it("offers service attachment actions for an Agent", async () => {
    const { renderAgents } = await import("./agents.ts");
    const text = flattenTemplateText(
      renderAgents(
        createProps({
          config: {
            form: {
              agents: {
                list: [{ id: "beta", name: "Beta", skills: [], tools: { profile: "minimal" } }],
              },
            },
            loading: false,
            saving: false,
            dirty: false,
          },
          agentSkills: {
            report: {
              workspaceDir: "/tmp/workspace",
              managedSkillsDir: "/tmp/skills",
              skills: [
                { ...createSkill(), name: "gog", skillKey: "gog", description: "Google Workspace" },
                { ...createSkill(), name: "github", skillKey: "github", description: "GitHub CLI" },
              ],
            },
            loading: false,
            error: null,
            agentId: "beta",
            filter: "",
          },
        }),
      ),
    );

    expect(text).toContain("Skills");
    expect(text).toContain("2 ready");
    expect(text).not.toContain("Service tool grants");
    expect(text).not.toContain("Grant gog");
    expect(text).not.toContain("Grant github");
  });

  it("renders the first-run setup checklist in the intended order with actionable labels", async () => {
    const { renderAgents } = await import("./agents.ts");
    const text = flattenTemplateText(
      renderAgents(
        createProps({
          agentSkills: {
            report: {
              workspaceDir: "/tmp/workspace",
              managedSkillsDir: "/tmp/skills",
              skills: [
                {
                  ...createSkill(),
                  name: "Needs API",
                  skillKey: "needs-api",
                  primaryEnv: "OPENAI_API_KEY",
                  missing: { bins: [], env: ["OPENAI_API_KEY"], config: [], os: [] },
                },
                {
                  ...createSkill(),
                  name: "Needs Binary",
                  skillKey: "needs-bin",
                  missing: { bins: ["ripgrep"], env: [], config: [], os: [] },
                  install: [{ id: "rg", label: "Install ripgrep" }],
                },
                {
                  ...createSkill(),
                  name: "Disabled Skill",
                  skillKey: "disabled-skill",
                  disabled: true,
                },
              ],
            },
            loading: false,
            error: null,
            agentId: "beta",
            filter: "",
          },
          memory: {
            inventory: {
              agentId: "beta",
              workspace: {
                path: "/tmp/workspace",
                exists: true,
                memoryRoots: [
                  {
                    id: "memory.md",
                    path: "/tmp/workspace/memory.md",
                    exists: false,
                    kind: "missing",
                  },
                ],
              },
              backend: { configured: "builtin", active: "builtin", citations: "auto" },
              qmd: { enabled: false },
              sessionMemory: { hookConfigured: true, enabled: false, messages: 0, llmSlug: false },
              memoryPlugin: { configuredSlot: null, enabled: false, registryLoaded: true },
            },
            validation: {
              agentId: "beta",
              ok: true,
              summary: { errors: 0, warnings: 0, info: 0 },
              findings: [],
            },
            loading: false,
            error: null,
          },
          channels: {
            snapshot: {
              ts: 0,
              channelOrder: ["discord"],
              channelLabels: { discord: "Discord" },
              channels: {},
              channelAccounts: {
                discord: [{ accountId: "primary", configured: false, running: false }],
              },
              channelDefaultAccountId: { discord: "primary" },
            },
            loading: false,
            error: null,
            lastSuccess: 0,
          },
        }),
      ),
    );

    expect(text).toContain("Beta");
    expect(text).toContain("Memory");
    expect(text).toContain("Skills");
    expect(text).toContain("Models");
    expect(text).toContain("Channels");
    expect(text).toContain("Tasks");
    expect(text).toContain("Sessions");
    expect(text).toContain("Provider");
    expect(text).toContain("Model");
    expect(text).toContain("0 ready");
    expect(text).not.toContain("Enable memory archive");
    expect(text).not.toContain("Install dependency");
    expect(text).not.toContain("Connect services");
    expect(text).not.toContain("Wallet policy");
    expect(text).not.toContain("Create task");
  });

  it("explains that workspace core files are user-owned", async () => {
    const { renderAgents } = await import("./agents.ts");
    const text = flattenTemplateText(
      renderAgents(
        createProps({
          activePanel: "files",
          agentFiles: {
            list: {
              agentId: "beta",
              workspace: "/tmp/workspace",
              files: [
                {
                  name: "AGENTS.md",
                  path: "/tmp/workspace/AGENTS.md",
                  missing: false,
                  size: 20,
                  updatedAtMs: Date.now(),
                },
              ],
            },
            loading: false,
            error: null,
            active: null,
            contents: {},
            drafts: {},
            saving: false,
          },
        }),
      ),
    );

    expect(text).toContain("user-owned bootstrap instructions");
    expect(text).toContain("Fased will not overwrite old");
    expect(text).toContain("AGENTS.md");
  });

  it("renders a simple Agent Setup with live operation links and readiness summaries", async () => {
    const { renderAgents } = await import("./agents.ts");
    const text = flattenTemplateText(
      renderAgents(
        createProps({
          agentSkills: {
            report: {
              workspaceDir: "/tmp/workspace",
              managedSkillsDir: "/tmp/skills",
              skills: [
                createSkill(),
                {
                  ...createSkill(),
                  name: "Needs API",
                  skillKey: "needs-api",
                  missing: { bins: [], env: ["OPENAI_API_KEY"], config: [], os: [] },
                },
              ],
            },
            loading: false,
            error: null,
            agentId: "beta",
            filter: "",
          },
          config: {
            form: {
              agents: {
                list: [
                  {
                    id: "beta",
                    tools: { allow: ["web_search"] },
                  },
                ],
              },
            },
            loading: false,
            saving: false,
            dirty: false,
          },
          toolsCatalog: {
            loading: false,
            error: null,
            result: {
              agentId: "beta",
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
                      id: "web_search",
                      label: "web_search",
                      description: "Search web",
                      source: "core",
                      defaultProfiles: ["full"],
                    },
                  ],
                },
              ],
            },
          },
          toolsEffective: {
            loading: false,
            error: null,
            result: {
              agentId: "beta",
              profile: "full",
              groups: [
                {
                  id: "runtime",
                  label: "Runtime",
                  source: "core",
                  tools: [
                    {
                      id: "common.reloadConfig",
                      label: "common.reloadConfig",
                      description: "Reload config",
                      rawDescription: "Reload config",
                      source: "core",
                    },
                    {
                      id: "web_search",
                      label: "web_search",
                      description: "Search web",
                      rawDescription: "Search web",
                      source: "core",
                    },
                  ],
                },
              ],
            },
          },
          runtimeSessionMatchesSelectedAgent: true,
          memory: {
            inventory: {
              agentId: "beta",
              workspace: {
                path: "/tmp/workspace",
                exists: true,
                memoryRoots: [
                  {
                    id: "memory.md",
                    label: "memory.md",
                    path: "/tmp/workspace/memory.md",
                    exists: false,
                    kind: "missing",
                    markdownFiles: 0,
                  },
                ],
              },
              backend: { configured: "builtin", active: "builtin", citations: "auto" },
              qmd: { enabled: false },
              sessionMemory: { hookConfigured: true, enabled: true, messages: 2, llmSlug: false },
              memoryPlugin: {
                configuredSlot: null,
                enabled: false,
                registryLoaded: true,
                reason: "No plugin",
              },
            },
            validation: {
              agentId: "beta",
              ok: false,
              summary: { errors: 0, warnings: 1, info: 0 },
              findings: [],
            },
            loading: false,
            error: null,
          },
          sessions: {
            result: {
              ts: 0,
              path: "/tmp/sessions.json",
              count: 2,
              defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: null },
              sessions: [
                { key: "main", kind: "direct", updatedAt: 0 },
                { key: "beta", kind: "direct", updatedAt: 0 },
              ],
            },
            loading: false,
            error: null,
          },
          channels: {
            snapshot: {
              ts: 0,
              channelOrder: ["discord"],
              channelLabels: { discord: "Discord" },
              channels: {},
              channelAccounts: {
                discord: [{ accountId: "primary", configured: true, running: true }],
              },
              channelDefaultAccountId: { discord: "primary" },
            },
            loading: false,
            error: null,
            lastSuccess: 0,
          },
          cron: {
            status: null,
            jobs: [{ id: "job-1", name: "Daily", agentId: "beta", enabled: true } as never],
            loading: false,
            error: null,
          },
          providers: {
            catalogStatus: {
              checkedAtMs: 0,
              cache: { modelCatalog: "cache", providerExtensionCatalog: "cache" },
              totalProviders: 4,
              totalModels: 12,
              configuredProviders: 2,
              availableProviders: 2,
              reasoningModels: 3,
              visionModels: 1,
              capabilityCounts: {
                textModels: 12,
                visionModels: 1,
                reasoningModels: 3,
                toolsModels: 7,
                jsonModels: 6,
                audioModels: 0,
              },
              sourceCounts: {},
              providers: [],
              providerExtensionCatalog: {
                totalEntries: 0,
                loadedEntries: 0,
                skippedUntrustedEntries: 0,
                emptyEntries: 0,
                errorEntries: 0,
                modelCount: 0,
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
          },
          plugins: {
            marketplace: {
              workspaceDir: "/tmp/plugins",
              diagnostics: [],
              plugins: [],
            },
          },
          wallet: {
            status: {
              enabled: true,
              managedMode: false,
              mode: "external",
              runtime: "external-custom",
              settlement: { class: "real-chain", realChainReady: true, summary: "Solana ready" },
            } as never,
            namedWallets: [{ id: "agent", name: "Agent", providerId: "local-socket-signer" }],
            defaultWalletId: "agent",
          },
          mining: {
            attachedWalletId: "miner",
            profile: null,
            readiness: null,
            status: { running: true, network: "devnet", riskMode: "balanced" } as never,
          },
          federation: {
            token: null,
            status: {
              managed: false,
              sourcePath: "/tmp/federation.json",
              joined: true,
              lifecycle: "active",
              checkedAt: "2026-05-07T00:00:00Z",
            },
          },
        }),
      ),
    );

    expect(text).toContain("Agent");
    expect(text).toContain("Models");
    expect(text).toContain("Skills");
    expect(text).toContain("1 ready");
    expect(text).toContain("Memory");
    expect(text).toContain("Sessions");
    expect(text).toContain("Tools");
    expect(text).toContain("available now");
    expect(text).not.toContain("allowed ·");
    expect(text).toContain("Extensions");
    expect(text).toContain("Runtime ok");
    expect(text).toContain("History and restore points");
    expect(text).toContain("Channels");
    expect(text).toContain("Discord");
    expect(text).not.toContain("Wallet");
    expect(text).not.toContain("Mining");
    expect(text).not.toContain("Network");
  });

  it("renders actionable setup fixes for memory hooks, skills, and plugin configuration", async () => {
    const { renderAgents } = await import("./agents.ts");
    const text = flattenTemplateText(
      renderAgents(
        createProps({
          config: {
            form: {
              hooks: {
                internal: {
                  enabled: true,
                  entries: {
                    "session-memory": { enabled: false },
                  },
                },
              },
            },
            loading: false,
            saving: false,
            dirty: false,
          },
          agentSkills: {
            report: {
              workspaceDir: "/tmp/workspace",
              managedSkillsDir: "/tmp/skills",
              skills: [
                {
                  ...createSkill(),
                  name: "Disabled Skill",
                  skillKey: "disabled-skill",
                  disabled: true,
                  eligible: false,
                },
                {
                  ...createSkill(),
                  name: "Needs API",
                  skillKey: "needs-api",
                  primaryEnv: "OPENAI_API_KEY",
                  eligible: false,
                  missing: { bins: [], env: ["OPENAI_API_KEY"], config: [], os: [] },
                },
                {
                  ...createSkill(),
                  name: "Needs Binary",
                  skillKey: "needs-binary",
                  eligible: false,
                  missing: { bins: ["gh"], env: [], config: [], os: [] },
                  install: [{ id: "node", kind: "node", label: "Install gh" }],
                },
                {
                  ...createSkill(),
                  name: "Needs Config",
                  skillKey: "needs-config",
                  eligible: false,
                  missing: { bins: [], env: [], config: ["token"], os: [] },
                },
                {
                  ...createSkill(),
                  name: "Agent Blocked",
                  skillKey: "agent-blocked",
                  blockedByAllowlist: true,
                  eligible: false,
                },
              ],
            },
            loading: false,
            error: null,
            agentId: "beta",
            filter: "",
          },
          memory: {
            inventory: {
              agentId: "beta",
              workspace: {
                path: "/tmp/workspace",
                exists: true,
                memoryRoots: [
                  {
                    id: "memory.md",
                    label: "memory.md",
                    path: "/tmp/workspace/memory.md",
                    exists: false,
                    kind: "missing",
                    markdownFiles: 0,
                  },
                ],
              },
              backend: { configured: "builtin", active: "builtin", citations: "auto" },
              qmd: { enabled: false },
              sessionMemory: {
                hookConfigured: true,
                enabled: false,
                messages: 0,
                llmSlug: false,
                memoryDir: { path: "/tmp/workspace/memory", exists: true, kind: "directory" },
                filenameDiagnostics: { checked: true, status: "ok", groups: [] },
              },
              memoryPlugin: { configuredSlot: null, enabled: false, registryLoaded: true },
            },
            validation: {
              agentId: "beta",
              ok: true,
              summary: { errors: 0, warnings: 0, info: 0 },
              findings: [],
            },
            loading: false,
            error: null,
          },
          plugins: {
            marketplace: {
              workspaceDir: "/tmp/plugins",
              diagnostics: [],
              plugins: [{ id: "demo-plugin", name: "Demo Plugin", status: "available" } as never],
            },
          },
        }),
      ),
    );

    expect(text).toContain("Memory");
    expect(text).toContain("Skills");
    expect(text).toContain("0 ready");
    expect(text).toContain("Models");
    expect(text).toContain("Channels");
    expect(text).toContain("Tasks");
    expect(text).toContain("Sessions");
    expect(text).not.toContain("Setup actions");
    expect(text).not.toContain("Enable memory archive");
    expect(text).not.toContain("Recommended hooks");
    expect(text).not.toContain("boot-md");
    expect(text).not.toContain("command-logger");
    expect(text).not.toContain("Fix skill setup");
    expect(text).not.toContain("Show in library");
    expect(text).not.toContain("Extension config");
  });

  it("renders a dedicated Memory panel without bundled hook controls", async () => {
    const { renderAgents } = await import("./agents.ts");
    const text = flattenTemplateText(
      renderAgents(
        createProps({
          activePanel: "memory",
          config: {
            form: {
              hooks: {
                internal: {
                  enabled: true,
                  entries: {
                    "boot-md": { enabled: true },
                    "bootstrap-extra-files": { enabled: false },
                    "command-logger": {},
                    "session-memory": { enabled: false },
                  },
                },
              },
            },
            loading: false,
            saving: false,
            dirty: true,
          },
          memory: {
            inventory: {
              agentId: "beta",
              workspace: {
                path: "/tmp/workspace",
                exists: true,
                memoryRoots: [
                  {
                    id: "memory.md",
                    label: "memory.md",
                    path: "/tmp/workspace/memory.md",
                    exists: false,
                    kind: "missing",
                    markdownFiles: 0,
                  },
                ],
              },
              backend: { configured: "builtin", active: "builtin", citations: "auto" },
              qmd: { enabled: false },
              sessionMemory: {
                hookConfigured: true,
                enabled: false,
                messages: 0,
                llmSlug: false,
                filenameDiagnostics: { checked: true, status: "none", groups: [] },
              },
              memoryPlugin: { configuredSlot: null, enabled: false, registryLoaded: true },
            },
            validation: {
              agentId: "beta",
              ok: true,
              summary: { errors: 0, warnings: 0, info: 0 },
              findings: [],
            },
            loading: false,
            error: null,
            dreamingStatusLoading: false,
            dreamingStatusError: null,
            dreamingStatus: null,
          },
        }),
      ),
    );

    expect(text).toContain("Memory");
    expect(text).toContain("Session archive and memory health for");
    expect(text).toContain("Session archive");
    expect(text).toContain("Disabled");
    expect(text).toContain("0 messages");
    expect(text).toContain("Backend");
    expect(text).toContain("Citations");
    expect(text).toContain("builtin");
    expect(text).toContain("Validation");
    expect(text).toContain("OK");
    expect(text).toContain("Workspace memory roots");
    expect(text).toContain("optional legacy root not present");
    expect(text).toContain("Session archive filename state");
    expect(text).toContain("No same-minute session archive filename collisions were found.");
    expect(text).toContain("Validation findings");
    expect(text).toContain("No memory validation findings are visible.");
    expect(text).toContain("Dreaming status");
    expect(text).toContain("Dreaming status has not loaded yet.");
    expect(text).toContain("Enable session archive");
    expect(text).toContain("Save config");
    expect(text).toContain("Diagnostics");
    expect(text).not.toContain("boot-md");
    expect(text).not.toContain("command-logger");
    expect(text).not.toContain("Advanced Config");
  });
});
