import type { emitAgentEvent } from "../../infra/agent-events.js";

export type AgentCommandRunEvent = {
  stream: string;
  data?: Record<string, unknown>;
};

export type AgentCommandLifecycleTracker = {
  readonly ended: boolean;
  observe(event: AgentCommandRunEvent): void;
  emitEnd(data?: Record<string, unknown>): void;
  emitError(error: unknown): void;
};

export function isTerminalLifecycleEvent(event: AgentCommandRunEvent): boolean {
  return (
    event.stream === "lifecycle" &&
    typeof event.data?.phase === "string" &&
    (event.data.phase === "end" || event.data.phase === "error")
  );
}

export function createAgentCommandLifecycleTracker(params: {
  runId: string;
  startedAt: number;
  emit: typeof emitAgentEvent;
}): AgentCommandLifecycleTracker {
  let lifecycleEnded = false;
  const tracker: AgentCommandLifecycleTracker = {
    get ended() {
      return lifecycleEnded;
    },
    observe(event) {
      if (isTerminalLifecycleEvent(event)) {
        lifecycleEnded = true;
      }
    },
    emitEnd(data) {
      if (lifecycleEnded) {
        return;
      }
      lifecycleEnded = true;
      params.emit({
        runId: params.runId,
        stream: "lifecycle",
        data: {
          phase: "end",
          startedAt: params.startedAt,
          endedAt: Date.now(),
          ...data,
        },
      });
    },
    emitError(error) {
      if (lifecycleEnded) {
        return;
      }
      lifecycleEnded = true;
      params.emit({
        runId: params.runId,
        stream: "lifecycle",
        data: {
          phase: "error",
          startedAt: params.startedAt,
          endedAt: Date.now(),
          error: String(error),
        },
      });
    },
  };
  return tracker;
}
