import crypto from "node:crypto";
import { listAgentEntries } from "../../agents/agent-scope.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import { parseDurationMs } from "../../cli/parse-duration.js";
import { writeConfigFile, type FasedAgentConfig } from "../../config/config.js";
import { updateSessionStore, type SessionEntry } from "../../config/sessions.js";
import type { AgentBinding } from "../../config/types.js";
import {
  formatCronEscalationContext,
  formatCronEscalationPasses,
  cronGraphRepairsForRun,
  formatCronRunLoadedSkills,
  formatCronGraphRepairLines,
  formatCronTaskRunDetail,
} from "../../cron/run-detail-format.js";
import { readCronTaskRunDetail } from "../../cron/run-detail.js";
import {
  readCronRunLogEntriesPage,
  resolveCronRunLogPath,
  type CronRunLogEntry,
} from "../../cron/run-log.js";
import { computeNextRunAtMs } from "../../cron/schedule.js";
import { loadCronStore, resolveCronStorePath, saveCronStore } from "../../cron/store.js";
import { resolveTaskModelRole, taskExplicitModelRef } from "../../cron/task-model-roles.js";
import { planTaskExecutionPolicy, withTaskCoordinationRequest } from "../../cron/task-planner.js";
import { readCronTaskRunQueue } from "../../cron/task-run-queue.js";
import { matchingTrustedSourcesForTask } from "../../cron/trusted-sources.js";
import type {
  CronDelivery,
  CronDeliveryStatus,
  CronDeliveryPatch,
  CronJob,
  CronJobPatch,
  CronSchedule,
  CronStoreFile,
  CronTaskExecutionPolicy,
  CronTaskRepairRecoveryResult,
} from "../../cron/types.js";
import { callGateway } from "../../gateway/call.js";
import { resolveInternalGatewayCallAuth } from "../../gateway/internal-call-auth.js";
import { logVerbose } from "../../globals.js";
import { formatDurationCompact } from "../../infra/format-time/format-duration.js";
import { DEFAULT_ACCOUNT_ID, normalizeAgentId } from "../../routing/session-key.js";
import type { MsgContext } from "../templating.js";
import type { CommandHandler, CommandHandlerResult } from "./commands-types.js";

const SESSION_NAMED_MARKER = ":chat:";

type CommandParams = Parameters<CommandHandler>[0];

function commandUsage() {
  return [
    "Usage:",
    "- /agent list",
    "- /agent switch <agent>",
    "- /session list",
    "- /session new <name>",
    "- /session switch <name|key|main>",
    "- /session current",
    "- /task list",
    "- /task list all",
    "- /task new every <duration> [<name>:] <prompt>",
    "- /task edit <id> [every <duration> <name>: <prompt>] [policy flags]",
    "- /task runs <id>",
    "- /task last <id>",
    "- /task run-show <runId>",
    "- /task run <id>",
    "- /task approve <id>",
    "- /task ask <id> --agent <agent>",
    "- /task repair <id> add-source <url or note>",
    "- /task repair <id> retry",
    "- /task repair <id> configure",
    "- /task cancel-run <runId>",
    "- /task retry-run <runId>",
    "- /task clear-stale <runId>",
    "- /task cancel <id>",
  ].join("\n");
}

function resolveRawCommandRest(params: CommandParams, prefix: string): string {
  const raw = resolveRawCommandBody(params);
  const trimmed = raw.trim();
  return trimmed.toLowerCase().startsWith(prefix)
    ? trimmed.slice(prefix.length).trim()
    : params.command.commandBodyNormalized.slice(prefix.length).trim();
}

function resolveRawCommandBody(params: CommandParams): string {
  const raw =
    params.ctx.BodyForCommands ??
    params.ctx.CommandBody ??
    params.ctx.RawBody ??
    params.ctx.Body ??
    params.command.commandBodyNormalized;
  return String(raw);
}

function resolveTaskCommandRest(params: CommandParams): string {
  const raw = resolveRawCommandBody(params).trim();
  const rawMatch = /^(?:\/task|fased\s+task)\b/i.exec(raw);
  if (rawMatch) {
    return raw.slice(rawMatch[0].length).trim();
  }
  return params.command.commandBodyNormalized.replace(/^(?:\/task|fased\s+task)\b/i, "").trim();
}

function splitBatchedTaskCommandLines(params: CommandParams): string[] {
  const lines = resolveRawCommandBody(params)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length <= 1) {
    return [];
  }
  return lines.every((line) => line.toLowerCase().startsWith("/task ")) ? lines : [];
}

function normalizeToken(value: string | undefined | null): string {
  return (value ?? "").trim().toLowerCase();
}

function displayAgentName(cfg: FasedAgentConfig, agentId: string): string {
  const id = normalizeAgentId(agentId);
  const entry = listAgentEntries(cfg).find((agent) => normalizeAgentId(agent.id) === id);
  if (entry?.name?.trim()) {
    return entry.name.trim();
  }
  return id === "main" ? "Assistant" : id;
}

function findAgentId(cfg: FasedAgentConfig, raw: string): string | null {
  const query = raw.trim();
  if (!query) {
    return null;
  }
  const normalizedQuery = normalizeAgentId(query);
  const agents = listAgentEntries(cfg);
  if (agents.length === 0 && normalizedQuery === "main") {
    return "main";
  }
  const match = agents.find((agent) => {
    const id = normalizeAgentId(agent.id);
    const name = normalizeAgentId(agent.name);
    const displayName = normalizeAgentId(displayAgentName(cfg, id));
    return id === normalizedQuery || name === normalizedQuery || displayName === normalizedQuery;
  });
  return match ? normalizeAgentId(match.id) : null;
}

function stripChannelPrefix(value: string, channel: string): string {
  const trimmed = value.trim();
  const prefix = `${channel}:`;
  return trimmed.toLowerCase().startsWith(prefix) ? trimmed.slice(prefix.length) : trimmed;
}

function resolvePeerId(ctx: MsgContext, channel: string, kind: string): string | undefined {
  const from = ctx.From?.trim();
  const to = ctx.OriginatingTo?.trim() || ctx.To?.trim();
  if (kind === "direct") {
    if (from) {
      return stripChannelPrefix(from, channel);
    }
    if (ctx.SenderId?.trim()) {
      return ctx.SenderId.trim();
    }
    return undefined;
  }
  const groupedPrefix = `${channel}:${kind}:`;
  if (from?.toLowerCase().startsWith(groupedPrefix)) {
    return from.slice(groupedPrefix.length);
  }
  if (to) {
    return stripChannelPrefix(to, channel);
  }
  return undefined;
}

function resolveCurrentRouteMatch(params: CommandParams): AgentBinding["match"] | null {
  const channel =
    normalizeToken(String(params.ctx.OriginatingChannel ?? "")) ||
    normalizeToken(params.ctx.Surface) ||
    normalizeToken(params.ctx.Provider) ||
    normalizeToken(params.command.channel);
  if (!channel || channel === "webchat" || channel === "internal") {
    return null;
  }
  const match: AgentBinding["match"] = { channel };
  const accountId = params.ctx.AccountId?.trim();
  if (accountId && accountId !== DEFAULT_ACCOUNT_ID) {
    match.accountId = accountId;
  }
  const chatType = normalizeChatType(params.ctx.ChatType) ?? (params.isGroup ? "group" : "direct");
  const peerId = resolvePeerId(params.ctx, channel, chatType);
  if (peerId) {
    match.peer = { kind: chatType, id: peerId };
  }
  return match;
}

function sameRouteMatch(a: AgentBinding["match"], b: AgentBinding["match"]): boolean {
  return (
    normalizeToken(a.channel) === normalizeToken(b.channel) &&
    normalizeToken(a.accountId || DEFAULT_ACCOUNT_ID) ===
      normalizeToken(b.accountId || DEFAULT_ACCOUNT_ID) &&
    normalizeToken(a.peer?.kind) === normalizeToken(b.peer?.kind) &&
    normalizeToken(a.peer?.id) === normalizeToken(b.peer?.id) &&
    normalizeToken(a.guildId) === normalizeToken(b.guildId) &&
    normalizeToken(a.teamId) === normalizeToken(b.teamId)
  );
}

function describeRouteMatch(match: AgentBinding["match"]): string {
  const parts = [match.channel];
  if (match.accountId) {
    parts.push(match.accountId);
  }
  if (match.peer) {
    parts.push(`${match.peer.kind}:${match.peer.id}`);
  }
  return parts.join(" · ");
}

function resolveRouteBaseSessionKey(params: CommandParams): string {
  return (
    params.ctx.CommandTargetSessionKey?.trim() ||
    params.ctx.SessionKey?.trim() ||
    params.sessionEntry?.baseSessionKey?.trim() ||
    params.sessionKey
  ).toLowerCase();
}

function sessionLabel(entry: SessionEntry | undefined, fallback: string): string {
  return entry?.displayName?.trim() || entry?.label?.trim() || fallback;
}

function slugifySessionName(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "chat"
  );
}

function listNamedSessions(store: Record<string, SessionEntry>, baseSessionKey: string) {
  const base = baseSessionKey.toLowerCase();
  return Object.entries(store)
    .filter(([key, entry]) => {
      if (key === base) {
        return false;
      }
      return (
        entry?.baseSessionKey?.toLowerCase() === base ||
        key.toLowerCase().startsWith(`${base}${SESSION_NAMED_MARKER}`)
      );
    })
    .toSorted(([, a], [, b]) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

function nextSessionLabel(store: Record<string, SessionEntry>, baseSessionKey: string): string {
  const labels = new Set(
    listNamedSessions(store, baseSessionKey).map(([, entry]) =>
      sessionLabel(entry, "").trim().toLowerCase(),
    ),
  );
  for (let index = 1; index < 10_000; index += 1) {
    const label = `Chat ${index}`;
    if (!labels.has(label.toLowerCase())) {
      return label;
    }
  }
  return `Chat ${crypto.randomBytes(2).toString("hex")}`;
}

function uniqueNamedSessionKey(params: {
  store: Record<string, SessionEntry>;
  baseSessionKey: string;
  slug: string;
}): string {
  const base = params.baseSessionKey.toLowerCase();
  const root = `${base}${SESSION_NAMED_MARKER}${params.slug}`;
  if (!params.store[root]) {
    return root;
  }
  for (let index = 2; index < 10_000; index += 1) {
    const key = `${root}-${index}`;
    if (!params.store[key]) {
      return key;
    }
  }
  return `${root}-${crypto.randomBytes(3).toString("hex")}`;
}

function findNamedSession(
  store: Record<string, SessionEntry>,
  baseSessionKey: string,
  rawTarget: string,
): [string, SessionEntry] | null {
  const target = rawTarget.trim().toLowerCase();
  if (!target) {
    return null;
  }
  const named = listNamedSessions(store, baseSessionKey);
  for (const [key, entry] of named) {
    const slug = entry.sessionSlug?.trim().toLowerCase();
    const label = sessionLabel(entry, "").trim().toLowerCase();
    if (key.toLowerCase() === target || slug === target || label === target) {
      return [key, entry];
    }
  }
  return null;
}

async function withSessionStore<T>(
  params: CommandParams,
  mutator: (store: Record<string, SessionEntry>) => T | Promise<T>,
): Promise<T | null> {
  if (!params.storePath) {
    return null;
  }
  return await updateSessionStore(params.storePath, mutator);
}

async function handleAgentCommand(params: CommandParams): Promise<CommandHandlerResult | null> {
  const normalized = params.command.commandBodyNormalized;
  if (!/^\/agent(?:\s|$)/.test(normalized)) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /agent from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }
  const rest = resolveRawCommandRest(params, "/agent");
  const [actionRaw, ...argParts] = rest.split(/\s+/).filter(Boolean);
  const action = actionRaw?.toLowerCase() || "current";
  const currentAgentId = normalizeAgentId(params.agentId ?? params.sessionKey.split(":")[1]);

  if (action === "list") {
    const agents = listAgentEntries(params.cfg);
    const ids = agents.length > 0 ? agents.map((agent) => normalizeAgentId(agent.id)) : ["main"];
    const lines = ids.map((id) => {
      const marker = id === currentAgentId ? "*" : "-";
      return `${marker} ${displayAgentName(params.cfg, id)} (${id})`;
    });
    return { shouldContinue: false, reply: { text: `Agents\n${lines.join("\n")}` } };
  }

  if (action === "current") {
    return {
      shouldContinue: false,
      reply: { text: `Agent: ${displayAgentName(params.cfg, currentAgentId)} (${currentAgentId})` },
    };
  }

  if (action !== "switch") {
    return { shouldContinue: false, reply: { text: "Usage: /agent list | /agent switch <agent>" } };
  }

  const requested = argParts.join(" ");
  const agentId = findAgentId(params.cfg, requested);
  if (!agentId) {
    return {
      shouldContinue: false,
      reply: { text: `Unknown Agent "${requested}". Run /agent list.` },
    };
  }
  const match = resolveCurrentRouteMatch(params);
  if (!match) {
    return {
      shouldContinue: false,
      reply: {
        text: "Agent switching is available from channel chats. WebChat uses the Agent picker.",
      },
    };
  }
  const existingBindings = params.cfg.bindings ?? [];
  const nextBindings = existingBindings.filter((binding) => !sameRouteMatch(binding.match, match));
  nextBindings.push({
    agentId,
    match,
    comment: "Set from /agent switch.",
  });
  await writeConfigFile({
    ...params.cfg,
    bindings: nextBindings,
  });
  return {
    shouldContinue: false,
    reply: {
      text: `Agent switched to ${displayAgentName(params.cfg, agentId)} for ${describeRouteMatch(match)}. New messages in this chat will use that Agent.`,
    },
  };
}

async function handleNamedSessionCommand(
  params: CommandParams,
): Promise<CommandHandlerResult | null> {
  const rest = resolveRawCommandRest(params, "/session");
  const [actionRaw, ...argParts] = rest.split(/\s+/).filter(Boolean);
  const action = actionRaw?.toLowerCase() || "current";
  if (!["list", "new", "switch", "current", "main", "close"].includes(action)) {
    return null;
  }
  const baseSessionKey = resolveRouteBaseSessionKey(params);
  const result = await withSessionStore(params, async (store) => {
    const baseEntry = store[baseSessionKey] ?? {
      sessionId: crypto.randomUUID(),
      updatedAt: Date.now(),
    };
    store[baseSessionKey] = baseEntry;
    const activeKey = baseEntry.activeSessionKey?.trim().toLowerCase();

    if (action === "current") {
      const currentKey = activeKey && store[activeKey] ? activeKey : baseSessionKey;
      const currentEntry = store[currentKey];
      const label = currentKey === baseSessionKey ? "Main" : sessionLabel(currentEntry, currentKey);
      return `Session: ${label}\n${currentKey}`;
    }

    if (action === "list") {
      const named = listNamedSessions(store, baseSessionKey);
      const lines = [`* Main (${baseSessionKey})${activeKey ? "" : " active"}`];
      for (const [key, entry] of named.slice(0, 20)) {
        const active = key === activeKey ? " active" : "";
        lines.push(`- ${sessionLabel(entry, key)} (${entry.sessionSlug ?? key})${active}`);
      }
      if (named.length > 20) {
        lines.push(`... ${named.length - 20} more`);
      }
      return `Sessions\n${lines.join("\n")}`;
    }

    if (action === "new") {
      const label = argParts.join(" ").trim() || nextSessionLabel(store, baseSessionKey);
      const slug = slugifySessionName(label);
      const key = uniqueNamedSessionKey({ store, baseSessionKey, slug });
      store[key] = {
        sessionId: crypto.randomUUID(),
        updatedAt: Date.now(),
        baseSessionKey,
        sessionSlug: key.slice(key.lastIndexOf(SESSION_NAMED_MARKER) + SESSION_NAMED_MARKER.length),
        label,
        displayName: label,
        chatType: params.sessionEntry?.chatType,
        origin: params.sessionEntry?.origin,
        deliveryContext: params.sessionEntry?.deliveryContext,
        lastChannel: params.sessionEntry?.lastChannel,
        lastTo: params.sessionEntry?.lastTo,
        lastAccountId: params.sessionEntry?.lastAccountId,
        lastThreadId: params.sessionEntry?.lastThreadId,
      };
      baseEntry.activeSessionKey = key;
      baseEntry.updatedAt = Date.now();
      return `Created session "${label}". New messages in this chat will use it.`;
    }

    if (action === "main" || action === "close") {
      delete baseEntry.activeSessionKey;
      baseEntry.updatedAt = Date.now();
      return "Switched back to Main session.";
    }

    const requested = argParts.join(" ").trim();
    if (!requested || requested.toLowerCase() === "main") {
      delete baseEntry.activeSessionKey;
      baseEntry.updatedAt = Date.now();
      return "Switched back to Main session.";
    }
    const found = findNamedSession(store, baseSessionKey, requested);
    if (!found) {
      return `Unknown session "${requested}". Run /session list.`;
    }
    const [key, entry] = found;
    baseEntry.activeSessionKey = key;
    baseEntry.updatedAt = Date.now();
    return `Switched to session "${sessionLabel(entry, key)}".`;
  });

  if (result == null) {
    return {
      shouldContinue: false,
      reply: { text: "Session control is unavailable because the session store is not loaded." },
    };
  }
  return { shouldContinue: false, reply: { text: result } };
}

function formatSchedule(schedule: CronSchedule): string {
  if (schedule.kind === "at") {
    return `at ${schedule.at}`;
  }
  if (schedule.kind === "every") {
    return `every ${formatDuration(schedule.everyMs)}`;
  }
  return `cron ${schedule.expr}`;
}

function formatDuration(ms: number): string {
  return formatDurationCompact(ms, { spaced: true }) ?? "1s";
}

function formatTimestamp(ms: number | undefined): string | undefined {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) {
    return undefined;
  }
  return new Date(ms).toISOString();
}

