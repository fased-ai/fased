import { getActivePluginRegistry } from "../plugins/runtime.js";
import { resolveReservedGatewayMethodScope } from "../shared/gateway-method-policy.js";

export const ADMIN_SCOPE = "operator.admin" as const;
export const READ_SCOPE = "operator.read" as const;
export const WRITE_SCOPE = "operator.write" as const;
export const APPROVALS_SCOPE = "operator.approvals" as const;
export const PAIRING_SCOPE = "operator.pairing" as const;

export type OperatorScope =
  | typeof ADMIN_SCOPE
  | typeof READ_SCOPE
  | typeof WRITE_SCOPE
  | typeof APPROVALS_SCOPE
  | typeof PAIRING_SCOPE;

export const CLI_DEFAULT_OPERATOR_SCOPES: OperatorScope[] = [
  ADMIN_SCOPE,
  READ_SCOPE,
  WRITE_SCOPE,
  APPROVALS_SCOPE,
  PAIRING_SCOPE,
];

const NODE_ROLE_METHODS = new Set([
  "node.invoke.result",
  "node.event",
  "node.pending.drain",
  "node.pending.pull",
  "node.pending.ack",
  "node.canvas.capability.refresh",
  "skills.bins",
]);

const METHOD_SCOPE_GROUPS: Record<OperatorScope, readonly string[]> = {
  [APPROVALS_SCOPE]: [
    "exec.approval.get",
    "exec.approval.list",
    "exec.approval.request",
    "exec.approval.waitDecision",
    "exec.approval.resolve",
  ],
  [PAIRING_SCOPE]: [
    "node.pair.request",
    "node.pair.list",
    "node.pair.approve",
    "node.pair.reject",
    "node.pair.remove",
    "node.pair.verify",
    "device.pair.list",
    "device.pair.approve",
    "device.pair.reject",
    "device.pair.remove",
    "device.token.rotate",
    "device.token.revoke",
    "node.rename",
  ],
  [READ_SCOPE]: [
    "health",
    "diagnostics.stability",
    "doctor.memory.inventory",
    "doctor.memory.repair.preview",
    "doctor.memory.status",
    "doctor.memory.validate",
    "doctor.memory.wiki.status",
    "logs.tail",
    "channels.status",
    "status",
    "usage.status",
    "usage.cost",
    "tts.status",
    "tts.providers",
    "tts.personas",
    "models.auth.status",
    "models.authStatus",
    "models.catalog.status",
    "models.list",
    "plugins.marketplace.list",
    "plugins.marketplace.info",
    "plugins.marketplace.update.preview",
    "webhookTriggers.list",
    "hooks.list",
    "commands.list",
    "tools.catalog",
    "tools.effective",
    "services.capabilities",
    "services.webSearch.providers",
    "services.webSearch.test",
    "tasks.list",
    "tasks.detail",
    "tasks.audit",
    "tasks.workflow.preview",
    "tasks.workflow.graph.preview",
    "tasks.workflow.definitions.list",
    "tasks.workflow.templates.list",
    "tasks.standingOrders.list",
    "tasks.flow.list",
    "tasks.flow.detail",
    "agents.list",
    "agent.identity.get",
    "acpx.pushTest.auditHistory",
    "acpx.pushTest.preview",
    "skills.status",
    "skills.file.get",
    "skills.wallet.grants",
    "update.status",
    "voicewake.get",
    "voicewake.routing.get",
    "sessions.list",
    "sessions.subscribe",
    "sessions.unsubscribe",
    "sessions.messages.subscribe",
    "sessions.messages.unsubscribe",
    "sessions.preview",
    "sessions.resolve",
    "sessions.compaction.list",
    "sessions.compaction.get",
    "sessions.usage",
    "sessions.usage.timeseries",
    "sessions.usage.logs",
    "cron.list",
    "cron.status",
    "cron.runDetail",
    "cron.runs",
    "cron.sources.list",
    "gateway.identity.get",
    "system-presence",
    "last-heartbeat",
    "node.list",
    "node.describe",
    "chat.history",
    "config.get",
    "config.schema.lookup",
    "talk.config",
    "agents.files.list",
    "agents.files.get",
  ],
  [WRITE_SCOPE]: [
    "send",
    "poll",
    "agent",
    "agent.wait",
    "wake",
    "talk.mode",
    "tts.enable",
    "tts.disable",
    "tts.convert",
    "tts.setProvider",
    "voicewake.set",
    "voicewake.routing.set",
    "channels.start",
    "channels.stop",
    "node.invoke",
    "node.pending.enqueue",
    "cron.queue.cancel",
    "cron.queue.retry",
    "cron.queue.clearStale",
    "tasks.cancel",
    "tasks.retry",
    "tasks.notify",
    "tasks.maintenance",
    "webhookTriggers.test",
    "tasks.workflow.run",
    "tasks.workflow.resume",
    "tasks.workflow.graph.run",
    "tasks.workflow.graph.resume",
    "tasks.workflow.definitions.save",
    "tasks.workflow.definitions.remove",
    "tasks.standingOrders.save",
    "tasks.standingOrders.remove",
    "tasks.standingOrders.propose",
    "tasks.flow.cancel",
    "chat.send",
    "chat.abort",
    "sessions.compaction.branch",
    "browser.request",
    "push.test",
    "acpx.pushTest.execute",
  ],
  [ADMIN_SCOPE]: [
    "channels.logout",
    "models.auth.interactive.start",
    "models.auth.configure",
    "models.auth.store",
    "models.auth.clear",
    "agents.create",
    "agents.update",
    "agents.delete",
    "plugins.marketplace.install",
    "plugins.marketplace.restart",
    "plugins.marketplace.runtimeHelper.set",
    "plugins.marketplace.adminRpcGrant.set",
    "plugins.marketplace.update",
    "plugins.marketplace.uninstall",
    "webhookTriggers.upsert",
    "webhookTriggers.remove",
    "hooks.setEnabled",
    "services.gmail.setup",
    "services.component.install",
    "services.component.restart",
    "skills.create",
    "skills.copy",
    "skills.install",
    "skills.file.set",
    "skills.wallet.grant.set",
    "skills.wallet.grant.clear",
    "skills.update",
    "secrets.reload",
    "cron.add",
    "cron.update",
    "cron.repair",
    "cron.sources.update",
    "cron.sources.remove",
    "cron.remove",
    "cron.run",
    "sessions.patch",
    "sessions.reset",
    "sessions.delete",
    "sessions.compact",
    "sessions.compaction.restore",
    "connect",
    "chat.inject",
    "doctor.memory.repair.execute",
    "doctor.memory.wiki.rebuild",
    "web.login.start",
    "web.login.wait",
    "set-heartbeats",
    "system-event",
    "agents.files.set",
  ],
};

