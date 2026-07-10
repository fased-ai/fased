import { describe, expect, it } from "vitest";
import type { FasedAgentConfig } from "../config/config.js";
import type { PluginMarketplaceEntry, PluginMarketplaceReport } from "../plugins/marketplace.js";
import { buildCapabilityReadinessReport, loadCapabilityCatalog } from "./catalog.js";

function plugin(params: Partial<PluginMarketplaceEntry> & Pick<PluginMarketplaceEntry, "id">) {
  return {
    id: params.id,
    name: params.name ?? params.id,
    status: params.status ?? "loaded",
    discovered: true,
    managed: params.managed ?? true,
    loaded: params.loaded ?? true,
    enabled: params.enabled ?? true,
    hasInstallRecord: params.hasInstallRecord ?? true,
    channels: params.channels ?? [],
    providers: params.providers ?? [],
    toolNames: [],
    hookNames: [],
    gatewayMethods: [],
    cliCommands: [],
    services: [],
    commands: [],
    httpHandlers: 0,
    hookCount: 0,
    installOptions: {},
    actions: ["status"],
    ...params,
  } satisfies PluginMarketplaceEntry;
}

function report(plugins: PluginMarketplaceEntry[] = []): PluginMarketplaceReport {
  return { plugins, diagnostics: [] };
}

describe("capability catalog", () => {
  it("loads one stable catalog without duplicate ids", () => {
    const entries = loadCapabilityCatalog();
    expect(entries).toHaveLength(16);
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length);
    expect(entries.find((entry) => entry.id === "sat-mining")?.delivery).toBe("core");
    expect(entries.find((entry) => entry.id === "telegram")?.packageName).toBe("@fased/telegram");
  });

  it("keeps missing optional and external components out of the error count", () => {
    const capabilities = buildCapabilityReadinessReport({
      config: {} as FasedAgentConfig,
      pluginReport: report(),
    });
    expect(capabilities.summary).toMatchObject({
      total: 16,
      coreIncluded: 6,
      optionalInstalled: 0,
      externalRequired: 6,
      errors: 0,
    });
    expect(capabilities.entries.find((entry) => entry.id === "telegram")?.state).toBe(
      "not-installed",
    );
    expect(capabilities.entries.find((entry) => entry.id === "ollama")?.state).toBe(
      "external-required",
    );
  });

  it("distinguishes installed add-ons from configured external providers", () => {
    const config = {
      channels: { telegram: { enabled: true, botToken: "token" } },
      models: { providers: { ollama: { baseUrl: "http://127.0.0.1:11434" } } },
    } as FasedAgentConfig;
    const capabilities = buildCapabilityReadinessReport({
      config,
      pluginReport: report([
        plugin({ id: "telegram", name: "@fased/telegram", channels: ["telegram"] }),
      ]),
    });
    expect(capabilities.entries.find((entry) => entry.id === "telegram")?.state).toBe("configured");
    expect(capabilities.entries.find((entry) => entry.id === "ollama")?.state).toBe("configured");
  });

  it("surfaces core plugin load errors", () => {
    const capabilities = buildCapabilityReadinessReport({
      config: {} as FasedAgentConfig,
      pluginReport: report([
        plugin({
          id: "sat-mining",
          status: "error",
          loaded: false,
          enabled: true,
          error: "failed to load",
        }),
      ]),
    });
    expect(capabilities.entries.find((entry) => entry.id === "sat-mining")?.state).toBe("error");
    expect(capabilities.summary.errors).toBe(1);
  });

  it("treats disabled bundled core plugins as included", () => {
    const capabilities = buildCapabilityReadinessReport({
      config: {} as FasedAgentConfig,
      pluginReport: report([
        plugin({
          id: "sat-mining",
          origin: "bundled",
          status: "disabled",
          loaded: false,
          enabled: false,
          managed: false,
          hasInstallRecord: false,
          error: "bundled (disabled by default)",
        }),
      ]),
    });
    expect(capabilities.entries.find((entry) => entry.id === "sat-mining")?.state).toBe("included");
    expect(capabilities.summary.errors).toBe(0);
  });

  it("does not count source-discovered channel add-ons as installed", () => {
    const capabilities = buildCapabilityReadinessReport({
      config: {} as FasedAgentConfig,
      pluginReport: report([
        plugin({
          id: "telegram",
          origin: "bundled",
          status: "disabled",
          loaded: false,
          enabled: false,
          managed: false,
          hasInstallRecord: false,
          channels: ["telegram"],
          error: "bundled (disabled by default)",
        }),
      ]),
    });
    expect(capabilities.entries.find((entry) => entry.id === "telegram")?.state).toBe(
      "not-installed",
    );
    expect(capabilities.summary.optionalInstalled).toBe(0);
    expect(capabilities.summary.errors).toBe(0);
  });
});
