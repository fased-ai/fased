import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openTaskLedgerSourceSurface } from "../app-render.ts";
import type { AppViewState } from "../app-view-state.ts";
import type { TaskRecord } from "../types.ts";
import { renderAgents, type AgentsProps } from "./agents.ts";

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
    agentCreateBusy: false,
    agentCreateMessage: null,
    activePanel: "overview",
    config: {
      form: {
        agents: {
          defaults: { model: "openai/gpt-5.5" },
          list: [{ id: "beta", name: "Beta", workspace: "/tmp/beta" }],
        },
        models: {
          providers: {
            openai: { models: [{ id: "gpt-5.5" }, { id: "gpt-5.6-terra" }] },
          },
        },
      },
      loading: false,
      saving: false,
      dirty: false,
    },
    connected: true,
    channelRuntimeBusy: {},
    configSchema: null,
    configSchemaLoading: false,
    configUiHints: {},
    channels: { snapshot: null, loading: false, error: null, lastSuccess: null },
    sessions: { result: null, loading: false, error: null },
    cron: { status: null, jobs: [], loading: false, error: null },
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
    agentSkills: { report: null, loading: false, error: null, agentId: null, filter: "" },
    toolsCatalog: { loading: false, error: null, result: null },
    toolsEffective: { loading: false, error: null, result: null },
    memory: { inventory: null, validation: null, loading: false, error: null },
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
    plugins: { marketplace: null },
    usage: { result: null, loading: false, error: null },
    wallet: { status: null, namedWallets: [], defaultWalletId: null },
    mining: { attachedWalletId: null, profile: null, readiness: null, status: null },
    federation: { token: null, status: null },
    runtimeSessionKey: "main",
    runtimeSessionMatchesSelectedAgent: false,
    modelCatalog: [{ id: "gpt-5.6-terra", name: "GPT-5.6 Terra", provider: "openai" }],
    runnableModelCatalog: [{ id: "gpt-5.6-terra", name: "GPT-5.6 Terra", provider: "openai" }],
    skillEdits: {},
    skillsBusyKey: null,
    onNavigate: vi.fn(),
    onOpenUsageForAgent: vi.fn(),
    onRefresh: vi.fn(),
    onCreateAgent: vi.fn(),
    onSelectAgent: vi.fn(),
    onSelectPanel: vi.fn(),
    onLoadFiles: vi.fn(),
    onSelectFile: vi.fn(),
    onFileDraftChange: vi.fn(),
    onFileReset: vi.fn(),
    onFileSave: vi.fn(),
    onToolsProfileChange: vi.fn(),
    onToolsOverridesChange: vi.fn(),
    onConfigPatch: vi.fn(),
    onConfigRemove: vi.fn(),
    onConfigReload: vi.fn(),
    onConfigSave: vi.fn(),
    onModelChange: vi.fn(),
    onModelFallbacksChange: vi.fn(),
    onTaskModelsChange: vi.fn(),
    onAgentIdentityAvatarChange: vi.fn(),
    onActiveModelProviderChange: vi.fn(),
    onModelProviderChange: vi.fn(),
    onSessionsRefresh: vi.fn(),
    onSessionPatch: vi.fn(),
    onSessionDelete: vi.fn(),
    onSessionBranchCheckpoint: vi.fn(),
    onSessionRestoreCheckpoint: vi.fn(),
    onChannelsViewChange: vi.fn(),
    onChannelsRefresh: vi.fn(),
    onChannelStart: vi.fn(),
    onChannelStop: vi.fn(),
    onChannelEnable: vi.fn(),
    onChannelLogout: vi.fn(),
    onCronRefresh: vi.fn(),
    onCronEdit: vi.fn(),
    onCronRunNow: vi.fn(),
    onCronToggle: vi.fn(),
    onCronRepair: vi.fn(),
    onCronQueueControl: vi.fn(),
    onCronRunDetail: vi.fn(),
    onCronRemove: vi.fn(),
    onCronCreate: vi.fn(),
    onCronOpenSession: vi.fn(),
    onSkillsFilterChange: vi.fn(),
    onSkillsRefresh: vi.fn(),
    onAgentSkillToggle: vi.fn(),
    onAgentSkillsClear: vi.fn(),
    onAgentSkillsNarrowToSelected: vi.fn(),
    onAgentSkillsDisableAll: vi.fn(),
    onSkillEdit: vi.fn(),
    onSkillSaveKey: vi.fn(),
    onSkillInstall: vi.fn(),
    onSkillEnabledChange: vi.fn(),
    onSessionMemoryEnabledChange: vi.fn(),
    onSetDefault: vi.fn(),
    ...overrides,
  } as unknown as AgentsProps;
}

