import type { FasedAgentConfig } from "../../config/config.js";
import { ADMIN_SCOPE, authorizeOperatorScopesForMethod } from "../../gateway/method-scopes.js";
import { consumeMutatingAdminRpcBudget } from "../../gateway/mutating-admin-rpc-rate-limit.js";
import type {
  ChatInjectParams,
  WebLoginStartParams,
  WebLoginWaitParams,
} from "../../gateway/protocol/index.js";
import type { PushTestParams } from "../../gateway/protocol/schema/types.js";
import { logMutatingAdminRpcAudit } from "../../gateway/server-methods/mutating-admin-rpc-audit.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
} from "../../gateway/server-methods/types.js";
import {
  type PluginAdminRpcActionMethod,
  resolvePluginAdminRpcActionGrant,
  type PluginAdminRpcActionSource,
  normalizePluginsConfig,
} from "../config-state.js";

export type PluginRuntimeAdminRpcCallContext = {
  context: GatewayRequestContext;
  client: GatewayClient | null;
  isWebchatConnect?: GatewayRequestHandlerOptions["isWebchatConnect"];
};

export type PluginRuntimeAdminRpcInvocation = {
  method: PluginAdminRpcActionMethod;
  params: Record<string, unknown>;
  call: PluginRuntimeAdminRpcCallContext;
};

export type PluginRuntimeAdminRpcInvoker = (
  invocation: PluginRuntimeAdminRpcInvocation,
) => Promise<unknown>;

export type PluginRuntimeAdminRpcAuditEvent = {
  pluginId?: string;
  method: PluginAdminRpcActionMethod;
  outcome: "allowed" | "denied" | "failed";
  denyReason?: string;
  matchedSource?: string;
};

export type PluginRuntimeAdminRpcAuditSink = (event: PluginRuntimeAdminRpcAuditEvent) => void;

export type PluginRuntimeAdminRpcHelperOptions = {
  config?: FasedAgentConfig;
  pluginId?: string;
  source?: PluginAdminRpcActionSource;
  invokeAdminRpc?: PluginRuntimeAdminRpcInvoker;
  adminRpcAudit?: PluginRuntimeAdminRpcAuditSink;
};

export type PluginRuntimeAdminRpcHelpers = {
  /**
   * Inject a labeled assistant message into an existing session transcript.
   *
   * This is not a generic gateway dispatcher. It requires an explicit
   * `chat.inject` grant and an operator-scoped gateway call context.
   */
  chatInject: (
    params: ChatInjectParams,
    call: PluginRuntimeAdminRpcCallContext,
  ) => Promise<{ ok: boolean; messageId?: string }>;
  /**
   * Send one test push to a specific registered node.
   */
  pushTest: (
    params: PushTestParams,
    call: PluginRuntimeAdminRpcCallContext,
  ) => Promise<{
    ok?: boolean;
    status?: number;
    reason?: string;
    environment?: string;
    apnsId?: string;
    tokenSuffix?: string;
    topic?: string;
  }>;
  /**
   * Start a provider QR-login flow. The returned payload is intentionally
   * reduced so plugins never receive QR payloads, tokens, cookies, or secrets.
   */
  webLoginStart: (
    params: WebLoginStartParams,
    call: PluginRuntimeAdminRpcCallContext,
  ) => Promise<{ ok: true; started: true }>;
  /**
   * Wait for a provider QR-login flow. The returned payload exposes only
   * connection status and never returns login secrets.
   */
  webLoginWait: (
    params: WebLoginWaitParams,
    call: PluginRuntimeAdminRpcCallContext,
  ) => Promise<{ connected: boolean }>;
};

function emitAudit(
  options: PluginRuntimeAdminRpcHelperOptions,
  event: PluginRuntimeAdminRpcAuditEvent,
) {
  options.adminRpcAudit?.(event);
}

function logPluginAdminRpcAudit(params: {
  options: PluginRuntimeAdminRpcHelperOptions;
  call?: PluginRuntimeAdminRpcCallContext;
  method: PluginAdminRpcActionMethod;
  outcome: "succeeded" | "failed" | "denied";
  reason?: string;
  matchedSource?: string;
}) {
  if (!params.call) {
    return;
  }
  logMutatingAdminRpcAudit({
    context: params.call.context,
    client: params.call.client,
    method: params.method,
    outcome: params.outcome,
    details: {
      pluginId: params.options.pluginId?.trim(),
      pluginSource: params.options.source?.source,
      pluginOrigin: params.options.source?.origin,
      matchedSource: params.matchedSource,
      reason: params.reason,
    },
  });
}

function deny(params: {
  options: PluginRuntimeAdminRpcHelperOptions;
  call?: PluginRuntimeAdminRpcCallContext;
  method: PluginAdminRpcActionMethod;
  reason: string;
  matchedSource?: string;
}): never {
  emitAudit(params.options, {
    pluginId: params.options.pluginId?.trim() || undefined,
    method: params.method,
    outcome: "denied",
    denyReason: params.reason,
    matchedSource: params.matchedSource,
  });
  logPluginAdminRpcAudit({
    options: params.options,
    call: params.call,
    method: params.method,
    outcome: "denied",
    reason: params.reason,
    matchedSource: params.matchedSource,
  });
  throw new Error(`plugin admin RPC ${params.method} denied: ${params.reason}`);
}

