import { html, nothing } from "lit";
import { normalizeToolName } from "../../../../src/agents/tool-policy-shared.js";
import { normalizeAgentModelFallbackValues } from "../../../../src/config/model-input.js";
import {
  getProviderBrandManifest,
  getProviderBrandManifestForRoute,
  isStandardProviderCatalogEntry,
} from "../../../../src/providers/registry.ts";
import { closeDialogOnBackdropClick, openDialogSafely } from "../dialog.ts";
import type { FederationStatus, FederationToken } from "../federation-api.ts";
import { icons } from "../icons.ts";
import type { SatMinerProfile, SatMiningReadiness, SatMiningRuntimeStatus } from "../mining-api.ts";
import { pathForTab, type Tab } from "../navigation.ts";
import type {
  AgentIdentityResult,
  AgentsFilesListResult,
  AgentsListResult,
  ChannelsStatusSnapshot,
  CronJob,
  ModelCatalogEntry,
  ModelsAuthStatusResult,
  ModelsCatalogStatusResult,
  PluginsMarketplaceListResult,
  SessionsUsageResult,
  SavedTaskWorkflowDefinitionsResult,
  SkillStatusEntry,
  SkillStatusReport,
  TaskListResult,
  ToolsCatalogResult,
  ToolsEffectiveResult,
  WebhookTriggersResult,
} from "../types.ts";
import type { WalletNamedWallet, WalletStatus } from "../wallet-api.ts";
import {
  isAllowedByPolicy,
  isVisibleAgentToolId,
  matchesList,
  normalizeAgentLabel,
  normalizeModelProviderId,
  normalizeModelValue,
  resolveAgentAvatarUrl,
  resolveAgentEmoji,
  resolveAgentConfig,
  resolveAgentModelProviders,
  resolveModelFallbacks,
  resolveModelLabel,
  resolveModelPrimary,
  resolveTaskModelSlots,
  resolveToolProfile,
  type AgentModelProviderSettings,
  type AgentTaskModelSlots,
} from "./agents-utils.ts";
import type {
  AgentsPanel,
  ChannelsState,
  CronState,
  MemoryState,
  SessionsState,
} from "./agents.ts";
import { getSkillReadiness, isSkillReady, summarizeSkillReadiness } from "./skills-shared.ts";
import { formatTokens } from "./usage-metrics.ts";

type CardTone = "default" | "ok" | "warn" | "danger";

type AgentModelOption = {
  provider: string;
  brandId: string;
  value: string;
  label: string;
  capabilityDetail?: string;
};

type AgentTaskModelRole = keyof AgentTaskModelSlots;

const AGENT_TASK_MODEL_ROLES: Array<{
  key: AgentTaskModelRole;
  label: string;
  detail: string;
}> = [
  {
    key: "cheapCheck",
    label: "Cheap/check",
    detail: "First pass for lightweight checks before escalation.",
  },
  {
    key: "strong",
    label: "Strong",
    detail: "Direct strong-model task runs.",
  },
  {
    key: "escalation",
    label: "Escalation",
    detail: "Follow-up when a cheap/check task needs deeper analysis.",
  },
  {
    key: "coding",
    label: "Coding",
    detail: "Coding-specialized task runs.",
  },
  {
    key: "summarizer",
    label: "Summarizer",
    detail: "Summary, compression, and report shaping.",
  },
];

function providerLabel(provider: string): string {
  const manifest = getProviderBrandManifest(provider) ?? getProviderBrandManifestForRoute(provider);
  if (manifest) {
    return manifest.label;
  }
  return provider
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function providerBrandId(provider: string): string {
  return getProviderBrandManifestForRoute(provider)?.id ?? provider;
}

function isAuthReadyProviderStatus(status: string): boolean {
  return status === "ok" || status === "expiring" || status === "static";
}

function modelProviderFromValue(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? "";
  const index = trimmed.indexOf("/");
  return index > 0 ? trimmed.slice(0, index) : "";
}

function addAgentModelOption(
  options: Map<string, AgentModelOption>,
  params: { provider: string; id: string; label?: string; capabilityDetail?: string },
) {
  const provider = params.provider.trim();
  const id = params.id.trim();
  if (!provider || !id) {
    return;
  }
  const value = id.toLowerCase().startsWith(`${provider.toLowerCase()}/`)
    ? id
    : `${provider}/${id}`;
  if (options.has(value)) {
    return;
  }
  options.set(value, {
    provider,
    brandId: providerBrandId(provider),
    value,
    label: params.label?.trim() || id,
    ...(params.capabilityDetail ? { capabilityDetail: params.capabilityDetail } : {}),
  });
}

function modelCatalogLabel(entry: ModelCatalogEntry): string {
  return entry.name && entry.name !== entry.id ? `${entry.name} (${entry.id})` : entry.id;
}

function modelCapabilityDetail(entry: ModelCatalogEntry): string {
  const metadata = entry.metadata;
  if (!metadata) {
    return "capabilities unknown";
  }
  const parts = [
    metadata.features.includes("vision") ? "vision" : null,
    metadata.features.includes("tools") ? "tools" : null,
    metadata.features.includes("reasoning") ? "reasoning" : null,
    metadata.streaming ? "streaming" : null,
    metadata.privateNetwork ? "private" : null,
  ].filter((value): value is string => Boolean(value));
  if (metadata.capabilityConfidence === "unknown") {
    parts.push("local capabilities unknown");
  }
  return parts.length > 0 ? parts.join(" · ") : "text";
}

function buildAgentModelOptions(catalog: ModelCatalogEntry[]) {
  const options = new Map<string, AgentModelOption>();
  for (const entry of catalog) {
    const provider = entry.provider?.trim();
    if (!provider) {
      continue;
    }
    if (!isStandardProviderCatalogEntry(entry)) {
      continue;
    }
    addAgentModelOption(options, {
      provider,
      id: entry.id,
      label: modelCatalogLabel(entry),
      capabilityDetail: modelCapabilityDetail(entry),
    });
  }
  return Array.from(options.values()).toSorted(
    (a, b) =>
      providerLabel(a.brandId).localeCompare(providerLabel(b.brandId)) ||
      a.label.localeCompare(b.label),
  );
}

function _buildAgentModelProviderEntries(
  authStatus: ModelsAuthStatusResult | null,
  modelOptions: AgentModelOption[],
  currentModel: string | null,
) {
  const providers = new Map<string, string>();
  for (const provider of authStatus?.providers ?? []) {
    if (isAuthReadyProviderStatus(provider.status)) {
      providers.set(providerBrandId(provider.provider), providerLabel(provider.provider));
    }
  }
  const currentProvider = modelProviderFromValue(currentModel);
  if (currentProvider) {
    providers.set(providerBrandId(currentProvider), providerLabel(currentProvider));
  }
  const modelProviders = new Set(modelOptions.map((option) => option.brandId));
  return Array.from(providers.entries())
    .filter(
      ([provider]) => modelProviders.has(provider) || provider === providerBrandId(currentProvider),
    )
    .map(([id, label]) => ({ id, label }))
    .toSorted((a, b) => a.label.localeCompare(b.label));
}

function prioritizeModelOption(entry: AgentModelOption): number {
  return entry.value === `${entry.provider}/auto` || entry.value === "openrouter/auto" ? 0 : 1;
}

function renderAgentProviderModelOptions(options: AgentModelOption[], selectedModel: string) {
  const byProvider = new Map<string, AgentModelOption[]>();
  for (const entry of options) {
    const current = byProvider.get(entry.brandId) ?? [];
    current.push(entry);
    byProvider.set(entry.brandId, current);
  }
  return Array.from(byProvider.entries())
    .toSorted((a, b) => providerLabel(a[0]).localeCompare(providerLabel(b[0])))
    .map(
      ([provider, providerModels]) => html`
      <optgroup label=${providerLabel(provider)} data-provider=${provider}>
        ${providerModels
          .slice()
          .toSorted(
            (a, b) =>
              prioritizeModelOption(a) - prioritizeModelOption(b) || a.label.localeCompare(b.label),
          )
          .map(
            (entry) => html`
              <option
                value=${entry.value}
                data-provider=${provider}
                ?selected=${selectedModel === entry.value}
              >
                ${entry.label}
              </option>
            `,
          )}
      </optgroup>
    `,
    );
}

function renderTaskRoleModelOptions(options: AgentModelOption[], selectedModel = "") {
  const byProvider = new Map<string, AgentModelOption[]>();
  for (const entry of options) {
    const current = byProvider.get(entry.brandId) ?? [];
    current.push(entry);
    byProvider.set(entry.brandId, current);
  }
  return Array.from(byProvider.entries())
    .toSorted((a, b) => providerLabel(a[0]).localeCompare(providerLabel(b[0])))
    .map(
      ([provider, providerModels]) => html`
      <optgroup label=${providerLabel(provider)} data-provider=${provider}>
        ${providerModels
          .slice()
          .toSorted(
            (a, b) =>
              prioritizeModelOption(a) - prioritizeModelOption(b) || a.label.localeCompare(b.label),
          )
          .map(
            (entry) => html`
              <option
                value=${entry.value}
                data-provider=${entry.brandId}
                ?selected=${selectedModel === entry.value}
              >
                ${entry.label}
              </option>
            `,
          )}
      </optgroup>
    `,
    );
}

function agentModelOptionLabel(options: AgentModelOption[], value: string, emptyLabel: string) {
  if (!value) {
    return emptyLabel;
  }
  return options.find((option) => option.value === value)?.label ?? value;
}

function findAgentModelControlSelect(root: HTMLElement, control: string) {
  if (control === "main") {
    return root.querySelector<HTMLSelectElement>('[data-agent-model-select="true"]');
  }
  if (control === "fallback") {
    return root.querySelector<HTMLSelectElement>("[data-agent-fallback-model]");
  }
  if (control.startsWith("role:")) {
    const role = control.slice("role:".length);
    return root.querySelector<HTMLSelectElement>(`[data-agent-task-model-role="${role}"]`);
  }
  return null;
}

function updateAgentModelControlState(root: HTMLElement, control?: string) {
  const controls = control
    ? [control]
    : Array.from(
        new Set(
          Array.from(root.querySelectorAll<HTMLElement>("[data-agent-model-control]"))
            .map((entry) => entry.dataset.agentModelControl)
            .filter((entry): entry is string => Boolean(entry)),
        ),
      );
  for (const current of controls) {
    const select = findAgentModelControlSelect(root, current);
    const selectedValue = select?.value ?? "";
    const emptyLabel = select?.dataset.emptyLabel ?? "Select model";
    const label =
      select?.selectedOptions[0]?.textContent?.trim() ||
      (selectedValue ? selectedValue : emptyLabel);
    for (const summary of Array.from(
      root.querySelectorAll<HTMLElement>("[data-agent-model-selected-for]"),
    ).filter((entry) => entry.dataset.agentModelSelectedFor === current)) {
      summary.textContent = label;
    }
    for (const button of Array.from(
      root.querySelectorAll<HTMLButtonElement>('[data-agent-model-option="true"]'),
    ).filter((entry) => entry.dataset.agentModelControl === current)) {
      const active = button.dataset.value === selectedValue;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
    }
  }
}

function renderAgentModelSelectButtons(params: {
  control: string;
  emptyLabel: string;
  options: AgentModelOption[];
  selectedValue: string;
}) {
  const grouped = new Map<string, AgentModelOption[]>();
  for (const option of params.options) {
    const current = grouped.get(option.brandId) ?? [];
    current.push(option);
    grouped.set(option.brandId, current);
  }
  const modelButtons = Array.from(grouped.entries())
    .toSorted((a, b) => providerLabel(a[0]).localeCompare(providerLabel(b[0])))
    .map(
      ([provider, options]) => html`
        <div class="agent-model-select__group">${providerLabel(provider)}</div>
        ${options
          .slice()
          .toSorted(
            (a, b) =>
              prioritizeModelOption(a) - prioritizeModelOption(b) || a.label.localeCompare(b.label),
          )
          .map(
            (entry) => html`
              <button
                class="chat-select__option agent-model-select__model-option ${
                  params.selectedValue === entry.value ? "active" : ""
                }"
                type="button"
                role="option"
                aria-selected=${String(params.selectedValue === entry.value)}
                title=${`${entry.label} · ${providerLabel(entry.brandId)}${
                  entry.capabilityDetail ? ` · ${entry.capabilityDetail}` : ""
                }`}
                data-agent-model-option="true"
                data-agent-model-control=${params.control}
                data-provider=${entry.brandId}
                data-value=${entry.value}
                @click=${handleAgentModelSelectOption}
              >
                ${entry.label} · ${providerLabel(entry.brandId)}
                ${
                  entry.capabilityDetail
                    ? html`<span class="agent-model-select__capabilities">${entry.capabilityDetail}</span>`
                    : nothing
                }
              </button>
            `,
          )}
      `,
    );
  return html`
    <button
      class="chat-select__option ${params.selectedValue ? "" : "active"}"
      type="button"
      role="option"
      aria-selected=${String(!params.selectedValue)}
      data-agent-model-option="true"
      data-agent-model-control=${params.control}
      data-value=""
      @click=${handleAgentModelSelectOption}
    >
      ${params.emptyLabel}
    </button>
    ${modelButtons}
  `;
}

function handleAgentModelSelectOption(event: Event) {
  const button = event.currentTarget as HTMLButtonElement;
  const root = button.closest<HTMLElement>("[data-agent-model-attach-root]");
  const control = button.dataset.agentModelControl ?? "";
  const select = root ? findAgentModelControlSelect(root, control) : null;
  if (!root || !select) {
    return;
  }
  const details = button.closest("details");
  if (details instanceof HTMLDetailsElement) {
    details.open = false;
  }
  select.value = button.dataset.value ?? "";
  select.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  select.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  updateAgentModelControlState(root, control);
}

function renderAgentModelPicker(params: {
  ariaLabel: string;
  control: string;
  disabled: boolean;
  emptyLabel: string;
  nativeOptions: unknown;
  onChange: (event: Event) => void;
  options: AgentModelOption[];
  role?: AgentTaskModelRole;
  savedRoleValue?: string;
  value: string;
}) {
  const selectedLabel = agentModelOptionLabel(params.options, params.value, params.emptyLabel);
  return html`
    <div class="chat-select agent-model-select" data-floating-select="true">
      <label class="field chat-select__native-wrap">
        <select
          class="chat-select__native agent-model-native-select"
          data-agent-model-control-select=${params.control}
          data-agent-model-select=${params.control === "main" ? "true" : nothing}
          data-agent-fallback-model=${params.control === "fallback" ? "true" : nothing}
          data-agent-task-model-role=${params.role ?? nothing}
          data-agent-task-model-saved-value=${params.savedRoleValue ?? nothing}
          data-empty-label=${params.emptyLabel}
          aria-label=${params.ariaLabel}
          .value=${params.value}
          ?disabled=${params.disabled}
          @change=${params.onChange}
        >
          <option
            value=""
            data-agent-model-empty-option=${params.control === "main" ? "true" : nothing}
            data-agent-role-default-option=${params.role ? "true" : nothing}
          >
            ${params.emptyLabel}
          </option>
          ${params.nativeOptions}
        </select>
      </label>
      <details class="chat-select__popover" data-agent-model-control=${params.control}>
        <summary
          class="chat-select__button"
          aria-label=${params.ariaLabel}
          aria-disabled=${params.disabled}
          @click=${(event: Event) => {
            if (params.disabled) {
              event.preventDefault();
            }
          }}
        >
          <span data-agent-model-selected-for=${params.control}>${selectedLabel}</span>
          ${icons.chevronDown}
        </summary>
        <div class="chat-select__panel" role="listbox" aria-label=${params.ariaLabel}>
          ${renderAgentModelSelectButtons({
            control: params.control,
            emptyLabel: params.emptyLabel,
            options: params.options,
            selectedValue: params.value,
          })}
        </div>
      </details>
    </div>
  `;
}

