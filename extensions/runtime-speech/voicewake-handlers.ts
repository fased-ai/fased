import { ErrorCodes, errorShape } from "../../src/gateway/protocol/index.js";
import type { GatewayRequestHandlers } from "../../src/gateway/server-methods/types.js";
import { normalizeVoiceWakeTriggers } from "../../src/gateway/server-utils.js";
import { formatForLog } from "../../src/gateway/ws-log.js";
import { loadVoiceWakeConfig, setVoiceWakeTriggers } from "../../src/infra/voicewake.js";

const getVoiceWakeRouting: GatewayRequestHandlers[string] = async ({ respond }) => {
  try {
    const cfg = await loadVoiceWakeConfig();
    respond(true, { triggers: cfg.triggers });
  } catch (err) {
    respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
  }
};

const setVoiceWakeRouting: GatewayRequestHandlers[string] = async ({
  params,
  respond,
  context,
}) => {
  if (!Array.isArray(params.triggers)) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "voicewake.set requires triggers: string[]"),
    );
    return;
  }
  try {
    const triggers = normalizeVoiceWakeTriggers(params.triggers);
    const cfg = await setVoiceWakeTriggers(triggers);
    context.broadcastVoiceWakeChanged(cfg.triggers);
    respond(true, { triggers: cfg.triggers });
  } catch (err) {
    respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
  }
};

export const voicewakeHandlers: GatewayRequestHandlers = {
  "voicewake.get": getVoiceWakeRouting,
  "voicewake.routing.get": getVoiceWakeRouting,
  "voicewake.set": setVoiceWakeRouting,
  "voicewake.routing.set": async (opts) => {
    if (!Array.isArray(opts.params.triggers)) {
      opts.respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "voicewake.routing.set requires triggers: string[]"),
      );
      return;
    }
    await setVoiceWakeRouting(opts);
  },
};
