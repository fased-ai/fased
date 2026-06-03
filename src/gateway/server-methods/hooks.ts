import { randomBytes, randomUUID } from "node:crypto";
import {
  listAgentIds,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import type { FasedAgentConfig } from "../../config/config.js";
import { loadConfig, writeConfigFile } from "../../config/config.js";
import type { HookMappingConfig } from "../../config/types.hooks.js";
import {
  buildWorkspaceHookStatus,
  type HookStatusEntry,
  type HookStatusReport,
} from "../../hooks/hooks-status.js";
import type { HookEntry } from "../../hooks/types.js";
import { loadWorkspaceHookEntries } from "../../hooks/workspace.js";
import { buildPluginStatusReport } from "../../plugins/status.js";
import {
  completeTaskRunByRunId,
  createRunningTaskRun,
  failTaskRunByRunId,
} from "../../tasks/task-executor.js";
import type { TaskNotifyPolicy } from "../../tasks/task-registry.types.js";
import { applyHookMappings, resolveHookMappings } from "../hooks-mapping.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";

const DEFAULT_WEBHOOK_TRIGGER_BASE_PATH = "/hooks";
const DEFAULT_WEBHOOK_TRIGGER_MESSAGE =
  "Webhook {{path}} received at {{now}}.\n\nPayload:\n{{payload}}";

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function resolveAgentIdOrRespondError(rawAgentId: unknown, respond: RespondFn) {
  const cfg = loadConfig();
  const knownAgents = listAgentIds(cfg);
  const requestedAgentId = typeof rawAgentId === "string" ? rawAgentId.trim() : "";
  const agentId = requestedAgentId || resolveDefaultAgentId(cfg);
  if (requestedAgentId && !knownAgents.includes(agentId)) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `unknown agent id "${requestedAgentId}"`),
    );
    return null;
  }
  return {
    cfg,
    agentId,
    workspaceDir: resolveAgentWorkspaceDir(cfg, agentId),
  };
}

function mergeHookEntries(pluginEntries: HookEntry[], workspaceEntries: HookEntry[]): HookEntry[] {
  const merged = new Map<string, HookEntry>();
  for (const entry of pluginEntries) {
    merged.set(entry.hook.name, entry);
  }
  for (const entry of workspaceEntries) {
    merged.set(entry.hook.name, entry);
  }
  return [...merged.values()];
}

function buildHooksReport(params: {
  config: FasedAgentConfig;
  workspaceDir: string | undefined;
}): HookStatusReport {
  const workspaceDir = params.workspaceDir ?? process.cwd();
  const workspaceEntries = loadWorkspaceHookEntries(workspaceDir, { config: params.config });
  const pluginReport = buildPluginStatusReport({ config: params.config, workspaceDir });
  const pluginEntries = pluginReport.hooks.map((hook) => hook.entry);
  const entries = mergeHookEntries(pluginEntries, workspaceEntries);
  return buildWorkspaceHookStatus(workspaceDir, { config: params.config, entries });
}

function summarizeMissing(hook: HookStatusEntry): string[] {
  const missing = hook.missing;
  return [
    ...missing.bins.map((value) => `bin:${value}`),
    ...(missing.anyBins.length > 0 ? [`one of:${missing.anyBins.join("|")}`] : []),
    ...missing.env.map((value) => `env:${value}`),
    ...missing.config.map((value) => `config:${value}`),
    ...missing.os.map((value) => `os:${value}`),
  ];
}

function serializeHook(hook: HookStatusEntry) {
  return {
    name: hook.name,
    hookKey: hook.hookKey,
    description: hook.description,
    source: hook.source,
    ...(hook.pluginId ? { pluginId: hook.pluginId } : {}),
    ...(hook.emoji ? { emoji: hook.emoji } : {}),
    ...(hook.homepage ? { homepage: hook.homepage } : {}),
    events: hook.events,
    always: hook.always,
    disabled: hook.disabled,
    eligible: hook.eligible,
    managedByPlugin: hook.managedByPlugin,
    missing: summarizeMissing(hook),
    configChecks: hook.configChecks,
    install: hook.install.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      label: entry.label,
      bins: entry.bins,
    })),
  };
}

function serializeReport(params: { agentId: string; report: HookStatusReport }) {
  const hooks = params.report.hooks
    .map(serializeHook)
    .toSorted((a, b) => a.name.localeCompare(b.name));
  return {
    agentId: params.agentId,
    workspaceDir: params.report.workspaceDir,
    managedHooksDir: params.report.managedHooksDir,
    hooks,
  };
}

