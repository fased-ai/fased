import { vi, type Mock } from "vitest";
import type { SubagentLifecycleHookRunner } from "../plugins/hooks.js";

type SessionsSpawnTestConfig = ReturnType<(typeof import("../config/config.js"))["loadConfig"]>;
type SessionsSpawnHookRunner = Pick<
  SubagentLifecycleHookRunner,
  "hasHooks" | "runSubagentSpawning" | "runSubagentSpawned" | "runSubagentEnded"
> | null;
type CreateSessionsSpawnTool =
  (typeof import("./tools/sessions-spawn-tool.js"))["createSessionsSpawnTool"];
type RunSubagentAnnounceFlow = (typeof import("./subagent-announce.js"))["runSubagentAnnounceFlow"];
export type CreateSessionsSpawnToolOpts = Parameters<CreateSessionsSpawnTool>[0];
export type GatewayRequest = { method?: string; params?: unknown };
export type AgentWaitCall = { runId?: string; timeoutMs?: number };
type SessionsSpawnGatewayMockOptions = {
  includeSessionsList?: boolean;
  includeChatHistory?: boolean;
  chatHistoryText?: string;
  onAgentSubagentSpawn?: (params: unknown) => void;
  onSessionsPatch?: (params: unknown) => void;
  onSessionsDelete?: (params: unknown) => void;
  agentWaitResult?: { status: "ok" | "timeout"; startedAt: number; endedAt: number };
};

const hoisted = vi.hoisted(() => {
  const callGatewayMock = vi.fn();
  const defaultConfigOverride = {
    session: {
      mainKey: "main",
      scope: "per-sender",
    },
  } as SessionsSpawnTestConfig;
  let configOverride = defaultConfigOverride;
  const resolveRequesterStoreKeyForTest = (
    cfg: SessionsSpawnTestConfig,
    requesterSessionKey: string,
  ): string => {
    const raw = (requesterSessionKey ?? "").trim();
    if (!raw || raw === "global" || raw === "unknown" || raw.startsWith("agent:")) {
      return raw;
    }
    const mainKey =
      typeof cfg.session?.mainKey === "string" && cfg.session.mainKey.trim()
        ? cfg.session.mainKey.trim()
        : "main";
    if (raw === "main" || raw === mainKey) {
      return `agent:main:${mainKey}`;
    }
    const agentId = raw.match(/^agent:([^:]+)/)?.[1] ?? "main";
    return `agent:${agentId}:${raw}`;
  };
  const defaultRunSubagentAnnounceFlow: RunSubagentAnnounceFlow = async (params) => {
    const statusLabel =
      params.outcome?.status === "timeout" ? "timed out" : "completed successfully";
    const requesterSessionKey = resolveRequesterStoreKeyForTest(
      configOverride,
      params.requesterSessionKey,
    );

    await callGatewayMock({
      method: "agent",
      params: {
        sessionKey: requesterSessionKey,
        message: `subagent task ${statusLabel}`,
        deliver: false,
      },
    });

    if (params.label) {
      await callGatewayMock({
        method: "sessions.patch",
        params: {
          key: params.childSessionKey,
          label: params.label,
        },
      });
    }

    if (params.cleanup === "delete") {
      await callGatewayMock({
        method: "sessions.delete",
        params: {
          key: params.childSessionKey,
          deleteTranscript: true,
          emitLifecycleHooks: params.spawnMode === "session",
        },
      });
    }

    return true;
  };
  const state = {
    get configOverride() {
      return configOverride;
    },
    set configOverride(next: SessionsSpawnTestConfig) {
      configOverride = next;
    },
    hookRunnerOverride: null as SessionsSpawnHookRunner,
    defaultRunSubagentAnnounceFlow,
    runSubagentAnnounceFlowOverride: defaultRunSubagentAnnounceFlow,
  };
  return { callGatewayMock, defaultConfigOverride, state };
});

export function getCallGatewayMock(): Mock {
  return hoisted.callGatewayMock;
}

export function getGatewayRequests(): Array<GatewayRequest> {
  return getCallGatewayMock().mock.calls.map((call: unknown[]) => call[0] as GatewayRequest);
}

export function getGatewayMethods(): Array<string | undefined> {
  return getGatewayRequests().map((request) => request.method);
}

export function findGatewayRequest(method: string): GatewayRequest | undefined {
  return getGatewayRequests().find((request) => request.method === method);
}

