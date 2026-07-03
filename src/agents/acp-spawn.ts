import crypto from "node:crypto";
import fs from "node:fs/promises";
import { getAcpSessionManager } from "../acp/control-plane/manager.js";
import {
  cleanupFailedAcpSpawn,
  type AcpSpawnRuntimeCloseHandle,
} from "../acp/control-plane/spawn.js";
import { isAcpEnabledByPolicy, resolveAcpAgentPolicyError } from "../acp/policy.js";
import {
  resolveAcpSessionCwd,
  resolveAcpThreadSessionDetailLines,
} from "../acp/runtime/session-identifiers.js";
import type { AcpRuntimeSessionMode } from "../acp/runtime/types.js";
import { DEFAULT_HEARTBEAT_EVERY } from "../auto-reply/heartbeat.js";
import {
  resolveThreadBindingIntroText,
  resolveThreadBindingThreadName,
} from "../channels/thread-bindings-messages.js";
import {
  formatThreadBindingDisabledError,
  formatThreadBindingSpawnDisabledError,
  resolveThreadBindingConversationRef,
  resolveThreadBindingDeliveryTo,
  resolveThreadBindingIdleTimeoutMsForChannel,
  resolveThreadBindingMaxAgeMsForChannel,
  resolveThreadBindingPlacement,
  resolveThreadBindingSpawnPolicy,
} from "../channels/thread-bindings-policy.js";
import { parseDurationMs } from "../cli/parse-duration.js";
import { loadConfig } from "../config/config.js";
import type { FasedAgentConfig } from "../config/config.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import { loadSessionStore } from "../config/sessions/store.js";
import { resolveSessionTranscriptFile } from "../config/sessions/transcript.js";
import { callGateway } from "../gateway/call.js";
import { formatErrorMessage } from "../infra/errors.js";
import { areHeartbeatsEnabled } from "../infra/heartbeat-wake.js";
import {
  getSessionBindingService,
  isSessionBindingError,
  type SessionBindingPlacement,
  type SessionBindingRecord,
} from "../infra/outbound/session-binding-service.js";
import {
  isSubagentSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import { createRunningTaskRun } from "../tasks/task-executor.js";
import { deliveryContextFromSession, normalizeDeliveryContext } from "../utils/delivery-context.js";
import {
  resolveAcpSpawnStreamLogPath,
  startAcpSpawnParentStreamRelay,
  type AcpSpawnParentRelayHandle,
} from "./acp-spawn-parent-stream.js";
import { resolveAgentConfig, resolveDefaultAgentId } from "./agent-scope.js";
import { resolveSandboxRuntimeStatus } from "./sandbox/runtime-status.js";
import { resolveSpawnedWorkspaceInheritance } from "./spawned-context.js";

export const ACP_SPAWN_MODES = ["run", "session"] as const;
export type SpawnAcpMode = (typeof ACP_SPAWN_MODES)[number];

export type SpawnAcpParams = {
  task: string;
  label?: string;
  agentId?: string;
  cwd?: string;
  mode?: SpawnAcpMode;
  thread?: boolean;
  sandbox?: string;
  streamTo?: "parent" | "none";
};

export type SpawnAcpContext = {
  agentSessionKey?: string;
  agentChannel?: string;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
  agentGroupId?: string | number;
};

export type SpawnAcpAcceptedResult = {
  status: "accepted";
  childSessionKey: string;
  runId: string;
  mode: SpawnAcpMode;
  note: string;
  streamLogPath?: string;
};

export type SpawnAcpFailureResult = {
  status: "forbidden" | "error";
  error: string;
  errorCode?: string;
  childSessionKey?: string;
};

export type SpawnAcpResult = SpawnAcpAcceptedResult | SpawnAcpFailureResult;

export const ACP_SPAWN_ACCEPTED_NOTE =
  "initial ACP task queued in isolated session; follow-ups continue in the bound thread.";
export const ACP_SPAWN_SESSION_ACCEPTED_NOTE =
  "thread-bound ACP session stays active after this task; continue in-thread for follow-ups.";

export function isSpawnAcpAcceptedResult(result: SpawnAcpResult): result is SpawnAcpAcceptedResult {
  return result.status === "accepted";
}

type PreparedAcpThreadBinding = {
  channel: string;
  accountId: string;
  placement: SessionBindingPlacement;
  conversationId: string;
  parentConversationId?: string;
};

function resolveSpawnMode(params: {
  requestedMode?: SpawnAcpMode;
  threadRequested: boolean;
}): SpawnAcpMode {
  if (params.requestedMode === "run" || params.requestedMode === "session") {
    return params.requestedMode;
  }
  // Thread-bound spawns should default to persistent sessions.
  return params.threadRequested ? "session" : "run";
}

function resolveAcpSessionMode(mode: SpawnAcpMode): AcpRuntimeSessionMode {
  return mode === "session" ? "persistent" : "oneshot";
}

function resolveTargetAcpAgentId(params: {
  requestedAgentId?: string;
  cfg: FasedAgentConfig;
}): { ok: true; agentId: string } | { ok: false; error: string } {
  const requested = normalizeOptionalAgentId(params.requestedAgentId);
  if (requested) {
    return { ok: true, agentId: requested };
  }

  const configuredDefault = normalizeOptionalAgentId(params.cfg.acp?.defaultAgent);
  if (configuredDefault) {
    return { ok: true, agentId: configuredDefault };
  }

  return {
    ok: false,
    error:
      "ACP target agent is not configured. Pass `agentId` in `sessions_spawn` or set `acp.defaultAgent` in config.",
  };
}

function normalizeOptionalAgentId(value: string | undefined | null): string | undefined {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    return undefined;
  }
  return normalizeAgentId(trimmed);
}