function formatRelativeTimestamp(ms: number | undefined, nowMs = Date.now()): string | undefined {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) {
    return undefined;
  }
  const deltaMs = ms - nowMs;
  const prefix = deltaMs >= 0 ? "in " : "";
  const suffix = deltaMs < 0 ? " ago" : "";
  return `${prefix}${formatDuration(Math.abs(deltaMs))}${suffix}`;
}

function formatRunAge(ms: number | undefined): string {
  return formatRelativeTimestamp(ms)?.replace(/^in /, "") ?? "unknown time";
}

function formatDurationMaybe(ms: number | undefined): string | undefined {
  return typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? formatDuration(ms) : undefined;
}

function describeTaskPlan(job: CronJob): string {
  const policy = job.executionPolicy;
  const strategy = policy?.planner?.strategy;
  if (strategy === "cheap-model") {
    return "cheap check";
  }
  if (strategy === "strong-model") {
    return "strong model";
  }
  if (strategy === "skill-only") {
    return `skill-only${policy?.skillAction?.toolName ? ` ${policy.skillAction.toolName}` : ""}`;
  }
  if (strategy === "no-model" || policy?.executionMode === "no-model") {
    return "no model";
  }
  if (policy?.executionMode === "skill-only") {
    return `skill-only${policy.skillAction?.toolName ? ` ${policy.skillAction.toolName}` : ""}`;
  }
  if (policy?.modelPolicy?.mode === "task-override" && policy.modelPolicy.model) {
    return `model ${policy.modelPolicy.model}`;
  }
  return policy?.executionMode ?? "auto";
}

function describeTaskCoordination(job: CronJob): string | undefined {
  const coordination = job.executionPolicy?.coordination;
  if (!coordination?.mode || coordination.mode === "none") {
    return undefined;
  }
  const agents = coordination.agents?.length ? coordination.agents.join(", ") : "planner-selected";
  const maxAgents =
    typeof coordination.maxAgents === "number" && Number.isFinite(coordination.maxAgents)
      ? ` · max ${coordination.maxAgents}`
      : "";
  const approval =
    coordination.requireApproval === false ? " · approval optional" : " · approval required";
  return `${coordination.mode} ${agents}${maxAgents}${approval}`;
}

function describeTaskDelivery(job: CronJob): string {
  const delivery = job.delivery;
  if (!delivery || delivery.mode === "none") {
    return "no delivery";
  }
  if (delivery.mode === "webhook") {
    return `webhook${delivery.to ? ` -> ${delivery.to}` : ""}`;
  }
  const channel = delivery.channel ?? "channel";
  return `${channel}${delivery.to ? ` -> ${delivery.to}` : ""}`;
}

function describeRunDeliveryStatus(status: CronDeliveryStatus | undefined): string {
  if (status === "delivered") {
    return "delivery sent";
  }
  if (status === "not-delivered") {
    return "delivery failed";
  }
  if (status === "unknown") {
    return "delivery unknown";
  }
  return "delivery not requested";
}

function describeRunSource(entry: CronRunLogEntry): string {
  const policy = entry.policy;
  if (policy?.resultSource === "direct-tool") {
    return policy.resultAdapter
      ? `direct tool ${policy.resultAdapter} · no model`
      : "direct tool · no model";
  }
  if (policy?.resultSource === "direct-text") {
    return "direct task result · no model";
  }
  if (policy?.resultSource === "model") {
    const source = formatTaskModelSource(policy.modelSource);
    return `model ${entry.model ?? policy.modelOverride ?? "agent default"}${source ? ` · ${source}` : ""}`;
  }
  if (policy?.modelUsed === false) {
    return policy.resultAdapter
      ? `${policy.resultAdapter} · no model`
      : `${policy.effectiveExecutionMode ?? "task"} · no model`;
  }
  if (entry.model) {
    return `model ${entry.model}`;
  }
  return policy?.effectiveExecutionMode ?? policy?.requestedExecutionMode ?? "task run";
}

function formatTaskModelSource(value: string | undefined): string | undefined {
  const source = value?.trim();
  if (!source) {
    return undefined;
  }
  return source.charAt(0).toUpperCase() + source.slice(1);
}

function formatRunUsage(entry: CronRunLogEntry): string | undefined {
  const usage = entry.usage;
  if (!usage) {
    return undefined;
  }
  const parts = [
    typeof usage.total_tokens === "number" ? `${usage.total_tokens} total` : "",
    typeof usage.input_tokens === "number" ? `${usage.input_tokens} in` : "",
    typeof usage.output_tokens === "number" ? `${usage.output_tokens} out` : "",
    typeof usage.cache_read_tokens === "number" ? `${usage.cache_read_tokens} cache read` : "",
    typeof usage.cache_write_tokens === "number" ? `${usage.cache_write_tokens} cache write` : "",
  ].filter(Boolean);
  return parts.length ? `tokens ${parts.join(" · ")}` : undefined;
}

function taskRunTranscriptPath(entry: CronRunLogEntry): string | undefined {
  return entry.sessionKey ? `/chat?session=${encodeURIComponent(entry.sessionKey)}` : undefined;
}

function taskQueueRunId(entry: CronRunLogEntry): string | undefined {
  const runId = entry.policy?.runCheckpoint?.runId?.trim();
  return runId || undefined;
}

function taskRunRecoveryHint(entry: CronRunLogEntry): string | undefined {
  const runId = taskQueueRunId(entry);
  if (!runId) {
    return undefined;
  }
  if (entry.status === "error" || entry.status === "blocked") {
    return `retry with /task retry-run ${runId}`;
  }
  if (entry.policy?.runCheckpoint?.phase === "recovered") {
    return `retry recovered run with /task retry-run ${runId}`;
  }
  return undefined;
}

function formatTaskRunLine(entry: CronRunLogEntry): string {
  const parts = [
    `- ${entry.status ?? "unknown"}`,
    formatRunAge(entry.ts),
    describeRunSource(entry),
    describeRunDeliveryStatus(entry.deliveryStatus),
  ];
  const duration = formatDurationMaybe(entry.durationMs);
  if (duration) {
    parts.push(duration);
  }
  if (entry.error) {
    parts.push(entry.error);
  } else if (entry.summary) {
    parts.push(entry.summary);
  }
  const recovery = taskRunRecoveryHint(entry);
  if (recovery) {
    parts.push(recovery);
  }
  return parts.join(" · ");
}

function formatTaskSourceStopLabel(code: string): string {
  switch (code) {
    case "source_access_missing":
      return "source access missing";
    case "needs_user_source":
      return "needs trusted source";
    case "conflicting_sources":
      return "conflicting sources need review";
    case "repair_limit_reached":
      return "repair limit reached";
    case "insufficient_sources":
      return "insufficient sources";
    default:
      return code;
  }
}

function formatTaskEvaluatorDecision(decision: {
  action: string;
  reason: string;
  stopCode?: string;
}): string {
  const stop = decision.stopCode ? `${formatTaskSourceStopLabel(decision.stopCode)} · ` : "";
  return `${decision.action} · ${stop}${decision.reason}`;
}

function formatTaskLastRun(
  entry: CronRunLogEntry,
  job: CronJob,
  previousEntries: CronRunLogEntry[] = [],
): string {
  const timestamp = formatTimestamp(entry.ts);
  const lines = [
    `Latest run: ${job.name || job.id}`,
    `Task: ${job.id}`,
    `Status: ${entry.status ?? "unknown"}`,
    `When: ${formatRunAge(entry.ts)}${timestamp ? ` (${timestamp})` : ""}`,
    `Source: ${describeRunSource(entry)}`,
    `Delivery: ${describeRunDeliveryStatus(entry.deliveryStatus)}`,
  ];
  const duration = formatDurationMaybe(entry.durationMs);
  if (duration) {
    lines.push(`Duration: ${duration}`);
  }
  const usage = formatRunUsage(entry);
  if (usage) {
    lines.push(`Usage: ${usage}`);
  }
  if (entry.policy?.planner) {
    lines.push(`Planner: ${entry.policy.planner.strategy} · ${entry.policy.planner.rationale}`);
  }
  const modelSource = formatTaskModelSource(entry.policy?.modelSource);
  if (modelSource) {
    lines.push(`Model source: ${modelSource}`);
  }
  const loadedSkills = formatCronRunLoadedSkills(entry.policy);
  if (loadedSkills) {
    lines.push(loadedSkills);
  }
  if (entry.policy?.evaluator) {
    lines.push(`Evaluator: ${formatTaskEvaluatorDecision(entry.policy.evaluator)}`);
  }
  const escalationContext = formatCronEscalationContext({ entry, job, previousEntries });
  if (escalationContext) {
    lines.push(escalationContext);
  }
  lines.push(...formatCronEscalationPasses({ entry, previousEntries }));
  if (entry.error) {
    lines.push(`Error: ${entry.error}`);
  } else if (entry.summary) {
    lines.push(`Summary: ${entry.summary}`);
  }
  if (entry.sessionKey) {
    lines.push(`Session: ${entry.sessionKey}`);
  }
  const transcriptPath = taskRunTranscriptPath(entry);
  if (transcriptPath) {
    lines.push(`Transcript: ${transcriptPath}`);
  }
  const runId = taskQueueRunId(entry);
  const graphRepairs = cronGraphRepairsForRun(job, runId);
  if (graphRepairs.length > 0) {
    lines.push("Source repair:");
    lines.push(...formatCronGraphRepairLines(graphRepairs));
  }
  if (job.state.lastGraphRepairStop) {
    lines.push(
      `Repair stop: ${formatTaskSourceStopLabel(job.state.lastGraphRepairStop.code)} · ${job.state.lastGraphRepairStop.reason}`,
    );
  }
  if (runId) {
    lines.push(`Run: ${runId}`);
  }
  const recovery = taskRunRecoveryHint(entry);
  if (recovery) {
    lines.push(`Recovery: ${recovery}`);
  }
  return lines.join("\n");
}