function parseAgentPrimaryDraft(root: HTMLElement): string | null {
  const modelSelect = root.querySelector<HTMLSelectElement>('[data-agent-model-select="true"]');
  const selected = modelSelect?.value?.trim() ?? "";
  const saved = root.dataset.agentModelPrimary?.trim() ?? "";
  return selected || saved || null;
}

function writeAgentPrimaryDraft(root: HTMLElement, modelId: string | null) {
  const trimmed = modelId?.trim() ?? "";
  if (trimmed) {
    root.dataset.agentModelPrimary = trimmed;
  } else {
    delete root.dataset.agentModelPrimary;
  }
}

function parseAgentFallbackDraft(root: HTMLElement): string[] {
  try {
    const parsed = JSON.parse(root.dataset.agentModelFallbacks ?? "[]");
    return normalizeAgentModelFallbackValues(parsed) ?? [];
  } catch {
    return [];
  }
}

function writeAgentFallbackDraft(root: HTMLElement, fallbacks: string[]) {
  root.dataset.agentModelFallbacks = JSON.stringify(
    normalizeAgentModelFallbackValues(fallbacks) ?? [],
  );
}

function updateAgentModelDependentDefaults(root: HTMLElement) {
  const modelSelect = root.querySelector<HTMLSelectElement>('[data-agent-model-select="true"]');
  const primary = modelSelect?.value?.trim() ?? "";
  for (const option of Array.from(
    root.querySelectorAll<HTMLOptionElement>("[data-agent-role-default-option='true']"),
  )) {
    option.textContent = primary
      ? `Use Agent default model (${primary})`
      : "Use Agent default model";
  }
  const fallbackSelect = root.querySelector<HTMLSelectElement>("[data-agent-fallback-model]");
  if (fallbackSelect && fallbackSelect.value === primary) {
    fallbackSelect.value = "";
    writeAgentFallbackDraft(root, []);
  }
}

function parseAgentTaskModelDraft(root: HTMLElement): AgentTaskModelSlots {
  try {
    const parsed = JSON.parse(root.dataset.agentTaskModels ?? "{}");
    return resolveTaskModelSlots(parsed) ?? {};
  } catch {
    return {};
  }
}

function writeAgentTaskModelDraft(root: HTMLElement, taskModels: AgentTaskModelSlots) {
  root.dataset.agentTaskModels = JSON.stringify(taskModels);
}

function parseAgentProviderModelDraft(
  root: HTMLElement,
): Record<string, AgentModelProviderSettings> {
  try {
    return resolveAgentModelProviders(JSON.parse(root.dataset.agentProviderModels ?? "{}"));
  } catch {
    return {};
  }
}

function currentAgentModelProvider(root: HTMLElement): string {
  const modelSelect = root.querySelector<HTMLSelectElement>('[data-agent-model-select="true"]');
  return (
    normalizeModelProviderId(modelProviderFromValue(modelSelect?.value)) ??
    normalizeModelProviderId(root.dataset.agentActiveProvider) ??
    ""
  );
}

function syncAgentTaskRoleProviderFilter(root: HTMLElement) {
  const draft = parseAgentTaskModelDraft(root);
  for (const select of Array.from(
    root.querySelectorAll<HTMLSelectElement>("[data-agent-task-model-role]"),
  )) {
    const role = select.dataset.agentTaskModelRole as AgentTaskModelRole | undefined;
    const savedValue =
      (role ? draft[role] : undefined) ?? select.dataset.agentTaskModelSavedValue ?? "";
    for (const group of Array.from(
      select.querySelectorAll<HTMLOptGroupElement>("optgroup[data-provider]"),
    )) {
      group.hidden = false;
    }
    for (const option of Array.from(select.options)) {
      const optionProvider = option.dataset.provider;
      if (!optionProvider) {
        option.hidden = false;
        option.disabled = false;
        continue;
      }
      option.hidden = false;
      option.disabled = false;
    }
    if (savedValue && Array.from(select.options).some((option) => option.value === savedValue)) {
      select.value = savedValue;
      select.dataset.agentTaskModelSavedValue = savedValue;
    } else if (savedValue) {
      select.dataset.agentTaskModelSavedValue = savedValue;
      select.value = "";
    }
  }
}

function syncAgentModelProviderFilter(root: HTMLElement, options: { savePrimary?: boolean } = {}) {
  const modelSelect = root.querySelector<HTMLSelectElement>('[data-agent-model-select="true"]');
  if (!modelSelect) {
    return;
  }
  const provider = currentAgentModelProvider(root);
  const previousModel = modelSelect.value;
  for (const group of Array.from(
    modelSelect.querySelectorAll<HTMLOptGroupElement>("optgroup[data-provider]"),
  )) {
    group.hidden = false;
  }
  for (const option of Array.from(modelSelect.options)) {
    const optionProvider = option.dataset.provider;
    if (!optionProvider) {
      option.hidden = false;
      option.disabled = false;
      continue;
    }
    const isNotice = option.dataset.noModels === "true";
    option.hidden = false;
    option.disabled = isNotice;
  }
  if (options.savePrimary && previousModel !== modelSelect.value) {
    modelSelect.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    modelSelect.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  }
  root.dataset.agentActiveProvider = provider;
  syncAgentTaskRoleProviderFilter(root);
  updateAgentModelDependentDefaults(root);
  updateAgentModelControlState(root);
}

function restoreAgentModelPrimarySelection(root: HTMLElement) {
  const modelSelect = root.querySelector<HTMLSelectElement>('[data-agent-model-select="true"]');
  if (!modelSelect) {
    return;
  }
  const savedPrimary = parseAgentPrimaryDraft(root) ?? root.dataset.agentLegacyPrimary ?? "";
  if (
    savedPrimary &&
    Array.from(modelSelect.options).some((option) => option.value === savedPrimary)
  ) {
    modelSelect.value = savedPrimary;
  }
  syncAgentModelProviderFilter(root);
}

type SkillFixAction =
  | { kind: "enable-global"; skill: SkillStatusEntry; detail: string }
  | { kind: "enable-agent"; skill: SkillStatusEntry; detail: string }
  | { kind: "save-api"; skill: SkillStatusEntry; detail: string }
  | { kind: "install"; skill: SkillStatusEntry; detail: string; installId: string; label: string }
  | { kind: "open-skills"; skill: SkillStatusEntry; detail: string };

const SERVICE_SKILL_ATTACHMENTS = [
  {
    title: "Google Workspace",
    label: "gog",
    candidates: ["gog", "Google Workspace"],
    detail: "Gmail, Calendar, Drive, Docs, Sheets, and Contacts through the gog skill.",
  },
  {
    title: "GitHub",
    label: "github",
    candidates: ["github"],
    detail: "GitHub CLI and repository workflows through the github skill.",
  },
] as const;

const SERVICE_TOOL_GROUPS = [
  {
    title: "Web/search",
    label: "web/search",
    action: "Enable web/search tools",
    tools: ["web_search", "web_fetch"],
    detail: "Public web search and fetch tools.",
  },
  {
    title: "Browser/media",
    label: "browser/media",
    action: "Enable browser/media tools",
    tools: ["browser", "image"],
    detail: "Browser control and image/media understanding tools.",
  },
] as const;

function cardToneClass(tone?: CardTone) {
  return tone && tone !== "default" ? ` ${tone}` : "";
}

function renderWorkbenchLink(params: {
  basePath: string;
  tab: Tab;
  label: string;
  onNavigate: (tab: Tab) => void;
}) {
  const href = pathForTab(params.tab, params.basePath);
  return html`
    <a
      class="agent-workbench-card__action"
      href=${href}
      @click=${(event: MouseEvent) => {
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        event.preventDefault();
        params.onNavigate(params.tab);
      }}
    >
      ${params.label}
    </a>
  `;
}

function renderWorkbenchActionLabel(label: string) {
  return html`<span class="agent-workbench-card__action-label">${label}</span>`;
}

function renderWorkbenchPanelAction(params: {
  panel: AgentsPanel;
  label: string;
  icon?: unknown;
  variant?: "default" | "neutral";
  onSelectPanel: (panel: AgentsPanel) => void;
}) {
  return html`
    <button
      type="button"
      class="agent-workbench-card__action ${
        params.variant === "neutral" ? "agent-workbench-card__action--neutral" : ""
      }"
      @click=${() => params.onSelectPanel(params.panel)}
    >
      ${params.icon ?? nothing}${renderWorkbenchActionLabel(params.label)}
    </button>
  `;
}

function openAgentModelDropdown(event: Event, selector?: string) {
  event.preventDefault();
  const trigger = event.currentTarget as HTMLElement;
  const root = trigger.closest(".card") ?? document;
  const dialog = root.querySelector<HTMLDialogElement>('[data-agent-model-dialog="true"]');
  if (dialog) {
    openDialogSafely(dialog);
  }
  const attachRoot = dialog?.querySelector<HTMLElement>("[data-agent-model-attach-root]");
  if (attachRoot && !selector) {
    restoreAgentModelPrimarySelection(attachRoot);
  }
  if (!selector) {
    return;
  }
  root.querySelector<HTMLElement>(selector)?.focus();
}

function renderAgentModelDropdownAction(params: {
  label: string;
  selector?: string;
  iconOnly?: boolean;
  icon?: unknown;
  wide?: boolean;
  variant?: "default" | "primary";
}) {
  return html`
    <button
      type="button"
      class="agent-workbench-card__action agent-model-action ${
        params.iconOnly ? "agent-workbench-card__action--icon" : ""
      } ${params.variant === "primary" ? "agent-workbench-card__action--primary" : ""} ${
        params.wide ? "agent-setup-card__link agent-setup-card__link--wide" : ""
      }"
      aria-label=${params.label}
      title=${params.label}
      @click=${(event: Event) => openAgentModelDropdown(event, params.selector)}
    >
      ${
        params.iconOnly
          ? icons.plus
          : html`${params.icon ?? nothing}${renderWorkbenchActionLabel(params.label)}`
      }
    </button>
  `;
}

function renderWorkbenchAnchor(params: { href: string; label: string }) {
  return html`
    <a class="agent-workbench-card__action" href=${params.href}>
      ${params.label}
    </a>
  `;
}

function _renderWorkbenchCard(params: {
  label: string;
  value: string;
  detail: string;
  tone?: CardTone;
  action?: unknown;
}) {
  return html`
    <div class="agent-workbench-card ${params.tone ?? "default"}">
      <div class="agent-workbench-card__label"><span class="agent-status-dot"></span>${params.label}</div>
      <div class="agent-workbench-card__value${cardToneClass(params.tone)}">${params.value}</div>
      <div class="agent-workbench-card__detail">${params.detail}</div>
      ${params.action ? html`<div class="agent-workbench-card__actions">${params.action}</div>` : nothing}
    </div>
  `;
}

function summarizeAgentUsage(
  usage: { result: SessionsUsageResult | null; loading: boolean; error: string | null } | undefined,
  agentId: string,
) {
  if (!usage?.result) {
    return {
      value: usage?.loading ? "..." : "-",
      detail: usage?.loading
        ? "Usage ledger is loading."
        : usage?.error
          ? "Usage ledger could not load."
          : "Load Usage to see this Agent's recent token usage.",
      tone: usage?.error ? ("warn" as CardTone) : ("default" as CardTone),
      title:
        usage?.error ??
        "Usage sessions are counted from chat, task, channel, CLI, and system runs.",
    };
  }
  const normalizedAgentId = agentId.toLowerCase();
  const cutoffMs = Date.now() - 24 * 60 * 60 * 1000;
  const sessions = usage.result.sessions.filter((session) => {
    if (session.agentId?.toLowerCase() !== normalizedAgentId) {
      return false;
    }
    const lastActivity = session.usage?.lastActivity ?? session.updatedAt ?? 0;
    return lastActivity >= cutoffMs;
  });
  const tokenSessions = sessions.filter((session) => (session.usage?.totalTokens ?? 0) > 0);
  const totalTokens = tokenSessions.reduce(
    (total, session) => total + (session.usage?.totalTokens ?? 0),
    0,
  );
  return {
    value: formatTokens(totalTokens),
    detail: `${tokenSessions.length} ${tokenSessions.length === 1 ? "session" : "sessions"}`,
    tone: totalTokens > 0 ? ("ok" as CardTone) : ("default" as CardTone),
    title: `${agentId} token usage in the last 24 hours.`,
  };
}

function renderSetupSummaryAction(params: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  icon?: unknown;
  title?: string;
  tone?: CardTone;
  wide?: boolean;
}) {
  return html`
    <button
      type="button"
      class="agent-setup-card__link ${params.wide ? "agent-setup-card__link--wide" : ""}"
      ?disabled=${params.disabled}
      title=${params.title ?? params.label}
      @click=${params.onClick}
    >
      ${
        params.tone
          ? html`<span class="agent-status-dot ${params.tone}" aria-hidden="true"></span>`
          : (params.icon ?? nothing)
      }${params.label}
    </button>
  `;
}

function renderSetupTitleButton(params: { label: string; onClick: () => void }) {
  return html`
    <button type="button" class="agent-setup-card__title-button" @click=${params.onClick}>
      ${params.label}
    </button>
  `;
}

function readImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => resolve(image), { once: true });
    image.addEventListener("error", () => reject(new Error("Avatar image failed to load.")), {
      once: true,
    });
    image.src = src;
  });
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      resolve(typeof reader.result === "string" ? reader.result : "");
    });
    reader.addEventListener("error", () =>
      reject(reader.error ?? new Error("Avatar read failed.")),
    );
    reader.readAsDataURL(file);
  });
}

const AGENT_AVATAR_CACHE_PREFIX = "fased.agentAvatar.";

function agentAvatarCacheKey(agentId: string) {
  return `${AGENT_AVATAR_CACHE_PREFIX}${encodeURIComponent(agentId)}`;
}

function readCachedAgentAvatar(agentId: string): string {
  if (typeof window === "undefined") {
    return "";
  }
  try {
    return window.localStorage.getItem(agentAvatarCacheKey(agentId))?.trim() ?? "";
  } catch {
    return "";
  }
}

function writeCachedAgentAvatar(agentId: string, avatar: string) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    if (avatar.trim()) {
      window.localStorage.setItem(agentAvatarCacheKey(agentId), avatar.trim());
    } else {
      window.localStorage.removeItem(agentAvatarCacheKey(agentId));
    }
  } catch {
    // Avatar cache is best-effort; config save remains the source of truth.
  }
}

async function readOptimizedAvatarDataUrl(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) {
    return "";
  }
  if (file.type === "image/svg+xml") {
    return readFileAsDataUrl(file);
  }
  const sourceUrl = URL.createObjectURL(file);
  try {
    const image = await readImageElement(sourceUrl);
    const maxSize = 192;
    const scale = Math.min(1, maxSize / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) {
      return readFileAsDataUrl(file);
    }
    context.drawImage(image, 0, 0, width, height);
    const webp = canvas.toDataURL("image/webp", 0.86);
    if (webp.startsWith("data:image/webp")) {
      return webp;
    }
    return canvas.toDataURL("image/jpeg", 0.88);
  } catch {
    return readFileAsDataUrl(file);
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}

