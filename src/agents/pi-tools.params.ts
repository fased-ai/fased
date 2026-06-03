import type { AgentTool } from "@mariozechner/pi-agent-core";
import { logError } from "../logger.js";

export type RequiredParamGroup = { keys: string[] };

export const REQUIRED_PARAM_GROUPS = {
  edit: [{ keys: ["edits"] }],
} as const satisfies Record<string, readonly RequiredParamGroup[]>;

export function wrapToolParamValidation<T extends AgentTool>(
  tool: T,
  groups: readonly RequiredParamGroup[],
): T {
  return {
    ...tool,
    execute: async (toolCallId: string, params: unknown, ...rest: unknown[]) => {
      const received =
        params && typeof params === "object" && !Array.isArray(params)
          ? Object.keys(params as Record<string, unknown>)
          : [];
      const missing = groups
        .filter((group) => !group.keys.some((key) => received.includes(key)))
        .map((group) => group.keys[0])
        .filter(Boolean);
      if (missing.length > 0) {
        const message = `Missing required parameter: ${missing[0]} (received: ${received.join(
          ", ",
        )}). Supply correct parameters before retrying. raw_params=${JSON.stringify(params)}`;
        logError(`[tools] ${tool.name} failed: ${message}`);
        throw new Error(message);
      }
      return await (tool.execute as (...args: unknown[]) => Promise<unknown>)(
        toolCallId,
        params,
        ...rest,
      );
    },
  } as T;
}
