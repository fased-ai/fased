import {
  ACPX_PUSH_TEST_WRAPPER_ID,
  type AcpxPushTestApprovalContractRequest,
  type AcpxPushTestExecutionAdapterResult,
} from "fased/plugin-sdk";
import type { ResolvedAcpxMcpBridgeConfig } from "./config.js";

export const ACPX_PUSH_TEST_REQUEST_MCP_TOOL_NAME = ACPX_PUSH_TEST_WRAPPER_ID;

export const ACPX_MUTATING_BRIDGE_TOOL_IDS = [ACPX_PUSH_TEST_REQUEST_MCP_TOOL_NAME] as const;

export type AcpxMutatingBridgeToolId = (typeof ACPX_MUTATING_BRIDGE_TOOL_IDS)[number];

export type AcpxMutatingBridgeToolDefinition = {
  id: AcpxMutatingBridgeToolId;
  title: string;
  description: string;
  implemented: boolean;
  readOnly: false;
  mutates: true;
  genericDispatcher: false;
};

export type AcpxPushTestMcpToolExecutionAdapter = (params: {
  request: AcpxPushTestApprovalContractRequest;
}) => Promise<AcpxPushTestExecutionAdapterResult> | AcpxPushTestExecutionAdapterResult;

const MUTATING_TOOL_DEFINITIONS: readonly AcpxMutatingBridgeToolDefinition[] = [
  {
    id: ACPX_PUSH_TEST_REQUEST_MCP_TOOL_NAME,
    title: "Fased Push Test Request",
    description:
      "Request an operator-approved push.test execution for one node through the fixed ACPX wrapper. Requires exact request fingerprint approval.",
    implemented: true,
    readOnly: false,
    mutates: true,
    genericDispatcher: false,
  },
];

export const ACPX_MUTATING_BRIDGE_TOOL_REGISTRY = new Map(
  MUTATING_TOOL_DEFINITIONS.map((definition) => [definition.id, Object.freeze({ ...definition })]),
);

export function isAcpxMutatingBridgeToolAllowed(
  bridgeConfig: ResolvedAcpxMcpBridgeConfig,
  toolName: string,
): toolName is AcpxMutatingBridgeToolId {
  if (bridgeConfig.mode !== "operator-approved-mutating-tools") {
    return false;
  }
  if (!ACPX_MUTATING_BRIDGE_TOOL_REGISTRY.has(toolName as AcpxMutatingBridgeToolId)) {
    return false;
  }
  if (bridgeConfig.denyTools.includes(toolName)) {
    return false;
  }
  return bridgeConfig.allowTools.includes(toolName);
}

export function resolveAcpxMcpMutatingToolDefinitions(
  bridgeConfig: ResolvedAcpxMcpBridgeConfig,
): AcpxMutatingBridgeToolDefinition[] {
  if (!bridgeConfig.enabled || bridgeConfig.mode !== "operator-approved-mutating-tools") {
    return [];
  }
  return [...ACPX_MUTATING_BRIDGE_TOOL_REGISTRY.values()].filter(
    (definition) =>
      definition.implemented && isAcpxMutatingBridgeToolAllowed(bridgeConfig, definition.id),
  );
}
