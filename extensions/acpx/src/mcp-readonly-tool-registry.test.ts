import { describe, expect, it } from "vitest";
import {
  ACPX_READONLY_BRIDGE_TOOL_IDS,
  ACPX_STATUS_MCP_TOOL_NAME,
  createAcpxReadonlyBridgeToolRegistry,
  isAcpxMcpBridgeToolAllowed,
  resolveAcpxMcpBridgeToolDefinitions,
} from "./mcp-readonly-tool-registry.js";

describe("ACPX read-only bridge tool registry", () => {
  it("defines a fixed Fased-owned wrapper list", () => {
    expect(ACPX_READONLY_BRIDGE_TOOL_IDS).toEqual([
      "fased_tools_effective",
      "fased_gateway_identity",
      "fased_gateway_status",
      "fased_models_catalog_status",
      "fased_commands_list",
      "fased_acp_status",
    ]);
  });

  it("resolves status-only mode to the effective tools preview only", () => {
    const tools = resolveAcpxMcpBridgeToolDefinitions({
      enabled: true,
      mode: "status-only",
      allowTools: [],
      denyTools: [],
    });

    expect(tools.map((tool) => tool.id)).toEqual([ACPX_STATUS_MCP_TOOL_NAME]);
    expect(tools.every((tool) => tool.readOnly)).toBe(true);
    expect(tools.every((tool) => tool.implemented)).toBe(true);
  });

  it("resolves read-only-tools mode to fixed wrappers without generic dispatch", () => {
    const tools = resolveAcpxMcpBridgeToolDefinitions({
      enabled: true,
      mode: "read-only-tools",
      allowTools: [],
      denyTools: [],
    });
    const toolIds = tools.map((tool) => tool.id);

    expect(toolIds).toEqual([...ACPX_READONLY_BRIDGE_TOOL_IDS]);
    expect(toolIds).not.toContain("fased_generic_dispatch");
    expect(toolIds).not.toContain("exec");
    expect(toolIds).not.toContain("wallet.send");
    expect(tools.every((tool) => tool.readOnly)).toBe(true);
  });

  it("can restrict read-only-tools mode to implemented wrappers only", () => {
    const tools = resolveAcpxMcpBridgeToolDefinitions(
      {
        enabled: true,
        mode: "read-only-tools",
        allowTools: [],
        denyTools: [],
      },
      { implementedOnly: true },
    );

    expect(tools.map((tool) => tool.id)).toEqual([
      ACPX_STATUS_MCP_TOOL_NAME,
      "fased_gateway_identity",
      "fased_gateway_status",
      "fased_models_catalog_status",
      "fased_commands_list",
      "fased_acp_status",
    ]);
  });

  it("makes denyTools win over allowTools", () => {
    const bridgeConfig = {
      enabled: true,
      mode: "read-only-tools" as const,
      allowTools: [ACPX_STATUS_MCP_TOOL_NAME, "fased_gateway_identity"],
      denyTools: ["fased_gateway_identity"],
    };

    expect(isAcpxMcpBridgeToolAllowed(bridgeConfig, ACPX_STATUS_MCP_TOOL_NAME)).toBe(true);
    expect(isAcpxMcpBridgeToolAllowed(bridgeConfig, "fased_gateway_identity")).toBe(false);
    expect(resolveAcpxMcpBridgeToolDefinitions(bridgeConfig).map((tool) => tool.id)).toEqual([
      ACPX_STATUS_MCP_TOOL_NAME,
    ]);
  });

  it("ignores unknown allowlist entries instead of creating callable tools", () => {
    const tools = resolveAcpxMcpBridgeToolDefinitions({
      enabled: true,
      mode: "read-only-tools",
      allowTools: ["fased_unknown_tool"],
      denyTools: [],
    });

    expect(tools).toEqual([]);
  });

  it("rejects mutating, dangerous, duplicate, and generic dispatcher registrations", () => {
    expect(() =>
      createAcpxReadonlyBridgeToolRegistry([
        {
          id: "gateway.config.set",
          title: "Gateway Config Set",
          description: "Should never register.",
          implemented: false,
          readOnly: true,
        },
      ]),
    ).toThrow("blocked by read-only bridge policy");

    expect(() =>
      createAcpxReadonlyBridgeToolRegistry([
        {
          id: "fased_generic_dispatch",
          title: "Generic Dispatch",
          description: "Should never register.",
          implemented: false,
          readOnly: true,
          genericDispatcher: true,
        },
      ]),
    ).toThrow("generic dispatcher");

    expect(() =>
      createAcpxReadonlyBridgeToolRegistry([
        {
          id: "fased_status_mutating",
          title: "Mutating Status",
          description: "Should never register.",
          implemented: false,
          readOnly: true,
          mutates: true as never,
        },
      ]),
    ).toThrow("cannot mutate state");

    expect(() =>
      createAcpxReadonlyBridgeToolRegistry([
        {
          id: "fased_duplicate_status",
          title: "Duplicate Status",
          description: "First.",
          implemented: false,
          readOnly: true,
        },
        {
          id: "fased_duplicate_status",
          title: "Duplicate Status",
          description: "Duplicate.",
          implemented: false,
          readOnly: true,
        },
      ]),
    ).toThrow("duplicate ACPX read-only bridge tool id");
  });
});