async function readTaskRuns(params: {
  storePath: string;
  jobId: string;
  limit: number;
}): Promise<CronRunLogEntry[]> {
  const runLogPath = resolveCronRunLogPath({ storePath: params.storePath, jobId: params.jobId });
  const page = await readCronRunLogEntriesPage(runLogPath, {
    jobId: params.jobId,
    limit: params.limit,
    offset: 0,
    status: "all",
    sortDir: "desc",
  });
  return page.entries;
}

type TaskQueueControlAction = "cancel" | "retry" | "clear-stale";

const TASK_QUEUE_CONTROL_RPC: Record<TaskQueueControlAction, string> = {
  cancel: "cron.queue.cancel",
  retry: "cron.queue.retry",
  "clear-stale": "cron.queue.clearStale",
};

async function resolveScopedTaskQueueRun(params: {
  storePath: string;
  store: Awaited<ReturnType<typeof loadCronStore>>;
  command: CommandParams;
  runId: string;
}) {
  const queue = await readCronTaskRunQueue({ storePath: params.storePath });
  const run = queue.runs.find((candidate) => candidate.runId === params.runId);
  if (!run) {
    return { ok: false as const, text: `Task run not found: ${params.runId}` };
  }
  const job = params.store.jobs.find((candidate) => candidate.id === run.jobId);
  if (!job) {
    return {
      ok: false as const,
      text: `Task for run ${params.runId} was not found: ${run.jobId}`,
    };
  }
  if (!isJobInScope(job, params.command, true)) {
    return {
      ok: false as const,
      text: "Task run belongs to another Agent/session and was not changed.",
    };
  }
  return { ok: true as const, run, job };
}

async function controlTaskQueueRun(params: {
  storePath: string;
  store: Awaited<ReturnType<typeof loadCronStore>>;
  command: CommandParams;
  action: TaskQueueControlAction;
  runId: string;
}) {
  const scoped = await resolveScopedTaskQueueRun(params);
  if (!scoped.ok) {
    return scoped.text;
  }
  await callGateway({
    ...resolveInternalGatewayCallAuth(params.command.cfg),
    method: TASK_QUEUE_CONTROL_RPC[params.action],
    params: { runId: params.runId, reason: `channel /task ${params.action}` },
    timeoutMs: 30_000,
  });
  const taskLabel = scoped.job.name || scoped.job.id;
  if (params.action === "cancel") {
    return `Canceled run ${params.runId} for ${taskLabel}.`;
  }
  if (params.action === "retry") {
    return `Queued retry for run ${params.runId} on ${taskLabel}.\nUse /task runs ${scoped.job.id} to inspect it.`;
  }
  return `Cleared stale lease for run ${params.runId} on ${taskLabel}.\nUse /task runs ${scoped.job.id} to inspect it.`;
}

function describeTaskListStatus(job: CronJob): string {
  if (job.state.needsAccess) {
    return "needs access";
  }
  const lastStatus = job.state.lastRunStatus ?? job.state.lastStatus;
  if (!job.enabled) {
    if (lastStatus === "blocked") {
      return "blocked";
    }
    if (lastStatus === "error") {
      return "error";
    }
    return "inactive";
  }
  if (lastStatus === "blocked") {
    return "blocked";
  }
  if (lastStatus === "error") {
    return "error";
  }
  return "active";
}

function describeTaskLastState(job: CronJob): string | undefined {
  const status = job.state.lastRunStatus ?? job.state.lastStatus;
  if (!status) {
    return undefined;
  }
  const parts = [`last ${status}`];
  if (job.state.lastDeliveryStatus && job.state.lastDeliveryStatus !== "unknown") {
    parts.push(`delivery ${job.state.lastDeliveryStatus}`);
  }
  if (job.state.lastEvaluatorDecision?.action === "escalate") {
    parts.push("evaluator escalated");
  } else if (job.state.lastEvaluatorDecision?.stopCode) {
    parts.push(`evaluator ${formatTaskSourceStopLabel(job.state.lastEvaluatorDecision.stopCode)}`);
  } else if (job.state.lastEvaluatorDecision?.reason) {
    parts.push(`evaluator ${job.state.lastEvaluatorDecision.action}`);
  }
  if (job.state.lastError) {
    parts.push(`error ${job.state.lastError}`);
  }
  return parts.join(" · ");
}

function taskText(job: CronJob): string {
  const status = describeTaskListStatus(job);
  const nextRun = formatRelativeTimestamp(job.state.nextRunAtMs);
  const parts = [
    `- ${job.name || job.id}`,
    job.id,
    status,
    formatSchedule(job.schedule),
    describeTaskPlan(job),
    describeTaskDelivery(job),
  ];
  const coordination = describeTaskCoordination(job);
  if (coordination) {
    parts.push(`coordinate ${coordination}`);
  }
  if (nextRun) {
    parts.push(`next ${nextRun}`);
  }
  if (job.state.needsAccess?.reason) {
    parts.push(job.state.needsAccess.reason);
  } else if (job.state.lastError) {
    parts.push(job.state.lastError);
  }
  return parts.join(" · ");
}

function sortTasksForList(jobs: CronJob[]): CronJob[] {
  return jobs.toSorted((left, right) => {
    const leftActive = left.enabled ? 0 : 1;
    const rightActive = right.enabled ? 0 : 1;
    if (leftActive !== rightActive) {
      return leftActive - rightActive;
    }
    const leftNext = left.state.nextRunAtMs ?? Number.POSITIVE_INFINITY;
    const rightNext = right.state.nextRunAtMs ?? Number.POSITIVE_INFINITY;
    if (leftNext !== rightNext) {
      return leftNext - rightNext;
    }
    return (
      (right.updatedAtMs ?? right.createdAtMs ?? 0) - (left.updatedAtMs ?? left.createdAtMs ?? 0)
    );
  });
}

function formatTaskListReply(jobs: CronJob[], includeInactive: boolean): string {
  if (!includeInactive) {
    return `Tasks\n${sortTasksForList(jobs).slice(0, 20).map(taskText).join("\n")}`;
  }
  const sorted = sortTasksForList(jobs);
  const active = sorted.filter((job) => job.enabled);
  const inactive = sorted.filter((job) => !job.enabled);
  const sections: string[] = ["Tasks"];
  if (active.length > 0) {
    sections.push(`Active\n${active.slice(0, 20).map(taskText).join("\n")}`);
  }
  if (inactive.length > 0) {
    sections.push(`Inactive\n${inactive.slice(0, 20).map(taskText).join("\n")}`);
  }
  return sections.join("\n\n");
}

function describeTaskConfiguredModelSource(
  job: CronJob,
  cfg: FasedAgentConfig,
): string | undefined {
  const policy = job.executionPolicy;
  if (job.state.needsAccess?.code === "missing_cheap_check_model_role") {
    return "Blocked: missing cheap/check model role.";
  }
  const explicitModel = taskExplicitModelRef(job);
  if (explicitModel) {
    return "Task model override";
  }
  if (policy?.planner?.strategy === "cheap-model") {
    const role = resolveTaskModelRole({ cfg, agentId: job.agentId, role: "cheapCheck" });
    return role?.label ?? "Blocked: missing cheap/check model role.";
  }
  if (policy?.planner?.strategy === "strong-model") {
    const role = resolveTaskModelRole({ cfg, agentId: job.agentId, role: "strong" });
    return role?.label ?? "Agent default model";
  }
  return undefined;
}

function taskDetails(job: CronJob, cfg: FasedAgentConfig): string {
  const policy = job.executionPolicy;
  const payload =
    job.payload.kind === "agentTurn"
      ? job.payload.message
      : job.payload.kind === "systemEvent"
        ? job.payload.text
        : "";
  const lines = [
    `Task: ${job.name || job.id}`,
    `ID: ${job.id}`,
    `Status: ${job.enabled ? "enabled" : "disabled"}`,
    `Schedule: ${formatSchedule(job.schedule)}`,
  ];
  const nextRun = formatTimestamp(job.state.nextRunAtMs);
  if (nextRun) {
    lines.push(`Next run: ${nextRun}`);
  }
  if (job.agentId) {
    lines.push(`Agent: ${job.agentId}`);
  }
  if (job.sessionKey) {
    lines.push(`Session: ${job.sessionKey}`);
  }
  if (payload) {
    lines.push(`Prompt: ${payload}`);
  }
  lines.push(`Policy: ${describeTaskPlan(job)}`);
  if (policy?.memoryScope) {
    lines.push(`Memory: ${policy.memoryScope}`);
  }
  if (policy?.skillScope) {
    const skills = policy.allowedSkills?.length ? ` (${policy.allowedSkills.join(", ")})` : "";
    lines.push(`Skills: ${policy.skillScope}${skills}`);
  }
  const modelPolicy = policy?.modelPolicy;
  if (modelPolicy) {
    lines.push(
      `Model: ${modelPolicy.model ?? modelPolicy.mode ?? "auto"}${
        modelPolicy.escalationModel ? ` · escalation ${modelPolicy.escalationModel}` : ""
      }`,
    );
  }
  const coordination = describeTaskCoordination(job);
  if (coordination) {
    lines.push(`Coordination: ${coordination}`);
    if (
      job.executionPolicy?.coordination?.requireApproval !== false &&
      !job.state.coordinationApprovedAtMs
    ) {
      lines.push(`Approve: /task approve ${job.id}`);
    }
  }
  if (policy?.budget) {
    const budget = [
      typeof policy.budget.maxTokensPerRun === "number"
        ? `${policy.budget.maxTokensPerRun} tokens/run`
        : "",
      typeof policy.budget.maxCostUsdPerRun === "number"
        ? `$${policy.budget.maxCostUsdPerRun}/run`
        : "",
      typeof policy.budget.maxRunsPerHour === "number"
        ? `${policy.budget.maxRunsPerHour} runs/hour`
        : "",
    ].filter(Boolean);
    if (budget.length) {
      lines.push(`Budget: ${budget.join(" · ")}`);
    }
  }
  if (policy?.stop) {
    const stop = [
      policy.stop.onSuccess ? "on success" : "",
      policy.stop.outputIncludes?.length ? `text ${policy.stop.outputIncludes.join(", ")}` : "",
      policy.stop.maxSuccessfulRuns ? `${policy.stop.maxSuccessfulRuns} successes` : "",
      policy.stop.maxTotalRuns ? `${policy.stop.maxTotalRuns} total runs` : "",
    ].filter(Boolean);
    if (stop.length) {
      lines.push(`Stop: ${stop.join(" · ")}`);
    }
  }
  const modelSource = describeTaskConfiguredModelSource(job, cfg);
  if (modelSource) {
    lines.push(`Model source: ${modelSource}`);
  }
  lines.push(`Delivery: ${describeTaskDelivery(job).replace(/^delivery\s+/, "")}`);
  const lastRun = formatTimestamp(job.state.lastRunAtMs);
  if (lastRun) {
    lines.push(`Last run: ${lastRun}`);
  }
  const last = describeTaskLastState(job);
  if (last) {
    lines.push(`Last result: ${last}`);
  }
  if (typeof job.state.totalRuns === "number" || typeof job.state.successfulRuns === "number") {
    lines.push(`Runs: ${job.state.successfulRuns ?? 0}/${job.state.totalRuns ?? 0} successful`);
  }
  if (job.state.pendingEscalation) {
    lines.push(`Pending escalation: ${job.state.pendingEscalation.reason}`);
  }
  if (job.state.lastEvaluatorDecision?.reason) {
    lines.push(`Evaluator: ${formatTaskEvaluatorDecision(job.state.lastEvaluatorDecision)}`);
  }
  if (job.state.lastGraphRepairStop) {
    lines.push(
      `Repair stop: ${formatTaskSourceStopLabel(job.state.lastGraphRepairStop.code)} · ${job.state.lastGraphRepairStop.reason}`,
    );
  }
  return lines.join("\n");
}

function describeTaskResumeResult(job: CronJob): string {
  if (job.state?.needsAccess) {
    const lines = [`Task ${job.id} still needs access: ${job.state.needsAccess.reason}`];
    if (job.state.needsAccess.setupCommand) {
      lines.push(job.state.needsAccess.setupCommand);
    }
    if (job.state.needsAccess.setupPath) {
      lines.push(`Open ${job.state.needsAccess.setupPath}`);
    }
    lines.push(`Use /task show ${job.id} for details.`);
    return lines.join("\n");
  }
  const next = formatTimestamp(job.state?.nextRunAtMs);
  return `Resumed task ${job.id}${next ? ` · next ${next}` : ""}.\nUse /task show ${job.id} for details.`;
}

function repairActionLabel(action: string): string {
  switch (action) {
    case "add_trusted_source":
      return "added trusted source";
    case "retry_replacement":
      return "queued replacement retry";
    case "stop_source_path":
      return "stopped source path";
    case "configure_source":
      return "configure source";
    default:
      return action;
  }
}

function formatTaskRepairResult(id: string, result: CronTaskRepairRecoveryResult): string {
  const lines: string[] = [];
  if (result.ok) {
    lines.push(result.message || `Task ${id}: ${repairActionLabel(result.action)}.`);
  } else {
    lines.push(`Could not repair task ${id}: ${result.reason}`);
  }
  if (result.setupCommand) {
    lines.push(result.setupCommand);
  }
  if (result.setupPath) {
    lines.push(`Open ${result.setupPath}`);
  }
  if (result.ok && result.action !== "configure_source") {
    lines.push(`Use /task show ${id} for details.`);
  }
  return lines.join("\n");
}

const TASK_NEW_USAGE =
  "Usage: /task new every <duration> [<name>:] <prompt>\n" +
  "Also supported: /task new at <iso-time> <name>: <prompt>\n" +
  "Advanced: /task new cron <expr> -- <name>: <prompt>\n" +
  "Natural examples:\n" +
  "- /task new remind me every hour to check @wallet balance and send it here\n" +
  "- /task new Check market risk every 10 minutes and send the result back here\n" +
  "- /task new every 10 minutes Check market risk for BTC and SOL. Use a cheap check first and escalate if deeper analysis is needed.\n" +
  "- /task new every 1h Market watch: Monitor market risk with a cheap check first and escalate if deeper analysis is needed.\n" +
  "- /task new every 30m Wallet pulse: check @wallet balance\n" +
  'Advanced flags: --objective <text> --success <text> --mode agent-turn|skill-only|no-model|auto --memory none|session-summary|pinned|search|agent --skills wallet,search --tool wallet --input \'{"action":"balance"}\' --model provider/model --escalate provider/model --coordinate consult|parallel|none --ask-agent research,support --max-coordination-agents 2 --coordination-approval true --max-tokens 1000 --max-cost 0.05 --max-runs-hour 12 --stop-on-success true --stop-text done,complete --max-successes 1 --max-total-runs 10 --auto-repair true --auto-stop-optional false --max-auto-repairs 1 --primary-source-approval true';