function resolveHookForToggle(report: HookStatusReport, rawName: string) {
  const hookName = rawName.trim();
  return report.hooks.find((hook) => hook.name === hookName || hook.hookKey === hookName) ?? null;
}

function canEnableHook(hook: HookStatusEntry) {
  if (hook.disabled) {
    return true;
  }
  return hook.eligible;
}

function buildConfigWithHookEnabled(params: {
  config: FasedAgentConfig;
  hook: HookStatusEntry;
  enabled: boolean;
}) {
  const entries = { ...params.config.hooks?.internal?.entries };
  const hookKey = params.hook.hookKey;
  entries[hookKey] = {
    ...entries[hookKey],
    enabled: params.enabled,
  };
  return {
    ...params.config,
    hooks: {
      ...params.config.hooks,
      internal: {
        ...params.config.hooks?.internal,
        ...(params.enabled ? { enabled: true } : {}),
        entries,
      },
    },
  };
}

type WebhookTriggerAction = "agent" | "wake" | "workflow";

type WebhookTriggerSerialized = {
  id: string;
  enabled: boolean;
  name: string;
  path: string;
  urlPath: string;
  action: WebhookTriggerAction;
  agentId?: string;
  wakeMode: "now" | "next-heartbeat";
  messageTemplate?: string;
  textTemplate?: string;
  workflowDefinitionId?: string;
  deliver: boolean;
  channel: string;
  to?: string;
  model?: string;
  thinking?: string;
  timeoutSeconds?: number;
  notifyPolicy: TaskNotifyPolicy;
  allowUnsafeExternalContent: boolean;
};

const WEBHOOK_TRIGGER_NOTIFY_POLICIES = new Set<TaskNotifyPolicy>([
  "silent",
  "done_only",
  "state_changes",
]);

function normalizeTriggerPath(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const cleaned = raw
    .trim()
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/[^a-zA-Z0-9/_-]+/g, "-")
    .replace(/\/{2,}/g, "/")
    .toLowerCase();
  if (!cleaned || cleaned === "wake" || cleaned === "agent") {
    return null;
  }
  if (cleaned.split("/").some((part) => !part || part === "." || part === "..")) {
    return null;
  }
  return cleaned.slice(0, 160);
}

function normalizeTriggerId(raw: unknown, fallbackPath: string): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  if (cleaned) {
    return cleaned;
  }
  return `webhook-${fallbackPath.replace(/[^a-z0-9_-]+/g, "-")}`;
}

function normalizeHooksBasePath(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) {
    return DEFAULT_WEBHOOK_TRIGGER_BASE_PATH;
  }
  const withSlash = raw.trim().startsWith("/") ? raw.trim() : `/${raw.trim()}`;
  const cleaned = withSlash.length > 1 ? withSlash.replace(/\/+$/, "") : withSlash;
  return cleaned && cleaned !== "/" ? cleaned : DEFAULT_WEBHOOK_TRIGGER_BASE_PATH;
}

function ensureHookToken(raw: unknown): { token: string; created: boolean } {
  const token = typeof raw === "string" ? raw.trim() : "";
  if (token) {
    return { token, created: false };
  }
  return { token: `hook_${randomBytes(24).toString("base64url")}`, created: true };
}

function isWebhookTriggerMapping(mapping: HookMappingConfig): boolean {
  return Boolean(mapping.id?.startsWith("webhook-") || mapping.match?.path);
}

function serializeWebhookTrigger(
  mapping: HookMappingConfig,
  basePath: string,
): WebhookTriggerSerialized | null {
  const path = normalizeTriggerPath(mapping.match?.path);
  if (!path) {
    return null;
  }
  const action =
    mapping.action === "wake" ? "wake" : mapping.action === "workflow" ? "workflow" : "agent";
  return {
    id: normalizeTriggerId(mapping.id, path),
    enabled: mapping.enabled !== false,
    name: mapping.name?.trim() || path,
    path,
    urlPath: `${basePath}/${path}`,
    action,
    ...(mapping.agentId ? { agentId: mapping.agentId } : {}),
    wakeMode: mapping.wakeMode ?? "now",
    ...(mapping.messageTemplate ? { messageTemplate: mapping.messageTemplate } : {}),
    ...(mapping.textTemplate ? { textTemplate: mapping.textTemplate } : {}),
    ...(mapping.workflowDefinitionId ? { workflowDefinitionId: mapping.workflowDefinitionId } : {}),
    deliver: mapping.deliver === true,
    channel: mapping.channel ?? "last",
    ...(mapping.to ? { to: mapping.to } : {}),
    ...(mapping.model ? { model: mapping.model } : {}),
    ...(mapping.thinking ? { thinking: mapping.thinking } : {}),
    ...(typeof mapping.timeoutSeconds === "number"
      ? { timeoutSeconds: mapping.timeoutSeconds }
      : {}),
    notifyPolicy: normalizeWebhookTriggerNotifyPolicy(mapping.notifyPolicy),
    allowUnsafeExternalContent: mapping.allowUnsafeExternalContent === true,
  };
}

