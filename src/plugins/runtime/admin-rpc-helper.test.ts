import { beforeEach, describe, expect, it, vi } from "vitest";
import { __testing as mutatingAdminRateLimitTesting } from "../../gateway/mutating-admin-rpc-rate-limit.js";
import type { GatewayClient, GatewayRequestContext } from "../../gateway/server-methods/types.js";
import { createPluginRuntime } from "./index.js";

const makeContext = () =>
  ({
    logGateway: {
      info: vi.fn(),
      warn: vi.fn(),
    },
  }) as unknown as GatewayRequestContext;

const makeOperatorClient = (scopes: string[] = ["operator.write"]): GatewayClient =>
  ({
    connId: "conn-test",
    clientIp: "127.0.0.1",
    connect: {
      role: "operator",
      scopes,
      client: { id: "operator-test" },
      device: { id: "device-test" },
    },
  }) as unknown as GatewayClient;

describe("plugin runtime admin RPC helpers", () => {
  beforeEach(() => {
    mutatingAdminRateLimitTesting.resetMutatingAdminRpcRateLimitState();
  });

  it("denies fixed admin RPC wrappers by default", async () => {
    const invokeAdminRpc = vi.fn();
    const adminRpcAudit = vi.fn();
    const runtime = createPluginRuntime({
      config: {},
      pluginId: "demo",
      source: { origin: "bundled" },
      invokeAdminRpc,
      adminRpcAudit,
    });

    await expect(
      runtime.helpers.adminRpc.pushTest(
        { nodeId: "ios-node" },
        { context: makeContext(), client: makeOperatorClient() },
      ),
    ).rejects.toThrow(/missing-runtime-admin-rpc-grant/);
    expect(invokeAdminRpc).not.toHaveBeenCalled();
    expect(adminRpcAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "push.test",
        outcome: "denied",
        denyReason: "missing-runtime-admin-rpc-grant",
      }),
    );
  });

  it("invokes an explicitly granted method for a trusted source and operator scope", async () => {
    const invokeAdminRpc = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      environment: "sandbox",
      tokenSuffix: "1234",
      topic: "com.fased.test",
    });
    const runtime = createPluginRuntime({
      config: {
        plugins: {
          entries: {
            demo: {
              runtime: {
                adminRpcActions: {
                  allow: [
                    {
                      method: "push.test",
                      sources: ["origin:bundled"],
                      requireOperatorApproval: true,
                    },
                  ],
                },
              },
            },
          },
        },
      },
      pluginId: "demo",
      source: { origin: "bundled" },
      invokeAdminRpc,
    });

    await expect(
      runtime.helpers.adminRpc.pushTest(
        { nodeId: "ios-node", title: "secret title", body: "secret body" },
        { context: makeContext(), client: makeOperatorClient() },
      ),
    ).resolves.toEqual({
      ok: true,
      status: 200,
      environment: "sandbox",
      tokenSuffix: "1234",
      topic: "com.fased.test",
    });
    expect(invokeAdminRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "push.test",
        params: { nodeId: "ios-node", title: "secret title", body: "secret body" },
      }),
    );
  });

  it("denies grants when the plugin source does not match the allowlist", async () => {
    const invokeAdminRpc = vi.fn();
    const runtime = createPluginRuntime({
      config: {
        plugins: {
          entries: {
            demo: {
              runtime: {
                adminRpcActions: {
                  allow: [
                    {
                      method: "push.test",
                      sources: ["origin:bundled"],
                      requireOperatorApproval: true,
                    },
                  ],
                },
              },
            },
          },
        },
      },
      pluginId: "demo",
      source: { origin: "workspace", source: "/tmp/demo-plugin/index.js" },
      invokeAdminRpc,
    });

    await expect(
      runtime.helpers.adminRpc.pushTest(
        { nodeId: "ios-node" },
        { context: makeContext(), client: makeOperatorClient() },
      ),
    ).rejects.toThrow(/source-not-allowlisted/);
    expect(invokeAdminRpc).not.toHaveBeenCalled();
  });

  it("denies operator contexts missing the core method scope", async () => {
    const invokeAdminRpc = vi.fn();
    const runtime = createPluginRuntime({
      config: {
        plugins: {
          entries: {
            demo: {
              runtime: {
                adminRpcActions: {
                  allow: [
                    {
                      method: "chat.inject",
                      sources: ["origin:bundled"],
                      requireOperatorApproval: true,
                    },
                  ],
                },
              },
            },
          },
        },
      },
      pluginId: "demo",
      source: { origin: "bundled" },
      invokeAdminRpc,
    });

    await expect(
      runtime.helpers.adminRpc.chatInject(
        { sessionKey: "agent:main:direct", message: "secret body" },
        { context: makeContext(), client: makeOperatorClient(["operator.read"]) },
      ),
    ).rejects.toThrow(/missing-scope:operator.admin/);
    expect(invokeAdminRpc).not.toHaveBeenCalled();
  });

  it("inherits mutating admin RPC rate limits", async () => {
    const invokeAdminRpc = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const runtime = createPluginRuntime({
      config: {
        plugins: {
          entries: {
            demo: {
              runtime: {
                adminRpcActions: {
                  allow: [
                    {
                      method: "push.test",
                      sources: ["origin:bundled"],
                      requireOperatorApproval: true,
                    },
                  ],
                },
              },
            },
          },
        },
      },
      pluginId: "demo",
      source: { origin: "bundled" },
      invokeAdminRpc,
    });
    const call = { context: makeContext(), client: makeOperatorClient() };

    await runtime.helpers.adminRpc.pushTest({ nodeId: "ios-node" }, call);
    await runtime.helpers.adminRpc.pushTest({ nodeId: "ios-node" }, call);
    await runtime.helpers.adminRpc.pushTest({ nodeId: "ios-node" }, call);
    await expect(runtime.helpers.adminRpc.pushTest({ nodeId: "ios-node" }, call)).rejects.toThrow(
      /rate-limited:3 per 60s/,
    );
    expect(invokeAdminRpc).toHaveBeenCalledTimes(3);
  });

  it("redacts web login start results down to status-only output", async () => {
    const invokeAdminRpc = vi.fn().mockResolvedValue({
      qrPayload: "secret-qr",
      token: "secret-token",
      cookie: "secret-cookie",
    });
    const runtime = createPluginRuntime({
      config: {
        plugins: {
          entries: {
            demo: {
              runtime: {
                adminRpcActions: {
                  allow: [
                    {
                      method: "web.login.start",
                      sources: ["origin:bundled"],
                      requireOperatorApproval: true,
                    },
                  ],
                },
              },
            },
          },
        },
      },
      pluginId: "demo",
      source: { origin: "bundled" },
      invokeAdminRpc,
    });

    await expect(
      runtime.helpers.adminRpc.webLoginStart(
        { accountId: "acct" },
        { context: makeContext(), client: makeOperatorClient(["operator.admin"]) },
      ),
    ).resolves.toEqual({ ok: true, started: true });
  });
});