const TASK_EDIT_USAGE =
  "Usage: /task edit <id> [every <duration> <name>: <prompt> | at <iso-time> <name>: <prompt> | cron <expr> -- <name>: <prompt> | <name>: <prompt> | <prompt>] [policy flags]\n" +
  "Natural edits: /task edit <id> every 30m, /task edit <id> send here, /task edit <id> use cheap check, /task edit <id> stop after success\n" +
  "Delivery flags: --delivery none|announce --channel telegram --to <target> --best-effort true|false";

const TASK_REPAIR_USAGE =
  "Usage: /task repair <id> add-source <url or note> | retry | stop-source [sourceNodeId] | configure";

function isJobInScope(job: CronJob, params: CommandParams, includeAgent: boolean): boolean {
  if (job.sessionKey && job.sessionKey === params.sessionKey) {
    return true;
  }
  if (
    includeAgent &&
    job.agentId &&
    normalizeAgentId(job.agentId) === normalizeAgentId(params.agentId)
  ) {
    return true;
  }
  return false;
}

function splitTaskNameAndMessage(raw: string): { name: string; message: string } | null {
  const index = raw.indexOf(":");
  if (index < 0) {
    return null;
  }
  const name = raw.slice(0, index).trim();
  const message = raw.slice(index + 1).trim();
  if (!name || !message) {
    return null;
  }
  return { name, message };
}

