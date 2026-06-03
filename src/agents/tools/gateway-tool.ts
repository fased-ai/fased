import { isDeepStrictEqual } from "node:util";
import { Type } from "@sinclair/typebox";
import { isRestartEnabled } from "../../config/commands.js";
import { parseConfigJson5, type FasedAgentConfig } from "../../config/config.js";
import { resolveConfigSnapshotHash } from "../../config/io.js";
import { applyMergePatch } from "../../config/merge-patch.js";
import { extractDeliveryInfo } from "../../config/sessions.js";
import {
  formatDoctorNonInteractiveHint,
  type RestartSentinelPayload,
  writeRestartSentinel,
} from "../../infra/restart-sentinel.js";
import { scheduleGatewaySigusr1Restart } from "../../infra/restart.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { collectEnabledInsecureOrDangerousFlags } from "../../security/dangerous-config-flags.js";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";
import { callGatewayTool, readGatewayCallOptions } from "./gateway.js";

const log = createSubsystemLogger("gateway-tool");

const DEFAULT_UPDATE_TIMEOUT_MS = 20 * 60_000;

function resolveBaseHashFromSnapshot(snapshot: unknown): string | undefined {
  if (!snapshot || typeof snapshot !== "object") {
    return undefined;
  }
  const hashValue = (snapshot as { hash?: unknown }).hash;
  const rawValue = (snapshot as { raw?: unknown }).raw;
  const hash = resolveConfigSnapshotHash({
    hash: typeof hashValue === "string" ? hashValue : undefined,
    raw: typeof rawValue === "string" ? rawValue : undefined,
  });
  return hash ?? undefined;
}

// Security: the agent-facing gateway tool is owner-only, but the model is not a
// trusted config editor. Runtime config writes fail closed and only allow narrow
// agent-tunable paths; all dangerous flags stay blocked unless already enabled.
const ALLOWED_GATEWAY_CONFIG_PATHS = [
  "agents.defaults.systemPromptOverride",
  "agents.defaults.promptOverlays",
  "agents.defaults.model",
  "agents.defaults.thinkingDefault",
  "agents.defaults.reasoningDefault",
  "agents.defaults.fastModeDefault",
  "agents.list[].id",
  "agents.list[].systemPromptOverride",
  "agents.list[].model",
  "agents.list[].thinkingDefault",
  "agents.list[].reasoningDefault",
  "agents.list[].fastModeDefault",
  "channels.*.requireMention",
  "channels.*.*.requireMention",
  "channels.*.*.*.requireMention",
  "channels.*.*.*.*.requireMention",
  "channels.*.*.*.*.*.requireMention",
] as const;

/** @internal Exposed for regression tests only; do not import from runtime code. */
export const ALLOWED_GATEWAY_CONFIG_PATHS_FOR_TEST = ALLOWED_GATEWAY_CONFIG_PATHS;