const METHOD_SCOPE_BY_NAME = new Map<string, OperatorScope>(
  Object.entries(METHOD_SCOPE_GROUPS).flatMap(([scope, methods]) =>
    methods.map((method) => [method, scope as OperatorScope]),
  ),
);

function resolveScopedMethod(method: string): OperatorScope | undefined {
  const explicitScope = METHOD_SCOPE_BY_NAME.get(method);
  if (explicitScope) {
    return explicitScope;
  }
  const reservedScope = resolveReservedGatewayMethodScope(method);
  if (reservedScope) {
    return reservedScope;
  }
  const pluginScope = getActivePluginRegistry()?.gatewayMethodScopes?.[method];
  if (pluginScope) {
    return pluginScope;
  }
  return undefined;
}

export function isApprovalMethod(method: string): boolean {
  return resolveScopedMethod(method) === APPROVALS_SCOPE;
}

export function isPairingMethod(method: string): boolean {
  return resolveScopedMethod(method) === PAIRING_SCOPE;
}

export function isReadMethod(method: string): boolean {
  return resolveScopedMethod(method) === READ_SCOPE;
}

export function isWriteMethod(method: string): boolean {
  return resolveScopedMethod(method) === WRITE_SCOPE;
}

export function isNodeRoleMethod(method: string): boolean {
  return NODE_ROLE_METHODS.has(method);
}

export function isAdminOnlyMethod(method: string): boolean {
  return resolveScopedMethod(method) === ADMIN_SCOPE;
}

export function resolveRequiredOperatorScopeForMethod(method: string): OperatorScope | undefined {
  return resolveScopedMethod(method);
}

export function resolveLeastPrivilegeOperatorScopesForMethod(method: string): OperatorScope[] {
  const requiredScope = resolveRequiredOperatorScopeForMethod(method);
  if (requiredScope) {
    return [requiredScope];
  }
  // Default-deny for unclassified methods.
  return [];
}

export function authorizeOperatorScopesForMethod(
  method: string,
  scopes: readonly string[],
): { allowed: true } | { allowed: false; missingScope: OperatorScope } {
  if (scopes.includes(ADMIN_SCOPE)) {
    return { allowed: true };
  }
  const requiredScope = resolveRequiredOperatorScopeForMethod(method) ?? ADMIN_SCOPE;
  if (requiredScope === READ_SCOPE) {
    if (scopes.includes(READ_SCOPE) || scopes.includes(WRITE_SCOPE)) {
      return { allowed: true };
    }
    return { allowed: false, missingScope: READ_SCOPE };
  }
  if (scopes.includes(requiredScope)) {
    return { allowed: true };
  }
  return { allowed: false, missingScope: requiredScope };
}

export function isGatewayMethodClassified(method: string): boolean {
  if (isNodeRoleMethod(method)) {
    return true;
  }
  return resolveRequiredOperatorScopeForMethod(method) !== undefined;
}
