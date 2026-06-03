import type { loadConfig } from "../config/config.js";
import { resolveAgentIdFromSessionKey, resolveMainSessionKey } from "../config/sessions.js";
import { normalizeMainKey } from "../routing/session-key.js";

export function resolveRequesterStoreKey(
  cfg: ReturnType<typeof loadConfig>,
  requesterSessionKey: string,
): string {
  const raw = (requesterSessionKey ?? "").trim();
  if (!raw) {
    return raw;
  }
  if (raw === "global" || raw === "unknown") {
    return raw;
  }
  if (raw.startsWith("agent:")) {
    return raw;
  }
  const mainKey = normalizeMainKey(cfg.session?.mainKey);
  if (raw === "main" || raw === mainKey) {
    return resolveMainSessionKey(cfg);
  }
  const agentId = resolveAgentIdFromSessionKey(raw);
  return `agent:${agentId}:${raw}`;
}

export const __testing = {
  setDepsForTest(_overrides?: unknown) {
    // Compatibility shim for legacy test fixtures. Current delivery code is
    // exercised through module mocks for gateway/config dependencies.
  },
};
