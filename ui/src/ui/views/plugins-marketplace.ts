import { html, nothing } from "lit";
import { formatAgentDisplayName } from "../agent-display.ts";
import type { PluginsMarketplaceRemediationState } from "../controllers/plugins-marketplace.ts";
import { icons } from "../icons.ts";
import type { Tab } from "../navigation.ts";
import type {
  PluginMarketplaceAdminRpcActionGrantStatus,
  PluginMarketplaceAdminRpcActionMethod,
  PluginMarketplaceDiagnostic,
  PluginMarketplaceEntry,
  PluginMarketplaceInstallChoice,
  PluginMarketplaceMutationAction,
  PluginsMarketplaceInfoResult,
  PluginsMarketplaceListResult,
  ExtensionsHooksStatusResult,
  ExtensionHookStatusEntry,
} from "../types.ts";

export type PluginsMarketplaceProps = {
  connected: boolean;
  loading: boolean;
  detailLoading: boolean;
  error: string | null;
  message: string | null;
  actionBusy: PluginMarketplaceMutationAction | null;
  remediation: PluginsMarketplaceRemediationState | null;
  hooksLoading: boolean;
  hooksError: string | null;
  hooksMessage: string | null;
  hooksStatus: ExtensionsHooksStatusResult | null;
  hooksBusyKey: string | null;
  report: PluginsMarketplaceListResult | null;
  detail: PluginsMarketplaceInfoResult | null;
  selectedId: string | null;
  onRefresh: () => void;
  onHooksRefresh: () => void;
  onSetHookEnabled: (name: string, enabled: boolean) => void;
  onSelect: (id: string) => void;
  onInstall: (id: string, sourceChoice?: PluginMarketplaceInstallChoice) => void;
  onRestartRuntime: (id: string) => void;
  onUpdate: (id: string) => void;
  onUninstall: (id: string) => void;
  onSetSessionHelperGrant: (id: string, enabled: boolean) => void;
  onSetAdminRpcGrant: (
    id: string,
    method: PluginMarketplaceAdminRpcActionMethod,
    enabled: boolean,
  ) => void;
  onOpenConfigSection: (section: string) => void;
  onOpenChannels: () => void;
  onOpenTab: (tab: Tab) => void;
};

type PluginManagementShortcut = {
  key: string;
  label: string;
  detail: string;
  kind: "config" | "tab";
  section?: string;
  tab?: Tab;
};

type PluginConfigurationNote = {
  label: string;
  detail: string;
};

type PluginDiagnosticsOverview = {
  warnings: number;
  errors: number;
  primary: string | null;
};

type PluginRuntimeHelperOverview = {
  sessionsRead: boolean;
  adminRpcGranted: number;
  deniedDiagnostics: PluginMarketplaceDiagnostic[];
  adminRpcDiagnostics: PluginMarketplaceDiagnostic[];
};

type PluginRemediationState = {
  severity: "info" | "warn" | "danger" | "success";
  title: string;
  detail: string;
};

function renderExtensionHelp(text: string) {
  return html`
    <span
      class="extension-help"
      role="img"
      tabindex="0"
      aria-label=${text}
      data-tooltip=${text}
      @click=${(event: Event) => event.stopPropagation()}
    >
      ${icons.info}
    </span>
  `;
}

function pluginSurfaceCounts(entry: PluginMarketplaceEntry) {
  return [
    entry.channels.length
      ? `${entry.channels.length} channel${entry.channels.length === 1 ? "" : "s"}`
      : null,
    entry.providers.length
      ? `${entry.providers.length} provider${entry.providers.length === 1 ? "" : "s"}`
      : null,
    entry.toolNames.length
      ? `${entry.toolNames.length} tool${entry.toolNames.length === 1 ? "" : "s"}`
      : null,
    entry.hookNames.length || entry.hookCount
      ? `${entry.hookNames.length || entry.hookCount} hook${(entry.hookNames.length || entry.hookCount) === 1 ? "" : "s"}`
      : null,
    entry.services.length
      ? `${entry.services.length} service${entry.services.length === 1 ? "" : "s"}`
      : null,
    entry.gatewayMethods.length ? `${entry.gatewayMethods.length} gateway` : null,
  ].filter(Boolean) as string[];
}

function pluginStateLabel(entry: PluginMarketplaceEntry) {
  if (entry.status === "error") {
    return "error";
  }
  if (entry.loaded && entry.enabled) {
    return "loaded";
  }
  if (entry.enabled && !entry.loaded) {
    return "restart needed";
  }
  if (entry.managed) {
    return "disabled";
  }
  if (entry.actions.includes("install")) {
    return "available";
  }
  return entry.status;
}

function renderExtensionDetailSection(params: {
  title: string;
  help?: string;
  summary?: unknown;
  open?: boolean;
  content: unknown;
}) {
  return html`
    <details class="extension-detail-section" ?open=${params.open ?? false}>
      <summary class="extension-detail-section__summary">
        <span class="extension-detail-section__title">
          ${params.title}
          ${params.help ? renderExtensionHelp(params.help) : nothing}
        </span>
        ${params.summary ? html`<span class="extension-detail-section__meta">${params.summary}</span>` : nothing}
      </summary>
      <div class="extension-detail-section__body">${params.content}</div>
    </details>
  `;
}

function extensionSortPriority(entry: PluginMarketplaceEntry) {
  if (entry.loaded && entry.enabled) {
    return 0;
  }
  if (entry.loaded) {
    return 1;
  }
  if (entry.enabled) {
    return 2;
  }
  if (entry.status === "error") {
    return 3;
  }
  if (entry.managed || entry.discovered) {
    return 4;
  }
  return 5;
}

function sortExtensions(plugins: PluginMarketplaceEntry[]) {
  return plugins.toSorted((left, right) => {
    const priority = extensionSortPriority(left) - extensionSortPriority(right);
    if (priority !== 0) {
      return priority;
    }
    return left.name.localeCompare(right.name);
  });
}

export function resolveInstallActionChoices(entry: PluginMarketplaceEntry): Array<{
  label: string;
  sourceChoice?: PluginMarketplaceInstallChoice;
  detail?: string;
}> {
  if (!entry.actions.includes("install")) {
    return [];
  }
  const hasLocal = Boolean(
    entry.installOptions.localPath ||
    entry.installOptions.resolvedLocalPath ||
    entry.installOptions.bundledLocalPath,
  );
  const hasNpm = Boolean(entry.installOptions.npmSpec);
  if (hasLocal && hasNpm) {
    return [
      {
        label: "Link local",
        sourceChoice: "local",
        detail:
          entry.installOptions.resolvedLocalPath ??
          entry.installOptions.bundledLocalPath ??
          entry.installOptions.localPath,
      },
      {
        label: "Install npm",
        sourceChoice: "npm",
        detail: entry.installOptions.npmSpec,
      },
    ];
  }
  if (hasLocal) {
    return [
      {
        label: "Link local",
        sourceChoice: "local",
        detail:
          entry.installOptions.resolvedLocalPath ??
          entry.installOptions.bundledLocalPath ??
          entry.installOptions.localPath,
      },
    ];
  }
  if (hasNpm) {
    return [
      {
        label: "Install npm",
        sourceChoice: "npm",
        detail: entry.installOptions.npmSpec,
      },
    ];
  }
  return [{ label: "Install" }];
}

