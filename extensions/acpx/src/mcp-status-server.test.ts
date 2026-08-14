import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FasedAgentPluginServiceContext } from "fased/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  ACPX_PUSH_TEST_METHOD,
  ACPX_PUSH_TEST_WRAPPER_ID,
  createAcpxPushTestRequestFingerprint,
  createAcpxPushTestSafeSummary,
  type AcpxPushTestApprovalContractRequest,
} from "../../../src/acp/acpx-push-test-approval-contract.js";
import type { AcpxPushTestExecutionAdapterResult } from "../../../src/acp/acpx-push-test-execution-adapter.js";
import type { ResolvedAcpxMcpBridgeConfig } from "./config.js";
import { ACPX_PUSH_TEST_REQUEST_MCP_TOOL_NAME } from "./mcp-mutating-tool-registry.js";
import {
  ACPX_ACP_STATUS_MCP_TOOL_NAME,
  ACPX_COMMANDS_LIST_MCP_TOOL_NAME,
  ACPX_GATEWAY_IDENTITY_MCP_TOOL_NAME,
  ACPX_GATEWAY_STATUS_MCP_TOOL_NAME,
  ACPX_MODELS_CATALOG_STATUS_MCP_TOOL_NAME,
} from "./mcp-readonly-tool-registry.js";
import {
  ACPX_STATUS_MCP_TOOL_NAME,
  createAcpxMcpStatusServer,
  type AcpxMcpEffectiveToolsPreviewResolver,
} from "./mcp-status-server.js";

function createBridgeConfig(
  overrides: Partial<ResolvedAcpxMcpBridgeConfig> = {},
): ResolvedAcpxMcpBridgeConfig {
  return {
    enabled: true,
    mode: "status-only",
    allowTools: [],
    denyTools: [],
    ...overrides,
  };
}