/** @internal Exposed for regression tests only; do not import from runtime code. */
export function assertGatewayConfigMutationAllowedForTest(params: {
  action: "config.apply" | "config.patch";
  currentConfig: Record<string, unknown>;
  raw: string;
}): void {
  assertGatewayConfigMutationAllowed(params);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getSnapshotConfig(snapshot: unknown): Record<string, unknown> {
  if (!isRecord(snapshot)) {
    throw new Error("config.get response is not an object.");
  }
  const config = snapshot.config;
  if (!isRecord(config)) {
    throw new Error("config.get response is missing a config object.");
  }
  return config;
}

function parseGatewayConfigMutationRaw(
  raw: string,
  action: "config.apply" | "config.patch",
): Record<string, unknown> {
  const parsed = parseConfigJson5(raw);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  if (!isRecord(parsed.parsed)) {
    throw new Error(`${action} raw must be an object.`);
  }
  return parsed.parsed;
}

function normalizeGatewayConfigPath(path: string): string {
  if (path.startsWith("tools.bash.")) {
    return path.replace(/^tools\.bash\./, "tools.exec.");
  }
  if (path.startsWith("agent.bash.")) {
    return path.replace(/^agent\.bash\./, "tools.exec.");
  }
  return path;
}

function readKeyedArrayEntries(list: unknown): {
  duplicateIds: boolean;
  entries: Map<string, unknown>;
  hasUnkeyedEntries: boolean;
} | null {
  if (!Array.isArray(list)) {
    return null;
  }

  let duplicateIds = false;
  let hasUnkeyedEntries = false;
  const entries = new Map<string, unknown>();
  for (const entry of list) {
    if (!isRecord(entry) || typeof entry.id !== "string" || entry.id.length === 0) {
      hasUnkeyedEntries = true;
      continue;
    }
    if (entries.has(entry.id)) {
      duplicateIds = true;
      continue;
    }
    entries.set(entry.id, entry);
  }
  return { duplicateIds, entries, hasUnkeyedEntries };
}

function collectConfigLeafPaths(value: unknown, basePath: string, out: Set<string>): void {
  const canonicalPath = normalizeGatewayConfigPath(basePath);
  if (value === undefined) {
    if (canonicalPath) {
      out.add(canonicalPath);
    }
    return;
  }

  if (Array.isArray(value)) {
    const keyedEntries = readKeyedArrayEntries(value);
    if (
      keyedEntries &&
      !keyedEntries.duplicateIds &&
      !keyedEntries.hasUnkeyedEntries &&
      keyedEntries.entries.size > 0
    ) {
      for (const entryValue of keyedEntries.entries.values()) {
        collectConfigLeafPaths(entryValue, `${basePath}[]`, out);
      }
      return;
    }
    if (canonicalPath) {
      out.add(canonicalPath);
    }
    return;
  }

  if (!isRecord(value)) {
    if (canonicalPath) {
      out.add(canonicalPath);
    }
    return;
  }

  const entries = Object.entries(value);
  if (entries.length === 0) {
    if (canonicalPath) {
      out.add(canonicalPath);
    }
    return;
  }

  for (const [key, child] of entries) {
    collectConfigLeafPaths(child, basePath ? `${basePath}.${key}` : key, out);
  }
}

function collectChangedConfigPaths(
  currentValue: unknown,
  nextValue: unknown,
  basePath = "",
  out = new Set<string>(),
): Set<string> {
  if (isDeepStrictEqual(currentValue, nextValue)) {
    return out;
  }

  if (currentValue === undefined || nextValue === undefined) {
    collectConfigLeafPaths(currentValue ?? nextValue, basePath, out);
    return out;
  }

  if (Array.isArray(currentValue) || Array.isArray(nextValue)) {
    if (!Array.isArray(currentValue) || !Array.isArray(nextValue)) {
      collectConfigLeafPaths(currentValue, basePath, out);
      collectConfigLeafPaths(nextValue, basePath, out);
      return out;
    }

    const currentEntries = readKeyedArrayEntries(currentValue);
    const nextEntries = readKeyedArrayEntries(nextValue);
    if (
      !currentEntries ||
      !nextEntries ||
      currentEntries.duplicateIds ||
      nextEntries.duplicateIds ||
      currentEntries.hasUnkeyedEntries ||
      nextEntries.hasUnkeyedEntries
    ) {
      out.add(normalizeGatewayConfigPath(basePath));
      return out;
    }

    const ids = new Set([...currentEntries.entries.keys(), ...nextEntries.entries.keys()]);
    for (const id of ids) {
      collectChangedConfigPaths(
        currentEntries.entries.get(id),
        nextEntries.entries.get(id),
        `${basePath}[]`,
        out,
      );
    }
    return out;
  }

  if (isRecord(currentValue) && isRecord(nextValue)) {
    const keys = new Set([...Object.keys(currentValue), ...Object.keys(nextValue)]);
    for (const key of keys) {
      collectChangedConfigPaths(
        currentValue[key],
        nextValue[key],
        basePath ? `${basePath}.${key}` : key,
        out,
      );
    }
    return out;
  }

  out.add(normalizeGatewayConfigPath(basePath));
  return out;
}

function pathSegmentMatches(patternSegment: string, pathSegment: string): boolean {
  return patternSegment === "*" || patternSegment === pathSegment;
}

function isAllowedGatewayConfigPath(path: string): boolean {
  const pathSegments = path.split(".");
  return ALLOWED_GATEWAY_CONFIG_PATHS.some((pattern) => {
    const patternSegments = pattern.split(".");
    if (patternSegments.length > pathSegments.length) {
      return false;
    }
    for (let index = 0; index < patternSegments.length; index += 1) {
      if (!pathSegmentMatches(patternSegments[index], pathSegments[index])) {
        return false;
      }
    }
    return true;
  });
}

function assertGatewayConfigMutationAllowed(params: {
  action: "config.apply" | "config.patch";
  currentConfig: Record<string, unknown>;
  raw: string;
}): void {
  const parsed = parseGatewayConfigMutationRaw(params.raw, params.action);
  const nextConfig =
    params.action === "config.apply"
      ? parsed
      : (applyMergePatch(params.currentConfig, parsed, {
          mergeObjectArraysById: true,
        }) as Record<string, unknown>);

  const changedPaths = [...collectChangedConfigPaths(params.currentConfig, nextConfig)].toSorted();
  const disallowedPaths = changedPaths.filter((path) => !isAllowedGatewayConfigPath(path));
  if (disallowedPaths.length > 0) {
    throw new Error(
      `gateway ${params.action} cannot change protected config paths: ${disallowedPaths.join(", ")}`,
    );
  }

  const currentFlags = new Set(
    collectEnabledInsecureOrDangerousFlags(params.currentConfig as FasedAgentConfig),
  );
  const nextFlags = collectEnabledInsecureOrDangerousFlags(nextConfig as FasedAgentConfig);
  const newlyEnabled = nextFlags.filter((flag) => !currentFlags.has(flag));
  if (newlyEnabled.length > 0) {
    throw new Error(
      `gateway ${params.action} cannot enable dangerous config flags: ${newlyEnabled.join(", ")}`,
    );
  }
}

const GATEWAY_ACTIONS = [
  "restart",
  "config.get",
  "config.schema",
  "config.schema.lookup",
  "config.apply",
  "config.patch",
  "models.auth.status",
  "models.catalog.status",
  "update.run",
] as const;

// NOTE: Using a flattened object schema instead of Type.Union([Type.Object(...), ...])
// because Claude API on Vertex AI rejects nested anyOf schemas as invalid JSON Schema.
// The discriminator (action) determines which properties are relevant; runtime validates.
const GatewayToolSchema = Type.Object({
  action: stringEnum(GATEWAY_ACTIONS),
  // restart
  delayMs: Type.Optional(Type.Number()),
  reason: Type.Optional(Type.String()),
  // config.get, config.schema, config.apply, model status, update.run
  gatewayUrl: Type.Optional(Type.String()),
  gatewayToken: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Number()),
  // config.apply, config.patch
  raw: Type.Optional(Type.String()),
  baseHash: Type.Optional(Type.String()),
  // config.schema.lookup
  path: Type.Optional(Type.String()),
  // config.apply, config.patch, update.run
  sessionKey: Type.Optional(Type.String()),
  note: Type.Optional(Type.String()),
  restartDelayMs: Type.Optional(Type.Number()),
});
// NOTE: We intentionally avoid top-level `allOf`/`anyOf`/`oneOf` conditionals here:
// - OpenAI rejects tool schemas that include these keywords at the *top-level*.
// - Claude/Vertex has other JSON Schema quirks.
// Conditional requirements (like `raw` for config.apply) are enforced at runtime.