function normalizeWebhookTriggerNotifyPolicy(raw: unknown): TaskNotifyPolicy {
  return typeof raw === "string" && WEBHOOK_TRIGGER_NOTIFY_POLICIES.has(raw as TaskNotifyPolicy)
    ? (raw as TaskNotifyPolicy)
    : "done_only";
}

function listWebhookTriggers(cfg: FasedAgentConfig) {
  const basePath = normalizeHooksBasePath(cfg.hooks?.path);
  const mappings = Array.isArray(cfg.hooks?.mappings) ? cfg.hooks.mappings : [];
  const triggers = mappings
    .filter(isWebhookTriggerMapping)
    .map((mapping) => serializeWebhookTrigger(mapping, basePath))
    .filter((entry): entry is WebhookTriggerSerialized => Boolean(entry))
    .toSorted((a, b) => a.path.localeCompare(b.path));
  return {
    enabled: cfg.hooks?.enabled === true,
    basePath,
    hasToken: Boolean(cfg.hooks?.token?.trim()),
    triggers,
  };
}

function parseWebhookTriggerParams(raw: Record<string, unknown>):
  | {
      ok: true;
      value: HookMappingConfig & { id: string; match: { path: string } };
    }
  | {
      ok: false;
      error: string;
    } {
  const path = normalizeTriggerPath(raw.path);
  if (!path) {
    return { ok: false, error: "path is required and may not be wake, agent, /, or traversal" };
  }
  const id = normalizeTriggerId(raw.id, path);
  const action = raw.action === "wake" ? "wake" : raw.action === "workflow" ? "workflow" : "agent";
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : path;
  const wakeMode = raw.wakeMode === "next-heartbeat" ? "next-heartbeat" : "now";
  const enabled = raw.enabled !== false;
  const mapping: HookMappingConfig & { id: string; match: { path: string } } = {
    id,
    enabled,
    match: { path },
    action,
    wakeMode,
    name,
  };
  if (action === "wake") {
    const textTemplate =
      typeof raw.textTemplate === "string" && raw.textTemplate.trim()
        ? raw.textTemplate
        : DEFAULT_WEBHOOK_TRIGGER_MESSAGE;
    mapping.textTemplate = textTemplate;
  } else if (action === "workflow") {
    const workflowDefinitionId =
      typeof raw.workflowDefinitionId === "string" && raw.workflowDefinitionId.trim()
        ? raw.workflowDefinitionId.trim()
        : "";
    if (!workflowDefinitionId) {
      return { ok: false, error: "workflowDefinitionId is required for workflow triggers" };
    }
    mapping.workflowDefinitionId = workflowDefinitionId;
  } else {
    const messageTemplate =
      typeof raw.messageTemplate === "string" && raw.messageTemplate.trim()
        ? raw.messageTemplate
        : DEFAULT_WEBHOOK_TRIGGER_MESSAGE;
    mapping.messageTemplate = messageTemplate;
  }
  if (typeof raw.agentId === "string" && raw.agentId.trim()) {
    mapping.agentId = raw.agentId.trim();
  }
  if (typeof raw.sessionKey === "string" && raw.sessionKey.trim()) {
    mapping.sessionKey = raw.sessionKey.trim();
  }
  if (typeof raw.deliver === "boolean") {
    mapping.deliver = raw.deliver;
  }
  if (typeof raw.channel === "string" && raw.channel.trim()) {
    mapping.channel = raw.channel.trim().toLowerCase() as HookMappingConfig["channel"];
  }
  if (typeof raw.to === "string" && raw.to.trim()) {
    mapping.to = raw.to.trim();
  }
  if (typeof raw.model === "string" && raw.model.trim()) {
    mapping.model = raw.model.trim();
  }
  if (typeof raw.thinking === "string" && raw.thinking.trim()) {
    mapping.thinking = raw.thinking.trim();
  }
  if (typeof raw.timeoutSeconds === "number" && Number.isFinite(raw.timeoutSeconds)) {
    mapping.timeoutSeconds = Math.max(1, Math.floor(raw.timeoutSeconds));
  }
  if (raw.notifyPolicy !== undefined) {
    if (!WEBHOOK_TRIGGER_NOTIFY_POLICIES.has(raw.notifyPolicy as TaskNotifyPolicy)) {
      return {
        ok: false,
        error: "notifyPolicy must be silent, done_only, or state_changes",
      };
    }
    mapping.notifyPolicy = raw.notifyPolicy as TaskNotifyPolicy;
  }
  if (raw.allowUnsafeExternalContent === true) {
    mapping.allowUnsafeExternalContent = true;
  }
  return { ok: true, value: mapping };
}