function inferTaskNameFromMessage(message: string): string {
  const normalized = message
    .replace(/\s+/g, " ")
    .replace(/^[\s"'`]+|[\s"'`]+$/g, "")
    .trim();
  if (!normalized) {
    return "Scheduled task";
  }
  const cleaned = normalized.replace(/^(?:please|can you|could you|would you)\s+/i, "");
  const words = cleaned.split(/\s+/).filter(Boolean);
  const stopWords = new Set([
    "and",
    "because",
    "if",
    "for",
    "otherwise",
    "report",
    "send",
    "then",
    "to",
    "use",
    "using",
    "when",
    "while",
    "with",
  ]);
  const selected: string[] = [];
  for (const word of words) {
    const plain = word.replace(/^[^\w@#]+|[^\w@#]+$/g, "");
    if (!plain) {
      continue;
    }
    if (selected.length >= 3 && stopWords.has(plain.toLowerCase())) {
      break;
    }
    selected.push(plain);
    if (selected.length >= 5) {
      break;
    }
  }
  const name = (selected.length > 0 ? selected.join(" ") : cleaned)
    .replace(/[.:;,!?]+$/g, "")
    .trim();
  return name.slice(0, 64) || "Scheduled task";
}

function splitOrInferTaskNameAndMessage(raw: string): { name: string; message: string } | null {
  const explicit = splitTaskNameAndMessage(raw);
  if (explicit) {
    return explicit;
  }
  const message = raw.trim();
  if (!message) {
    return null;
  }
  return { name: inferTaskNameFromMessage(message), message };
}

function parseTaskFlagValue(params: {
  raw: string;
  names: string[];
  onValue: (value: string) => void;
}): string {
  const names = params.names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const pattern = new RegExp(
    `\\s+--(?:${names})\\s+(?:"([^"]*)"|'([^']*)'|(.+?)(?=\\s+--|$))`,
    "gi",
  );
  return params.raw.replace(
    pattern,
    (_match, doubleQuoted: string | undefined, singleQuoted: string | undefined, raw: string) => {
      params.onValue((doubleQuoted ?? singleQuoted ?? raw).trim());
      return "";
    },
  );
}

function parseOptionalTaskFlagValue(params: {
  raw: string;
  names: string[];
  onValue: (value: string | undefined) => void;
}): string {
  const names = params.names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const pattern = new RegExp(
    `\\s+--(?:${names})(?:\\s+(?:"([^"]*)"|'([^']*)'|(.+?)(?=\\s+--|$)))?`,
    "gi",
  );
  return params.raw.replace(
    pattern,
    (_match, doubleQuoted: string | undefined, singleQuoted: string | undefined, raw?: string) => {
      params.onValue(doubleQuoted ?? singleQuoted ?? raw?.trim());
      return "";
    },
  );
}

function parseTaskAgentList(raw: string | undefined) {
  return Array.from(
    new Set(
      (raw ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  );
}

function taskPromptText(job: CronJob) {
  return job.payload.kind === "agentTurn" ? job.payload.message : job.payload.text;
}

function parseTaskAskSpec(raw: string): {
  id: string;
  agents: string[];
  mode: "consult" | "parallel";
  approve: boolean;
  run: boolean;
} {
  let nextRaw = raw;
  let agentValue = "";
  let mode: "consult" | "parallel" = "consult";
  let approve = true;
  let run = true;
  nextRaw = parseTaskFlagValue({
    raw: nextRaw,
    names: ["agent", "agents"],
    onValue: (value) => {
      agentValue = value;
    },
  });
  nextRaw = parseTaskFlagValue({
    raw: nextRaw,
    names: ["mode"],
    onValue: (value) => {
      mode = value.trim().toLowerCase() === "parallel" ? "parallel" : "consult";
    },
  });
  nextRaw = parseOptionalTaskFlagValue({
    raw: nextRaw,
    names: ["no-approve"],
    onValue: () => {
      approve = false;
    },
  });
  nextRaw = parseOptionalTaskFlagValue({
    raw: nextRaw,
    names: ["no-run"],
    onValue: () => {
      run = false;
    },
  });
  return {
    id: nextRaw.trim(),
    agents: parseTaskAgentList(agentValue),
    mode,
    approve,
    run,
  };
}

function parseNonNegativeTaskNumber(label: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} must be 0 or greater.`);
  }
  return parsed;
}

function parseTaskBoolean(label: string, value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  throw new Error(`${label} must be true or false.`);
}

function splitCsv(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  );
}

function defaultTaskExecutionPolicy(): CronTaskExecutionPolicy {
  return {
    triggerKind: "schedule",
    executionMode: "auto",
    memoryScope: "session-summary",
    skillScope: "agent-default",
    modelPolicy: { mode: "auto" },
  };
}

function cloneTaskExecutionPolicy(
  policy: CronTaskExecutionPolicy | undefined,
): CronTaskExecutionPolicy {
  const base = policy ?? defaultTaskExecutionPolicy();
  return {
    ...base,
    allowedSkills: base.allowedSkills ? [...base.allowedSkills] : undefined,
    skillAction: base.skillAction
      ? {
          ...base.skillAction,
          input: base.skillAction.input ? { ...base.skillAction.input } : undefined,
        }
      : undefined,
    modelPolicy: base.modelPolicy ? { ...base.modelPolicy } : undefined,
    coordination: base.coordination
      ? {
          ...base.coordination,
          agents: base.coordination.agents ? [...base.coordination.agents] : undefined,
        }
      : undefined,
    budget: base.budget ? { ...base.budget } : undefined,
    stop: base.stop
      ? {
          ...base.stop,
          outputIncludes: base.stop.outputIncludes ? [...base.stop.outputIncludes] : undefined,
        }
      : undefined,
    repairPolicy: base.repairPolicy ? { ...base.repairPolicy } : undefined,
    planner: base.planner
      ? {
          ...base.planner,
          signals: base.planner.signals ? [...base.planner.signals] : undefined,
        }
      : undefined,
  };
}

function extractTaskExecutionPolicy(
  raw: string,
  basePolicy?: CronTaskExecutionPolicy,
): { raw: string; executionPolicy: CronTaskExecutionPolicy; changed: boolean } | { error: string } {
  let nextRaw = raw;
  let changed = false;
  const policy = cloneTaskExecutionPolicy(basePolicy);
  const budget: NonNullable<CronTaskExecutionPolicy["budget"]> = { ...policy.budget };
  const stop: NonNullable<CronTaskExecutionPolicy["stop"]> = { ...policy.stop };
  const coordination: NonNullable<CronTaskExecutionPolicy["coordination"]> = {
    ...policy.coordination,
    agents: policy.coordination?.agents ? [...policy.coordination.agents] : undefined,
  };
  const repairPolicy: NonNullable<CronTaskExecutionPolicy["repairPolicy"]> = {
    ...policy.repairPolicy,
  };
  let skillInput: Record<string, unknown> | undefined;
  const consume = (names: string[], onValue: (value: string) => void): { error?: string } => {
    try {
      nextRaw = parseTaskFlagValue({ raw: nextRaw, names, onValue });
      return {};
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  };
  const consumeOptional = (
    names: string[],
    onValue: (value: string | undefined) => void,
  ): { error?: string } => {
    try {
      nextRaw = parseOptionalTaskFlagValue({ raw: nextRaw, names, onValue });
      return {};
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  };

  const objective = consume(["objective"], (value) => {
    changed = true;
    const trimmed = value.trim();
    if (trimmed) {
      policy.objective = trimmed;
    }
  });
  if (objective.error) {
    return { error: objective.error };
  }

  const success = consume(["success"], (value) => {
    changed = true;
    const trimmed = value.trim();
    if (trimmed) {
      policy.successCriteria = trimmed;
    }
  });
  if (success.error) {
    return { error: success.error };
  }

  const mode = consume(["mode"], (value) => {
    const normalized = value.trim().toLowerCase();
    changed = true;
    if (
      normalized !== "auto" &&
      normalized !== "agent-turn" &&
      normalized !== "skill-only" &&
      normalized !== "no-model"
    ) {
      throw new Error(`Invalid task mode: ${value}`);
    }
    policy.executionMode = normalized;
  });
  if (mode.error) {
    return { error: mode.error };
  }

  const memory = consume(["memory"], (value) => {
    const normalized = value.trim().toLowerCase();
    changed = true;
    if (
      normalized !== "none" &&
      normalized !== "session-summary" &&
      normalized !== "pinned" &&
      normalized !== "search" &&
      normalized !== "agent"
    ) {
      throw new Error(`Invalid memory scope: ${value}`);
    }
    policy.memoryScope = normalized;
  });
  if (memory.error) {
    return { error: memory.error };
  }

  const skills = consume(["skills"], (value) => {
    changed = true;
    if (value.trim().toLowerCase() === "none") {
      policy.skillScope = "none";
      policy.allowedSkills = undefined;
      return;
    }
    const allowedSkills = splitCsv(value);
    if (allowedSkills.length > 0) {
      policy.skillScope = "selected";
      policy.allowedSkills = allowedSkills;
    }
  });
  if (skills.error) {
    return { error: skills.error };
  }

  const tool = consume(["tool"], (value) => {
    changed = true;
    const toolName = value.trim();
    if (toolName) {
      policy.skillAction = { toolName };
    }
  });
  if (tool.error) {
    return { error: tool.error };
  }

  const input = consume(["input"], (value) => {
    changed = true;
    try {
      const parsed = JSON.parse(value);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Skill input must be a JSON object.");
      }
      skillInput = parsed as Record<string, unknown>;
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : "Skill input must be valid JSON.", {
        cause: err,
      });
    }
  });
  if (input.error) {
    return { error: input.error };
  }

  const model = consume(["model"], (value) => {
    changed = true;
    const modelRef = value.trim();
    if (modelRef) {
      policy.modelPolicy = { ...policy.modelPolicy, mode: "task-override", model: modelRef };
    }
  });
  if (model.error) {
    return { error: model.error };
  }

  const escalation = consume(["escalate", "escalation"], (value) => {
    changed = true;
    const modelRef = value.trim();
    if (modelRef) {
      policy.modelPolicy = { ...policy.modelPolicy, escalationModel: modelRef };
    }
  });
  if (escalation.error) {
    return { error: escalation.error };
  }

  const coordinationMode = consume(["coordinate", "coordination"], (value) => {
    const normalized = value.trim().toLowerCase();
    changed = true;
    if (normalized !== "none" && normalized !== "consult" && normalized !== "parallel") {
      throw new Error(`Invalid coordination mode: ${value}`);
    }
    coordination.mode = normalized;
    if (normalized === "none") {
      coordination.agents = undefined;
      coordination.maxAgents = undefined;
      coordination.requireApproval = undefined;
    }
  });
  if (coordinationMode.error) {
    return { error: coordinationMode.error };
  }

  const coordinationAgents = consume(["ask-agent", "ask-agents", "agents"], (value) => {
    changed = true;
    if (value.trim().toLowerCase() === "none") {
      coordination.agents = undefined;
      coordination.mode = "none";
      return;
    }
    const agents = splitCsv(value).map((entry) => normalizeAgentId(entry));
    if (agents.length > 0) {
      coordination.agents = Array.from(new Set([...(coordination.agents ?? []), ...agents]));
      if (!coordination.mode || coordination.mode === "none") {
        coordination.mode = "consult";
      }
    }
  });
  if (coordinationAgents.error) {
    return { error: coordinationAgents.error };
  }

  const maxCoordinationAgents = consume(["max-coordination-agents", "max-agents"], (value) => {
    changed = true;
    const parsed = parseNonNegativeTaskNumber("max-coordination-agents", value);
    if (parsed <= 0) {
      throw new Error("max-coordination-agents must be greater than 0.");
    }
    coordination.maxAgents = Math.floor(parsed);
    if (!coordination.mode || coordination.mode === "none") {
      coordination.mode = "consult";
    }
  });
  if (maxCoordinationAgents.error) {
    return { error: maxCoordinationAgents.error };
  }

  const coordinationApproval = consume(
    ["coordination-approval", "require-coordination-approval"],
    (value) => {
      changed = true;
      coordination.requireApproval = parseTaskBoolean("coordination-approval", value);
      if (!coordination.mode || coordination.mode === "none") {
        coordination.mode = "consult";
      }
    },
  );
  if (coordinationApproval.error) {
    return { error: coordinationApproval.error };
  }

  const maxTokens = consume(["max-tokens"], (value) => {
    changed = true;
    budget.maxTokensPerRun = parseNonNegativeTaskNumber("max-tokens", value);
  });
  if (maxTokens.error) {
    return { error: maxTokens.error };
  }

  const maxCost = consume(["max-cost"], (value) => {
    changed = true;
    budget.maxCostUsdPerRun = parseNonNegativeTaskNumber("max-cost", value);
  });
  if (maxCost.error) {
    return { error: maxCost.error };
  }

  const maxRuns = consume(["max-runs-hour", "max-runs"], (value) => {
    changed = true;
    budget.maxRunsPerHour = parseNonNegativeTaskNumber("max-runs-hour", value);
  });
  if (maxRuns.error) {
    return { error: maxRuns.error };
  }

  const stopOnSuccess = consumeOptional(["stop-on-success"], (value) => {
    changed = true;
    stop.onSuccess = value === undefined ? true : parseTaskBoolean("stop-on-success", value);
  });
  if (stopOnSuccess.error) {
    return { error: stopOnSuccess.error };
  }

  const stopText = consume(["stop-text", "stop-contains"], (value) => {
    changed = true;
    const outputIncludes = splitCsv(value);
    if (outputIncludes.length > 0) {
      stop.outputIncludes = outputIncludes;
    }
  });
  if (stopText.error) {
    return { error: stopText.error };
  }

  const maxSuccesses = consume(["max-successes"], (value) => {
    changed = true;
    const parsed = parseNonNegativeTaskNumber("max-successes", value);
    if (parsed > 0) {
      stop.maxSuccessfulRuns = Math.floor(parsed);
    }
  });
  if (maxSuccesses.error) {
    return { error: maxSuccesses.error };
  }

  const maxTotalRuns = consume(["max-total-runs"], (value) => {
    changed = true;
    const parsed = parseNonNegativeTaskNumber("max-total-runs", value);
    if (parsed > 0) {
      stop.maxTotalRuns = Math.floor(parsed);
    }
  });
  if (maxTotalRuns.error) {
    return { error: maxTotalRuns.error };
  }

  const autoRepair = consume(["auto-repair", "auto-source-repair"], (value) => {
    changed = true;
    repairPolicy.autoRetryReplacement = parseTaskBoolean("auto-repair", value);
  });
  if (autoRepair.error) {
    return { error: autoRepair.error };
  }

  const autoStopOptional = consume(
    ["auto-stop-optional", "auto-stop-optional-sources"],
    (value) => {
      changed = true;
      repairPolicy.autoStopOptionalSources = parseTaskBoolean("auto-stop-optional", value);
    },
  );
  if (autoStopOptional.error) {
    return { error: autoStopOptional.error };
  }

  const maxAutoRepairs = consume(["max-auto-repairs", "max-repairs"], (value) => {
    changed = true;
    const parsed = parseNonNegativeTaskNumber("max-auto-repairs", value);
    if (parsed <= 0) {
      throw new Error("max-auto-repairs must be greater than 0.");
    }
    repairPolicy.maxAutoRepairsPerRun = Math.floor(parsed);
  });
  if (maxAutoRepairs.error) {
    return { error: maxAutoRepairs.error };
  }

  const primarySourceApproval = consume(
    ["primary-source-approval", "require-primary-source-approval"],
    (value) => {
      changed = true;
      repairPolicy.requireApprovalForPrimarySource = parseTaskBoolean(
        "primary-source-approval",
        value,
      );
    },
  );
  if (primarySourceApproval.error) {
    return { error: primarySourceApproval.error };
  }

  if (policy.executionMode === "no-model") {
    policy.modelPolicy = { mode: "none" };
  }
  if (policy.skillAction && skillInput) {
    policy.skillAction = { ...policy.skillAction, input: skillInput };
  }
  if (policy.executionMode === "skill-only" && !policy.skillAction?.toolName?.trim()) {
    return { error: "Skill-only tasks require --tool <toolName>." };
  }
  if (Object.keys(budget).length > 0) {
    policy.budget = budget;
  } else {
    policy.budget = undefined;
  }
  if (Object.keys(coordination).length > 0) {
    policy.coordination = coordination;
  } else {
    policy.coordination = undefined;
  }
  if (Object.keys(stop).length > 0) {
    policy.stop = stop;
  } else {
    policy.stop = undefined;
  }
  if (Object.keys(repairPolicy).length > 0) {
    policy.repairPolicy = repairPolicy;
  } else {
    policy.repairPolicy = undefined;
  }
  if (changed) {
    policy.planner = undefined;
  }
  return { raw: nextRaw.trim(), executionPolicy: policy, changed };
}

function extractTaskDeliveryPatch(
  raw: string,
): { raw: string; delivery?: CronDeliveryPatch; changed: boolean } | { error: string } {
  let nextRaw = raw;
  let changed = false;
  const delivery: CronDeliveryPatch = {};
  const consume = (names: string[], onValue: (value: string) => void): { error?: string } => {
    try {
      nextRaw = parseTaskFlagValue({ raw: nextRaw, names, onValue });
      return {};
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  };

  const mode = consume(["delivery"], (value) => {
    changed = true;
    const normalized = value.trim().toLowerCase();
    if (["none", "off", "no"].includes(normalized)) {
      delivery.mode = "none";
      return;
    }
    if (["announce", "channel", "on", "deliver"].includes(normalized)) {
      delivery.mode = "announce";
      return;
    }
    throw new Error(`Invalid delivery mode: ${value}`);
  });
  if (mode.error) {
    return { error: mode.error };
  }

  const channel = consume(["channel"], (value) => {
    changed = true;
    const channelId = value.trim();
    if (channelId) {
      delivery.channel = channelId as CronDeliveryPatch["channel"];
    }
  });
  if (channel.error) {
    return { error: channel.error };
  }

  const to = consume(["to", "target"], (value) => {
    changed = true;
    delivery.to = value.trim();
  });
  if (to.error) {
    return { error: to.error };
  }

  const bestEffort = consume(["best-effort"], (value) => {
    changed = true;
    delivery.bestEffort = parseTaskBoolean("best-effort", value);
  });
  if (bestEffort.error) {
    return { error: bestEffort.error };
  }

  return { raw: nextRaw.trim(), delivery: changed ? delivery : undefined, changed };
}

const TASK_DURATION_UNIT_ALIASES: Record<string, "ms" | "s" | "m" | "h" | "d"> = {
  millisecond: "ms",
  milliseconds: "ms",
  msec: "ms",
  msecs: "ms",
  ms: "ms",
  second: "s",
  seconds: "s",
  sec: "s",
  secs: "s",
  s: "s",
  minute: "m",
  minutes: "m",
  min: "m",
  mins: "m",
  m: "m",
  hour: "h",
  hours: "h",
  hr: "h",
  hrs: "h",
  h: "h",
  day: "d",
  days: "d",
  d: "d",
};

function normalizeTaskDurationCandidate(raw: string): string | null {
  const compact = raw.trim().toLowerCase();
  if (/^\d+(?:\.\d+)?(?:ms|s|m|h|d)(?:\d+(?:\.\d+)?(?:ms|s|m|h|d))*$/.test(compact)) {
    return compact;
  }
  if (/^[a-z]+$/.test(compact)) {
    const unit = TASK_DURATION_UNIT_ALIASES[compact];
    if (unit) {
      return `1${unit}`;
    }
  }
  const tokens = compact
    .replace(/,/g, " ")
    .split(/\s+/)
    .filter((token) => token && token !== "and");
  if (tokens.length === 0) {
    return null;
  }
  const parts: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const combined = /^(\d+(?:\.\d+)?)([a-z]+)$/.exec(token ?? "");
    if (combined?.[1] && combined[2]) {
      const unit = TASK_DURATION_UNIT_ALIASES[combined[2]];
      if (!unit) {
        return null;
      }
      parts.push(`${combined[1]}${unit}`);
      continue;
    }
    if (!/^\d+(?:\.\d+)?$/.test(token ?? "")) {
      return null;
    }
    const next = tokens[index + 1];
    const unit = next ? TASK_DURATION_UNIT_ALIASES[next] : undefined;
    if (!unit) {
      return null;
    }
    parts.push(`${token}${unit}`);
    index += 1;
  }
  return parts.length > 0 ? parts.join("") : null;
}

function parseLeadingTaskDuration(
  raw: string,
): { everyMs: number; durationRaw: string; rest: string } | { error: string } {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  for (let count = Math.min(6, tokens.length - 1); count >= 1; count -= 1) {
    const candidate = tokens.slice(0, count).join(" ");
    const normalized = normalizeTaskDurationCandidate(candidate);
    if (!normalized) {
      continue;
    }
    let everyMs = 0;
    try {
      everyMs = parseDurationMs(normalized);
    } catch {
      continue;
    }
    if (everyMs <= 0) {
      return { error: "Duration must be greater than 0." };
    }
    const rest = tokens.slice(count).join(" ").trim();
    if (!rest) {
      return { error: TASK_NEW_USAGE };
    }
    return { everyMs, durationRaw: candidate, rest };
  }
  const first = tokens[0] ?? "";
  return { error: first ? `Invalid duration "${first}".` : TASK_NEW_USAGE };
}

function parseTaskDurationOnly(
  raw: string,
): { everyMs: number; durationRaw: string } | { error: string } {
  const candidate = raw.trim();
  const normalized = normalizeTaskDurationCandidate(candidate);
  if (!normalized) {
    const first = candidate.split(/\s+/).find(Boolean) ?? "";
    return { error: first ? `Invalid duration "${first}".` : "Duration is required." };
  }
  try {
    const everyMs = parseDurationMs(normalized);
    if (everyMs <= 0) {
      return { error: "Duration must be greater than 0." };
    }
    return { everyMs, durationRaw: candidate };
  } catch (err) {
    return { error: err instanceof Error ? err.message : `Invalid duration "${candidate}".` };
  }
}

function shorthandTaskIntervalMs(raw: string): number | undefined {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "hourly") {
    return 3_600_000;
  }
  if (normalized === "daily") {
    return 24 * 3_600_000;
  }
  if (normalized === "weekly") {
    return 7 * 24 * 3_600_000;
  }
  return undefined;
}

function cleanNaturalTaskFragment(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .replace(/^[\s,.;:!?]+|[\s,.;:!?]+$/g, "")
    .replace(/^(?:please|can you|could you|would you)\s+/i, "")
    .replace(/^(?:to|that you|you should)\s+/i, "")
    .trim();
}

function isReminderLeadIn(raw: string): boolean {
  return /^(?:please\s+)?(?:remind me|send me a reminder|ping me|notify me)$/i.test(
    cleanNaturalTaskFragment(raw),
  );
}

function isNaturalWorkFragment(raw: string): boolean {
  return /\b(?:check|monitor|watch|status|search|find|research|summar[yi][sz]e|analy[sz]e|@?wallet|@?mining|@?offers)\b/i.test(
    raw,
  );
}

function joinNaturalTaskFragments(beforeRaw: string, afterRaw: string): string {
  const before = cleanNaturalTaskFragment(beforeRaw);
  const after = cleanNaturalTaskFragment(afterRaw);
  if (after && isReminderLeadIn(before)) {
    return isNaturalWorkFragment(after) ? after : `${before} to ${after}`;
  }
  if (after && !before) {
    return after;
  }
  if (!before) {
    return after;
  }
  if (!after) {
    return before;
  }
  const followUp = after.replace(/^(?:and|then)\s+/i, "").trim();
  if (/^(?:send|deliver|report|reply|message|notify)\b/i.test(followUp)) {
    return `${before}. ${followUp}`;
  }
  return `${before} ${followUp}`.trim();
}

function parseNaturalEveryTaskSpec(
  raw: string,
  nowMs: number,
):
  | { ok: true; name: string; message: string; schedule: CronSchedule }
  | { ok: false; error: string }
  | undefined {
  const shorthand = /^(hourly|daily|weekly)\s+([\s\S]+)$/i.exec(raw.trim());
  if (shorthand?.[1] && shorthand[2]) {
    const everyMs = shorthandTaskIntervalMs(shorthand[1]) ?? 3_600_000;
    const task = splitOrInferTaskNameAndMessage(shorthand[2]);
    if (!task) {
      return { ok: false, error: TASK_NEW_USAGE };
    }
    return {
      ok: true,
      ...task,
      schedule: { kind: "every", everyMs, anchorMs: nowMs },
    };
  }

  const trailingShorthand = /^([\s\S]+?)\s+(hourly|daily|weekly)$/i.exec(raw.trim());
  if (trailingShorthand?.[1] && trailingShorthand[2]) {
    const everyMs = shorthandTaskIntervalMs(trailingShorthand[2]) ?? 3_600_000;
    const task = splitOrInferTaskNameAndMessage(trailingShorthand[1]);
    if (!task) {
      return { ok: false, error: TASK_NEW_USAGE };
    }
    return {
      ok: true,
      ...task,
      schedule: { kind: "every", everyMs, anchorMs: nowMs },
    };
  }

  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  for (let everyIndex = 0; everyIndex < tokens.length - 1; everyIndex += 1) {
    if ((tokens[everyIndex] ?? "").toLowerCase() !== "every") {
      continue;
    }
    for (let count = Math.min(6, tokens.length - everyIndex - 1); count >= 1; count -= 1) {
      const candidate = tokens.slice(everyIndex + 1, everyIndex + 1 + count).join(" ");
      const normalized = normalizeTaskDurationCandidate(candidate);
      if (!normalized) {
        continue;
      }
      let everyMs = 0;
      try {
        everyMs = parseDurationMs(normalized);
      } catch {
        continue;
      }
      if (everyMs <= 0) {
        return { ok: false, error: "Duration must be greater than 0." };
      }
      const message = joinNaturalTaskFragments(
        tokens.slice(0, everyIndex).join(" "),
        tokens.slice(everyIndex + 1 + count).join(" "),
      );
      const task = splitOrInferTaskNameAndMessage(message);
      if (!task) {
        return { ok: false, error: TASK_NEW_USAGE };
      }
      return {
        ok: true,
        ...task,
        schedule: { kind: "every", everyMs, anchorMs: nowMs },
      };
    }
  }
  return undefined;
}

function parseTaskNewSpec(
  raw: string,
  nowMs: number,
):
  | { ok: true; name: string; message: string; schedule: CronSchedule }
  | { ok: false; error: string } {
  const trimmed = raw.trim();
  const everyBody = /^every\s+([\s\S]+)$/i.exec(trimmed)?.[1]?.trim();
  if (everyBody) {
    const duration = parseLeadingTaskDuration(everyBody);
    if ("error" in duration) {
      return { ok: false, error: duration.error };
    }
    const task = splitOrInferTaskNameAndMessage(duration.rest);
    if (!task) {
      return { ok: false, error: TASK_NEW_USAGE };
    }
    return {
      ok: true,
      ...task,
      schedule: { kind: "every", everyMs: duration.everyMs, anchorMs: nowMs },
    };
  }

  const atMatch = /^at\s+(\S+)\s+([\s\S]+)$/i.exec(trimmed);
  if (atMatch?.[1] && atMatch[2]) {
    const atMs = Date.parse(atMatch[1]);
    if (!Number.isFinite(atMs) || atMs <= nowMs) {
      return { ok: false, error: `Invalid future time "${atMatch[1]}".` };
    }
    const task = splitOrInferTaskNameAndMessage(atMatch[2]);
    if (!task) {
      return { ok: false, error: TASK_NEW_USAGE };
    }
    return {
      ok: true,
      ...task,
      schedule: { kind: "at", at: new Date(atMs).toISOString() },
    };
  }

  const cronMatch = /^cron\s+([\s\S]+?)\s+--\s+([\s\S]+)$/i.exec(trimmed);
  if (cronMatch?.[1] && cronMatch[2]) {
    const expr = cronMatch[1].trim();
    const task = splitTaskNameAndMessage(cronMatch[2]);
    if (!expr || !task) {
      return { ok: false, error: TASK_NEW_USAGE };
    }
    return { ok: true, ...task, schedule: { kind: "cron", expr } };
  }

  const naturalEvery = parseNaturalEveryTaskSpec(trimmed, nowMs);
  if (naturalEvery) {
    return naturalEvery;
  }

  return { ok: false, error: TASK_NEW_USAGE };
}

function slugifyTaskId(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 36) || "task"
  );
}

function uniqueTaskId(store: { jobs: CronJob[] }, name: string): string {
  const root = `task-${slugifyTaskId(name)}`;
  const suffix = crypto.randomBytes(3).toString("hex");
  const candidate = `${root}-${suffix}`;
  if (!store.jobs.some((job) => job.id === candidate)) {
    return candidate;
  }
  return `${root}-${crypto.randomUUID().slice(0, 8)}`;
}

function resolveTaskDelivery(params: CommandParams): CronDelivery | undefined {
  const channel =
    normalizeToken(String(params.ctx.OriginatingChannel ?? "")) ||
    normalizeToken(params.ctx.Surface) ||
    normalizeToken(params.ctx.Provider) ||
    normalizeToken(params.command.channel);
  if (!channel || channel === "webchat" || channel === "internal") {
    return undefined;
  }
  const rawTarget = params.ctx.OriginatingTo || params.ctx.From || params.ctx.To;
  const target = rawTarget ? stripChannelPrefix(rawTarget, channel).trim() : "";
  const delivery: CronDelivery = {
    mode: "announce",
    channel: channel as CronDelivery["channel"],
  };
  if (target) {
    delivery.to = target;
  }
  const accountId = params.ctx.AccountId?.trim();
  if (accountId && accountId !== DEFAULT_ACCOUNT_ID) {
    delivery.accountId = accountId;
  }
  return delivery;
}

function createTaskJob(params: {
  store: CronStoreFile;
  command: CommandParams;
  name: string;
  message: string;
  schedule: CronSchedule;
  executionPolicy: CronTaskExecutionPolicy;
  nowMs: number;
}): { ok: true; job: CronJob } | { ok: false; error: string } {
  let nextRunAtMs: number | undefined;
  try {
    nextRunAtMs = computeNextRunAtMs(params.schedule, params.nowMs);
  } catch (err) {
    return { ok: false, error: `Invalid schedule: ${String(err)}` };
  }
  if (nextRunAtMs === undefined) {
    return { ok: false, error: "Schedule does not produce a future run." };
  }
  const job: CronJob = {
    id: uniqueTaskId(params.store, params.name),
    agentId: normalizeAgentId(params.command.agentId),
    sessionKey: params.command.sessionKey,
    name: params.name,
    enabled: true,
    createdAtMs: params.nowMs,
    updatedAtMs: params.nowMs,
    schedule: params.schedule,
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: params.message },
    delivery: resolveTaskDelivery(params.command),
    executionPolicy: planTaskExecutionPolicy({
      name: params.name,
      message: params.message,
      policy: params.executionPolicy,
      trustedSources: matchingTrustedSourcesForTask({
        store: params.store,
        agentId: normalizeAgentId(params.command.agentId),
        sessionKey: params.command.sessionKey,
        text: [params.name, params.message].join(" "),
      }),
    }),
    state: { nextRunAtMs },
  };
  return { ok: true, job };
}

function createTaskFromCommandArgs(params: {
  actionArgs: string;
  store: CronStoreFile;
  command: CommandParams;
  nowMs: number;
}): { ok: true; job: CronJob } | { ok: false; error: string } {
  const taskPolicy = extractTaskExecutionPolicy(params.actionArgs);
  if ("error" in taskPolicy) {
    return { ok: false, error: taskPolicy.error };
  }
  const parsed = parseTaskNewSpec(taskPolicy.raw, params.nowMs);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error };
  }
  return createTaskJob({
    store: params.store,
    command: params.command,
    name: parsed.name,
    message: parsed.message,
    schedule: parsed.schedule,
    executionPolicy: taskPolicy.executionPolicy,
    nowMs: params.nowMs,
  });
}

function parseNaturalEditSchedule(
  raw: string,
  nowMs: number,
): { schedule: CronSchedule; changeLabel: string } | { error: string; handled: true } | undefined {
  const trimmed = cleanNaturalTaskFragment(raw);
  const shorthand =
    /^(?:make\s+(?:it\s+)?|change\s+(?:it\s+)?to\s+|run\s+)?(hourly|daily|weekly)$/i.exec(trimmed);
  if (shorthand?.[1]) {
    const everyMs = shorthandTaskIntervalMs(shorthand[1]);
    if (!everyMs) {
      return { error: `Invalid interval "${shorthand[1]}".`, handled: true };
    }
    return {
      schedule: { kind: "every", everyMs, anchorMs: nowMs },
      changeLabel: "schedule",
    };
  }

  const everyMatch =
    /^(?:(?:run|repeat)\s+|change\s+(?:it\s+)?to\s+|make\s+(?:it\s+)?run\s+)?(?:every|each)\s+([\s\S]+)$/i.exec(
      trimmed,
    );
  if (!everyMatch?.[1]) {
    return undefined;
  }
  const duration = parseTaskDurationOnly(everyMatch[1]);
  if ("error" in duration) {
    return undefined;
  }
  return {
    schedule: { kind: "every", everyMs: duration.everyMs, anchorMs: nowMs },
    changeLabel: "schedule",
  };
}

function parseNaturalEditDelivery(
  raw: string,
  command: CommandParams | undefined,
):
  | { delivery: CronDeliveryPatch | undefined; changeLabel: string }
  | { error: string }
  | undefined {
  const trimmed = cleanNaturalTaskFragment(raw);
  if (
    /^(?:no delivery|delivery off|disable delivery|stop (?:sending|delivering|replying))$/i.test(
      trimmed,
    )
  ) {
    return { delivery: { mode: "none" }, changeLabel: "delivery" };
  }
  if (
    !/\b(?:send|deliver|reply|message|post|report)\b/i.test(trimmed) ||
    !/\b(?:here|this chat|current chat|back here)\b/i.test(trimmed)
  ) {
    return undefined;
  }
  if (!command) {
    return {
      error: "This edit needs the current channel context. Use --channel and --to instead.",
    };
  }
  const delivery = resolveTaskDelivery(command);
  if (!delivery?.channel || !delivery.to) {
    return {
      error:
        "This channel does not expose a delivery target. Use --delivery announce --channel <channel> --to <target>.",
    };
  }
  return { delivery, changeLabel: "delivery" };
}

function policyWithPlanner(params: {
  policy: CronTaskExecutionPolicy;
  strategy: NonNullable<CronTaskExecutionPolicy["planner"]>["strategy"];
  rationale: string;
  signals?: string[];
}): CronTaskExecutionPolicy {
  return {
    ...params.policy,
    planner: {
      source: "heuristic",
      strategy: params.strategy,
      rationale: params.rationale,
      confidence: "high",
      signals: params.signals,
    },
  };
}

function autoOrExistingTaskModelPolicy(policy: CronTaskExecutionPolicy) {
  if (policy.modelPolicy?.model?.trim()) {
    return { ...policy.modelPolicy, mode: "task-override" as const };
  }
  return { ...policy.modelPolicy, mode: "auto" as const, model: undefined };
}

function parseNaturalEditPolicy(
  raw: string,
  basePolicy: CronTaskExecutionPolicy,
):
  | { policy: CronTaskExecutionPolicy; changeLabel: string; replan: boolean }
  | { error: string }
  | undefined {
  const trimmed = cleanNaturalTaskFragment(raw);
  const lower = trimmed.toLowerCase();
  const policy = cloneTaskExecutionPolicy(basePolicy);

  const modelMatch =
    /^(?:use\s+)?(?:model\s+)?([a-z0-9][a-z0-9._~:/-]*\/[a-z0-9][a-z0-9._~:/-]*)(?:\s+model)?$/i.exec(
      trimmed,
    );
  if (modelMatch?.[1]) {
    return {
      policy: {
        ...policy,
        executionMode: "agent-turn",
        modelPolicy: { ...policy.modelPolicy, mode: "task-override", model: modelMatch[1] },
        planner: undefined,
      },
      changeLabel: "policy",
      replan: false,
    };
  }

  const escalationMatch =
    /^(?:use\s+)?(?:escalation|escalate|stronger model|escalation model)\s+(?:to\s+)?([a-z0-9][a-z0-9._~:/-]*\/[a-z0-9][a-z0-9._~:/-]*)$/i.exec(
      trimmed,
    );
  if (escalationMatch?.[1]) {
    return {
      policy: {
        ...policy,
        executionMode: "agent-turn",
        modelPolicy: { ...policy.modelPolicy, escalationModel: escalationMatch[1] },
        evaluator: {
          ...policy.evaluator,
          escalateOnSignal: true,
          signalIncludes: policy.evaluator?.signalIncludes ?? ["Needs deeper analysis: yes"],
          maxEscalations: policy.evaluator?.maxEscalations ?? 1,
        },
        planner: undefined,
      },
      changeLabel: "policy",
      replan: false,
    };
  }

  if (/\b(?:no model|without model|do not use (?:a )?model)\b/i.test(trimmed)) {
    return {
      policy: policyWithPlanner({
        policy: {
          ...policy,
          executionMode: "no-model",
          memoryScope: "none",
          skillScope: "none",
          modelPolicy: { mode: "none" },
          evaluator: undefined,
        },
        strategy: "no-model",
        rationale: "User requested a no-model task policy.",
        signals: ["natural-edit"],
      }),
      changeLabel: "policy",
      replan: false,
    };
  }

  if (/\b(?:skill only|skill-only|tool only|direct tool)\b/i.test(trimmed)) {
    if (!policy.skillAction?.toolName?.trim()) {
      return { error: "Skill-only edit needs an existing task tool or --tool <toolName>." };
    }
    return {
      policy: policyWithPlanner({
        policy: {
          ...policy,
          executionMode: "skill-only",
          memoryScope: "none",
          skillScope: "selected",
          allowedSkills: policy.allowedSkills ?? [policy.skillAction.toolName],
          modelPolicy: { mode: "none" },
          evaluator: undefined,
        },
        strategy: "skill-only",
        rationale: "User requested deterministic skill-only execution.",
        signals: ["natural-edit", policy.skillAction.toolName],
      }),
      changeLabel: "policy",
      replan: false,
    };
  }

  if (/\b(?:cheap check|cheap model|cheap first|quick check|lightweight check)\b/i.test(trimmed)) {
    const allowedSkills =
      policy.allowedSkills ??
      (policy.skillAction?.toolName ? [policy.skillAction.toolName] : undefined);
    return {
      policy: policyWithPlanner({
        policy: {
          ...policy,
          executionMode: "agent-turn",
          memoryScope: policy.memoryScope ?? "none",
          skillScope: policy.skillScope ?? (allowedSkills?.length ? "selected" : "none"),
          allowedSkills,
          modelPolicy: autoOrExistingTaskModelPolicy(policy),
          evaluator: {
            ...policy.evaluator,
            escalateOnSignal: true,
            signalIncludes: policy.evaluator?.signalIncludes ?? ["Needs deeper analysis: yes"],
            maxEscalations: policy.evaluator?.maxEscalations ?? 1,
          },
        },
        strategy: "cheap-model",
        rationale: "User requested a cheap first pass with optional escalation.",
        signals: ["manual-evaluator"],
      }),
      changeLabel: "policy",
      replan: false,
    };
  }

  if (/\b(?:strong model|stronger model|deep analysis|reasoning model)\b/i.test(trimmed)) {
    return {
      policy: policyWithPlanner({
        policy: {
          ...policy,
          executionMode: "agent-turn",
          memoryScope: policy.memoryScope ?? "search",
          skillScope: policy.skillScope ?? "agent-default",
          modelPolicy: autoOrExistingTaskModelPolicy(policy),
          evaluator: undefined,
        },
        strategy: "strong-model",
        rationale: "User requested stronger model reasoning.",
        signals: ["natural-edit"],
      }),
      changeLabel: "policy",
      replan: false,
    };
  }

  if (
    /^(?:stop|pause|disable)\s+after\s+success$/i.test(lower) ||
    /^(?:stop|pause|disable)\s+on\s+success$/i.test(lower)
  ) {
    return {
      policy: {
        ...policy,
        stop: { ...policy.stop, onSuccess: true },
      },
      changeLabel: "stop rule",
      replan: false,
    };
  }

  const maxRunsMatch = /^stop\s+after\s+(\d+)\s+(?:total\s+)?runs?$/i.exec(trimmed);
  if (maxRunsMatch?.[1]) {
    return {
      policy: {
        ...policy,
        stop: { ...policy.stop, maxTotalRuns: Number.parseInt(maxRunsMatch[1], 10) },
      },
      changeLabel: "stop rule",
      replan: false,
    };
  }

  const maxSuccessesMatch = /^stop\s+after\s+(\d+)\s+success(?:es|ful runs?)?$/i.exec(trimmed);
  if (maxSuccessesMatch?.[1]) {
    return {
      policy: {
        ...policy,
        stop: { ...policy.stop, maxSuccessfulRuns: Number.parseInt(maxSuccessesMatch[1], 10) },
      },
      changeLabel: "stop rule",
      replan: false,
    };
  }

  return undefined;
}

function parseNaturalEditContent(
  raw: string,
): { patch: Pick<CronJobPatch, "name" | "payload">; changes: string[] } | undefined {
  const trimmed = cleanNaturalTaskFragment(raw);
  const renameMatch = /^(?:rename|name|title|set title)\s+(?:to\s+)?([\s\S]+)$/i.exec(trimmed);
  if (renameMatch?.[1]?.trim()) {
    return { patch: { name: renameMatch[1].trim() }, changes: ["name"] };
  }
  const promptMatch = /^(?:change\s+)?(?:prompt|message|task prompt)\s+(?:to\s+)?([\s\S]+)$/i.exec(
    trimmed,
  );
  if (promptMatch?.[1]?.trim()) {
    return {
      patch: { payload: { kind: "agentTurn", message: promptMatch[1].trim() } },
      changes: ["prompt"],
    };
  }
  return undefined;
}

type CronRunGatewayResult =
  | { ok: true; ran: true }
  | { ok: true; ran: false; reason?: string; runId?: string; detail?: string }
  | { ok: false; reason?: string; detail?: string };

function buildTaskEditPatch(params: {
  raw: string;
  job: CronJob;
  nowMs: number;
  command?: CommandParams;
}): { ok: true; patch: CronJobPatch; changes: string[] } | { ok: false; error: string } {
  const deliveryPatch = extractTaskDeliveryPatch(params.raw);
  if ("error" in deliveryPatch) {
    return { ok: false, error: deliveryPatch.error };
  }
  const taskPolicy = extractTaskExecutionPolicy(
    deliveryPatch.raw,
    params.job.executionPolicy ?? defaultTaskExecutionPolicy(),
  );
  if ("error" in taskPolicy) {
    return { ok: false, error: taskPolicy.error };
  }
  const body = taskPolicy.raw.trim();
  const patch: CronJobPatch = {};
  const changes: string[] = [];
  let replanPolicy = true;
  if (deliveryPatch.changed) {
    patch.delivery = deliveryPatch.delivery;
    changes.push("delivery");
  }
  if (taskPolicy.changed) {
    patch.executionPolicy = taskPolicy.executionPolicy;
    changes.push("policy");
  }
  if (body) {
    const naturalSchedule = parseNaturalEditSchedule(body, params.nowMs);
    if (naturalSchedule && "error" in naturalSchedule) {
      return { ok: false, error: naturalSchedule.error };
    }
    if (naturalSchedule) {
      patch.schedule = naturalSchedule.schedule;
      changes.push(naturalSchedule.changeLabel);
    } else {
      const naturalDelivery = parseNaturalEditDelivery(body, params.command);
      if (naturalDelivery && "error" in naturalDelivery) {
        return { ok: false, error: naturalDelivery.error };
      }
      if (naturalDelivery) {
        patch.delivery = naturalDelivery.delivery;
        changes.push(naturalDelivery.changeLabel);
      } else {
        const naturalPolicy = parseNaturalEditPolicy(
          body,
          patch.executionPolicy ?? params.job.executionPolicy ?? defaultTaskExecutionPolicy(),
        );
        if (naturalPolicy && "error" in naturalPolicy) {
          return { ok: false, error: naturalPolicy.error };
        }
        if (naturalPolicy) {
          patch.executionPolicy = naturalPolicy.policy;
          replanPolicy = naturalPolicy.replan;
          changes.push(naturalPolicy.changeLabel);
        } else {
          const naturalContent = parseNaturalEditContent(body);
          if (naturalContent) {
            Object.assign(patch, naturalContent.patch);
            changes.push(...naturalContent.changes);
          } else {
            const scheduleLike = /^(?:every|at|cron)\s+/i.test(body);
            const parsed = parseTaskNewSpec(body, params.nowMs);
            if (parsed.ok) {
              patch.name = parsed.name;
              patch.schedule = parsed.schedule;
              patch.payload = { kind: "agentTurn", message: parsed.message };
              changes.push("schedule", "name", "prompt");
            } else if (scheduleLike) {
              return { ok: false, error: parsed.error };
            } else {
              const task = splitTaskNameAndMessage(body);
              if (task) {
                patch.name = task.name;
                patch.payload = { kind: "agentTurn", message: task.message };
                changes.push("name", "prompt");
              } else {
                patch.payload = { kind: "agentTurn", message: body };
                changes.push("prompt");
              }
            }
          }
        }
      }
    }
  }
  if (Object.keys(patch).length === 0) {
    return { ok: false, error: TASK_EDIT_USAGE };
  }
  if (
    replanPolicy &&
    patch.executionPolicy !== null &&
    (patch.executionPolicy || patch.payload || patch.name)
  ) {
    patch.executionPolicy = planTaskExecutionPolicy({
      name: typeof patch.name === "string" ? patch.name : params.job.name,
      message:
        patch.payload?.kind === "agentTurn" && typeof patch.payload.message === "string"
          ? patch.payload.message
          : params.job.payload.kind === "agentTurn"
            ? params.job.payload.message
            : "",
      policy: patch.executionPolicy ?? params.job.executionPolicy ?? defaultTaskExecutionPolicy(),
    });
  }
  return { ok: true, patch, changes: Array.from(new Set(changes)) };
}

async function handleTaskCommand(params: CommandParams): Promise<CommandHandlerResult | null> {
  const normalized = params.command.commandBodyNormalized;
  if (!/^(?:\/task|fased\s+task)(?:\s|$)/.test(normalized)) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /task from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }
  const rest = resolveTaskCommandRest(params);
  const [actionRaw, ...argParts] = rest.split(/\s+/).filter(Boolean);
  const action = actionRaw?.toLowerCase() || "list";
  const actionArgs = actionRaw ? rest.slice(actionRaw.length).trim() : "";
  const storePath = resolveCronStorePath(params.cfg.cron?.store);
  const store = await loadCronStore(storePath);

  const batchedTaskLines = splitBatchedTaskCommandLines(params);
  if (batchedTaskLines.length > 1) {
    const nowMs = Date.now();
    const createdJobs: CronJob[] = [];
    for (const line of batchedTaskLines) {
      const lineRest = line.slice("/task".length).trim();
      const [lineActionRaw] = lineRest.split(/\s+/).filter(Boolean);
      const lineAction = lineActionRaw?.toLowerCase() || "list";
      const lineActionArgs = lineActionRaw ? lineRest.slice(lineActionRaw.length).trim() : "";
      if (lineAction !== "new") {
        return {
          shouldContinue: false,
          reply: { text: "Batched /task messages support /task new lines only." },
        };
      }
      const created = createTaskFromCommandArgs({
        actionArgs: lineActionArgs,
        store,
        command: params,
        nowMs,
      });
      if (!created.ok) {
        return { shouldContinue: false, reply: { text: created.error } };
      }
      store.jobs.push(created.job);
      createdJobs.push(created.job);
    }
    await saveCronStore(storePath, store);
    return {
      shouldContinue: false,
      reply: {
        text: `Created tasks\n${createdJobs
          .map(
            (job) =>
              `- ${job.name} (${job.id}) · ${formatSchedule(job.schedule)}${
                job.executionPolicy?.planner?.strategy
                  ? ` · plan ${job.executionPolicy.planner.strategy}`
                  : ""
              }`,
          )
          .join("\n")}`,
      },
    };
  }

  if (action === "new") {
    const nowMs = Date.now();
    const created = createTaskFromCommandArgs({
      actionArgs,
      store,
      command: params,
      nowMs,
    });
    if (!created.ok) {
      return { shouldContinue: false, reply: { text: created.error } };
    }
    store.jobs.push(created.job);
    await saveCronStore(storePath, store);
    return {
      shouldContinue: false,
      reply: {
        text: `Created task "${created.job.name}" (${created.job.id}) · ${formatSchedule(
          created.job.schedule,
        )}${
          created.job.executionPolicy?.planner?.strategy
            ? ` · plan ${created.job.executionPolicy.planner.strategy}`
            : ""
        }`,
      },
    };
  }

  if (action === "list") {
    const includeAgent = argParts[0]?.toLowerCase() === "all";
    const scopedJobs = store.jobs.filter((job) => isJobInScope(job, params, includeAgent));
    const jobs = includeAgent ? scopedJobs : scopedJobs.filter((job) => job.enabled);
    if (jobs.length === 0) {
      return {
        shouldContinue: false,
        reply: {
          text: includeAgent
            ? "No tasks found for this Agent."
            : scopedJobs.length > 0
              ? "No active tasks found for this session. Use /task list all to include inactive tasks and the whole Agent."
              : "No active tasks found for this session. Use /task list all to include the whole Agent.",
        },
      };
    }
    return {
      shouldContinue: false,
      reply: { text: formatTaskListReply(jobs, includeAgent) },
    };
  }

  if (action === "show" || action === "info" || action === "status") {
    const id = argParts.join(" ").trim();
    if (!id) {
      return { shouldContinue: false, reply: { text: "Usage: /task show <id>" } };
    }
    const job = store.jobs.find((candidate) => candidate.id === id);
    if (!job) {
      return { shouldContinue: false, reply: { text: `Task not found: ${id}` } };
    }
    if (!isJobInScope(job, params, true)) {
      return {
        shouldContinue: false,
        reply: { text: "Task belongs to another Agent/session and was not shown." },
      };
    }
    return { shouldContinue: false, reply: { text: taskDetails(job, params.cfg) } };
  }

  if (action === "runs" || action === "history") {
    const id = argParts[0]?.trim() ?? "";
    if (!id) {
      return { shouldContinue: false, reply: { text: "Usage: /task runs <id> [limit]" } };
    }
    const job = store.jobs.find((candidate) => candidate.id === id);
    if (!job) {
      return { shouldContinue: false, reply: { text: `Task not found: ${id}` } };
    }
    if (!isJobInScope(job, params, true)) {
      return {
        shouldContinue: false,
        reply: { text: "Task belongs to another Agent/session and was not shown." },
      };
    }
    const maybeLimit = Number.parseInt(argParts[1] ?? "", 10);
    const limit = Number.isFinite(maybeLimit) ? Math.max(1, Math.min(10, maybeLimit)) : 5;
    const runs = await readTaskRuns({ storePath, jobId: id, limit });
    if (runs.length === 0) {
      return {
        shouldContinue: false,
        reply: { text: `No runs recorded for ${id} yet.\nUse /task run ${id} to run it now.` },
      };
    }
    return {
      shouldContinue: false,
      reply: {
        text: [`Runs: ${job.name || id}`, `Task: ${id}`, ...runs.map(formatTaskRunLine)].join("\n"),
      },
    };
  }

  if (action === "last") {
    const id = argParts.join(" ").trim();
    if (!id) {
      return { shouldContinue: false, reply: { text: "Usage: /task last <id>" } };
    }
    const job = store.jobs.find((candidate) => candidate.id === id);
    if (!job) {
      return { shouldContinue: false, reply: { text: `Task not found: ${id}` } };
    }
    if (!isJobInScope(job, params, true)) {
      return {
        shouldContinue: false,
        reply: { text: "Task belongs to another Agent/session and was not shown." },
      };
    }
    const [last, ...previousEntries] = await readTaskRuns({ storePath, jobId: id, limit: 3 });
    if (!last) {
      if (job.state.needsAccess?.code === "missing_cheap_check_model_role") {
        return {
          shouldContinue: false,
          reply: {
            text: [
              `Latest run: ${job.name || job.id}`,
              `Task: ${job.id}`,
              "Status: blocked",
              "Blocked: missing cheap/check model role.",
              "Model source: Blocked: missing cheap/check model role.",
              "Open Agent > Models and assign Cheap/check, then use /task resume.",
            ].join("\n"),
          },
        };
      }
      return {
        shouldContinue: false,
        reply: { text: `No runs recorded for ${id} yet.\nUse /task run ${id} to run it now.` },
      };
    }
    return {
      shouldContinue: false,
      reply: { text: formatTaskLastRun(last, job, previousEntries) },
    };
  }

  if (action === "run-show" || action === "show-run" || action === "run-detail") {
    const runId = argParts.join(" ").trim();
    if (!runId) {
      return { shouldContinue: false, reply: { text: "Usage: /task run-show <runId>" } };
    }
    const detail = await readCronTaskRunDetail({
      storePath,
      runId,
      nowMs: Date.now(),
      jobs: store.jobs,
    });
    if (!detail) {
      return { shouldContinue: false, reply: { text: `Task run not found: ${runId}` } };
    }
    const job = detail.job ?? store.jobs.find((candidate) => candidate.id === detail.jobId);
    if (!job || !isJobInScope(job, params, true)) {
      return {
        shouldContinue: false,
        reply: { text: "Task run belongs to another Agent/session and was not shown." },
      };
    }
    return {
      shouldContinue: false,
      reply: { text: formatCronTaskRunDetail(detail, { commandPrefix: "/task" }) },
    };
  }

  if (
    action === "cancel-run" ||
    action === "retry-run" ||
    action === "clear-stale" ||
    action === "clear-stale-run"
  ) {
    const runId = argParts.join(" ").trim();
    if (!runId) {
      return {
        shouldContinue: false,
        reply: {
          text: "Usage: /task cancel-run <runId>, /task retry-run <runId>, or /task clear-stale <runId>",
        },
      };
    }
    const controlAction: TaskQueueControlAction =
      action === "cancel-run" ? "cancel" : action === "retry-run" ? "retry" : "clear-stale";
    const text = await controlTaskQueueRun({
      storePath,
      store,
      command: params,
      action: controlAction,
      runId,
    });
    return { shouldContinue: false, reply: { text } };
  }

  if (action === "repair" || action === "recover") {
    const id = argParts[0]?.trim() ?? "";
    const verb = argParts[1]?.toLowerCase() ?? "";
    if (!id || !verb) {
      return { shouldContinue: false, reply: { text: TASK_REPAIR_USAGE } };
    }
    const job = store.jobs.find((candidate) => candidate.id === id);
    if (!job) {
      return { shouldContinue: false, reply: { text: `Task not found: ${id}` } };
    }
    if (!isJobInScope(job, params, true)) {
      return {
        shouldContinue: false,
        reply: { text: "Task belongs to another Agent/session and was not changed." },
      };
    }

    const verbStart = actionArgs.indexOf(verb);
    const recoveryArgs = verbStart >= 0 ? actionArgs.slice(verbStart + verb.length).trim() : "";
    let repairAction:
      | "configure_source"
      | "add_trusted_source"
      | "retry_replacement"
      | "stop_source_path";
    let source: string | undefined;
    let sourceNodeId: string | undefined;
    if (verb === "configure" || verb === "config" || verb === "setup") {
      repairAction = "configure_source";
    } else if (
      verb === "add-source" ||
      verb === "source" ||
      verb === "trusted-source" ||
      verb === "add-trusted-source"
    ) {
      repairAction = "add_trusted_source";
      source = recoveryArgs;
      if (!source) {
        return {
          shouldContinue: false,
          reply: { text: "Usage: /task repair <id> add-source <url or note>" },
        };
      }
    } else if (verb === "retry" || verb === "retry-replacement" || verb === "replace") {
      repairAction = "retry_replacement";
    } else if (verb === "stop-source" || verb === "stop-path" || verb === "stop") {
      repairAction = "stop_source_path";
      sourceNodeId = recoveryArgs || undefined;
    } else {
      return { shouldContinue: false, reply: { text: TASK_REPAIR_USAGE } };
    }

    const result = await callGateway<CronTaskRepairRecoveryResult>({
      ...resolveInternalGatewayCallAuth(params.cfg),
      method: "cron.repair",
      params: { id, action: repairAction, source, sourceNodeId },
      timeoutMs: 30_000,
    });
    return {
      shouldContinue: false,
      reply: { text: formatTaskRepairResult(id, result) },
    };
  }

  if (action === "ask") {
    const spec = parseTaskAskSpec(actionArgs);
    if (!spec.id || spec.agents.length === 0) {
      return {
        shouldContinue: false,
        reply: {
          text: "Usage: /task ask <id> --agent <agent>[,<agent>] [--mode consult|parallel]",
        },
      };
    }
    const job = store.jobs.find((candidate) => candidate.id === spec.id);
    if (!job) {
      return { shouldContinue: false, reply: { text: `Task not found: ${spec.id}` } };
    }
    if (!isJobInScope(job, params, true)) {
      return {
        shouldContinue: false,
        reply: { text: "Task belongs to another Agent/session and was not changed." },
      };
    }
    const nowMs = Date.now();
    const executionPolicy = withTaskCoordinationRequest({
      policy: job.executionPolicy,
      message: taskPromptText(job),
      agents: spec.agents,
      mode: spec.mode,
      requireApproval: spec.approve,
    });
    await callGateway<CronJob>({
      ...resolveInternalGatewayCallAuth(params.cfg),
      method: "cron.update",
      params: {
        id: spec.id,
        patch: {
          executionPolicy,
          state: {
            pendingCoordination: {
              reason: `User requested task-room evidence from ${spec.agents.join(", ")}.`,
              signal: "manual_agent_request",
              agents: spec.agents,
              mode: spec.mode,
              createdAtMs: nowMs,
              sourceRunAtMs: nowMs,
            },
            ...(spec.approve ? { coordinationApprovedAtMs: nowMs } : {}),
          },
        },
      },
      timeoutMs: 30_000,
    });
    let suffix = "Queued Agent evidence.";
    if (spec.run) {
      const runResult = await callGateway<CronRunGatewayResult>({
        ...resolveInternalGatewayCallAuth(params.cfg),
        method: "cron.run",
        params: { id: spec.id, mode: "force" },
        timeoutMs: 120_000,
      });
      suffix =
        runResult.ok && runResult.ran
          ? "Queued Agent evidence and started a run."
          : `Queued Agent evidence. Run did not start: ${runResult.reason ?? "skipped"}.`;
    }
    return {
      shouldContinue: false,
      reply: {
        text: `${suffix}\nTask: ${spec.id}\nAgents: ${spec.agents.join(", ")}\nUse /task last ${spec.id} to inspect task-room evidence.`,
      },
    };
  }

  if (action === "approve") {
    const id = argParts.join(" ").trim();
    if (!id) {
      return { shouldContinue: false, reply: { text: "Usage: /task approve <id>" } };
    }
    const job = store.jobs.find((candidate) => candidate.id === id);
    if (!job) {
      return { shouldContinue: false, reply: { text: `Task not found: ${id}` } };
    }
    if (!isJobInScope(job, params, true)) {
      return {
        shouldContinue: false,
        reply: { text: "Task belongs to another Agent/session and was not approved." },
      };
    }
    await callGateway<CronJob>({
      ...resolveInternalGatewayCallAuth(params.cfg),
      method: "cron.update",
      params: { id, patch: { state: { coordinationApprovedAtMs: Date.now() } } },
      timeoutMs: 30_000,
    });
    const runResult = await callGateway<CronRunGatewayResult>({
      ...resolveInternalGatewayCallAuth(params.cfg),
      method: "cron.run",
      params: { id, mode: "force" },
      timeoutMs: 120_000,
    });
    const suffix =
      runResult.ok && runResult.ran
        ? "Started a run."
        : `Run did not start: ${runResult.reason ?? "skipped"}.`;
    return {
      shouldContinue: false,
      reply: {
        text: `Approved coordination for task ${id}. ${suffix}\nUse /task last ${id} to inspect task-room evidence.`,
      },
    };
  }

  if (action === "edit" || action === "update") {
    const id = argParts[0]?.trim() ?? "";
    if (!id) {
      return { shouldContinue: false, reply: { text: TASK_EDIT_USAGE } };
    }
    const job = store.jobs.find((candidate) => candidate.id === id);
    if (!job) {
      return { shouldContinue: false, reply: { text: `Task not found: ${id}` } };
    }
    if (!isJobInScope(job, params, true)) {
      return {
        shouldContinue: false,
        reply: { text: "Task belongs to another Agent/session and was not changed." },
      };
    }
    const rawEdit = actionArgs.slice(id.length).trim();
    const parsed = buildTaskEditPatch({ raw: rawEdit, job, nowMs: Date.now(), command: params });
    if (!parsed.ok) {
      return { shouldContinue: false, reply: { text: parsed.error } };
    }
    await callGateway<CronJob>({
      ...resolveInternalGatewayCallAuth(params.cfg),
      method: "cron.update",
      params: { id, patch: parsed.patch },
      timeoutMs: 30_000,
    });
    return {
      shouldContinue: false,
      reply: { text: `Updated task ${id}: ${parsed.changes.join(", ")}.` },
    };
  }

  if (action === "pause" || action === "disable" || action === "resume" || action === "enable") {
    const id = argParts.join(" ").trim();
    if (!id) {
      return {
        shouldContinue: false,
        reply: { text: "Usage: /task pause <id> or /task resume <id>" },
      };
    }
    const job = store.jobs.find((candidate) => candidate.id === id);
    if (!job) {
      return { shouldContinue: false, reply: { text: `Task not found: ${id}` } };
    }
    if (!isJobInScope(job, params, true)) {
      return {
        shouldContinue: false,
        reply: { text: "Task belongs to another Agent/session and was not changed." },
      };
    }
    const enable = action === "resume" || action === "enable";
    const updated = await callGateway<CronJob>({
      ...resolveInternalGatewayCallAuth(params.cfg),
      method: "cron.update",
      params: { id, patch: { enabled: enable } },
      timeoutMs: 30_000,
    });
    return {
      shouldContinue: false,
      reply: {
        text: enable
          ? describeTaskResumeResult(updated)
          : `Paused task ${id}.\nUse /task resume ${id} to enable it again.`,
      },
    };
  }

  if (action === "cancel" || action === "remove") {
    const id = argParts.join(" ").trim();
    if (!id) {
      return { shouldContinue: false, reply: { text: "Usage: /task cancel <id>" } };
    }
    const index = store.jobs.findIndex((job) => job.id === id);
    if (index < 0) {
      return { shouldContinue: false, reply: { text: `Task not found: ${id}` } };
    }
    const job = store.jobs[index];
    if (!job || !isJobInScope(job, params, true)) {
      return {
        shouldContinue: false,
        reply: { text: "Task belongs to another Agent/session and was not changed." },
      };
    }
    store.jobs.splice(index, 1);
    await saveCronStore(storePath, store);
    return { shouldContinue: false, reply: { text: `Canceled task ${id}.` } };
  }

  if (action === "run" || action === "force") {
    const id = argParts.join(" ").trim();
    if (!id) {
      return { shouldContinue: false, reply: { text: "Usage: /task run <id>" } };
    }
    const job = store.jobs.find((candidate) => candidate.id === id);
    if (!job) {
      return { shouldContinue: false, reply: { text: `Task not found: ${id}` } };
    }
    if (!isJobInScope(job, params, true)) {
      return {
        shouldContinue: false,
        reply: { text: "Task belongs to another Agent/session and was not run." },
      };
    }
    const result = await callGateway<CronRunGatewayResult>({
      ...resolveInternalGatewayCallAuth(params.cfg),
      method: "cron.run",
      params: { id, mode: "force" },
      timeoutMs: 120_000,
    });
    if (result.ok && result.ran) {
      const updatedStore = await loadCronStore(storePath);
      const updatedJob = updatedStore.jobs.find((candidate) => candidate.id === id) ?? job;
      const last = describeTaskLastState(updatedJob);
      return {
        shouldContinue: false,
        reply: {
          text: `Ran task ${id}${last ? ` · ${last}` : ""}.\nUse /task show ${id} for details.`,
        },
      };
    }
    if (result.ok && !result.ran) {
      const updatedStore = await loadCronStore(storePath);
      const updatedJob = updatedStore.jobs.find((candidate) => candidate.id === id) ?? job;
      const detail =
        result.detail ??
        updatedJob.state.needsAccess?.reason ??
        updatedJob.state.lastError ??
        updatedJob.state.stopReason;
      if (result.reason === "queued" || result.reason === "running") {
        return {
          shouldContinue: false,
          reply: {
            text: [
              `Task ${id} started and is still ${result.reason}${result.runId ? ` · run ${result.runId}` : ""}.`,
              detail ? `Current detail: ${detail}` : undefined,
              result.runId
                ? `Use /task run-show ${result.runId} or /task last ${id} for details.`
                : `Use /task show ${id} for details.`,
            ]
              .filter((line): line is string => Boolean(line))
              .join("\n"),
          },
        };
      }
      return {
        shouldContinue: false,
        reply: {
          text: `Task ${id} did not run: ${result.reason ?? "skipped"}${detail ? ` · ${detail}` : ""}.\nUse /task show ${id} for details.`,
        },
      };
    }
    const updatedStore = await loadCronStore(storePath);
    const updatedJob = updatedStore.jobs.find((candidate) => candidate.id === id) ?? job;
    const detail =
      updatedJob.state.needsAccess?.reason ??
      updatedJob.state.lastError ??
      updatedJob.state.stopReason;
    return {
      shouldContinue: false,
      reply: {
        text: `Failed to run task ${id}${detail ? ` · ${detail}` : ""}.\nUse /task show ${id} for details.`,
      },
    };
  }

  return {
    shouldContinue: false,
    reply: {
      text: `${TASK_NEW_USAGE}\n${TASK_EDIT_USAGE}\n${TASK_REPAIR_USAGE}\n/task list [all]\n/task show <id>\n/task runs <id> [limit]\n/task last <id>\n/task run-show <runId>\n/task run <id>\n/task ask <id> --agent <agent>\n/task approve <id>\n/task cancel-run <runId>\n/task retry-run <runId>\n/task clear-stale <runId>\n/task pause <id>\n/task resume <id>\n/task cancel <id>`,
    },
  };
}

export const handleControlCommands: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const normalized = params.command.commandBodyNormalized;
  if (!/^(?:\/(?:agent|task)|fased\s+task)(?:\s|$)/.test(normalized)) {
    return null;
  }
  return (
    (await handleAgentCommand(params)) ??
    (await handleTaskCommand(params)) ?? {
      shouldContinue: false,
      reply: { text: commandUsage() },
    }
  );
};

export async function handleNamedSessionControlCommand(
  params: CommandParams,
): Promise<CommandHandlerResult | null> {
  return await handleNamedSessionCommand(params);
}