function renderAgentAvatarUpload(params: {
  agent: AgentsListResult["agents"][number];
  agentIdentity: AgentIdentityResult | null;
  identityAvatar: string;
  disabled: boolean;
  onAgentIdentityAvatarChange: (agentId: string, avatar: string | null) => void;
}) {
  const cachedAvatar = readCachedAgentAvatar(params.agent.id);
  const selectedAvatar =
    params.identityAvatar ||
    params.agent.identity?.avatar ||
    params.agentIdentity?.avatar ||
    cachedAvatar;
  const avatarAgent = {
    ...params.agent,
    identity: {
      ...params.agent.identity,
      avatar: selectedAvatar,
    },
  };
  const avatarIdentity = selectedAvatar
    ? {
        ...(params.agentIdentity ?? {
          agentId: params.agent.id,
          name: normalizeAgentLabel(params.agent),
          avatar: "",
        }),
        avatar: selectedAvatar,
      }
    : params.agentIdentity;
  const avatarUrl = resolveAgentAvatarUrl(avatarAgent, avatarIdentity);
  const emoji = resolveAgentEmoji(avatarAgent, avatarIdentity);
  const fallback = emoji || normalizeAgentLabel(params.agent).slice(0, 1).toUpperCase() || "A";
  return html`
    <label
      class="agent-profile-avatar ${params.disabled ? "agent-profile-avatar--disabled" : ""}"
      title="Upload avatar"
      aria-label="Upload avatar"
    >
      <input
        data-agent-identity-avatar-input="true"
        type="file"
        accept="image/*"
        ?disabled=${params.disabled}
        @change=${(event: Event) => {
          const input = event.currentTarget as HTMLInputElement;
          const file = input.files?.[0] ?? null;
          if (!file || !file.type.startsWith("image/")) {
            return;
          }
          void readOptimizedAvatarDataUrl(file).then((result) => {
            if (result) {
              writeCachedAgentAvatar(params.agent.id, result);
              params.onAgentIdentityAvatarChange(params.agent.id, result);
            }
            input.value = "";
          });
        }}
      />
      ${
        avatarUrl
          ? html`<img src=${avatarUrl} alt="" />`
          : html`<span aria-hidden="true">${fallback}</span>`
      }
    </label>
  `;
}