function findWebhookTriggerMapping(params: {
  config: FasedAgentConfig;
  id: string;
}): (HookMappingConfig & { id: string; match: { path: string } }) | null {
  const mappings = Array.isArray(params.config.hooks?.mappings) ? params.config.hooks.mappings : [];
  for (const mapping of mappings) {
    if (!isWebhookTriggerMapping(mapping)) {
      continue;
    }
    const path = normalizeTriggerPath(mapping.match?.path);
    if (!path) {
      continue;
    }
    const id = normalizeTriggerId(mapping.id, path);
    if (id === params.id) {
      return { ...mapping, id, match: { ...mapping.match, path } };
    }
  }
  return null;
}

function webhookTriggerBelongsToAgent(
  config: FasedAgentConfig,
  mapping: Pick<HookMappingConfig, "agentId">,
  agentId: string | undefined,
): boolean {
  if (!agentId?.trim()) {
    return true;
  }
  return (mapping.agentId?.trim() || resolveDefaultAgentId(config)) === agentId.trim();
}

function readTestPayload(raw: Record<string, unknown>, id: string): Record<string, unknown> {
  const payload = raw.payload;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }
  return {
    test: true,
    triggerId: id,
    message: "Webhook trigger test",
  };
}

function buildConfigWithWebhookTrigger(params: {
  config: FasedAgentConfig;
  mapping: HookMappingConfig & { id: string; match: { path: string } };
}) {
  const hooks = params.config.hooks ?? {};
  const token = ensureHookToken(hooks.token);
  const mappings = Array.isArray(hooks.mappings) ? [...hooks.mappings] : [];
  const index = mappings.findIndex((entry) => entry.id === params.mapping.id);
  if (index >= 0) {
    mappings[index] = { ...mappings[index], ...params.mapping };
  } else {
    mappings.push(params.mapping);
  }
  return {
    config: {
      ...params.config,
      hooks: {
        ...hooks,
        enabled: true,
        path: normalizeHooksBasePath(hooks.path),
        token: token.token,
        mappings,
      },
    },
    tokenCreated: token.created,
  };
}

function buildConfigWithoutWebhookTrigger(params: { config: FasedAgentConfig; id: string }) {
  const hooks = params.config.hooks ?? {};
  const mappings = Array.isArray(hooks.mappings) ? hooks.mappings : [];
  const nextMappings = mappings.filter((entry) => entry.id !== params.id);
  return {
    ...params.config,
    hooks: {
      ...hooks,
      mappings: nextMappings,
    },
  };
}