function summarizeError(err: unknown): string {
  return formatErrorMessage(err);
}

function createAcpSpawnFailure(params: {
  status: "forbidden" | "error";
  error: string;
  errorCode?: string;
  childSessionKey?: string;
}): SpawnAcpFailureResult {
  return {
    status: params.status,
    error: params.error,
    ...(params.errorCode ? { errorCode: params.errorCode } : {}),
    ...(params.childSessionKey ? { childSessionKey: params.childSessionKey } : {}),
  };
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeOptionalLowercaseString(value: unknown): string | undefined {
  return normalizeOptionalString(value)?.toLowerCase();
}

function isMissingPathError(error: unknown): boolean {
  const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function resolveRuntimeCwdForAcpSpawn(params: {
  resolvedCwd?: string;
  explicitCwd?: string;
}): Promise<string | undefined> {
  if (!params.resolvedCwd) {
    return undefined;
  }
  if (normalizeOptionalString(params.explicitCwd)) {
    return params.resolvedCwd;
  }
  try {
    await fs.access(params.resolvedCwd);
    return params.resolvedCwd;
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined;
    }
    throw error;
  }
}

function resolveAcpSpawnRuntimePolicyError(params: {
  cfg: FasedAgentConfig;
  requesterSessionKey?: string;
  sandbox?: string;
}): string | undefined {
  const requesterRuntime = resolveSandboxRuntimeStatus({
    cfg: params.cfg,
    sessionKey: params.requesterSessionKey,
  });
  if (requesterRuntime.sandboxed) {
    return 'Sandboxed sessions cannot spawn ACP sessions because runtime="acp" runs on the host. Use runtime="subagent" from sandboxed sessions.';
  }
  if (params.sandbox === "require") {
    return 'sessions_spawn sandbox="require" is unsupported for runtime="acp" because ACP sessions run outside the sandbox. Use runtime="subagent" or sandbox="inherit".';
  }
  return undefined;
}

function resolveAcpSpawnChannelAccountId(params: {
  cfg: FasedAgentConfig;
  channel?: string;
  accountId?: string;
}): string | undefined {
  const explicit = normalizeOptionalString(params.accountId);
  if (explicit) {
    return explicit;
  }
  const channel = normalizeOptionalLowercaseString(params.channel);
  if (!channel) {
    return undefined;
  }
  const channels = params.cfg.channels as Record<string, { defaultAccount?: unknown } | undefined>;
  return normalizeOptionalString(channels?.[channel]?.defaultAccount) ?? "default";
}

function isHeartbeatEnabledForSessionAgent(params: {
  cfg: FasedAgentConfig;
  sessionKey?: string;
}): boolean {
  if (!areHeartbeatsEnabled()) {
    return false;
  }
  const requesterAgentId = parseAgentSessionKey(params.sessionKey)?.agentId;
  if (!requesterAgentId) {
    return true;
  }
  const defaultAgentId = resolveDefaultAgentId(params.cfg);
  const agentEntries = Array.isArray(params.cfg.agents?.list) ? params.cfg.agents.list : [];
  const hasExplicitHeartbeatAgents = agentEntries.some((entry) => Boolean(entry?.heartbeat));
  const enabledByPolicy = hasExplicitHeartbeatAgents
    ? agentEntries.some(
        (entry) => Boolean(entry?.heartbeat) && normalizeAgentId(entry?.id) === requesterAgentId,
      )
    : requesterAgentId === defaultAgentId;
  if (!enabledByPolicy) {
    return false;
  }
  const heartbeatEvery =
    resolveAgentConfig(params.cfg, requesterAgentId)?.heartbeat?.every ??
    params.cfg.agents?.defaults?.heartbeat?.every ??
    DEFAULT_HEARTBEAT_EVERY;
  const trimmed = normalizeOptionalString(heartbeatEvery);
  if (!trimmed) {
    return false;
  }
  try {
    return parseDurationMs(trimmed, { defaultUnit: "m" }) > 0;
  } catch {
    return false;
  }
}

function hasSessionLocalHeartbeatRelayRoute(params: {
  cfg: FasedAgentConfig;
  parentSessionKey: string;
  requesterAgentId: string;
}): boolean {
  if (params.cfg.session?.scope === "global") {
    return false;
  }
  const heartbeat =
    resolveAgentConfig(params.cfg, params.requesterAgentId)?.heartbeat ??
    params.cfg.agents?.defaults?.heartbeat;
  if ((heartbeat?.target ?? "none") !== "last") {
    return false;
  }
  if (normalizeOptionalString(heartbeat?.to) || normalizeOptionalString(heartbeat?.accountId)) {
    return false;
  }
  const storePath = resolveStorePath(params.cfg.session?.store, {
    agentId: params.requesterAgentId,
  });
  const parentEntry = loadSessionStore(storePath)[params.parentSessionKey];
  const context = deliveryContextFromSession(parentEntry);
  return Boolean(context?.channel && context.to);
}

function shouldStreamToParent(params: {
  cfg: FasedAgentConfig;
  spawnMode: SpawnAcpMode;
  requestThreadBinding: boolean;
  streamToParentRequested: boolean;
  parentSessionKey?: string;
  hasThreadContext: boolean;
}): boolean {
  if (params.streamToParentRequested) {
    return true;
  }
  const parentSessionKey = normalizeOptionalString(params.parentSessionKey);
  if (
    !parentSessionKey ||
    params.spawnMode !== "run" ||
    params.requestThreadBinding ||
    params.hasThreadContext ||
    !isSubagentSessionKey(parentSessionKey)
  ) {
    return false;
  }
  const requesterAgentId = parseAgentSessionKey(parentSessionKey)?.agentId;
  if (!requesterAgentId) {
    return false;
  }
  if (!isHeartbeatEnabledForSessionAgent({ cfg: params.cfg, sessionKey: parentSessionKey })) {
    return false;
  }
  return hasSessionLocalHeartbeatRelayRoute({
    cfg: params.cfg,
    parentSessionKey,
    requesterAgentId,
  });
}

async function persistAcpSpawnSessionFileBestEffort(params: {
  cfg: FasedAgentConfig;
  sessionKey: string;
  agentId: string;
  threadId?: string | number;
}) {
  try {
    const storePath = resolveStorePath(params.cfg.session?.store, {
      agentId: params.agentId,
    });
    const sessionStore = loadSessionStore(storePath);
    const sessionId = sessionStore[params.sessionKey]?.sessionId ?? params.sessionKey;
    await resolveSessionTranscriptFile({
      sessionId,
      sessionKey: params.sessionKey,
      storePath,
      agentId: params.agentId,
      threadId: params.threadId,
    });
  } catch {
    // Session-file persistence is best effort and must not fail ACP startup.
  }
}

function prepareAcpThreadBinding(params: {
  cfg: FasedAgentConfig;
  channel?: string;
  accountId?: string;
  to?: string;
  threadId?: string | number;
  groupId?: string | number;
}): { ok: true; binding: PreparedAcpThreadBinding } | { ok: false; error: string } {
  const channel = normalizeOptionalLowercaseString(params.channel);
  if (!channel) {
    return {
      ok: false,
      error: "thread=true for ACP sessions requires a channel context.",
    };
  }

  const accountId = resolveAcpSpawnChannelAccountId({
    cfg: params.cfg,
    channel,
    accountId: params.accountId,
  });
  const policy = resolveThreadBindingSpawnPolicy({
    cfg: params.cfg,
    channel,
    accountId,
    kind: "acp",
  });
  if (!policy.enabled) {
    return {
      ok: false,
      error: formatThreadBindingDisabledError({
        channel: policy.channel,
        accountId: policy.accountId,
        kind: "acp",
      }),
    };
  }
  if (!policy.spawnEnabled) {
    return {
      ok: false,
      error: formatThreadBindingSpawnDisabledError({
        channel: policy.channel,
        accountId: policy.accountId,
        kind: "acp",
      }),
    };
  }
  const bindingService = getSessionBindingService();
  const capabilities = bindingService.getCapabilities({
    channel: policy.channel,
    accountId: policy.accountId,
  });
  if (!capabilities.adapterAvailable) {
    return {
      ok: false,
      error: `Thread bindings are unavailable for ${policy.channel}.`,
    };
  }
  const placement = resolveThreadBindingPlacement({
    channel: policy.channel,
    placements: capabilities.placements,
  });
  if (!capabilities.bindSupported || !capabilities.placements.includes(placement)) {
    return {
      ok: false,
      error: `Thread bindings do not support ${placement} placement for ${policy.channel}.`,
    };
  }
  const conversationRef = resolveThreadBindingConversationRef({
    channel: policy.channel,
    to: params.to,
    threadId: params.threadId,
    groupId: params.groupId,
  });
  if (!conversationRef?.conversationId) {
    return {
      ok: false,
      error: `Could not resolve a ${policy.channel} conversation for ACP thread spawn.`,
    };
  }

  return {
    ok: true,
    binding: {
      channel: policy.channel,
      accountId: policy.accountId,
      placement,
      conversationId: conversationRef.conversationId,
      ...(conversationRef.parentConversationId
        ? { parentConversationId: conversationRef.parentConversationId }
        : {}),
    },
  };
}

export async function spawnAcpDirect(
  params: SpawnAcpParams,
  ctx: SpawnAcpContext,
): Promise<SpawnAcpResult> {
  const cfg = loadConfig();
  if (!isAcpEnabledByPolicy(cfg)) {
    return createAcpSpawnFailure({
      status: "forbidden",
      errorCode: "acp_disabled",
      error: "ACP is disabled by policy (`acp.enabled=false`).",
    });
  }

  const requestThreadBinding = params.thread === true;
  const parentSessionKey = normalizeOptionalString(ctx.agentSessionKey);
  const streamToParentRequested = params.streamTo === "parent";
  if (streamToParentRequested && !parentSessionKey) {
    return createAcpSpawnFailure({
      status: "error",
      errorCode: "requester_session_required",
      error: 'sessions_spawn streamTo="parent" requires an active requester session context.',
    });
  }
  const runtimePolicyError = resolveAcpSpawnRuntimePolicyError({
    cfg,
    requesterSessionKey: parentSessionKey,
    sandbox: params.sandbox,
  });
  if (runtimePolicyError) {
    return createAcpSpawnFailure({
      status: "forbidden",
      errorCode: "runtime_policy",
      error: runtimePolicyError,
    });
  }
  const spawnMode = resolveSpawnMode({
    requestedMode: params.mode,
    threadRequested: requestThreadBinding,
  });
  if (spawnMode === "session" && !requestThreadBinding) {
    return createAcpSpawnFailure({
      status: "error",
      errorCode: "thread_required",
      error: 'mode="session" requires thread=true so the ACP session can stay bound to a thread.',
    });
  }

  const targetAgentResult = resolveTargetAcpAgentId({
    requestedAgentId: params.agentId,
    cfg,
  });
  if (!targetAgentResult.ok) {
    return createAcpSpawnFailure({
      status: "error",
      errorCode: "target_agent_required",
      error: targetAgentResult.error,
    });
  }
  const targetAgentId = targetAgentResult.agentId;
  const agentPolicyError = resolveAcpAgentPolicyError(cfg, targetAgentId);
  if (agentPolicyError) {
    return createAcpSpawnFailure({
      status: "forbidden",
      errorCode: "agent_forbidden",
      error: agentPolicyError.message,
    });
  }

  const sessionKey = `agent:${targetAgentId}:acp:${crypto.randomUUID()}`;
  const runtimeMode = resolveAcpSessionMode(spawnMode);
  const requestedWorkspace = resolveSpawnedWorkspaceInheritance({
    config: cfg,
    targetAgentId,
    requesterSessionKey: parentSessionKey,
    explicitWorkspaceDir: params.cwd,
  });
  let runtimeCwd: string | undefined;
  try {
    runtimeCwd = await resolveRuntimeCwdForAcpSpawn({
      resolvedCwd: requestedWorkspace,
      explicitCwd: params.cwd,
    });
  } catch (error) {
    return createAcpSpawnFailure({
      status: "error",
      errorCode: "cwd_resolution_failed",
      error: summarizeError(error),
    });
  }
  const hasThreadContext =
    typeof ctx.agentThreadId === "string"
      ? Boolean(ctx.agentThreadId.trim())
      : ctx.agentThreadId != null;
  const streamToParent = shouldStreamToParent({
    cfg,
    spawnMode,
    requestThreadBinding,
    streamToParentRequested,
    parentSessionKey,
    hasThreadContext,
  });

  let preparedBinding: PreparedAcpThreadBinding | null = null;
  if (requestThreadBinding) {
    const prepared = prepareAcpThreadBinding({
      cfg,
      channel: ctx.agentChannel,
      accountId: ctx.agentAccountId,
      to: ctx.agentTo,
      threadId: ctx.agentThreadId,
      groupId: ctx.agentGroupId,
    });
    if (!prepared.ok) {
      return createAcpSpawnFailure({
        status: "error",
        errorCode: "thread_binding_invalid",
        error: prepared.error,
      });
    }
    preparedBinding = prepared.binding;
  }

  const acpManager = getAcpSessionManager();
  const bindingService = getSessionBindingService();
  let binding: SessionBindingRecord | null = null;
  let sessionCreated = false;
  let initializedRuntime: AcpSpawnRuntimeCloseHandle | undefined;
  try {
    await callGateway({
      method: "sessions.patch",
      params: {
        key: sessionKey,
        ...(parentSessionKey ? { spawnedBy: parentSessionKey } : {}),
        ...(params.label ? { label: params.label } : {}),
      },
      timeoutMs: 10_000,
    });
    sessionCreated = true;
    const initialized = await acpManager.initializeSession({
      cfg,
      sessionKey,
      agent: targetAgentId,
      mode: runtimeMode,
      cwd: runtimeCwd,
      backendId: cfg.acp?.backend,
    });
    initializedRuntime = {
      runtime: initialized.runtime,
      handle: initialized.handle,
    };
    await persistAcpSpawnSessionFileBestEffort({
      cfg,
      sessionKey,
      agentId: targetAgentId,
    });

    if (preparedBinding) {
      binding = await bindingService.bind({
        targetSessionKey: sessionKey,
        targetKind: "session",
        conversation: {
          channel: preparedBinding.channel,
          accountId: preparedBinding.accountId,
          conversationId: preparedBinding.conversationId,
          parentConversationId: preparedBinding.parentConversationId,
        },
        placement: preparedBinding.placement,
        metadata: {
          threadName: resolveThreadBindingThreadName({
            agentId: targetAgentId,
            label: params.label || targetAgentId,
          }),
          agentId: targetAgentId,
          label: params.label || undefined,
          boundBy: "system",
          introText: resolveThreadBindingIntroText({
            agentId: targetAgentId,
            label: params.label || undefined,
            idleTimeoutMs: resolveThreadBindingIdleTimeoutMsForChannel({
              cfg,
              channel: preparedBinding.channel,
              accountId: preparedBinding.accountId,
            }),
            maxAgeMs: resolveThreadBindingMaxAgeMsForChannel({
              cfg,
              channel: preparedBinding.channel,
              accountId: preparedBinding.accountId,
            }),
            sessionCwd: resolveAcpSessionCwd(initialized.meta),
            sessionDetails: resolveAcpThreadSessionDetailLines({
              sessionKey,
              meta: initialized.meta,
            }),
          }),
        },
      });
      if (!binding?.conversation.conversationId) {
        throw new Error(
          `Failed to create and bind a ${preparedBinding.channel} thread for this ACP session.`,
        );
      }
      if (preparedBinding.placement === "child") {
        await persistAcpSpawnSessionFileBestEffort({
          cfg,
          sessionKey,
          agentId: targetAgentId,
          threadId: binding.conversation.conversationId,
        });
      }
    }
  } catch (err) {
    await cleanupFailedAcpSpawn({
      cfg,
      sessionKey,
      shouldDeleteSession: sessionCreated,
      deleteTranscript: true,
      runtimeCloseHandle: initializedRuntime,
    });
    return createAcpSpawnFailure({
      status: "error",
      errorCode: "spawn_failed",
      error: isSessionBindingError(err) ? err.message : summarizeError(err),
    });
  }

  const requesterOrigin = normalizeDeliveryContext({
    channel: ctx.agentChannel,
    accountId: ctx.agentAccountId,
    to: ctx.agentTo,
    threadId: ctx.agentThreadId,
  });
  // For thread-bound ACP spawns, force bootstrap delivery to the new child thread.
  const boundThreadIdRaw = binding?.conversation.conversationId;
  const boundThreadId = boundThreadIdRaw ? String(boundThreadIdRaw).trim() || undefined : undefined;
  const fallbackThreadIdRaw = requesterOrigin?.threadId;
  const fallbackThreadId =
    fallbackThreadIdRaw != null ? String(fallbackThreadIdRaw).trim() || undefined : undefined;
  const bindingPlacement = preparedBinding?.placement;
  const deliveryThreadId =
    bindingPlacement === "child" ? (boundThreadId ?? fallbackThreadId) : fallbackThreadId;
  const inferredDeliveryTo = resolveThreadBindingDeliveryTo({
    channel: preparedBinding?.channel,
    placement: bindingPlacement,
    boundConversationId: boundThreadId,
    requesterTo: requesterOrigin?.to,
    deliveryThreadId,
  });
  const hasDeliveryTarget = Boolean(
    requestThreadBinding && !streamToParent && requesterOrigin?.channel && inferredDeliveryTo,
  );
  const childIdem = crypto.randomUUID();
  let childRunId: string = childIdem;
  let parentRelay: AcpSpawnParentRelayHandle | undefined;
  let streamLogPath: string | undefined;
  if (streamToParent && parentSessionKey) {
    streamLogPath = resolveAcpSpawnStreamLogPath({ childSessionKey: sessionKey });
    parentRelay = startAcpSpawnParentStreamRelay({
      runId: childIdem,
      parentSessionKey,
      childSessionKey: sessionKey,
      agentId: targetAgentId,
      logPath: streamLogPath,
      emitStartNotice: false,
    });
  }
  try {
    const response = await callGateway<{ runId?: string }>({
      method: "agent",
      params: {
        message: params.task,
        sessionKey,
        channel: hasDeliveryTarget ? requesterOrigin?.channel : undefined,
        to: hasDeliveryTarget ? inferredDeliveryTo : undefined,
        accountId: hasDeliveryTarget
          ? (preparedBinding?.accountId ?? requesterOrigin?.accountId ?? undefined)
          : undefined,
        threadId: hasDeliveryTarget ? deliveryThreadId : undefined,
        idempotencyKey: childIdem,
        deliver: hasDeliveryTarget,
        label: params.label || undefined,
      },
      timeoutMs: 10_000,
    });
    if (typeof response?.runId === "string" && response.runId.trim()) {
      childRunId = response.runId.trim();
    }
    if (parentRelay && childRunId !== childIdem && parentSessionKey) {
      parentRelay.dispose();
      parentRelay = startAcpSpawnParentStreamRelay({
        runId: childRunId,
        parentSessionKey,
        childSessionKey: sessionKey,
        agentId: targetAgentId,
        logPath: streamLogPath,
        emitStartNotice: false,
      });
    }
    parentRelay?.notifyStarted();
  } catch (err) {
    parentRelay?.dispose();
    await cleanupFailedAcpSpawn({
      cfg,
      sessionKey,
      shouldDeleteSession: true,
      deleteTranscript: true,
    });
    return createAcpSpawnFailure({
      status: "error",
      errorCode: "dispatch_failed",
      error: summarizeError(err),
      childSessionKey: sessionKey,
    });
  }

  try {
    createRunningTaskRun({
      runtime: "acp",
      sourceId: `sessions_spawn:acp:${childRunId}`,
      ownerKey: ctx.agentSessionKey,
      requesterSessionKey: ctx.agentSessionKey,
      sessionKey,
      agentId: targetAgentId,
      runId: childRunId,
      label: params.label || undefined,
      task: params.task,
      deliveryStatus: hasDeliveryTarget ? "pending" : "not_applicable",
      notifyPolicy: hasDeliveryTarget || streamToParent ? "done_only" : "silent",
      scopeKind: "session",
      channel: requesterOrigin?.channel,
      requesterOrigin,
      taskKind: "acp-spawn",
      metadata: {
        mode: spawnMode,
        thread: requestThreadBinding,
        targetAgentId,
        childSessionKey: sessionKey,
        accountId: requesterOrigin?.accountId,
        to: inferredDeliveryTo,
        threadId: deliveryThreadId,
      },
    });
  } catch {
    // Task ledger recording must not break ACP execution.
  }

  return {
    status: "accepted",
    childSessionKey: sessionKey,
    runId: childRunId,
    mode: spawnMode,
    note: spawnMode === "session" ? ACP_SPAWN_SESSION_ACCEPTED_NOTE : ACP_SPAWN_ACCEPTED_NOTE,
    ...(streamLogPath ? { streamLogPath } : {}),
  };
}
