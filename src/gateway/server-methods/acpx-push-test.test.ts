import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FasedAgentConfig } from "../../config/types.fased.js";
import { acpxPushTestHandlers } from "./acpx-push-test.js";

vi.mock("../../config/config.js", () => ({
  loadConfig: vi.fn(),
}));

vi.mock("../../infra/push-apns.js", () => ({
  loadApnsRegistration: vi.fn(),
  normalizeApnsEnvironment: vi.fn(),
  resolveApnsAuthConfigFromEnv: vi.fn(),
  sendApnsAlert: vi.fn(),
}));

import { loadConfig } from "../../config/config.js";
import {
  loadApnsRegistration,
  normalizeApnsEnvironment,
  resolveApnsAuthConfigFromEnv,
  sendApnsAlert,
} from "../../infra/push-apns.js";
import {
  logMutatingAdminRpcAudit,
  resetMutatingAdminRpcAuditHistoryForTest,
} from "./mutating-admin-rpc-audit.js";

function enabledConfig(): FasedAgentConfig {
  return {
    plugins: {
      entries: {
        acpx: {
          enabled: true,
          config: {
            mcpBridge: {
              enabled: true,
              mode: "operator-approved-mutating-tools",
              allowTools: ["fased_push_test_request"],
              denyTools: [],
            },
          },
        },
      },
    },
  } as FasedAgentConfig;
}

function disabledConfig(): FasedAgentConfig {
  return {
    plugins: {
      entries: {
        acpx: {
          enabled: true,
          config: {
            mcpBridge: {
              enabled: true,
              mode: "read-only-tools",
              allowTools: ["fased_gateway_identity"],
              denyTools: ["fased_push_test_request"],
            },
          },
        },
      },
    },
  } as FasedAgentConfig;
}

function makeInvokeParams(params: Record<string, unknown>) {
  const respond = vi.fn();
  const logGateway = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const client = {
    connId: "conn-operator",
    clientIp: "127.0.0.1",
    connect: {
      role: "operator",
      scopes: ["operator.write"],
      client: { id: "dashboard" },
      device: { id: "operator-laptop" },
    },
  };
  return {
    respond,
    invokePreview: async () =>
      await acpxPushTestHandlers["acpx.pushTest.preview"]({
        params,
        respond: respond as never,
        context: { logGateway } as never,
        client: client as never,
        req: { type: "req", id: "req-1", method: "acpx.pushTest.preview" },
        isWebchatConnect: () => false,
      }),
    invokeExecute: async () =>
      await acpxPushTestHandlers["acpx.pushTest.execute"]({
        params,
        respond: respond as never,
        context: { logGateway } as never,
        client: client as never,
        req: { type: "req", id: "req-2", method: "acpx.pushTest.execute" },
        isWebchatConnect: () => false,
      }),
    invokeHistory: async () =>
      await acpxPushTestHandlers["acpx.pushTest.auditHistory"]({
        params,
        respond: respond as never,
        context: { logGateway } as never,
        client: client as never,
        req: { type: "req", id: "req-3", method: "acpx.pushTest.auditHistory" },
        isWebchatConnect: () => false,
      }),
  };
}