function renderActionButtons(
  props: Pick<PluginsMarketplaceProps, "actionBusy" | "onInstall" | "onUpdate" | "onUninstall">,
  entry: PluginMarketplaceEntry,
) {
  const busy = props.actionBusy;
  const disabled = busy !== null;
  const buttons = [];
  const installChoices = resolveInstallActionChoices(entry);

  for (const choice of installChoices) {
    buttons.push(html`
      <button
        class="btn btn--sm primary"
        ?disabled=${disabled}
        @click=${() => props.onInstall(entry.id, choice.sourceChoice)}
      >
        ${busy === "install" ? "Installing…" : choice.label}
      </button>
    `);
  }
  if (entry.actions.includes("update")) {
    buttons.push(html`
      <button class="btn btn--sm" ?disabled=${disabled} @click=${() => props.onUpdate(entry.id)}>
        ${busy === "update" ? "Updating…" : "Update"}
      </button>
    `);
  }
  if (entry.actions.includes("uninstall")) {
    buttons.push(html`
      <button class="btn btn--sm danger" ?disabled=${disabled} @click=${() => props.onUninstall(entry.id)}>
        ${busy === "uninstall" ? "Uninstalling…" : "Uninstall"}
      </button>
    `);
  }

  if (buttons.length === 0) {
    return nothing;
  }

  return renderExtensionDetailSection({
    title: "Actions",
    summary: html`${buttons.length} action${buttons.length === 1 ? "" : "s"}`,
    content: html`
      <div class="card-sub">Runtime changes still require a gateway restart to fully load or unload code.</div>
      <div class="row" style="gap: 8px; margin-top: 12px; flex-wrap: wrap;">${buttons}</div>
      ${
        installChoices.length > 1
          ? html`
              <div class="callout info" style="margin-top: 12px;">
                Choose how to install this plugin:
                ${installChoices.map(
                  (choice) =>
                    html`<div style="margin-top: 6px;"><strong>${choice.label}:</strong> ${choice.detail ?? "default host install source"}</div>`,
                )}
              </div>
            `
          : nothing
      }
      <div class="callout info" style="margin-top: 12px;">
        Install, update, and uninstall mutate plugin config and files safely, but a restart is still required to refresh the active runtime.
      </div>
    `,
  });
}