export function resetSessionsSpawnConfigOverride(): void {
  hoisted.state.configOverride = hoisted.defaultConfigOverride;
}

export function setSessionsSpawnConfigOverride(next: SessionsSpawnTestConfig): void {
  hoisted.state.configOverride = next;
}

export function resetSessionsSpawnAnnounceFlowOverride(): void {
  hoisted.state.runSubagentAnnounceFlowOverride = hoisted.state.defaultRunSubagentAnnounceFlow;
}

export function resetSessionsSpawnHookRunnerOverride(): void {
  hoisted.state.hookRunnerOverride = null;
}

export function setSessionsSpawnHookRunnerOverride(next: SessionsSpawnHookRunner): void {
  hoisted.state.hookRunnerOverride = next;
}

export function setSessionsSpawnAnnounceFlowOverride(next: RunSubagentAnnounceFlow): void {
  hoisted.state.runSubagentAnnounceFlowOverride = next;
}

export async function getSessionsSpawnTool(opts: CreateSessionsSpawnToolOpts) {
  const { createSessionsSpawnTool } = await import("./tools/sessions-spawn-tool.js");
  return createSessionsSpawnTool(opts);
}

export function setupSessionsSpawnGatewayMock(setupOpts: SessionsSpawnGatewayMockOptions): {
  calls: Array<GatewayRequest>;
  waitCalls: Array<AgentWaitCall>;
  getChild: () => { runId?: string; sessionKey?: string };
} {
  const calls: Array<GatewayRequest> = [];
  const waitCalls: Array<AgentWaitCall> = [];
  let agentCallCount = 0;
  let childRunId: string | undefined;
  let childSessionKey: string | undefined;

  getCallGatewayMock().mockImplementation(async (optsUnknown: unknown) => {
    const request = optsUnknown as GatewayRequest;
    calls.push(request);

    if (request.method === "sessions.list" && setupOpts.includeSessionsList) {
      return {
        sessions: [
          {
            key: "main",
            lastChannel: "whatsapp",
            lastTo: "+123",
          },
        ],
      };
    }

    if (request.method === "agent") {
      agentCallCount += 1;
      const runId = `run-${agentCallCount}`;
      const params = request.params as { lane?: string; sessionKey?: string } | undefined;
      // Capture only the subagent run metadata.
      if (params?.lane === "subagent") {
        childRunId = runId;
        childSessionKey = params.sessionKey ?? "";
        setupOpts.onAgentSubagentSpawn?.(params);
      }
      return {
        runId,
        status: "accepted",
        acceptedAt: 1000 + agentCallCount,
      };
    }

    if (request.method === "agent.wait") {
      const params = request.params as AgentWaitCall | undefined;
      waitCalls.push(params ?? {});
      const waitResult = setupOpts.agentWaitResult ?? {
        status: "ok",
        startedAt: 1000,
        endedAt: 2000,
      };
      return {
        runId: params?.runId ?? "run-1",
        ...waitResult,
      };
    }

    if (request.method === "sessions.patch") {
      setupOpts.onSessionsPatch?.(request.params);
      return { ok: true };
    }

    if (request.method === "sessions.delete") {
      setupOpts.onSessionsDelete?.(request.params);
      return { ok: true };
    }

    if (request.method === "chat.history" && setupOpts.includeChatHistory) {
      return {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: setupOpts.chatHistoryText ?? "done" }],
          },
        ],
      };
    }

    return {};
  });

  return {
    calls,
    waitCalls,
    getChild: () => ({ runId: childRunId, sessionKey: childSessionKey }),
  };
}

vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => hoisted.callGatewayMock(opts),
}));
// Some tools import callGateway via "../../gateway/call.js" (from nested folders). Mock that too.
vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => hoisted.callGatewayMock(opts),
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => hoisted.state.hookRunnerOverride,
}));

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => hoisted.state.hookRunnerOverride,
}));

vi.mock("./subagent-announce.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./subagent-announce.js")>();
  return {
    ...actual,
    runSubagentAnnounceFlow: (params: Parameters<RunSubagentAnnounceFlow>[0]) =>
      hoisted.state.runSubagentAnnounceFlowOverride(params),
  };
});

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    loadConfig: () => hoisted.state.configOverride,
    resolveGatewayPort: () => 18789,
  };
});

// Same module, different specifier (used by tools under src/agents/tools/*).
vi.mock("../../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    loadConfig: () => hoisted.state.configOverride,
    resolveGatewayPort: () => 18789,
  };
});
