import { listChannelPlugins } from "../../channels/plugins/index.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateWebLoginStartParams,
  validateWebLoginWaitParams,
} from "../protocol/index.js";
import { formatForLog } from "../ws-log.js";
import { logMutatingAdminRpcAudit } from "./mutating-admin-rpc-audit.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";

const WEB_LOGIN_METHODS = new Set(["web.login.start", "web.login.wait"]);

function resolveRequestedChannel(params: unknown): string | undefined {
  const raw = (params as { channel?: unknown }).channel;
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

const supportsWebLogin = (plugin: ReturnType<typeof listChannelPlugins>[number]) =>
  (plugin.gatewayMethods ?? []).some((method) => WEB_LOGIN_METHODS.has(method));

const resolveWebLoginProvider = (channelId?: string) => {
  const plugins = listChannelPlugins().filter(supportsWebLogin);
  if (channelId) {
    return plugins.find((plugin) => plugin.id === channelId) ?? null;
  }
  return plugins[0] ?? null;
};

function resolveAccountId(params: unknown): string | undefined {
  return typeof (params as { accountId?: unknown }).accountId === "string"
    ? (params as { accountId?: string }).accountId
    : undefined;
}

async function startBuiltInWhatsAppLogin(params: {
  force?: boolean;
  timeoutMs?: number;
  verbose?: boolean;
  accountId?: string;
}) {
  const { startWebLoginWithQr } = await import("../../web/login-qr.js");
  return await startWebLoginWithQr(params);
}

async function waitBuiltInWhatsAppLogin(params: { timeoutMs?: number; accountId?: string }) {
  const { waitForWebLogin } = await import("../../web/login-qr.js");
  return await waitForWebLogin(params);
}

function respondProviderUnsupported(respond: RespondFn, providerId: string) {
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, `web login is not supported by provider ${providerId}`),
  );
}

function respondProviderUnavailable(respond: RespondFn, channelId?: string) {
  respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.UNAVAILABLE,
      channelId
        ? `web login provider is not available for channel ${channelId}`
        : "web login provider is not available",
    ),
  );
}