export function summarizePluginRuntimeSurface(entry: PluginMarketplaceEntry) {
  return [
    entry.channels.length ? `${entry.channels.length} channels` : null,
    entry.providers.length ? `${entry.providers.length} providers` : null,
    entry.toolNames.length ? `${entry.toolNames.length} tools` : null,
    entry.gatewayMethods.length ? `${entry.gatewayMethods.length} gateway methods` : null,
    entry.runtimeHelpers?.sessions.read ? "session helper" : null,
    (entry.runtimeHelpers?.adminRpcActions?.methods ?? []).some((method) => method.granted)
      ? "admin RPC grant"
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function buildPluginManagementShortcuts(
  entry: PluginMarketplaceEntry,
): PluginManagementShortcut[] {
  const shortcuts = new Map<string, PluginManagementShortcut>();
  const addShortcut = (shortcut: PluginManagementShortcut) => {
    if (!shortcuts.has(shortcut.key)) {
      shortcuts.set(shortcut.key, shortcut);
    }
  };

  if (entry.providers.length > 0) {
    addShortcut({
      key: "providers",
      label: "Open Providers",
      detail: "Manage provider sign-in, auth profiles, and model catalog availability.",
      kind: "tab",
      tab: "providers",
    });
    addShortcut({
      key: "agents",
      label: "Open Agent Models",
      detail: "Choose primary, fallback, and task-role models for each Agent.",
      kind: "tab",
      tab: "agents",
    });
  }
  if (entry.channels.length > 0) {
    addShortcut({
      key: "channels",
      label: "Open Channels",
      detail: "Inspect the live channel cards and account health for this plugin's surfaces.",
      kind: "tab",
      tab: "channels",
    });
  }
  if (entry.services.length > 0) {
    addShortcut({
      key: "services",
      label: "Open Services",
      detail: "Configure API/service credentials exposed by this extension.",
      kind: "tab",
      tab: "services",
    });
  }
  if (entry.gatewayMethods.length > 0 || entry.httpHandlers > 0) {
    addShortcut({
      key: "debug",
      label: "Open Debug",
      detail: "Inspect guarded gateway/runtime diagnostics for this extension surface.",
      kind: "tab",
      tab: "debug",
    });
  }
  if (entry.toolNames.length > 0) {
    addShortcut({
      key: "tools",
      label: "Open Agent Tools",
      detail: "Grant or block this extension's tools per Agent.",
      kind: "tab",
      tab: "agents",
    });
  }
  return [...shortcuts.values()];
}

export function resolvePluginInstallSourceDetail(entry: PluginMarketplaceEntry) {
  if (entry.install?.source === "npm") {
    return entry.install.spec ?? entry.installOptions.npmSpec ?? "npm";
  }
  if (entry.install?.source === "path") {
    return (
      entry.install.sourcePath ??
      entry.installOptions.resolvedLocalPath ??
      entry.installOptions.bundledLocalPath ??
      entry.installOptions.localPath ??
      "path"
    );
  }
  return (
    entry.installOptions.resolvedLocalPath ??
    entry.installOptions.bundledLocalPath ??
    entry.installOptions.localPath ??
    entry.installOptions.npmSpec ??
    null
  );
}

export function summarizePluginOperationalState(entry: PluginMarketplaceEntry): string[] {
  const lines: string[] = [];

  if (entry.status === "error") {
    lines.push(
      entry.error?.trim()
        ? `Plugin load failed during the last runtime refresh: ${entry.error.trim()}`
        : "Plugin load failed during the last runtime refresh.",
    );
  } else if (entry.loaded) {
    lines.push("Plugin runtime is loaded in the current gateway process.");
  } else if (entry.managed && entry.enabled) {
    lines.push(
      "Plugin is configured and enabled, but the active runtime still needs a reload to pick it up.",
    );
  } else if (entry.managed) {
    lines.push("Plugin is managed by this host but currently disabled.");
  } else if (entry.actions.includes("install")) {
    lines.push("Plugin is available to install but is not yet managed by this host.");
  } else if (entry.discovered) {
    lines.push("Plugin was discovered from manifests or channel catalog metadata only.");
  }

  if (entry.install?.source === "npm") {
    lines.push("Installed from npm and can be updated in place from the Plugins tab.");
  } else if (entry.install?.source === "path") {
    lines.push("Linked from a local path, so updates come from the checked-out source tree.");
  }

  if (entry.providers.length > 0) {
    lines.push(
      `Exposes ${entry.providers.length} provider surface${
        entry.providers.length === 1 ? "" : "s"
      } that may need auth and model routing.`,
    );
  }
  if (entry.channels.length > 0) {
    lines.push(
      `Exposes ${entry.channels.length} channel surface${
        entry.channels.length === 1 ? "" : "s"
      } that show up in Channels.`,
    );
  }

  const runtimeSurfaces = [
    entry.toolNames.length > 0 ? `${entry.toolNames.length} tools` : null,
    entry.gatewayMethods.length > 0 ? `${entry.gatewayMethods.length} gateway methods` : null,
    entry.hookCount > 0 ? `${entry.hookCount} hooks` : null,
  ].filter(Boolean);
  if (runtimeSurfaces.length > 0) {
    lines.push(`Adds runtime control surfaces across ${runtimeSurfaces.join(", ")}.`);
  }

  return lines;
}

export function buildPluginConfigurationNotes(
  entry: PluginMarketplaceEntry,
): PluginConfigurationNote[] {
  const notes: PluginConfigurationNote[] = [
    {
      label: "Install path",
      detail:
        resolvePluginInstallSourceDetail(entry) ??
        "No resolved npm or local source was advertised for this plugin yet.",
    },
    {
      label: "Restart behavior",
      detail:
        entry.managed || entry.actions.some((action) => action !== "status")
          ? "Install, update, or uninstall changes are safe here, but the gateway still needs a restart to fully refresh runtime code."
          : "This plugin is currently read-only from the marketplace view.",
    },
  ];

  if (entry.channelCatalog?.docsPath) {
    notes.push({
      label: entry.channelCatalog.docsLabel?.trim() || "Docs",
      detail: entry.channelCatalog.docsPath,
    });
  }
  if (entry.providers.length > 0) {
    notes.push({
      label: "Provider config",
      detail: "Use Providers for auth profiles and Agent > Models for model routing.",
    });
  }
  if (entry.channels.length > 0) {
    notes.push({
      label: "Channel setup",
      detail: "Use Channels to inspect live accounts and channel-specific health for this plugin.",
    });
  }
  if (entry.gatewayMethods.length > 0 || entry.httpHandlers > 0) {
    notes.push({
      label: "Gateway surface",
      detail:
        "Use Debug for runtime health. Raw Advanced Config is for emergency gateway fields only.",
    });
  }
  if (entry.toolNames.length > 0 || entry.hookCount > 0) {
    notes.push({
      label: "Tools and hooks",
      detail:
        "Use Agent > Tools for tool policy. Hook packs and lifecycle integrations stay visible here in Extensions.",
    });
  }

  return notes;
}

export function filterPluginDiagnostics(
  diagnostics: PluginMarketplaceDiagnostic[],
  selectedId: string | null,
) {
  return diagnostics.filter((diagnostic) => {
    if (!selectedId) {
      return true;
    }
    return diagnostic.pluginId === selectedId;
  });
}

export function filterGlobalPluginDiagnostics(diagnostics: PluginMarketplaceDiagnostic[]) {
  return diagnostics.filter((diagnostic) => !diagnostic.pluginId);
}

export function summarizePluginDiagnosticsOverview(
  diagnostics: PluginMarketplaceDiagnostic[],
  selectedId: string | null,
): PluginDiagnosticsOverview {
  const relevant = filterPluginDiagnostics(diagnostics, selectedId);
  return {
    warnings: relevant.filter((diagnostic) => diagnostic.level === "warn").length,
    errors: relevant.filter((diagnostic) => diagnostic.level === "error").length,
    primary:
      relevant.find((diagnostic) => diagnostic.level === "error")?.message ??
      relevant[0]?.message ??
      null,
  };
}

export function filterPluginRuntimeHelperDiagnostics(
  diagnostics: PluginMarketplaceDiagnostic[],
  selectedId: string | null,
) {
  return filterPluginDiagnostics(diagnostics, selectedId).filter((diagnostic) =>
    diagnostic.message.startsWith("runtime session helper denied:"),
  );
}

export function filterPluginAdminRpcDiagnostics(
  diagnostics: PluginMarketplaceDiagnostic[],
  selectedId: string | null,
) {
  return filterPluginDiagnostics(diagnostics, selectedId).filter((diagnostic) =>
    diagnostic.message.startsWith("runtime admin RPC "),
  );
}

export function summarizePluginRuntimeHelpers(
  entry: PluginMarketplaceEntry,
  diagnostics: PluginMarketplaceDiagnostic[],
): PluginRuntimeHelperOverview {
  const adminMethods = entry.runtimeHelpers?.adminRpcActions?.methods ?? [];
  return {
    sessionsRead: entry.runtimeHelpers?.sessions.read === true,
    adminRpcGranted: adminMethods.filter((method) => method.granted).length,
    deniedDiagnostics: filterPluginRuntimeHelperDiagnostics(diagnostics, entry.id),
    adminRpcDiagnostics: filterPluginAdminRpcDiagnostics(diagnostics, entry.id),
  };
}

export function shouldShowPluginRestartAction(
  entry: PluginMarketplaceEntry,
  remediation: PluginsMarketplaceRemediationState | null,
): boolean {
  if (remediation?.pluginId === entry.id && remediation.action === "restart") {
    return false;
  }
  if (
    remediation?.pluginId === entry.id &&
    remediation.action !== "restart" &&
    remediation.requiresRestart
  ) {
    return true;
  }
  return entry.status === "error" || (entry.managed && entry.enabled && !entry.loaded);
}

export function buildPluginRemediationState(
  entry: PluginMarketplaceEntry,
  diagnostics: PluginMarketplaceDiagnostic[],
  remediation: PluginsMarketplaceRemediationState | null,
): PluginRemediationState | null {
  const overview = summarizePluginDiagnosticsOverview(diagnostics, entry.id);
  if (remediation?.pluginId === entry.id) {
    if (remediation.action === "restart") {
      return {
        severity: "info",
        title: "Restart scheduled",
        detail: remediation.message,
      };
    }
    if (remediation.requiresRestart) {
      return {
        severity: "warn",
        title: "Restart required",
        detail: `${remediation.message} Restart the gateway runtime to make this plugin change live.`,
      };
    }
  }
  if (entry.status === "error") {
    return {
      severity: "danger",
      title: "Plugin failed to load",
      detail:
        entry.error?.trim() ||
        overview.primary ||
        "The plugin reported a runtime load failure during the last refresh.",
    };
  }
  if (entry.managed && entry.enabled && !entry.loaded) {
    return {
      severity: "warn",
      title: "Runtime reload pending",
      detail: "This plugin is configured, but the active gateway process has not loaded it yet.",
    };
  }
  if (overview.errors > 0 || overview.warnings > 0) {
    return {
      severity: overview.errors > 0 ? "danger" : "info",
      title:
        overview.errors > 0 ? "Plugin diagnostics need attention" : "Plugin diagnostics reported",
      detail: overview.primary || "Review the current diagnostics for this plugin.",
    };
  }
  return null;
}

export function buildPluginRemediationNotes(
  entry: PluginMarketplaceEntry,
  diagnostics: PluginMarketplaceDiagnostic[],
  remediation: PluginsMarketplaceRemediationState | null,
): string[] {
  const notes: string[] = [];
  const overview = summarizePluginDiagnosticsOverview(diagnostics, entry.id);

  if (
    remediation?.pluginId === entry.id &&
    remediation.action !== "restart" &&
    remediation.requiresRestart
  ) {
    notes.push(
      "Restart the gateway runtime once so install, update, or uninstall changes take effect.",
    );
  }
  if (remediation?.pluginId === entry.id && remediation.action === "restart") {
    notes.push(
      "Wait for the control UI to reconnect, then refresh this plugin detail pane to confirm the new runtime state.",
    );
  }
  if (entry.status === "error") {
    notes.push(
      "If the plugin still fails after restart, review Install detail, Docs path, and the Diagnostics list below.",
    );
  }
  if ((overview.errors > 0 || overview.warnings > 0) && remediation?.action !== "restart") {
    notes.push(
      "Refresh this plugin after any restart to confirm whether the current diagnostics cleared.",
    );
  }
  if (entry.providers.length > 0) {
    notes.push(
      "If this plugin depends on providers, re-check Providers and Agent > Models after restart.",
    );
  }
  if (entry.channels.length > 0) {
    notes.push(
      "If channel surfaces still look stale after restart, inspect Channels health for this plugin.",
    );
  }
  return notes;
}

function renderEntrySummary(
  props: PluginsMarketplaceProps,
  entry: PluginMarketplaceEntry,
  selected: boolean,
  diagnostics: PluginMarketplaceDiagnostic[],
) {
  const runtimeSummary = summarizePluginRuntimeSurface(entry);
  const overview = summarizePluginDiagnosticsOverview(diagnostics, entry.id);
  const dotClass =
    entry.status === "error" || overview.errors > 0
      ? "warn"
      : entry.loaded || entry.enabled
        ? "ok"
        : entry.managed
          ? "warn"
          : "";
  const detail = entry.description || runtimeSummary || "No runtime surfaces registered yet.";
  const surfaceCounts = pluginSurfaceCounts(entry);

  return html`
    <details
      class="extensions-plugin"
      ?open=${selected}
      data-plugin-card=${entry.id}
      @toggle=${(event: Event) => {
        const details = event.currentTarget as HTMLDetailsElement;
        if (details.open && !selected) {
          props.onSelect(entry.id);
        } else if (!details.open && selected) {
          props.onSelect("");
        }
      }}
    >
      <summary class="extensions-plugin__summary">
        <div class="extensions-plugin__main">
          <span
            class="extensions-plugin__dot ${dotClass}"
            title=${entry.status}
            aria-hidden="true"
          ></span>
          <div>
            <div class="extensions-plugin__name">${entry.name}</div>
            <div class="extensions-plugin__detail">${detail}</div>
          </div>
        </div>
        <div class="extensions-plugin__status">
          <span class="extension-status-text">${pluginStateLabel(entry)}</span>
          ${surfaceCounts.slice(0, 3).map((item) => html`<span class="extension-status-text">${item}</span>`)}
          ${
            overview.errors > 0
              ? html`<span class="extension-status-text warn">${overview.errors} errors</span>`
              : overview.warnings > 0
                ? html`<span class="extension-status-text warn">${overview.warnings} warnings</span>`
                : nothing
          }
        </div>
      </summary>
      <div class="extensions-plugin__body">
        ${
          selected && props.detailLoading
            ? html`
                <span class="chip">Loading details...</span>
              `
            : nothing
        }
        ${renderPluginExpanded(props, entry, diagnostics)}
      </div>
    </details>
  `;
}

function renderFact(label: string, value: unknown) {
  if (value == null || value === "") {
    return nothing;
  }
  let text = "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    text = `${value}`;
  } else {
    text = JSON.stringify(value);
  }
  return html`
    <div class="extension-mini-card">
      <div class="extension-mini-card__label">${label}</div>
      <div class="extension-mini-card__value">${text}</div>
    </div>
  `;
}

function renderSurfaceCard(params: {
  label: string;
  values: string[] | undefined;
  emptyLabel: string;
  action?: unknown;
}) {
  const list = params.values?.filter(Boolean) ?? [];
  if (list.length === 0 && !params.action) {
    return nothing;
  }
  return html`
    <div class="extension-surface-card">
      <div class="extension-surface-card__head">
        <div class="extension-mini-card__label">${params.label}</div>
        ${params.action ?? nothing}
      </div>
      ${
        list.length === 0
          ? html`<div class="muted" style="margin-top: 8px;">${params.emptyLabel}</div>`
          : html`
              <div class="chip-row" style="margin-top: 8px;">
                ${list.map((value) => html`<span class="chip">${value}</span>`)}
              </div>
            `
      }
    </div>
  `;
}

function renderSurfaceGroups(
  props: Pick<PluginsMarketplaceProps, "onOpenChannels">,
  entry: PluginMarketplaceEntry,
) {
  const groups = [
    renderSurfaceCard({
      label: "Channels",
      values: entry.channels,
      emptyLabel: "No channel integrations declared.",
      action:
        entry.channels.length > 0
          ? html`<button class="btn btn--sm" @click=${props.onOpenChannels}>Open Channels</button>`
          : nothing,
    }),
    renderSurfaceCard({
      label: "Providers",
      values: entry.providers,
      emptyLabel: "No providers declared.",
    }),
    renderSurfaceCard({
      label: "Tools",
      values: entry.toolNames,
      emptyLabel: "No tools declared.",
    }),
    renderSurfaceCard({
      label: "Hooks",
      values: entry.hookNames,
      emptyLabel: "No hooks declared.",
    }),
    renderSurfaceCard({
      label: "Gateway Methods",
      values: entry.gatewayMethods,
      emptyLabel: "No gateway methods declared.",
    }),
    renderSurfaceCard({
      label: "CLI Commands",
      values: entry.cliCommands,
      emptyLabel: "No CLI commands declared.",
    }),
    renderSurfaceCard({
      label: "Services",
      values: entry.services,
      emptyLabel: "No services declared.",
    }),
    renderSurfaceCard({
      label: "Commands",
      values: entry.commands,
      emptyLabel: "No command surfaces declared.",
    }),
  ].filter((value) => value !== nothing);

  return renderExtensionDetailSection({
    title: "Extension Surface",
    help: "Runtime surfaces exposed by this extension. Channel accounts stay in Channels; Agent tool policy stays in Agent > Tools.",
    summary: html`${groups.length} surface group${groups.length === 1 ? "" : "s"}`,
    content: html`
      ${
        groups.length === 0
          ? html`
              <div class="muted">No runtime surfaces registered yet.</div>
            `
          : html`<div class="extension-surface-grid">${groups}</div>`
      }
    `,
  });
}

function renderDiagnostics(
  diagnostics: PluginMarketplaceDiagnostic[],
  selectedId: string | null,
  emptyLabel: string,
) {
  const relevant = filterPluginDiagnostics(diagnostics, selectedId);
  return renderExtensionDetailSection({
    title: "Diagnostics",
    summary: html`${relevant.length} finding${relevant.length === 1 ? "" : "s"}`,
    content: html`
      ${
        relevant.length === 0
          ? html`<div class="muted">${emptyLabel}</div>`
          : html`
            <div class="list">
              ${relevant.map(
                (diagnostic) => html`
                  <div class="list-item">
                    <div class="list-main">
                      <div class="list-title">${diagnostic.message}</div>
                      <div class="list-sub">
                        ${diagnostic.level}
                        ${diagnostic.source ? html` · ${diagnostic.source}` : nothing}
                        ${diagnostic.pluginId ? html` · ${diagnostic.pluginId}` : nothing}
                      </div>
                    </div>
                  </div>
                `,
              )}
            </div>
          `
      }
    `,
  });
}

function renderGlobalDiagnostics(diagnostics: PluginMarketplaceDiagnostic[]) {
  const globalDiagnostics = filterGlobalPluginDiagnostics(diagnostics);
  if (globalDiagnostics.length === 0) {
    return nothing;
  }
  return html`
    <div class="extension-global-diagnostics">
      <div class="extension-global-diagnostics__title">Global diagnostics</div>
      <div class="extension-note-grid">
        ${globalDiagnostics.map(
          (diagnostic) => html`
            <div class="extension-note-card ${diagnostic.level === "error" ? "danger" : "warn"}">
              <span class="extensions-plugin__dot ${diagnostic.level === "error" ? "warn" : ""}" aria-hidden="true"></span>
              <span>${diagnostic.message}</span>
            </div>
          `,
        )}
      </div>
    </div>
  `;
}

function renderRuntimeHelpers(
  props: Pick<
    PluginsMarketplaceProps,
    "actionBusy" | "onSetSessionHelperGrant" | "onSetAdminRpcGrant"
  >,
  entry: PluginMarketplaceEntry,
  diagnostics: PluginMarketplaceDiagnostic[],
) {
  const helper = summarizePluginRuntimeHelpers(entry, diagnostics);
  const deniedCount = helper.deniedDiagnostics.length;
  const adminDiagnosticsCount = helper.adminRpcDiagnostics.length;
  const adminRpcActions = entry.runtimeHelpers?.adminRpcActions;
  const adminRpcMethods = adminRpcActions?.methods ?? [];
  const adminSourceKeys = adminRpcActions?.sourceKeys ?? [];
  const sessionDetail = helper.sessionsRead
    ? "This plugin can read sanitized session metadata/status through runtime.helpers.sessions."
    : "No session helper grant is configured. Calls to runtime.helpers.sessions are denied and audited.";

  return renderExtensionDetailSection({
    title: "Runtime Helpers",
    help: "Permission-gated helper surfaces exposed to this plugin runtime.",
    summary: html`${helper.adminRpcGranted} admin grants`,
    content: html`
      <div class="extension-mini-grid">
        ${renderFact("Denied helper calls", deniedCount)}
        ${renderFact("Admin RPC grants", helper.adminRpcGranted)}
        ${renderFact("Admin RPC audit events", adminDiagnosticsCount)}
      </div>
      <div class="extension-toggle-row">
        <div>
          <div class="list-title">Session helper</div>
          <div class="list-sub">${sessionDetail}</div>
        </div>
        <label class="cfg-toggle">
          <input
            type="checkbox"
            .checked=${helper.sessionsRead}
            ?disabled=${props.actionBusy !== null}
            @change=${() => props.onSetSessionHelperGrant(entry.id, !helper.sessionsRead)}
          />
          <span class="cfg-toggle__track"></span>
        </label>
      </div>
      <div style="margin-top: 14px; padding-top: 12px; border-top: 1px solid rgba(148,163,184,0.22);">
        <div class="card-title">Admin RPC Grants</div>
        <div class="card-sub">
          Fixed admin/write wrappers only. These grants do not expose a generic gateway dispatcher.
        </div>
        ${
          adminRpcMethods.length === 0
            ? html`
                <div class="muted" style="margin-top: 8px">
                  No admin RPC grant metadata reported for this plugin.
                </div>
              `
            : html`
                <div class="list" style="margin-top: 10px;">
                  ${adminRpcMethods.map((grant) =>
                    renderAdminRpcGrantRow(props, entry, grant, adminSourceKeys),
                  )}
                </div>
              `
        }
        <div class="callout warn" style="margin-top: 12px;">
          Enable only when the plugin source is trusted. Calls still require operator approval,
          runtime audit, and mutating-admin rate limits.
        </div>
        ${
          adminDiagnosticsCount > 0
            ? html`
                <div class="list" style="margin-top: 12px;">
                  ${helper.adminRpcDiagnostics.map(
                    (diagnostic) => html`
                      <div class="list-item">
                        <div class="list-main">
                          <div class="list-title">${diagnostic.message}</div>
                          <div class="list-sub">
                            ${diagnostic.level}
                            ${diagnostic.source ? html` · ${diagnostic.source}` : nothing}
                          </div>
                        </div>
                      </div>
                    `,
                  )}
                </div>
              `
            : nothing
        }
      </div>
      ${
        deniedCount > 0
          ? html`
              <div class="list" style="margin-top: 12px;">
                ${helper.deniedDiagnostics.map(
                  (diagnostic) => html`
                    <div class="list-item">
                      <div class="list-main">
                        <div class="list-title">${diagnostic.message}</div>
                        <div class="list-sub">
                          ${diagnostic.level}
                          ${diagnostic.source ? html` · ${diagnostic.source}` : nothing}
                        </div>
                      </div>
                    </div>
                  `,
                )}
              </div>
            `
          : nothing
      }
    `,
  });
}

function renderAdminRpcGrantRow(
  props: Pick<PluginsMarketplaceProps, "actionBusy" | "onSetAdminRpcGrant">,
  entry: PluginMarketplaceEntry,
  grant: PluginMarketplaceAdminRpcActionGrantStatus,
  sourceKeys: string[],
) {
  const canEnable = sourceKeys.length > 0;
  const disabled = props.actionBusy !== null || (!grant.granted && !canEnable);
  return html`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">${grant.method}</div>
        <div class="list-sub">
          ${grant.granted ? "configured" : "not granted"}
          ${grant.requireOperatorApproval ? " · operator approval required" : ""}
          ${grant.reason ? html` · ${grant.reason}` : nothing}
        </div>
        ${
          grant.sources.length > 0
            ? html`
                <div class="chip-row" style="margin-top: 8px;">
                  ${grant.sources.map((source) => html`<span class="chip">${source}</span>`)}
                </div>
              `
            : nothing
        }
      </div>
      <div class="list-meta" style="display: grid; gap: 8px; justify-items: end;">
        <label
          class="cfg-toggle"
          title=${!canEnable && !grant.granted ? "No trusted source keys are available for this plugin." : ""}
        >
          <input
            type="checkbox"
            .checked=${grant.granted}
            ?disabled=${disabled}
            @change=${() => props.onSetAdminRpcGrant(entry.id, grant.method, !grant.granted)}
          />
          <span class="cfg-toggle__track"></span>
        </label>
      </div>
    </div>
  `;
}

function renderOperationalOverview(
  entry: PluginMarketplaceEntry,
  diagnostics: PluginMarketplaceDiagnostic[],
) {
  const lines = summarizePluginOperationalState(entry);
  const overview = summarizePluginDiagnosticsOverview(diagnostics, entry.id);

  return renderExtensionDetailSection({
    title: "Runtime Status",
    summary: html`${overview.warnings} warnings · ${overview.errors} errors`,
    content: html`
      <div class="extension-mini-grid">
        ${renderFact("Warnings", overview.warnings)}
        ${renderFact("Errors", overview.errors)}
        ${renderFact("Loaded now", entry.loaded ? "yes" : "no")}
        ${renderFact("Managed", entry.managed ? "yes" : "no")}
      </div>
      ${
        entry.error
          ? html`<div class="callout danger" style="margin-top: 12px;">${entry.error}</div>`
          : nothing
      }
      ${
        overview.primary
          ? html`
              <div class=${overview.errors > 0 ? "callout danger" : "callout info"} style="margin-top: 12px;">
                ${overview.primary}
              </div>
            `
          : nothing
      }
      ${
        lines.length > 0
          ? html`
              <div class="extension-note-grid" style="margin-top: 12px;">
                ${lines.map(
                  (line) => html`
                    <div class="extension-note-card">${line}</div>
                  `,
                )}
              </div>
            `
          : nothing
      }
    `,
  });
}

function renderRemediationPanel(
  props: Pick<
    PluginsMarketplaceProps,
    "actionBusy" | "onRefresh" | "onRestartRuntime" | "remediation"
  >,
  entry: PluginMarketplaceEntry,
  diagnostics: PluginMarketplaceDiagnostic[],
) {
  const remediation = props.remediation?.pluginId === entry.id ? props.remediation : null;
  const state = buildPluginRemediationState(entry, diagnostics, remediation);
  const notes = buildPluginRemediationNotes(entry, diagnostics, remediation);
  const canRestart = shouldShowPluginRestartAction(entry, remediation);
  const updateReview = remediation?.updateReview;

  if (!state && notes.length === 0 && !canRestart && !updateReview) {
    return nothing;
  }

  const calloutClass =
    state?.severity === "danger"
      ? "callout danger"
      : state?.severity === "warn"
        ? "callout info"
        : state?.severity === "success"
          ? "callout success"
          : "callout info";

  return renderExtensionDetailSection({
    title: "Restart and Remediation",
    summary: state?.title ?? (canRestart ? "restart available" : null),
    content: html`
      <div class="card-sub">Use this when plugin code changed or the runtime state does not match config yet.</div>
      ${
        state
          ? html`
              <div class=${calloutClass} style="margin-top: 12px;">
                <strong>${state.title}:</strong> ${state.detail}
              </div>
            `
          : nothing
      }
      <div class="row" style="gap: 8px; margin-top: 12px; flex-wrap: wrap;">
        ${
          canRestart
            ? html`
                <button
                  class="btn btn--sm primary"
                  ?disabled=${props.actionBusy !== null}
                  @click=${() => props.onRestartRuntime(entry.id)}
                >
                  ${props.actionBusy === "restart" ? "Restarting…" : "Restart gateway now"}
                </button>
              `
            : nothing
        }
        <button class="btn btn--sm" ?disabled=${props.actionBusy !== null} @click=${props.onRefresh}>
          Refresh details
        </button>
      </div>
      ${
        updateReview
          ? html`
              <div class="callout ${updateReview.approvalRequired ? "warning" : "info"}" style="margin-top: 12px;">
                <strong>Update review:</strong>
                ${
                  updateReview.approvalRequired
                    ? "explicit approval was required for this update."
                    : "no risky update approval was required."
                }
                <div class="muted" style="margin-top: 6px;">
                  Source ${updateReview.sourceTrust.source}${
                    updateReview.sourceTrust.spec ? ` · ${updateReview.sourceTrust.spec}` : ""
                  } · ${updateReview.sourceTrust.reason}
                </div>
                ${
                  updateReview.reasons.length > 0
                    ? html`
                        <div class="chip-row" style="margin-top: 8px;">
                          ${updateReview.reasons.map((reason) => html`<span class="chip chip-warn">${reason}</span>`)}
                        </div>
                      `
                    : nothing
                }
                ${
                  updateReview.permissionDiff.added.channels.length +
                    updateReview.permissionDiff.added.providers.length +
                    updateReview.permissionDiff.added.tools.length +
                    updateReview.permissionDiff.added.skills.length >
                  0
                    ? html`
                        <div class="muted" style="margin-top: 8px;">
                          Added surfaces:
                          ${[
                            ...updateReview.permissionDiff.added.channels.map(
                              (value) => `channel:${value}`,
                            ),
                            ...updateReview.permissionDiff.added.providers.map(
                              (value) => `provider:${value}`,
                            ),
                            ...updateReview.permissionDiff.added.tools.map(
                              (value) => `tool:${value}`,
                            ),
                            ...updateReview.permissionDiff.added.skills.map(
                              (value) => `skill:${value}`,
                            ),
                          ].join(", ")}
                        </div>
                      `
                    : nothing
                }
              </div>
            `
          : nothing
      }
      ${
        notes.length > 0
          ? html`
              <div class="list" style="margin-top: 12px;">
                ${notes.map(
                  (note) => html`
                    <div class="list-item">
                      <div class="list-main">
                        <div class="list-title">${note}</div>
                      </div>
                    </div>
                  `,
                )}
              </div>
            `
          : nothing
      }
    `,
  });
}

function renderManagementShortcuts(
  props: Pick<PluginsMarketplaceProps, "onOpenConfigSection" | "onOpenTab">,
  entry: PluginMarketplaceEntry,
) {
  const shortcuts = buildPluginManagementShortcuts(entry);
  if (shortcuts.length === 0) {
    return nothing;
  }
  return renderExtensionDetailSection({
    title: "Setup Shortcuts",
    summary: html`${shortcuts.length} link${shortcuts.length === 1 ? "" : "s"}`,
    content: html`
      <div class="card-sub">Jump directly into the existing surfaces that manage this plugin.</div>
      <div style="display: grid; gap: 10px; margin-top: 12px;">
        ${shortcuts.map(
          (shortcut) => html`
            <div class="list-item">
              <div class="list-main">
                <div class="list-title">${shortcut.label}</div>
                <div class="list-sub">${shortcut.detail}</div>
              </div>
              <div class="list-meta">
                <button
                  class="btn btn--sm"
                  @click=${() => {
                    if (shortcut.kind === "tab" && shortcut.tab) {
                      props.onOpenTab(shortcut.tab);
                      return;
                    }
                    if (shortcut.section) {
                      props.onOpenConfigSection(shortcut.section);
                    }
                  }}
                >
                  Open
                </button>
              </div>
            </div>
          `,
        )}
      </div>
    `,
  });
}

function hookStatusLabel(hook: ExtensionHookStatusEntry) {
  if (hook.managedByPlugin) {
    return hook.eligible ? "plugin managed" : "plugin missing";
  }
  if (hook.disabled) {
    return "disabled";
  }
  if (hook.eligible) {
    return "enabled";
  }
  return "missing";
}

function hookStatusClass(hook: ExtensionHookStatusEntry) {
  if (hook.managedByPlugin && hook.eligible) {
    return "chip";
  }
  if (hook.disabled) {
    return "chip";
  }
  if (hook.eligible) {
    return "chip chip-ok";
  }
  return "chip chip-warn";
}

function hookDotClass(hook: ExtensionHookStatusEntry) {
  if (hook.disabled) {
    return "";
  }
  if (hook.eligible) {
    return "ok";
  }
  return "warn";
}

function summarizeHookCounts(hooks: ExtensionHookStatusEntry[]) {
  return {
    total: hooks.length,
    enabled: hooks.filter((hook) => !hook.managedByPlugin && hook.eligible && !hook.disabled)
      .length,
    disabled: hooks.filter((hook) => hook.disabled).length,
    missing: hooks.filter((hook) => !hook.eligible && !hook.disabled).length,
    managed: hooks.filter((hook) => hook.managedByPlugin).length,
  };
}

function renderHookRow(
  props: Pick<PluginsMarketplaceProps, "hooksBusyKey" | "onSetHookEnabled">,
  hook: ExtensionHookStatusEntry,
) {
  const busy = props.hooksBusyKey === hook.name || props.hooksBusyKey === hook.hookKey;
  const canToggle = !hook.managedByPlugin;
  const enableNext = hook.disabled;
  const missing = hook.missing.join(", ");
  const events = hook.events.length > 0 ? hook.events.join(", ") : "lifecycle";

  return html`
    <div class="list-item extension-hook-row">
      <div class="list-main">
        <div class="extension-hook-row__title">
          <span class="extensions-plugin__dot ${hookDotClass(hook)}" aria-hidden="true"></span>
          <div>
            <div class="list-title">
              ${hook.emoji ? html`${hook.emoji} ` : nothing}${hook.name}
            </div>
            <div class="list-sub">
              ${events}
              ${hook.pluginId ? html` · plugin ${hook.pluginId}` : html` · ${hook.source}`}
            </div>
          </div>
        </div>
        ${
          hook.description
            ? html`<div class="muted" style="margin-top: 6px;">${hook.description}</div>`
            : nothing
        }
        ${
          missing
            ? html`<div class="muted" style="margin-top: 6px;">Missing ${missing}</div>`
            : nothing
        }
      </div>
      <div class="list-meta" style="display: grid; gap: 8px; justify-items: end;">
        <span class=${hookStatusClass(hook)}>${hookStatusLabel(hook)}</span>
        ${
          canToggle
            ? html`
                <label
                  class="cfg-toggle"
                  title=${busy ? "Saving hook state" : enableNext ? "Enable hook" : "Disable hook"}
                >
                  <input
                    type="checkbox"
                    .checked=${!enableNext}
                    ?disabled=${props.hooksBusyKey !== null}
                    @change=${() => props.onSetHookEnabled(hook.hookKey, enableNext)}
                  />
                  <span class="cfg-toggle__track"></span>
                </label>
                <span
                  class="sr-only"
                  role="status"
                >
                  ${busy ? "Saving hook state" : ""}
                </span>
              `
            : html`
                <span
                  class="muted"
                  data-tooltip="This hook is declared by a loaded plugin. Enable, disable, update, or remove the owning plugin from its extension row."
                >
                  plugin managed
                </span>
              `
        }
      </div>
    </div>
  `;
}

function renderExtensionsHooksCard(props: PluginsMarketplaceProps) {
  const hooks = props.hooksStatus?.hooks ?? [];
  const counts = summarizeHookCounts(hooks);

  return html`
    <section class="card">
        <div class="row" style="justify-content: space-between; gap: 12px; align-items: center;">
          <div class="chip-row">
            <span class="chip">${counts.total} hooks</span>
            ${counts.enabled > 0 ? html`<span class="chip chip-ok">${counts.enabled} enabled</span>` : nothing}
            ${counts.disabled > 0 ? html`<span class="chip">${counts.disabled} disabled</span>` : nothing}
            ${counts.missing > 0 ? html`<span class="chip chip-warn">${counts.missing} missing</span>` : nothing}
            ${counts.managed > 0 ? html`<span class="chip">${counts.managed} plugin-managed</span>` : nothing}
          </div>
          <button class="btn btn--sm" ?disabled=${props.hooksLoading} @click=${props.onHooksRefresh}>
            ${props.hooksLoading ? "Refreshing..." : "Refresh"}
          </button>
        </div>
        ${props.hooksError ? html`<div class="callout danger" style="margin-top: 12px;">${props.hooksError}</div>` : nothing}
        ${
          props.hooksMessage
            ? html`<div class="callout success" style="margin-top: 12px;">${props.hooksMessage}</div>`
            : nothing
        }
        ${
          hooks.length === 0
            ? html`
                <div class="muted" style="margin-top: 12px;">
                  ${props.hooksLoading ? "Loading hooks..." : "No hooks were discovered."}
                </div>
              `
            : html`
                <div class="list" style="margin-top: 12px;">
                  ${hooks.map((hook) => renderHookRow(props, hook))}
                </div>
              `
        }
    </section>
  `;
}

function renderPluginExpanded(
  props: PluginsMarketplaceProps,
  entry: PluginMarketplaceEntry,
  diagnostics: PluginMarketplaceDiagnostic[],
) {
  const surfaceCounts = pluginSurfaceCounts(entry);
  return html`
    <section class="card extension-state-card">
      <div class="extension-state-card__row">
        <div>
          <div class="extension-state-card__label">State</div>
          <div class="extension-status-list">
            <span class="extension-status-text">${pluginStateLabel(entry)}</span>
            ${
              entry.managed
                ? html`
                    <span class="extension-status-text">managed</span>
                  `
                : entry.actions.includes("install")
                  ? html`
                      <span class="extension-status-text">installable</span>
                    `
                  : nothing
            }
            ${surfaceCounts.slice(0, 4).map((item) => html`<span class="extension-status-text">${item}</span>`)}
          </div>
        </div>
        ${
          entry.description
            ? html`<div class="extension-state-card__description">${entry.description}</div>`
            : nothing
        }
      </div>
    </section>

    ${renderOperationalOverview(entry, diagnostics)}
    ${renderRuntimeHelpers(props, entry, diagnostics)}
    ${renderRemediationPanel(props, entry, diagnostics)}
    ${renderActionButtons(props, entry)}
    ${renderManagementShortcuts(props, entry)}
    ${renderSurfaceGroups(props, entry)}

    ${renderExtensionDetailSection({
      title: "Install and Source",
      summary:
        entry.origin ?? entry.install?.source ?? entry.installOptions.defaultChoice ?? "source",
      content: html`
        <div class="extension-facts">
          ${renderFact("Origin", entry.origin ?? "-")}
          ${renderFact("Kind", entry.kind ?? "-")}
          ${renderFact("Source", entry.source ?? "-")}
          ${renderFact("HTTP handlers", entry.httpHandlers)}
          ${renderFact("Hooks", entry.hookCount)}
          ${renderFact("Install source", entry.install?.source ?? entry.installOptions.defaultChoice ?? "-")}
          ${renderFact("Install detail", resolvePluginInstallSourceDetail(entry) ?? "-")}
          ${renderFact("Docs path", entry.channelCatalog?.docsPath ?? "-")}
        </div>
      `,
    })}

    ${
      entry.install
        ? renderExtensionDetailSection({
            title: "Install Record",
            summary: entry.install.source,
            content: html`
              <div class="extension-facts">
                ${renderFact("Method", entry.install.source)}
                ${renderFact("Spec", entry.install.spec)}
                ${renderFact("Version", entry.install.version)}
                ${renderFact("Installed", entry.install.installedAt)}
                ${renderFact("Resolved", entry.install.resolvedAt)}
              </div>
            `,
          })
        : nothing
    }

    ${renderDiagnostics(diagnostics, entry.id, "No diagnostics for this plugin right now.")}
  `;
}

export function renderPluginsMarketplace(props: PluginsMarketplaceProps) {
  const plugins = sortExtensions(props.report?.plugins ?? []);
  const diagnostics = props.detail?.diagnostics ?? props.report?.diagnostics ?? [];
  const reportDiagnostics = props.report?.diagnostics ?? [];
  const activeCount =
    props.report?.plugins.filter((entry) => entry.loaded || entry.enabled).length ?? 0;

  return html`
    <section class="surface-stack">
      <style>
        .extensions-list {
          display: grid;
          gap: 8px;
        }

        .extension-card-title-row {
          align-items: center;
          display: inline-flex;
          gap: 8px;
        }

        .extension-help {
          align-items: center;
          color: var(--text-strong);
          cursor: help;
          display: inline-flex;
          height: 18px;
          justify-content: center;
          position: relative;
          width: 18px;
        }

        .extension-help svg {
          fill: none;
          height: 14px;
          stroke: currentColor;
          width: 14px;
        }

        .extension-help::after {
          background: var(--panel);
          border: 1px solid var(--border);
          border-radius: var(--radius-md);
          box-shadow: var(--shadow-lg);
          color: var(--text-strong);
          content: attr(data-tooltip);
          font-size: 12px;
          font-weight: 520;
          left: 0;
          line-height: 1.45;
          opacity: 0;
          padding: 10px 12px;
          pointer-events: none;
          position: absolute;
          top: calc(100% + 8px);
          transform: translateY(-2px);
          transition:
            opacity 0.12s ease,
            transform 0.12s ease;
          white-space: normal;
          width: min(340px, calc(100vw - 48px));
          z-index: 50;
        }

        .extension-help:hover::after,
        .extension-help:focus-visible::after {
          opacity: 1;
          transform: translateY(0);
        }

        .extensions-plugin {
          border: 1px solid var(--border);
          border-radius: var(--radius-lg);
          background: var(--panel);
          overflow: visible;
        }

        .extensions-plugin[open] {
          border-color: color-mix(in srgb, var(--accent) 38%, var(--border));
        }

        .extensions-plugin__summary {
          align-items: center;
          cursor: pointer;
          display: grid;
          gap: 12px;
          grid-template-columns: minmax(0, 1fr) auto;
          list-style: none;
          padding: 14px 16px;
        }

        .extensions-plugin__summary::-webkit-details-marker {
          display: none;
        }

        .extensions-plugin__main {
          align-items: center;
          display: flex;
          gap: 10px;
          min-width: 0;
        }

        .extensions-plugin__dot {
          border-radius: 999px;
          background: var(--muted);
          flex: 0 0 auto;
          height: 9px;
          width: 9px;
        }

        .extensions-plugin__dot.ok {
          background: var(--success);
        }

        .extensions-plugin__dot.warn {
          background: var(--warning);
        }

        .extensions-plugin__name {
          color: var(--text-strong);
          font-size: 15px;
          font-weight: 850;
        }

        .extensions-plugin__detail {
          color: var(--muted);
          font-size: 12px;
          line-height: 1.45;
        }

        .extensions-plugin__status {
          align-items: center;
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          justify-content: flex-end;
        }

        .extension-status-list {
          align-items: center;
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
        }

        .extension-status-text {
          color: var(--muted);
          font-size: 12px;
          font-weight: 720;
          line-height: 1.25;
        }

        .extension-status-text.ok {
          color: var(--success);
        }

        .extension-status-text.warn {
          color: var(--warning);
        }

        .extensions-plugin__body {
          border-top: 1px solid var(--border);
          display: grid;
          gap: 12px;
          padding: 14px 16px 16px;
        }

        .extensions-plugin__body > .card {
          border-radius: var(--radius-md);
          background: var(--secondary);
        }

        .extension-detail-section {
          background: var(--secondary);
          border: 1px solid var(--border);
          border-radius: var(--radius-md);
          overflow: visible;
        }

        .extension-detail-section--top {
          background: var(--panel);
        }

        .extension-detail-section__summary {
          align-items: center;
          cursor: pointer;
          display: flex;
          gap: 12px;
          justify-content: space-between;
          list-style: none;
          padding: 12px;
        }

        .extension-detail-section__summary::-webkit-details-marker {
          display: none;
        }

        .extension-detail-section__summary:hover {
          background: var(--bg-hover);
        }

        .extension-detail-section[open] > .extension-detail-section__summary {
          border-bottom: 1px solid var(--border);
        }

        .extension-detail-section__title {
          align-items: center;
          color: var(--text-strong);
          display: inline-flex;
          font-size: 13px;
          font-weight: 850;
          gap: 8px;
          min-width: 0;
        }

        .extension-detail-section__meta {
          color: var(--muted);
          font-size: 12px;
          line-height: 1.35;
          text-align: right;
        }

        .extension-detail-section__body {
          padding: 12px;
        }

        .extension-hook-row__title,
        .extension-state-card__row {
          align-items: center;
          display: flex;
          gap: 12px;
        }

        .extension-hook-row__title {
          align-items: flex-start;
        }

        .extension-hook-row__title .extensions-plugin__dot {
          margin-top: 4px;
        }

        .extension-state-card__row {
          justify-content: space-between;
          flex-wrap: wrap;
        }

        .extension-state-card__label {
          color: var(--muted);
          font-size: 11px;
          font-weight: 850;
          letter-spacing: 0.08em;
          margin-bottom: 8px;
          text-transform: uppercase;
        }

        .extension-state-card__description {
          color: var(--text);
          font-size: 13px;
          line-height: 1.5;
          max-width: 680px;
        }

        .extension-mini-grid {
          display: grid;
          gap: 10px;
          grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
        }

        .extension-toggle-row {
          align-items: center;
          border: 1px solid var(--border);
          border-radius: var(--radius-md);
          display: flex;
          gap: 12px;
          justify-content: space-between;
          margin-top: 12px;
          padding: 11px 12px;
        }

        .extension-mini-card,
        .extension-surface-card,
        .extension-note-card {
          border: 1px solid var(--border);
          border-radius: var(--radius-md);
          background: color-mix(in srgb, var(--panel) 82%, var(--secondary) 18%);
          padding: 11px 12px;
        }

        .extension-mini-card__label {
          color: var(--muted);
          font-size: 11px;
          font-weight: 850;
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }

        .extension-mini-card__value {
          color: var(--text-strong);
          font-size: 14px;
          font-weight: 760;
          line-height: 1.35;
          margin-top: 6px;
          overflow-wrap: anywhere;
        }

        .extension-note-grid {
          display: grid;
          gap: 8px;
        }

        .extension-note-card {
          align-items: flex-start;
          color: var(--text);
          display: flex;
          font-size: 13px;
          gap: 10px;
          line-height: 1.45;
        }

        .extension-note-card.danger {
          border-color: color-mix(in srgb, var(--danger) 34%, var(--border));
        }

        .extension-note-card.warn {
          border-color: color-mix(in srgb, var(--warning) 34%, var(--border));
        }

        .extension-global-diagnostics {
          border-top: 1px solid var(--border);
          display: grid;
          gap: 10px;
          margin-top: 14px;
          padding-top: 14px;
        }

        .extension-global-diagnostics__title {
          color: var(--text-strong);
          font-size: 13px;
          font-weight: 850;
        }

        .extension-surface-grid {
          display: grid;
          gap: 10px;
          grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
          margin-top: 12px;
        }

        .extension-surface-card {
          min-width: 0;
        }

        .extension-surface-card__head {
          align-items: center;
          display: flex;
          gap: 10px;
          justify-content: space-between;
        }

        .extension-card-actions {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          margin-top: 12px;
        }

        .extension-facts {
          display: grid;
          gap: 12px;
          grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
          margin-top: 8px;
        }

        .extensions-tabs {
          display: grid;
          gap: 12px;
        }

        .extensions-tabs__bar {
          align-items: center;
          border-bottom: 1px solid var(--border);
          display: flex;
          gap: 6px;
        }

        .extensions-tab-input {
          height: 1px;
          opacity: 0;
          pointer-events: none;
          position: absolute;
          width: 1px;
        }

        .extensions-tab-label {
          align-items: center;
          border: 1px solid transparent;
          border-bottom: 0;
          border-radius: var(--radius-sm) var(--radius-sm) 0 0;
          color: var(--muted);
          cursor: pointer;
          display: inline-flex;
          font-size: 13px;
          font-weight: 760;
          gap: 8px;
          margin-bottom: -1px;
          padding: 9px 12px;
        }

        .extensions-tab-label:hover {
          background: var(--bg-hover);
          color: var(--text-strong);
        }

        .extensions-tab-panel {
          display: none;
        }

        #extensions-tab-runtime:checked ~ .extensions-tabs__bar label[for="extensions-tab-runtime"],
        #extensions-tab-hooks:checked ~ .extensions-tabs__bar label[for="extensions-tab-hooks"] {
          background: var(--panel);
          border-color: var(--border);
          color: var(--text-strong);
        }

        #extensions-tab-runtime:checked ~ .extensions-tab-panel--runtime,
        #extensions-tab-hooks:checked ~ .extensions-tab-panel--hooks {
          display: grid;
          gap: 12px;
        }

        @media (max-width: 760px) {
          .extensions-plugin__summary {
            grid-template-columns: 1fr;
          }

          .extensions-plugin__status {
            justify-content: flex-start;
          }
        }
      </style>
      <section class="extensions-tabs">
        <input
          class="extensions-tab-input"
          id="extensions-tab-runtime"
          name="extensions-tab"
          type="radio"
          checked
        />
        <input
          class="extensions-tab-input"
          id="extensions-tab-hooks"
          name="extensions-tab"
          type="radio"
        />
        <div class="extensions-tabs__bar" role="tablist" aria-label="Extensions sections">
          <label class="extensions-tab-label" for="extensions-tab-runtime" role="tab">
            Extensions
            ${renderExtensionHelp(
              "Global gateway plugins. Expand a row to inspect lifecycle state, actions, grants, and exposed surfaces. Channel account setup stays in Channels.",
            )}
          </label>
          <label class="extensions-tab-label" for="extensions-tab-hooks" role="tab">
            Hooks
            ${renderExtensionHelp(
              "Lifecycle hook packs and installed workspace hooks. Agent memory stays in Agent > Memory. Plugin-managed hooks are controlled by the owning extension.",
            )}
          </label>
          <span style="flex: 1;"></span>
          <button class="btn btn--sm" ?disabled=${props.loading} @click=${props.onRefresh}>
            ${props.loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>

        <section class="extensions-tab-panel extensions-tab-panel--runtime">
          ${
            props.report
              ? html`
                  <div class="chip-row">
                    <span class="chip">${props.report.plugins.length} plugins</span>
                    ${activeCount > 0 ? html`<span class="chip chip-ok">${activeCount} active</span>` : nothing}
                    <span class="chip">${props.report.diagnostics.length} diagnostics</span>
                    <span class="chip">agent ${formatAgentDisplayName({ id: props.report.agentId })}</span>
                    ${
                      props.report.workspaceDir
                        ? html`<span class="chip">${props.report.workspaceDir}</span>`
                        : nothing
                    }
                  </div>
                `
              : nothing
          }
          ${
            !props.connected
              ? html`
                  <div class="callout danger">Connect to the gateway to browse plugins.</div>
                `
              : nothing
          }
          ${props.error ? html`<div class="callout danger">${props.error}</div>` : nothing}
          ${
            props.message
              ? html`<div class="callout success" style="white-space: pre-wrap;">${props.message}</div>`
              : nothing
          }
          ${renderGlobalDiagnostics(reportDiagnostics)}
          ${
            plugins.length === 0
              ? html`
                  <div class="muted">
                    ${props.loading ? "Loading plugin marketplace…" : "No marketplace plugins were reported."}
                  </div>
                `
              : html`
                  <div class="extensions-list">
                    ${plugins.map((entry) => {
                      const expandedEntry =
                        props.detail?.plugin?.id === entry.id ? props.detail.plugin : entry;
                      const entryDiagnostics =
                        props.detail?.plugin?.id === entry.id
                          ? (props.detail.diagnostics ?? diagnostics)
                          : diagnostics;
                      return renderEntrySummary(
                        props,
                        expandedEntry,
                        entry.id === props.selectedId,
                        entryDiagnostics,
                      );
                    })}
                  </div>
                `
          }
        </section>

        <section class="extensions-tab-panel extensions-tab-panel--hooks">
          ${renderExtensionsHooksCard(props)}
        </section>
      </section>
    </section>
  `;
}
