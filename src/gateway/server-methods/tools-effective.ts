import type { FasedAgentConfig } from "../../config/config.js";
import { ADMIN_SCOPE } from "../method-scopes.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateToolsEffectiveParams,
} from "../protocol/index.js";
import type { ToolsEffectiveResult } from "../protocol/index.js";
import {
  deliveryContextFromSession,
  listAgentIds,
  loadSessionEntry,
  resolveEffectiveToolInventory,
  resolveReplyToMode,
  resolveSessionAgentId,
  resolveSessionModelRef,
} from "./tools-effective.runtime.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";
import type { GatewayRequestContext } from "./types.js";

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function resolveRequestedAgentIdOrRespondError(params: {
  rawAgentId: unknown;
  cfg: FasedAgentConfig;
  respond: RespondFn;
}) {
  const requestedAgentId = normalizeOptionalString(params.rawAgentId);
  if (!requestedAgentId) {
    return undefined;
  }
  const knownAgents = listAgentIds(params.cfg);
  if (!knownAgents.includes(requestedAgentId)) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `unknown agent id "${requestedAgentId}"`),
    );
    return null;
  }
  return requestedAgentId;
}

function stripRawDescriptions(result: ReturnType<typeof resolveEffectiveToolInventory>) {
  return {
    agentId: result.agentId,
    profile: result.profile,
    groups: result.groups.map((group) => ({
      id: group.id,
      label: group.label,
      source: group.source,
      tools: group.tools.map((tool) => ({
        id: tool.id,
        label: tool.label,
        description: tool.description,
        source: tool.source,
        ...(tool.pluginId ? { pluginId: tool.pluginId } : {}),
        ...(tool.channelId ? { channelId: tool.channelId } : {}),
      })),
    })),
  } satisfies ToolsEffectiveResult;
}

function resolveRuntimeConfigForToolsEffective(params: {
  context: GatewayRequestContext;
  sessionKey: string;
}): FasedAgentConfig {
  const contextWithConfig = params.context as GatewayRequestContext & {
    getRuntimeConfig?: () => FasedAgentConfig;
  };
  if (typeof contextWithConfig.getRuntimeConfig === "function") {
    return contextWithConfig.getRuntimeConfig();
  }
  const loaded = loadSessionEntry(params.sessionKey);
  return loaded.cfg ?? {};
}

function resolveTrustedToolsEffectiveResult(params: {
  sessionKey: string;
  requestedAgentId?: string;
  senderIsOwner: boolean;
  respond: RespondFn;
}): ToolsEffectiveResult | null {
  const loaded = loadSessionEntry(params.sessionKey);
  if (!loaded.entry) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `unknown session key "${params.sessionKey}"`),
    );
    return null;
  }

  const canonicalSessionKey = loaded.canonicalKey ?? params.sessionKey;
  const sessionAgentId = resolveSessionAgentId({
    sessionKey: canonicalSessionKey,
    config: loaded.cfg,
  });
  if (params.requestedAgentId && params.requestedAgentId !== sessionAgentId) {
    params.respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `agent id "${params.requestedAgentId}" does not match session agent "${sessionAgentId}"`,
      ),
    );
    return null;
  }

  const delivery = deliveryContextFromSession(loaded.entry);
  const resolvedModel = resolveSessionModelRef(loaded.cfg, loaded.entry, sessionAgentId);
  const messageProvider =
    delivery?.channel ??
    loaded.entry.lastChannel ??
    loaded.entry.channel ??
    loaded.entry.origin?.provider;
  const accountId =
    delivery?.accountId ?? loaded.entry.lastAccountId ?? loaded.entry.origin?.accountId;

  const result = resolveEffectiveToolInventory({
    cfg: loaded.cfg,
    agentId: sessionAgentId,
    sessionKey: canonicalSessionKey,
    messageProvider,
    modelProvider: resolvedModel.provider,
    modelId: resolvedModel.model,
    senderIsOwner: params.senderIsOwner,
    currentChannelId: delivery?.to,
    currentThreadTs:
      delivery?.threadId != null
        ? String(delivery.threadId)
        : loaded.entry.lastThreadId != null
          ? String(loaded.entry.lastThreadId)
          : loaded.entry.origin?.threadId != null
            ? String(loaded.entry.origin.threadId)
            : undefined,
    accountId,
    groupId: loaded.entry.groupId,
    groupChannel: loaded.entry.groupChannel,
    groupSpace: loaded.entry.space,
    replyToMode: resolveReplyToMode(
      loaded.cfg,
      messageProvider,
      accountId,
      loaded.entry.chatType ?? loaded.entry.origin?.chatType,
    ),
  });
  return stripRawDescriptions(result);
}

export const toolsEffectiveHandlers: GatewayRequestHandlers = {
  "tools.effective": ({ params, respond, client, context }) => {
    if (!validateToolsEffectiveParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid tools.effective params: ${formatValidationErrors(validateToolsEffectiveParams.errors)}`,
        ),
      );
      return;
    }
    const cfg = resolveRuntimeConfigForToolsEffective({
      context,
      sessionKey: params.sessionKey,
    });
    const requestedAgentId = resolveRequestedAgentIdOrRespondError({
      rawAgentId: params.agentId,
      cfg,
      respond,
    });
    if (requestedAgentId === null) {
      return;
    }
    const result = resolveTrustedToolsEffectiveResult({
      sessionKey: params.sessionKey,
      requestedAgentId,
      senderIsOwner: Array.isArray(client?.connect?.scopes)
        ? client.connect.scopes.includes(ADMIN_SCOPE)
        : false,
      respond,
    });
    if (!result) {
      return;
    }
    respond(true, result, undefined);
  },
};
