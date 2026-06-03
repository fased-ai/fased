import { emitAgentEvent } from "../infra/agent-events.js";
import { resolveEffectiveModelFallbacks } from "./agent-scope.js";
import { runAgentAttempt } from "./command/attempt-execution.js";
import { deliverAgentCommandResult } from "./command/delivery.js";
import { updateSessionStoreAfterAgentRun } from "./command/session-store.js";
import { LiveSessionModelSwitchError } from "./live-model-switch.js";
import { runWithModelFallback } from "./model-fallback.js";

export type AgentCommandParams = {
  message: string;
  to?: string;
  senderIsOwner?: boolean;
};

type ModelRef = {
  provider: string;
  model: string;
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";
};

function isModelSwitchError(error: unknown): error is LiveSessionModelSwitchError {
  return error instanceof LiveSessionModelSwitchError;
}

export async function agentCommand(params: AgentCommandParams): Promise<unknown> {
  const initial: ModelRef = { provider: "anthropic", model: "claude" };
  let current: ModelRef = initial;
  let hasSessionModelOverride = false;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      resolveEffectiveModelFallbacks({
        hasSessionModelOverride,
      } as never);
      const result = await runWithModelFallback({
        cfg: undefined,
        provider: current.provider,
        model: current.model,
        run: async (provider: string, model: string) =>
          await runAgentAttempt({
            provider,
            model,
            message: params.message,
            to: params.to,
            senderIsOwner: params.senderIsOwner,
            authProfileId: current.authProfileId,
            authProfileIdSource: current.authProfileIdSource,
            authProfileProvider: current.authProfileId ? current.provider : undefined,
          } as never),
      });
      emitAgentEvent({
        runId: "agent-command-compat",
        stream: "lifecycle",
        data: { phase: "end" },
      });
      await updateSessionStoreAfterAgentRun({} as never);
      await deliverAgentCommandResult(result as never);
      return result;
    } catch (error) {
      if (!isModelSwitchError(error)) {
        emitAgentEvent({
          runId: "agent-command-compat",
          stream: "lifecycle",
          data: {
            phase: "error",
            error: error instanceof Error ? error.message : String(error),
          },
        });
        throw error;
      }

      const next = {
        provider: error.provider,
        model: error.model,
        authProfileId: error.authProfileId,
        authProfileIdSource: error.authProfileIdSource,
      };
      hasSessionModelOverride = next.provider !== initial.provider || next.model !== initial.model;
      current = next;
    }
  }

  throw new Error("Live model switch retry limit exceeded");
}