function createReadySkill(overrides: Record<string, unknown> = {}) {
  return {
    name: "gog",
    description: "Google Workspace",
    source: "workspace",
    filePath: "/tmp/skill",
    baseDir: "/tmp",
    skillKey: "gog",
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

function getInput(form: HTMLFormElement, name: string): HTMLInputElement {
  const input = form.querySelector<HTMLInputElement>(`input[name="${name}"]`);
  expect(input).toBeInstanceOf(HTMLInputElement);
  return input!;
}

function submit(form: HTMLFormElement) {
  form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
}

function taskLedgerFilterText(container: HTMLElement, source: string): string {
  const ids: Record<string, string> = {
    all: "task-work-filter-all",
  };
  const testId = ids[source] ?? `task-work-filter-source-${source}`;
  return (
    container
      .querySelector(`[data-testid="${testId}"]`)
      ?.textContent?.replace(/\s+/g, " ")
      .replace(/[()]/g, "")
      .trim() ?? ""
  );
}

function createTaskSourceRoutingState() {
  const state: Record<string, unknown> = {
    basePath: "",
    tab: "agents",
    agentsPanel: "cron",
    channelsView: "accounts",
    taskLedgerSourceFilter: "all",
    walletMainPanel: "wallets",
    walletApprovalsFilter: "pending",
    miningActivityFilter: "all",
    miningActivityWindow: "24h",
    connected: false,
    client: null,
    setTab: vi.fn((tab: string) => {
      state.tab = tab;
    }),
    setTaskLedgerSourceFilter: vi.fn((source: string) => {
      state.taskLedgerSourceFilter = source;
    }),
    loadCron: vi.fn(),
  };
  return state as unknown as AppViewState;
}

describe("Agents assembly UI", () => {
  beforeEach(() => {
    installBrowserGlobals();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("creates and selects Agent entries from the workbench", () => {
    const props = createProps();
    const container = document.createElement("div");
    document.body.append(container);
    render(renderAgents(props), container);

    expect(container.textContent).toContain("Agent");
    expect(container.querySelector('[title*="/tmp/beta"]')).toBeTruthy();
    expect(container.textContent).not.toContain("Subagents are runtime delegation workers");
    const createAgentButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent?.trim() === "Agent");
    expect(createAgentButton).toBeInstanceOf(HTMLButtonElement);
    expect(createAgentButton!.querySelector("svg")).toBeInstanceOf(SVGElement);

    const selectTrigger = container.querySelector<HTMLButtonElement>(".agents-select-trigger");
    expect(selectTrigger).toBeInstanceOf(HTMLButtonElement);
    selectTrigger!.click();
    const selectDialog = container.querySelector<HTMLDialogElement>(
      'dialog[data-agent-select-dialog="true"]',
    );
    expect(selectDialog?.open).toBe(true);
    expect(selectDialog?.querySelector('[title*="/tmp/beta"]')).toBeTruthy();
    selectDialog?.close();

    const selector = container.querySelector<HTMLSelectElement>('select[data-agent-select="true"]');
    expect(selector).toBeInstanceOf(HTMLSelectElement);
    selector!.value = "alpha";
    selector!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(props.onSelectAgent).toHaveBeenCalledWith("alpha");

    const form = container.querySelector<HTMLFormElement>('form[data-agent-create-form="true"]');
    expect(form).toBeInstanceOf(HTMLFormElement);
    const nameInput = getInput(form!, "name");
    nameInput.value = "Research Ops";
    nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    const avatarInput = getInput(form!, "avatar");
    avatarInput.value = "avatars/research.png";
    const slugPreview = form!.querySelector<HTMLInputElement>(
      'input[data-agent-id-preview="true"]',
    );
    expect(slugPreview).toBeInstanceOf(HTMLInputElement);
    expect(slugPreview!.value).toBe("research-ops");
    expect(getInput(form!, "workspace").value).toBe("~/.fased/workspace/agents/research-ops");
    const provider = form!.querySelector<HTMLSelectElement>('select[name="provider"]');
    expect(provider).toBeInstanceOf(HTMLSelectElement);
    provider!.value = "openai";
    provider!.dispatchEvent(new Event("change", { bubbles: true }));
    const model = form!.querySelector<HTMLSelectElement>('select[name="model"]');
    expect(model).toBeInstanceOf(HTMLSelectElement);
    model!.value = "openai/gpt-5.6-terra";
    expect(container.textContent).not.toContain("Delete Agent");
    submit(form!);
    expect(props.onCreateAgent).toHaveBeenCalledWith({
      name: "Research Ops",
      workspace: "~/.fased/workspace/agents/research-ops",
      model: "openai/gpt-5.6-terra",
      avatar: "avatars/research.png",
    });
  });

  it("keeps Agent Files ownership guidance behind a help icon", () => {
    const container = document.createElement("div");
    render(
      renderAgents(
        createProps({
          activePanel: "files",
          agentFiles: {
            list: {
              agentId: "beta",
              workspace: "/tmp/beta",
              files: [
                {
                  name: "AGENTS.md",
                  path: "/tmp/beta/AGENTS.md",
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
      container,
    );

    const help = container.querySelector<HTMLElement>('[data-agent-files-help="true"]');
    expect(help).toBeInstanceOf(HTMLElement);
    expect(help?.getAttribute("title")).toContain("user-owned bootstrap instructions");
    expect(container.textContent).not.toContain("Fased will not overwrite old");
  });

  it("shows avatar upload on the Agent setup summary", () => {
    const props = createProps({
      config: {
        form: {
          agents: {
            list: [
              {
                id: "beta",
                name: "Beta",
                workspace: "/tmp/beta",
                identity: { avatar: "B" },
              },
            ],
          },
        },
        loading: false,
        saving: false,
        dirty: false,
      },
    });
    const container = document.createElement("div");
    render(renderAgents(props), container);

    const avatarInput = container.querySelector<HTMLInputElement>(
      'input[data-agent-identity-avatar-input="true"]',
    );
    expect(avatarInput).toBeInstanceOf(HTMLInputElement);
    expect(avatarInput!.type).toBe("file");
    expect(avatarInput!.accept).toBe("image/*");
    expect(container.textContent).toContain("Beta");
    expect(container.textContent).not.toContain("Identity");
  });

  it("filters create-agent models by the selected signed provider", () => {
    const props = createProps({
      modelCatalog: [
        { id: "openai/gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openrouter" },
        { id: "gpt-5.5", name: "GPT-5.5 Codex", provider: "openai-codex" },
      ],
      runnableModelCatalog: [
        { id: "openai/gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openrouter" },
        { id: "gpt-5.5", name: "GPT-5.5 Codex", provider: "openai-codex" },
      ],
      providers: {
        catalogStatus: {
          totalProviders: 2,
          configuredProviders: 2,
          totalModels: 3,
          providers: [
            {
              provider: "openrouter",
              configured: true,
              totalModels: 2,
              reasoningModels: 1,
              visionModels: 0,
              sources: ["configured"],
              sourceConfidence: "configured",
              capabilityCounts: {
                textModels: 2,
                visionModels: 0,
                reasoningModels: 1,
                toolsModels: 0,
                jsonModels: 0,
                audioModels: 0,
              },
              authModes: ["api-key"],
              privateNetwork: { models: 0, allowed: 0, blocked: 0 },
              probeStatus: "not-run",
            },
            {
              provider: "openai-codex",
              configured: true,
              totalModels: 1,
              reasoningModels: 1,
              visionModels: 0,
              sources: ["runtime"],
              sourceConfidence: "runtime",
              capabilityCounts: {
                textModels: 1,
                visionModels: 0,
                reasoningModels: 1,
                toolsModels: 0,
                jsonModels: 0,
                audioModels: 0,
              },
              authModes: ["oauth"],
              privateNetwork: { models: 0, allowed: 0, blocked: 0 },
              probeStatus: "not-run",
            },
          ],
          cache: { modelCatalog: "cache", providerExtensionCatalog: "cache" },
          sourceCounts: {},
          providerExtensionCatalog: {
            totalEntries: 0,
            bundledEntries: 0,
            installedEntries: 0,
            warningEntries: 0,
            warnings: [],
            entries: [],
          },
          providerExtensionManifest: { totalEntries: 0, entries: [] },
        },
        authStatus: {
          storePath: "/tmp/auth-profiles.json",
          warnAfterMs: 86_400_000,
          providers: [
            {
              provider: "openrouter",
              status: "ok",
              effective: { kind: "profiles", detail: "openrouter:default" },
              profiles: [],
            },
            {
              provider: "openai-codex",
              status: "ok",
              effective: { kind: "profiles", detail: "openai-codex:default" },
              profiles: [],
            },
          ],
        },
      },
      config: {
        form: {
          models: {
            providers: {
              openrouter: {
                models: [
                  { id: "openai/gpt-5.6-sol", name: "GPT-5.6 Sol" },
                  { id: "anthropic/claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
                ],
              },
              "openai-codex": {
                models: [{ id: "gpt-5.5", name: "GPT-5.5 Codex" }],
              },
              anthropic: {
                models: [{ id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" }],
              },
            },
          },
        },
        loading: false,
        saving: false,
        dirty: false,
      },
    });
    const container = document.createElement("div");
    document.body.append(container);
    render(renderAgents(props), container);
    const form = container.querySelector<HTMLFormElement>('form[data-agent-create-form="true"]');
    expect(form).toBeInstanceOf(HTMLFormElement);
    const provider = form!.querySelector<HTMLSelectElement>('select[name="provider"]');
    const model = form!.querySelector<HTMLSelectElement>('select[name="model"]');
    expect(provider).toBeInstanceOf(HTMLSelectElement);
    expect(model).toBeInstanceOf(HTMLSelectElement);
    expect(Array.from(provider!.options).map((option) => option.value)).toContain("openrouter");
    expect(Array.from(provider!.options).map((option) => option.value)).not.toContain("anthropic");
    expect(Array.from(model!.options).map((option) => option.value)).toContain(
      "openrouter/openai/gpt-5.6-sol",
    );

    provider!.value = "openrouter";
    provider!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(
      model!.querySelector<HTMLOptionElement>('option[value="openrouter/openai/gpt-5.6-sol"]')
        ?.disabled,
    ).toBe(false);
    expect(
      model!.querySelector<HTMLOptionElement>('option[value="openrouter/openai/gpt-5.6-sol"]')
        ?.hidden,
    ).toBe(false);
    expect(model!.value).toBe("openrouter/openai/gpt-5.6-sol");
    expect(
      model!.querySelector<HTMLOptionElement>('option[value="openai-codex/gpt-5.5"]')?.disabled,
    ).toBe(true);

    provider!.value = "openai";
    provider!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(model!.value).toBe("openai-codex/gpt-5.5");
    expect(
      model!.querySelector<HTMLOptionElement>('option[value="openai-codex/gpt-5.5"]')?.disabled,
    ).toBe(false);
    expect(
      model!.querySelector<HTMLOptionElement>('option[value="openrouter/openai/gpt-5.6-sol"]')
        ?.disabled,
    ).toBe(true);
  });

  it("uses the chat-style modal dropdown and still selects the first provider model", () => {
    const props = createProps({
      modelCatalog: [
        { id: "openai/gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openrouter" },
        { id: "gpt-5.5", name: "GPT-5.5 Codex", provider: "openai-codex" },
      ],
      runnableModelCatalog: [
        { id: "openai/gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openrouter" },
        { id: "gpt-5.5", name: "GPT-5.5 Codex", provider: "openai-codex" },
      ],
      providers: {
        catalogStatus: null,
        authStatus: {
          storePath: "/tmp/auth-profiles.json",
          warnAfterMs: 86_400_000,
          providers: [
            {
              provider: "openrouter",
              status: "ok",
              effective: { kind: "profiles", detail: "openrouter:default" },
              profiles: [],
            },
            {
              provider: "openai-codex",
              status: "ok",
              effective: { kind: "profiles", detail: "openai-codex:default" },
              profiles: [],
            },
          ],
        },
      },
    });
    const container = document.createElement("div");
    document.body.append(container);
    render(renderAgents(props), container);
    container.querySelector<HTMLButtonElement>(".agents-toolbar .primary")?.click();
    const form = container.querySelector<HTMLFormElement>('form[data-agent-create-form="true"]');
    const provider = form?.querySelector<HTMLSelectElement>('select[name="provider"]');
    const model = form?.querySelector<HTMLSelectElement>('select[name="model"]');
    expect(provider).toBeInstanceOf(HTMLSelectElement);
    expect(model).toBeInstanceOf(HTMLSelectElement);
    expect(provider!.classList.contains("chat-select__native")).toBe(true);
    expect(model!.classList.contains("chat-select__native")).toBe(true);

    const providerPopover = form?.querySelector<HTMLDetailsElement>(
      ".agent-create-select--provider .chat-select__popover",
    );
    expect(providerPopover).toBeInstanceOf(HTMLDetailsElement);
    providerPopover!.open = true;
    const openRouter = Array.from(
      providerPopover!.querySelectorAll<HTMLButtonElement>(".chat-select__option"),
    ).find((button) => button.dataset.value === "openrouter");
    expect(openRouter).toBeInstanceOf(HTMLButtonElement);
    openRouter!.click();

    expect(provider!.value).toBe("openrouter");
    expect(model!.value).toBe("openrouter/openai/gpt-5.6-sol");
    expect(form?.querySelector('[data-agent-provider-selected="true"]')?.textContent?.trim()).toBe(
      "OpenRouter",
    );
    expect(form?.querySelector('[data-agent-model-selected="true"]')?.textContent?.trim()).toBe(
      "GPT-5.6 Sol (openai/gpt-5.6-sol)",
    );
  });

  it("saves Agent primary model as a model ref", () => {
    const props = createProps();
    const container = document.createElement("div");
    render(renderAgents(props), container);

    const modelSelect = container.querySelector<HTMLSelectElement>(
      'select[data-agent-model-select="true"]',
    );
    const roleSelect = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Cheap/check task model"]',
    );
    expect(modelSelect).toBeInstanceOf(HTMLSelectElement);
    expect(roleSelect).toBeInstanceOf(HTMLSelectElement);
    modelSelect!.value = "openai/gpt-5.6-terra";
    modelSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(props.onModelChange).toHaveBeenCalledWith("beta", "openai/gpt-5.6-terra");
    expect(props.onActiveModelProviderChange).toHaveBeenCalledWith("beta", null);
    expect(roleSelect!.options[0]?.textContent).toContain("openai/gpt-5.6-terra");
  });

  it("lets Agent model fields select provider/model refs directly", async () => {
    const props = createProps({
      config: {
        form: {
          agents: {
            defaults: { model: "openai/gpt-5.5" },
            list: [
              {
                id: "beta",
                name: "Beta",
                workspace: "/tmp/beta",
                model: { primary: "openai/gpt-5.6-terra" },
              },
            ],
          },
          models: {
            providers: {
              openai: { models: [{ id: "gpt-5.6-terra" }] },
              openrouter: { models: [{ id: "auto" }] },
            },
          },
        },
        loading: false,
        saving: false,
        dirty: false,
      },
      modelCatalog: [
        { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", provider: "openai" },
        { id: "openai/gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openrouter" },
      ],
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
            {
              provider: "openrouter",
              status: "ok",
              effective: { kind: "profiles", detail: "openrouter:default" },
              profiles: [],
            },
          ],
        },
      },
    });
    const container = document.createElement("div");
    document.body.append(container);
    render(renderAgents(props), container);

    const modelSelect = container.querySelector<HTMLSelectElement>(
      'select[data-agent-model-select="true"]',
    );
    const cheapRoleSelect = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Cheap/check task model"]',
    );
    const escalationRoleSelect = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Escalation task model"]',
    );
    expect(modelSelect).toBeInstanceOf(HTMLSelectElement);
    expect(cheapRoleSelect).toBeInstanceOf(HTMLSelectElement);
    expect(escalationRoleSelect).toBeInstanceOf(HTMLSelectElement);
    expect(modelSelect!.value).toBe("openai/gpt-5.6-terra");
    const initialOpenrouterRoleOption = Array.from(cheapRoleSelect!.options).find(
      (option) => option.value === "openrouter/openai/gpt-5.6-sol",
    );
    expect(initialOpenrouterRoleOption?.hidden).toBe(false);
    expect(initialOpenrouterRoleOption?.disabled).toBe(false);

    modelSelect!.value = "openrouter/openai/gpt-5.6-sol";
    modelSelect!.dispatchEvent(new Event("change", { bubbles: true }));

    expect(modelSelect!.value).toBe("openrouter/openai/gpt-5.6-sol");
    expect(props.onModelChange).toHaveBeenCalledWith("beta", "openrouter/openai/gpt-5.6-sol");
    expect(props.onActiveModelProviderChange).toHaveBeenCalledWith("beta", null);
    const openaiRoleOption = Array.from(cheapRoleSelect!.options).find(
      (option) => option.value === "openai/gpt-5.6-terra",
    );
    const openrouterRoleOption = Array.from(cheapRoleSelect!.options).find(
      (option) => option.value === "openrouter/openai/gpt-5.6-sol",
    );
    expect(openaiRoleOption?.hidden).toBe(false);
    expect(openaiRoleOption?.disabled).toBe(false);
    expect(openrouterRoleOption?.hidden).toBe(false);
    expect(openrouterRoleOption?.disabled).toBe(false);
    cheapRoleSelect!.value = "openrouter/openai/gpt-5.6-sol";
    cheapRoleSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(props.onTaskModelsChange).toHaveBeenCalledWith("beta", {
      cheapCheck: "openrouter/openai/gpt-5.6-sol",
    });
    await Promise.resolve();
    expect(props.onConfigSave).toHaveBeenCalled();

    escalationRoleSelect!.value = "openai/gpt-5.6-terra";
    escalationRoleSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(props.onTaskModelsChange).toHaveBeenLastCalledWith("beta", {
      cheapCheck: "openrouter/openai/gpt-5.6-sol",
      escalation: "openai/gpt-5.6-terra",
    });
  });

  it("renders Agent Providers as the providers surface with the shared setup model dialog", () => {
    const props = createProps({
      activePanel: "providers",
      providersPanel: "GLOBAL PROVIDERS",
    });
    const container = document.createElement("div");
    render(renderAgents(props), container);

    const text = container.textContent ?? "";
    expect(text).toContain("GLOBAL PROVIDERS");
    expect(text).not.toContain("Agent Providers");
    expect(
      container.querySelector<HTMLDialogElement>('[data-agent-model-dialog="true"]'),
    ).toBeInstanceOf(HTMLDialogElement);
  });

  it("assigns Agent task model roles from the Agent model selector", () => {
    const props = createProps();
    const container = document.createElement("div");
    render(renderAgents(props), container);

    const roleSelect = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Cheap/check task model"]',
    );
    expect(roleSelect).toBeInstanceOf(HTMLSelectElement);
    roleSelect!.value = "openai/gpt-5.6-terra";
    roleSelect!.dispatchEvent(new Event("change", { bubbles: true }));

    expect(props.onTaskModelsChange).toHaveBeenCalledWith("beta", {
      cheapCheck: "openai/gpt-5.6-terra",
    });
  });

  it("preserves multiple Agent task model role edits before rerender", () => {
    const props = createProps({
      modelCatalog: [
        { id: "gpt-5.5", name: "GPT-5.5", provider: "openai" },
        { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", provider: "openai" },
      ],
    });
    const container = document.createElement("div");
    render(renderAgents(props), container);

    const cheapSelect = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Cheap/check task model"]',
    );
    const escalationSelect = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Escalation task model"]',
    );
    expect(cheapSelect).toBeInstanceOf(HTMLSelectElement);
    expect(escalationSelect).toBeInstanceOf(HTMLSelectElement);

    cheapSelect!.value = "openai/gpt-5.6-terra";
    cheapSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    escalationSelect!.value = "openai/gpt-5.5";
    escalationSelect!.dispatchEvent(new Event("change", { bubbles: true }));

    expect(props.onTaskModelsChange).toHaveBeenLastCalledWith("beta", {
      cheapCheck: "openai/gpt-5.6-terra",
      escalation: "openai/gpt-5.5",
    });
  });

  it("sets a fallback model from existing provider models and autosaves", async () => {
    const props = createProps({
      config: {
        form: {
          agents: {
            defaults: { model: "openai/gpt-5.5" },
            list: [
              {
                id: "beta",
                name: "Beta",
                workspace: "/tmp/beta",
                model: { primary: "openai/gpt-5.5" },
              },
            ],
          },
          models: {
            providers: {
              openai: { models: [{ id: "gpt-5.5" }, { id: "gpt-5.6-terra" }] },
            },
          },
        },
        loading: false,
        saving: false,
        dirty: false,
      },
      modelCatalog: [
        { id: "gpt-5.5", name: "GPT-5.5", provider: "openai" },
        { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", provider: "openai" },
        { id: "openai/gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openrouter" },
      ],
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
            {
              provider: "openrouter",
              status: "ok",
              effective: { kind: "profiles", detail: "openrouter:default" },
              profiles: [],
            },
          ],
        },
      },
    });
    const container = document.createElement("div");
    document.body.append(container);
    render(renderAgents(props), container);

    const modelsButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.includes("Models"),
    );
    expect(modelsButton).toBeInstanceOf(HTMLButtonElement);
    modelsButton!.click();

    const dialog = container.querySelector<HTMLDialogElement>('[data-agent-model-dialog="true"]');
    expect(dialog).toBeInstanceOf(HTMLDialogElement);
    expect(dialog!.querySelector(".agent-model-selected")).toBeNull();
    const dialogForm = dialog!.querySelector<HTMLFormElement>(".agent-model-dialog__form");
    expect(dialogForm).toBeInstanceOf(HTMLFormElement);
    expect(getComputedStyle(dialog!).overflow).toBe("hidden");
    expect(getComputedStyle(dialogForm!).overflowY).toBe("auto");
    expect(
      dialog!.querySelector<HTMLSelectElement>('select[data-agent-model-provider-select="true"]'),
    ).toBeNull();
    expect(dialog!.textContent).toContain("Primary");
    expect(dialog!.textContent).toContain("Fallback");
    expect(dialog!.querySelector("details.chat-select__popover")).toBeInstanceOf(
      HTMLDetailsElement,
    );
    for (const select of Array.from(dialog!.querySelectorAll<HTMLSelectElement>("select"))) {
      expect(select.classList.contains("agent-model-native-select")).toBe(true);
    }
    expect(dialog!.textContent).not.toContain("Saving");
    expect(dialog!.textContent).not.toContain("Save");

    const fallbackSelect = dialog!.querySelector<HTMLSelectElement>(
      'select[data-agent-fallback-model="true"]',
    );
    expect(fallbackSelect).toBeInstanceOf(HTMLSelectElement);
    const fallbackDetails = dialog!.querySelector<HTMLDetailsElement>(
      'details[data-agent-model-control="fallback"]',
    );
    expect(fallbackDetails).toBeInstanceOf(HTMLDetailsElement);
    const fallbackOption = fallbackDetails!.querySelector<HTMLButtonElement>(
      'button[data-agent-model-option="true"][data-value="openai/gpt-5.6-terra"]',
    );
    expect(fallbackOption).toBeInstanceOf(HTMLButtonElement);
    fallbackDetails!.open = true;
    fallbackOption!.click();

    expect(fallbackDetails!.open).toBe(false);
    expect(fallbackSelect!.value).toBe("openai/gpt-5.6-terra");
    expect(props.onModelFallbacksChange).toHaveBeenCalledWith("beta", ["openai/gpt-5.6-terra"]);

    const openrouterFallback = Array.from(fallbackSelect!.options).find(
      (option) => option.value === "openrouter/openai/gpt-5.6-sol",
    );
    expect(openrouterFallback).toBeInstanceOf(HTMLOptionElement);
    fallbackSelect!.value = "openrouter/openai/gpt-5.6-sol";
    fallbackSelect!.dispatchEvent(new Event("change", { bubbles: true }));

    expect(props.onModelFallbacksChange).toHaveBeenLastCalledWith("beta", [
      "openrouter/openai/gpt-5.6-sol",
    ]);

    await Promise.resolve();
    expect(props.onConfigSave).toHaveBeenCalled();
  });

  it("shows only models from authenticated provider routes", () => {
    const props = createProps({
      config: {
        form: {
          agents: {
            defaults: { model: "openai-codex/gpt-5.5" },
            list: [{ id: "beta", name: "Beta", workspace: "/tmp/beta" }],
          },
        },
        loading: false,
        saving: false,
        dirty: false,
      },
      modelCatalog: [
        { id: "gpt-5.6", name: "GPT-5.6", provider: "openai" },
        { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai-codex" },
        { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", provider: "openai-codex" },
        { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "openai-codex" },
        { id: "gpt-5.5", name: "GPT-5.5", provider: "openai-codex" },
      ],
      runnableModelCatalog: [
        { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai-codex" },
        { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", provider: "openai-codex" },
        { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "openai-codex" },
        { id: "gpt-5.5", name: "GPT-5.5", provider: "openai-codex" },
      ],
      providers: {
        catalogStatus: null,
        authStatus: {
          storePath: "/tmp/auth-profiles.json",
          warnAfterMs: 86_400_000,
          providers: [
            {
              provider: "openai-codex",
              status: "ok",
              effective: { kind: "profiles", detail: "openai-codex:default" },
              profiles: [],
            },
          ],
        },
      },
    });
    const container = document.createElement("div");
    document.body.append(container);
    render(renderAgents(props), container);

    const modelsButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.includes("Models"),
    );
    modelsButton?.click();
    const dialog = container.querySelector<HTMLDialogElement>('[data-agent-model-dialog="true"]');
    const direct = dialog?.querySelector<HTMLButtonElement>(
      'button[data-agent-model-option="true"][data-value="openai/gpt-5.6"]',
    );
    const signedIn = dialog?.querySelector<HTMLButtonElement>(
      'button[data-agent-model-option="true"][data-value="openai-codex/gpt-5.5"]',
    );
    const signedInSol = dialog?.querySelector<HTMLButtonElement>(
      'button[data-agent-model-option="true"][data-value="openai-codex/gpt-5.6-sol"]',
    );

    expect(direct).toBeNull();
    expect(signedIn).toBeInstanceOf(HTMLButtonElement);
    expect(signedIn?.disabled).toBe(false);
    expect(signedInSol).toBeInstanceOf(HTMLButtonElement);
    expect(signedInSol?.disabled).toBe(false);
  });

  it("keeps the primary model when fallback is selected before rerender", async () => {
    const props = createProps({
      config: {
        form: {
          agents: {
            list: [{ id: "beta", name: "Beta", workspace: "/tmp/beta" }],
          },
          models: {
            providers: {
              openai: { models: [{ id: "gpt-5.5" }, { id: "gpt-5.6-terra" }] },
              openrouter: { models: [{ id: "auto" }] },
            },
          },
        },
        loading: false,
        saving: false,
        dirty: false,
      },
      modelCatalog: [
        { id: "gpt-5.5", name: "GPT-5.5", provider: "openai" },
        { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", provider: "openai" },
        { id: "openai/gpt-5.6-sol", name: "Auto", provider: "openrouter" },
      ],
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
            {
              provider: "openrouter",
              status: "ok",
              effective: { kind: "profiles", detail: "openrouter:default" },
              profiles: [],
            },
          ],
        },
      },
    });
    const container = document.createElement("div");
    document.body.append(container);
    render(renderAgents(props), container);

    const modelsButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.includes("Models"),
    );
    expect(modelsButton).toBeInstanceOf(HTMLButtonElement);
    modelsButton!.click();

    const dialog = container.querySelector<HTMLDialogElement>('[data-agent-model-dialog="true"]');
    const primarySelect = dialog!.querySelector<HTMLSelectElement>(
      'select[data-agent-model-select="true"]',
    );
    const fallbackSelect = dialog!.querySelector<HTMLSelectElement>(
      'select[data-agent-fallback-model="true"]',
    );
    expect(primarySelect).toBeInstanceOf(HTMLSelectElement);
    expect(fallbackSelect).toBeInstanceOf(HTMLSelectElement);

    primarySelect!.value = "openai/gpt-5.6-terra";
    primarySelect!.dispatchEvent(new Event("change", { bubbles: true }));
    fallbackSelect!.value = "openrouter/openai/gpt-5.6-sol";
    fallbackSelect!.dispatchEvent(new Event("change", { bubbles: true }));

    expect(props.onModelChange).toHaveBeenLastCalledWith("beta", "openai/gpt-5.6-terra");
    expect(props.onModelFallbacksChange).toHaveBeenCalledWith("beta", [
      "openrouter/openai/gpt-5.6-sol",
    ]);
    await Promise.resolve();
    expect(props.onConfigSave).toHaveBeenCalled();
  });

  it("stores one Agent fallback model", () => {
    const props = createProps({
      config: {
        form: {
          agents: {
            list: [
              {
                id: "beta",
                name: "Beta",
                workspace: "/tmp/beta",
                model: {
                  primary: "openai/gpt-5.5",
                  fallbacks: ["openai/a", "openai/b"],
                },
              },
            ],
          },
          models: {
            providers: {
              openai: {
                models: [{ id: "gpt-5.5" }, { id: "gpt-5.6-terra" }, { id: "a" }, { id: "b" }],
              },
            },
          },
        },
        loading: false,
        saving: false,
        dirty: false,
      },
      modelCatalog: [
        { id: "gpt-5.5", name: "GPT-5.5", provider: "openai" },
        { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", provider: "openai" },
        { id: "a", name: "A", provider: "openai" },
        { id: "b", name: "B", provider: "openai" },
      ],
    });
    const container = document.createElement("div");
    render(renderAgents(props), container);

    const modelsButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.includes("Models"),
    );
    expect(modelsButton).toBeInstanceOf(HTMLButtonElement);
    modelsButton!.click();

    const dialog = container.querySelector<HTMLDialogElement>('[data-agent-model-dialog="true"]');
    const fallbackSelect = dialog!.querySelector<HTMLSelectElement>(
      'select[data-agent-fallback-model="true"]',
    );
    expect(fallbackSelect?.value).toBe("openai/a");
    const replacementFallback = Array.from(fallbackSelect!.options).find(
      (option) => option.value && option.value !== "openai/a",
    );
    expect(replacementFallback).toBeInstanceOf(HTMLOptionElement);
    fallbackSelect!.value = replacementFallback!.value;
    fallbackSelect!.dispatchEvent(new Event("change", { bubbles: true }));

    expect(props.onModelFallbacksChange).toHaveBeenCalledWith("beta", [replacementFallback!.value]);
  });

  it("shows Agent provider cards as compact model summaries without per-card editing", () => {
    const props = createProps({
      activePanel: "providers",
      config: {
        form: {
          agents: {
            defaults: { model: "openai/gpt-5.5" },
            list: [
              {
                id: "beta",
                name: "Beta",
                workspace: "/tmp/beta",
                model: { primary: "openai/gpt-5.6-terra" },
              },
            ],
          },
          models: {
            providers: {
              openai: { models: [{ id: "gpt-5.6-terra" }] },
              openrouter: { models: [{ id: "auto" }] },
            },
          },
        },
        loading: false,
        saving: false,
        dirty: false,
      },
      modelCatalog: [
        { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", provider: "openai" },
        { id: "openai/gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openrouter" },
      ],
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
            {
              provider: "openrouter",
              status: "ok",
              effective: { kind: "profiles", detail: "openrouter:default" },
              profiles: [],
            },
          ],
        },
      },
    });
    const container = document.createElement("div");
    render(renderAgents(props), container);

    const openaiModel = container.querySelector<HTMLElement>(
      '[data-agent-provider-model-card="openai"] .agent-provider-model-card__model',
    );
    expect(openaiModel).toBeInstanceOf(HTMLElement);
    expect(openaiModel!.textContent).toContain("Primary:");
    expect(openaiModel!.textContent).toContain("GPT-5.6 Terra");
    expect(openaiModel!.title).toContain("Primary");

    const openrouterAdd = container.querySelector<HTMLButtonElement>(
      '[data-agent-provider-model-card="openrouter"] .agent-provider-model-card__add',
    );
    expect(openrouterAdd).toBeNull();
    expect(props.onModelChange).not.toHaveBeenCalled();
  });

  it("shows Sessions as a per-Agent expandable list with delete controls", () => {
    const onSessionDelete = vi.fn();
    const props = createProps({
      activePanel: "sessions",
      selectedAgentId: "beta",
      onSessionDelete,
      sessions: {
        loading: false,
        error: null,
        result: {
          ts: 0,
          path: "/tmp/sessions.json",
          count: 2,
          defaults: { modelProvider: "openai", model: "gpt-5.5", contextTokens: null },
          sessions: [
            {
              key: "agent:alpha:webchat:direct:one",
              kind: "direct",
              updatedAt: Date.now(),
              label: "Alpha chat",
            },
            {
              key: "agent:beta:webchat:direct:two",
              kind: "direct",
              updatedAt: Date.now(),
              label: "Beta chat",
              modelProvider: "openai",
              model: "gpt-5.6-terra",
              totalTokens: 1200,
              lastMessagePreview: "last beta message",
            },
          ],
        },
      },
      cron: {
        status: null,
        loading: false,
        error: null,
        jobs: [
          {
            id: "task-two",
            sessionKey: "agent:beta:webchat:direct:two",
            name: "Beta task",
            enabled: true,
            createdAtMs: Date.now(),
            updatedAtMs: Date.now(),
            schedule: { kind: "every", everyMs: 60_000 },
            sessionTarget: "current",
            wakeMode: "now",
            payload: { kind: "agentTurn", message: "Run beta task" },
            state: {},
          },
        ],
      },
    });
    const container = document.createElement("div");
    render(renderAgents(props), container);

    expect(container.textContent).toContain("Beta chat");
    expect(container.textContent).toContain("openai/gpt-5.6-terra");
    expect(container.textContent).toContain("1200 tokens");
    expect(container.textContent).toContain("1 task");
    expect(container.textContent).not.toContain("Last access:");
    expect(container.textContent).not.toContain("Tokens used:");
    expect(container.textContent).not.toContain("Alpha chat");
    container.querySelector<HTMLButtonElement>(".session-card__delete")?.click();
    expect(onSessionDelete).toHaveBeenCalledWith("agent:beta:webchat:direct:two");
  });

  it("shows global channels in onboarding order and assigns routes to the selected Agent", () => {
    const onConfigPatch = vi.fn();
    const props = createProps({
      activePanel: "channels",
      selectedAgentId: "beta",
      onConfigPatch,
      config: {
        form: {
          bindings: [{ agentId: "alpha", match: { channel: "telegram", accountId: "ops" } }],
          channels: {
            telegram: { dmPolicy: "pairing" },
          },
        },
        loading: false,
        saving: false,
        dirty: false,
      },
      channels: {
        snapshot: {
          ts: 0,
          channelOrder: ["telegram", "whatsapp"],
          channelLabels: { telegram: "Telegram", whatsapp: "WhatsApp" },
          channelDetailLabels: {
            telegram: "Telegram Bot API",
            whatsapp: "WhatsApp QR link",
          },
          channelMeta: [
            { id: "telegram", label: "Telegram", detailLabel: "Telegram Bot API" },
            { id: "whatsapp", label: "WhatsApp", detailLabel: "WhatsApp QR link" },
          ],
          channels: {
            telegram: { running: true, connected: true },
            whatsapp: { configured: false, running: false, connected: false },
          },
          channelAccounts: {
            telegram: [
              {
                accountId: "ops",
                name: "Ops",
                configured: true,
                running: true,
                connected: true,
              },
            ],
            whatsapp: [],
          },
          channelDefaultAccountId: { telegram: "ops" },
        },
        loading: false,
        error: null,
        lastSuccess: 0,
      },
    });
    const container = document.createElement("div");
    render(renderAgents(props), container);

    expect(container.textContent).toContain("Telegram");
    expect(container.textContent).toContain("WhatsApp");
    expect(container.textContent).toContain("Default route");
    expect(container.textContent).toContain("Configured");
    expect(container.textContent).toContain("Running");
    expect(container.textContent).toContain("Route to Agent");
    expect(container.textContent).toContain("Start");
    expect(container.textContent).toContain("Stop");
    expect(container.querySelector('[aria-label="Clear credentials"]')).not.toBeNull();

    const routeSelect = container.querySelector<HTMLSelectElement>(
      '[data-test-id="channel-route-telegram-ops"]',
    );
    expect(routeSelect).not.toBeNull();
    routeSelect!.value = "beta";
    routeSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onConfigPatch).toHaveBeenCalledWith(
      ["bindings"],
      [{ agentId: "beta", match: { channel: "telegram", accountId: "ops" } }],
    );

    expect(container.querySelector("[data-agent-channel-task='true']")).toBeNull();
  });

  it("shows channel message behavior inside the selected Agent", () => {
    const onChannelsViewChange = vi.fn();
    const onConfigPatch = vi.fn();
    const onConfigRemove = vi.fn();
    const props = createProps({
      activePanel: "channels",
      selectedAgentId: "beta",
      channelsView: "messages",
      onChannelsViewChange,
      onConfigPatch,
      onConfigRemove,
      config: {
        form: {
          messages: {
            responsePrefix: "[Agent]",
            ackReaction: "👀",
            ackReactionScope: "direct",
          },
        },
        loading: false,
        saving: false,
        dirty: true,
      },
    });
    const container = document.createElement("div");
    render(renderAgents(props), container);

    const text = container.textContent ?? "";
    expect(text).toContain("Accounts");
    expect(text).toContain("Behavior");
    expect(text).toContain("Reply Behavior");
    expect(text).toContain("Ack And Status Reactions");
    expect(text).not.toContain("Route to Agent");

    const accountsTab = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === "Accounts",
    );
    accountsTab?.click();
    expect(onChannelsViewChange).toHaveBeenCalledWith("accounts");

    const prefix = container.querySelector<HTMLInputElement>('input[placeholder="none"]');
    expect(prefix?.value).toBe("[Agent]");
    prefix!.value = "[Ops]";
    prefix!.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onConfigPatch).toHaveBeenCalledWith(["messages", "responsePrefix"], "[Ops]");
  });

  it("shows the Services panel inside the selected Agent", async () => {
    const props = createProps({
      activePanel: "services",
      agentSkills: {
        report: {
          skills: [createReadySkill({ skillKey: "github", name: "github" })],
          visibleSkills: 1,
          bundledSkills: 1,
          setupSkills: 0,
        } as never,
        loading: false,
        error: null,
        agentId: "beta",
        filter: "",
      },
    });
    const container = document.createElement("div");
    render(renderAgents(props), container);

    expect(container.textContent).not.toContain("Global service connectors for Beta");
    expect(container.textContent).toContain("Connect");
    expect(container.textContent).toContain("Services");
    expect(container.textContent).toContain("Google Workspace");
    expect(container.textContent).toContain("GitHub");
    expect(container.textContent).toContain("Web/search");
    expect(container.textContent).toContain("Agent > Tools decides");
  });

  it("edits Agent coordination without using Advanced Config", () => {
    const onConfigPatch = vi.fn();
    const onConfigRemove = vi.fn();
    const props = createProps({
      activePanel: "coordination",
      selectedAgentId: "beta",
      onConfigPatch,
      onConfigRemove,
      config: {
        form: {
          agents: {
            defaults: {
              subagents: { maxConcurrent: 2, maxSpawnDepth: 1 },
            },
            list: [{ id: "beta", name: "Beta", subagents: { allowAgents: ["alpha"] } }],
          },
          tools: {
            agentToAgent: { enabled: false, allow: ["alpha"] },
          },
          session: {
            agentToAgent: { maxPingPongTurns: 2 },
          },
        },
        loading: false,
        saving: false,
        dirty: true,
      },
    });
    const container = document.createElement("div");
    render(renderAgents(props), container);

    const tabLabels = Array.from(container.querySelectorAll(".agent-tab")).map((tab) =>
      tab.textContent?.trim(),
    );
    expect(tabLabels).not.toContain("Coordination");
    const tasksTab = Array.from(container.querySelectorAll(".agent-tab")).find((tab) =>
      tab.textContent?.includes("Tasks"),
    );
    expect(tasksTab?.classList.contains("active")).toBe(true);
    const taskSubtabs = Array.from(container.querySelectorAll(".agent-task-subtab"));
    expect(taskSubtabs.map((tab) => tab.textContent?.trim())).toEqual(["Tasks(0)", "Coordination"]);
    expect(taskSubtabs[1]?.classList.contains("active")).toBe(true);
    expect(container.textContent).toContain("Subagent Spawn Policy");
    expect(container.textContent).toContain("Agent-to-Agent Access");

    container
      .querySelector<HTMLButtonElement>('[data-test-id="coordination-spawn-agent-any"]')
      ?.click();
    expect(onConfigPatch).toHaveBeenCalledWith(
      ["agents", "list", 0, "subagents", "allowAgents"],
      ["*"],
    );

    const a2aToggle = container.querySelector<HTMLInputElement>(
      '.coordination-card input[type="checkbox"]',
    );
    expect(a2aToggle).not.toBeNull();
    a2aToggle!.checked = true;
    a2aToggle!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onConfigPatch).toHaveBeenCalledWith(["tools", "agentToAgent", "enabled"], true);

    const maxDepth = Array.from(container.querySelectorAll<HTMLInputElement>("input")).find(
      (input) => input.value === "1",
    );
    expect(maxDepth).not.toBeNull();
    maxDepth!.value = "3";
    maxDepth!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onConfigPatch).toHaveBeenCalledWith(
      ["agents", "defaults", "subagents", "maxSpawnDepth"],
      3,
    );

    expect(props.onConfigSave).not.toHaveBeenCalled();
    Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.trim() === "Save")
      ?.click();
    expect(props.onConfigSave).toHaveBeenCalled();
  });

  it("keeps Agent task runs separate from coordination controls", () => {
    const props = createProps({
      activePanel: "cron",
      selectedAgentId: "beta",
      cron: {
        status: null,
        jobs: [
          {
            id: "daily",
            name: "Daily summary",
            agentId: "beta",
            enabled: true,
            createdAtMs: 1_000,
            updatedAtMs: 2_000,
            schedule: { kind: "cron", expression: "0 9 * * *" },
            sessionTarget: "reuse",
            wakeMode: "daemon",
            payload: { kind: "agentTurn", message: "Summarize the day" },
            state: {},
          },
        ] as never,
        loading: false,
        error: null,
      },
    });
    const container = document.createElement("div");
    render(renderAgents(props), container);

    const tabLabels = Array.from(container.querySelectorAll(".agent-tab")).map((tab) =>
      tab.textContent?.trim(),
    );
    expect(tabLabels).not.toContain("Coordination");
    const tasksTab = Array.from(container.querySelectorAll(".agent-tab")).find((tab) =>
      tab.textContent?.includes("Tasks"),
    );
    expect(tasksTab?.classList.contains("active")).toBe(true);
    const taskSubtabs = Array.from(container.querySelectorAll(".agent-task-subtab"));
    expect(taskSubtabs.map((tab) => tab.textContent?.trim())).toEqual(["Tasks(1)", "Coordination"]);
    expect(taskSubtabs[0]?.classList.contains("active")).toBe(true);
    expect(container.textContent).toContain("Daily summary");
    expect(container.textContent).not.toContain("Subagent Spawn Policy");
    expect(container.textContent).not.toContain("Agent-to-Agent Access");
  });

  it("reassigns selected Agent channel routes without touching other routes", () => {
    const onConfigPatch = vi.fn();
    const props = createProps({
      activePanel: "channels",
      selectedAgentId: "beta",
      onConfigPatch,
      config: {
        form: {
          bindings: [
            { agentId: "beta", match: { channel: "telegram", accountId: "ops" } },
            { agentId: "alpha", match: { channel: "discord", accountId: "support" } },
          ],
        },
        loading: false,
        saving: false,
        dirty: false,
      },
      channels: {
        snapshot: {
          ts: 0,
          channelOrder: ["telegram"],
          channelLabels: { telegram: "Telegram" },
          channels: { telegram: { running: true, connected: true } },
          channelAccounts: {
            telegram: [
              {
                accountId: "ops",
                name: "Ops",
                configured: true,
                running: true,
                connected: true,
              },
            ],
          },
          channelDefaultAccountId: { telegram: "ops" },
        },
        loading: false,
        error: null,
        lastSuccess: 0,
      },
    });
    const container = document.createElement("div");
    render(renderAgents(props), container);

    const routeSelect = container.querySelector<HTMLSelectElement>(
      '[data-test-id="channel-route-telegram-ops"]',
    );
    expect(routeSelect).not.toBeNull();
    routeSelect!.value = "alpha";
    routeSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onConfigPatch).toHaveBeenCalledWith(
      ["bindings"],
      [
        { agentId: "alpha", match: { channel: "discord", accountId: "support" } },
        { agentId: "alpha", match: { channel: "telegram", accountId: "ops" } },
      ],
    );
  });

  it("starts Agent task creation for the selected Agent", () => {
    const onCronCreate = vi.fn();
    const props = createProps({
      activePanel: "cron",
      selectedAgentId: "beta",
      onCronCreate,
      webhookTriggers: {
        result: {
          enabled: true,
          basePath: "/hooks",
          hasToken: true,
          triggers: [],
        },
        loading: false,
        busy: false,
        error: null,
        message: null,
        draft: null,
      },
    });
    const container = document.createElement("div");
    render(renderAgents(props), container);

    container.querySelector<HTMLButtonElement>("[data-agent-task-create='true']")?.click();
    expect(onCronCreate).toHaveBeenCalledWith("beta");
    const actionOrder = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        "[data-agent-task-create='true'], [data-agent-task-trigger-create='true'], [aria-label='Create workflow'], [aria-label='Create graph workflow'], [aria-label='Create program'], [data-agent-task-template-library='true']",
      ),
    ).map((button) => button.textContent?.replace(/\s+/g, " ").trim());
    expect(actionOrder).toEqual(["Task", "Trigger", "Workflow", "Graph", "Program", "Templates"]);
  });

  it("wires Agent webhook triggers from the Tasks panel", () => {
    const onCreate = vi.fn();
    const onEdit = vi.fn();
    const onToggle = vi.fn();
    const onRemove = vi.fn();
    const onTest = vi.fn();
    const props = createProps({
      activePanel: "cron",
      selectedAgentId: "beta",
      webhookTriggers: {
        result: {
          enabled: true,
          basePath: "/hooks",
          hasToken: true,
          triggers: [
            {
              id: "webhook-beta",
              enabled: true,
              name: "Beta hook",
              path: "beta",
              urlPath: "/hooks/beta",
              action: "agent",
              agentId: "beta",
              wakeMode: "now",
              deliver: false,
              channel: "last",
              notifyPolicy: "done_only",
              allowUnsafeExternalContent: false,
            },
          ],
        },
        loading: false,
        busy: false,
        error: null,
        message: null,
        draft: null,
      },
      onWebhookTriggerCreate: onCreate,
      onWebhookTriggerEdit: onEdit,
      onWebhookTriggerToggle: onToggle,
      onWebhookTriggerRemove: onRemove,
      onWebhookTriggerTest: onTest,
    });
    const container = document.createElement("div");
    render(renderAgents(props), container);

    expect(container.textContent).toContain("Beta hook");
    expect(container.textContent).toContain("/hooks/beta");
    expect(container.querySelector('[aria-label="Tasks help"]')?.getAttribute("title")).toContain(
      "Tasks is the Agent workbench",
    );
    Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Trigger"))
      ?.click();
    expect(onCreate).toHaveBeenCalledWith("beta");

    container.querySelector<HTMLButtonElement>('button[aria-label="Edit trigger"]')?.click();
    expect(onEdit).toHaveBeenCalledWith(
      expect.objectContaining({ id: "webhook-beta", agentId: "beta" }),
    );

    container.querySelector<HTMLButtonElement>('button[aria-label="Test trigger"]')?.click();
    expect(onTest).toHaveBeenCalledWith(expect.objectContaining({ id: "webhook-beta" }));

    container.querySelector<HTMLButtonElement>('button[aria-label="Disable trigger"]')?.click();
    expect(onToggle).toHaveBeenCalledWith(expect.objectContaining({ id: "webhook-beta" }), false);

    container.querySelector<HTMLButtonElement>('button[aria-label="Delete trigger"]')?.click();
    expect(onRemove).toHaveBeenCalledWith(expect.objectContaining({ id: "webhook-beta" }));
  });

  it("edits Agent webhook triggers with saved workflow targets", () => {
    const onPatch = vi.fn();
    const onSave = vi.fn();
    const props = createProps({
      activePanel: "cron",
      selectedAgentId: "beta",
      webhookTriggers: {
        result: {
          enabled: true,
          basePath: "/hooks",
          hasToken: true,
          triggers: [],
        },
        loading: false,
        busy: false,
        error: null,
        message: null,
        draft: {
          name: "Workflow hook",
          path: "release",
          action: "workflow",
          agentId: "beta",
          workflowDefinitionId: "release-flow",
          notifyPolicy: "done_only",
        },
      },
      taskWorkflow: {
        draft: null,
        graphDraft: null,
        busy: false,
        error: null,
        message: null,
        definitions: {
          agentId: "beta",
          definitions: [
            {
              id: "release-flow",
              agentId: "beta",
              mode: "graph",
              name: "Release flow",
              task: "Review release",
              notifyPolicy: "done_only",
              steps: [{ id: "start", label: "Start", type: "checkpoint" }],
              graph: {
                version: 2,
                startNodeId: "start",
                nodes: [
                  { id: "start", type: "start", label: "Start" },
                  { id: "done", type: "end", label: "Done" },
                ],
                edges: [{ id: "start-success-done", from: "start", to: "done", on: "success" }],
              },
              createdAt: 1,
              updatedAt: 2,
            },
          ],
        },
        definitionsLoading: false,
        definitionsBusy: false,
        definitionsError: null,
        runs: null,
        runsLoading: false,
        runsBusy: false,
        runsError: null,
      },
      onWebhookTriggerPatch: onPatch,
      onWebhookTriggerSave: onSave,
    });
    const container = document.createElement("div");
    render(renderAgents(props), container);

    expect(container.textContent).toContain("Workflow target");
    expect(container.textContent).toContain("Release flow");
    const target = container
      .querySelector<HTMLOptionElement>('option[value="release-flow"]')
      ?.closest("select") as HTMLSelectElement | null;
    expect(target).toBeTruthy();
    target!.value = "";
    target!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith({ workflowDefinitionId: "" });

    container.querySelector<HTMLButtonElement>(".webhook-trigger-editor-actions .primary")?.click();
    expect(onSave).toHaveBeenCalled();
  });

  it("wires simple Agent workflows from the Tasks panel", () => {
    const onCreate = vi.fn();
    const onPatch = vi.fn();
    const onPreview = vi.fn();
    const onSave = vi.fn();
    const onRun = vi.fn();
    const onEditDefinition = vi.fn();
    const onRunDefinition = vi.fn();
    const onRemoveDefinition = vi.fn();
    const onOpenRunGraph = vi.fn();
    const onCancelRun = vi.fn();
    const onOpenSource = vi.fn();
    const onCancel = vi.fn();
    const savedWorkflow = {
      id: "daily-smoke",
      agentId: "beta",
      mode: "steps" as const,
      name: "Daily smoke",
      task: "Run daily smoke",
      notifyPolicy: "done_only" as const,
      steps: [
        { id: "prepare", label: "Prepare", type: "note" as const },
        { id: "approve", label: "Approve", type: "approval" as const },
      ],
      createdAt: 1,
      updatedAt: 2,
    };
    const savedGraphWorkflow = {
      id: "daily-smoke-graph",
      agentId: "beta",
      mode: "graph" as const,
      name: "Daily graph",
      task: "Run daily graph",
      notifyPolicy: "state_changes" as const,
      steps: [
        { id: "prepare", label: "Prepare", type: "checkpoint" as const },
        { id: "done", label: "Done", type: "handoff" as const },
      ],
      graph: {
        version: 2 as const,
        startNodeId: "start",
        nodes: [
          { id: "start", type: "start" as const, label: "Start" },
          { id: "prepare", type: "task" as const, label: "Prepare" },
          { id: "done", type: "end" as const, label: "Done" },
        ],
        edges: [
          { id: "start-success-prepare", from: "start", to: "prepare", on: "success" as const },
          { id: "prepare-success-done", from: "prepare", to: "done", on: "success" as const },
        ],
      },
      createdAt: 1,
      updatedAt: 2,
    };
    const workflowRun = {
      flowId: "flow:workflow:run-1",
      syncMode: "workflow" as const,
      revision: 0,
      status: "running" as const,
      goal: "Daily smoke",
      notifyPolicy: "done_only" as const,
      agentId: "beta",
      definitionId: "daily-smoke-graph",
      taskIds: ["CLI:run-1"],
      currentTaskId: "CLI:run-1",
      currentStep: "Prepare",
      createdAt: 3,
      updatedAt: 4,
      metadata: {
        sourceTaskId: "wallet:approval:run-1",
        sourceTaskRunId: "wallet-run-1",
        sourceTaskSource: "wallet",
        sourceTaskRuntime: "wallet",
        sourceTaskKind: "wallet_approval",
        sourceTask: {
          taskId: "wallet:approval:run-1",
          runId: "wallet-run-1",
          source: "wallet",
          runtime: "wallet",
          taskKind: "wallet_approval",
          task: "Wallet approval run",
          metadata: { approvalId: "wallet-run-1" },
        },
      },
    };
    const blockedWorkflowRun = {
      flowId: "flow:workflow:blocked-1",
      syncMode: "workflow" as const,
      revision: 0,
      status: "blocked" as const,
      goal: "Approval workflow",
      notifyPolicy: "state_changes" as const,
      agentId: "beta",
      definitionId: "daily-smoke-graph",
      taskIds: ["CLI:blocked-1"],
      currentTaskId: "CLI:blocked-1",
      blockedTaskId: "CLI:blocked-1",
      currentStep: "Approve publish",
      blockedSummary: "Approval required.",
      createdAt: 5,
      updatedAt: 6,
      metadata: {
        source: "CLI",
        runtime: "cli",
        taskKind: "workflow",
      },
    };
    const props = createProps({
      activePanel: "cron",
      selectedAgentId: "beta",
      taskWorkflow: {
        draft: null,
        graphDraft: null,
        busy: false,
        error: null,
        message: null,
        definitions: { agentId: "beta", definitions: [savedWorkflow, savedGraphWorkflow] },
        definitionsLoading: false,
        definitionsBusy: false,
        definitionsError: null,
        runs: {
          generatedAt: 4,
          total: 2,
          flows: [workflowRun, blockedWorkflowRun],
          summary: {
            total: 2,
            active: 1,
            terminal: 1,
            blocked: 1,
            byStatus: { running: 1, blocked: 1 },
          },
        },
        runsLoading: false,
        runsBusy: false,
        runsError: null,
      },
      onTaskWorkflowCreate: onCreate,
      onTaskWorkflowPatch: onPatch,
      onTaskWorkflowPreview: onPreview,
      onTaskWorkflowSave: onSave,
      onTaskWorkflowRun: onRun,
      onTaskWorkflowEditDefinition: onEditDefinition,
      onTaskWorkflowRunDefinition: onRunDefinition,
      onTaskWorkflowRemoveDefinition: onRemoveDefinition,
      onTaskWorkflowOpenRunGraph: onOpenRunGraph,
      onTaskWorkflowCancelRun: onCancelRun,
      onTaskLedgerOpenSource: onOpenSource,
      onTaskWorkflowCancel: onCancel,
    });
    const container = document.createElement("div");
    render(renderAgents(props), container);

    expect(container.textContent).toContain("Daily smoke");
    expect(container.textContent).toContain("Workflow runs");
    expect(container.textContent).toContain("1 needs review");
    expect(container.textContent).toContain("2 steps");
    expect(container.textContent).toContain("Source task");
    expect(container.textContent).toContain("Wallet approval run");
    expect(container.textContent).toContain("wallet:approval:run-1");
    expect(container.textContent).toContain("Approval workflow");
    expect(container.textContent).toContain("Needs review");
    expect(container.textContent).toContain("Blocked task");
    expect(container.textContent).toContain("Approve publish");
    expect(container.textContent).toContain("Approval required.");
    container.querySelector<HTMLButtonElement>('button[aria-label="Open workflow graph"]')?.click();
    expect(onOpenRunGraph).toHaveBeenCalledWith(workflowRun);
    container.querySelector<HTMLButtonElement>('button[aria-label="Open source task"]')?.click();
    expect(onOpenSource).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "wallet:approval:run-1",
        runId: "wallet-run-1",
        source: "wallet",
        runtime: "wallet",
        taskKind: "wallet_approval",
        metadata: { approvalId: "wallet-run-1" },
      }),
    );
    container.querySelector<HTMLButtonElement>('button[aria-label="Open run task"]')?.click();
    expect(onOpenSource).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "CLI:run-1",
        source: "CLI",
        runtime: "cli",
        taskKind: "workflow",
      }),
    );
    container.querySelector<HTMLButtonElement>('button[aria-label="Open blocked task"]')?.click();
    expect(onOpenSource).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "CLI:blocked-1",
        source: "CLI",
        runtime: "cli",
        taskKind: "workflow",
        status: "blocked",
      }),
    );
    container.querySelector<HTMLButtonElement>('button[aria-label="Cancel workflow run"]')?.click();
    expect(onCancelRun).toHaveBeenCalledWith(workflowRun);
    container.querySelector<HTMLButtonElement>('button[aria-label="Run workflow"]')?.click();
    expect(onRunDefinition).toHaveBeenCalledWith(savedWorkflow);
    container.querySelector<HTMLButtonElement>('button[aria-label="Edit workflow"]')?.click();
    expect(onEditDefinition).toHaveBeenCalledWith(savedWorkflow);
    container.querySelector<HTMLButtonElement>('button[aria-label="Delete workflow"]')?.click();
    expect(onRemoveDefinition).toHaveBeenCalledWith(savedWorkflow);

    Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Workflow"))
      ?.click();
    expect(onCreate).toHaveBeenCalledWith("beta");

    render(
      renderAgents({
        ...props,
        taskWorkflow: {
          draft: {
            name: "Smoke workflow",
            task: "Run smoke workflow",
            stepsText: "Prepare\nVerify",
            notifyPolicy: "done_only",
          },
          graphDraft: null,
          busy: false,
          error: null,
          message: "Preview ok",
          definitions: { agentId: "beta", definitions: [savedWorkflow] },
          definitionsLoading: false,
          definitionsBusy: false,
          definitionsError: null,
          runs: {
            generatedAt: 4,
            total: 1,
            flows: [workflowRun],
            summary: {
              total: 1,
              active: 1,
              terminal: 0,
              blocked: 0,
              byStatus: { running: 1 },
            },
          },
          runsLoading: false,
          runsBusy: false,
          runsError: null,
        },
      }),
      container,
    );

    expect(container.textContent).toContain("Workflows");
    expect(container.textContent).toContain("Preview ok");
    const nameInput = Array.from(container.querySelectorAll<HTMLInputElement>("input")).find(
      (input) => input.value === "Smoke workflow",
    );
    expect(nameInput).toBeInstanceOf(HTMLInputElement);
    nameInput!.value = "Changed workflow";
    nameInput!.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith({ name: "Changed workflow" });

    Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Preview"))
      ?.click();
    expect(onPreview).toHaveBeenCalledWith("beta");
    Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Run workflow"))
      ?.click();
    expect(onRun).toHaveBeenCalledWith("beta");
    Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Save workflow"))
      ?.click();
    expect(onSave).toHaveBeenCalledWith("beta");
    Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.trim() === "Cancel")
      ?.click();
    expect(onCancel).toHaveBeenCalled();
  });

  it("wires graph workflow builder controls from the Tasks panel", () => {
    const onGraphCreate = vi.fn();
    const onGraphPatch = vi.fn();
    const onGraphAddNode = vi.fn();
    const onGraphUpdateNode = vi.fn();
    const onGraphRemoveNode = vi.fn();
    const onGraphMoveNode = vi.fn();
    const onGraphAddEdge = vi.fn();
    const onGraphUpdateEdge = vi.fn();
    const onGraphRemoveEdge = vi.fn();
    const onGraphAutoLayout = vi.fn();
    const onGraphImportJson = vi.fn();
    const onGraphExportJson = vi.fn();
    const onGraphPreview = vi.fn();
    const onGraphSave = vi.fn();
    const onGraphRun = vi.fn();
    const onUseTemplate = vi.fn();
    const onEditGraphDefinition = vi.fn();
    const onRunDefinition = vi.fn();
    const savedGraph = {
      id: "graph-smoke",
      agentId: "beta",
      mode: "graph" as const,
      name: "Graph smoke",
      task: "Run graph smoke",
      notifyPolicy: "state_changes" as const,
      steps: [
        { id: "start", label: "Start", type: "checkpoint" as const },
        { id: "approval", label: "Approve", type: "checkpoint" as const },
        { id: "done", label: "Done", type: "checkpoint" as const },
      ],
      graph: {
        version: 2 as const,
        startNodeId: "start",
        nodes: [
          { id: "start", type: "start" as const, label: "Start" },
          {
            id: "approval",
            type: "approval" as const,
            label: "Approve",
            input: "Approve run.",
          },
          { id: "done", type: "end" as const, label: "Done" },
        ],
        edges: [
          { id: "start-success-approval", from: "start", to: "approval", on: "success" as const },
          { id: "approval-approved-done", from: "approval", to: "done", on: "approved" as const },
        ],
        layout: {
          nodes: {
            start: { x: 24, y: 60 },
            approval: { x: 240, y: 60 },
            done: { x: 456, y: 60 },
          },
        },
      },
      createdAt: 1,
      updatedAt: 2,
    };
    const graphDraft = {
      id: "graph-smoke",
      name: "Graph smoke",
      task: "Run graph smoke",
      notifyPolicy: "state_changes" as const,
      graph: savedGraph.graph,
      selectedNodeId: "approval",
      selectedEdgeId: "approval-approved-done",
      connectFromNodeId: null,
      zoom: 1,
      panX: 0,
      panY: 0,
      jsonText: JSON.stringify(savedGraph.graph, null, 2),
      jsonOpen: false,
      runState: {
        taskId: "CLI:workflow-graph-run",
        runId: "workflow-graph-run",
        source: "CLI" as const,
        runtime: "cli" as const,
        taskKind: "workflow",
        task: "Graph smoke",
        status: "blocked" as const,
        deliveryStatus: "not_applicable" as const,
        updatedAt: 4,
        steps: [
          { id: "start", label: "Start", status: "succeeded" as const },
          {
            id: "approval",
            label: "Approve",
            status: "blocked" as const,
            error: "Approval required.",
          },
          { id: "done", label: "Done", status: "queued" as const },
        ],
      },
    };
    const baseTaskWorkflow = {
      draft: null,
      graphDraft: null,
      busy: false,
      error: null,
      message: null,
      definitions: { agentId: "beta", definitions: [savedGraph] },
      definitionsLoading: false,
      definitionsBusy: false,
      definitionsError: null,
      templates: {
        templates: [
          {
            id: "graph-template",
            name: "Graph template",
            description: "Template with graph nodes",
            task: "Run graph template",
            notifyPolicy: "done_only" as const,
            tags: ["test"],
            steps: [{ id: "task", label: "Task", type: "checkpoint" as const }],
            graph: savedGraph.graph,
          },
        ],
      },
      templatesLoading: false,
      templatesError: null,
      runs: {
        generatedAt: 4,
        total: 0,
        flows: [],
        summary: { total: 0, active: 0, terminal: 0, blocked: 0, byStatus: {} },
      },
      runsLoading: false,
      runsBusy: false,
      runsError: null,
    };
    const props = createProps({
      activePanel: "cron",
      selectedAgentId: "beta",
      taskWorkflow: baseTaskWorkflow,
      onTaskWorkflowGraphCreate: onGraphCreate,
      onTaskWorkflowUseTemplate: onUseTemplate,
      onTaskWorkflowGraphPatch: onGraphPatch,
      onTaskWorkflowGraphAddNode: onGraphAddNode,
      onTaskWorkflowGraphUpdateNode: onGraphUpdateNode,
      onTaskWorkflowGraphRemoveNode: onGraphRemoveNode,
      onTaskWorkflowGraphMoveNode: onGraphMoveNode,
      onTaskWorkflowGraphAddEdge: onGraphAddEdge,
      onTaskWorkflowGraphUpdateEdge: onGraphUpdateEdge,
      onTaskWorkflowGraphRemoveEdge: onGraphRemoveEdge,
      onTaskWorkflowGraphAutoLayout: onGraphAutoLayout,
      onTaskWorkflowGraphImportJson: onGraphImportJson,
      onTaskWorkflowGraphExportJson: onGraphExportJson,
      onTaskWorkflowGraphPreview: onGraphPreview,
      onTaskWorkflowGraphSave: onGraphSave,
      onTaskWorkflowGraphRun: onGraphRun,
      onTaskWorkflowEditGraphDefinition: onEditGraphDefinition,
      onTaskWorkflowRunDefinition: onRunDefinition,
      onTaskWorkflowCancel: vi.fn(),
    });
    const container = document.createElement("div");
    render(renderAgents(props), container);

    expect(container.textContent).toContain("Graph smoke");
    expect(container.textContent).toContain("Graph template");
    expect(container.textContent).toContain("3 nodes");
    container.querySelector<HTMLButtonElement>('button[aria-label="Use Graph template"]')?.click();
    expect(onUseTemplate).toHaveBeenCalledWith(
      "beta",
      expect.objectContaining({ id: "graph-template" }),
    );
    container.querySelector<HTMLButtonElement>('button[aria-label="Edit workflow"]')?.click();
    expect(onEditGraphDefinition).toHaveBeenCalledWith(savedGraph);
    container.querySelector<HTMLButtonElement>('button[aria-label="Run workflow"]')?.click();
    expect(onRunDefinition).toHaveBeenCalledWith(savedGraph);
    Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Graph"))
      ?.click();
    expect(onGraphCreate).toHaveBeenCalledWith("beta");

    render(
      renderAgents({
        ...props,
        taskWorkflow: {
          ...baseTaskWorkflow,
          graphDraft,
          message: "Graph preview ok",
        },
      }),
      container,
    );

    expect(container.querySelector('[data-workflow-graph-builder="true"]')).toBeTruthy();
    expect(container.querySelector('[data-workflow-run-timeline="true"]')).toBeTruthy();
    expect(container.textContent).toContain("Graph preview ok");
    expect(container.textContent).toContain("Waiting at Approve");
    expect(container.textContent).toContain("Run timeline");
    expect(container.textContent).toContain("not applicable · CLI/cli");
    expect(container.textContent).toContain("Approval required.");
    expect(
      container.querySelector('[data-node-id="approval"]')?.getAttribute("data-run-state"),
    ).toBe("blocked");
    expect(container.querySelector('[data-node-id="approval"]')?.getAttribute("title")).toContain(
      "Approve",
    );
    expect(container.querySelector('[data-node-id="start"]')?.getAttribute("data-run-state")).toBe(
      "succeeded",
    );
    expect(container.textContent).toContain("100%");
    const approvalNode = container.querySelector<HTMLElement>('[data-node-id="approval"]');
    expect(approvalNode).toBeInstanceOf(HTMLElement);
    approvalNode!.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        clientX: 100,
        clientY: 120,
      }),
    );
    window.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        clientX: 126,
        clientY: 152,
      }),
    );
    window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    expect(onGraphMoveNode).toHaveBeenCalledWith("approval", 266, 92);
    container.querySelector<HTMLButtonElement>(".workflow-graph-run-step--blocked")?.click();
    expect(onGraphPatch).toHaveBeenCalledWith({
      selectedNodeId: "approval",
      selectedEdgeId: null,
    });
    const nameInput = Array.from(container.querySelectorAll<HTMLInputElement>("input")).find(
      (input) => input.value === "Graph smoke",
    );
    expect(nameInput).toBeInstanceOf(HTMLInputElement);
    nameInput!.value = "Graph changed";
    nameInput!.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onGraphPatch).toHaveBeenCalledWith({ name: "Graph changed" });

    Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("approval"))
      ?.click();
    expect(onGraphAddNode).toHaveBeenCalledWith("approval");

    const labelInput = Array.from(container.querySelectorAll<HTMLInputElement>("input")).find(
      (input) => input.value === "Approve",
    );
    expect(labelInput).toBeInstanceOf(HTMLInputElement);
    labelInput!.value = "Approval gate";
    labelInput!.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onGraphUpdateNode).toHaveBeenCalledWith("approval", { label: "Approval gate" });

    const edgeSelect = Array.from(container.querySelectorAll<HTMLSelectElement>("select")).find(
      (select) => Array.from(select.options).some((option) => option.value === "approved"),
    );
    expect(edgeSelect).toBeInstanceOf(HTMLSelectElement);
    edgeSelect!.value = "rejected";
    edgeSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onGraphUpdateEdge).toHaveBeenCalledWith(expect.any(String), { on: "rejected" });

    Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Auto layout"))
      ?.click();
    expect(onGraphAutoLayout).toHaveBeenCalled();
    Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.trim() === "JSON")
      ?.click();
    expect(onGraphPatch).toHaveBeenCalledWith({
      jsonOpen: true,
      jsonText: JSON.stringify(savedGraph.graph, null, 2),
    });

    render(
      renderAgents({
        ...props,
        taskWorkflow: {
          ...baseTaskWorkflow,
          graphDraft: { ...graphDraft, jsonOpen: true },
          message: "Graph preview ok",
        },
      }),
      container,
    );
    expect(container.textContent).toContain("Graph JSON");
    const jsonArea = container.querySelector<HTMLTextAreaElement>(".workflow-graph-json textarea");
    expect(jsonArea).toBeInstanceOf(HTMLTextAreaElement);
    jsonArea!.value = '{"nodes":[],"edges":[]}';
    jsonArea!.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onGraphPatch).toHaveBeenCalledWith({ jsonText: '{"nodes":[],"edges":[]}' });
    Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Import JSON"))
      ?.click();
    expect(onGraphImportJson).toHaveBeenCalled();
    Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Refresh and copy"))
      ?.click();
    expect(onGraphExportJson).toHaveBeenCalled();

    Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Preview graph"))
      ?.click();
    expect(onGraphPreview).toHaveBeenCalledWith("beta");
    Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Run graph"))
      ?.click();
    expect(onGraphRun).toHaveBeenCalledWith("beta");
    Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Save graph"))
      ?.click();
    expect(onGraphSave).toHaveBeenCalledWith("beta");
    container
      .querySelector<HTMLButtonElement>('button[aria-label="Delete workflow edge"]')
      ?.click();
    expect(onGraphRemoveEdge).toHaveBeenCalledWith("start-success-approval");
    Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.trim() === "Delete")
      ?.click();
    expect(onGraphRemoveNode).toHaveBeenCalledWith("approval");
  });

  it.skip("shows ACP and webhook task ledger details with session and retry actions", () => {
    const onOpenSession = vi.fn();
    const onControl = vi.fn();
    const now = Date.now();
    const props = createProps({
      activePanel: "cron",
      selectedAgentId: "beta",
      onCronOpenSession: onOpenSession,
      onTaskLedgerControl: onControl,
      taskLedger: {
        loading: false,
        busy: false,
        error: null,
        result: {
          generatedAt: now,
          total: 3,
          summary: {
            total: 3,
            queued: 0,
            running: 0,
            terminal: 3,
            failed: 1,
            lost: 0,
            bySource: { subagent: 1, webhook: 1, media: 1 },
            byStatus: { succeeded: 2, failed: 1 },
          },
          audit: { findings: [] },
          tasks: [
            {
              taskId: "task-acp",
              runId: "run-acp",
              source: "subagent",
              runtime: "acp",
              taskKind: "acp-spawn",
              agentId: "beta",
              requesterSessionKey: "agent:beta:webchat:parent",
              task: "Delegate research",
              status: "succeeded",
              deliveryStatus: "delivered",
              notifyPolicy: "done_only",
              createdAt: now - 2_000,
              updatedAt: now - 1_000,
              metadata: { childSessionKey: "agent:beta:subagent:child", mode: "run" },
              delivery: { channel: "telegram", target: "ops", messageId: "42" },
              loadedSkills: ["diagram-maker"],
              loadedTools: ["web.search"],
              memoryScope: "agent",
              usage: { totalTokens: 123, inputTokens: 45, outputTokens: 78, unpriced: true },
            },
            {
              taskId: "task-webhook",
              runId: "run-webhook",
              source: "webhook",
              runtime: "webhook",
              taskKind: "workflow",
              sourceId: "webhook-beta",
              agentId: "beta",
              sessionKey: "agent:beta:webhook:run",
              task: "Webhook smoke",
              status: "failed",
              deliveryStatus: "not_delivered",
              notifyPolicy: "state_changes",
              createdAt: now - 4_000,
              updatedAt: now - 3_000,
              error: "Webhook failed",
              metadata: { triggerId: "webhook-beta", hookName: "Beta hook" },
            },
            {
              taskId: "task-media",
              runId: "run-media",
              source: "media",
              runtime: "media",
              taskKind: "video_generation",
              sourceId: "video_generate:runway",
              agentId: "beta",
              sessionKey: "agent:beta:webchat:direct:1",
              task: "Generate launch clip",
              status: "succeeded",
              progressSummary: "Generating video",
              terminalSummary: "Generated 1 video with runway/gen4.",
              deliveryStatus: "not_applicable",
              notifyPolicy: "silent",
              createdAt: now - 5_000,
              updatedAt: now - 500,
              provider: "runway",
              model: "gen4",
              metadata: {
                providerHint: "runway",
                mediaPaths: ["/tmp/fased/generated/demo.mp4"],
                mediaContentTypes: ["video/mp4"],
              },
            },
          ],
        },
      },
    });
    const container = document.createElement("div");
    render(renderAgents(props), container);

    expect(container.querySelector('[aria-label="Tasks help"]')?.getAttribute("title")).toContain(
      "Activity records what actually happened",
    );
    expect(container.textContent).toContain("ACP spawn");
    expect(container.textContent).toContain("Webhook trigger");
    expect(container.textContent).toContain("Child session");
    expect(container.textContent).toContain("agent:beta:subagent:child");
    expect(container.textContent).toContain("Trigger");
    expect(container.textContent).toContain("webhook-beta");
    expect(container.textContent).toContain("123 total");
    expect(taskLedgerFilterText(container, "media")).toBe("Media 1");
    expect(container.textContent).toContain("Generated 1 video with runway/gen4.");
    expect(container.textContent).toContain("Artifact paths");
    expect(container.textContent).toContain("/tmp/fased/generated/demo.mp4");

    container
      .querySelector<HTMLButtonElement>(
        '#task-ledger-task-acp button[aria-label="Open task session"]',
      )
      ?.click();
    expect(onOpenSession).toHaveBeenCalledWith("agent:beta:subagent:child");

    const retryButtons = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).filter(
      (button) => button.getAttribute("aria-label") === "Replay webhook workflow",
    );
    expect(retryButtons).toHaveLength(1);
    retryButtons[0]?.click();
    expect(onControl).toHaveBeenCalledWith("retry", "task-webhook");
  });

  it.skip("filters task ledger sources and keeps wallet marketplace mining records view-only", () => {
    const onSourceFilterChange = vi.fn();
    const onControl = vi.fn();
    const onOpenSource = vi.fn();
    const onWorkflowReview = vi.fn();
    const now = Date.now();
    const baseResult = {
      generatedAt: now,
      total: 3,
      summary: {
        total: 3,
        queued: 0,
        running: 1,
        terminal: 2,
        failed: 0,
        lost: 0,
        bySource: { wallet: 1, marketplace: 1, mining: 1 },
        byStatus: { running: 1, succeeded: 2 },
      },
      audit: { findings: [] },
      tasks: [
        {
          taskId: "wallet:approval:smoke",
          runId: "wallet-approval-smoke",
          source: "wallet",
          runtime: "wallet",
          taskKind: "wallet_approval",
          agentId: "beta",
          task: "Wallet approval: 0.01 SOL",
          status: "succeeded",
          deliveryStatus: "not_applicable",
          notifyPolicy: "state_changes",
          createdAt: now - 3_000,
          updatedAt: now - 2_000,
          metadata: { approvalId: "wallet-smoke", walletId: "agent-1", txHash: "wallet-tx" },
        },
        {
          taskId: "marketplace:order:smoke",
          runId: "marketplace-order-smoke",
          source: "marketplace",
          runtime: "marketplace",
          taskKind: "marketplace_order",
          agentId: "beta",
          task: "Marketplace order: Smoke order",
          status: "succeeded",
          deliveryStatus: "delivered",
          notifyPolicy: "state_changes",
          createdAt: now - 2_000,
          updatedAt: now - 1_000,
          metadata: { orderId: "order-smoke", deliveryStatus: "delivered" },
        },
        {
          taskId: "mining:start:smoke",
          runId: "mining-start-smoke",
          source: "mining",
          runtime: "mining",
          taskKind: "mining_control",
          agentId: "beta",
          task: "Mining: Start mining",
          status: "running",
          deliveryStatus: "not_applicable",
          notifyPolicy: "state_changes",
          createdAt: now - 1_000,
          updatedAt: now,
          metadata: { method: "sat.startMining", walletId: "mining-1" },
        },
      ],
    } as const;
    const props = createProps({
      activePanel: "cron",
      selectedAgentId: "beta",
      onTaskLedgerControl: onControl,
      onTaskLedgerOpenSource: onOpenSource,
      onTaskLedgerSourceFilterChange: onSourceFilterChange,
      onTaskLedgerWorkflowReview: onWorkflowReview,
      taskLedger: {
        loading: false,
        busy: false,
        error: null,
        sourceFilter: "all",
        result: baseResult,
      },
    });
    const container = document.createElement("div");
    render(renderAgents(props), container);

    expect(container.textContent).toContain("Wallet approval");
    expect(container.textContent).toContain("Marketplace order");
    expect(container.textContent).toContain("Mining control");
    const sourceSelect = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Work type"]',
    );
    expect(sourceSelect).toBeInstanceOf(HTMLSelectElement);
    expect(container.querySelectorAll(".agent-task-view-only")).toHaveLength(3);
    expect(container.textContent).toContain("Wallet controls");
    expect(container.textContent).toContain("Marketplace controls");
    expect(container.textContent).toContain("Mining controls");
    expect(container.textContent).toContain("Wallet signing, passkey approval");
    expect(container.textContent).toContain("Marketplace settlement, delivery");
    expect(container.textContent).toContain("Mining start/stop, capital");
    expect(container.textContent).toContain("Source actions");
    expect(container.textContent).toContain("Open source");
    expect(container.textContent).not.toContain("Review workflow");
    expect(container.querySelectorAll('button[aria-label="Cancel task"]')).toHaveLength(0);
    expect(container.querySelectorAll('button[aria-label="Notify on state changes"]')).toHaveLength(
      0,
    );
    expect(container.querySelector('[data-testid="task-work-filter-all"]')?.textContent).toContain(
      "All",
    );
    expect(
      container.querySelector('[data-testid="task-work-filter-source-wallet"]')?.textContent,
    ).toContain("Wallet");
    expect(
      container.querySelector('[data-testid="task-work-filter-source-marketplace"]')?.textContent,
    ).toContain("Marketplace");
    expect(
      container.querySelector('[data-testid="task-work-filter-source-mining"]')?.textContent,
    ).toContain("Mining");
    expect(sourceSelect?.value).toBe("all");
    expect(container.querySelector('button[aria-label="Review approval workflow"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Review delivery workflow"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Open wallet approval"]')).toBeTruthy();
    expect(container.querySelector('button[aria-label="Open marketplace order"]')).toBeTruthy();
    expect(container.querySelector('button[aria-label="Open mining action"]')).toBeTruthy();
    container
      .querySelector<HTMLButtonElement>('button[aria-label="Open wallet approval"]')
      ?.click();
    expect(onOpenSource).toHaveBeenCalledWith(
      expect.objectContaining({ source: "wallet", taskId: "wallet:approval:smoke" }),
    );
    container
      .querySelector<HTMLButtonElement>('button[aria-label="Open marketplace order"]')
      ?.click();
    expect(onOpenSource).toHaveBeenCalledWith(
      expect.objectContaining({ source: "marketplace", taskId: "marketplace:order:smoke" }),
    );
    container.querySelector<HTMLButtonElement>('button[aria-label="Open mining action"]')?.click();
    expect(onOpenSource).toHaveBeenCalledWith(
      expect.objectContaining({ source: "mining", taskId: "mining:start:smoke" }),
    );
    expect(onWorkflowReview).not.toHaveBeenCalled();

    const miningFilter = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Activity source"]',
    );
    expect(miningFilter).not.toBeNull();
    miningFilter!.value = "mining";
    miningFilter!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onSourceFilterChange).toHaveBeenCalledWith("mining");

    render(
      renderAgents(
        createProps({
          activePanel: "cron",
          selectedAgentId: "beta",
          onTaskLedgerSourceFilterChange: onSourceFilterChange,
          taskLedger: {
            loading: false,
            busy: false,
            error: null,
            sourceFilter: "mining",
            result: baseResult,
          },
        }),
      ),
      container,
    );
    expect(
      container.querySelector<HTMLSelectElement>('select[aria-label="Activity source"]')?.value,
    ).toBe("mining");
    expect(container.textContent).toContain("Mining: Start mining");
    expect(container.textContent).not.toContain("Marketplace order: Smoke order");
    expect(container.textContent).not.toContain("Wallet approval: 0.01 SOL");
  });

  it("keeps mining activity out of the primary Tasks list when no saved tasks exist", () => {
    const now = Date.now();
    const props = createProps({
      activePanel: "cron",
      selectedAgentId: "beta",
      cron: {
        status: null,
        loading: false,
        error: null,
        jobs: [],
      },
      webhookTriggers: {
        result: {
          enabled: true,
          basePath: "/hooks",
          hasToken: true,
          triggers: [],
        },
        loading: false,
        busy: false,
        error: null,
        message: null,
        draft: null,
      },
      taskWorkflow: {
        draft: null,
        graphDraft: null,
        busy: false,
        error: null,
        message: null,
        definitions: {
          agentId: "beta",
          definitions: [],
        },
        definitionsLoading: false,
        definitionsBusy: false,
        definitionsError: null,
        runs: null,
        runsLoading: false,
        runsBusy: false,
        runsError: null,
      },
      taskStandingOrders: {
        result: {
          agentId: "beta",
          orders: [],
          summary: { total: 0, enabled: 0, disabled: 0 },
        },
        loading: false,
        busy: false,
        error: null,
        message: null,
        draft: null,
      },
      taskLedger: {
        loading: false,
        busy: false,
        error: null,
        sourceFilter: "all",
        typeFilter: "all",
        statusFilter: "all",
        result: {
          generatedAt: now,
          total: 1,
          summary: {
            total: 1,
            queued: 0,
            running: 1,
            terminal: 0,
            failed: 0,
            lost: 0,
            bySource: { mining: 1 },
            byStatus: { running: 1 },
          },
          audit: { findings: [] },
          tasks: [
            {
              taskId: "mining:stopMining:stale",
              runId: "mining-stop-stale",
              source: "mining",
              runtime: "mining",
              taskKind: "mining_control",
              agentId: "beta",
              task: "Mining: Stop mining",
              status: "running",
              deliveryStatus: "not_applicable",
              notifyPolicy: "state_changes",
              createdAt: now - 1_000,
              updatedAt: now,
              metadata: { method: "sat.stopMining", drainOnly: true },
            },
          ],
        },
      },
    });
    const container = document.createElement("div");
    render(renderAgents(props), container);

    expect(container.textContent).toContain("No tasks.");
    expect(container.querySelector('[data-testid="task-work-filter-all"]')?.textContent).toContain(
      "All (0)",
    );
    expect(
      container.querySelector('[data-testid="task-work-filter-tasks"]')?.textContent,
    ).toContain("Tasks (0)");
    expect(
      container.querySelector('[data-testid="task-work-filter-history"]')?.textContent,
    ).toContain("Run history (1)");
    const primaryChips = Array.from(
      container.querySelectorAll(".agent-task-toolbar__primary .chip"),
    ).map((chip) => chip.textContent?.trim() ?? "");
    expect(primaryChips).not.toContain("1 activity");
    expect(primaryChips).not.toContain("1 active");
    expect(container.querySelector(".agent-task-recent-activity")).toBeNull();
    expect(container.textContent).not.toContain("Recent activity");

    render(
      renderAgents(
        createProps({
          activePanel: "cron",
          selectedAgentId: "beta",
          taskWorkflow: props.taskWorkflow,
          taskStandingOrders: props.taskStandingOrders,
          taskLedger: {
            ...props.taskLedger!,
            typeFilter: "history",
          },
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("Mining: Stop mining");
    expect(
      container.querySelector<HTMLInputElement>('input[aria-label="Search run history"]'),
    ).toBeTruthy();
    expect(
      container.querySelector<HTMLSelectElement>('select[aria-label="History source"]'),
    ).toBeTruthy();
    expect(
      container.querySelector<HTMLSelectElement>('select[aria-label="History status"]'),
    ).toBeTruthy();
  });

  it("counts saved Agent work definitions in tabs, subtabs, and setup summary", () => {
    const props = createProps({
      selectedAgentId: "beta",
      activePanel: "overview",
      cron: {
        status: null,
        loading: false,
        error: null,
        jobs: [
          {
            id: "task-beta",
            agentId: "beta",
            name: "Beta task",
            enabled: true,
            createdAtMs: 1,
            updatedAtMs: 2,
            schedule: { kind: "every", everyMs: 60_000 },
            sessionTarget: "isolated",
            wakeMode: "next-heartbeat",
            payload: { kind: "agentTurn", message: "Run beta task" },
            state: {},
          },
          {
            id: "task-alpha",
            agentId: "alpha",
            name: "Alpha task",
            enabled: true,
            createdAtMs: 1,
            updatedAtMs: 2,
            schedule: { kind: "every", everyMs: 60_000 },
            sessionTarget: "isolated",
            wakeMode: "next-heartbeat",
            payload: { kind: "agentTurn", message: "Run alpha task" },
            state: {},
          },
        ],
      },
      webhookTriggers: {
        result: {
          enabled: true,
          basePath: "/hooks",
          hasToken: true,
          triggers: [
            {
              id: "trigger-beta",
              agentId: "beta",
              name: "Beta trigger",
              enabled: true,
              action: "wake",
              urlPath: "/hooks/beta",
              notifyPolicy: "done_only",
            },
            {
              id: "trigger-alpha",
              agentId: "alpha",
              name: "Alpha trigger",
              enabled: true,
              action: "wake",
              urlPath: "/hooks/alpha",
              notifyPolicy: "done_only",
            },
          ],
        },
        loading: false,
        busy: false,
        error: null,
        message: null,
        draft: null,
      },
      taskWorkflow: {
        draft: null,
        graphDraft: null,
        busy: false,
        error: null,
        message: null,
        definitions: {
          agentId: "beta",
          definitions: [
            {
              id: "workflow-beta",
              agentId: "beta",
              mode: "steps",
              name: "Beta workflow",
              task: "Run beta workflow",
              notifyPolicy: "terminal",
              steps: [],
              createdAt: 1,
              updatedAt: 2,
            },
            {
              id: "graph-beta",
              agentId: "beta",
              mode: "graph",
              name: "Beta graph",
              task: "Run beta graph",
              notifyPolicy: "terminal",
              steps: [],
              graph: { version: 1, nodes: [], edges: [] },
              createdAt: 1,
              updatedAt: 2,
            },
            {
              id: "graph-alpha",
              agentId: "alpha",
              mode: "graph",
              name: "Alpha graph",
              task: "Run alpha graph",
              notifyPolicy: "terminal",
              steps: [],
              graph: { version: 1, nodes: [], edges: [] },
              createdAt: 1,
              updatedAt: 2,
            },
          ],
        },
        definitionsLoading: false,
        definitionsBusy: false,
        definitionsError: null,
        runs: null,
        runsLoading: false,
        runsBusy: false,
        runsError: null,
      },
      taskStandingOrders: {
        result: {
          agentId: "beta",
          orders: [
            {
              id: "program-beta",
              agentId: "beta",
              name: "Beta program",
              instructions: "Propose beta work",
              proposalKind: "task",
              status: "enabled",
              approvalRequired: true,
              createdAt: 1,
              updatedAt: 2,
            },
            {
              id: "program-alpha",
              agentId: "alpha",
              name: "Alpha program",
              instructions: "Propose alpha work",
              proposalKind: "task",
              status: "enabled",
              approvalRequired: true,
              createdAt: 1,
              updatedAt: 2,
            },
          ],
          summary: { total: 2, enabled: 2, disabled: 0 },
        },
        loading: false,
        busy: false,
        error: null,
        message: null,
        draft: null,
      },
      taskLedger: {
        loading: false,
        busy: false,
        error: null,
        sourceFilter: "all",
        typeFilter: "all",
        statusFilter: "all",
        result: {
          generatedAt: Date.now(),
          total: 99,
          summary: {
            total: 99,
            queued: 0,
            running: 0,
            terminal: 99,
            failed: 0,
            lost: 0,
            bySource: { mining: 99 },
            byStatus: { succeeded: 99 },
          },
          audit: { findings: [] },
          tasks: [],
        },
      },
    });
    const container = document.createElement("div");
    render(renderAgents(props), container);

    const tabLabels = Array.from(container.querySelectorAll(".agent-tab")).map((tab) =>
      tab.textContent?.replace(/\s+/g, " ").trim(),
    );
    expect(tabLabels).toContain("Tasks(5)");
    const setupTaskCard = container.querySelector<HTMLElement>('section[aria-label="Tasks"]');
    expect(setupTaskCard?.textContent?.replace(/\s+/g, " ").trim()).toContain(
      "1 task · 1 trigger · 1 workflow · 1 graph · 1 program",
    );
    expect(setupTaskCard?.textContent).not.toContain("activity");

    render(renderAgents({ ...props, activePanel: "cron" }), container);
    const subtabLabels = Array.from(container.querySelectorAll(".agent-task-subtab")).map((tab) =>
      tab.textContent?.replace(/\s+/g, " ").trim(),
    );
    expect(subtabLabels).toContain("Tasks(5)");
    expect(container.querySelector('[data-testid="task-work-filter-all"]')?.textContent).toContain(
      "All (5)",
    );
  });

  it("edits Agent programs as proposal-only definitions", () => {
    const onProgramCreate = vi.fn();
    const onProgramEdit = vi.fn();
    const onProgramPatch = vi.fn();
    const onProgramSave = vi.fn();
    const onProgramRemove = vi.fn();
    const onProgramPropose = vi.fn();
    const program = {
      id: "program-beta",
      agentId: "beta",
      name: "Beta program",
      instructions: "Propose beta work",
      triggerHint: "when orders change",
      proposalKind: "workflow" as const,
      status: "enabled" as const,
      approvalRequired: true as const,
      createdAt: 1,
      updatedAt: 2,
    };
    const baseProps = createProps({
      activePanel: "cron",
      selectedAgentId: "beta",
      taskStandingOrders: {
        result: {
          agentId: "beta",
          orders: [program],
          summary: { total: 1, enabled: 1, disabled: 0 },
        },
        loading: false,
        busy: false,
        error: null,
        message: null,
        draft: null,
      },
      onTaskStandingOrderCreate: onProgramCreate,
      onTaskStandingOrderEdit: onProgramEdit,
      onTaskStandingOrderPatch: onProgramPatch,
      onTaskStandingOrderSave: onProgramSave,
      onTaskStandingOrderRemove: onProgramRemove,
      onTaskStandingOrderPropose: onProgramPropose,
      onTaskStandingOrderCancel: vi.fn(),
    });
    const container = document.createElement("div");
    render(renderAgents(baseProps), container);

    Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Program"))
      ?.click();
    expect(onProgramCreate).toHaveBeenCalledWith("beta");
    container.querySelector<HTMLButtonElement>('button[aria-label="Propose work"]')?.click();
    expect(onProgramPropose).toHaveBeenCalledWith(program);
    container.querySelector<HTMLButtonElement>('button[aria-label="Edit program"]')?.click();
    expect(onProgramEdit).toHaveBeenCalledWith(program);
    container.querySelector<HTMLButtonElement>('button[aria-label="Delete program"]')?.click();
    expect(onProgramRemove).toHaveBeenCalledWith(program);

    render(
      renderAgents({
        ...baseProps,
        taskStandingOrders: {
          ...baseProps.taskStandingOrders!,
          draft: {
            name: "New program",
            instructions: "Propose a review.",
            triggerHint: "weekdays 08:00",
            proposalKind: "workflow",
            status: "enabled",
          },
        },
      }),
      container,
    );

    const modalText = container.textContent?.replace(/\s+/g, " ").trim() ?? "";
    expect(modalText).toContain("saved Program definition");
    expect(modalText).toContain("not a schedule");
    expect(modalText).toContain("does not run automatically");

    const modal = container.querySelector<HTMLElement>(".agent-task-modal-panel");
    expect(modal).toBeInstanceOf(HTMLElement);

    const nameInput = Array.from(modal!.querySelectorAll<HTMLInputElement>("input")).find(
      (input) => input.value === "New program",
    );
    expect(nameInput).toBeInstanceOf(HTMLInputElement);
    nameInput!.value = "Changed program";
    nameInput!.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onProgramPatch).toHaveBeenCalledWith({ name: "Changed program" });

    const statusSelect = Array.from(modal!.querySelectorAll<HTMLSelectElement>("select")).find(
      (select) => Array.from(select.options).some((option) => option.value === "disabled"),
    );
    expect(statusSelect).toBeInstanceOf(HTMLSelectElement);
    statusSelect!.value = "disabled";
    statusSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onProgramPatch).toHaveBeenCalledWith({ status: "disabled" });

    const proposalSelect = Array.from(modal!.querySelectorAll<HTMLSelectElement>("select")).find(
      (select) => Array.from(select.options).some((option) => option.value === "task"),
    );
    expect(proposalSelect).toBeInstanceOf(HTMLSelectElement);
    proposalSelect!.value = "task";
    proposalSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onProgramPatch).toHaveBeenCalledWith({ proposalKind: "task" });

    const triggerInput = Array.from(modal!.querySelectorAll<HTMLInputElement>("input")).find(
      (input) => input.value === "weekdays 08:00",
    );
    expect(triggerInput).toBeInstanceOf(HTMLInputElement);
    triggerInput!.value = "when provider health changes";
    triggerInput!.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onProgramPatch).toHaveBeenCalledWith({
      triggerHint: "when provider health changes",
    });

    const instructions = modal!.querySelector<HTMLTextAreaElement>("textarea");
    expect(instructions).toBeInstanceOf(HTMLTextAreaElement);
    instructions!.value = "Propose a health check.";
    instructions!.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onProgramPatch).toHaveBeenCalledWith({ instructions: "Propose a health check." });

    Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Save program"))
      ?.click();
    expect(onProgramSave).toHaveBeenCalledWith("beta");
  });

  it.skip("treats programs as one work filter and activity type without an empty duplicate panel", () => {
    const now = Date.now();
    const props = createProps({
      activePanel: "cron",
      selectedAgentId: "beta",
      taskStandingOrders: {
        result: {
          agentId: "beta",
          orders: [],
          summary: { total: 0, enabled: 0, disabled: 0 },
        },
        loading: false,
        busy: false,
        error: null,
        message: null,
        draft: null,
      },
      taskLedger: {
        loading: false,
        busy: false,
        error: null,
        sourceFilter: "all",
        typeFilter: "program",
        statusFilter: "all",
        result: {
          generatedAt: now,
          total: 1,
          summary: {
            total: 1,
            queued: 0,
            running: 0,
            terminal: 1,
            failed: 0,
            lost: 0,
            bySource: { CLI: 1 },
            byStatus: { blocked: 1 },
          },
          audit: { findings: [] },
          tasks: [
            {
              taskId: "standing:daily-review",
              runId: "standing-run-daily-review",
              source: "CLI",
              runtime: "cli",
              taskKind: "standing-order-proposal",
              sourceId: "daily-review",
              definitionId: "daily-review",
              definitionKind: "workflow",
              agentId: "beta",
              task: "Program proposal: Daily review",
              status: "blocked",
              deliveryStatus: "not_applicable",
              notifyPolicy: "state_changes",
              createdAt: now - 1_000,
              updatedAt: now,
              metadata: {
                standingOrderId: "daily-review",
                standingOrderName: "Daily review",
                proposalKind: "workflow",
              },
            },
          ],
        },
      },
    });
    const container = document.createElement("div");
    render(renderAgents(props), container);

    expect(container.textContent).toContain("Program proposal: Daily review");
    expect(container.textContent).not.toContain("No Programs for this Agent yet");
    expect(container.textContent).not.toContain("No Programs match this view");
    expect(container.textContent).not.toContain("No definitions match this view");
    expect(
      container.querySelector<HTMLSelectElement>('select[aria-label="Work type"]')?.value,
    ).toBe("program");
    expect(
      container.querySelector('[data-testid="task-work-filter-programs"]')?.textContent,
    ).toContain("Programs");
  });

  it.skip("only exposes source retry controls for retryable workflow and scheduled task records", () => {
    const onControl = vi.fn();
    const now = Date.now();
    const props = createProps({
      activePanel: "cron",
      selectedAgentId: "beta",
      onTaskLedgerControl: onControl,
      taskLedger: {
        loading: false,
        busy: false,
        error: null,
        sourceFilter: "all",
        result: {
          generatedAt: now,
          total: 8,
          summary: {
            total: 8,
            queued: 0,
            running: 0,
            terminal: 8,
            failed: 8,
            lost: 0,
            bySource: { webhook: 2, channel: 2, media: 2, cron: 2 },
            byStatus: { failed: 8 },
          },
          audit: { findings: [] },
          tasks: [
            {
              taskId: "webhook:plain-failed",
              runId: "webhook-plain-failed",
              source: "webhook",
              runtime: "webhook",
              taskKind: "webhook-trigger",
              agentId: "beta",
              task: "Webhook plain failed",
              status: "failed",
              deliveryStatus: "not_delivered",
              notifyPolicy: "state_changes",
              createdAt: now - 7_000,
              updatedAt: now - 6_000,
              metadata: { triggerId: "plain-hook" },
            },
            {
              taskId: "webhook:workflow-failed",
              runId: "webhook-workflow-failed",
              source: "webhook",
              runtime: "webhook",
              taskKind: "workflow",
              agentId: "beta",
              task: "Webhook workflow failed",
              status: "failed",
              deliveryStatus: "not_delivered",
              notifyPolicy: "state_changes",
              createdAt: now - 6_000,
              updatedAt: now - 5_000,
              steps: [{ id: "deliver", label: "Deliver", status: "failed" }],
              metadata: { triggerId: "workflow-hook", workflow: true },
            },
            {
              taskId: "channel:plain-failed",
              runId: "channel-plain-failed",
              source: "channel",
              runtime: "channel",
              taskKind: "channel-triggered-agent",
              agentId: "beta",
              channel: "telegram",
              task: "Channel plain failed",
              status: "failed",
              deliveryStatus: "not_delivered",
              notifyPolicy: "state_changes",
              createdAt: now - 5_000,
              updatedAt: now - 4_000,
              metadata: { messageId: "plain-message" },
            },
            {
              taskId: "channel:workflow-failed",
              runId: "channel-workflow-failed",
              source: "channel",
              runtime: "channel",
              taskKind: "workflow",
              agentId: "beta",
              channel: "telegram",
              task: "Channel workflow failed",
              status: "failed",
              deliveryStatus: "not_delivered",
              notifyPolicy: "state_changes",
              createdAt: now - 4_000,
              updatedAt: now - 3_000,
              steps: [{ id: "notify", label: "Notify", status: "failed" }],
              metadata: { messageId: "workflow-message", workflow: true },
            },
            {
              taskId: "media:plain-failed",
              runId: "media-plain-failed",
              source: "media",
              runtime: "media",
              taskKind: "image_generation",
              agentId: "beta",
              sessionKey: "agent:beta:webchat:media-plain",
              task: "Media plain failed",
              status: "failed",
              deliveryStatus: "not_applicable",
              notifyPolicy: "state_changes",
              createdAt: now - 3_000,
              updatedAt: now - 2_000,
              metadata: { artifactKind: "image" },
            },
            {
              taskId: "media:workflow-failed",
              runId: "media-workflow-failed",
              source: "media",
              runtime: "media",
              taskKind: "workflow",
              agentId: "beta",
              sessionKey: "agent:beta:webchat:media-workflow",
              task: "Media workflow failed",
              status: "failed",
              deliveryStatus: "not_applicable",
              notifyPolicy: "state_changes",
              createdAt: now - 2_000,
              updatedAt: now - 1_000,
              steps: [{ id: "review", label: "Review", status: "failed" }],
              metadata: { artifactKind: "image", workflow: true },
            },
            {
              taskId: "cron:failed-live",
              runId: "cron-failed-live",
              source: "cron",
              runtime: "cron",
              taskKind: "scheduled-task",
              agentId: "beta",
              definitionId: "job-live",
              sourceId: "job-live",
              task: "Scheduled task failed",
              status: "failed",
              deliveryStatus: "not_delivered",
              notifyPolicy: "done_only",
              createdAt: now - 1_000,
              updatedAt: now,
            },
            {
              taskId: "cron:failed-stale",
              runId: "cron-failed-stale",
              source: "cron",
              runtime: "cron",
              taskKind: "scheduled-task",
              agentId: "beta",
              definitionId: "job-deleted",
              sourceId: "job-deleted",
              task: "Deleted scheduled task failed",
              status: "failed",
              deliveryStatus: "not_delivered",
              notifyPolicy: "done_only",
              createdAt: now - 500,
              updatedAt: now,
            },
          ],
        },
      },
      cron: {
        status: null,
        loading: false,
        error: null,
        jobs: [
          {
            id: "job-live",
            agentId: "beta",
            name: "Live scheduled task",
            enabled: true,
            schedule: { kind: "once", atMs: now + 60_000 },
            createdAtMs: now - 10_000,
            updatedAtMs: now - 10_000,
            payload: { type: "chat", prompt: "run" },
          },
        ],
      },
    });
    const container = document.createElement("div");
    render(renderAgents(props), container);

    expect(
      Array.from(container.querySelectorAll<HTMLButtonElement>("button")).filter(
        (button) => button.getAttribute("aria-label") === "Replay webhook workflow",
      ),
    ).toHaveLength(1);
    expect(
      Array.from(container.querySelectorAll<HTMLButtonElement>("button")).filter(
        (button) => button.getAttribute("aria-label") === "Retry channel workflow",
      ),
    ).toHaveLength(1);
    expect(
      Array.from(container.querySelectorAll<HTMLButtonElement>("button")).filter(
        (button) => button.getAttribute("aria-label") === "Retry media workflow",
      ),
    ).toHaveLength(1);
    expect(
      Array.from(container.querySelectorAll<HTMLButtonElement>("button")).filter(
        (button) => button.getAttribute("aria-label") === "Retry scheduled task",
      ),
    ).toHaveLength(1);
    expect(container.textContent).toContain(
      "This scheduled-task definition no longer exists. This row is historical activity only.",
    );
    expect(container.querySelector('button[aria-label="Retry task"]')).toBeNull();

    container
      .querySelector<HTMLButtonElement>('button[aria-label="Replay webhook workflow"]')
      ?.click();
    expect(onControl).toHaveBeenCalledWith("retry", "webhook:workflow-failed");
    container
      .querySelector<HTMLButtonElement>('button[aria-label="Retry channel workflow"]')
      ?.click();
    expect(onControl).toHaveBeenCalledWith("retry", "channel:workflow-failed");
    container
      .querySelector<HTMLButtonElement>('button[aria-label="Retry media workflow"]')
      ?.click();
    expect(onControl).toHaveBeenCalledWith("retry", "media:workflow-failed");
    container
      .querySelector<HTMLButtonElement>('button[aria-label="Retry scheduled task"]')
      ?.click();
    expect(onControl).toHaveBeenCalledWith("retry", "cron:failed-live");
  });

  it.skip("renders composite task ledger source details in Agent Tasks", () => {
    const onOpenSource = vi.fn();
    const onWorkflowReview = vi.fn();
    const now = Date.now();
    const props = createProps({
      activePanel: "cron",
      selectedAgentId: "beta",
      onTaskLedgerOpenSource: onOpenSource,
      onTaskLedgerWorkflowReview: onWorkflowReview,
      taskLedger: {
        loading: false,
        busy: false,
        error: null,
        sourceFilter: "all",
        result: {
          generatedAt: now,
          total: 9,
          summary: {
            total: 9,
            queued: 0,
            running: 1,
            terminal: 8,
            failed: 0,
            lost: 0,
            bySource: {
              webhook: 1,
              subagent: 1,
              cron: 1,
              CLI: 1,
              channel: 1,
              media: 1,
              wallet: 1,
              marketplace: 1,
              mining: 1,
            },
            byStatus: { succeeded: 8, running: 1 },
          },
          audit: { findings: [] },
          tasks: [
            {
              taskId: "webhook:smoke",
              runId: "webhook-smoke",
              source: "webhook",
              runtime: "webhook",
              taskKind: "webhook-trigger",
              sourceId: "orders",
              rootTaskId: "webhook:smoke",
              correlationId: "webhook:smoke",
              definitionId: "orders",
              definitionKind: "trigger",
              agentId: "beta",
              sessionKey: "agent:beta:webhook:orders",
              task: "Webhook trigger smoke",
              status: "succeeded",
              deliveryStatus: "delivered",
              notifyPolicy: "state_changes",
              createdAt: now - 7_000,
              updatedAt: now - 6_000,
              metadata: { triggerId: "orders", path: "/hooks/orders" },
            },
            {
              taskId: "subagent:smoke",
              runId: "acp-smoke",
              source: "subagent",
              runtime: "acp",
              taskKind: "acp-spawn",
              agentId: "beta",
              rootTaskId: "webhook:smoke",
              parentTaskId: "webhook:smoke",
              correlationId: "webhook:smoke",
              requesterSessionKey: "agent:beta:webchat:direct",
              sessionKey: "agent:beta:subagent:research",
              task: "ACP subagent smoke",
              status: "succeeded",
              deliveryStatus: "delivered",
              notifyPolicy: "done_only",
              createdAt: now - 6_500,
              updatedAt: now - 5_500,
              delivery: { channel: "webchat", target: "parent", messageId: "acp-result" },
              loadedSkills: ["diagram-maker"],
              loadedTools: ["web.search"],
              memoryScope: "agent",
              metadata: { childSessionKey: "agent:beta:subagent:research", mode: "run" },
            },
            {
              taskId: "cron:smoke",
              runId: "cron-smoke",
              source: "cron",
              runtime: "cron",
              taskKind: "scheduled-task",
              definitionId: "scheduled-smoke",
              sourceId: "scheduled-smoke",
              agentId: "beta",
              sessionKey: "agent:beta:webchat:direct",
              task: "Scheduled Agent task smoke",
              status: "succeeded",
              deliveryStatus: "delivered",
              notifyPolicy: "done_only",
              createdAt: now - 6_000,
              updatedAt: now - 5_000,
              loadedSkills: ["fased-test"],
              loadedTools: ["web.search"],
              memoryScope: "agent",
            },
            {
              taskId: "CLI:smoke",
              runId: "cli-smoke",
              source: "CLI",
              runtime: "cli",
              taskKind: "cli-command",
              agentId: "beta",
              task: "CLI/system task smoke",
              status: "succeeded",
              deliveryStatus: "not_applicable",
              notifyPolicy: "silent",
              createdAt: now - 5_500,
              updatedAt: now - 4_500,
              metadata: { command: "fased doctor", scope: "system" },
            },
            {
              taskId: "channel:smoke",
              runId: "channel-smoke",
              source: "channel",
              runtime: "channel",
              taskKind: "channel-triggered-agent",
              agentId: "beta",
              sessionKey: "agent:beta:telegram:default",
              channel: "telegram",
              task: "Channel delivery smoke",
              status: "succeeded",
              deliveryStatus: "delivered",
              notifyPolicy: "state_changes",
              createdAt: now - 5_000,
              updatedAt: now - 4_000,
              delivery: { channel: "telegram", target: "ops", messageId: "tg-channel" },
              metadata: {
                dispatchRoute: "origin",
                replyCounts: { final: 1, tool: 0 },
                messageId: "tg-in",
                threadId: "thread-1",
                accountId: "default",
              },
            },
            {
              taskId: "media:smoke",
              runId: "media-smoke",
              source: "media",
              runtime: "media",
              taskKind: "image_generation",
              agentId: "beta",
              sessionKey: "agent:beta:webchat:direct",
              task: "Media task smoke",
              status: "succeeded",
              deliveryStatus: "not_applicable",
              notifyPolicy: "silent",
              createdAt: now - 4_000,
              updatedAt: now - 3_000,
              provider: "local",
              model: "media-service",
              metadata: {
                artifactKind: "image",
                mediaCount: 1,
                mediaIds: ["media-1"],
                mediaPaths: ["/tmp/fased/generated/smoke.png"],
                mediaContentTypes: ["image/png"],
                mediaSizes: [1024],
              },
            },
            {
              taskId: "wallet:approval:smoke",
              runId: "wallet-approval-smoke",
              source: "wallet",
              runtime: "wallet",
              taskKind: "wallet_approval",
              agentId: "beta",
              task: "Wallet approval: 0.01 SOL",
              status: "succeeded",
              deliveryStatus: "not_applicable",
              notifyPolicy: "state_changes",
              createdAt: now - 3_000,
              updatedAt: now - 2_000,
              metadata: {
                approvalId: "wallet-smoke",
                approvalStatus: "executed",
                actionKind: "send",
                chain: "solana",
                providerId: "local-socket-signer",
                walletId: "agent-1",
                walletName: "Agent wallet",
                amountDisplay: "0.01 SOL",
                token: "SOL",
                to: "dest111",
                requestedBy: "beta",
                approvedBy: "operator",
                simulationDecision: "allow",
                simulationOk: true,
                simulationChecks: [{ id: "daily-cap", label: "Daily cap", status: "pass" }],
                txHash: "wallet-tx",
              },
            },
            {
              taskId: "marketplace:order:smoke",
              runId: "marketplace-order-smoke",
              source: "marketplace",
              runtime: "marketplace",
              taskKind: "marketplace_order",
              agentId: "beta",
              task: "Marketplace order: Smoke order",
              status: "succeeded",
              deliveryStatus: "delivered",
              notifyPolicy: "state_changes",
              createdAt: now - 2_000,
              updatedAt: now - 1_000,
              metadata: {
                orderId: "order-smoke",
                offerId: "offer-smoke",
                source: "local",
                orderStatus: "delivered",
                serviceKind: "content.summarize",
                buyerHandle: "@buyer",
                sellerHandle: "@seller",
                paymentStatus: "verified",
                settlementMode: "direct",
                settlementStatus: "settled",
                deliveryStatus: "delivered",
                deliveryTargetKind: "channel",
                receiptId: "receipt-smoke",
                txRef: "market-tx",
                resultRef: "artifact://order-smoke",
                currency: "SOL",
                amount: "0.01",
              },
            },
            {
              taskId: "mining:start:smoke",
              runId: "mining-start-smoke",
              source: "mining",
              runtime: "mining",
              taskKind: "mining_control",
              agentId: "beta",
              task: "Mining: Start mining",
              status: "running",
              deliveryStatus: "not_applicable",
              notifyPolicy: "state_changes",
              createdAt: now - 1_000,
              updatedAt: now,
              metadata: {
                action: "startMining",
                method: "sat.startMining",
                walletId: "mining-1",
                running: true,
                started: true,
                currentCycleId: "7",
                currentCapitalLockedLamports: "5000",
                currentCapitalPendingCycleCount: "1",
                strategyMode: "auto",
                readinessChecks: [{ key: "wallet", ok: true, detail: "ready" }],
              },
            },
          ],
        },
      },
      cron: {
        status: null,
        loading: false,
        error: null,
        jobs: [
          {
            id: "scheduled-smoke",
            agentId: "beta",
            name: "Scheduled Agent task smoke",
            enabled: true,
            schedule: { kind: "once", atMs: now + 60_000 },
            createdAtMs: now - 10_000,
            updatedAtMs: now - 10_000,
            payload: { type: "chat", prompt: "smoke" },
          },
        ],
      },
    });
    const container = document.createElement("div");
    render(renderAgents(props), container);

    expect(taskLedgerFilterText(container, "webhook")).toBe("Webhooks 1");
    expect(taskLedgerFilterText(container, "subagent")).toBe("ACP 1");
    expect(taskLedgerFilterText(container, "cron")).toBe("Tasks 1");
    expect(taskLedgerFilterText(container, "CLI")).toBe("CLI 1");
    expect(taskLedgerFilterText(container, "channel")).toBe("Channels 1");
    expect(taskLedgerFilterText(container, "media")).toBe("Media 1");
    expect(taskLedgerFilterText(container, "wallet")).toBe("Wallet 1");
    expect(taskLedgerFilterText(container, "marketplace")).toBe("Marketplace 1");
    expect(taskLedgerFilterText(container, "mining")).toBe("Mining 1");
    expect(container.textContent).toContain("Dispatch route");
    expect(container.textContent).toContain("Webhook trigger -> ACP spawn");
    expect(container.textContent).toContain("2 linked");
    expect(container.textContent).toContain("Child session");
    expect(container.textContent).toContain("agent:beta:subagent:research");
    expect(container.textContent).toContain("CLI task");
    expect(container.textContent).toContain("origin");
    expect(container.textContent).toContain("Reply counts");
    expect(container.textContent).toContain("final 1");
    expect(container.textContent).toContain("Media kind");
    expect(container.textContent).toContain("image");
    expect(container.textContent).toContain("Media ids");
    expect(container.textContent).toContain("media-1");
    expect(container.textContent).toContain("Media sizes");
    expect(container.textContent).toContain("1024");
    expect(container.textContent).toContain("Wallet action");
    expect(container.textContent).toContain("status executed");
    expect(container.textContent).toContain("Policy simulation");
    expect(container.textContent).toContain("decision allow");
    expect(container.textContent).toContain("Marketplace delivery");
    expect(container.textContent).toContain("target channel");
    expect(container.textContent).toContain("Mining action");
    expect(container.textContent).toContain("startMining");
    expect(container.textContent).toContain("Readiness");
    expect(container.textContent).toContain("controls stay in Mining");
    expect(container.querySelectorAll(".agent-task-view-only")).toHaveLength(3);
    expect(container.textContent).toContain("Wallet controls");
    expect(container.textContent).toContain("Marketplace controls");
    expect(container.textContent).toContain("Mining controls");
    expect(container.textContent).toContain("Source actions");
    expect(container.querySelectorAll('button[aria-label="Cancel task"]')).toHaveLength(0);
    for (const label of [
      "Open webhook trigger",
      "Open ACP session",
      "Open scheduled task",
      "Open CLI task",
      "Open channel message",
      "Open media session",
      "Open wallet approval",
      "Open marketplace order",
      "Open mining cycle",
    ]) {
      expect(container.querySelector(`button[aria-label="${label}"]`)).toBeTruthy();
    }
    for (const label of [
      "Review approval workflow",
      "Review delivery workflow",
      "Review channel delivery workflow",
      "Review media artifacts workflow",
    ]) {
      expect(container.querySelector(`button[aria-label="${label}"]`)).toBeNull();
    }
    container
      .querySelector<HTMLButtonElement>('button[aria-label="Open channel message"]')
      ?.click();
    expect(onOpenSource).toHaveBeenCalledWith(
      expect.objectContaining({ source: "channel", taskId: "channel:smoke" }),
    );
    container.querySelector<HTMLButtonElement>('button[aria-label="Open media session"]')?.click();
    expect(onOpenSource).toHaveBeenCalledWith(
      expect.objectContaining({ source: "media", taskId: "media:smoke" }),
    );
    expect(onWorkflowReview).not.toHaveBeenCalled();
  });

  it.skip("opens source-specific task ledger targets from real source buttons", () => {
    window.history.replaceState({}, "", "/agents");
    const state = createTaskSourceRoutingState();
    const now = Date.now();
    const props = createProps({
      activePanel: "cron",
      selectedAgentId: "beta",
      onTaskLedgerOpenSource: (task: TaskRecord) => openTaskLedgerSourceSurface(state, task),
      taskLedger: {
        loading: false,
        busy: false,
        error: null,
        sourceFilter: "all",
        result: {
          generatedAt: now,
          total: 7,
          summary: {
            total: 7,
            queued: 0,
            running: 0,
            terminal: 7,
            failed: 0,
            lost: 0,
            bySource: {
              CLI: 1,
              wallet: 1,
              marketplace: 1,
              mining: 1,
              channel: 1,
              media: 1,
              webhook: 1,
            },
            byStatus: { succeeded: 7 },
          },
          audit: { findings: [] },
          tasks: [
            {
              taskId: "workflow-route",
              runId: "workflow-route",
              source: "CLI",
              runtime: "cli",
              taskKind: "workflow",
              agentId: "beta",
              task: "Workflow route",
              status: "succeeded",
              deliveryStatus: "not_applicable",
              notifyPolicy: "state_changes",
              createdAt: now - 7_000,
              updatedAt: now - 6_000,
              metadata: {
                sourceTask: {
                  taskId: "wallet-source-route",
                  runId: "wallet-source-route",
                  source: "wallet",
                  runtime: "wallet",
                  taskKind: "wallet_approval",
                  task: "Wallet source route",
                  metadata: { approvalId: "approval-source-route" },
                },
              },
            },
            {
              taskId: "wallet-route",
              runId: "wallet-route",
              source: "wallet",
              runtime: "wallet",
              taskKind: "wallet_approval",
              agentId: "beta",
              task: "Wallet route",
              status: "succeeded",
              deliveryStatus: "not_applicable",
              notifyPolicy: "state_changes",
              createdAt: now - 6_000,
              updatedAt: now - 5_000,
              metadata: { approvalId: "approval-route" },
            },
            {
              taskId: "marketplace-route",
              runId: "marketplace-route",
              source: "marketplace",
              runtime: "marketplace",
              taskKind: "marketplace_order",
              agentId: "beta",
              task: "Marketplace route",
              status: "succeeded",
              deliveryStatus: "delivered",
              notifyPolicy: "state_changes",
              createdAt: now - 5_000,
              updatedAt: now - 4_000,
              metadata: { orderId: "order-route" },
            },
            {
              taskId: "mining-route",
              runId: "mining-route",
              source: "mining",
              runtime: "mining",
              taskKind: "mining_control",
              agentId: "beta",
              task: "Mining route",
              status: "succeeded",
              deliveryStatus: "not_applicable",
              notifyPolicy: "state_changes",
              createdAt: now - 4_000,
              updatedAt: now - 3_000,
              metadata: { currentCycleId: "cycle-route", action: "commit" },
            },
            {
              taskId: "channel-route",
              runId: "channel-route",
              source: "channel",
              runtime: "channel",
              taskKind: "channel-triggered-agent",
              agentId: "beta",
              task: "Channel route",
              status: "succeeded",
              deliveryStatus: "delivered",
              notifyPolicy: "state_changes",
              createdAt: now - 3_000,
              updatedAt: now - 2_000,
              metadata: { messageId: "tg-route" },
            },
            {
              taskId: "media-route",
              runId: "media-route",
              source: "media",
              runtime: "media",
              taskKind: "image_generation",
              agentId: "beta",
              task: "Media route",
              status: "succeeded",
              deliveryStatus: "not_applicable",
              notifyPolicy: "silent",
              createdAt: now - 2_000,
              updatedAt: now - 1_000,
              metadata: { artifactId: "image-route" },
            },
            {
              taskId: "webhook-route",
              runId: "webhook-route",
              source: "webhook",
              runtime: "webhook",
              taskKind: "webhook-trigger",
              sourceId: "hook-route",
              agentId: "beta",
              task: "Webhook route",
              status: "succeeded",
              deliveryStatus: "delivered",
              notifyPolicy: "state_changes",
              createdAt: now - 1_000,
              updatedAt: now,
              metadata: { triggerId: "hook-route" },
            },
          ],
        },
      },
    });
    const container = document.createElement("div");
    render(renderAgents(props), container);

    expect(container.textContent).toContain("Source task");
    expect(container.textContent).toContain("Wallet source route");
    expect(container.textContent).toContain("Source actions");
    expect(container.textContent).toContain("Open source task");
    container.querySelector<HTMLButtonElement>('button[aria-label="Open source task"]')?.click();
    expect(state.tab).toBe("wallet");
    expect(state.walletMainPanel).toBe("wallets");
    expect(window.location.hash).toBe("#wallet-approval-approval-source-route");

    container
      .querySelector<HTMLButtonElement>('button[aria-label="Open wallet approval"]')
      ?.click();
    expect(state.tab).toBe("wallet");
    expect(state.walletMainPanel).toBe("wallets");
    expect(state.walletApprovalsFilter).toBe("all");
    expect(window.location.hash).toBe("#wallet-approval-approval-route");

    container
      .querySelector<HTMLButtonElement>('button[aria-label="Open marketplace order"]')
      ?.click();
    expect(state.tab).toBe("marketplace");
    expect(window.location.hash).toBe("#marketplace-order-order-route");

    container.querySelector<HTMLButtonElement>('button[aria-label="Open mining cycle"]')?.click();
    expect(state.tab).toBe("mining");
    expect(state.miningActivityFilter).toBe("cycle");
    expect(state.miningActivityWindow).toBe("all");
    expect(window.location.hash).toBe("#mining-cycle-cycle-route");

    container
      .querySelector<HTMLButtonElement>('button[aria-label="Open channel message"]')
      ?.click();
    expect(state.tab).toBe("agents");
    expect(state.agentsPanel).toBe("channels");
    expect(state.channelsView).toBe("messages");
    expect(window.location.hash).toBe("#channel-message-tg-route");

    container.querySelector<HTMLButtonElement>('button[aria-label="Open media task"]')?.click();
    expect(state.tab).toBe("agents");
    expect(state.agentsPanel).toBe("cron");
    expect(state.taskLedgerSourceFilter).toBe("media");
    expect(window.location.hash).toBe("#task-ledger-media-route");

    container
      .querySelector<HTMLButtonElement>('button[aria-label="Open webhook trigger"]')
      ?.click();
    expect(state.tab).toBe("agents");
    expect(state.agentsPanel).toBe("cron");
    expect(state.taskLedgerSourceFilter).toBe("webhook");
    expect(window.location.hash).toBe("#webhook-trigger-hook-route");
    expect(state.loadCron).toHaveBeenCalled();
  });

  it.skip("requests and renders full task details when a task row expands", () => {
    const onDetailOpen = vi.fn();
    const now = Date.now();
    const props = createProps({
      activePanel: "cron",
      selectedAgentId: "beta",
      onTaskLedgerDetailOpen: onDetailOpen,
      taskLedger: {
        loading: false,
        busy: false,
        error: null,
        sourceFilter: "all",
        details: {
          "media:summary": {
            taskId: "media:summary",
            runId: "media-summary",
            source: "media",
            runtime: "media",
            taskKind: "image_generation",
            agentId: "beta",
            sessionKey: "agent:beta:webchat:direct",
            task: "Detailed media task",
            status: "succeeded",
            deliveryStatus: "not_applicable",
            notifyPolicy: "silent",
            createdAt: now - 2_000,
            updatedAt: now,
            provider: "openai",
            model: "gpt-image-1",
            usage: { totalTokens: 33, inputTokens: 11, outputTokens: 22 },
            metadata: {
              artifactKind: "image",
              mediaIds: ["detail-image"],
              mediaPaths: ["/tmp/fased/generated/detail.png"],
              mediaContentTypes: ["image/png"],
              mediaSizes: [2048],
            },
          },
        },
        detailLoading: { "media:summary": true },
        detailErrors: {},
        result: {
          generatedAt: now,
          total: 1,
          summary: {
            total: 1,
            queued: 0,
            running: 0,
            terminal: 1,
            failed: 0,
            lost: 0,
            bySource: { media: 1 },
            byStatus: { succeeded: 1 },
          },
          audit: { findings: [] },
          tasks: [
            {
              taskId: "media:summary",
              runId: "media-summary",
              source: "media",
              runtime: "media",
              taskKind: "image_generation",
              agentId: "beta",
              task: "Summary media task",
              status: "succeeded",
              deliveryStatus: "not_applicable",
              notifyPolicy: "silent",
              createdAt: now - 2_000,
              updatedAt: now - 1_000,
            },
          ],
        },
      },
    });
    const container = document.createElement("div");
    render(renderAgents(props), container);

    const row = container.querySelector<HTMLDetailsElement>(".agent-task-row");
    expect(row).not.toBeNull();
    row!.open = true;
    row!.dispatchEvent(new Event("toggle"));

    expect(onDetailOpen).toHaveBeenCalledWith("media:summary");
    expect(container.textContent).toContain("Detailed media task");
    expect(container.textContent).toContain("detail-image");
    expect(container.textContent).toContain("/tmp/fased/generated/detail.png");
    expect(container.textContent).toContain("33 total");
    expect(container.textContent).toContain("Loading full task detail");
  });

  it.skip("shows approve and continue for blocked workflow approval gates", () => {
    const onControl = vi.fn();
    const now = Date.now();
    const props = createProps({
      activePanel: "cron",
      selectedAgentId: "beta",
      onTaskLedgerControl: onControl,
      taskLedger: {
        loading: false,
        busy: false,
        error: null,
        result: {
          generatedAt: now,
          total: 1,
          summary: {
            total: 1,
            queued: 0,
            running: 0,
            terminal: 1,
            failed: 0,
            lost: 0,
            bySource: { CLI: 1 },
            byStatus: { blocked: 1 },
          },
          audit: { findings: [] },
          tasks: [
            {
              taskId: "CLI:workflow-blocked",
              runId: "workflow-blocked",
              source: "CLI",
              runtime: "cli",
              taskKind: "workflow",
              agentId: "beta",
              task: "Blocked workflow",
              status: "blocked",
              deliveryStatus: "not_applicable",
              notifyPolicy: "done_only",
              createdAt: now - 2_000,
              updatedAt: now - 1_000,
              steps: [
                { id: "prepare", label: "Prepare", status: "succeeded" },
                {
                  id: "approval",
                  label: "Approve publish",
                  status: "blocked",
                  error: "Approval required.",
                },
                { id: "publish", label: "Publish", status: "queued" },
              ],
              metadata: {
                workflow: true,
                blockedStepId: "approval",
                steps: [
                  { id: "prepare", label: "Prepare", type: "note" },
                  { id: "approval", label: "Approve publish", type: "approval" },
                  { id: "publish", label: "Publish", type: "handoff" },
                ],
              },
            },
          ],
        },
      },
    });
    const container = document.createElement("div");
    render(renderAgents(props), container);

    expect(container.textContent).toContain("Workflow run");
    expect(container.textContent).toContain("Waiting for approval");
    expect(container.textContent).toContain("Prepare");
    expect(container.textContent).toContain("Approve publish");
    expect(container.textContent).toContain("Publish");
    expect(container.textContent).toContain("Approval required.");

    const approve = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Approve/resume workflow"]',
    );
    expect(approve).toBeInstanceOf(HTMLButtonElement);
    approve?.click();
    expect(onControl).toHaveBeenCalledWith("approve", "CLI:workflow-blocked");
  });

  it.skip("shows approve and reject for blocked graph workflow approval gates", () => {
    const onControl = vi.fn();
    const now = Date.now();
    const props = createProps({
      activePanel: "cron",
      selectedAgentId: "beta",
      onTaskLedgerControl: onControl,
      taskLedger: {
        loading: false,
        busy: false,
        error: null,
        result: {
          generatedAt: now,
          total: 1,
          summary: {
            total: 1,
            queued: 0,
            running: 0,
            terminal: 1,
            failed: 0,
            lost: 0,
            bySource: { CLI: 1 },
            byStatus: { blocked: 1 },
          },
          audit: { findings: [] },
          tasks: [
            {
              taskId: "CLI:graph-blocked",
              runId: "graph-blocked",
              source: "CLI",
              runtime: "cli",
              taskKind: "workflow",
              agentId: "beta",
              task: "Blocked graph workflow",
              status: "blocked",
              deliveryStatus: "not_applicable",
              notifyPolicy: "done_only",
              createdAt: now - 2_000,
              updatedAt: now - 1_000,
              steps: [
                { id: "start", label: "Start", status: "succeeded" },
                {
                  id: "approval",
                  label: "Approve handoff",
                  status: "blocked",
                  error: "Approval required.",
                },
              ],
              metadata: {
                workflow: true,
                workflowMode: "graph",
                workflowGraphVersion: 2,
                blockedNodeId: "approval",
                graph: {
                  version: 2,
                  startNodeId: "start",
                  nodes: [
                    { id: "start", type: "start", label: "Start" },
                    { id: "approval", type: "approval", label: "Approve handoff" },
                    { id: "done", type: "end", label: "Done" },
                  ],
                  edges: [
                    { id: "start-success-approval", from: "start", to: "approval", on: "success" },
                    {
                      id: "approval-approved-done",
                      from: "approval",
                      to: "done",
                      on: "approved",
                    },
                  ],
                },
              },
            },
          ],
        },
      },
    });
    const container = document.createElement("div");
    render(renderAgents(props), container);

    container
      .querySelector<HTMLButtonElement>('button[aria-label="Approve/resume workflow"]')
      ?.click();
    expect(onControl).toHaveBeenCalledWith("approve", "CLI:graph-blocked");
    container.querySelector<HTMLButtonElement>('button[aria-label="Reject workflow"]')?.click();
    expect(onControl).toHaveBeenCalledWith("reject", "CLI:graph-blocked");
  });

  it.skip("renders workflow timelines without controls for source-owned mirror records", () => {
    const onControl = vi.fn();
    const now = Date.now();
    const props = createProps({
      activePanel: "cron",
      selectedAgentId: "beta",
      onTaskLedgerControl: onControl,
      taskLedger: {
        loading: false,
        busy: false,
        error: null,
        result: {
          generatedAt: now,
          total: 3,
          summary: {
            total: 3,
            queued: 0,
            running: 0,
            terminal: 3,
            failed: 1,
            lost: 0,
            bySource: { CLI: 2, wallet: 1 },
            byStatus: { succeeded: 1, failed: 1, blocked: 1 },
          },
          audit: { findings: [] },
          tasks: [
            {
              taskId: "CLI:workflow-done",
              runId: "workflow-done",
              source: "CLI",
              runtime: "cli",
              taskKind: "workflow",
              agentId: "beta",
              task: "Successful workflow",
              status: "succeeded",
              deliveryStatus: "delivered",
              notifyPolicy: "done_only",
              createdAt: now - 5_000,
              updatedAt: now - 4_000,
              steps: [
                { id: "plan", label: "Plan", status: "succeeded" },
                { id: "run", label: "Run", status: "succeeded" },
                { id: "deliver", label: "Deliver", status: "succeeded" },
              ],
            },
            {
              taskId: "CLI:workflow-failed",
              runId: "workflow-failed",
              source: "CLI",
              runtime: "cli",
              taskKind: "workflow",
              agentId: "beta",
              task: "Failed workflow",
              status: "failed",
              deliveryStatus: "not_delivered",
              notifyPolicy: "state_changes",
              createdAt: now - 4_000,
              updatedAt: now - 3_000,
              steps: [
                { id: "plan", label: "Plan", status: "succeeded" },
                {
                  id: "publish",
                  label: "Publish",
                  status: "failed",
                  error: "Publish failed.",
                },
              ],
            },
            {
              taskId: "wallet:workflow-blocked",
              runId: "wallet-workflow-blocked",
              source: "wallet",
              runtime: "wallet",
              taskKind: "workflow",
              agentId: "beta",
              task: "Wallet mirrored workflow",
              status: "blocked",
              deliveryStatus: "not_applicable",
              notifyPolicy: "state_changes",
              createdAt: now - 3_000,
              updatedAt: now - 2_000,
              metadata: { approvalId: "wallet-approval-1" },
              steps: [
                { id: "simulate", label: "Simulate policy", status: "succeeded" },
                {
                  id: "approval",
                  label: "Passkey approval",
                  status: "blocked",
                  error: "Approve in Wallets.",
                },
              ],
            },
          ],
        },
      },
    });
    const container = document.createElement("div");
    render(renderAgents(props), container);

    expect(container.textContent).toContain("Workflow completed");
    expect(container.textContent).toContain("Failed at Publish");
    expect(container.textContent).toContain("Publish failed.");
    expect(container.textContent).toContain("Wallet mirrored workflow");
    expect(container.textContent).toContain("Waiting for approval");
    expect(container.textContent).toContain("Approve in Wallets.");
    expect(container.querySelectorAll(".agent-task-view-only")).toHaveLength(1);
    expect(container.querySelector('button[aria-label="Approve/resume workflow"]')).toBeNull();
    const retryButtons = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).filter(
      (button) => button.getAttribute("aria-label") === "Retry workflow",
    );
    expect(retryButtons).toHaveLength(1);
    retryButtons[0]?.click();
    expect(onControl).toHaveBeenCalledWith("retry", "CLI:workflow-failed");
  });

  it("shows Agent task lifecycle and evaluator status", () => {
    const onCronRunDetail = vi.fn();
    const props = createProps({
      activePanel: "cron",
      selectedAgentId: "beta",
      onCronRunDetail,
      cron: {
        status: {
          enabled: true,
          jobs: 1,
          nextWakeAtMs: null,
          queue: {
            path: "/tmp/queue.json",
            total: 2,
            queued: 0,
            running: 2,
            terminal: 0,
            cancelRequested: 0,
            expiredLeases: 0,
            byStatus: {
              queued: 0,
              running: 2,
              ok: 0,
              error: 0,
              skipped: 0,
              blocked: 0,
              canceled: 0,
              recovered: 0,
            },
            workers: [],
            activeRuns: [
              {
                runId: "run-beta-active",
                jobId: "task-market",
                jobName: "Market watch",
                agentId: "beta",
                sessionKey: "agent:beta:webchat:direct:market",
                status: "running",
                stepId: "execute",
                attempt: 1,
                maxAttempts: 2,
                leaseOwner: "worker-beta",
                leaseExpired: false,
                queuedAtMs: 1,
                startedAtMs: 2,
                updatedAtMs: 3,
              },
              {
                runId: "run-alpha-active",
                jobId: "task-alpha",
                jobName: "Alpha task",
                agentId: "alpha",
                status: "running",
                stepId: "execute",
                attempt: 1,
                maxAttempts: 2,
                leaseOwner: "worker-alpha",
                leaseExpired: false,
                queuedAtMs: 1,
                startedAtMs: 2,
                updatedAtMs: 3,
              },
            ],
            recentRuns: [],
          },
        },
        loading: false,
        error: null,
        jobs: [
          {
            id: "task-market",
            name: "Market watch",
            agentId: "beta",
            sessionKey: "agent:beta:webchat:direct:market",
            enabled: true,
            createdAtMs: 1,
            updatedAtMs: 2,
            schedule: { kind: "every", everyMs: 600_000 },
            sessionTarget: "isolated",
            wakeMode: "next-heartbeat",
            payload: { kind: "agentTurn", message: "check market" },
            delivery: { mode: "announce", channel: "telegram", to: "397848047" },
            executionPolicy: {
              executionMode: "agent-turn",
              modelPolicy: { mode: "task-override", model: "openrouter/google/gemini-flash" },
            },
            state: {
              lastRunStatus: "ok",
              lastStatus: "ok",
              lastDeliveryStatus: "delivered",
              lastRunResultSource: "direct-tool",
              lastRunResultAdapter: "wallet",
              lastRunModelUsed: false,
              lastRunCheckpoint: { runId: "run-1" },
              lastRunSessionKey: "agent:beta:cron:task-market:run:run-1",
              lastEvaluatorDecision: {
                source: "heuristic",
                action: "none",
                reason: "No escalation cue found.",
              },
            },
          } as never,
        ],
      },
    });
    const container = document.createElement("div");
    render(renderAgents(props), container);

    expect(container.textContent).toContain("Market watch");
    expect(container.textContent).toContain("Last run ok");
    expect(container.textContent).toContain("Delivery sent");
    expect(container.textContent).toContain("Direct tool result");
    expect(container.textContent).toContain("wallet - no model used");
    expect(container.textContent).toContain("Evaluator none");
    expect(container.textContent).toContain("Latest run transcript is ready");
    expect(container.textContent).toContain("openrouter/google/gemini-flash");
    expect(container.textContent).not.toContain("Task workers");
    expect(container.textContent).not.toContain("1 worker");
    expect(container.textContent).not.toContain("worker-beta");
    expect(container.textContent).not.toContain("worker-alpha");

    const latestRunButton = container.querySelector('button[aria-label="Open latest run"]');
    expect(latestRunButton).not.toBeNull();
    latestRunButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onCronRunDetail).toHaveBeenCalledWith("run-beta-active");
  });

  it("wires Agent checklist actions to the source pages and per-agent setup controls", () => {
    const props = createProps({
      config: {
        form: {
          agents: {
            defaults: { model: "openai/gpt-5.5" },
            list: [
              {
                id: "beta",
                name: "Beta",
                workspace: "/tmp/beta",
                skills: [],
                tools: { profile: "minimal" },
              },
            ],
          },
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
            createReadySkill(),
            createReadySkill({
              name: "Needs API",
              skillKey: "needs-api",
              primaryEnv: "OPENAI_API_KEY",
              missing: { bins: [], env: ["OPENAI_API_KEY"], config: [], os: [] },
              eligible: false,
            }),
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
          workspace: { path: "/tmp/workspace", exists: true, memoryRoots: [] },
          backend: { configured: "builtin", active: "builtin", citations: "auto" },
          qmd: { enabled: false },
          sessionMemory: {
            hookConfigured: true,
            enabled: false,
            messages: 0,
            llmSlug: false,
          },
          memoryPlugin: { configuredSlot: null, enabled: false, registryLoaded: true },
        },
        validation: null,
        loading: false,
        error: null,
      },
      channels: {
        snapshot: {
          ts: 0,
          channelOrder: ["telegram"],
          channelLabels: { telegram: "Telegram" },
          channels: {},
          channelAccounts: {
            telegram: [{ accountId: "ops", name: "Ops", configured: true, running: true }],
          },
          channelDefaultAccountId: { telegram: "ops" },
        },
        loading: false,
        error: null,
        lastSuccess: 0,
      },
    });
    const container = document.createElement("div");
    render(renderAgents(props), container);

    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
    const clickButton = (label: string) => {
      const button = buttons.find((entry) => entry.textContent?.includes(label));
      expect(button, label).toBeInstanceOf(HTMLButtonElement);
      button!.click();
    };

    container.querySelector<HTMLButtonElement>('button[aria-label="Models"]')?.click();
    expect(
      container.querySelector<HTMLDialogElement>('[data-agent-model-dialog="true"]')?.open,
    ).toBe(true);
    expect(
      container.querySelector<HTMLSelectElement>('select[data-agent-model-provider-select="true"]'),
    ).toBeNull();

    clickButton("Memory");
    expect(props.onSelectPanel).toHaveBeenCalledWith("memory");

    clickButton("Skills");
    expect(props.onSelectPanel).toHaveBeenCalledWith("skills");

    clickButton("Channels");
    expect(props.onSelectPanel).toHaveBeenCalledWith("channels");

    clickButton("Tasks");
    expect(props.onSelectPanel).toHaveBeenCalledWith("cron");

    clickButton("Sessions");
    expect(props.onSelectPanel).toHaveBeenCalledWith("sessions");
  });

  it("toggles Agent memory archive and keeps hook-pack controls out of the panel", () => {
    const props = createProps({
      activePanel: "memory",
      config: {
        form: {
          hooks: {
            internal: {
              enabled: true,
              entries: {
                "boot-md": { enabled: false },
                "bootstrap-extra-files": { enabled: false },
                "command-logger": { enabled: true },
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
          workspace: { path: "/tmp/workspace", exists: true, memoryRoots: [] },
          backend: { configured: "builtin", active: "builtin", citations: "auto" },
          qmd: { enabled: false },
          sessionMemory: {
            hookConfigured: true,
            enabled: false,
            messages: 0,
            llmSlug: false,
          },
          memoryPlugin: { configuredSlot: null, enabled: false, registryLoaded: true },
        },
        validation: null,
        loading: false,
        error: null,
      },
    });
    const container = document.createElement("div");
    render(renderAgents(props), container);

    const sessionMemory = container.querySelector<HTMLButtonElement>(
      'button[data-session-memory-toggle="true"]',
    );
    expect(sessionMemory).toBeInstanceOf(HTMLButtonElement);
    sessionMemory!.click();
    expect(props.onSessionMemoryEnabledChange).toHaveBeenCalledWith(true);
    expect(props.onConfigSave).not.toHaveBeenCalled();

    const save = container.querySelector<HTMLButtonElement>(
      'button[data-agent-memory-save="true"]',
    );
    expect(save).toBeInstanceOf(HTMLButtonElement);
    expect(save?.disabled).toBe(false);
    save!.click();
    expect(props.onConfigSave).toHaveBeenCalled();

    container
      .querySelector<HTMLButtonElement>('button[data-agent-memory-diagnostics="true"]')
      ?.click();
    expect(props.onNavigate).toHaveBeenCalledWith("debug");
    expect(container.textContent).toContain("Session archive");
    expect(container.textContent).not.toContain("boot-md");
    expect(container.textContent).not.toContain("command-logger");
  });
});