function readConfigPathValue(value: unknown, path: string[]): unknown {
  let current = value;
  for (const part of path) {
    if (!current || typeof current !== "object" || !(part in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function readConfigString(value: unknown, path: string[]): string {
  const result = readConfigPathValue(value, path);
  return typeof result === "string" ? result.trim() : "";
}

function readConfigBoolean(value: unknown, path: string[]): boolean {
  return readConfigPathValue(value, path) === true;
}

function hasConfigSecret(value: unknown, path: string[]): boolean {
  const result = readConfigPathValue(value, path);
  if (typeof result === "string") {
    return result.trim().length > 0;
  }
  if (!result || typeof result !== "object") {
    return false;
  }
  const record = result as Record<string, unknown>;
  return Boolean(
    (typeof record.value === "string" && record.value.trim()) ||
    (typeof record.secretRef === "string" && record.secretRef.trim()) ||
    (typeof record.env === "string" && record.env.trim()),
  );
}

function findReadySkill(skills: SkillStatusEntry[], candidates: string[]): SkillStatusEntry | null {
  const normalized = new Set(candidates.map((candidate) => candidate.trim().toLowerCase()));
  return (
    skills.find((skill) => {
      const names = [skill.name, skill.skillKey, skill.description]
        .map((entry) => entry?.trim().toLowerCase())
        .filter(Boolean);
      return names.some((name) => normalized.has(name)) && isSkillReady(skill);
    }) ?? null
  );
}

function summarizeServiceCards(params: {
  configForm: Record<string, unknown> | null;
  skills: SkillStatusEntry[];
  plugins: PluginsMarketplaceListResult | null;
}) {
  const config = params.configForm ?? {};
  const names: string[] = [];
  const add = (name: string, enabled: boolean) => {
    if (enabled && !names.includes(name)) {
      names.push(name);
    }
  };
  add(
    "Google Workspace",
    Boolean(
      readConfigString(config, ["hooks", "gmail", "account"]) ||
      readConfigString(config, ["hooks", "gmail", "topic"]) ||
      readConfigString(config, ["hooks", "gmail", "hookUrl"]) ||
      findReadySkill(params.skills, ["gog", "google workspace"]),
    ),
  );
  add(
    "GitHub",
    Boolean(
      hasConfigSecret(config, ["skills", "entries", "gh-issues", "apiKey"]) ||
      readConfigString(config, ["skills", "entries", "gh-issues", "env", "GH_TOKEN"]) ||
      findReadySkill(params.skills, ["github"]),
    ),
  );
  add("Web/search", readConfigBoolean(config, ["tools", "web", "search", "enabled"]));
  add("Web/fetch", readConfigBoolean(config, ["tools", "web", "fetch", "enabled"]));
  add(
    "Media",
    readConfigBoolean(config, ["browser", "enabled"]) ||
      readConfigBoolean(config, ["tools", "media", "image", "enabled"]) ||
      readConfigBoolean(config, ["tools", "media", "audio", "enabled"]) ||
      readConfigBoolean(config, ["tools", "media", "video", "enabled"]),
  );
  add(
    "Talk",
    Boolean(
      hasConfigSecret(config, ["talk", "apiKey"]) ||
      hasConfigSecret(config, ["talk", "providers", "openai", "apiKey"]) ||
      hasConfigSecret(config, ["talk", "providers", "elevenlabs", "apiKey"]),
    ),
  );
  for (const plugin of params.plugins?.plugins ?? []) {
    if (!plugin.enabled || !plugin.loaded || plugin.services.length === 0) {
      continue;
    }
    for (const service of plugin.services) {
      add(service, true);
    }
  }
  return {
    count: names.length,
    detail: names.length > 0 ? names.slice(0, 4).join(", ") : "No services connected.",
  };
}

function summarizeAgentToolCards(params: {
  agentId: string;
  configForm: Record<string, unknown> | null;
  toolsCatalog: {
    loading: boolean;
    error: string | null;
    result: ToolsCatalogResult | null;
  };
  toolsEffective: {
    loading: boolean;
    error: string | null;
    result: ToolsEffectiveResult | null;
    runtimeSessionMatchesSelectedAgent: boolean;
  };
}) {
  const config = resolveAgentConfig(params.configForm, params.agentId);
  const agentTools = config.entry?.tools ?? {};
  const globalTools = config.globalTools ?? {};
  const profile = agentTools.profile ?? globalTools.profile ?? "full";
  const hasAgentAllow = Array.isArray(agentTools.allow) && agentTools.allow.length > 0;
  const alsoAllow =
    !hasAgentAllow && Array.isArray(agentTools.alsoAllow) ? agentTools.alsoAllow : [];
  const deny = !hasAgentAllow && Array.isArray(agentTools.deny) ? agentTools.deny : [];
  const policy = hasAgentAllow
    ? { allow: agentTools.allow ?? [], deny: agentTools.deny ?? [] }
    : (resolveToolProfile(profile) ?? undefined);
  const tools =
    params.toolsCatalog.result?.groups
      .flatMap((group) => group.tools)
      .filter((tool) => isVisibleAgentToolId(tool.id)) ?? [];
  const allowedCount = tools.filter(
    (tool) =>
      (isAllowedByPolicy(normalizeToolName(tool.id), policy) || matchesList(tool.id, alsoAllow)) &&
      !matchesList(tool.id, deny),
  ).length;
  const availableNow = params.toolsEffective.result?.groups.reduce(
    (sum, group) => sum + group.tools.length,
    0,
  );
  const runtimeKnown =
    params.toolsEffective.runtimeSessionMatchesSelectedAgent &&
    !params.toolsEffective.loading &&
    !params.toolsEffective.error &&
    typeof availableNow === "number";
  const tone: CardTone =
    params.toolsCatalog.error || params.toolsEffective.error
      ? "danger"
      : runtimeKnown
        ? "ok"
        : "warn";

  return {
    allowedCount,
    totalCount: tools.length,
    availableNow,
    tone,
    detail: runtimeKnown
      ? `${availableNow} available now`
      : tools.length > 0
        ? "Policy saved; open live chat to verify runtime."
        : params.toolsCatalog.loading
          ? "Tool catalog loading."
          : "Open Tools to load runtime catalog.",
  };
}

function summarizeExtensionCards(plugins: PluginsMarketplaceListResult | null) {
  const diagnostics = plugins?.diagnostics ?? [];
  const warningCount = diagnostics.filter((entry) => entry.level === "warn").length;
  const errorCount = diagnostics.filter((entry) => entry.level === "error").length;
  const activeCount = plugins?.plugins.filter((entry) => entry.loaded || entry.enabled).length ?? 0;
  const restartPending =
    plugins?.plugins.filter((entry) => entry.managed && entry.enabled && !entry.loaded).length ?? 0;
  const tone: CardTone =
    errorCount > 0 ? "danger" : warningCount > 0 || restartPending > 0 ? "warn" : "ok";
  const detail =
    errorCount > 0
      ? `${errorCount} error${errorCount === 1 ? "" : "s"}`
      : warningCount > 0
        ? `${warningCount} warning${warningCount === 1 ? "" : "s"}`
        : restartPending > 0
          ? `${restartPending} restart pending`
          : "Runtime ok";

  return {
    activeCount,
    detail,
    tone,
  };
}

function renderChecklistAction(actions: unknown) {
  const entries = Array.isArray(actions) ? actions.filter(Boolean) : actions ? [actions] : [];
  if (entries.length === 0) {
    return nothing;
  }
  return html`<div class="agent-checklist-row__actions">${entries}</div>`;
}

function renderChecklistRow(params: {
  step: string;
  label: string;
  value?: unknown;
  detail: unknown;
  tone?: CardTone;
  valueTone?: CardTone | "plain";
  actions?: unknown;
}) {
  const valueTone = params.valueTone === "plain" ? undefined : (params.valueTone ?? params.tone);
  return html`
    <div class="agent-checklist-row ${params.tone ?? "default"}">
      <div class="agent-checklist-row__step mono">${params.step}</div>
      <div class="agent-checklist-row__body">
        <div class="agent-checklist-row__head">
          <span class="agent-checklist-row__label">${params.label}</span>
          ${
            params.value
              ? html`
                  <span class="agent-checklist-row__value${cardToneClass(valueTone)}">
                    ${params.value}
                  </span>
                `
              : nothing
          }
        </div>
        <div class="agent-checklist-row__detail">${params.detail}</div>
      </div>
      ${renderChecklistAction(params.actions)}
    </div>
  `;
}

function channelSummary(channels: ChannelsState) {
  if (!channels.snapshot) {
    return {
      detail: "Channel status has not loaded yet.",
      tone: "default" as const,
    };
  }
  const activeChannelIds = new Set<string>();
  for (const [channelId, channelAccounts] of Object.entries(
    channels.snapshot.channelAccounts ?? {},
  )) {
    if (
      channelAccounts.some(
        (entry) => entry.enabled || entry.configured || entry.running || entry.connected,
      )
    ) {
      activeChannelIds.add(channelId);
    }
  }
  for (const [channelId, status] of Object.entries(channels.snapshot.channels ?? {})) {
    if (
      status &&
      typeof status === "object" &&
      ((status as { configured?: unknown }).configured === true ||
        (status as { running?: unknown }).running === true ||
        (status as { connected?: unknown }).connected === true)
    ) {
      activeChannelIds.add(channelId);
    }
  }
  const labels = [...activeChannelIds]
    .map((channelId) => {
      const meta = channels.snapshot?.channelMeta?.find((entry) => entry.id === channelId);
      return meta?.label ?? channels.snapshot?.channelLabels?.[channelId] ?? channelId;
    })
    .filter(Boolean);
  return {
    detail: labels.length > 0 ? labels.join(", ") : "No active channels yet.",
    tone: labels.length > 0 ? ("ok" as const) : ("default" as const),
  };
}

function cronSummary(cron: CronState, agentId: string) {
  const jobs = cron.jobs.filter((job) => job.agentId === agentId);
  if (cron.loading && jobs.length === 0) {
    return { value: "Loading", detail: "Reading scheduled work.", tone: "default" as const };
  }
  const enabled = jobs.filter((job) => job.enabled).length;
  return {
    value: `${jobs.length} scheduled`,
    detail: `${enabled} enabled · triggers, workflows, and activity stay on Tasks.`,
    tone: enabled > 0 ? ("ok" as const) : ("default" as const),
  };
}

function memorySummary(memory: MemoryState) {
  if (!memory.inventory && !memory.validation) {
    return {
      value: "Not loaded",
      detail: "Memory inventory has not loaded yet.",
      tone: "default" as const,
    };
  }
  const errors = memory.validation?.summary.errors ?? 0;
  const warnings = memory.validation?.summary.warnings ?? 0;
  const archive = memory.inventory?.sessionMemory?.enabled ? "archive on" : "archive off";
  return {
    value: errors > 0 ? `${errors} errors` : warnings > 0 ? `${warnings} warnings` : "OK",
    detail: `${archive} · search backend ${memory.inventory?.backend?.active ?? memory.inventory?.backend?.configured ?? "unknown"}`,
    tone: errors > 0 ? ("danger" as const) : warnings > 0 ? ("warn" as const) : ("ok" as const),
  };
}

function providerAuthSummary(authStatus: ModelsAuthStatusResult | null) {
  if (!authStatus) {
    return {
      value: "Not loaded",
      detail: "Auth profile state has not loaded yet.",
      tone: "default" as const,
    };
  }
  const readyBrands = new Set(
    authStatus.providers
      .filter((provider) => provider.status === "ok" || provider.status === "static")
      .map((provider) => providerBrandId(provider.provider)),
  );
  const missingBrands = new Set(
    authStatus.providers
      .filter((provider) => provider.status === "missing" || provider.effective.kind === "missing")
      .map((provider) => providerBrandId(provider.provider)),
  );
  for (const ready of readyBrands) {
    missingBrands.delete(ready);
  }
  const readyNames = [...readyBrands].map((provider) => providerLabel(provider));
  const readyLabel = readyNames.length > 0 ? readyNames.join(", ") : "No providers";
  return {
    value: readyLabel,
    detail:
      missingBrands.size > 0 ? `${missingBrands.size} missing credentials` : "credentials ready",
    tone: missingBrands.size > 0 ? ("warn" as const) : ("ok" as const),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function channelLabel(snapshot: ChannelsStatusSnapshot | null, channelId: string): string {
  const meta = snapshot?.channelMeta?.find((entry) => entry.id === channelId);
  return meta?.label ?? snapshot?.channelLabels?.[channelId] ?? channelId;
}

function channelAccountLabel(
  snapshot: ChannelsStatusSnapshot | null,
  channelId: string,
  accountId: string | null,
): { label: string; detail: string } {
  if (!accountId) {
    return { label: "Default route", detail: "channel default" };
  }
  const accounts = snapshot?.channelAccounts?.[channelId] ?? [];
  const account = accounts.find((entry) => entry.accountId === accountId);
  return {
    label: account?.name?.trim() || accountId,
    detail: accountId,
  };
}

function formatPeerDetail(match: Record<string, unknown>): string | null {
  const parts: string[] = [];
  const peer = match.peer;
  if (isRecord(peer) && typeof peer.kind === "string" && typeof peer.id === "string") {
    parts.push(`${peer.kind} ${peer.id}`);
  }
  if (typeof match.guildId === "string" && match.guildId.trim()) {
    parts.push(`guild ${match.guildId}`);
  }
  if (typeof match.teamId === "string" && match.teamId.trim()) {
    parts.push(`team ${match.teamId}`);
  }
  if (Array.isArray(match.roles) && match.roles.length > 0) {
    parts.push(`${match.roles.length} role${match.roles.length === 1 ? "" : "s"}`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

function resolveAgentChannelRoutes(params: {
  agentId: string;
  configForm: Record<string, unknown> | null;
  snapshot: ChannelsStatusSnapshot | null;
}): Array<{ title: string; detail: string; channelLabel: string }> {
  const bindings = params.configForm?.bindings;
  if (!Array.isArray(bindings)) {
    return [];
  }
  return bindings.flatMap((binding) => {
    if (!isRecord(binding) || binding.agentId !== params.agentId || !isRecord(binding.match)) {
      return [];
    }
    const channelId = binding.match.channel;
    if (typeof channelId !== "string" || !channelId.trim()) {
      return [];
    }
    const accountId =
      typeof binding.match.accountId === "string" && binding.match.accountId.trim()
        ? binding.match.accountId
        : null;
    const account = channelAccountLabel(params.snapshot, channelId, accountId);
    const channel = channelLabel(params.snapshot, channelId);
    const peer = formatPeerDetail(binding.match);
    return [
      {
        channelLabel: channel,
        title: `${channel} · ${account.label}`,
        detail: [account.detail, peer].filter(Boolean).join(" · "),
      },
    ];
  });
}

function _renderAgentRouteSummary(params: {
  agentId: string;
  configForm: Record<string, unknown> | null;
  channels: ChannelsState;
  cron: CronState;
  onSelectPanel: (panel: AgentsPanel) => void;
}) {
  const channelRoutes = resolveAgentChannelRoutes({
    agentId: params.agentId,
    configForm: params.configForm,
    snapshot: params.channels.snapshot,
  });
  const jobs = params.cron.jobs.filter((job) => job.agentId === params.agentId);
  const visibleRoutes = channelRoutes.slice(0, 5);
  const visibleJobs = jobs.slice(0, 5);

  return html`
    <div class="agent-routes">
      <div class="agent-setup-section__head">
        <div>
          <div class="agent-setup-section__title">Agent routes</div>
          <div class="agent-setup-section__sub">
            This Agent receives app messages and scheduled work through these bindings.
          </div>
        </div>
      </div>
      <div class="agent-route-grid">
        <div class="agent-route-column">
          <div class="agent-route-column__head">
            <span>Inbound channel routes</span>
            <button
              type="button"
              class="agent-workbench-card__action"
              @click=${() => params.onSelectPanel("channels")}
            >
              Connect app
            </button>
          </div>
          ${
            visibleRoutes.length === 0
              ? html`
                  <div class="agent-setup-empty">No app routes target this agent yet.</div>
                `
              : html`
                  <div class="agent-route-list">
                    ${visibleRoutes.map(
                      (route) => html`
                        <div class="agent-route-item">
                          <div class="agent-route-item__title">${route.title}</div>
                          <div class="agent-route-item__detail">${route.detail}</div>
                        </div>
                      `,
                    )}
                  </div>
                  ${
                    channelRoutes.length > visibleRoutes.length
                      ? html`
                          <div class="agent-route-more">
                            +${channelRoutes.length - visibleRoutes.length} more routes
                          </div>
                        `
                      : nothing
                  }
                `
          }
        </div>
        <div class="agent-route-column">
          <div class="agent-route-column__head">
            <span>Scheduled work for this Agent</span>
            <button
              type="button"
              class="agent-workbench-card__action"
              @click=${() => params.onSelectPanel("cron")}
            >
              Create task
            </button>
          </div>
          <div class="agent-route-column__sub">
            Task bindings run recurring work as this Agent.
          </div>
          ${
            visibleJobs.length === 0
              ? html`
                  <div class="agent-setup-empty">No scheduled tasks target this Agent yet.</div>
                `
              : html`
                  <div class="agent-route-list">
                    ${visibleJobs.map((job) => renderCronBindingItem(job))}
                  </div>
                  ${
                    jobs.length > visibleJobs.length
                      ? html`
                          <div class="agent-route-more">
                            +${jobs.length - visibleJobs.length} more tasks
                          </div>
                        `
                      : nothing
                  }
                `
          }
        </div>
      </div>
    </div>
  `;
}

function renderCronBindingItem(job: CronJob) {
  return html`
    <div class="agent-route-item">
      <div class="agent-route-item__title">${job.name}</div>
      <div class="agent-route-item__detail">
        ${job.enabled ? "enabled" : "disabled"} · scheduled as ${job.agentId ?? "default"} · ${job.description ?? job.id}
      </div>
    </div>
  `;
}

function _selectSkillFixActions(skills: SkillStatusEntry[]): SkillFixAction[] {
  const actions: SkillFixAction[] = [];
  for (const skill of skills) {
    const readiness = getSkillReadiness(skill);
    if (skill.blockedByAllowlist) {
      actions.push({
        kind: "enable-agent",
        skill,
        detail: `${readiness.label}: ${readiness.detail}`,
      });
      continue;
    }
    switch (readiness.kind) {
      case "ready":
        break;
      case "disabled":
        actions.push({
          kind: "enable-global",
          skill,
          detail: `${readiness.label}: ${readiness.detail}`,
        });
        break;
      case "needs-api-key":
        actions.push({
          kind: "save-api",
          skill,
          detail: `${readiness.label}: ${readiness.detail}`,
        });
        break;
      case "needs-dependency":
        if (skill.install[0]?.id) {
          actions.push({
            kind: "install",
            skill,
            detail: `${readiness.label}: ${readiness.detail}`,
            installId: skill.install[0].id,
            label: skill.install[0].label,
          });
        } else {
          actions.push({
            kind: "open-skills",
            skill,
            detail: `${readiness.label}: ${readiness.detail}`,
          });
        }
        break;
      case "needs-config":
        actions.push({
          kind: "open-skills",
          skill,
          detail: `${readiness.label}: ${readiness.detail}`,
        });
        break;
      case "unsupported-os":
        actions.push({
          kind: "open-skills",
          skill,
          detail: `${readiness.label}: ${readiness.detail}`,
        });
        break;
    }
  }
  return actions.slice(0, 5);
}

function findSkill(
  skills: SkillStatusEntry[],
  candidates: readonly string[],
): SkillStatusEntry | null {
  const normalized = new Set(candidates.map((candidate) => candidate.toLowerCase()));
  return (
    skills.find((skill) => {
      const keys = [skill.skillKey, skill.name].map((value) => value.toLowerCase());
      return keys.some((key) => normalized.has(key));
    }) ?? null
  );
}

function isSkillAttached(skill: SkillStatusEntry, allowlist: string[] | null) {
  if (!allowlist) {
    return true;
  }
  const allowed = new Set(allowlist.map((name) => name.trim()).filter(Boolean));
  return allowed.has(skill.name) || allowed.has(skill.skillKey);
}

function _renderServiceAttachmentList(params: {
  agentId: string;
  basePath: string;
  configEditable: boolean;
  configForm: Record<string, unknown> | null;
  skillAllowlist: string[] | null;
  skillsLoadedForAgent: boolean;
  skills: SkillStatusEntry[];
  onNavigate: (tab: Tab) => void;
  onAgentSkillToggle: (agentId: string, skillName: string, enabled: boolean) => void;
  onToolsOverridesChange: (agentId: string, alsoAllow: string[], deny: string[]) => void;
}) {
  const config = resolveAgentConfig(params.configForm, params.agentId);
  const agentTools = config.entry?.tools ?? {};
  const globalTools = config.globalTools ?? {};
  const profile = agentTools.profile ?? globalTools.profile ?? "full";
  const hasAgentAllow = Array.isArray(agentTools.allow) && agentTools.allow.length > 0;
  const alsoAllow =
    !hasAgentAllow && Array.isArray(agentTools.alsoAllow) ? agentTools.alsoAllow : [];
  const deny = !hasAgentAllow && Array.isArray(agentTools.deny) ? agentTools.deny : [];
  const basePolicy = hasAgentAllow
    ? { allow: agentTools.allow ?? [], deny: agentTools.deny ?? [] }
    : (resolveToolProfile(profile) ?? undefined);
  const resolveAllowed = (toolId: string) => {
    const baseAllowed = isAllowedByPolicy(toolId, basePolicy);
    const extraAllowed = matchesList(toolId, alsoAllow);
    const denied = matchesList(toolId, deny);
    return {
      allowed: (baseAllowed || extraAllowed) && !denied,
      baseAllowed,
    };
  };
  const enableTools = (toolIds: readonly string[]) => {
    const nextAllow = new Set(
      alsoAllow.map((entry) => normalizeToolName(entry)).filter((entry) => entry.length > 0),
    );
    const nextDeny = new Set(
      deny.map((entry) => normalizeToolName(entry)).filter((entry) => entry.length > 0),
    );
    for (const toolId of toolIds) {
      const normalized = normalizeToolName(toolId);
      if (!normalized) {
        continue;
      }
      nextDeny.delete(normalized);
      if (!resolveAllowed(toolId).baseAllowed) {
        nextAllow.add(normalized);
      }
    }
    params.onToolsOverridesChange(params.agentId, [...nextAllow], [...nextDeny]);
  };

  return html`
    <div class="agent-setup-section" id="agent-service-attach">
      <div class="agent-setup-section__head">
        <div>
          <div class="agent-setup-section__title">Service tool grants</div>
          <div class="agent-setup-section__sub">
            Connect credentials in Services or the Skill Library, then grant this Agent tool access here.
          </div>
        </div>
        ${renderWorkbenchLink({
          basePath: params.basePath,
          tab: "services",
          label: "Services",
          onNavigate: params.onNavigate,
        })}
      </div>
      <div class="agent-setup-list">
        ${SERVICE_SKILL_ATTACHMENTS.map((item) => {
          const skill = findSkill(params.skills, item.candidates);
          const attached = skill ? isSkillAttached(skill, params.skillAllowlist) : false;
          const disabled =
            !params.configEditable || !params.skillsLoadedForAgent || !skill || attached;
          return html`
            <div class="agent-setup-row">
              <div class="agent-setup-row__main">
                <div class="agent-setup-row__title">${item.title}</div>
                <div class="agent-setup-row__detail">
                  ${
                    !params.skillsLoadedForAgent
                      ? "Skill readiness has not loaded yet."
                      : skill
                        ? attached
                          ? `${item.label} granted. ${item.detail}`
                          : `${item.label} ready to grant. ${item.detail}`
                        : `${item.label} skill is not visible yet. Install or enable it in Skills.`
                  }
                </div>
              </div>
              <div class="agent-setup-row__actions">
                <button
                  type="button"
                  class="btn btn--sm"
                  ?disabled=${disabled}
                  @click=${() => skill && params.onAgentSkillToggle(params.agentId, skill.name, true)}
                >
                  ${attached ? "Granted" : `Grant ${item.label}`}
                </button>
              </div>
            </div>
          `;
        })}
        ${SERVICE_TOOL_GROUPS.map((group) => {
          const enabled = group.tools.every((toolId) => resolveAllowed(toolId).allowed);
          return html`
            <div class="agent-setup-row">
              <div class="agent-setup-row__main">
                <div class="agent-setup-row__title">${group.title}</div>
                <div class="agent-setup-row__detail">
                  ${
                    hasAgentAllow
                      ? "This agent uses an explicit tools.allow list. Open Tools to edit it."
                      : enabled
                        ? `${group.label} tools enabled. ${group.detail}`
                        : `${group.label} tools can be enabled through safe per-agent overrides. ${group.detail}`
                  }
                </div>
              </div>
              <div class="agent-setup-row__actions">
                <button
                  type="button"
                  class="btn btn--sm"
                  ?disabled=${!params.configEditable || hasAgentAllow || enabled}
                  @click=${() => enableTools(group.tools)}
                >
                  ${enabled ? "Enabled" : group.action}
                </button>
              </div>
            </div>
          `;
        })}
      </div>
    </div>
  `;
}

function _renderFirstRunChecklist(params: {
  basePath: string;
  agentLabel: string;
  workspace: string;
  isDefault: boolean;
  effectivePrimary: string | null;
  fallbackCount: number;
  providerCount: string;
  providerAuth: ReturnType<typeof providerAuthSummary>;
  providerDetail: string;
  memory: ReturnType<typeof memorySummary>;
  channels: ReturnType<typeof channelSummary>;
  cron: ReturnType<typeof cronSummary>;
  walletCount: number;
  walletDetail: string;
  skillsLoadedForAgent: boolean;
  readySkills: number;
  needsSetupSkills: number;
  skills: SkillStatusEntry[];
  sessionMemoryEnabled: boolean | null;
  configEditable: boolean;
  onNavigate: (tab: Tab) => void;
  onSelectPanel: (panel: AgentsPanel) => void;
  onSessionMemoryEnabledChange: (enabled: boolean) => void;
}) {
  const readinessSummary = summarizeSkillReadiness(params.skills);
  const skillActions =
    params.skillsLoadedForAgent && params.needsSetupSkills > 0
      ? [
          readinessSummary.needsApiKey > 0
            ? renderWorkbenchPanelAction({
                panel: "skills",
                label: "Add API key",
                onSelectPanel: params.onSelectPanel,
              })
            : nothing,
          readinessSummary.needsDependency > 0
            ? renderWorkbenchPanelAction({
                panel: "skills",
                label: "Install dependency",
                onSelectPanel: params.onSelectPanel,
              })
            : nothing,
          readinessSummary.needsConfig > 0
            ? renderWorkbenchPanelAction({
                panel: "skills",
                label: "Configure skills",
                onSelectPanel: params.onSelectPanel,
              })
            : nothing,
          readinessSummary.disabled > 0
            ? renderWorkbenchPanelAction({
                panel: "skills",
                label: "Show in library",
                onSelectPanel: params.onSelectPanel,
              })
            : nothing,
        ]
      : renderWorkbenchPanelAction({
          panel: "skills",
          label: "Review skills",
          onSelectPanel: params.onSelectPanel,
        });
  const memoryEnabled = params.sessionMemoryEnabled === true;
  const walletValue = params.walletCount > 0 ? `${params.walletCount} wallets` : "Not loaded";

  return html`
    <div class="agent-first-run">
      <div class="agent-checklist" aria-label="Agent first-run checklist">
        ${renderChecklistRow({
          step: "01",
          label: "Agent",
          value: params.agentLabel,
          detail: `Workspace: ${params.workspace}`,
          tone: "ok",
        })}
        ${renderChecklistRow({
          step: "02",
          label: "Provider / Model",
          detail: `${params.providerAuth.value} · ${params.providerDetail}`,
          tone: params.effectivePrimary && params.providerAuth.tone === "ok" ? "ok" : "warn",
          valueTone: "plain",
          actions: [
            renderAgentModelDropdownAction({
              label: "Models",
              icon: icons.plus,
              variant: "primary",
            }),
            renderWorkbenchPanelAction({
              panel: "providers",
              label: "Providers",
              icon: icons.plus,
              variant: "neutral",
              onSelectPanel: params.onSelectPanel,
            }),
          ],
        })}
        ${renderChecklistRow({
          step: "03",
          label: "Channels",
          detail: params.channels.detail,
          tone: params.channels.tone,
          actions: renderWorkbenchPanelAction({
            panel: "channels",
            label: "Channel",
            icon: icons.plus,
            onSelectPanel: params.onSelectPanel,
          }),
        })}
        ${renderChecklistRow({
          step: "04",
          label: "Memory",
          value: params.memory.value,
          detail: params.memory.detail,
          tone: params.memory.tone,
          actions: html`
            <button
              type="button"
              class="agent-workbench-card__action"
              ?disabled=${!params.configEditable}
              @click=${() => params.onSessionMemoryEnabledChange(!memoryEnabled)}
            >
              ${memoryEnabled ? "Disable memory archive" : "Enable memory archive"}
            </button>
          `,
        })}
        ${renderChecklistRow({
          step: "05",
          label: "Skills",
          value: params.skillsLoadedForAgent ? `${params.readySkills} ready` : "Not loaded",
          detail: params.skillsLoadedForAgent
            ? `${params.needsSetupSkills} setup · ${readinessSummary.bundled} bundled · ${params.skills.length} visible.`
            : "Load skills to see API key, binary, config, and OS blockers.",
          tone:
            params.needsSetupSkills > 0 ? "warn" : params.skillsLoadedForAgent ? "ok" : "default",
          actions: skillActions,
        })}
        ${renderChecklistRow({
          step: "06",
          label: "Services",
          value: "Connectors",
          detail:
            "Gmail, calendars, GitHub, web/search, media, and custom APIs are services this agent can use.",
          tone: "default",
          actions: [
            renderWorkbenchLink({
              basePath: params.basePath,
              tab: "services",
              label: "Connect services",
              onNavigate: params.onNavigate,
            }),
            renderWorkbenchAnchor({ href: "#agent-service-attach", label: "Grant tool access" }),
          ],
        })}
        ${renderChecklistRow({
          step: "07",
          label: "Wallet",
          value: walletValue,
          detail: `${params.walletDetail} · Policy-bound actions, not required for chat.`,
          tone: params.walletCount > 0 ? "ok" : "default",
          actions: renderWorkbenchLink({
            basePath: params.basePath,
            tab: "wallet",
            label: "Wallet policy",
            onNavigate: params.onNavigate,
          }),
        })}
        ${renderChecklistRow({
          step: "08",
          label: "Tasks",
          value: params.cron.value,
          detail: `${params.cron.detail} Use this for scheduled work after the Agent is ready.`,
          tone: params.cron.tone,
          actions: renderWorkbenchPanelAction({
            panel: "cron",
            label: "Create task",
            onSelectPanel: params.onSelectPanel,
          }),
        })}
      </div>
    </div>
  `;
}

function _renderSkillFixActions(params: {
  agentId: string;
  actions: SkillFixAction[];
  skillEdits: Record<string, string>;
  skillsBusyKey: string | null;
  configEditable: boolean;
  onSelectPanel: (panel: AgentsPanel) => void;
  onAgentSkillToggle: (agentId: string, skillName: string, enabled: boolean) => void;
  onSkillEdit: (skillKey: string, value: string) => void;
  onSkillSaveKey: (skillKey: string) => void;
  onSkillInstall: (skillKey: string, name: string, installId: string) => void;
  onSkillEnabledChange: (skillKey: string, enabled: boolean) => void;
}) {
  return html`
    <div class="agent-setup-section">
      <div class="agent-setup-section__head">
        <div>
          <div class="agent-setup-section__title">Fix skill setup</div>
          <div class="agent-setup-section__sub">Resolve the first visible blockers for this agent.</div>
        </div>
        <button
          type="button"
          class="btn btn--sm"
          @click=${() => params.onSelectPanel("skills")}
        >
          All skills
        </button>
      </div>
      ${
        params.actions.length === 0
          ? html`
              <div class="agent-setup-empty">No actionable skill blockers are visible.</div>
            `
          : html`
              <div class="agent-setup-list">
                ${params.actions.map((action) => {
                  const skill = action.skill;
                  const busy = params.skillsBusyKey === skill.skillKey;
                  return html`
                    <div class="agent-setup-row">
                      <div class="agent-setup-row__main">
                        <div class="agent-setup-row__title">
                          ${skill.name}
                        </div>
                        <div class="agent-setup-row__detail">${action.detail}</div>
                      </div>
                      <div class="agent-setup-row__actions">
                        ${
                          action.kind === "enable-global"
                            ? html`
                                <button
                                  type="button"
                                  class="btn btn--sm"
                                  ?disabled=${busy}
                                  @click=${() => params.onSkillEnabledChange(skill.skillKey, true)}
                                >
                                  ${busy ? "Saving..." : "Show in library"}
                                </button>
                              `
                            : action.kind === "enable-agent"
                              ? html`
                                  <button
                                    type="button"
                                    class="btn btn--sm"
                                    ?disabled=${!params.configEditable}
                                    @click=${() =>
                                      params.onAgentSkillToggle(params.agentId, skill.name, true)}
                                  >
                                    Allow on Agent
                                  </button>
                                `
                              : action.kind === "save-api"
                                ? html`
                                    <input
                                      class="agent-setup-secret"
                                      type="password"
                                      .value=${params.skillEdits[skill.skillKey] ?? ""}
                                      placeholder=${skill.primaryEnv ?? "API key"}
                                      @input=${(event: Event) =>
                                        params.onSkillEdit(
                                          skill.skillKey,
                                          (event.target as HTMLInputElement).value,
                                        )}
                                    />
                                    <button
                                      type="button"
                                      class="btn btn--sm primary"
                                  ?disabled=${busy}
                                  @click=${() => params.onSkillSaveKey(skill.skillKey)}
                                >
                                      ${busy ? "Saving..." : "Add API key"}
                                    </button>
                                  `
                                : action.kind === "install"
                                  ? html`
                                      <button
                                        type="button"
                                        class="btn btn--sm"
                                        ?disabled=${busy}
                                        @click=${() =>
                                          params.onSkillInstall(
                                            skill.skillKey,
                                            skill.name,
                                            action.installId,
                                          )}
                                      >
                                        ${busy ? "Installing..." : action.label}
                                      </button>
                                    `
                                  : html`
                                      <button
                                        type="button"
                                        class="btn btn--sm"
                                        @click=${() => params.onSelectPanel("skills")}
                                      >
                                        Configure
                                      </button>
                                    `
                        }
                      </div>
                    </div>
                  `;
                })}
              </div>
            `
      }
    </div>
  `;
}

function _renderPluginSetupCta(params: {
  pluginCount: number | null;
  pluginErrors: number;
  basePath: string;
  onNavigate: (tab: Tab) => void;
}) {
  return html`
    <div class="agent-setup-section">
      <div class="agent-setup-section__head">
        <div>
          <div class="agent-setup-section__title">Extension config</div>
          <div class="agent-setup-section__sub">
            ${
              params.pluginCount == null
                ? "Plugin runtime status has not loaded yet."
                : `${params.pluginCount} extensions · Advanced warnings stay in Extensions.`
            }
          </div>
        </div>
        ${renderWorkbenchLink({
          basePath: params.basePath,
          tab: "plugins",
          label: params.pluginErrors > 0 ? "Review warnings" : "Configure extensions",
          onNavigate: params.onNavigate,
        })}
      </div>
    </div>
  `;
}

export function renderAgentOverview(params: {
  surface?: "overview" | "providers" | "model-dialog";
  agent: AgentsListResult["agents"][number];
  basePath: string;
  defaultId: string | null;
  configForm: Record<string, unknown> | null;
  agentFilesList: AgentsFilesListResult | null;
  agentIdentity: AgentIdentityResult | null;
  agentIdentityLoading: boolean;
  agentIdentityError: string | null;
  configLoading: boolean;
  configSaving: boolean;
  configDirty: boolean;
  channels: ChannelsState;
  sessions: SessionsState;
  cron: CronState;
  webhookTriggers?: {
    result: WebhookTriggersResult | null;
  };
  taskLedger?: {
    result: TaskListResult | null;
  };
  taskWorkflow?: {
    definitions: SavedTaskWorkflowDefinitionsResult | null;
  };
  taskStandingOrders?: {
    result: import("../types.ts").StandingOrdersResult | null;
  };
  agentSkills: {
    report: SkillStatusReport | null;
    loading: boolean;
    error: string | null;
    agentId: string | null;
    filter: string;
  };
  memory: MemoryState;
  providers: {
    catalogStatus: ModelsCatalogStatusResult | null;
    authStatus: ModelsAuthStatusResult | null;
  };
  usage?: {
    result: SessionsUsageResult | null;
    loading: boolean;
    error: string | null;
  };
  toolsCatalog: {
    loading: boolean;
    error: string | null;
    result: ToolsCatalogResult | null;
  };
  toolsEffective: {
    loading: boolean;
    error: string | null;
    result: ToolsEffectiveResult | null;
    runtimeSessionMatchesSelectedAgent: boolean;
  };
  plugins: {
    marketplace: PluginsMarketplaceListResult | null;
  };
  wallet: {
    status: WalletStatus | null;
    namedWallets: WalletNamedWallet[];
    defaultWalletId: string | null;
  };
  mining: {
    attachedWalletId: string | null;
    profile: SatMinerProfile | null;
    readiness: SatMiningReadiness | null;
    status: SatMiningRuntimeStatus | null;
  };
  federation: {
    token: FederationToken | null;
    status: FederationStatus | null;
  };
  modelCatalog: ModelCatalogEntry[];
  skillEdits: Record<string, string>;
  skillsBusyKey: string | null;
  onConfigReload: () => void;
  onConfigSave: () => void;
  onModelChange: (agentId: string, modelId: string | null) => void;
  onModelFallbacksChange: (agentId: string, fallbacks: string[]) => void;
  onTaskModelsChange: (agentId: string, taskModels: AgentTaskModelSlots) => void;
  onAgentIdentityAvatarChange: (agentId: string, avatar: string | null) => void;
  onActiveModelProviderChange: (agentId: string, providerId: string | null) => void;
  onModelProviderChange: (
    agentId: string,
    providerId: string,
    providerConfig: AgentModelProviderSettings | null,
  ) => void;
  onSelectPanel: (panel: AgentsPanel) => void;
  onNavigate: (tab: Tab) => void;
  onOpenUsageForAgent?: (agentId: string) => void;
  onAgentSkillToggle: (agentId: string, skillName: string, enabled: boolean) => void;
  onToolsOverridesChange: (agentId: string, alsoAllow: string[], deny: string[]) => void;
  onSkillEdit: (skillKey: string, value: string) => void;
  onSkillSaveKey: (skillKey: string) => void;
  onSkillInstall: (skillKey: string, name: string, installId: string) => void;
  onSkillEnabledChange: (skillKey: string, enabled: boolean) => void;
  onSessionMemoryEnabledChange: (enabled: boolean) => void;
}) {
  const {
    agent,
    configForm,
    agentFilesList,
    configLoading,
    configSaving,
    configDirty,
    onModelChange,
  } = params;
  const config = resolveAgentConfig(configForm, agent.id);
  const agentModel = agent.model;
  const workspaceFromFiles =
    agentFilesList && agentFilesList.agentId === agent.id ? agentFilesList.workspace : null;
  const workspace =
    workspaceFromFiles ||
    config.entry?.workspace ||
    config.defaults?.workspace ||
    agent.workspace ||
    "default";
  const defaultModel = resolveModelLabel(config.defaults?.model ?? agentModel);
  const entryModelProviders = resolveAgentModelProviders(config.entry?.modelProviders);
  const configuredActiveProvider =
    normalizeModelProviderId(config.entry?.activeModelProvider) ??
    normalizeModelProviderId(modelProviderFromValue(resolveModelPrimary(config.entry?.model))) ??
    Object.keys(entryModelProviders)[0] ??
    "";
  const activeProviderConfig = configuredActiveProvider
    ? (entryModelProviders[configuredActiveProvider] ?? {})
    : {};
  const legacyEntryPrimary = resolveModelPrimary(config.entry?.model);
  const legacyEntryTaskModels = resolveTaskModelSlots(config.entry?.taskModels) ?? {};
  const entryPrimary = legacyEntryPrimary ?? activeProviderConfig.primary;
  const defaultPrimary =
    resolveModelPrimary(config.defaults?.model) ||
    (defaultModel !== "-" ? normalizeModelValue(defaultModel) : null) ||
    (configForm ? null : resolveModelPrimary(agentModel));
  const effectivePrimary = entryPrimary ?? defaultPrimary ?? null;
  const providerFallbacks = Array.from(
    new Set(
      Object.values(entryModelProviders)
        .flatMap((providerConfig) => providerConfig.fallbacks ?? [])
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  );
  const modelFallbacks =
    resolveModelFallbacks(config.entry?.model) ??
    (providerFallbacks.length > 0 ? providerFallbacks : null) ??
    resolveModelFallbacks(config.defaults?.model) ??
    (configForm ? null : resolveModelFallbacks(agentModel));
  const fallbackChips = modelFallbacks ?? [];
  const defaultTaskModels = resolveTaskModelSlots(config.defaults?.taskModels) ?? {};
  const providerTaskModels: AgentTaskModelSlots = {};
  for (const [providerId, providerConfig] of Object.entries(entryModelProviders)) {
    if (providerId !== configuredActiveProvider) {
      Object.assign(providerTaskModels, resolveTaskModelSlots(providerConfig.taskModels) ?? {});
    }
  }
  Object.assign(providerTaskModels, resolveTaskModelSlots(activeProviderConfig.taskModels) ?? {});
  const entryTaskModels: AgentTaskModelSlots = {
    ...providerTaskModels,
    ...legacyEntryTaskModels,
  };
  const scheduleModelConfigSave = () => {
    if (!configForm || configLoading || configSaving) {
      return;
    }
    queueMicrotask(() => params.onConfigSave());
  };
  const applyModelChange = (modelId: string | null, root?: HTMLElement | null) => {
    if (root) {
      writeAgentPrimaryDraft(root, modelId);
    }
    onModelChange(agent.id, modelId);
    const trimmedModelId = modelId?.trim() ?? "";
    if (root && trimmedModelId) {
      const currentFallbacks = parseAgentFallbackDraft(root);
      if (currentFallbacks.includes(trimmedModelId)) {
        applyFallbacksChange(
          currentFallbacks.filter((entry) => entry !== trimmedModelId),
          root,
        );
      }
    }
    params.onActiveModelProviderChange(agent.id, null);
    const providers = root ? parseAgentProviderModelDraft(root) : entryModelProviders;
    for (const providerId of Object.keys(providers)) {
      params.onModelProviderChange(agent.id, providerId, null);
    }
    scheduleModelConfigSave();
  };
  const applyFallbacksChange = (fallbacks: string[], root?: HTMLElement | null) => {
    const primary = root ? parseAgentPrimaryDraft(root) : entryPrimary;
    const normalized = (normalizeAgentModelFallbackValues(fallbacks) ?? []).filter(
      (entry) => entry !== primary,
    );
    if (root) {
      writeAgentFallbackDraft(root, normalized);
    }
    if (primary) {
      onModelChange(agent.id, primary);
    }
    params.onModelFallbacksChange(agent.id, normalized);
    params.onActiveModelProviderChange(agent.id, null);
    const providers = root ? parseAgentProviderModelDraft(root) : entryModelProviders;
    for (const providerId of Object.keys(providers)) {
      params.onModelProviderChange(agent.id, providerId, null);
    }
    scheduleModelConfigSave();
  };
  const applyTaskModelRoleChange = (
    role: AgentTaskModelRole,
    modelId: string | null,
    root: HTMLElement | null,
  ) => {
    const next: AgentTaskModelSlots = {
      ...entryTaskModels,
      ...(root ? parseAgentTaskModelDraft(root) : {}),
    };
    const trimmed = modelId?.trim();
    if (trimmed) {
      next[role] = trimmed;
    } else {
      delete next[role];
    }
    if (root) {
      writeAgentTaskModelDraft(root, next);
      const select = root.querySelector<HTMLSelectElement>(
        `[data-agent-task-model-role="${role}"]`,
      );
      if (select) {
        if (trimmed) {
          select.dataset.agentTaskModelSavedValue = trimmed;
        } else {
          delete select.dataset.agentTaskModelSavedValue;
        }
      }
    }
    params.onTaskModelsChange(agent.id, next);
    params.onActiveModelProviderChange(agent.id, null);
    const providers = root ? parseAgentProviderModelDraft(root) : entryModelProviders;
    for (const providerId of Object.keys(providers)) {
      params.onModelProviderChange(agent.id, providerId, null);
    }
    scheduleModelConfigSave();
  };
  const isDefault = Boolean(params.defaultId && agent.id === params.defaultId);
  const agentLabel = normalizeAgentLabel(agent);
  const disabled = !configForm || configLoading || configSaving;
  const skillsLoadedForAgent = params.agentSkills.agentId === agent.id;
  const skills = skillsLoadedForAgent ? (params.agentSkills.report?.skills ?? []) : [];
  const skillReadinessSummary = summarizeSkillReadiness(skills);
  const readySkills = skillReadinessSummary.ready;
  const selectedModelValue = effectivePrimary ?? "";
  const identityAvatar =
    config.entry?.identity?.avatar?.trim() || agent.identity?.avatar?.trim() || "";
  const agentModelOptions = buildAgentModelOptions(params.modelCatalog);
  const discoveredAgentModelValues = new Set(agentModelOptions.map((option) => option.value));
  for (const currentTaskModel of [
    ...Object.values(defaultTaskModels),
    ...Object.values(entryTaskModels),
    ...Object.values(entryModelProviders).flatMap((providerConfig) => [
      providerConfig.primary,
      ...(providerConfig.fallbacks ?? []),
      ...Object.values(providerConfig.taskModels ?? {}),
    ]),
  ]) {
    if (
      !currentTaskModel ||
      agentModelOptions.some((option) => option.value === currentTaskModel)
    ) {
      continue;
    }
    const currentProvider = modelProviderFromValue(currentTaskModel);
    if (currentProvider) {
      agentModelOptions.unshift({
        provider: currentProvider,
        brandId: providerBrandId(currentProvider),
        value: currentTaskModel,
        label: `Current (${currentTaskModel})`,
      });
    }
  }
  if (
    selectedModelValue &&
    !agentModelOptions.some((option) => option.value === selectedModelValue)
  ) {
    const currentProvider = modelProviderFromValue(selectedModelValue);
    if (currentProvider) {
      agentModelOptions.unshift({
        provider: currentProvider,
        brandId: providerBrandId(currentProvider),
        value: selectedModelValue,
        label: `Current (${selectedModelValue})`,
      });
    }
  }
  for (const currentFallback of fallbackChips) {
    if (!currentFallback || agentModelOptions.some((option) => option.value === currentFallback)) {
      continue;
    }
    const currentProvider = modelProviderFromValue(currentFallback);
    if (currentProvider) {
      agentModelOptions.unshift({
        provider: currentProvider,
        brandId: providerBrandId(currentProvider),
        value: currentFallback,
        label: `Current (${currentFallback})`,
      });
    }
  }
  const selectedModelProvider =
    configuredActiveProvider || modelProviderFromValue(selectedModelValue);
  const selectedModelProviderBrand = providerBrandId(selectedModelProvider);
  const agentModelProviderEntries = _buildAgentModelProviderEntries(
    params.providers.authStatus,
    agentModelOptions,
    selectedModelValue,
  );
  const selectedFallbackValue = fallbackChips[0] ?? "";
  const fallbackModelOptions = agentModelOptions.filter(
    (option) => option.value !== selectedModelValue,
  );
  const discoveredModelOptions = agentModelOptions.filter((option) =>
    discoveredAgentModelValues.has(option.value),
  );
  const replacementForMissingModel = (modelValue: string) => {
    const currentProvider = providerBrandId(modelProviderFromValue(modelValue));
    return (
      discoveredModelOptions.find((option) => option.brandId === currentProvider) ??
      discoveredModelOptions[0] ??
      null
    );
  };
  const renderMissingModelWarning = (params: {
    value: string;
    roleLabel: string;
    onReplace: (replacement: string, root: HTMLElement | null) => void;
  }) => {
    const value = params.value.trim();
    if (!value || discoveredAgentModelValues.has(value)) {
      return nothing;
    }
    const replacement = replacementForMissingModel(value);
    return html`
      <div class="agent-model-warning" role="alert">
        <span>${params.roleLabel} model is not in the discovered catalog.</span>
        ${
          replacement
            ? html`
                <button
                  type="button"
                  class="agent-workbench-card__action agent-workbench-card__action--neutral"
                  @click=${(event: Event) =>
                    params.onReplace(
                      replacement.value,
                      (event.currentTarget as HTMLElement).closest<HTMLElement>(
                        "[data-agent-model-attach-root]",
                      ),
                    )}
                >
                  Replace with ${replacement.label}
                </button>
              `
            : html`
                <span>No discovered replacement is available yet.</span>
              `
        }
      </div>
    `;
  };
  const selectedAgentModelMap = new Map<string, { label: string; roles: string[] }>();
  const addSelectedAgentModel = (value: string | null | undefined, role: string) => {
    const modelId = value?.trim();
    if (!modelId) {
      return;
    }
    const existing = selectedAgentModelMap.get(modelId);
    const label = agentModelOptions.find((option) => option.value === modelId)?.label ?? modelId;
    if (existing) {
      if (!existing.roles.includes(role)) {
        existing.roles.push(role);
      }
      return;
    }
    selectedAgentModelMap.set(modelId, { label, roles: [role] });
  };
  addSelectedAgentModel(
    entryPrimary ?? (configForm ? null : resolveModelPrimary(agentModel)),
    "Primary",
  );
  const entryFallbacks =
    resolveModelFallbacks(config.entry?.model) ??
    (providerFallbacks.length > 0 ? providerFallbacks : null);
  const agentFallbacks =
    entryFallbacks ?? (configForm ? [] : (resolveModelFallbacks(agentModel) ?? []));
  for (const fallback of agentFallbacks) {
    addSelectedAgentModel(fallback, "Fallback");
  }
  for (const role of AGENT_TASK_MODEL_ROLES) {
    addSelectedAgentModel(entryTaskModels[role.key], role.label);
  }
  const selectedAgentModelRows = [...selectedAgentModelMap.entries()];
  const channels = channelSummary(params.channels);
  const memory = memorySummary(params.memory);
  const channelRoutes = resolveAgentChannelRoutes({
    agentId: agent.id,
    configForm,
    snapshot: params.channels.snapshot,
  });
  const channelRouteLabels = [
    ...new Set(channelRoutes.map((route) => route.channelLabel).filter(Boolean)),
  ];
  const agentTasks = params.cron.jobs.filter((job) => job.agentId === agent.id);
  const agentTriggers =
    params.webhookTriggers?.result?.triggers.filter((trigger) => trigger.agentId === agent.id)
      .length ?? 0;
  const agentWorkflows =
    params.taskWorkflow?.definitions?.definitions.filter(
      (definition) => definition.agentId === agent.id && definition.mode !== "graph",
    ).length ?? 0;
  const agentGraphs =
    params.taskWorkflow?.definitions?.definitions.filter(
      (definition) => definition.agentId === agent.id && definition.mode === "graph",
    ).length ?? 0;
  const agentPrograms =
    params.taskStandingOrders?.result?.orders.filter((order) => order.agentId === agent.id)
      .length ?? 0;
  const workDefinitionCount =
    agentTasks.length + agentTriggers + agentWorkflows + agentGraphs + agentPrograms;
  const sessionCount = params.sessions.result?.sessions.length ?? null;
  const providerNames = agentModelProviderEntries.map((provider) => provider.label);
  const serviceSummary = summarizeServiceCards({
    configForm,
    skills,
    plugins: params.plugins.marketplace,
  });
  const usageSummary = summarizeAgentUsage(params.usage, agent.id);
  const toolsSummary = summarizeAgentToolCards({
    agentId: agent.id,
    configForm,
    toolsCatalog: params.toolsCatalog,
    toolsEffective: params.toolsEffective,
  });
  const extensionsSummary = summarizeExtensionCards(params.plugins.marketplace);
  const providersOnly = params.surface === "providers";
  const dialogOnly = params.surface === "model-dialog";

  return html`
    <section
      class="card ${!providersOnly && !dialogOnly ? "agent-overview--setup" : ""} ${providersOnly ? "agent-overview--providers-only" : ""} ${
        dialogOnly ? "agent-overview--dialog-only" : ""
      }"
    >
      <style>
        .agent-overview--providers-only > :not(style):not(.agent-provider-models):not(.agent-model-dialog) {
          display: none !important;
        }

        .agent-overview--dialog-only > :not(style):not(.agent-model-dialog) {
          display: none !important;
        }

        .agent-overview--dialog-only {
          background: transparent;
          border: 0;
          box-shadow: none;
          margin: 0;
          padding: 0;
        }

        .agent-workbench-intro {
          display: flex;
          flex-wrap: wrap;
          align-items: flex-start;
          justify-content: space-between;
          gap: 12px;
        }

        .agent-workbench-grid {
          display: grid;
          gap: 8px;
          grid-template-columns: repeat(auto-fit, minmax(165px, 1fr));
          margin-top: 14px;
        }

        .agent-first-run {
          border-top: 1px solid var(--border);
          display: grid;
          gap: 10px;
          margin-top: 16px;
          padding-top: 16px;
        }

        .agent-first-run__head {
          align-items: flex-start;
          display: flex;
          justify-content: space-between;
          gap: 12px;
        }

        .agent-checklist {
          display: grid;
          gap: 8px;
        }

        .agent-checklist-row {
          align-items: center;
          border: 1px solid var(--border);
          border-radius: var(--radius-sm);
          background: var(--panel);
          display: grid;
          gap: 10px;
          grid-template-columns: 42px minmax(0, 1fr) auto;
          padding: 10px;
        }

        .agent-checklist-row__step {
          color: var(--muted);
          font-size: 12px;
          font-weight: 800;
        }

        .agent-checklist-row__body {
          min-width: 0;
        }

        .agent-checklist-row__head {
          align-items: baseline;
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
        }

        .agent-checklist-row__label {
          color: var(--text-strong);
          font-size: 13px;
          font-weight: 800;
        }

        .agent-checklist-row__value {
          color: var(--text);
          font-family: var(--mono);
          font-size: 12px;
          font-weight: 800;
          overflow-wrap: anywhere;
        }

        .agent-checklist-row__value.ok {
          color: var(--ok);
        }

        .agent-checklist-row__value.warn {
          color: var(--warn);
        }

        .agent-checklist-row__value.danger {
          color: var(--danger);
        }

        .agent-checklist-row__detail {
          color: var(--muted);
          font-size: 12px;
          line-height: 1.45;
          margin-top: 3px;
          overflow-wrap: anywhere;
        }

        .agent-checklist-row__actions {
          align-items: center;
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          justify-content: flex-end;
        }

        .agent-workbench-card {
          min-width: 0;
          border: 1px solid var(--border);
          border-radius: var(--radius-md);
          background: var(--panel);
          padding: 11px;
        }

        .agent-workbench-card__label {
          align-items: center;
          color: var(--muted);
          display: flex;
          gap: 7px;
          font-size: 11px;
          font-weight: 800;
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }

        .agent-status-dot {
          background: var(--muted);
          border-radius: 999px;
          display: inline-block;
          height: 7px;
          width: 7px;
        }

        .agent-workbench-card.ok .agent-status-dot {
          background: var(--ok);
        }

        .agent-workbench-card.warn .agent-status-dot {
          background: var(--warn);
        }

        .agent-workbench-card.danger .agent-status-dot {
          background: var(--danger);
        }

        .agent-workbench-card__value {
          color: var(--text-strong);
          font-family: var(--mono);
          font-size: 15px;
          font-weight: 800;
          margin-top: 6px;
          overflow-wrap: anywhere;
        }

        .agent-workbench-card__value.ok {
          color: var(--ok);
        }

        .agent-workbench-card__value.warn {
          color: var(--warn);
        }

        .agent-workbench-card__value.danger {
          color: var(--danger);
        }

        .agent-workbench-card__detail {
          color: var(--muted);
          font-size: 12px;
          line-height: 1.45;
          margin-top: 6px;
          overflow-wrap: anywhere;
        }

        .agent-workbench-card__actions {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          margin-top: 9px;
        }

        .agent-setup-summary-grid {
          display: grid;
          gap: 10px;
          grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
          grid-auto-rows: minmax(178px, 1fr);
        }

        .agent-setup-card {
          align-items: center;
          background: var(--panel);
          border: 1px solid var(--border);
          border-radius: var(--radius-md);
          display: grid;
          gap: 8px;
          grid-template-rows: auto auto minmax(18px, auto) auto;
          justify-items: center;
          min-width: 0;
          padding: 12px;
          text-align: center;
        }

        .agent-overview--setup {
          background: transparent;
          border: 0;
          border-radius: 0;
          box-shadow: none;
          padding: 0;
        }

        .agent-setup-card__figure {
          align-items: center;
          color: var(--text-strong);
          display: flex;
          font-family: var(--mono);
          font-size: 34px;
          font-weight: 850;
          justify-content: center;
          line-height: 1;
          min-height: 58px;
          min-width: 0;
          width: 100%;
        }

        .agent-setup-card__title,
        .agent-setup-card__title-button {
          background: transparent;
          border: 0;
          color: var(--text-strong);
          cursor: pointer;
          font: inherit;
          font-size: 13px;
          font-weight: 850;
          line-height: 1.2;
          min-width: 0;
          padding: 0;
          text-align: center;
        }

        .agent-setup-card__title-button:hover,
        .agent-setup-card__title-button:focus-visible {
          color: var(--accent);
        }

        .agent-setup-card__detail {
          -webkit-box-orient: vertical;
          -webkit-line-clamp: 2;
          color: var(--muted);
          display: -webkit-box;
          font-size: 11px;
          line-height: 1.35;
          min-height: 30px;
          overflow: hidden;
          overflow-wrap: anywhere;
        }

        .agent-setup-card__status {
          align-items: center;
          display: inline-flex;
          gap: 6px;
          min-width: 0;
        }

        .agent-setup-card__status-dot {
          background: var(--muted);
          border-radius: 999px;
          flex: 0 0 auto;
          height: 8px;
          width: 8px;
        }

        .agent-setup-card__status-dot.ok {
          background: var(--ok);
        }

        .agent-setup-card__status-dot.warn {
          background: var(--warn);
        }

        .agent-setup-card__status-dot.danger {
          background: var(--danger);
        }

        .agent-profile-card__meta {
          color: var(--muted);
          font-size: 11px;
          line-height: 1.45;
          overflow-wrap: anywhere;
        }

        .agent-setup-card__links {
          align-items: center;
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          justify-content: center;
        }

        .agent-setup-card__link {
          align-items: center;
          background: var(--button-neutral-bg);
          border: 1px solid var(--button-neutral-border);
          border-radius: var(--radius-sm);
          color: var(--button-neutral-fg);
          cursor: pointer;
          display: inline-flex;
          font: inherit;
          font-size: 12px;
          font-weight: 700;
          gap: 6px;
          min-height: 28px;
          padding: 0 8px;
          text-decoration: none;
        }

        .agent-setup-card__links .agent-workbench-card__action {
          min-height: 28px;
          padding: 0 8px;
        }

        .agent-setup-card__links .agent-workbench-card__action svg {
          display: block;
          fill: none;
          flex: 0 0 auto;
          height: 14px;
          stroke: currentColor;
          stroke-width: 2;
          width: 14px;
        }

        .agent-setup-card__link svg {
          display: block;
          fill: none;
          flex: 0 0 auto;
          height: 14px;
          stroke: currentColor;
          stroke-width: 2;
          width: 14px;
        }

        .agent-setup-card__link:hover,
        .agent-setup-card__link:focus-visible {
          background: var(--button-bg-hover);
          color: var(--text-strong);
        }

        .agent-setup-card__link--wide {
          justify-content: center;
          min-width: 108px;
        }

        .agent-profile-avatar {
          align-items: center;
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: 999px;
          color: var(--text-strong);
          cursor: pointer;
          display: inline-grid;
          flex: 0 0 auto;
          font-size: 22px;
          font-weight: 850;
          height: 64px;
          justify-items: center;
          overflow: hidden;
          place-items: center;
          width: 64px;
        }

        .agent-profile-avatar input {
          display: none;
        }

        .agent-profile-avatar img {
          height: 100%;
          object-fit: cover;
          width: 100%;
        }

        .agent-profile-avatar--disabled {
          cursor: not-allowed;
          opacity: 0.68;
        }

        .agent-status-dot.ok {
          background: var(--ok);
        }

        .agent-status-dot.warn {
          background: var(--warn);
        }

        .agent-status-dot.danger {
          background: var(--danger);
        }

        .agent-identity-card {
          border: 1px solid var(--border);
          border-radius: var(--radius-md);
          background: var(--panel);
          display: grid;
          gap: 10px;
          margin-top: 16px;
          padding: 11px;
        }

        .agent-identity-card__head {
          align-items: baseline;
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          justify-content: space-between;
        }

        .agent-identity-card__title {
          color: var(--text-strong);
          font-size: 13px;
          font-weight: 850;
        }

        .agent-identity-card__meta {
          color: var(--muted);
          font-size: 12px;
          overflow-wrap: anywhere;
        }

        .agent-identity-card__row {
          align-items: end;
          display: grid;
          gap: 8px;
          grid-template-columns: minmax(0, 1fr) auto;
        }

        .agent-identity-card .field {
          min-width: 0;
        }

        .agent-identity-card input {
          min-width: 0;
          width: 100%;
        }

        .agent-workbench-card__action {
          align-items: center;
          appearance: none;
          border: 1px solid var(--button-border);
          border-radius: var(--radius-sm);
          background: var(--button-bg);
          color: var(--button-fg);
          cursor: pointer;
          display: inline-flex;
          gap: 5px;
          font: inherit;
          font-size: 12px;
          font-weight: 700;
          line-height: 1;
          padding: 7px 8px;
          text-decoration: none;
        }

        .agent-workbench-card__action-label {
          font-weight: 600;
        }

        .agent-workbench-card__action svg {
          color: currentColor;
          height: 14px;
          stroke: currentColor;
          width: 14px;
          stroke-width: 2;
        }

        .agent-workbench-card__action:hover {
          background: var(--button-bg-hover);
          color: var(--text-strong);
        }

        .agent-workbench-card__action--neutral {
          background: var(--button-neutral-bg);
          border-color: var(--button-neutral-border);
          color: var(--button-neutral-fg);
        }

        .agent-workbench-card__action--neutral svg {
          color: currentColor;
          stroke: currentColor;
        }

        .agent-workbench-card__action--primary {
          background: var(--button-success-bg);
          border-color: var(--button-success-border);
          color: var(--button-success-fg);
        }

        .agent-workbench-card__action--primary:hover {
          background: var(--button-success-bg-hover);
          color: var(--button-success-fg);
        }

        .agent-workbench-card__action--primary svg {
          color: currentColor;
          height: 16px;
          stroke: currentColor;
          width: 16px;
        }

        .agent-workbench-card__action--icon {
          align-items: center;
          display: inline-flex;
          height: 30px;
          justify-content: center;
          padding: 0;
          width: 30px;
        }

        .agent-workbench-card__action--icon svg {
          height: 16px;
          width: 16px;
        }

        .agent-model-action {
          background: var(--text-strong);
          border-color: var(--text-strong);
          color: var(--bg);
        }

        .agent-model-action:hover,
        .agent-model-action:focus-visible {
          background: var(--text);
          border-color: var(--text);
          color: var(--bg);
          outline: none;
        }

        .agent-model-action svg {
          color: currentColor;
          stroke: currentColor;
        }

        .agent-routes {
          border-top: 1px solid var(--border);
          display: grid;
          gap: 12px;
          margin-top: 16px;
          padding-top: 16px;
        }

        .agent-route-grid {
          display: grid;
          gap: 10px;
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }

        .agent-route-column {
          border: 1px solid var(--border);
          border-radius: var(--radius-md);
          background: var(--panel);
          display: grid;
          gap: 9px;
          min-width: 0;
          padding: 10px;
        }

        .agent-route-column__head {
          align-items: center;
          color: var(--text-strong);
          display: flex;
          font-size: 13px;
          font-weight: 800;
          gap: 8px;
          justify-content: space-between;
        }

        .agent-route-column__sub {
          color: var(--muted);
          font-size: 12px;
          line-height: 1.45;
        }

        .agent-route-list {
          display: grid;
          gap: 7px;
        }

        .agent-route-item {
          border: 1px solid var(--border);
          border-radius: var(--radius-sm);
          padding: 8px;
        }

        .agent-route-item__title {
          color: var(--text);
          font-size: 13px;
          font-weight: 750;
          overflow-wrap: anywhere;
        }

        .agent-route-item__detail,
        .agent-route-more {
          color: var(--muted);
          font-family: var(--mono);
          font-size: 12px;
          line-height: 1.45;
          margin-top: 3px;
          overflow-wrap: anywhere;
        }

        .agent-setup-actions {
          border-top: 1px solid var(--border);
          display: grid;
          gap: 12px;
          grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
          margin-top: 18px;
          padding-top: 16px;
        }

        .agent-setup-section {
          display: grid;
          gap: 10px;
          min-width: 0;
        }

        .agent-setup-actions__head {
          align-self: start;
          min-width: 0;
        }

        .agent-setup-section__head,
        .agent-setup-row {
          align-items: flex-start;
          display: flex;
          gap: 10px;
          justify-content: space-between;
          min-width: 0;
        }

        .agent-setup-section__title {
          color: var(--text-strong);
          font-size: 13px;
          font-weight: 800;
        }

        .agent-setup-section__sub,
        .agent-setup-row__detail,
        .agent-setup-empty {
          color: var(--muted);
          font-size: 12px;
          line-height: 1.45;
        }

        .agent-setup-list {
          display: grid;
          gap: 8px;
        }

        .agent-setup-row {
          border: 1px solid var(--border);
          border-radius: var(--radius-sm);
          padding: 9px;
        }

        .agent-setup-row__main {
          min-width: 0;
        }

        .agent-setup-row__title {
          color: var(--text);
          font-size: 13px;
          font-weight: 750;
          overflow-wrap: anywhere;
        }

        .agent-setup-row__actions {
          align-items: center;
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          justify-content: flex-end;
        }

        .agent-setup-secret {
          max-width: 150px;
          min-width: 120px;
        }

        .agent-model-hint {
          color: var(--muted);
          font-size: 12px;
          line-height: 1.45;
          margin-top: 8px;
        }

        .agent-provider-models {
          display: grid;
          gap: 10px;
          margin-top: 0;
          padding-top: 0;
        }

        .agent-provider-models__head {
          align-items: flex-start;
          display: flex;
          gap: 10px;
          justify-content: space-between;
        }

        .agent-provider-models__title {
          color: var(--text-strong);
          font-size: 13px;
          font-weight: 850;
        }

        .agent-provider-models__sub {
          color: var(--muted);
          font-size: 12px;
          line-height: 1.45;
        }

        .agent-provider-model-grid {
          display: grid;
          gap: 8px;
          grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        }

        .agent-provider-model-card {
          border: 1px solid var(--border);
          border-radius: var(--radius-sm);
          background: var(--panel);
          display: grid;
          gap: 10px;
          padding: 10px;
        }

        .agent-provider-model-card__head {
          align-items: flex-start;
          display: flex;
          gap: 10px;
          justify-content: space-between;
        }

        .agent-provider-model-card__name {
          color: var(--text-strong);
          font-size: 13px;
          font-weight: 800;
        }

        .agent-provider-model-card__meta {
          color: var(--muted);
          font-size: 12px;
          margin-top: 2px;
        }

        .agent-provider-model-card__models {
          display: grid;
          gap: 5px;
        }

        .agent-provider-model-card__model {
          align-items: baseline;
          background: transparent;
          border: 0;
          color: var(--text);
          cursor: pointer;
          display: grid;
          gap: 4px;
          grid-template-columns: auto minmax(0, 1fr);
          min-width: 0;
          padding: 0;
          text-align: left;
          text-decoration: none;
        }

        .agent-provider-model-card__model.is-missing {
          color: var(--warning);
        }

        .agent-provider-model-card__model.is-missing .agent-provider-model-card__model-value {
          color: var(--warning);
        }

        .agent-provider-model-card__model:hover .agent-provider-model-card__model-value,
        .agent-provider-model-card__model:focus-visible .agent-provider-model-card__model-value {
          color: var(--text-strong);
          text-decoration: underline;
          text-underline-offset: 3px;
        }

        .agent-provider-model-card__model-role {
          color: var(--muted);
          font-size: 11px;
          font-weight: 800;
          white-space: nowrap;
        }

        .agent-provider-model-card__model-value {
          color: var(--text);
          font-size: 12px;
          font-weight: 750;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .agent-provider-model-card__empty {
          color: var(--muted);
          font-size: 12px;
        }

        .agent-provider-model-card__add {
          align-items: center;
          color: #05150c;
          display: inline-flex;
          gap: 5px;
          font-weight: 650;
        }

        .agent-provider-model-card__add svg {
          color: #05150c;
          height: 16px;
          stroke: #05150c;
          stroke-width: 2;
          width: 16px;
        }

        .agent-model-fields {
          display: grid;
          gap: 10px;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          margin-top: 10px;
        }

        .agent-model-select-field {
          min-width: 0;
        }

        .agent-model-select {
          width: 100%;
        }

        .agent-model-select .chat-select__panel {
          z-index: 120;
          width: min(420px, calc(100vw - 54px));
        }

        .agent-model-select[data-floating-select="true"] .chat-select__panel {
          z-index: 10000;
        }

        .agent-model-select__group {
          align-items: center;
          color: var(--muted);
          display: flex;
          font-size: 11px;
          font-weight: 800;
          min-height: 24px;
          padding: 4px 8px 2px;
          text-transform: uppercase;
        }

        .agent-model-native-select {
          min-width: 0;
          width: 100%;
        }

        .agent-model-roles {
          grid-column: 1 / -1;
          border-top: 1px solid var(--border);
          display: grid;
          gap: 8px;
          padding-top: 10px;
        }

        .agent-model-roles__head {
          align-items: baseline;
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          justify-content: space-between;
        }

        .agent-model-roles__title {
          color: var(--text-strong);
          font-size: 13px;
          font-weight: 800;
        }

        .agent-model-role-grid {
          display: grid;
          gap: 8px;
          grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        }

        .agent-model-role {
          border: 1px solid var(--border);
          border-radius: var(--radius-sm);
          background: var(--surface);
          display: grid;
          gap: 6px;
          padding: 9px;
        }

        .agent-model-role__label {
          color: var(--text-strong);
          font-size: 12px;
          font-weight: 800;
        }

        .agent-model-role__detail {
          color: var(--text-muted);
          font-size: 11px;
          line-height: 1.35;
        }

        .agent-model-role select {
          min-width: 0;
          width: 100%;
        }

        .agent-model-select__capabilities {
          color: var(--muted);
          display: block;
          font-size: 11px;
          font-weight: 650;
          margin-top: 3px;
        }

        .agent-model-warning {
          align-items: center;
          background: color-mix(in srgb, var(--warning) 9%, transparent);
          border: 1px solid color-mix(in srgb, var(--warning) 42%, var(--border));
          border-radius: var(--radius-sm);
          color: var(--text);
          display: flex;
          flex-wrap: wrap;
          font-size: 12px;
          gap: 8px;
          line-height: 1.4;
          padding: 8px;
        }

        .agent-model-dialog {
          background: var(--panel);
          border: 1px solid var(--border);
          border-radius: var(--radius-lg);
          box-shadow: 0 22px 60px rgba(0, 0, 0, 0.42);
          color: var(--text);
          max-height: min(760px, calc(100dvh - 28px));
          overflow: hidden;
          padding: 0;
          width: min(560px, calc(100vw - 28px));
        }

        .agent-model-dialog::backdrop {
          background: rgba(0, 0, 0, 0.58);
        }

        .agent-model-dialog__form {
          display: grid;
          gap: 13px;
          max-height: min(760px, calc(100dvh - 28px));
          overflow-y: auto;
          padding: 16px;
          scroll-padding-block: 16px;
          scrollbar-gutter: stable;
        }

        .agent-model-dialog__head {
          align-items: center;
          background: var(--panel);
          display: flex;
          gap: 10px;
          justify-content: space-between;
          margin: -16px -16px 0;
          padding: 16px 16px 10px;
          position: sticky;
          top: 0;
          z-index: 2;
        }

        .agent-model-dialog__title {
          color: var(--text-strong);
          font-size: 16px;
          font-weight: 800;
        }

        .agent-model-dialog__close {
          align-items: center;
          background: transparent;
          border: 1px solid var(--border);
          border-radius: var(--radius-sm);
          color: var(--muted);
          cursor: pointer;
          display: inline-flex;
          height: 34px;
          justify-content: center;
          padding: 0;
          width: 34px;
        }

        .agent-model-dialog__close:hover,
        .agent-model-dialog__close:focus-visible {
          background: var(--secondary);
          color: var(--text-strong);
          outline: none;
        }

        .agent-model-dialog__close svg {
          fill: none;
          height: 16px;
          stroke: currentColor;
          stroke-linecap: round;
          stroke-linejoin: round;
          stroke-width: 2;
          width: 16px;
        }

        @media (max-width: 740px) {
          .agent-setup-summary-grid {
            grid-template-columns: 1fr;
          }

          .agent-setup-card--profile {
            grid-column: auto;
          }

          .agent-profile-card__main {
            justify-content: flex-start;
          }

          .agent-checklist-row {
            grid-template-columns: 34px minmax(0, 1fr);
          }

          .agent-route-grid {
            grid-template-columns: 1fr;
          }

          .agent-model-fields {
            grid-template-columns: 1fr;
          }

          .agent-identity-card__row {
            grid-template-columns: 1fr;
          }

          .agent-checklist-row__actions {
            grid-column: 1 / -1;
            justify-content: flex-start;
          }
        }
      </style>

      <div class="agent-setup-summary-grid" aria-label="Agent setup summary">
        <section class="agent-setup-card agent-setup-card--profile" aria-label="Agent profile">
          <div class="agent-setup-card__figure">
            ${renderAgentAvatarUpload({
              agent,
              agentIdentity: params.agentIdentity,
              identityAvatar,
              disabled,
              onAgentIdentityAvatarChange: params.onAgentIdentityAvatarChange,
            })}
          </div>
          <div class="agent-setup-card__title">${agentLabel}</div>
          <div
            class="agent-setup-card__detail"
            title=${`${agentLabel} · ${agent.id}${isDefault ? " · default" : ""} · ${workspace}`}
          >
            ${agent.id}${isDefault ? " · default" : ""} · <span title=${workspace}>Space</span>
          </div>
          <div class="agent-setup-card__links">
            ${renderSetupSummaryAction({
              label: "Memory",
              title: memory.detail,
              tone: memory.tone,
              onClick: () => params.onSelectPanel("memory"),
            })}
            ${
              configDirty
                ? renderSetupSummaryAction({
                    label: "Save",
                    onClick: params.onConfigSave,
                    disabled,
                  })
                : nothing
            }
          </div>
        </section>

        <section class="agent-setup-card" aria-label="Agent skills">
          <div class="agent-setup-card__figure">
            ${skillsLoadedForAgent ? readySkills : "–"}
          </div>
          ${renderSetupTitleButton({ label: "Skills", onClick: () => params.onSelectPanel("skills") })}
          <div class="agent-setup-card__detail">
            ${skillsLoadedForAgent ? `${readySkills} ready for this Agent` : "Skills are loading."}
          </div>
          <div class="agent-setup-card__links">
            ${renderSetupSummaryAction({
              label: "Skill",
              icon: icons.plus,
              onClick: () => params.onNavigate("skills"),
            })}
          </div>
        </section>

        <section class="agent-setup-card" aria-label="Provider models">
          <div class="agent-setup-card__figure">${agentModelOptions.length}</div>
          ${renderSetupTitleButton({
            label: "Models",
            onClick: () => params.onSelectPanel("providers"),
          })}
          <div class="agent-setup-card__detail">
            ${providerNames.length > 0 ? providerNames.join(", ") : "No signed-in providers."}
          </div>
          <div class="agent-setup-card__links">
            ${renderAgentModelDropdownAction({ label: "Models", icon: icons.plus, wide: true })}
            ${renderSetupSummaryAction({
              label: "Providers",
              icon: icons.plus,
              wide: true,
              onClick: () => params.onSelectPanel("providers"),
            })}
          </div>
        </section>

        <section class="agent-setup-card" aria-label="Channels">
          <div class="agent-setup-card__figure">${channelRoutes.length}</div>
          ${renderSetupTitleButton({ label: "Channels", onClick: () => params.onSelectPanel("channels") })}
          <div class="agent-setup-card__detail">
            ${channelRouteLabels.length > 0 ? channelRouteLabels.join(", ") : channels.detail}
          </div>
          <div class="agent-setup-card__links">
            ${renderSetupSummaryAction({
              label: "Channels",
              icon: icons.plus,
              onClick: () => params.onSelectPanel("channels"),
            })}
          </div>
        </section>

        <section class="agent-setup-card" aria-label="Tasks">
          <div class="agent-setup-card__figure">${workDefinitionCount}</div>
          ${renderSetupTitleButton({ label: "Tasks", onClick: () => params.onSelectPanel("cron") })}
          <div class="agent-setup-card__detail">
            ${agentTasks.length} task${agentTasks.length === 1 ? "" : "s"} · ${agentTriggers} trigger${agentTriggers === 1 ? "" : "s"} · ${agentWorkflows} workflow${agentWorkflows === 1 ? "" : "s"} · ${agentGraphs} graph${agentGraphs === 1 ? "" : "s"} · ${agentPrograms} program${agentPrograms === 1 ? "" : "s"}
          </div>
          <div class="agent-setup-card__links">
            ${renderSetupSummaryAction({
              label: "Tasks",
              icon: icons.plus,
              onClick: () => params.onSelectPanel("cron"),
            })}
          </div>
        </section>

        <section class="agent-setup-card" aria-label="Sessions">
          <div class="agent-setup-card__figure">${sessionCount ?? "–"}</div>
          ${renderSetupTitleButton({
            label: "Sessions",
            onClick: () => params.onSelectPanel("sessions"),
          })}
          <div class="agent-setup-card__detail">
            ${sessionCount == null ? "Session history has not loaded." : "History and restore points."}
          </div>
          <div class="agent-setup-card__links">
            ${renderSetupSummaryAction({
              label: "Sessions",
              onClick: () => params.onSelectPanel("sessions"),
            })}
          </div>
        </section>

        <section class="agent-setup-card" aria-label="Usage">
          <div class="agent-setup-card__figure">${usageSummary.value}</div>
          ${renderSetupTitleButton({
            label: "Usage",
            onClick: () => params.onOpenUsageForAgent?.(agent.id) ?? params.onNavigate("usage"),
          })}
          <div class="agent-setup-card__detail" title=${usageSummary.title}>
            ${usageSummary.detail}
          </div>
          <div class="agent-setup-card__links">
            ${renderSetupSummaryAction({
              label: "Usage",
              onClick: () => params.onOpenUsageForAgent?.(agent.id) ?? params.onNavigate("usage"),
            })}
          </div>
        </section>

        <section class="agent-setup-card" aria-label="Services">
          <div class="agent-setup-card__figure">${serviceSummary.count}</div>
          ${renderSetupTitleButton({
            label: "Services",
            onClick: () => params.onSelectPanel("services"),
          })}
          <div class="agent-setup-card__detail">
            ${serviceSummary.detail}
          </div>
          <div class="agent-setup-card__links">
            ${renderSetupSummaryAction({
              label: "Service",
              icon: icons.plus,
              onClick: () => params.onSelectPanel("services"),
            })}
          </div>
        </section>

        <section class="agent-setup-card" aria-label="Tools">
          <div class="agent-setup-card__figure">
            ${
              typeof toolsSummary.availableNow === "number"
                ? toolsSummary.availableNow
                : toolsSummary.allowedCount
            }
          </div>
          ${renderSetupTitleButton({ label: "Tools", onClick: () => params.onSelectPanel("tools") })}
          <div class="agent-setup-card__detail">
            ${typeof toolsSummary.availableNow === "number" ? "available now" : toolsSummary.detail}
          </div>
          <div class="agent-setup-card__links">
            ${renderSetupSummaryAction({
              label: "Tools",
              onClick: () => params.onSelectPanel("tools"),
            })}
          </div>
        </section>

        <section class="agent-setup-card" aria-label="Extensions">
          <div class="agent-setup-card__figure">${extensionsSummary.activeCount}</div>
          ${renderSetupTitleButton({
            label: "Extensions",
            onClick: () => params.onNavigate("plugins"),
          })}
          <div class="agent-setup-card__detail">
            <span class="agent-setup-card__status">
              <span class="agent-setup-card__status-dot ${extensionsSummary.tone}" aria-hidden="true"></span>
              <span>${extensionsSummary.detail}</span>
            </span>
          </div>
          <div class="agent-setup-card__links">
            ${renderSetupSummaryAction({
              label: "Extensions",
              onClick: () => params.onNavigate("plugins"),
            })}
          </div>
        </section>
      </div>

      ${
        providersOnly
          ? html`
              <div class="agent-provider-models" aria-label="Agent provider models">
                <div class="agent-provider-models__head">
                  ${renderAgentModelDropdownAction({ label: "Models", icon: icons.plus })}
                </div>
                <div class="agent-provider-model-grid">
                  ${
                    agentModelProviderEntries.length > 0
                      ? agentModelProviderEntries.map((provider) => {
                          const providerModels = selectedAgentModelRows.filter(
                            ([modelId]) =>
                              providerBrandId(modelProviderFromValue(modelId)) === provider.id,
                          );
                          const availableCount = agentModelOptions.filter(
                            (option) => option.brandId === provider.id,
                          ).length;
                          return html`
                            <div
                              class="agent-provider-model-card"
                              data-agent-provider-model-card=${provider.id}
                            >
                              <div class="agent-provider-model-card__head">
                                <div>
                                  <div class="agent-provider-model-card__name">
                                    ${provider.label}
                                    <span class="agent-provider-model-card__meta">
                                      ${availableCount} ${availableCount === 1 ? "model" : "models"}
                                    </span>
                                  </div>
                                </div>
                              </div>
                              <div class="agent-provider-model-card__models">
                                ${
                                  providerModels.length > 0
                                    ? providerModels.map(
                                        ([modelId, entry]) => html`
                                          <button
                                            type="button"
                                            class="agent-provider-model-card__model ${
                                              discoveredAgentModelValues.has(modelId)
                                                ? ""
                                                : "is-missing"
                                            }"
                                            title=${`${entry.roles.join(", ")} · ${entry.label} · ${modelId}`}
                                            @click=${(event: Event) =>
                                              openAgentModelDropdown(
                                                event,
                                                "[data-agent-model-select]",
                                              )}
                                          >
                                            <span class="agent-provider-model-card__model-role">
                                              ${entry.roles.join(" / ")}:
                                            </span>
                                            <span class="agent-provider-model-card__model-value">
                                              ${entry.label}
                                            </span>
                                            ${
                                              discoveredAgentModelValues.has(modelId)
                                                ? nothing
                                                : html`
                                                    <span class="agent-provider-model-card__model-role"> missing </span>
                                                  `
                                            }
                                          </button>
                                        `,
                                      )
                                    : html`
                                        <span class="agent-provider-model-card__empty"> No Agent-specific models selected </span>
                                      `
                                }
                              </div>
                            </div>
                          `;
                        })
                      : html`
                          <div class="agent-provider-model-card">
                            <div class="agent-provider-model-card__empty">
                              Connect a provider before attaching Agent models.
                            </div>
                          </div>
                        `
                  }
                </div>
              </div>
            `
          : nothing
      }

      ${
        configDirty
          ? html`
              <div class="callout warn" style="margin-top: 16px">You have unsaved config changes.</div>
            `
          : nothing
      }

      <dialog
        class="agent-model-dialog"
        id="agent-model-attach"
        data-agent-model-dialog="true"
        @click=${closeDialogOnBackdropClick}
      >
        <form class="agent-model-dialog__form" method="dialog">
          <div class="agent-model-dialog__head">
            <div class="agent-model-dialog__title">Add Models</div>
            <button
              type="button"
              class="agent-model-dialog__close"
              aria-label="Close"
              @click=${(event: Event) =>
                (event.currentTarget as HTMLElement).closest("dialog")?.close()}
            >
              ${icons.x}
            </button>
          </div>
          <div
            class="agent-model-fields"
            data-agent-model-attach-root="true"
            data-agent-active-provider=${selectedModelProviderBrand}
            data-agent-provider-models=${JSON.stringify(entryModelProviders)}
            data-agent-model-primary=${selectedModelValue}
            data-agent-legacy-primary=${legacyEntryPrimary ?? ""}
            data-agent-model-fallbacks=${JSON.stringify(fallbackChips)}
            data-agent-task-models=${JSON.stringify(entryTaskModels)}
          >
          <label class="field agent-model-select-field">
            <span>Primary</span>
            ${renderAgentModelPicker({
              ariaLabel: "Primary model",
              control: "main",
              disabled: disabled || agentModelOptions.length === 0,
              emptyLabel: isDefault
                ? "Not set"
                : defaultPrimary
                  ? `Inherit default (${defaultPrimary})`
                  : "Inherit default",
              nativeOptions: renderAgentProviderModelOptions(agentModelOptions, selectedModelValue),
              onChange: (event: Event) => {
                const select = event.currentTarget as HTMLSelectElement;
                const root = select.closest<HTMLElement>("[data-agent-model-attach-root]");
                applyModelChange(select.value || null, root);
                if (root) {
                  syncAgentModelProviderFilter(root);
                }
              },
              options: agentModelOptions,
              value: selectedModelValue,
            })}
            ${renderMissingModelWarning({
              value: selectedModelValue,
              roleLabel: "Primary",
              onReplace: (replacement, root) => {
                applyModelChange(replacement, root);
                if (root) {
                  const select = findAgentModelControlSelect(root, "main");
                  if (select) {
                    select.value = replacement;
                  }
                  updateAgentModelControlState(root, "main");
                }
              },
            })}
          </label>
          <label class="field agent-model-select-field">
            <span>Fallback</span>
            ${renderAgentModelPicker({
              ariaLabel: "Fallback model",
              control: "fallback",
              disabled: disabled || agentModelOptions.length === 0,
              emptyLabel: "No fallback",
              nativeOptions: renderTaskRoleModelOptions(
                fallbackModelOptions,
                selectedFallbackValue,
              ),
              onChange: (event: Event) => {
                const select = event.currentTarget as HTMLSelectElement;
                applyFallbacksChange(
                  select.value ? [select.value] : [],
                  select.closest<HTMLElement>("[data-agent-model-attach-root]"),
                );
              },
              options: fallbackModelOptions,
              value: selectedFallbackValue,
            })}
            ${renderMissingModelWarning({
              value: selectedFallbackValue,
              roleLabel: "Fallback",
              onReplace: (replacement, root) => {
                applyFallbacksChange([replacement], root);
                if (root) {
                  const select = findAgentModelControlSelect(root, "fallback");
                  if (select) {
                    select.value = replacement;
                  }
                  updateAgentModelControlState(root, "fallback");
                }
              },
            })}
          </label>
          <div class="agent-model-roles" aria-label="Task model roles">
            <div class="agent-model-roles__head">
              <div class="agent-model-roles__title">Task model roles</div>
            </div>
            <div class="agent-model-role-grid">
              ${AGENT_TASK_MODEL_ROLES.map((role) => {
                const entryValue = entryTaskModels[role.key] ?? "";
                const inheritedValue = defaultTaskModels[role.key] ?? "";
                const inheritedLabel = inheritedValue
                  ? `Inherit default (${inheritedValue})`
                  : effectivePrimary
                    ? `Use Agent default model (${effectivePrimary})`
                    : "Use Agent default model";
                return html`
                  <label class="agent-model-role">
                    <span class="agent-model-role__label">${role.label}</span>
                    <span class="agent-model-role__detail">${role.detail}</span>
                    ${renderAgentModelPicker({
                      ariaLabel: `${role.label} task model`,
                      control: `role:${role.key}`,
                      disabled: disabled || agentModelOptions.length === 0,
                      emptyLabel: inheritedLabel,
                      nativeOptions: renderTaskRoleModelOptions(agentModelOptions, entryValue),
                      onChange: (event: Event) => {
                        const select = event.currentTarget as HTMLSelectElement;
                        applyTaskModelRoleChange(
                          role.key,
                          select.value || null,
                          select.closest<HTMLElement>("[data-agent-model-attach-root]"),
                        );
                      },
                      options: agentModelOptions,
                      role: role.key,
                      savedRoleValue: entryValue,
                      value: entryValue,
                    })}
                    ${renderMissingModelWarning({
                      value: entryValue,
                      roleLabel: role.label,
                      onReplace: (replacement, root) => {
                        applyTaskModelRoleChange(role.key, replacement, root);
                        if (root) {
                          const select = findAgentModelControlSelect(root, `role:${role.key}`);
                          if (select) {
                            select.value = replacement;
                          }
                          updateAgentModelControlState(root, `role:${role.key}`);
                        }
                      },
                    })}
                  </label>
                `;
              })}
            </div>
          </div>
          </div>
        </form>
      </dialog>
    </section>
  `;
}
