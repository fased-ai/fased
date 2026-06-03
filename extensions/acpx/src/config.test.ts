import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ACPX_BUNDLED_BIN,
  createAcpxPluginConfigSchema,
  resolveAcpxPluginConfig,
} from "./config.js";

describe("acpx plugin config parsing", () => {
  it("resolves a strict plugin-local acpx command", () => {
    const resolved = resolveAcpxPluginConfig({
      rawConfig: {
        cwd: "/tmp/workspace",
      },
      workspaceDir: "/tmp/workspace",
    });

    expect(resolved.command).toBe(ACPX_BUNDLED_BIN);
    expect(resolved.cwd).toBe(path.resolve("/tmp/workspace"));
    expect(resolved.mcpBridge).toEqual({
      enabled: false,
      mode: "status-only",
      allowTools: [],
      denyTools: [],
    });
  });

  it("parses strict Fased-owned MCP bridge config without enabling it by default", () => {
    const resolved = resolveAcpxPluginConfig({
      rawConfig: {
        mcpBridge: {
          mode: "read-only-tools",
          allowTools: [" fased_tools_effective ", "fased_gateway_identity"],
          denyTools: ["exec", "exec"],
        },
      },
      workspaceDir: "/tmp/workspace",
    });

    expect(resolved.mcpBridge).toEqual({
      enabled: false,
      mode: "read-only-tools",
      allowTools: ["fased_tools_effective", "fased_gateway_identity"],
      denyTools: ["exec"],
    });
  });

  it("accepts explicit MCP bridge enablement without adding a bridge process", () => {
    const resolved = resolveAcpxPluginConfig({
      rawConfig: {
        mcpBridge: {
          enabled: true,
          mode: "status-only",
        },
      },
      workspaceDir: "/tmp/workspace",
    });

    expect(resolved.mcpBridge).toEqual({
      enabled: true,
      mode: "status-only",
      allowTools: [],
      denyTools: [],
    });
  });

  it("accepts the explicit operator-approved mutating bridge mode", () => {
    const resolved = resolveAcpxPluginConfig({
      rawConfig: {
        mcpBridge: {
          enabled: true,
          mode: "operator-approved-mutating-tools",
          allowTools: ["fased_push_test_request"],
        },
      },
      workspaceDir: "/tmp/workspace",
    });

    expect(resolved.mcpBridge).toEqual({
      enabled: true,
      mode: "operator-approved-mutating-tools",
      allowTools: ["fased_push_test_request"],
      denyTools: [],
    });
  });

  it("rejects command overrides", () => {
    expect(() =>
      resolveAcpxPluginConfig({
        rawConfig: {
          command: "acpx-custom",
        },
        workspaceDir: "/tmp/workspace",
      }),
    ).toThrow("unknown config key: command");
  });

  it("rejects commandArgs overrides", () => {
    expect(() =>
      resolveAcpxPluginConfig({
        rawConfig: {
          commandArgs: ["--foo"],
        },
        workspaceDir: "/tmp/workspace",
      }),
    ).toThrow("unknown config key: commandArgs");
  });

  it("rejects upstream-style ACPX MCP bridge fields", () => {
    expect(() =>
      resolveAcpxPluginConfig({
        rawConfig: {
          mcpServers: [{ name: "caller-supplied", command: "node" }],
        },
        workspaceDir: "/tmp/workspace",
      }),
    ).toThrow("unknown config key: mcpServers");
  });

  it("rejects CLI MCP escape hatches and mutating bridge wrappers", () => {
    expect(() =>
      resolveAcpxPluginConfig({
        rawConfig: {
          mcpConfigPath: "/tmp/mcp.json",
        },
        workspaceDir: "/tmp/workspace",
      }),
    ).toThrow("unknown config key: mcpConfigPath");

    expect(() =>
      resolveAcpxPluginConfig({
        rawConfig: {
          cliMcp: true,
        },
        workspaceDir: "/tmp/workspace",
      }),
    ).toThrow("unknown config key: cliMcp");

    expect(() =>
      resolveAcpxPluginConfig({
        rawConfig: {
          mcpBridge: {
            command: "node",
          },
        },
        workspaceDir: "/tmp/workspace",
      }),
    ).toThrow("unknown mcpBridge config key: command");

    expect(() =>
      resolveAcpxPluginConfig({
        rawConfig: {
          mcpBridge: {
            wrappers: ["gateway.config.set"],
          },
        },
        workspaceDir: "/tmp/workspace",
      }),
    ).toThrow("unknown mcpBridge config key: wrappers");
  });

  it("rejects unknown nested MCP bridge fields", () => {
    expect(() =>
      resolveAcpxPluginConfig({
        rawConfig: {
          mcpBridge: {
            servers: {
              unsafe: {
                command: "node",
              },
            },
          },
        },
        workspaceDir: "/tmp/workspace",
      }),
    ).toThrow("unknown mcpBridge config key: servers");
  });

  it("rejects invalid MCP bridge options", () => {
    expect(() =>
      resolveAcpxPluginConfig({
        rawConfig: {
          mcpBridge: {
            enabled: "yes",
          },
        },
        workspaceDir: "/tmp/workspace",
      }),
    ).toThrow("mcpBridge.enabled must be a boolean");
    expect(() =>
      resolveAcpxPluginConfig({
        rawConfig: {
          mcpBridge: {
            mode: "mutating-tools",
          },
        },
        workspaceDir: "/tmp/workspace",
      }),
    ).toThrow("mcpBridge.mode must be one of");
    expect(() =>
      resolveAcpxPluginConfig({
        rawConfig: {
          mcpBridge: {
            allowTools: ["ok", ""],
          },
        },
        workspaceDir: "/tmp/workspace",
      }),
    ).toThrow("mcpBridge.allowTools must be an array of non-empty strings");
  });

  it("schema rejects empty cwd", () => {
    const schema = createAcpxPluginConfigSchema();
    if (!schema.safeParse) {
      throw new Error("acpx config schema missing safeParse");
    }
    const parsed = schema.safeParse({ cwd: "   " });

    expect(parsed.success).toBe(false);
  });

  it("schema accepts only the Fased MCP bridge shape", () => {
    const schema = createAcpxPluginConfigSchema();
    if (!schema.safeParse) {
      throw new Error("acpx config schema missing safeParse");
    }
    expect(
      schema.safeParse({
        mcpBridge: {
          enabled: false,
          mode: "status-only",
          allowTools: ["fased_tools_effective"],
          denyTools: ["exec"],
        },
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        mcpBridge: {
          servers: {},
        },
      }).success,
    ).toBe(false);
  });
});
