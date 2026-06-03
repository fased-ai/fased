import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(),
  isGatewayTransportError: (value: unknown) =>
    value instanceof Error &&
    value.name === "GatewayTransportError" &&
    ((value as { kind?: unknown }).kind === "closed" ||
      (value as { kind?: unknown }).kind === "timeout"),
  randomIdempotencyKey: () => "idem-1",
}));
vi.mock("./agent.js", () => ({
  agentCommand: vi.fn(),
}));

import type { FasedAgentConfig } from "../config/config.js";
import * as configModule from "../config/config.js";
import { callGateway } from "../gateway/call.js";
import type { RuntimeEnv } from "../runtime.js";
import { agentCliCommand } from "./agent-via-gateway.js";
import { agentCommand } from "./agent.js";

const runtime: RuntimeEnv = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

const configSpy = vi.spyOn(configModule, "loadConfig");

function mockConfig(storePath: string, overrides?: Partial<FasedAgentConfig>) {
  configSpy.mockReturnValue({
    agents: {
      defaults: {
        timeoutSeconds: 600,
        ...overrides?.agents?.defaults,
      },
    },
    session: {
      store: storePath,
      mainKey: "main",
      ...overrides?.session,
    },
    gateway: overrides?.gateway,
  });
}

async function withTempStore(
  fn: (ctx: { dir: string; store: string }) => Promise<void>,
  overrides?: Partial<FasedAgentConfig>,
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fased-agent-cli-"));
  const store = path.join(dir, "sessions.json");
  mockConfig(store, overrides);
  try {
    await fn({ dir, store });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function mockGatewaySuccessReply(text = "hello") {
  vi.mocked(callGateway).mockResolvedValue({
    runId: "idem-1",
    status: "ok",
    result: {
      payloads: [{ text }],
      meta: { stub: true },
    },
  });
}

function mockLocalAgentReply(text = "local") {
  vi.mocked(agentCommand).mockImplementationOnce(async (_opts, rt) => {
    rt?.log?.(text);
    return {
      payloads: [{ text }],
      meta: { durationMs: 1, agentMeta: { sessionId: "s", provider: "p", model: "m" } },
    } as unknown as Awaited<ReturnType<typeof agentCommand>>;
  });
}

function createGatewayTransportError(kind: "closed" | "timeout", message: string): Error {
  const error = new Error(message);
  error.name = "GatewayTransportError";
  return Object.assign(error, {
    kind,
    connectionDetails: {
      url: "ws://127.0.0.1:18789",
      urlSource: "local loopback",
      message: "Gateway target: ws://127.0.0.1:18789",
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("agentCliCommand", () => {
  it("uses a timer-safe max gateway timeout when --timeout is 0", async () => {
    await withTempStore(async () => {
      mockGatewaySuccessReply();

      await agentCliCommand({ message: "hi", to: "+1555", timeout: "0" }, runtime);

      expect(callGateway).toHaveBeenCalledTimes(1);
      const request = vi.mocked(callGateway).mock.calls[0]?.[0] as { timeoutMs?: number };
      expect(request.timeoutMs).toBe(2_147_000_000);
    });
  });

  it("uses gateway by default", async () => {
    await withTempStore(async () => {
      mockGatewaySuccessReply();

      await agentCliCommand({ message: "hi", to: "+1555" }, runtime);

      expect(callGateway).toHaveBeenCalledTimes(1);
      expect(agentCommand).not.toHaveBeenCalled();
      expect(runtime.log).toHaveBeenCalledWith("hello");
    });
  });

  it("falls back to embedded agent when gateway transport closes", async () => {
    await withTempStore(async () => {
      vi.mocked(callGateway).mockRejectedValue(
        createGatewayTransportError("closed", "gateway closed (1006): no close reason"),
      );
      mockLocalAgentReply();

      await agentCliCommand({ message: "hi", to: "+1555" }, runtime);

      expect(callGateway).toHaveBeenCalledTimes(1);
      expect(agentCommand).toHaveBeenCalledTimes(1);
      expect(runtime.log).toHaveBeenCalledWith("local");
    });
  });

  it("falls back to embedded agent when gateway transport times out", async () => {
    await withTempStore(async () => {
      vi.mocked(callGateway).mockRejectedValue(
        createGatewayTransportError("timeout", "gateway timeout after 10000ms"),
      );
      mockLocalAgentReply();

      await agentCliCommand({ message: "hi", to: "+1555" }, runtime);

      expect(callGateway).toHaveBeenCalledTimes(1);
      expect(agentCommand).toHaveBeenCalledTimes(1);
      expect(runtime.log).toHaveBeenCalledWith("local");
    });
  });

  it("does not fall back to embedded agent for gateway request errors", async () => {
    await withTempStore(async () => {
      vi.mocked(callGateway).mockRejectedValue(
        Object.assign(new Error("missing scope: operator.admin"), {
          name: "GatewayClientRequestError",
          gatewayCode: "INVALID_REQUEST",
        }),
      );

      await expect(agentCliCommand({ message: "hi", to: "+1555" }, runtime)).rejects.toThrow(
        "missing scope: operator.admin",
      );

      expect(callGateway).toHaveBeenCalledTimes(1);
      expect(agentCommand).not.toHaveBeenCalled();
      expect(runtime.error).not.toHaveBeenCalledWith(
        expect.stringContaining("falling back to embedded"),
      );
    });
  });

  it("does not fall back to embedded agent for gateway auth errors", async () => {
    await withTempStore(async () => {
      vi.mocked(callGateway).mockRejectedValue(
        Object.assign(new Error("unauthorized: gateway token mismatch"), {
          name: "GatewayClientRequestError",
          gatewayCode: "INVALID_REQUEST",
        }),
      );

      await expect(agentCliCommand({ message: "hi", to: "+1555" }, runtime)).rejects.toThrow(
        "unauthorized: gateway token mismatch",
      );

      expect(callGateway).toHaveBeenCalledTimes(1);
      expect(agentCommand).not.toHaveBeenCalled();
      expect(runtime.error).not.toHaveBeenCalledWith(
        expect.stringContaining("falling back to embedded"),
      );
    });
  });

  it("skips gateway when --local is set", async () => {
    await withTempStore(async () => {
      mockLocalAgentReply();

      await agentCliCommand(
        {
          message: "hi",
          to: "+1555",
          local: true,
        },
        runtime,
      );

      expect(callGateway).not.toHaveBeenCalled();
      expect(agentCommand).toHaveBeenCalledTimes(1);
      expect(runtime.log).toHaveBeenCalledWith("local");
    });
  });
});