function createContext(): FasedAgentPluginServiceContext {
  return {
    config: {},
    workspaceDir: "/tmp/workspace",
    stateDir: "/tmp/state",
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
}

function firstTextContent(result: unknown): { type?: string; text?: string } | undefined {
  return (
    (result as { content?: unknown }).content as Array<{ type?: string; text?: string }> | undefined
  )?.[0];
}

function createPushTestRequest(
  overrides: Partial<AcpxPushTestApprovalContractRequest> = {},
): AcpxPushTestApprovalContractRequest {
  const params = overrides.params ?? {
    nodeId: "ios-node-1",
    title: "secret title",
    body: "secret body",
    environment: "sandbox",
  };
  const fingerprint = createAcpxPushTestRequestFingerprint({
    wrapperId: ACPX_PUSH_TEST_WRAPPER_ID,
    method: ACPX_PUSH_TEST_METHOD,
    params,
  });
  return {
    schemaVersion: 1,
    kind: "acpx.mutating-wrapper.push-test.execution.request",
    wrapperId: ACPX_PUSH_TEST_WRAPPER_ID,
    method: ACPX_PUSH_TEST_METHOD,
    dryRun: true,
    requestId: "req-push-1",
    createdAt: "2026-05-01T00:00:00.000Z",
    params,
    approval: {
      confirmation: "operator-confirmed",
      acceptedRequestFingerprint: fingerprint,
      operatorId: "operator-1",
      approvedAt: "2026-05-01T00:00:01.000Z",
    },
    gate: {
      gates: {
        "operator-scope": true,
        "operator-confirmation": true,
        "plugin-admin-rpc-grant": true,
        "plugin-source-allowlist": true,
        audit: true,
        "rate-limit": true,
        "gateway-token": true,
        "explicit-wrapper-enable": true,
      },
      allowWrappers: [ACPX_PUSH_TEST_WRAPPER_ID],
    },
    ...overrides,
  };
}

function createPushTestExecutionResult(
  request: AcpxPushTestApprovalContractRequest,
): AcpxPushTestExecutionAdapterResult {
  const fingerprint = createAcpxPushTestRequestFingerprint({
    wrapperId: request.wrapperId,
    method: request.method,
    params: request.params,
  });
  const safeSummary = createAcpxPushTestSafeSummary(request.params);
  return {
    schemaVersion: 1,
    kind: "acpx.mutating-wrapper.push-test.execution.result",
    wrapperId: ACPX_PUSH_TEST_WRAPPER_ID,
    method: ACPX_PUSH_TEST_METHOD,
    requestId: request.requestId,
    status: "executed",
    executionPerformed: true,
    noGenericDispatcher: true,
    contract: {
      schemaVersion: 1,
      kind: "acpx.mutating-wrapper.push-test.execution.response",
      wrapperId: ACPX_PUSH_TEST_WRAPPER_ID,
      method: ACPX_PUSH_TEST_METHOD,
      dryRun: true,
      noExecutionPerformed: true,
      requestId: request.requestId,
      createdAt: request.createdAt,
      status: "admitted",
      stage: "admitted",
      requestFingerprint: fingerprint,
      reasons: [],
      safeSummary,
    },
    reasons: [],
    safeSummary,
    result: {
      ok: true,
      status: 200,
      environment: request.params.environment,
      tokenSuffix: "1234abcd",
      topic: "ai.fased.ios",
    },
  };
}

describe("createAcpxMcpStatusServer", () => {
  it("registers fased_tools_effective as the only status tool", async () => {
    const previewResolver: AcpxMcpEffectiveToolsPreviewResolver = vi.fn(() => ({
      agentId: "main",
      profile: "full",
      groups: [
        {
          id: "core",
          label: "Built-in tools",
          source: "core",
          tools: [
            {
              id: "session_status",
              label: "Session Status",
              description: "Inspect session state.",
              rawDescription: "raw prompt text must not leak",
              source: "core",
            },
          ],
        },
      ],
    }));

    const server = createAcpxMcpStatusServer({
      bridgeConfig: createBridgeConfig(),
      context: createContext(),
      effectiveToolsPreviewResolver: previewResolver,
    });

    expect(server.toolNames).toEqual([ACPX_STATUS_MCP_TOOL_NAME]);
    const preview = await server.previewEffectiveTools({ agentId: " support " });

    expect(preview).toEqual({
      bridge: {
        id: "acpx",
        mode: "status-only",
        enabled: true,
      },
      agentId: "main",
      profile: "full",
      groups: [
        {
          id: "core",
          label: "Built-in tools",
          source: "core",
          tools: [
            {
              id: "session_status",
              label: "Session Status",
              description: "Inspect session state.",
              source: "core",
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(preview)).not.toContain("rawDescription");
    expect(previewResolver).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "support",
      }),
    );

    await server.close();
  });

  it("honors allow and deny lists for the status tool", async () => {
    const context = createContext();
    const resolver: AcpxMcpEffectiveToolsPreviewResolver = () => ({
      agentId: "main",
      profile: "full",
      groups: [],
    });

    const allowMiss = createAcpxMcpStatusServer({
      bridgeConfig: createBridgeConfig({ allowTools: ["other_tool"] }),
      context,
      effectiveToolsPreviewResolver: resolver,
    });
    expect(allowMiss.toolNames).toEqual([]);
    await allowMiss.close();

    const denied = createAcpxMcpStatusServer({
      bridgeConfig: createBridgeConfig({
        allowTools: [ACPX_STATUS_MCP_TOOL_NAME],
        denyTools: [ACPX_STATUS_MCP_TOOL_NAME],
      }),
      context,
      effectiveToolsPreviewResolver: resolver,
    });
    expect(denied.toolNames).toEqual([]);
    await denied.close();
  });

  it("does not expose generic dispatch or dangerous wrapper tools", async () => {
    const server = createAcpxMcpStatusServer({
      bridgeConfig: createBridgeConfig({
        allowTools: [
          ACPX_STATUS_MCP_TOOL_NAME,
          "exec",
          "shell",
          "gateway.config.set",
          "fased_wallet_send",
          "fased_generic_dispatch",
        ],
      }),
      context: createContext(),
      effectiveToolsPreviewResolver: () => ({
        agentId: "main",
        profile: "full",
        groups: [],
      }),
    });

    expect(server.toolNames).toEqual([ACPX_STATUS_MCP_TOOL_NAME]);
    const endpoint = await server.startEndpoint();
    const transport = new StreamableHTTPClientTransport(new URL(endpoint.url), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${endpoint.token}`,
        },
      },
    });
    const client = new Client({ name: "fased-acpx-policy-test", version: "1.0.0" });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      const toolNames = tools.tools.map((tool) => tool.name);

      expect(toolNames).toEqual([ACPX_STATUS_MCP_TOOL_NAME]);
      expect(toolNames).not.toContain("exec");
      expect(toolNames).not.toContain("shell");
      expect(toolNames).not.toContain("gateway.config.set");
      expect(toolNames).not.toContain("fased_wallet_send");
      expect(toolNames).not.toContain("fased_generic_dispatch");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("starts read-only-tools mode with implemented fixed wrappers only", async () => {
    const server = createAcpxMcpStatusServer({
      bridgeConfig: createBridgeConfig({
        enabled: true,
        mode: "read-only-tools",
        allowTools: [
          ACPX_STATUS_MCP_TOOL_NAME,
          ACPX_GATEWAY_IDENTITY_MCP_TOOL_NAME,
          ACPX_GATEWAY_STATUS_MCP_TOOL_NAME,
          ACPX_MODELS_CATALOG_STATUS_MCP_TOOL_NAME,
          ACPX_COMMANDS_LIST_MCP_TOOL_NAME,
          ACPX_ACP_STATUS_MCP_TOOL_NAME,
        ],
        denyTools: [],
      }),
      context: createContext(),
      effectiveToolsPreviewResolver: () => ({
        agentId: "main",
        profile: "full",
        groups: [],
      }),
      gatewayIdentityResolver: () => ({
        deviceId: "device-123",
        publicKey: "public-key-raw",
        privateKey: "PRIVATE-KEY" as never,
      }),
      gatewayStatusResolver: () => ({
        gatewayStartup: {
          entries: [
            {
              name: "config",
              durationMs: 12.8,
            },
          ],
          totalMs: 21,
          summary: "config=13ms, total=21ms",
          recordedAtMs: 12345,
        },
        linkChannel: {
          id: "telegram",
          label: "Telegram",
          linked: true,
          authAgeMs: 5000,
        },
        heartbeat: {
          defaultAgentId: "main",
          agents: [
            {
              agentId: "main",
              enabled: true,
              every: "10m",
              everyMs: 600000,
            },
          ],
        },
        channelSummary: ["Telegram: configured"],
        queuedSystemEvents: ["SECRET queued event text"],
        sessions: {
          paths: ["/secret/local/path/sessions.json"],
          count: 2,
          defaults: {
            model: "openrouter/test-model",
            contextTokens: 32000,
          },
          recent: [
            {
              key: "telegram:secret-sender",
              sessionId: "secret-session-id",
            },
          ],
          byAgent: [
            {
              agentId: "main",
              path: "/secret/local/path/main.json",
              count: 2,
              recent: [
                {
                  key: "agent:main:secret",
                },
              ],
            },
          ],
        },
      }),
      modelsCatalogStatusResolver: () => ({
        totalProviders: 2,
        totalModels: 3,
        configuredProviders: 1,
        availableProviders: 1,
        reasoningModels: 1,
        visionModels: 1,
        sourceCounts: {
          "current-preview": 1,
          "provider-index": 1,
          configured: 1,
          ignored: "not-a-number",
        },
        providers: [
          {
            provider: "openai",
            totalModels: 2,
            configured: true,
            reasoningModels: 1,
            visionModels: 1,
            sources: ["configured", "current-preview"],
            baseUrl: "https://secret.example/v1",
          },
          {
            provider: "qwen-portal",
            totalModels: 1,
            configured: false,
            reasoningModels: 0,
            visionModels: 0,
            sources: ["provider-index"],
          },
        ],
        apiKey: "SECRET_API_KEY",
      }),
      commandsListResolver: (params) => ({
        commands: [
          {
            name: params.provider === "discord" ? "set_model" : "model",
            nativeName: "model",
            textAliases: ["/model", "/m"],
            description: "Set model",
            category: "options",
            source: "native",
            scope: "both",
            acceptsArgs: true,
            args: params.includeArgs
              ? [
                  {
                    name: "model",
                    description: "Model identifier",
                    type: "string",
                    required: true,
                    choices: [
                      {
                        value: "gpt-5.2",
                        label: "GPT-5.2",
                      },
                    ],
                    rawSecret: "SHOULD_NOT_LEAK",
                  },
                ]
              : undefined,
            rawPrompt: "SHOULD_NOT_LEAK",
          },
          {
            name: "commands",
            textAliases: ["/commands"],
            description: "List commands",
            source: "native",
            scope: "text",
            acceptsArgs: false,
          },
        ],
      }),
      acpStatusResolver: (params) => ({
        policy: {
          enabled: true,
          dispatchEnabled: false,
          backend: "acpx",
          defaultAgent: "codex",
          allowedAgents: ["support", "codex"],
          maxConcurrentSessions: 3,
        },
        runtimeBackend: {
          requestedId: "acpx",
          registered: true,
          selectedId: "acpx",
          healthy: true,
        },
        manager: {
          runtimeCache: {
            activeSessions: 1,
            idleTtlMs: 60000,
            evictedTotal: 2,
            lastEvictedAt: 2222,
          },
          turns: {
            active: 0,
            queueDepth: 1,
            completed: 5,
            failed: 1,
            averageLatencyMs: 123,
            maxLatencyMs: 456,
          },
          errorsByCode: {
            ACP_TURN_FAILED: 1,
            ignored: "not-a-number",
          },
        },
        sessions: {
          total: 1,
          returned: 1,
          limit: params.limit,
          items: [
            {
              sessionKey: "agent:codex:acp:demo",
              backend: "acpx",
              agent: "codex",
              mode: "persistent",
              state: "idle",
              lastActivityAt: 1234,
              identity: {
                state: "resolved",
                source: "status",
                acpxRecordId: "rec-1",
                acpxSessionId: "sid-1",
                agentSessionId: "inner-1",
                lastUpdatedAt: 1200,
              },
              runtimeOptions: {
                runtimeMode: "plan",
                model: "openai-codex/gpt-5.3-codex",
                permissionProfile: "read-only",
                timeoutSeconds: 30,
                backendExtrasKeys: ["model"],
                cwdConfigured: true,
                cwd: "/secret/local/path",
              },
              cwd: "/secret/local/path",
            },
          ],
        },
      }),
    });

    expect(server.toolNames).toEqual([
      ACPX_STATUS_MCP_TOOL_NAME,
      ACPX_GATEWAY_IDENTITY_MCP_TOOL_NAME,
      ACPX_GATEWAY_STATUS_MCP_TOOL_NAME,
      ACPX_MODELS_CATALOG_STATUS_MCP_TOOL_NAME,
      ACPX_COMMANDS_LIST_MCP_TOOL_NAME,
      ACPX_ACP_STATUS_MCP_TOOL_NAME,
    ]);
    const preview = await server.previewEffectiveTools();
    expect(preview.bridge.mode).toBe("read-only-tools");
    const gatewayStatusPreview = await server.previewGatewayStatus();
    expect(gatewayStatusPreview).toMatchObject({
      source: "status",
      gatewayStartup: {
        entries: [
          {
            name: "config",
            durationMs: 12,
          },
        ],
        totalMs: 21,
      },
      linkChannel: {
        id: "telegram",
        linked: true,
      },
      heartbeat: {
        defaultAgentId: "main",
        agents: [
          {
            agentId: "main",
            enabled: true,
            every: "10m",
            everyMs: 600000,
          },
        ],
      },
      channelSummary: ["Telegram: configured"],
      queuedSystemEventsCount: 1,
      sessions: {
        count: 2,
        defaults: {
          model: "openrouter/test-model",
          contextTokens: 32000,
        },
        byAgent: [
          {
            agentId: "main",
            count: 2,
          },
        ],
      },
    });
    expect(JSON.stringify(gatewayStatusPreview)).not.toContain("/secret");
    expect(JSON.stringify(gatewayStatusPreview)).not.toContain("secret-sender");
    expect(JSON.stringify(gatewayStatusPreview)).not.toContain("SECRET queued event text");
    const modelsCatalogPreview = await server.previewModelsCatalogStatus();
    expect(modelsCatalogPreview).toMatchObject({
      source: "models.catalog.status",
      totalProviders: 2,
      totalModels: 3,
      configuredProviders: 1,
      availableProviders: 1,
      reasoningModels: 1,
      visionModels: 1,
      sourceCounts: {
        "current-preview": 1,
        "provider-index": 1,
        configured: 1,
      },
      providers: [
        {
          provider: "openai",
          totalModels: 2,
          configured: true,
          reasoningModels: 1,
          visionModels: 1,
          sources: ["configured", "current-preview"],
        },
        {
          provider: "qwen-portal",
          totalModels: 1,
          configured: false,
          reasoningModels: 0,
          visionModels: 0,
          sources: ["provider-index"],
        },
      ],
    });
    expect(JSON.stringify(modelsCatalogPreview)).not.toContain("SECRET_API_KEY");
    expect(JSON.stringify(modelsCatalogPreview)).not.toContain("secret.example");
    const commandsPreview = await server.previewCommandsList({
      agentId: "support",
      provider: "discord",
      scope: "text",
      includeArgs: false,
    });
    expect(commandsPreview).toMatchObject({
      source: "commands.list",
      agentId: "support",
      provider: "discord",
      scope: "text",
      includeArgs: false,
      commands: [
        {
          name: "set_model",
          nativeName: "model",
          source: "native",
          scope: "both",
          acceptsArgs: true,
        },
        {
          name: "commands",
          source: "native",
          scope: "text",
          acceptsArgs: false,
        },
      ],
    });
    expect(JSON.stringify(commandsPreview)).not.toContain("SHOULD_NOT_LEAK");
    const acpPreview = await server.previewAcpStatus({ limit: 1 });
    expect(acpPreview).toMatchObject({
      source: "acp.status",
      policy: {
        backend: "acpx",
        allowedAgents: ["codex", "support"],
      },
      runtimeBackend: {
        requestedId: "acpx",
        registered: true,
        selectedId: "acpx",
        healthy: true,
      },
      manager: {
        errorsByCode: {
          ACP_TURN_FAILED: 1,
        },
      },
      sessions: {
        total: 1,
        returned: 1,
        limit: 1,
      },
    });
    expect(acpPreview.sessions.items[0]?.runtimeOptions.cwdConfigured).toBe(true);
    expect(JSON.stringify(acpPreview)).not.toContain("/secret");

    const endpoint = await server.startEndpoint();
    expect(endpoint.mode).toBe("read-only-tools");
    expect(endpoint.toolNames).toEqual([
      ACPX_STATUS_MCP_TOOL_NAME,
      ACPX_GATEWAY_IDENTITY_MCP_TOOL_NAME,
      ACPX_GATEWAY_STATUS_MCP_TOOL_NAME,
      ACPX_MODELS_CATALOG_STATUS_MCP_TOOL_NAME,
      ACPX_COMMANDS_LIST_MCP_TOOL_NAME,
      ACPX_ACP_STATUS_MCP_TOOL_NAME,
    ]);
    const transport = new StreamableHTTPClientTransport(new URL(endpoint.url), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${endpoint.token}`,
        },
      },
    });
    const client = new Client({ name: "fased-acpx-readonly-test", version: "1.0.0" });
    try {
      await client.connect(transport);
      const tools = await client.listTools();

      expect(tools.tools.map((tool) => tool.name)).toEqual([
        ACPX_STATUS_MCP_TOOL_NAME,
        ACPX_GATEWAY_IDENTITY_MCP_TOOL_NAME,
        ACPX_GATEWAY_STATUS_MCP_TOOL_NAME,
        ACPX_MODELS_CATALOG_STATUS_MCP_TOOL_NAME,
        ACPX_COMMANDS_LIST_MCP_TOOL_NAME,
        ACPX_ACP_STATUS_MCP_TOOL_NAME,
      ]);
      const result = await client.callTool({
        name: ACPX_STATUS_MCP_TOOL_NAME,
        arguments: {},
      });
      const content = firstTextContent(result);
      expect(content?.type).toBe("text");
      const parsed = JSON.parse(String(content?.text));
      expect(parsed.bridge.mode).toBe("read-only-tools");

      const identityResult = await client.callTool({
        name: ACPX_GATEWAY_IDENTITY_MCP_TOOL_NAME,
        arguments: {},
      });
      const identityContent = firstTextContent(identityResult);
      expect(identityContent?.type).toBe("text");
      const identityParsed = JSON.parse(String(identityContent?.text));
      expect(identityParsed).toEqual({
        bridge: {
          id: "acpx",
          mode: "read-only-tools",
          enabled: true,
        },
        source: "gateway.identity.get",
        gateway: {
          deviceId: "device-123",
          publicKey: "public-key-raw",
        },
      });
      expect(JSON.stringify(identityParsed)).not.toContain("PRIVATE");

      const gatewayStatusResult = await client.callTool({
        name: ACPX_GATEWAY_STATUS_MCP_TOOL_NAME,
        arguments: {},
      });
      const gatewayStatusContent = firstTextContent(gatewayStatusResult);
      expect(gatewayStatusContent?.type).toBe("text");
      const gatewayStatusParsed = JSON.parse(String(gatewayStatusContent?.text));
      expect(gatewayStatusParsed).toMatchObject({
        bridge: {
          id: "acpx",
          mode: "read-only-tools",
          enabled: true,
        },
        source: "status",
        queuedSystemEventsCount: 1,
        sessions: {
          count: 2,
          byAgent: [
            {
              agentId: "main",
              count: 2,
            },
          ],
        },
      });
      expect(JSON.stringify(gatewayStatusParsed)).not.toContain("/secret");
      expect(JSON.stringify(gatewayStatusParsed)).not.toContain("secret-sender");
      expect(JSON.stringify(gatewayStatusParsed)).not.toContain("SECRET queued event text");

      const modelsCatalogResult = await client.callTool({
        name: ACPX_MODELS_CATALOG_STATUS_MCP_TOOL_NAME,
        arguments: {},
      });
      const modelsCatalogContent = firstTextContent(modelsCatalogResult);
      expect(modelsCatalogContent?.type).toBe("text");
      const modelsCatalogParsed = JSON.parse(String(modelsCatalogContent?.text));
      expect(modelsCatalogParsed).toMatchObject({
        bridge: {
          id: "acpx",
          mode: "read-only-tools",
          enabled: true,
        },
        source: "models.catalog.status",
        totalProviders: 2,
        totalModels: 3,
        configuredProviders: 1,
        availableProviders: 1,
        providers: [
          {
            provider: "openai",
            totalModels: 2,
            configured: true,
            sources: ["configured", "current-preview"],
          },
          {
            provider: "qwen-portal",
            totalModels: 1,
            configured: false,
            sources: ["provider-index"],
          },
        ],
      });
      expect(modelsCatalogParsed.sourceCounts).toEqual({
        "current-preview": 1,
        "provider-index": 1,
        configured: 1,
      });
      expect(JSON.stringify(modelsCatalogParsed)).not.toContain("SECRET_API_KEY");
      expect(JSON.stringify(modelsCatalogParsed)).not.toContain("secret.example");

      const commandsResult = await client.callTool({
        name: ACPX_COMMANDS_LIST_MCP_TOOL_NAME,
        arguments: {
          provider: "discord",
          scope: "text",
          includeArgs: false,
        },
      });
      const commandsContent = firstTextContent(commandsResult);
      expect(commandsContent?.type).toBe("text");
      const commandsParsed = JSON.parse(String(commandsContent?.text));
      expect(commandsParsed).toMatchObject({
        bridge: {
          id: "acpx",
          mode: "read-only-tools",
          enabled: true,
        },
        source: "commands.list",
        agentId: "main",
        provider: "discord",
        scope: "text",
        includeArgs: false,
      });
      expect(commandsParsed.commands.map((command: { name: string }) => command.name)).toEqual([
        "set_model",
        "commands",
      ]);
      expect(JSON.stringify(commandsParsed)).not.toContain("SHOULD_NOT_LEAK");

      const acpResult = await client.callTool({
        name: ACPX_ACP_STATUS_MCP_TOOL_NAME,
        arguments: {
          limit: 1,
        },
      });
      const acpContent = firstTextContent(acpResult);
      expect(acpContent?.type).toBe("text");
      const acpParsed = JSON.parse(String(acpContent?.text));
      expect(acpParsed).toMatchObject({
        bridge: {
          id: "acpx",
          mode: "read-only-tools",
          enabled: true,
        },
        source: "acp.status",
        policy: {
          enabled: true,
          backend: "acpx",
          defaultAgent: "codex",
          allowedAgents: ["codex", "support"],
        },
        runtimeBackend: {
          requestedId: "acpx",
          registered: true,
          selectedId: "acpx",
          healthy: true,
        },
        sessions: {
          total: 1,
          returned: 1,
          limit: 1,
        },
      });
      expect(acpParsed.manager.errorsByCode).toEqual({
        ACP_TURN_FAILED: 1,
      });
      expect(acpParsed.sessions.items[0].runtimeOptions.cwdConfigured).toBe(true);
      expect(JSON.stringify(acpParsed)).not.toContain("/secret");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("registers the fixed push-test MCP tool only in explicit operator-approved mutating mode", async () => {
    const pushTestExecutionAdapter = vi.fn(({ request }) => createPushTestExecutionResult(request));
    const server = createAcpxMcpStatusServer({
      bridgeConfig: createBridgeConfig({
        enabled: true,
        mode: "operator-approved-mutating-tools",
        allowTools: [ACPX_PUSH_TEST_REQUEST_MCP_TOOL_NAME],
      }),
      context: createContext(),
      pushTestExecutionAdapter,
    });

    expect(server.toolNames).toEqual([ACPX_PUSH_TEST_REQUEST_MCP_TOOL_NAME]);
    const request = createPushTestRequest();
    const directResult = await server.executePushTestRequest(request);
    expect(directResult).toMatchObject({
      wrapperId: ACPX_PUSH_TEST_WRAPPER_ID,
      method: "push.test",
      status: "executed",
      executionPerformed: true,
      noGenericDispatcher: true,
    });

    const endpoint = await server.startEndpoint();
    expect(endpoint.mode).toBe("operator-approved-mutating-tools");
    expect(endpoint.toolNames).toEqual([ACPX_PUSH_TEST_REQUEST_MCP_TOOL_NAME]);
    const unauthorized = await fetch(endpoint.url, { method: "POST" });
    expect(unauthorized.status).toBe(401);
    expect(pushTestExecutionAdapter).toHaveBeenCalledTimes(1);

    const transport = new StreamableHTTPClientTransport(new URL(endpoint.url), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${endpoint.token}`,
        },
      },
    });
    const client = new Client({ name: "fased-acpx-push-test", version: "1.0.0" });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual([ACPX_PUSH_TEST_REQUEST_MCP_TOOL_NAME]);
      const result = await client.callTool({
        name: ACPX_PUSH_TEST_REQUEST_MCP_TOOL_NAME,
        arguments: request,
      });
      const content = firstTextContent(result);
      expect(content?.type).toBe("text");
      const parsed = JSON.parse(String(content?.text));
      expect(parsed).toMatchObject({
        wrapperId: ACPX_PUSH_TEST_WRAPPER_ID,
        method: "push.test",
        status: "executed",
        executionPerformed: true,
        noGenericDispatcher: true,
        result: {
          ok: true,
          status: 200,
          environment: "sandbox",
          tokenSuffix: "1234abcd",
          topic: "ai.fased.ios",
        },
      });
      expect(JSON.stringify(parsed)).not.toContain("secret title");
      expect(JSON.stringify(parsed)).not.toContain("secret body");
      expect(pushTestExecutionAdapter).toHaveBeenCalledTimes(2);
      expect(pushTestExecutionAdapter).toHaveBeenLastCalledWith({ request });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("keeps the push-test MCP tool closed without mutating mode and explicit allowlist", async () => {
    const pushTestExecutionAdapter = vi.fn(({ request }) => createPushTestExecutionResult(request));
    const readOnlyServer = createAcpxMcpStatusServer({
      bridgeConfig: createBridgeConfig({
        enabled: true,
        mode: "read-only-tools",
        allowTools: [ACPX_PUSH_TEST_REQUEST_MCP_TOOL_NAME],
      }),
      context: createContext(),
      pushTestExecutionAdapter,
    });
    expect(readOnlyServer.toolNames).toEqual([]);
    await readOnlyServer.close();

    const missingAllow = createAcpxMcpStatusServer({
      bridgeConfig: createBridgeConfig({
        enabled: true,
        mode: "operator-approved-mutating-tools",
        allowTools: [],
      }),
      context: createContext(),
      pushTestExecutionAdapter,
    });
    expect(missingAllow.toolNames).not.toContain(ACPX_PUSH_TEST_REQUEST_MCP_TOOL_NAME);
    await expect(missingAllow.executePushTestRequest(createPushTestRequest())).rejects.toThrow(
      "not enabled",
    );
    await missingAllow.close();

    const denied = createAcpxMcpStatusServer({
      bridgeConfig: createBridgeConfig({
        enabled: true,
        mode: "operator-approved-mutating-tools",
        allowTools: [ACPX_PUSH_TEST_REQUEST_MCP_TOOL_NAME],
        denyTools: [ACPX_PUSH_TEST_REQUEST_MCP_TOOL_NAME],
      }),
      context: createContext(),
      pushTestExecutionAdapter,
    });
    expect(denied.toolNames).not.toContain(ACPX_PUSH_TEST_REQUEST_MCP_TOOL_NAME);
    await denied.close();
    expect(pushTestExecutionAdapter).not.toHaveBeenCalled();
  });

  it("fails closed for disabled or broader bridge modes", () => {
    expect(() =>
      createAcpxMcpStatusServer({
        bridgeConfig: createBridgeConfig({ enabled: false }),
        context: createContext(),
      }),
    ).toThrow("mcpBridge.enabled=true");

    expect(() =>
      createAcpxMcpStatusServer({
        bridgeConfig: createBridgeConfig({ mode: "mutating-tools" as never }),
        context: createContext(),
      }),
    ).toThrow("unsupported ACPX MCP bridge mode");
  });

  it("rejects preview calls after disposal", async () => {
    const server = createAcpxMcpStatusServer({
      bridgeConfig: createBridgeConfig(),
      context: createContext(),
      effectiveToolsPreviewResolver: () => ({
        agentId: "main",
        profile: "full",
        groups: [],
      }),
    });

    await server.close();

    expect(server.isClosed()).toBe(true);
    await expect(server.previewEffectiveTools()).rejects.toThrow("closed");
  });

  it("requires the endpoint bearer token before any MCP request is handled", async () => {
    const server = createAcpxMcpStatusServer({
      bridgeConfig: createBridgeConfig(),
      context: createContext(),
      effectiveToolsPreviewResolver: () => ({
        agentId: "main",
        profile: "full",
        groups: [],
      }),
    });
    const endpoint = await server.startEndpoint();

    try {
      const missing = await fetch(endpoint.url, { method: "POST" });
      expect(missing.status).toBe(401);

      const wrong = await fetch(endpoint.url, {
        method: "POST",
        headers: {
          Authorization: "Bearer wrong-token",
        },
      });
      expect(wrong.status).toBe(401);
    } finally {
      await server.close();
    }
  });

  it("serves the status tool over a loopback MCP endpoint with a capability token", async () => {
    const previewResolver: AcpxMcpEffectiveToolsPreviewResolver = vi.fn(() => ({
      agentId: "main",
      profile: "full",
      groups: [
        {
          id: "core",
          label: "Built-in tools",
          source: "core",
          tools: [
            {
              id: "session_status",
              label: "Session Status",
              description: "Inspect session state.",
              rawDescription: "raw prompt text must not leak",
              source: "core",
            },
          ],
        },
      ],
    }));
    const server = createAcpxMcpStatusServer({
      bridgeConfig: createBridgeConfig(),
      context: createContext(),
      effectiveToolsPreviewResolver: previewResolver,
    });
    const endpoint = await server.startEndpoint();

    expect(endpoint.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(endpoint.token.length).toBeGreaterThan(20);
    expect(endpoint.toolNames).toEqual([ACPX_STATUS_MCP_TOOL_NAME]);
    expect(endpoint.mode).toBe("status-only");
    expect(server.getEndpoint()).toEqual(endpoint);

    const unauth = await fetch(endpoint.url, { method: "POST" });
    expect(unauth.status).toBe(401);

    const transport = new StreamableHTTPClientTransport(new URL(endpoint.url), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${endpoint.token}`,
        },
      },
    });
    const client = new Client({ name: "fased-acpx-status-test", version: "1.0.0" });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual([ACPX_STATUS_MCP_TOOL_NAME]);

      const result = await client.callTool({
        name: ACPX_STATUS_MCP_TOOL_NAME,
        arguments: { agentId: "support" },
      });
      const content = firstTextContent(result);
      expect(content?.type).toBe("text");
      const parsed = JSON.parse(String(content?.text));
      expect(parsed.bridge.mode).toBe("status-only");
      expect(parsed.agentId).toBe("main");
      expect(JSON.stringify(parsed)).not.toContain("rawDescription");
      expect(previewResolver).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "support",
        }),
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
});
