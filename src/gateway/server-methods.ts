import {
  buildGatewayMiningChangedEventPayload,
  GATEWAY_EVENT_MINING_CHANGED,
  isSatMiningMutationMethod,
  SAT_MINING_MUTATION_METHODS,
} from "../mining/mining-facade.js";
import {
  shouldMirrorMiningGatewayTask,
  syncMiningGatewayTask,
} from "../mining/mining-task-ledger.js";
import { formatControlPlaneActor, resolveControlPlaneActor } from "./control-plane-audit.js";
import { consumeControlPlaneWriteBudget } from "./control-plane-rate-limit.js";
import { ADMIN_SCOPE, authorizeOperatorScopesForMethod } from "./method-scopes.js";
import { consumeMutatingAdminRpcBudget } from "./mutating-admin-rpc-rate-limit.js";
import { ErrorCodes, errorShape } from "./protocol/index.js";
import { isRoleAuthorizedForMethod, parseGatewayRole } from "./role-policy.js";
import { acpxPushTestHandlers } from "./server-methods/acpx-push-test.js";
import { agentHandlers } from "./server-methods/agent.js";
import { agentsHandlers } from "./server-methods/agents.js";
import { chatHandlers } from "./server-methods/chat.js";
import { commandsHandlers } from "./server-methods/commands.js";
import { configHandlers } from "./server-methods/config.js";
import { connectHandlers } from "./server-methods/connect.js";
import { cronHandlers } from "./server-methods/cron.js";
import { deviceHandlers } from "./server-methods/devices.js";
import { diagnosticsHandlers } from "./server-methods/diagnostics.js";
import { doctorHandlers } from "./server-methods/doctor.js";
import { execApprovalsHandlers } from "./server-methods/exec-approvals.js";
import { healthHandlers } from "./server-methods/health.js";
import { hooksHandlers } from "./server-methods/hooks.js";
import { logsHandlers } from "./server-methods/logs.js";
import { modelsHandlers } from "./server-methods/models.js";
import { logMutatingAdminRpcAudit } from "./server-methods/mutating-admin-rpc-audit.js";
import { nodePendingHandlers } from "./server-methods/nodes-pending.js";
import { nodeHandlers } from "./server-methods/nodes.js";
import { optionalGatewayHandlers } from "./server-methods/optional-capabilities.js";
import { pluginsMarketplaceHandlers } from "./server-methods/plugins-marketplace.js";
import { pushHandlers } from "./server-methods/push.js";
import { sendHandlers } from "./server-methods/send.js";
import { servicesHandlers } from "./server-methods/services.js";
import { sessionsHandlers } from "./server-methods/sessions.js";
import { skillsHandlers } from "./server-methods/skills.js";
import { systemHandlers } from "./server-methods/system.js";
import { talkHandlers } from "./server-methods/talk.js";
import { tasksHandlers } from "./server-methods/tasks.js";
import { toolsCatalogHandlers } from "./server-methods/tools-catalog.js";
import { toolsEffectiveHandlers } from "./server-methods/tools-effective.js";
import type { GatewayRequestHandlers, GatewayRequestOptions } from "./server-methods/types.js";
import { updateHandlers } from "./server-methods/update.js";
import { usageHandlers } from "./server-methods/usage.js";
import { webHandlers } from "./server-methods/web.js";
import { wizardHandlers } from "./server-methods/wizard.js";

const CONTROL_PLANE_WRITE_METHODS = new Set([
  "config.apply",
  "config.patch",
  "hooks.setEnabled",
  "update.run",
]);
function authorizeGatewayMethod(method: string, client: GatewayRequestOptions["client"]) {
  if (!client?.connect) {
    return null;
  }
  if (method === "health") {
    return null;
  }
  const roleRaw = client.connect.role ?? "operator";
  const role = parseGatewayRole(roleRaw);
  if (!role) {
    return errorShape(ErrorCodes.INVALID_REQUEST, `unauthorized role: ${roleRaw}`);
  }
  const scopes = client.connect.scopes ?? [];
  if (!isRoleAuthorizedForMethod(role, method)) {
    return errorShape(ErrorCodes.INVALID_REQUEST, `unauthorized role: ${role}`);
  }
  if (role === "node") {
    return null;
  }
  if (scopes.includes(ADMIN_SCOPE)) {
    return null;
  }
  const scopeAuth = authorizeOperatorScopesForMethod(method, scopes);
  if (!scopeAuth.allowed) {
    return errorShape(ErrorCodes.INVALID_REQUEST, `missing scope: ${scopeAuth.missingScope}`);
  }
  return null;
}

