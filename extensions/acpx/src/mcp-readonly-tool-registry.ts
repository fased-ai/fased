import type { ResolvedAcpxMcpBridgeConfig } from "./config.js";

export const ACPX_STATUS_MCP_TOOL_NAME = "fased_tools_effective";
export const ACPX_GATEWAY_IDENTITY_MCP_TOOL_NAME = "fased_gateway_identity";
export const ACPX_GATEWAY_STATUS_MCP_TOOL_NAME = "fased_gateway_status";
export const ACPX_MODELS_CATALOG_STATUS_MCP_TOOL_NAME = "fased_models_catalog_status";
export const ACPX_COMMANDS_LIST_MCP_TOOL_NAME = "fased_commands_list";
export const ACPX_ACP_STATUS_MCP_TOOL_NAME = "fased_acp_status";

export const ACPX_READONLY_BRIDGE_TOOL_IDS = [
  ACPX_STATUS_MCP_TOOL_NAME,
  ACPX_GATEWAY_IDENTITY_MCP_TOOL_NAME,
  ACPX_GATEWAY_STATUS_MCP_TOOL_NAME,
  ACPX_MODELS_CATALOG_STATUS_MCP_TOOL_NAME,
  ACPX_COMMANDS_LIST_MCP_TOOL_NAME,
  ACPX_ACP_STATUS_MCP_TOOL_NAME,
] as const;

export type AcpxReadonlyBridgeToolId = (typeof ACPX_READONLY_BRIDGE_TOOL_IDS)[number];

export type AcpxReadonlyBridgeToolDefinition = {
  id: string;
  title: string;
  description: string;
  implemented: boolean;
  readOnly: boolean;
  mutates?: boolean;
  genericDispatcher?: boolean;
};

const BLOCKED_TOOL_ID_PATTERNS = [
  /(^|[._-])(exec|shell|spawn|process|terminal)([._-]|$)/i,
  /gateway[._-]?config/i,
  /wallet/i,
  /generic.*dispatch/i,
  /dispatcher/i,
  /plugin.*(install|update|uninstall|enable|disable)/i,
  /cron.*(create|update|delete)/i,
  /commands?[._-]?(run|exec|invoke|dispatch)/i,
];

const DEFAULT_READONLY_BRIDGE_TOOL_DEFINITIONS: AcpxReadonlyBridgeToolDefinition[] = [
  {
    id: ACPX_STATUS_MCP_TOOL_NAME,
    title: "Fased Effective Tools Preview",
    description:
      "Preview the read-only effective Fased tool inventory for the default agent context. This does not execute tools.",
    implemented: true,
    readOnly: true,
  },
  {
    id: ACPX_GATEWAY_IDENTITY_MCP_TOOL_NAME,
    title: "Fased Gateway Identity",
    description: "Read the sanitized public gateway device identity.",
    implemented: true,
    readOnly: true,
  },
  {
    id: ACPX_GATEWAY_STATUS_MCP_TOOL_NAME,
    title: "Fased Gateway Status",
    description: "Read sanitized gateway status without exposing local paths or session details.",
    implemented: true,
    readOnly: true,
  },
  {
    id: ACPX_MODELS_CATALOG_STATUS_MCP_TOOL_NAME,
    title: "Fased Models Catalog Status",
    description: "Read sanitized provider/model catalog status without exposing provider secrets.",
    implemented: true,
    readOnly: true,
  },
  {
    id: ACPX_COMMANDS_LIST_MCP_TOOL_NAME,
    title: "Fased Commands List",
    description: "Read command metadata without invoking commands.",
    implemented: true,
    readOnly: true,
  },
  {
    id: ACPX_ACP_STATUS_MCP_TOOL_NAME,
    title: "Fased ACP Status",
    description: "Read ACP/session bridge status without session mutation.",
    implemented: true,
    readOnly: true,
  },
];

function isNonEmptyTrimmedString(value: string): boolean {
  return value.trim() === value && value.length > 0;
}

function isBlockedToolId(toolId: string): boolean {
  return BLOCKED_TOOL_ID_PATTERNS.some((pattern) => pattern.test(toolId));
}

function assertReadonlyBridgeToolDefinition(definition: AcpxReadonlyBridgeToolDefinition): void {
  if (!isNonEmptyTrimmedString(definition.id)) {
    throw new Error("ACPX read-only bridge tool id must be a non-empty trimmed string");
  }
  if (!definition.readOnly) {
    throw new Error(`ACPX bridge tool ${definition.id} must be read-only`);
  }
  if (definition.mutates === true) {
    throw new Error(`ACPX bridge tool ${definition.id} cannot mutate state`);
  }
  if (definition.genericDispatcher === true) {
    throw new Error(`ACPX bridge tool ${definition.id} cannot be a generic dispatcher`);
  }
  if (isBlockedToolId(definition.id)) {
    throw new Error(`ACPX bridge tool ${definition.id} is blocked by read-only bridge policy`);
  }
}

export function createAcpxReadonlyBridgeToolRegistry(
  definitions: readonly AcpxReadonlyBridgeToolDefinition[] = DEFAULT_READONLY_BRIDGE_TOOL_DEFINITIONS,
): ReadonlyMap<string, AcpxReadonlyBridgeToolDefinition> {
  const registry = new Map<string, AcpxReadonlyBridgeToolDefinition>();
  for (const definition of definitions) {
    assertReadonlyBridgeToolDefinition(definition);
    if (registry.has(definition.id)) {
      throw new Error(`duplicate ACPX read-only bridge tool id: ${definition.id}`);
    }
    registry.set(definition.id, Object.freeze({ ...definition }));
  }
  return registry;
}

export const ACPX_READONLY_BRIDGE_TOOL_REGISTRY = createAcpxReadonlyBridgeToolRegistry();

export function isAcpxReadonlyBridgeToolId(toolName: string): toolName is AcpxReadonlyBridgeToolId {
  return ACPX_READONLY_BRIDGE_TOOL_REGISTRY.has(toolName);
}

export function isAcpxMcpBridgeToolAllowed(
  bridgeConfig: ResolvedAcpxMcpBridgeConfig,
  toolName: string,
): boolean {
  if (!isAcpxReadonlyBridgeToolId(toolName)) {
    return false;
  }
  if (bridgeConfig.denyTools.includes(toolName)) {
    return false;
  }
  if (bridgeConfig.allowTools.length > 0 && !bridgeConfig.allowTools.includes(toolName)) {
    return false;
  }
  return true;
}

export function resolveAcpxMcpBridgeToolDefinitions(
  bridgeConfig: ResolvedAcpxMcpBridgeConfig,
  opts?: {
    implementedOnly?: boolean;
  },
): AcpxReadonlyBridgeToolDefinition[] {
  if (!bridgeConfig.enabled) {
    return [];
  }
  const candidates =
    bridgeConfig.mode === "status-only"
      ? [ACPX_STATUS_MCP_TOOL_NAME]
      : [...ACPX_READONLY_BRIDGE_TOOL_REGISTRY.keys()];
  return candidates
    .filter((toolName) => isAcpxMcpBridgeToolAllowed(bridgeConfig, toolName))
    .map((toolName) => ACPX_READONLY_BRIDGE_TOOL_REGISTRY.get(toolName))
    .filter((definition): definition is AcpxReadonlyBridgeToolDefinition => definition != null)
    .filter((definition) => opts?.implementedOnly !== true || definition.implemented);
}
