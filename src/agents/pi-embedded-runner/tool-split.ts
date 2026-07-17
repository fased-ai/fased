import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { toToolDefinitions } from "../pi-tool-definition-adapter.js";
import { isKnownCoreToolId } from "../tool-catalog.js";
import { normalizeToolName } from "../tool-policy.js";

// We always pass tools via `customTools` so our policy filtering, sandbox integration,
// and extended toolset remain consistent across providers.
type AnyAgentTool = AgentTool;

// A client tool must never make a dormant SDK built-in or policy-disabled core tool
// eligible for activation under the same name.
const SDK_BUILT_IN_TOOL_NAMES = new Set(
  ["read", "bash", "edit", "write", "grep", "find", "ls"].map(normalizeToolName),
);

function validateClientToolDefinitions(params: {
  fasedTools: ToolDefinition[];
  clientTools: ToolDefinition[];
}): void {
  const fasedToolNames = new Set(params.fasedTools.map((tool) => normalizeToolName(tool.name)));
  const clientToolNames = new Set<string>();

  for (const tool of params.clientTools) {
    const name = tool.name;
    const trimmedName = name.trim();
    if (!trimmedName || trimmedName !== name) {
      throw new Error("Client tool names must be non-empty and must not contain outer whitespace");
    }

    const normalizedName = normalizeToolName(name);
    if (
      SDK_BUILT_IN_TOOL_NAMES.has(normalizedName) ||
      isKnownCoreToolId(normalizedName) ||
      fasedToolNames.has(normalizedName)
    ) {
      throw new Error(`Client tool name "${name}" is reserved by Fased`);
    }
    if (clientToolNames.has(normalizedName)) {
      throw new Error(`Duplicate client tool name: "${name}"`);
    }
    clientToolNames.add(normalizedName);
  }
}

export function splitSdkTools(options: {
  tools: AnyAgentTool[];
  clientTools?: ToolDefinition[];
  sandboxEnabled: boolean;
}): {
  activeToolNames: string[];
  customTools: ToolDefinition[];
} {
  const { tools } = options;
  const fasedTools = toToolDefinitions(tools);
  const clientTools = options.clientTools ?? [];
  validateClientToolDefinitions({ fasedTools, clientTools });
  const customTools = [...fasedTools, ...clientTools];
  return {
    activeToolNames: customTools.map((tool) => tool.name),
    customTools,
  };
}