export const coreGatewayHandlers: GatewayRequestHandlers = {
  ...connectHandlers,
  ...acpxPushTestHandlers,
  ...logsHandlers,
  ...healthHandlers,
  ...hooksHandlers,
  ...chatHandlers,
  ...commandsHandlers,
  ...cronHandlers,
  ...diagnosticsHandlers,
  ...deviceHandlers,
  ...doctorHandlers,
  ...execApprovalsHandlers,
  ...webHandlers,
  ...modelsHandlers,
  ...pluginsMarketplaceHandlers,
  ...configHandlers,
  ...wizardHandlers,
  ...talkHandlers,
  ...tasksHandlers,
  ...toolsCatalogHandlers,
  ...toolsEffectiveHandlers,
  ...skillsHandlers,
  ...sessionsHandlers,
  ...systemHandlers,
  ...updateHandlers,
  ...nodeHandlers,
  ...nodePendingHandlers,
  ...pushHandlers,
  ...sendHandlers,
  ...servicesHandlers,
  ...usageHandlers,
  ...agentHandlers,
  ...agentsHandlers,
  ...optionalGatewayHandlers,
};

export async function handleGatewayRequest(
  opts: GatewayRequestOptions & { extraHandlers?: GatewayRequestHandlers },
): Promise<void> {
  const { req, respond, client, isWebchatConnect, context } = opts;
  const authError = authorizeGatewayMethod(req.method, client);
  if (authError) {
    respond(false, undefined, authError);
    return;
  }
  if (CONTROL_PLANE_WRITE_METHODS.has(req.method)) {
    const budget = consumeControlPlaneWriteBudget({ client });
    if (!budget.allowed) {
      const actor = resolveControlPlaneActor(client);
      context.logGateway.warn(
        `control-plane write rate-limited method=${req.method} ${formatControlPlaneActor(actor)} retryAfterMs=${budget.retryAfterMs} key=${budget.key}`,
      );
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `rate limit exceeded for ${req.method}; retry after ${Math.ceil(budget.retryAfterMs / 1000)}s`,
          {
            retryable: true,
            retryAfterMs: budget.retryAfterMs,
            details: {
              method: req.method,
              limit: "3 per 60s",
            },
          },
        ),
      );
      return;
    }
  }
  const adminRpcBudget = consumeMutatingAdminRpcBudget({ method: req.method, client });
  if (adminRpcBudget.applies && !adminRpcBudget.allowed) {
    const actor = resolveControlPlaneActor(client);
    context.logGateway.warn(
      `mutating admin RPC rate-limited method=${req.method} ${formatControlPlaneActor(actor)} retryAfterMs=${adminRpcBudget.retryAfterMs} key=${adminRpcBudget.key}`,
    );
    logMutatingAdminRpcAudit({
      context,
      client,
      method: req.method,
      outcome: "denied",
      details: {
        reason: "rate_limited",
        retryAfterMs: adminRpcBudget.retryAfterMs,
        limit: adminRpcBudget.policy.label,
      },
    });
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.UNAVAILABLE,
        `rate limit exceeded for ${req.method}; retry after ${Math.ceil(adminRpcBudget.retryAfterMs / 1000)}s`,
        {
          retryable: true,
          retryAfterMs: adminRpcBudget.retryAfterMs,
          details: {
            method: req.method,
            limit: adminRpcBudget.policy.label,
          },
        },
      ),
    );
    return;
  }
  const handler = opts.extraHandlers?.[req.method] ?? coreGatewayHandlers[req.method];
  if (!handler) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `unknown method: ${req.method}`),
    );
    return;
  }
  let responseOk: boolean | null = null;
  let responsePayload: unknown;
  const wrappedRespond: typeof respond = (...args: Parameters<typeof respond>) => {
    const [ok, payload] = args;
    responseOk = ok;
    responsePayload = payload;
    respond(...args);
  };
  await handler({
    req,
    params: (req.params ?? {}) as Record<string, unknown>,
    client,
    isWebchatConnect,
    respond: wrappedRespond,
    context,
  });
  if (responseOk === true) {
    const requestParams = (req.params ?? {}) as Record<string, unknown>;
    if (
      shouldMirrorMiningGatewayTask({
        method: req.method,
        responsePayload,
        requestParams,
        mutationMethods: SAT_MINING_MUTATION_METHODS,
      })
    ) {
      try {
        syncMiningGatewayTask({
          method: req.method,
          requestId: req.id,
          requestParams,
          responsePayload,
        });
      } catch (error) {
        context.logGateway.warn(
          `mining task ledger mirror failed method=${req.method}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
  if (responseOk === true && isSatMiningMutationMethod(req.method)) {
    context.broadcast(
      GATEWAY_EVENT_MINING_CHANGED,
      buildGatewayMiningChangedEventPayload(req.method, responsePayload),
      { dropIfSlow: true },
    );
  }
}
