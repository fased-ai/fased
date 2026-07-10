import fs from "node:fs";
import path from "node:path";
import type { FasedAgentConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import { resolveFasedAgentPackageRootSync } from "../infra/fased-root.js";
import {
  buildPluginMarketplaceReport,
  type PluginMarketplaceReport,
} from "../plugins/marketplace.js";

export const CAPABILITY_STATES = [
  "included",
  "external-required",
  "not-installed",
  "installed",
  "configured",
  "ready",
  "error",
] as const;

export type CapabilityState = (typeof CAPABILITY_STATES)[number];
export type CapabilityDelivery = "core" | "npm-addon" | "external-runtime";
export type CapabilityCategory = "core" | "crypto" | "channel" | "provider" | "runtime";
export type CapabilityAction = "none" | "install" | "connect" | "configure" | "test" | "repair";

export type CapabilityCatalogEntry = {
  id: string;
  label: string;
  category: CapabilityCategory;
  delivery: CapabilityDelivery;
  description: string;
  docsPath: string;
  surface: string;
  packageName?: string;
  pluginId?: string;
  channelId?: string;
  providerId?: string;
  externalKind?: "browser" | "model-server" | "local-embeddings";
  restartRequired?: boolean;
};

export type CapabilityReadinessEntry = CapabilityCatalogEntry & {
  state: CapabilityState;
  action: CapabilityAction;
  detail: string;
};

export type CapabilityReadinessSummary = {
  total: number;
  coreIncluded: number;
  optionalInstalled: number;
  optionalConfigured: number;
  externalRequired: number;
  errors: number;
};

export type CapabilityReadinessReport = {
  entries: CapabilityReadinessEntry[];
  summary: CapabilityReadinessSummary;
};

const CATALOG_RELATIVE_PATH = path.join("config", "capability-catalog.json");
const DELIVERY_VALUES = new Set<CapabilityDelivery>(["core", "npm-addon", "external-runtime"]);
const CATEGORY_VALUES = new Set<CapabilityCategory>([
  "core",
  "crypto",
  "channel",
  "provider",
  "runtime",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string, index: number): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`capability catalog entry ${index} requires ${key}`);
  }
  return value.trim();
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseCatalogEntry(value: unknown, index: number): CapabilityCatalogEntry {
  if (!isRecord(value)) {
    throw new Error(`capability catalog entry ${index} must be an object`);
  }
  const delivery = requiredString(value, "delivery", index) as CapabilityDelivery;
  if (!DELIVERY_VALUES.has(delivery)) {
    throw new Error(`capability catalog entry ${index} has invalid delivery ${delivery}`);
  }
  const category = requiredString(value, "category", index) as CapabilityCategory;
  if (!CATEGORY_VALUES.has(category)) {
    throw new Error(`capability catalog entry ${index} has invalid category ${category}`);
  }
  const externalKind = optionalString(value, "externalKind");
  if (
    externalKind &&
    externalKind !== "browser" &&
    externalKind !== "model-server" &&
    externalKind !== "local-embeddings"
  ) {
    throw new Error(`capability catalog entry ${index} has invalid externalKind ${externalKind}`);
  }
  return {
    id: requiredString(value, "id", index),
    label: requiredString(value, "label", index),
    category,
    delivery,
    description: requiredString(value, "description", index),
    docsPath: requiredString(value, "docsPath", index),
    surface: requiredString(value, "surface", index),
    ...(optionalString(value, "packageName")
      ? { packageName: optionalString(value, "packageName") }
      : {}),
    ...(optionalString(value, "pluginId") ? { pluginId: optionalString(value, "pluginId") } : {}),
    ...(optionalString(value, "channelId")
      ? { channelId: optionalString(value, "channelId") }
      : {}),
    ...(optionalString(value, "providerId")
      ? { providerId: optionalString(value, "providerId") }
      : {}),
    ...(externalKind
      ? { externalKind: externalKind as CapabilityCatalogEntry["externalKind"] }
      : {}),
    ...(value.restartRequired === true ? { restartRequired: true } : {}),
  };
}

function resolveCatalogPath(): string {
  const roots = [
    resolveFasedAgentPackageRootSync({ moduleUrl: import.meta.url }),
    resolveFasedAgentPackageRootSync({ cwd: process.cwd() }),
    process.cwd(),
  ].filter((entry, index, all): entry is string => Boolean(entry) && all.indexOf(entry) === index);
  for (const root of roots) {
    const candidate = path.join(root, CATALOG_RELATIVE_PATH);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`Fased capability catalog not found (${CATALOG_RELATIVE_PATH})`);
}

export function loadCapabilityCatalog(): CapabilityCatalogEntry[] {
  const payload = JSON.parse(fs.readFileSync(resolveCatalogPath(), "utf8")) as unknown;
  if (!isRecord(payload) || !Array.isArray(payload.entries)) {
    throw new Error("capability catalog must contain an entries array");
  }
  const entries = payload.entries.map(parseCatalogEntry);
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) {
      throw new Error(`duplicate capability catalog id: ${entry.id}`);
    }
    ids.add(entry.id);
  }
  return entries;
}

function configRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function channelConfigured(config: FasedAgentConfig, channelId: string): boolean {
  const channel = configRecord(configRecord(config.channels)[channelId]);
  return Object.keys(channel).length > 0;
}

function providerConfigured(config: FasedAgentConfig, providerId: string): boolean {
  return Boolean(config.models?.providers?.[providerId]);
}

