import {
  ErrorCodes,
  errorShape,
  validateUpdateRunParams,
  validateUpdateStatusParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

const OWNER_SHELL_UPDATE_MESSAGE =
  "Managed updates cannot run inside replaceable Gateway application bytes; run fased update from the owner shell.";
const OWNER_SHELL_STATUS_MESSAGE =
  "Canonical managed lifecycle status is unavailable inside replaceable Gateway application bytes; run fased update status from the owner shell.";

export const updateHandlers: GatewayRequestHandlers = {
  "update.status": async ({ params, respond }) => {
    if (!assertValidParams(params, validateUpdateStatusParams, "update.status", respond)) {
      return;
    }

    respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, OWNER_SHELL_STATUS_MESSAGE));
  },

  "update.run": async ({ params, respond }) => {
    if (!assertValidParams(params, validateUpdateRunParams, "update.run", respond)) {
      return;
    }

    respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, OWNER_SHELL_UPDATE_MESSAGE));
  },
};
