import {
  loadApnsRegistration,
  resolveApnsAuthConfigFromEnv,
  sendApnsBackgroundWake,
} from "../infra/push-apns.js";

const NODE_WAKE_THROTTLE_MS = 15_000;

type NodeWakeState = {
  lastWakeAtMs: number;
  inFlight?: Promise<NodeWakeAttempt>;
};

export type NodeWakeAttempt = {
  available: boolean;
  throttled: boolean;
  path: "throttled" | "no-registration" | "no-auth" | "sent" | "send-error";
  durationMs: number;
  apnsStatus?: number;
  apnsReason?: string;
};

const nodeWakeById = new Map<string, NodeWakeState>();

export async function maybeWakeNodeWithApns(
  nodeId: string,
  opts?: { force?: boolean; wakeReason?: string },
): Promise<NodeWakeAttempt> {
  const state = nodeWakeById.get(nodeId) ?? { lastWakeAtMs: 0 };
  nodeWakeById.set(nodeId, state);

  if (state.inFlight) {
    return await state.inFlight;
  }

  const now = Date.now();
  const force = opts?.force === true;
  if (!force && state.lastWakeAtMs > 0 && now - state.lastWakeAtMs < NODE_WAKE_THROTTLE_MS) {
    return { available: true, throttled: true, path: "throttled", durationMs: 0 };
  }

  state.inFlight = (async () => {
    const startedAtMs = Date.now();
    const withDuration = (attempt: Omit<NodeWakeAttempt, "durationMs">): NodeWakeAttempt => ({
      ...attempt,
      durationMs: Math.max(0, Date.now() - startedAtMs),
    });

    try {
      const registration = await loadApnsRegistration(nodeId);
      if (!registration) {
        return withDuration({ available: false, throttled: false, path: "no-registration" });
      }

      const auth = await resolveApnsAuthConfigFromEnv(process.env);
      if (!auth.ok) {
        return withDuration({
          available: false,
          throttled: false,
          path: "no-auth",
          apnsReason: auth.error,
        });
      }

      state.lastWakeAtMs = Date.now();
      const wakeResult = await sendApnsBackgroundWake({
        auth: auth.value,
        registration,
        nodeId,
        wakeReason: opts?.wakeReason ?? "node.invoke",
      });
      if (!wakeResult.ok) {
        return withDuration({
          available: true,
          throttled: false,
          path: "send-error",
          apnsStatus: wakeResult.status,
          apnsReason: wakeResult.reason,
        });
      }
      return withDuration({
        available: true,
        throttled: false,
        path: "sent",
        apnsStatus: wakeResult.status,
        apnsReason: wakeResult.reason,
      });
    } catch (err) {
      // Best-effort wake only.
      const message = err instanceof Error ? err.message : String(err);
      if (state.lastWakeAtMs === 0) {
        return withDuration({
          available: false,
          throttled: false,
          path: "send-error",
          apnsReason: message,
        });
      }
      return withDuration({
        available: true,
        throttled: false,
        path: "send-error",
        apnsReason: message,
      });
    }
  })();

  try {
    return await state.inFlight;
  } finally {
    state.inFlight = undefined;
  }
}

export function resetNodeWakeApnsForTests() {
  nodeWakeById.clear();
}
