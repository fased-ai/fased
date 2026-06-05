import { getGatewayLivenessHealthSnapshot } from "../../commands/health.js";
import { getStatusSummary } from "../../commands/status.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import { formatError } from "../server-utils.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestHandlers } from "./types.js";

const ADMIN_SCOPE = "operator.admin";

export const healthHandlers: GatewayRequestHandlers = {
  health: async ({ respond, context, params, client }) => {
    const { getHealthCache, refreshHealthSnapshot, logHealth } = context;
    const wantsProbe = params?.probe === true;
    const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
    const includeSensitive = scopes.includes(ADMIN_SCOPE);
    const cached = getHealthCache();
    if (!wantsProbe && cached) {
      respond(true, cached, undefined, { cached: true });
      void refreshHealthSnapshot({ probe: false, includeSensitive }).catch((err) =>
        logHealth.error(`background health refresh failed: ${formatError(err)}`),
      );
      return;
    }
    if (!wantsProbe) {
      respond(true, getGatewayLivenessHealthSnapshot(), undefined, { provisional: true });
      void refreshHealthSnapshot({ probe: false, includeSensitive }).catch((err) =>
        logHealth.error(`background health refresh failed: ${formatError(err)}`),
      );
      return;
    }
    try {
      const snap = await refreshHealthSnapshot({ probe: wantsProbe, includeSensitive });
      respond(true, snap, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  status: async ({ respond, client }) => {
    const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
    const status = await getStatusSummary({
      includeSensitive: scopes.includes(ADMIN_SCOPE),
    });
    respond(true, status, undefined);
  },
};