export function createGatewayTool(opts?: {
  agentSessionKey?: string;
  config?: FasedAgentConfig;
}): AnyAgentTool {
  return {
    label: "Gateway",
    name: "gateway",
    ownerOnly: true,
    description:
      "Restart, inspect provider health, apply config, or update the gateway in-place (SIGUSR1). Use models.auth.status for provider credential health and models.catalog.status for provider/model catalog health. Use config.patch for safe partial config updates (merges with existing). Use config.apply only when replacing entire config. Both trigger restart after writing. Always pass a human-readable completion message via the `note` parameter so the system can deliver it to the user after restart.",
    parameters: GatewayToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      if (action === "restart") {
        if (!isRestartEnabled(opts?.config)) {
          throw new Error("Gateway restart is disabled (commands.restart=false).");
        }
        const sessionKey =
          typeof params.sessionKey === "string" && params.sessionKey.trim()
            ? params.sessionKey.trim()
            : opts?.agentSessionKey?.trim() || undefined;
        const delayMs =
          typeof params.delayMs === "number" && Number.isFinite(params.delayMs)
            ? Math.floor(params.delayMs)
            : undefined;
        const reason =
          typeof params.reason === "string" && params.reason.trim()
            ? params.reason.trim().slice(0, 200)
            : undefined;
        const note =
          typeof params.note === "string" && params.note.trim() ? params.note.trim() : undefined;
        // Extract channel + threadId for routing after restart
        // Supports both :thread: (most channels) and :topic: (Telegram)
        const { deliveryContext, threadId } = extractDeliveryInfo(sessionKey);
        const payload: RestartSentinelPayload = {
          kind: "restart",
          status: "ok",
          ts: Date.now(),
          sessionKey,
          deliveryContext,
          threadId,
          message: note ?? reason ?? null,
          doctorHint: formatDoctorNonInteractiveHint(),
          stats: {
            mode: "gateway.restart",
            reason,
          },
        };
        try {
          await writeRestartSentinel(payload);
        } catch {
          // ignore: sentinel is best-effort
        }
        log.info(
          `gateway tool: restart requested (delayMs=${delayMs ?? "default"}, reason=${reason ?? "none"})`,
        );
        const scheduled = scheduleGatewaySigusr1Restart({
          delayMs,
          reason,
        });
        return jsonResult(scheduled);
      }

      const gatewayOpts = { gatewayTarget: "local" as const, ...readGatewayCallOptions(params) };

      const resolveGatewayWriteMeta = (): {
        sessionKey: string | undefined;
        note: string | undefined;
        restartDelayMs: number | undefined;
      } => {
        const sessionKey =
          typeof params.sessionKey === "string" && params.sessionKey.trim()
            ? params.sessionKey.trim()
            : opts?.agentSessionKey?.trim() || undefined;
        const note =
          typeof params.note === "string" && params.note.trim() ? params.note.trim() : undefined;
        const restartDelayMs =
          typeof params.restartDelayMs === "number" && Number.isFinite(params.restartDelayMs)
            ? Math.floor(params.restartDelayMs)
            : undefined;
        return { sessionKey, note, restartDelayMs };
      };

      const resolveConfigWriteParams = async (): Promise<{
        raw: string;
        baseHash: string;
        snapshotConfig: Record<string, unknown>;
        sessionKey: string | undefined;
        note: string | undefined;
        restartDelayMs: number | undefined;
      }> => {
        const raw = readStringParam(params, "raw", { required: true });
        let baseHash = readStringParam(params, "baseHash");
        const snapshot = await callGatewayTool("config.get", gatewayOpts, {});
        const snapshotConfig = getSnapshotConfig(snapshot);
        if (!baseHash) {
          baseHash = resolveBaseHashFromSnapshot(snapshot);
        }
        if (!baseHash) {
          throw new Error("Missing baseHash from config snapshot.");
        }
        return { raw, baseHash, snapshotConfig, ...resolveGatewayWriteMeta() };
      };

      if (action === "config.get") {
        const result = await callGatewayTool("config.get", gatewayOpts, {});
        return jsonResult({ ok: true, result });
      }
      if (action === "config.schema") {
        const result = await callGatewayTool("config.schema", gatewayOpts, {});
        return jsonResult({ ok: true, result });
      }
      if (action === "config.schema.lookup") {
        const path = readStringParam(params, "path", { required: true });
        const result = await callGatewayTool("config.schema.lookup", gatewayOpts, { path });
        return jsonResult({ ok: true, result });
      }
      if (action === "models.auth.status" || action === "models.catalog.status") {
        const result = await callGatewayTool(action, gatewayOpts, {});
        return jsonResult({ ok: true, result });
      }
      if (action === "config.apply") {
        const { raw, baseHash, snapshotConfig, sessionKey, note, restartDelayMs } =
          await resolveConfigWriteParams();
        assertGatewayConfigMutationAllowed({
          action: "config.apply",
          currentConfig: snapshotConfig,
          raw,
        });
        const result = await callGatewayTool("config.apply", gatewayOpts, {
          raw,
          baseHash,
          sessionKey,
          note,
          restartDelayMs,
        });
        return jsonResult({ ok: true, result });
      }
      if (action === "config.patch") {
        const { raw, baseHash, snapshotConfig, sessionKey, note, restartDelayMs } =
          await resolveConfigWriteParams();
        assertGatewayConfigMutationAllowed({
          action: "config.patch",
          currentConfig: snapshotConfig,
          raw,
        });
        const result = await callGatewayTool("config.patch", gatewayOpts, {
          raw,
          baseHash,
          sessionKey,
          note,
          restartDelayMs,
        });
        return jsonResult({ ok: true, result });
      }
      if (action === "update.run") {
        const { sessionKey, note, restartDelayMs } = resolveGatewayWriteMeta();
        const updateTimeoutMs = gatewayOpts.timeoutMs ?? DEFAULT_UPDATE_TIMEOUT_MS;
        const updateGatewayOpts = {
          ...gatewayOpts,
          timeoutMs: updateTimeoutMs,
        };
        const result = await callGatewayTool("update.run", updateGatewayOpts, {
          sessionKey,
          note,
          restartDelayMs,
          timeoutMs: updateTimeoutMs,
        });
        return jsonResult({ ok: true, result });
      }

      throw new Error(`Unknown action: ${action}`);
    },
  };
}
