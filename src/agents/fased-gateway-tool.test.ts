import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import "./test-helpers/fast-core-tools.js";
import { createGatewayTool } from "./tools/gateway-tool.js";
import { callGatewayTool } from "./tools/gateway.js";

const { callGatewayToolMock, readGatewayCallOptionsMock } = vi.hoisted(() => ({
  callGatewayToolMock: vi.fn(),
  readGatewayCallOptionsMock: vi.fn(() => ({})),
}));

vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: callGatewayToolMock,
  readGatewayCallOptions: readGatewayCallOptionsMock,
}));

function requireGatewayTool(agentSessionKey?: string) {
  return createGatewayTool({
    ...(agentSessionKey ? { agentSessionKey } : {}),
    config: { commands: { restart: true } },
  });
}

function expectConfigMutationCall(params: {
  callGatewayTool: {
    mock: {
      calls: Array<readonly unknown[]>;
    };
  };
  action: "config.apply" | "config.patch";
  raw: string;
  sessionKey: string;
}) {
  expect(params.callGatewayTool).toHaveBeenCalledWith("config.get", expect.any(Object), {});
  expect(params.callGatewayTool).toHaveBeenCalledWith(
    params.action,
    expect.any(Object),
    expect.objectContaining({
      raw: params.raw.trim(),
      baseHash: "hash-1",
      sessionKey: params.sessionKey,
    }),
  );
}