export const hooksHandlers: GatewayRequestHandlers = {
  "webhookTriggers.list": ({ params, respond }) => {
    const cfg = loadConfig();
    const raw = readRecord(params);
    const agentId = typeof raw.agentId === "string" && raw.agentId.trim() ? raw.agentId.trim() : "";
    const result = listWebhookTriggers(cfg);
    respond(
      true,
      agentId
        ? {
            ...result,
            triggers: result.triggers.filter(
              (trigger) => (trigger.agentId?.trim() || resolveDefaultAgentId(cfg)) === agentId,
            ),
          }
        : result,
      undefined,
    );
  },

  "webhookTriggers.upsert": async ({ params, respond }) => {
    const raw = readRecord(params);
    const parsed = parseWebhookTriggerParams(raw);
    if (!parsed.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, parsed.error));
      return;
    }
    const cfg = loadConfig();
    const knownAgents = listAgentIds(cfg);
    if (parsed.value.agentId && !knownAgents.includes(parsed.value.agentId)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `unknown agent id "${parsed.value.agentId}"`),
      );
      return;
    }
    const next = buildConfigWithWebhookTrigger({ config: cfg, mapping: parsed.value });
    await writeConfigFile(next.config);
    respond(
      true,
      {
        changed: true,
        tokenCreated: next.tokenCreated,
        ...(next.tokenCreated ? { token: next.config.hooks?.token } : {}),
        ...listWebhookTriggers(next.config),
      },
      undefined,
    );
  },

  "webhookTriggers.remove": async ({ params, respond }) => {
    const raw = readRecord(params);
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    if (!id) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "invalid webhookTriggers.remove params: id required",
        ),
      );
      return;
    }
    const cfg = loadConfig();
    const agentId = typeof raw.agentId === "string" && raw.agentId.trim() ? raw.agentId.trim() : "";
    if (agentId) {
      const mapping = findWebhookTriggerMapping({ config: cfg, id });
      if (!mapping || !webhookTriggerBelongsToAgent(cfg, mapping, agentId)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "Webhook trigger not found for selected Agent."),
        );
        return;
      }
    }
    const before = Array.isArray(cfg.hooks?.mappings) ? cfg.hooks.mappings.length : 0;
    const nextConfig = buildConfigWithoutWebhookTrigger({ config: cfg, id });
    const after = Array.isArray(nextConfig.hooks?.mappings) ? nextConfig.hooks.mappings.length : 0;
    await writeConfigFile(nextConfig);
    respond(
      true,
      {
        changed: after !== before,
        removed: after !== before,
        ...listWebhookTriggers(nextConfig),
      },
      undefined,
    );
  },

  "webhookTriggers.test": async ({ params, respond }) => {
    const raw = readRecord(params);
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    if (!id) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid webhookTriggers.test params: id required"),
      );
      return;
    }
    const cfg = loadConfig();
    const mapping = findWebhookTriggerMapping({ config: cfg, id });
    if (!mapping) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "Webhook trigger not found."),
      );
      return;
    }
    const agentId = typeof raw.agentId === "string" && raw.agentId.trim() ? raw.agentId.trim() : "";
    if (!webhookTriggerBelongsToAgent(cfg, mapping, agentId)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "Webhook trigger not found for selected Agent."),
      );
      return;
    }
    const basePath = normalizeHooksBasePath(cfg.hooks?.path);
    const path = normalizeTriggerPath(mapping.match.path);
    if (!path) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "Webhook trigger path is invalid."),
      );
      return;
    }
    const runId = randomUUID();
    const payload = readTestPayload(raw, id);
    const url = new URL(`${basePath}/${path}`, "http://127.0.0.1");
    const headers =
      raw.headers && typeof raw.headers === "object" && !Array.isArray(raw.headers)
        ? (raw.headers as Record<string, string>)
        : {};
    let taskCreated = false;
    const createTestTask = (
      task: string,
      extra?: { agentId?: string; sessionKey?: string; model?: string },
    ) => {
      taskCreated = true;
      return createRunningTaskRun({
        runtime: "webhook",
        sourceId: `hook:test:${id}`,
        runId,
        agentId: extra?.agentId ?? mapping.agentId,
        sessionKey: extra?.sessionKey ?? mapping.sessionKey,
        requesterSessionKey: extra?.sessionKey ?? mapping.sessionKey,
        taskKind: "webhook-trigger-test",
        task,
        model: extra?.model ?? mapping.model,
        notifyPolicy: normalizeWebhookTriggerNotifyPolicy(mapping.notifyPolicy),
        deliveryStatus: "not_applicable",
        metadata: {
          triggerId: id,
          path,
          action: mapping.action ?? "agent",
          test: true,
        },
      });
    };
    try {
      const resolved = resolveHookMappings({
        ...cfg.hooks,
        mappings: [mapping],
        presets: [],
      });
      const result = await applyHookMappings(resolved, {
        payload,
        headers,
        url,
        path,
      });
      if (!result) {
        createTestTask(`Webhook trigger test did not match ${path}.`);
        failTaskRunByRunId({
          runId,
          status: "blocked",
          summary: "Webhook trigger test did not match the configured path.",
          deliveryStatus: "not_applicable",
        });
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "Webhook trigger did not match."),
        );
        return;
      }
      if (!result.ok) {
        createTestTask(`Webhook trigger test failed: ${result.error}`);
        failTaskRunByRunId({
          runId,
          status: "blocked",
          summary: result.error,
          error: result.error,
          deliveryStatus: "not_applicable",
        });
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, result.error));
        return;
      }
      if (result.action === null) {
        const task = createTestTask("Webhook trigger test was skipped by transform.");
        completeTaskRunByRunId({
          runId,
          summary: "Webhook trigger transform skipped this payload.",
          deliveryStatus: "not_applicable",
        });
        respond(true, { ok: true, skipped: true, task }, undefined);
        return;
      }
      if (result.action.kind === "wake") {
        const task = createTestTask(result.action.text);
        const updated = completeTaskRunByRunId({
          runId,
          summary: "Webhook wake text rendered. Real POST will enqueue the wake event.",
          deliveryStatus: "not_applicable",
        });
        respond(true, { ok: true, action: "wake", task: updated ?? task }, undefined);
        return;
      }
      if (result.action.kind === "workflow") {
        const task = createTestTask(`Workflow ${result.action.workflowDefinitionId}`, {
          agentId: result.action.agentId,
          sessionKey: result.action.sessionKey,
        });
        const updated = completeTaskRunByRunId({
          runId,
          summary: "Webhook workflow target resolved. Real POST will run the saved workflow.",
          deliveryStatus: "not_applicable",
        });
        respond(
          true,
          {
            ok: true,
            action: "workflow",
            workflowDefinitionId: result.action.workflowDefinitionId,
            task: updated ?? task,
          },
          undefined,
        );
        return;
      }
      const task = createTestTask(result.action.message, {
        agentId: result.action.agentId,
        sessionKey: result.action.sessionKey,
        model: result.action.model,
      });
      const updated = completeTaskRunByRunId({
        runId,
        summary: "Webhook Agent prompt rendered. Real POST will run the selected Agent.",
        deliveryStatus: "not_applicable",
      });
      respond(
        true,
        {
          ok: true,
          action: "agent",
          task: updated ?? task,
        },
        undefined,
      );
    } catch (err) {
      if (!taskCreated) {
        createTestTask(`Webhook trigger test failed: ${String(err)}`);
      }
      failTaskRunByRunId({
        runId,
        status: "failed",
        summary: "Webhook trigger test failed.",
        error: String(err),
        deliveryStatus: "not_applicable",
      });
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
    }
  },

  "hooks.list": ({ params, respond }) => {
    const raw = readRecord(params);
    const resolved = resolveAgentIdOrRespondError(raw.agentId, respond);
    if (!resolved) {
      return;
    }
    const report = buildHooksReport({
      config: resolved.cfg,
      workspaceDir: resolved.workspaceDir,
    });
    respond(true, serializeReport({ agentId: resolved.agentId, report }), undefined);
  },

  "hooks.setEnabled": async ({ params, respond }) => {
    const raw = readRecord(params);
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    const enabled = raw.enabled;
    if (!name || typeof enabled !== "boolean") {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "invalid hooks.setEnabled params: name (string) and enabled (boolean) required",
        ),
      );
      return;
    }

    const resolved = resolveAgentIdOrRespondError(raw.agentId, respond);
    if (!resolved) {
      return;
    }
    const report = buildHooksReport({
      config: resolved.cfg,
      workspaceDir: resolved.workspaceDir,
    });
    const hook = resolveHookForToggle(report, name);
    if (!hook) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, `hook not found: ${name}`));
      return;
    }
    if (hook.managedByPlugin) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `hook "${hook.name}" is managed by plugin "${hook.pluginId ?? "unknown"}"`,
        ),
      );
      return;
    }
    if (enabled && !canEnableHook(hook)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `hook "${hook.name}" is missing requirements: ${summarizeMissing(hook).join(", ")}`,
        ),
      );
      return;
    }

    const nextConfig = buildConfigWithHookEnabled({
      config: resolved.cfg,
      hook,
      enabled,
    });
    await writeConfigFile(nextConfig);
    const nextReport = buildHooksReport({
      config: nextConfig,
      workspaceDir: resolved.workspaceDir,
    });
    respond(
      true,
      {
        changed: true,
        hookName: hook.name,
        hookKey: hook.hookKey,
        enabled,
        report: serializeReport({ agentId: resolved.agentId, report: nextReport }),
      },
      undefined,
    );
  },
};
