import type { AcpRuntime, FasedAgentPluginServiceContext } from "fased/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AcpRuntimeError } from "../../../src/acp/runtime/errors.js";
import {
  __testing,
  getAcpRuntimeBackend,
  requireAcpRuntimeBackend,
} from "../../../src/acp/runtime/registry.js";
import { ACPX_BUNDLED_BIN } from "./config.js";
import type { AcpxMcpStatusEndpoint, AcpxMcpStatusServer } from "./mcp-status-server.js";
import { createAcpxRuntimeService } from "./service.js";

const { ensurePinnedAcpxSpy } = vi.hoisted(() => ({
  ensurePinnedAcpxSpy: vi.fn(async () => {}),
}));

vi.mock("./ensure.js", () => ({
  ensurePinnedAcpx: ensurePinnedAcpxSpy,
}));

type RuntimeStub = AcpRuntime & {
  probeAvailability(): Promise<void>;
  isHealthy(): boolean;
};

function createRuntimeStub(healthy: boolean): {
  runtime: RuntimeStub;
  probeAvailabilitySpy: ReturnType<typeof vi.fn>;
  isHealthySpy: ReturnType<typeof vi.fn>;
} {
  const probeAvailabilitySpy = vi.fn(async () => {});
  const isHealthySpy = vi.fn(() => healthy);
  return {
    runtime: {
      ensureSession: vi.fn(async (input) => ({
        sessionKey: input.sessionKey,
        backend: "acpx",
        runtimeSessionName: input.sessionKey,
      })),
      runTurn: vi.fn(async function* () {
        yield { type: "done" as const };
      }),
      cancel: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      async probeAvailability() {
        await probeAvailabilitySpy();
      },
      isHealthy() {
        return isHealthySpy();
      },
    },
    probeAvailabilitySpy,
    isHealthySpy,
  };
}

function createServiceContext(
  overrides: Partial<FasedAgentPluginServiceContext> = {},
): FasedAgentPluginServiceContext {
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
    ...overrides,
  };
}

function createMcpStatusServerStub(endpointOverrides?: { mode?: AcpxMcpStatusEndpoint["mode"] }): {
  server: AcpxMcpStatusServer;
  closeSpy: ReturnType<typeof vi.fn>;
  startEndpointSpy: ReturnType<typeof vi.fn>;
} {
  const closeSpy = vi.fn(async () => {});
  const endpoint: AcpxMcpStatusEndpoint = {
    url: "http://127.0.0.1:12345/mcp",
    token: "test-token",
    toolNames: ["fased_tools_effective"],
    ...endpointOverrides,
  };
  const startEndpointSpy = vi.fn(async () => endpoint);
  return {
    server: {
      server: {} as never,
      toolNames: ["fased_tools_effective"],
      startEndpoint: startEndpointSpy,
      getEndpoint: vi.fn(() => endpoint),
      previewEffectiveTools: vi.fn(async () => ({
        bridge: {
          id: "acpx" as const,
          mode: "status-only" as const,
          enabled: true as const,
        },
        agentId: "main",
        profile: "full",
        groups: [],
      })),
      previewGatewayStatus: vi.fn(async () => ({}) as never),
      previewModelsCatalogStatus: vi.fn(async () => ({}) as never),
      previewCommandsList: vi.fn(async () => ({}) as never),
      previewAcpStatus: vi.fn(async () => ({}) as never),
      executePushTestRequest: vi.fn(async () => ({}) as never),
      close: closeSpy,
      isClosed: vi.fn(() => false),
    },
    closeSpy,
    startEndpointSpy,
  };
}

