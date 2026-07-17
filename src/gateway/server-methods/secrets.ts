import { ErrorCodes, errorShape } from "../protocol/index.js";
import { sanitizeGatewaySecretsRuntimeError } from "../server-secrets-runtime.js";
import { logMutatingAdminRpcAudit } from "./mutating-admin-rpc-audit.js";
import type { GatewayRequestHandlers } from "./types.js";

export function createSecretsHandlers(params: {
  reloadSecrets: () => Promise<{ warningCount: number }>;
}): GatewayRequestHandlers {
  return {
    "secrets.reload": async ({ respond, client, context }) => {
      try {
        const result = await params.reloadSecrets();
        logMutatingAdminRpcAudit({
          context,
          client,
          method: "secrets.reload",
          outcome: "succeeded",
          details: { warningCount: result.warningCount },
        });
        respond(true, { ok: true, warningCount: result.warningCount });
      } catch (err) {
        const safe = sanitizeGatewaySecretsRuntimeError(err);
        logMutatingAdminRpcAudit({
          context,
          client,
          method: "secrets.reload",
          outcome: "failed",
          details: { code: safe.code },
        });
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, safe.message, {
            retryable: true,
            details: { code: safe.code },
          }),
        );
      }
    },
  };
}