function assertOperatorContext(params: {
  options: PluginRuntimeAdminRpcHelperOptions;
  call: PluginRuntimeAdminRpcCallContext;
  method: PluginAdminRpcActionMethod;
}) {
  const client = params.call.client;
  if (!client?.connect) {
    deny({ ...params, reason: "missing-operator-client" });
  }
  const role = client.connect.role ?? "operator";
  if (role !== "operator") {
    deny({ ...params, reason: "operator-client-required" });
  }
  const scopes = client.connect.scopes ?? [];
  if (scopes.includes(ADMIN_SCOPE)) {
    return;
  }
  const auth = authorizeOperatorScopesForMethod(params.method, scopes);
  if (!auth.allowed) {
    deny({ ...params, reason: `missing-scope:${auth.missingScope}` });
  }
}

function sanitizeResult(method: PluginAdminRpcActionMethod, payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  const record = payload as Record<string, unknown>;
  switch (method) {
    case "chat.inject":
      return {
        ok: record.ok === true,
        messageId: typeof record.messageId === "string" ? record.messageId : undefined,
      };
    case "push.test":
      return {
        ok: typeof record.ok === "boolean" ? record.ok : undefined,
        status: typeof record.status === "number" ? record.status : undefined,
        reason: typeof record.reason === "string" ? record.reason : undefined,
        environment: typeof record.environment === "string" ? record.environment : undefined,
        apnsId: typeof record.apnsId === "string" ? record.apnsId : undefined,
        tokenSuffix: typeof record.tokenSuffix === "string" ? record.tokenSuffix : undefined,
        topic: typeof record.topic === "string" ? record.topic : undefined,
      };
    case "web.login.start":
      return { ok: true, started: true };
    case "web.login.wait":
      return { connected: record.connected === true };
  }
}

async function invokeFixedAdminRpc(
  options: PluginRuntimeAdminRpcHelperOptions,
  method: PluginAdminRpcActionMethod,
  params: Record<string, unknown>,
  call: PluginRuntimeAdminRpcCallContext,
): Promise<unknown> {
  const pluginId = options.pluginId?.trim();
  if (!pluginId) {
    deny({ options, call, method, reason: "missing-trusted-plugin-id" });
  }
  const grant = resolvePluginAdminRpcActionGrant({
    config: normalizePluginsConfig((options.config ?? {}).plugins),
    pluginId,
    method,
    source: options.source,
  });
  if (!grant.allowed) {
    deny({ options, call, method, reason: grant.reason });
  }
  assertOperatorContext({ options, call, method });
  if (!options.invokeAdminRpc) {
    deny({
      options,
      call,
      method,
      reason: "admin-rpc-runtime-invoker-unavailable",
      matchedSource: grant.matchedSource,
    });
  }
  const budget = consumeMutatingAdminRpcBudget({ method, client: call.client });
  if (budget.applies && !budget.allowed) {
    deny({
      options,
      call,
      method,
      reason: `rate-limited:${budget.policy.label}`,
      matchedSource: grant.matchedSource,
    });
  }

  try {
    const payload = await options.invokeAdminRpc({
      method,
      params,
      call,
    });
    emitAudit(options, {
      pluginId,
      method,
      outcome: "allowed",
      matchedSource: grant.matchedSource,
    });
    logPluginAdminRpcAudit({
      options,
      call,
      method,
      outcome: "succeeded",
      matchedSource: grant.matchedSource,
    });
    return sanitizeResult(method, payload);
  } catch (err) {
    emitAudit(options, {
      pluginId,
      method,
      outcome: "failed",
      matchedSource: grant.matchedSource,
    });
    logPluginAdminRpcAudit({
      options,
      call,
      method,
      outcome: "failed",
      reason: "handler_failed",
      matchedSource: grant.matchedSource,
    });
    throw err;
  }
}

export function createPluginRuntimeAdminRpcHelpers(
  options: PluginRuntimeAdminRpcHelperOptions = {},
): PluginRuntimeAdminRpcHelpers {
  return {
    chatInject(params, call) {
      return invokeFixedAdminRpc(options, "chat.inject", params, call) as Promise<{
        ok: boolean;
        messageId?: string;
      }>;
    },
    pushTest(params, call) {
      return invokeFixedAdminRpc(options, "push.test", params, call) as Promise<{
        ok?: boolean;
        status?: number;
        reason?: string;
        environment?: string;
        apnsId?: string;
        tokenSuffix?: string;
        topic?: string;
      }>;
    },
    webLoginStart(params, call) {
      return invokeFixedAdminRpc(options, "web.login.start", params, call) as Promise<{
        ok: true;
        started: true;
      }>;
    },
    webLoginWait(params, call) {
      return invokeFixedAdminRpc(options, "web.login.wait", params, call) as Promise<{
        connected: boolean;
      }>;
    },
  };
}
