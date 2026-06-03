export type SessionLifecycleEvent = Record<string, unknown>;

export async function emitSessionLifecycleEvent(_event: SessionLifecycleEvent): Promise<void> {
  // Stable hook point for subagent lifecycle emitters. Runtime session broadcasts
  // are handled by the gateway event layer.
}