describe("gateway tool", () => {
  beforeEach(() => {
    callGatewayToolMock.mockClear();
    readGatewayCallOptionsMock.mockClear();
    callGatewayToolMock.mockImplementation(async (method: string) => {
      if (method === "config.get") {
        return {
          hash: "hash-1",
          config: {
            tools: {
              exec: {
                ask: "on-miss",
                security: "allowlist",
              },
            },
          },
        };
      }
      if (method === "config.schema.lookup") {
        return {
          path: "gateway.auth",
          schema: {
            type: "object",
          },
          hint: { label: "Gateway Auth" },
          hintPath: "gateway.auth",
          children: [
            {
              key: "token",
              path: "gateway.auth.token",
              type: "string",
              required: true,
              hasChildren: false,
              hint: { label: "Token", sensitive: true },
              hintPath: "gateway.auth.token",
            },
          ],
        };
      }
      return { ok: true };
    });
  });

  it("marks gateway as owner-only", async () => {
    const tool = requireGatewayTool();
    expect(tool.ownerOnly).toBe(true);
  });

  it("uses local gateway credentials by default for provider status checks", async () => {
    const tool = requireGatewayTool();

    await tool.execute("call-status", {
      action: "models.auth.status",
    });

    expect(callGatewayTool).toHaveBeenCalledWith(
      "models.auth.status",
      expect.objectContaining({ gatewayTarget: "local" }),
      {},
    );
  });

  it("schedules SIGUSR1 restart", async () => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-test-"));

    try {
      await withEnvAsync({ FASED_STATE_DIR: stateDir, FASED_PROFILE: "isolated" }, async () => {
        const tool = requireGatewayTool();

        const result = await tool.execute("call1", {
          action: "restart",
          delayMs: 0,
        });
        expect(result.details).toMatchObject({
          ok: true,
          pid: process.pid,
          signal: "SIGUSR1",
          delayMs: 0,
        });

        const sentinelPath = path.join(stateDir, "restart-sentinel.json");
        const raw = await fs.readFile(sentinelPath, "utf-8");
        const parsed = JSON.parse(raw) as {
          payload?: { kind?: string; doctorHint?: string | null };
        };
        expect(parsed.payload?.kind).toBe("restart");
        expect(parsed.payload?.doctorHint).toBe(
          "Run: fased --profile isolated doctor --non-interactive",
        );

        expect(kill).not.toHaveBeenCalled();
        await vi.runAllTimersAsync();
        expect(kill).toHaveBeenCalledWith(process.pid, "SIGUSR1");
      });
    } finally {
      kill.mockRestore();
      vi.useRealTimers();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("passes config.apply through gateway call", async () => {
    const sessionKey = "agent:main:whatsapp:dm:+15555550123";
    const tool = requireGatewayTool(sessionKey);

    const raw =
      '{\n  agents: { defaults: { model: { primary: "openrouter/google/gemini-2.5-flash-lite" } } },\n  tools: { exec: { ask: "on-miss", security: "allowlist" } }\n}\n';
    await tool.execute("call2", {
      action: "config.apply",
      raw,
    });

    expectConfigMutationCall({
      callGatewayTool: vi.mocked(callGatewayTool),
      action: "config.apply",
      raw,
      sessionKey,
    });
  });

  it("passes config.patch through gateway call", async () => {
    const sessionKey = "agent:main:whatsapp:dm:+15555550123";
    const tool = requireGatewayTool(sessionKey);

    const raw = '{\n  channels: { telegram: { groups: { "*": { requireMention: false } } } }\n}\n';
    await tool.execute("call4", {
      action: "config.patch",
      raw,
    });

    expectConfigMutationCall({
      callGatewayTool: vi.mocked(callGatewayTool),
      action: "config.patch",
      raw,
      sessionKey,
    });
  });

  it("allows config.apply when protected exec settings are structurally unchanged", async () => {
    vi.mocked(callGatewayTool).mockImplementationOnce(async (method: string) => {
      if (method === "config.get") {
        return {
          hash: "hash-1",
          config: {
            tools: {
              exec: {
                ask: "on-miss",
                security: { allow: { a: 1, b: 2 }, modes: ["read"] },
              },
            },
          },
        };
      }
      return { ok: true };
    });
    const sessionKey = "agent:main:whatsapp:dm:+15555550123";
    const tool = requireGatewayTool(sessionKey);

    const raw =
      '{\n  tools: { exec: { ask: "on-miss", security: { modes: ["read"], allow: { b: 2, a: 1 } } } }\n}\n';
    await tool.execute("call-structural-apply", {
      action: "config.apply",
      raw,
    });

    expectConfigMutationCall({
      callGatewayTool: vi.mocked(callGatewayTool),
      action: "config.apply",
      raw,
      sessionKey,
    });
  });

  it("rejects config.patch when it changes exec approval settings", async () => {
    const tool = requireGatewayTool();

    await expect(
      tool.execute("call-protected-patch", {
        action: "config.patch",
        raw: '{ tools: { exec: { ask: "off" } } }',
      }),
    ).rejects.toThrow("gateway config.patch cannot change protected config paths: tools.exec.ask");
    expect(callGatewayTool).toHaveBeenCalledWith("config.get", expect.any(Object), {});
    expect(callGatewayTool).not.toHaveBeenCalledWith(
      "config.patch",
      expect.any(Object),
      expect.anything(),
    );
  });

  it("rejects config.patch when a legacy tools.bash alias changes exec security", async () => {
    vi.mocked(callGatewayTool).mockImplementationOnce(async (method: string) => {
      if (method === "config.get") {
        return { hash: "hash-1", config: {} };
      }
      return { ok: true };
    });
    const tool = requireGatewayTool();

    await expect(
      tool.execute("call-legacy-protected-patch", {
        action: "config.patch",
        raw: '{ tools: { bash: { security: "full" } } }',
      }),
    ).rejects.toThrow(
      "gateway config.patch cannot change protected config paths: tools.exec.security",
    );
    expect(callGatewayTool).toHaveBeenCalledWith("config.get", expect.any(Object), {});
    expect(callGatewayTool).not.toHaveBeenCalledWith(
      "config.patch",
      expect.any(Object),
      expect.anything(),
    );
  });

  it("rejects config.apply when it changes exec security settings", async () => {
    const tool = requireGatewayTool();

    await expect(
      tool.execute("call-protected-apply", {
        action: "config.apply",
        raw: '{ tools: { exec: { ask: "on-miss", security: "full" } } }',
      }),
    ).rejects.toThrow(
      "gateway config.apply cannot change protected config paths: tools.exec.security",
    );
    expect(callGatewayTool).toHaveBeenCalledWith("config.get", expect.any(Object), {});
    expect(callGatewayTool).not.toHaveBeenCalledWith(
      "config.apply",
      expect.any(Object),
      expect.anything(),
    );
  });

  it("rejects config.apply when protected exec settings are omitted", async () => {
    const tool = requireGatewayTool();

    await expect(
      tool.execute("call-missing-protected", {
        action: "config.apply",
        raw: '{ agents: { defaults: { model: { primary: "openrouter/google/gemini-2.5-flash-lite" } } } }',
      }),
    ).rejects.toThrow(
      "gateway config.apply cannot change protected config paths: tools.exec.ask, tools.exec.security",
    );
    expect(callGatewayTool).toHaveBeenCalledWith("config.get", expect.any(Object), {});
    expect(callGatewayTool).not.toHaveBeenCalledWith(
      "config.apply",
      expect.any(Object),
      expect.anything(),
    );
  });

  it("rejects config.patch when it newly enables a dangerous flag", async () => {
    const tool = requireGatewayTool();

    await expect(
      tool.execute("call-dangerous-patch", {
        action: "config.patch",
        raw: "{ gateway: { controlUi: { dangerouslyDisableDeviceAuth: true } } }",
      }),
    ).rejects.toThrow(
      /gateway config\.patch cannot (?:change protected config paths: gateway\.controlUi\.dangerouslyDisableDeviceAuth|enable dangerous config flags: gateway\.controlUi\.dangerouslyDisableDeviceAuth=true)/,
    );
    expect(callGatewayTool).toHaveBeenCalledWith("config.get", expect.any(Object), {});
    expect(callGatewayTool).not.toHaveBeenCalledWith(
      "config.patch",
      expect.any(Object),
      expect.anything(),
    );
  });

  it("allows config.patch when a dangerous flag was already enabled", async () => {
    vi.mocked(callGatewayTool).mockImplementationOnce(async (method: string) => {
      if (method === "config.get") {
        return {
          hash: "hash-1",
          config: {
            gateway: {
              controlUi: {
                dangerouslyDisableDeviceAuth: true,
              },
            },
            tools: {
              exec: {
                ask: "on-miss",
                security: "allowlist",
              },
            },
          },
        };
      }
      return { ok: true };
    });
    const tool = requireGatewayTool("agent:main:whatsapp:dm:+15555550123");

    const raw = '{ channels: { telegram: { groups: { "*": { requireMention: false } } } } }';
    await tool.execute("call-existing-dangerous-patch", {
      action: "config.patch",
      raw,
    });

    expectConfigMutationCall({
      callGatewayTool: vi.mocked(callGatewayTool),
      action: "config.patch",
      raw,
      sessionKey: "agent:main:whatsapp:dm:+15555550123",
    });
  });

  it("rejects config.apply when raw config cannot be parsed", async () => {
    const tool = requireGatewayTool();

    await expect(
      tool.execute("call-invalid-apply", {
        action: "config.apply",
        raw: "{ agents: ",
      }),
    ).rejects.toThrow();
    expect(callGatewayTool).toHaveBeenCalledWith("config.get", expect.any(Object), {});
    expect(callGatewayTool).not.toHaveBeenCalledWith(
      "config.apply",
      expect.any(Object),
      expect.anything(),
    );
  });

  it("rejects config.patch when config.get does not return a config object", async () => {
    vi.mocked(callGatewayTool).mockImplementationOnce(async (method: string) => {
      if (method === "config.get") {
        return { hash: "hash-1" };
      }
      return { ok: true };
    });
    const tool = requireGatewayTool();

    await expect(
      tool.execute("call-missing-snapshot-config", {
        action: "config.patch",
        raw: '{ channels: { telegram: { groups: { "*": { requireMention: false } } } } }',
      }),
    ).rejects.toThrow("config.get response is missing a config object.");
    expect(callGatewayTool).toHaveBeenCalledWith("config.get", expect.any(Object), {});
    expect(callGatewayTool).not.toHaveBeenCalledWith(
      "config.patch",
      expect.any(Object),
      expect.anything(),
    );
  });

  it("passes update.run through gateway call", async () => {
    const sessionKey = "agent:main:whatsapp:dm:+15555550123";
    const tool = requireGatewayTool(sessionKey);

    await tool.execute("call3", {
      action: "update.run",
      note: "test update",
    });

    expect(callGatewayTool).toHaveBeenCalledWith(
      "update.run",
      expect.any(Object),
      expect.objectContaining({
        note: "test update",
        sessionKey,
      }),
    );
    const updateCall = vi
      .mocked(callGatewayTool)
      .mock.calls.find((call) => call[0] === "update.run");
    expect(updateCall).toBeDefined();
    if (updateCall) {
      const [, opts, params] = updateCall;
      expect(opts).toMatchObject({ timeoutMs: 20 * 60_000 });
      expect(params).toMatchObject({ timeoutMs: 20 * 60_000 });
    }
  });

  it("returns a path-scoped schema lookup result", async () => {
    const tool = requireGatewayTool();

    const result = await tool.execute("call5", {
      action: "config.schema.lookup",
      path: "gateway.auth",
    });

    expect(callGatewayTool).toHaveBeenCalledWith("config.schema.lookup", expect.any(Object), {
      path: "gateway.auth",
    });
    expect(result.details).toMatchObject({
      ok: true,
      result: {
        path: "gateway.auth",
        hintPath: "gateway.auth",
        children: [
          expect.objectContaining({
            key: "token",
            path: "gateway.auth.token",
            required: true,
            hintPath: "gateway.auth.token",
          }),
        ],
      },
    });
    const schema = (result.details as { result?: { schema?: { properties?: unknown } } }).result
      ?.schema;
    expect(schema?.properties).toBeUndefined();
  });
});
