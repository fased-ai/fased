import {
  loadApnsRegistration,
  normalizeApnsEnvironment,
  resolveApnsAuthConfigFromEnv,
  sendApnsAlert,
} from "../../infra/push-apns.js";
import { ErrorCodes, errorShape, validatePushTestParams } from "../protocol/index.js";
import { logMutatingAdminRpcAudit } from "./mutating-admin-rpc-audit.js";
import { respondInvalidParams, respondUnavailableOnThrow } from "./nodes.helpers.js";
import type { GatewayRequestHandlers } from "./types.js";

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export const pushHandlers: GatewayRequestHandlers = {
  "push.test": async ({ params, respond, client, context }) => {
    if (!validatePushTestParams(params)) {
      respondInvalidParams({
        respond,
        method: "push.test",
        validator: validatePushTestParams,
      });
      return;
    }

    const nodeId = String(params.nodeId ?? "").trim();
    if (!nodeId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "nodeId required"));
      return;
    }

    const title = normalizeOptionalString(params.title) ?? "FasedAgent";
    const body = normalizeOptionalString(params.body) ?? `Push test for node ${nodeId}`;

    await respondUnavailableOnThrow(respond, async () => {
      const registration = await loadApnsRegistration(nodeId);
      if (!registration) {
        logMutatingAdminRpcAudit({
          context,
          client,
          method: "push.test",
          outcome: "denied",
          details: { nodeId, reason: "no_apns_registration" },
        });
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `node ${nodeId} has no APNs registration (connect iOS node first)`,
          ),
        );
        return;
      }

      const auth = await resolveApnsAuthConfigFromEnv(process.env);
      if (!auth.ok) {
        logMutatingAdminRpcAudit({
          context,
          client,
          method: "push.test",
          outcome: "failed",
          details: { nodeId, reason: "apns_auth_unavailable" },
        });
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, auth.error));
        return;
      }

      const overrideEnvironment = normalizeApnsEnvironment(params.environment);
      const result = await sendApnsAlert({
        auth: auth.value,
        registration: {
          ...registration,
          environment: overrideEnvironment ?? registration.environment,
        },
        nodeId,
        title,
        body,
      });
      logMutatingAdminRpcAudit({
        context,
        client,
        method: "push.test",
        outcome: result.ok ? "succeeded" : "failed",
        details: {
          nodeId,
          environment: overrideEnvironment ?? registration.environment,
          status: result.status,
        },
      });
      respond(true, result, undefined);
    });
  },
};