function browserConfigured(config: FasedAgentConfig): boolean {
  const browser = configRecord(config.browser);
  return (
    browser.enabled === true ||
    typeof browser.executablePath === "string" ||
    typeof browser.cdpUrl === "string" ||
    Object.keys(configRecord(browser.profiles)).length > 0
  );
}

function localMemoryConfigured(config: FasedAgentConfig): boolean {
  return config.agents?.defaults?.memorySearch?.provider === "local";
}

function actionForState(state: CapabilityState): CapabilityAction {
  switch (state) {
    case "not-installed":
      return "install";
    case "external-required":
      return "connect";
    case "installed":
    case "included":
      return "configure";
    case "configured":
      return "test";
    case "error":
      return "repair";
    case "ready":
      return "none";
  }
}

function resolveCoreCapability(
  entry: CapabilityCatalogEntry,
  plugins: PluginMarketplaceReport,
): Pick<CapabilityReadinessEntry, "state" | "detail"> {
  if (entry.pluginId) {
    const plugin = plugins.plugins.find((candidate) => candidate.id === entry.pluginId);
    if (plugin?.status === "error") {
      return { state: "error", detail: plugin.error ?? `${entry.label} failed to load.` };
    }
  }
  return { state: "included", detail: "Included in the Fased core runtime." };
}

function resolveAddonCapability(
  entry: CapabilityCatalogEntry,
  config: FasedAgentConfig,
  plugins: PluginMarketplaceReport,
): Pick<CapabilityReadinessEntry, "state" | "detail"> {
  const plugin = plugins.plugins.find(
    (candidate) =>
      candidate.id === entry.pluginId ||
      candidate.name === entry.packageName ||
      candidate.channels.includes(entry.channelId ?? entry.id),
  );
  const installRecord = entry.pluginId ? config.plugins?.installs?.[entry.pluginId] : undefined;
  const installed = Boolean(
    installRecord ||
    plugin?.hasInstallRecord ||
    plugin?.managed ||
    (plugin?.loaded && plugin.origin !== "bundled"),
  );
  if (!installed) {
    return {
      state: "not-installed",
      detail: `${entry.packageName ?? entry.label} is available as an optional npm add-on.`,
    };
  }
  if (plugin?.status === "error") {
    return { state: "error", detail: plugin.error ?? `${entry.label} failed to load.` };
  }
  const configured = entry.channelId ? channelConfigured(config, entry.channelId) : false;
  if (configured && plugin?.loaded && plugin.enabled) {
    return {
      state: "configured",
      detail: "Add-on is installed and configured. Run its live channel check for readiness.",
    };
  }
  return {
    state: "installed",
    detail: plugin?.loaded
      ? "Add-on is installed. Complete its configuration."
      : "Add-on is installed and requires a Gateway restart or enable step.",
  };
}

function resolveExternalCapability(
  entry: CapabilityCatalogEntry,
  config: FasedAgentConfig,
): Pick<CapabilityReadinessEntry, "state" | "detail"> {
  const configured = entry.providerId
    ? providerConfigured(config, entry.providerId)
    : entry.externalKind === "browser"
      ? browserConfigured(config)
      : entry.externalKind === "local-embeddings"
        ? localMemoryConfigured(config)
        : false;
  if (configured) {
    return {
      state: "configured",
      detail:
        "Fased is configured to use this external runtime. Test the connection for readiness.",
    };
  }
  return {
    state: "external-required",
    detail: "Install or run this runtime outside Fased, then connect it from the listed surface.",
  };
}

function summarize(entries: CapabilityReadinessEntry[]): CapabilityReadinessSummary {
  return {
    total: entries.length,
    coreIncluded: entries.filter((entry) => entry.delivery === "core" && entry.state === "included")
      .length,
    optionalInstalled: entries.filter(
      (entry) =>
        entry.delivery === "npm-addon" &&
        (entry.state === "installed" || entry.state === "configured" || entry.state === "ready"),
    ).length,
    optionalConfigured: entries.filter((entry) => entry.state === "configured").length,
    externalRequired: entries.filter((entry) => entry.state === "external-required").length,
    errors: entries.filter((entry) => entry.state === "error").length,
  };
}

export function buildCapabilityReadinessReport(params?: {
  config?: FasedAgentConfig;
  pluginReport?: PluginMarketplaceReport;
}): CapabilityReadinessReport {
  const config = params?.config ?? loadConfig();
  const pluginReport = params?.pluginReport ?? buildPluginMarketplaceReport({ config });
  const entries = loadCapabilityCatalog().map((entry): CapabilityReadinessEntry => {
    const resolved =
      entry.delivery === "core"
        ? resolveCoreCapability(entry, pluginReport)
        : entry.delivery === "npm-addon"
          ? resolveAddonCapability(entry, config, pluginReport)
          : resolveExternalCapability(entry, config);
    return {
      ...entry,
      ...resolved,
      action: actionForState(resolved.state),
    };
  });
  return { entries, summary: summarize(entries) };
}

export function formatCapabilityReadinessSummary(report: CapabilityReadinessReport): string {
  const { summary } = report;
  return [
    `Core included: ${summary.coreIncluded}`,
    `Add-ons installed: ${summary.optionalInstalled}`,
    `Configured: ${summary.optionalConfigured}`,
    `External required: ${summary.externalRequired}`,
    `Errors: ${summary.errors}`,
  ].join(" · ");
}
