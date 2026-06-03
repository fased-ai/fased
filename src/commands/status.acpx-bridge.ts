import type { FasedAgentConfig } from "../config/types.fased.js";

export const ACPX_PUSH_TEST_TOOL_NAME = "fased_push_test_request";

export type AcpxMcpBridgeModeStatus =
  | "disabled"
  | "status-only"
  | "read-only-tools"
  | "operator-approved-mutating-tools";

export type AcpxMcpBridgeStatus = {
  pluginId: "acpx";
  enabled: boolean;
  mode: AcpxMcpBridgeModeStatus;
  configuredMode: Exclude<AcpxMcpBridgeModeStatus, "disabled">;
  allowTools: string[];
  denyTools: string[];
  fasedPushTestRequest: {
    toolName: typeof ACPX_PUSH_TEST_TOOL_NAME;
    enabled: boolean;
    allowed: boolean;
    denied: boolean;
    reason: string;
  };
};

const VALID_MODES = new Set(["status-only", "read-only-tools", "operator-approved-mutating-tools"]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readToolList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [
    ...new Set(
      value
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter((entry) => entry.length > 0),
    ),
  ].toSorted((left, right) => left.localeCompare(right));
}

function readConfiguredMode(value: unknown): AcpxMcpBridgeStatus["configuredMode"] {
  return typeof value === "string" && VALID_MODES.has(value)
    ? (value as AcpxMcpBridgeStatus["configuredMode"])
    : "status-only";
}

export function resolveAcpxMcpBridgeStatus(
  cfg: Pick<FasedAgentConfig, "plugins">,
): AcpxMcpBridgeStatus {
  const pluginEntry = cfg.plugins?.entries?.acpx;
  const pluginEnabled = cfg.plugins?.enabled !== false && pluginEntry?.enabled !== false;
  const pluginConfig = asRecord(pluginEntry?.config);
  const bridgeConfig = asRecord(pluginConfig.mcpBridge);
  const configuredMode = readConfiguredMode(bridgeConfig.mode);
  const bridgeEnabled = pluginEnabled && bridgeConfig.enabled === true;
  const allowTools = readToolList(bridgeConfig.allowTools);
  const denyTools = readToolList(bridgeConfig.denyTools);
  const denied = denyTools.includes(ACPX_PUSH_TEST_TOOL_NAME);
  const allowed = allowTools.includes(ACPX_PUSH_TEST_TOOL_NAME);
  const enabled =
    bridgeEnabled && configuredMode === "operator-approved-mutating-tools" && allowed && !denied;
  const reason = (() => {
    if (!bridgeEnabled) {
      return "mcpBridge.disabled";
    }
    if (configuredMode !== "operator-approved-mutating-tools") {
      return "mcpBridge.not-mutating-mode";
    }
    if (denied) {
      return "mcpBridge.denyTools";
    }
    if (!allowed) {
      return "mcpBridge.allowTools";
    }
    return "enabled";
  })();

  return {
    pluginId: "acpx",
    enabled: bridgeEnabled,
    mode: bridgeEnabled ? configuredMode : "disabled",
    configuredMode,
    allowTools,
    denyTools,
    fasedPushTestRequest: {
      toolName: ACPX_PUSH_TEST_TOOL_NAME,
      enabled,
      allowed,
      denied,
      reason,
    },
  };
}