describe("ACPX push-test gateway handlers", () => {
  beforeEach(() => {
    vi.mocked(loadConfig).mockReset();
    vi.mocked(loadApnsRegistration).mockReset();
    vi.mocked(normalizeApnsEnvironment).mockReset();
    vi.mocked(resolveApnsAuthConfigFromEnv).mockReset();
    vi.mocked(sendApnsAlert).mockReset();
    resetMutatingAdminRpcAuditHistoryForTest();
  });

  it("previews operator approval state without leaking push title or body", async () => {
    vi.mocked(loadConfig).mockReturnValue(enabledConfig());
    const { respond, invokePreview } = makeInvokeParams({
      nodeId: "ios-node-1",
      title: "secret title",
      body: "secret body",
    });

    await invokePreview();

    const call = respond.mock.calls[0] as [boolean, unknown?] | undefined;
    expect(call?.[0]).toBe(true);
    expect(call?.[1]).toMatchObject({
      kind: "acpx.mutating-wrapper.push-test.preview",
      wrapperId: "fased_push_test_request",
      method: "push.test",
      response: {
        status: "denied",
        stage: "operator-approval",
        safeSummary: {
          nodeId: "ios-node-1",
          titleProvided: true,
          bodyProvided: true,
        },
      },
    });
    const serialized = JSON.stringify(call?.[1]);
    expect(serialized).not.toContain("secret title");
    expect(serialized).not.toContain("secret body");
    expect(serialized).toContain("requestFingerprint");
    expect(sendApnsAlert).not.toHaveBeenCalled();
  });

  it("executes the fixed wrapper only after matching approval fingerprint and bridge enablement", async () => {
    vi.mocked(loadConfig).mockReturnValue(enabledConfig());
    vi.mocked(loadApnsRegistration).mockResolvedValue({
      nodeId: "ios-node-1",
      token: "abcd",
      topic: "ai.fased.ios",
      environment: "sandbox",
      updatedAtMs: 1,
    });
    vi.mocked(resolveApnsAuthConfigFromEnv).mockResolvedValue({
      ok: true,
      value: {
        teamId: "TEAM123",
        keyId: "KEY123",
        privateKey: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
      },
    });
    vi.mocked(normalizeApnsEnvironment).mockReturnValue(null);
    vi.mocked(sendApnsAlert).mockResolvedValue({
      ok: true,
      status: 200,
      tokenSuffix: "1234abcd",
      topic: "ai.fased.ios",
      environment: "sandbox",
    });

    const preview = makeInvokeParams({
      nodeId: "ios-node-1",
      title: "secret title",
      body: "secret body",
    });
    await preview.invokePreview();
    const previewPayload = preview.respond.mock.calls[0]?.[1] as {
      response: { requestFingerprint: string };
    };

    const execute = makeInvokeParams({
      nodeId: "ios-node-1",
      title: "secret title",
      body: "secret body",
      confirm: "EXECUTE_ACPX_PUSH_TEST",
      acceptedRequestFingerprint: previewPayload.response.requestFingerprint,
    });
    await execute.invokeExecute();

    const call = execute.respond.mock.calls[0] as [boolean, unknown?] | undefined;
    expect(call?.[0]).toBe(true);
    expect(call?.[1]).toMatchObject({
      wrapperId: "fased_push_test_request",
      method: "push.test",
      status: "executed",
      executionPerformed: true,
      noGenericDispatcher: true,
      result: {
        ok: true,
        status: 200,
        tokenSuffix: "1234abcd",
      },
    });
    expect(sendApnsAlert).toHaveBeenCalledTimes(1);
    const serialized = JSON.stringify(call?.[1]);
    expect(serialized).not.toContain("secret title");
    expect(serialized).not.toContain("secret body");
  });

  it("denies execution when the bridge is not in operator-approved push-test mode", async () => {
    vi.mocked(loadConfig).mockReturnValue(disabledConfig());
    const { respond, invokeExecute } = makeInvokeParams({
      nodeId: "ios-node-1",
      confirm: "EXECUTE_ACPX_PUSH_TEST",
      acceptedRequestFingerprint: "wrong",
    });

    await invokeExecute();

    const call = respond.mock.calls[0] as [boolean, unknown?] | undefined;
    expect(call?.[0]).toBe(true);
    expect(call?.[1]).toMatchObject({
      status: "denied",
      executionPerformed: false,
    });
    const serialized = JSON.stringify(call?.[1]);
    expect(serialized).toContain("ACPX push-test approval fingerprint does not match request");
    expect(sendApnsAlert).not.toHaveBeenCalled();
  });

  it("returns recent sanitized push-test audit and rate-limit outcomes", async () => {
    const logGateway = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const client = {
      connId: "conn-operator",
      clientIp: "127.0.0.1",
      connect: {
        role: "operator",
        scopes: ["operator.write"],
        client: { id: "dashboard" },
        device: { id: "operator-laptop" },
      },
    };
    logMutatingAdminRpcAudit({
      context: { logGateway } as never,
      client: client as never,
      method: "push.test",
      outcome: "denied",
      details: {
        reason: "rate_limited",
        limit: "3 per 60s",
        retryAfterMs: 30000,
        title: "secret title",
        body: "secret body",
        token: "secret token",
      },
    });
    logMutatingAdminRpcAudit({
      context: { logGateway } as never,
      client: null,
      method: "chat.inject",
      outcome: "succeeded",
      details: { message: "secret transcript" },
    });

    const { respond, invokeHistory } = makeInvokeParams({ limit: 10 });
    await invokeHistory();

    const call = respond.mock.calls[0] as [boolean, unknown?] | undefined;
    expect(call?.[0]).toBe(true);
    expect(call?.[1]).toMatchObject({
      schemaVersion: 1,
      kind: "acpx.mutating-wrapper.push-test.audit-history",
      wrapperId: "fased_push_test_request",
      method: "push.test",
      count: 1,
      events: [
        {
          method: "push.test",
          outcome: "denied",
          actor: "dashboard",
          details: {
            reason: "rate_limited",
            limit: "3_per_60s",
            retryAfterMs: "30000",
            title: "<redacted>",
            body: "<redacted>",
            token: "<redacted>",
          },
        },
      ],
    });
    const serialized = JSON.stringify(call?.[1]);
    expect(serialized).not.toContain("secret title");
    expect(serialized).not.toContain("secret body");
    expect(serialized).not.toContain("secret token");
    expect(serialized).not.toContain("secret transcript");
  });
});
