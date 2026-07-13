import type { AppViewState } from "../app-view-state.ts";
import type { CapabilityReadinessReport, WebSearchServiceProvidersResult } from "../types.ts";
import { loadConfig } from "./config.ts";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readPath(root: unknown, path: ReadonlyArray<string | number>): unknown {
  let current: unknown = root;
  for (const key of path) {
    const record = asRecord(current);
    if (!(key in record)) {
      return undefined;
    }
    current = record[key];
  }
  return current;
}

function stringParam(root: unknown, path: ReadonlyArray<string | number>): string | undefined {
  const value = readPath(root, path);
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function numberParam(root: unknown, path: ReadonlyArray<string | number>): number | undefined {
  const value = readPath(root, path);
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

function booleanParam(root: unknown, path: ReadonlyArray<string | number>): boolean | undefined {
  const value = readPath(root, path);
  return typeof value === "boolean" ? value : undefined;
}

export async function loadWebSearchServiceProviders(state: AppViewState) {
  if (!state.client) {
    return;
  }
  state.servicesWebSearchProvidersLoading = true;
  try {
    const res = await state.client.request<WebSearchServiceProvidersResult>(
      "services.webSearch.providers",
      {},
    );
    state.servicesWebSearchProviders = Array.isArray(res?.providers) ? res.providers : [];
  } catch {
    state.servicesWebSearchProviders = [];
  } finally {
    state.servicesWebSearchProvidersLoading = false;
  }
}

export async function loadServiceCapabilities(state: AppViewState) {
  if (!state.client) {
    return;
  }
  state.servicesCapabilitiesLoading = true;
  try {
    state.servicesCapabilities = await state.client.request<CapabilityReadinessReport>(
      "services.capabilities",
      {},
    );
  } catch {
    state.servicesCapabilities = null;
  } finally {
    state.servicesCapabilitiesLoading = false;
  }
}

type ComponentMutationResult = {
  message?: string;
  report?: CapabilityReadinessReport;
};

async function mutateServiceComponent(
  state: AppViewState,
  method: "services.component.install" | "services.component.restart",
  id: string,
) {
  if (!state.client || state.servicesComponentBusy[id]) {
    return;
  }
  state.servicesComponentBusy = { ...state.servicesComponentBusy, [id]: true };
  state.servicesComponentMessage = null;
  try {
    const result = await state.client.request<ComponentMutationResult>(method, { id });
    state.servicesComponentMessage = result?.message ?? "Component action completed.";
    if (result?.report) {
      state.servicesCapabilities = result.report;
    } else {
      await loadServiceCapabilities(state);
    }
  } catch (err) {
    state.servicesComponentMessage = `Component action failed: ${String(err)}`;
  } finally {
    const next = { ...state.servicesComponentBusy };
    delete next[id];
    state.servicesComponentBusy = next;
  }
}

export async function installServiceComponent(state: AppViewState, id: string) {
  await mutateServiceComponent(state, "services.component.install", id);
}

export async function restartServiceComponent(state: AppViewState, id: string) {
  await mutateServiceComponent(state, "services.component.restart", id);
}

export async function testWebSearchService(state: AppViewState) {
  if (!state.client) {
    return;
  }
  const client = state.client;
  state.servicesWebSearchTesting = true;
  state.servicesWebSearchTestMessage = null;
  try {
    const res = await client.request<{
      provider?: string;
      result?: { error?: string; message?: string; results?: unknown[] };
    }>("services.webSearch.test", {});
    const provider = res?.provider ? `${res.provider}: ` : "";
    const resultCount = Array.isArray(res?.result?.results) ? res.result.results.length : null;
    state.servicesWebSearchTestMessage =
      resultCount == null
        ? `${provider}test completed.`
        : `${provider}test completed with ${resultCount} result${resultCount === 1 ? "" : "s"}.`;
  } catch (err) {
    state.servicesWebSearchTestMessage = `Test failed: ${String(err)}`;
  } finally {
    state.servicesWebSearchTesting = false;
  }
}

export async function provisionGmailService(state: AppViewState) {
  if (!state.client) {
    return;
  }
  const config = state.configForm ?? state.configSnapshot?.config ?? {};
  const params = {
    account: stringParam(config, ["hooks", "gmail", "account"]),
    project: stringParam(config, ["hooks", "gmail", "project"]),
    topic: stringParam(config, ["hooks", "gmail", "topic"]),
    subscription: stringParam(config, ["hooks", "gmail", "subscription"]),
    label: stringParam(config, ["hooks", "gmail", "label"]),
    hookUrl: stringParam(config, ["hooks", "gmail", "hookUrl"]),
    hookToken: stringParam(config, ["hooks", "token"]),
    pushToken: stringParam(config, ["hooks", "gmail", "pushToken"]),
    bind: stringParam(config, ["hooks", "gmail", "serve", "bind"]),
    port: numberParam(config, ["hooks", "gmail", "serve", "port"]),
    path: stringParam(config, ["hooks", "gmail", "serve", "path"]),
    includeBody: booleanParam(config, ["hooks", "gmail", "includeBody"]),
    maxBytes: numberParam(config, ["hooks", "gmail", "maxBytes"]),
    renewEveryMinutes: numberParam(config, ["hooks", "gmail", "renewEveryMinutes"]),
    tailscale: stringParam(config, ["hooks", "gmail", "tailscale", "mode"]),
    tailscalePath: stringParam(config, ["hooks", "gmail", "tailscale", "path"]),
    tailscaleTarget: stringParam(config, ["hooks", "gmail", "tailscale", "target"]),
    pushEndpoint: stringParam(config, ["hooks", "gmail", "pushEndpoint"]),
  };

  state.servicesGmailProvisioning = true;
  state.servicesGmailProvisionMessage = null;
  try {
    const res = await state.client.request<{ summary?: { topic?: string; subscription?: string } }>(
      "services.gmail.setup",
      params,
    );
    const summary = res?.summary;
    state.servicesGmailProvisionMessage = summary?.topic
      ? `Gmail provisioned: ${summary.topic}`
      : "Gmail provisioned.";
    await loadConfig(state);
  } catch (err) {
    state.servicesGmailProvisionMessage = `Provision failed: ${String(err)}`;
  } finally {
    state.servicesGmailProvisioning = false;
  }
}