describe("createAcpxRuntimeService", () => {
  beforeEach(() => {
    __testing.resetAcpRuntimeBackendsForTests();
    ensurePinnedAcpxSpy.mockReset();
    ensurePinnedAcpxSpy.mockImplementation(async () => {});
  });

  it("registers and unregisters the acpx backend", async () => {
    const { runtime, probeAvailabilitySpy } = createRuntimeStub(true);
    const service = createAcpxRuntimeService({
      runtimeFactory: () => runtime,
    });
    const context = createServiceContext();

    await service.start(context);
    expect(getAcpRuntimeBackend("acpx")?.runtime).toBe(runtime);

    await vi.waitFor(() => {
      expect(ensurePinnedAcpxSpy).toHaveBeenCalledOnce();
      expect(probeAvailabilitySpy).toHaveBeenCalledOnce();
    });

    await service.stop?.(context);
    expect(getAcpRuntimeBackend("acpx")).toBeNull();
  });

  it("marks backend unavailable when runtime health check fails", async () => {
    const { runtime } = createRuntimeStub(false);
    const service = createAcpxRuntimeService({
      runtimeFactory: () => runtime,
    });
    const context = createServiceContext();

    await service.start(context);

    expect(() => requireAcpRuntimeBackend("acpx")).toThrowError(AcpRuntimeError);
    try {
      requireAcpRuntimeBackend("acpx");
      throw new Error("expected ACP backend lookup to fail");
    } catch (error) {
      expect((error as AcpRuntimeError).code).toBe("ACP_BACKEND_UNAVAILABLE");
    }
  });

  it("passes queue-owner TTL from plugin config", async () => {
    const { runtime } = createRuntimeStub(true);
    const runtimeFactory = vi.fn(() => runtime);
    const service = createAcpxRuntimeService({
      runtimeFactory,
      pluginConfig: {
        queueOwnerTtlSeconds: 0.25,
      },
    });
    const context = createServiceContext();

    await service.start(context);

    expect(runtimeFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        queueOwnerTtlSeconds: 0.25,
        pluginConfig: expect.objectContaining({
          command: ACPX_BUNDLED_BIN,
        }),
      }),
    );
  });

  it("uses a short default queue-owner TTL", async () => {
    const { runtime } = createRuntimeStub(true);
    const runtimeFactory = vi.fn(() => runtime);
    const service = createAcpxRuntimeService({
      runtimeFactory,
    });
    const context = createServiceContext();

    await service.start(context);

    expect(runtimeFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        queueOwnerTtlSeconds: 0.1,
      }),
    );
  });

  it("does not block startup while acpx ensure runs", async () => {
    const { runtime } = createRuntimeStub(true);
    ensurePinnedAcpxSpy.mockImplementation(() => new Promise<void>(() => {}));
    const service = createAcpxRuntimeService({
      runtimeFactory: () => runtime,
    });
    const context = createServiceContext();

    const startResult = await Promise.race([
      Promise.resolve(service.start(context)).then(() => "started"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timed_out"), 100)),
    ]);

    expect(startResult).toBe("started");
    expect(getAcpRuntimeBackend("acpx")?.runtime).toBe(runtime);
  });

  it("does not start the ACPX MCP status bridge by default", async () => {
    const { runtime } = createRuntimeStub(true);
    const mcpStatusServerFactory = vi.fn();
    const service = createAcpxRuntimeService({
      runtimeFactory: () => runtime,
      mcpStatusServerFactory,
    });

    await service.start(createServiceContext());

    expect(mcpStatusServerFactory).not.toHaveBeenCalled();
  });

  it("starts and disposes the ACPX MCP status bridge when explicitly enabled", async () => {
    const { runtime } = createRuntimeStub(true);
    const { server, closeSpy, startEndpointSpy } = createMcpStatusServerStub();
    const runtimeFactory = vi.fn(() => runtime);
    const mcpStatusServerFactory = vi.fn(() => server);
    const context = createServiceContext();
    const service = createAcpxRuntimeService({
      runtimeFactory,
      mcpStatusServerFactory,
      pluginConfig: {
        mcpBridge: {
          enabled: true,
          mode: "status-only",
        },
      },
    });

    await service.start(context);

    expect(mcpStatusServerFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        context,
        bridgeConfig: {
          enabled: true,
          mode: "status-only",
          allowTools: [],
          denyTools: [],
        },
      }),
    );
    expect(startEndpointSpy).toHaveBeenCalledOnce();
    expect(runtimeFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        mcpStatusEndpoint: {
          url: "http://127.0.0.1:12345/mcp",
          token: "test-token",
          toolNames: ["fased_tools_effective"],
        },
      }),
    );
    expect(getAcpRuntimeBackend("acpx")?.runtime).toBe(runtime);

    await service.stop?.(context);

    expect(closeSpy).toHaveBeenCalledOnce();
    expect(getAcpRuntimeBackend("acpx")).toBeNull();
  });

  it("starts the ACPX bridge in read-only-tools mode with fixed wrapper endpoint metadata", async () => {
    const { runtime } = createRuntimeStub(true);
    const { server, startEndpointSpy } = createMcpStatusServerStub({
      mode: "read-only-tools",
    });
    const runtimeFactory = vi.fn(() => runtime);
    const context = createServiceContext();
    const service = createAcpxRuntimeService({
      runtimeFactory,
      mcpStatusServerFactory: vi.fn(() => server),
      pluginConfig: {
        mcpBridge: {
          enabled: true,
          mode: "read-only-tools",
        },
      },
    });

    await service.start(context);

    expect(startEndpointSpy).toHaveBeenCalledOnce();
    expect(runtimeFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        mcpStatusEndpoint: expect.objectContaining({
          mode: "read-only-tools",
          toolNames: ["fased_tools_effective"],
        }),
      }),
    );

    await service.stop?.(context);
  });

  it("does not register the ACPX runtime backend when the MCP bridge fails to start", async () => {
    const { runtime } = createRuntimeStub(true);
    const service = createAcpxRuntimeService({
      runtimeFactory: () => runtime,
      mcpStatusServerFactory: vi.fn(() => {
        throw new Error("bridge boom");
      }),
      pluginConfig: {
        mcpBridge: {
          enabled: true,
        },
      },
    });

    await expect(service.start(createServiceContext())).rejects.toThrow("bridge boom");

    expect(getAcpRuntimeBackend("acpx")).toBeNull();
  });

  it("closes the MCP status bridge when endpoint startup fails", async () => {
    const { runtime } = createRuntimeStub(true);
    const { server, closeSpy, startEndpointSpy } = createMcpStatusServerStub();
    startEndpointSpy.mockRejectedValueOnce(new Error("endpoint boom"));
    const service = createAcpxRuntimeService({
      runtimeFactory: () => runtime,
      mcpStatusServerFactory: vi.fn(() => server),
      pluginConfig: {
        mcpBridge: {
          enabled: true,
        },
      },
    });

    await expect(service.start(createServiceContext())).rejects.toThrow("endpoint boom");

    expect(closeSpy).toHaveBeenCalledOnce();
    expect(getAcpRuntimeBackend("acpx")).toBeNull();
  });
});