export const webHandlers: GatewayRequestHandlers = {
  "web.login.start": async ({ params, respond, context, client }) => {
    if (!validateWebLoginStartParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid web.login.start params: ${formatValidationErrors(validateWebLoginStartParams.errors)}`,
        ),
      );
      return;
    }
    try {
      const accountId = resolveAccountId(params);
      const requestedChannel = resolveRequestedChannel(params);
      const provider = resolveWebLoginProvider(requestedChannel);
      if (!provider) {
        if (requestedChannel && requestedChannel !== "whatsapp") {
          logMutatingAdminRpcAudit({
            context,
            client,
            method: "web.login.start",
            outcome: "denied",
            details: { provider: requestedChannel, accountId, reason: "provider_unavailable" },
          });
          respondProviderUnavailable(respond, requestedChannel);
          return;
        }
        try {
          const result = await startBuiltInWhatsAppLogin({
            force: Boolean((params as { force?: boolean }).force),
            timeoutMs:
              typeof (params as { timeoutMs?: unknown }).timeoutMs === "number"
                ? (params as { timeoutMs?: number }).timeoutMs
                : undefined,
            verbose: Boolean((params as { verbose?: boolean }).verbose),
            accountId,
          });
          logMutatingAdminRpcAudit({
            context,
            client,
            method: "web.login.start",
            outcome: "succeeded",
            details: { provider: "whatsapp", accountId, source: "built_in_qr" },
          });
          respond(true, result, undefined);
          return;
        } catch (err) {
          logMutatingAdminRpcAudit({
            context,
            client,
            method: "web.login.start",
            outcome: "failed",
            details: { accountId, reason: "built_in_qr_error" },
          });
          respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
          return;
        }
      }
      await context.stopChannel(provider.id, accountId);
      if (!provider.gateway?.loginWithQrStart) {
        logMutatingAdminRpcAudit({
          context,
          client,
          method: "web.login.start",
          outcome: "denied",
          details: { provider: provider.id, accountId, reason: "provider_unsupported" },
        });
        respondProviderUnsupported(respond, provider.id);
        return;
      }
      const result = await provider.gateway.loginWithQrStart({
        force: Boolean((params as { force?: boolean }).force),
        timeoutMs:
          typeof (params as { timeoutMs?: unknown }).timeoutMs === "number"
            ? (params as { timeoutMs?: number }).timeoutMs
            : undefined,
        verbose: Boolean((params as { verbose?: boolean }).verbose),
        accountId,
      });
      logMutatingAdminRpcAudit({
        context,
        client,
        method: "web.login.start",
        outcome: "succeeded",
        details: { provider: provider.id, accountId },
      });
      respond(true, result, undefined);
    } catch (err) {
      logMutatingAdminRpcAudit({
        context,
        client,
        method: "web.login.start",
        outcome: "failed",
        details: { accountId: resolveAccountId(params), reason: "provider_error" },
      });
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "web.login.wait": async ({ params, respond, context, client }) => {
    if (!validateWebLoginWaitParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid web.login.wait params: ${formatValidationErrors(validateWebLoginWaitParams.errors)}`,
        ),
      );
      return;
    }
    try {
      const accountId = resolveAccountId(params);
      const requestedChannel = resolveRequestedChannel(params);
      const provider = resolveWebLoginProvider(requestedChannel);
      if (!provider) {
        if (requestedChannel && requestedChannel !== "whatsapp") {
          logMutatingAdminRpcAudit({
            context,
            client,
            method: "web.login.wait",
            outcome: "denied",
            details: { provider: requestedChannel, accountId, reason: "provider_unavailable" },
          });
          respondProviderUnavailable(respond, requestedChannel);
          return;
        }
        try {
          const result = await waitBuiltInWhatsAppLogin({
            timeoutMs:
              typeof (params as { timeoutMs?: unknown }).timeoutMs === "number"
                ? (params as { timeoutMs?: number }).timeoutMs
                : undefined,
            accountId,
          });
          const payload = result.connected
            ? {
                ...result,
                message: `${result.message} Restart the gateway to load the WhatsApp channel runtime.`,
              }
            : result;
          logMutatingAdminRpcAudit({
            context,
            client,
            method: "web.login.wait",
            outcome: "succeeded",
            details: {
              provider: "whatsapp",
              accountId,
              connected: result.connected,
              source: "built_in_qr",
            },
          });
          respond(true, payload, undefined);
          return;
        } catch (err) {
          logMutatingAdminRpcAudit({
            context,
            client,
            method: "web.login.wait",
            outcome: "failed",
            details: { accountId, reason: "built_in_qr_error" },
          });
          respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
          return;
        }
      }
      if (!provider.gateway?.loginWithQrWait) {
        logMutatingAdminRpcAudit({
          context,
          client,
          method: "web.login.wait",
          outcome: "denied",
          details: { provider: provider.id, accountId, reason: "provider_unsupported" },
        });
        respondProviderUnsupported(respond, provider.id);
        return;
      }
      const result = await provider.gateway.loginWithQrWait({
        timeoutMs:
          typeof (params as { timeoutMs?: unknown }).timeoutMs === "number"
            ? (params as { timeoutMs?: number }).timeoutMs
            : undefined,
        accountId,
      });
      if (result.connected) {
        await context.startChannel(provider.id, accountId);
      }
      logMutatingAdminRpcAudit({
        context,
        client,
        method: "web.login.wait",
        outcome: "succeeded",
        details: { provider: provider.id, accountId, connected: result.connected },
      });
      respond(true, result, undefined);
    } catch (err) {
      logMutatingAdminRpcAudit({
        context,
        client,
        method: "web.login.wait",
        outcome: "failed",
        details: { accountId: resolveAccountId(params), reason: "provider_error" },
      });
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
};
