import type {
  LoadSessionRequest,
  NewSessionRequest,
  PromptRequest,
} from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import type { GatewayClient } from "../gateway/client.js";
import { createInMemorySessionStore } from "./session.js";
import { AcpGatewayAgent } from "./translator.js";
import { createAcpConnection, createAcpGateway } from "./translator.test-helpers.js";

function createNewSessionRequest(cwd = "/tmp"): NewSessionRequest {
  return {
    cwd,
    mcpServers: [],
    _meta: {},
  } as unknown as NewSessionRequest;
}

function createLoadSessionRequest(sessionId: string, cwd = "/tmp"): LoadSessionRequest {
  return {
    sessionId,
    cwd,
    mcpServers: [],
    _meta: {},
  } as unknown as LoadSessionRequest;
}

function createPromptRequest(
  sessionId: string,
  text: string,
  meta: Record<string, unknown> = {},
): PromptRequest {
  return {
    sessionId,
    prompt: [{ type: "text", text }],
    _meta: meta,
  } as unknown as PromptRequest;
}

async function expectOversizedPromptRejected(params: { sessionId: string; text: string }) {
  const request = vi.fn(async () => ({ ok: true })) as GatewayClient["request"];
  const sessionStore = createInMemorySessionStore();
  const agent = new AcpGatewayAgent(createAcpConnection(), createAcpGateway(request), {
    sessionStore,
  });
  await agent.loadSession(createLoadSessionRequest(params.sessionId));

  await expect(agent.prompt(createPromptRequest(params.sessionId, params.text))).rejects.toThrow(
    /maximum allowed size/i,
  );
  expect(request).not.toHaveBeenCalledWith("chat.send", expect.anything(), expect.anything());
  const session = sessionStore.getSession(params.sessionId);
  expect(session?.activeRunId).toBeNull();
  expect(session?.abortController).toBeNull();

  sessionStore.clearAllSessionsForTest();
}

describe("acp session creation rate limit", () => {
  it("ignores client-supplied MCP servers when creating and loading sessions", async () => {
    const sessionStore = createInMemorySessionStore();
    const agent = new AcpGatewayAgent(createAcpConnection(), createAcpGateway(), {
      sessionStore,
    });
    const mcpServers = [
      {
        name: "client-supplied",
        command: "node",
        args: ["evil.js"],
      },
    ];

    const created = await agent.newSession({
      ...createNewSessionRequest(),
      mcpServers,
    } as unknown as NewSessionRequest);
    const createdSession = sessionStore.getSession(created.sessionId);
    expect(createdSession).toBeDefined();
    expect(createdSession).not.toHaveProperty("mcpServers");

    await agent.loadSession({
      ...createLoadSessionRequest(created.sessionId),
      mcpServers,
    } as unknown as LoadSessionRequest);
    const loadedSession = sessionStore.getSession(created.sessionId);
    expect(loadedSession).toBeDefined();
    expect(loadedSession).not.toHaveProperty("mcpServers");

    sessionStore.clearAllSessionsForTest();
  });

  it("rate limits excessive newSession bursts", async () => {
    const sessionStore = createInMemorySessionStore();
    const agent = new AcpGatewayAgent(createAcpConnection(), createAcpGateway(), {
      sessionStore,
      sessionCreateRateLimit: {
        maxRequests: 2,
        windowMs: 60_000,
      },
    });

    await agent.newSession(createNewSessionRequest());
    await agent.newSession(createNewSessionRequest());
    await expect(agent.newSession(createNewSessionRequest())).rejects.toThrow(
      /session creation rate limit exceeded/i,
    );

    sessionStore.clearAllSessionsForTest();
  });

  it("does not count loadSession refreshes for an existing session ID", async () => {
    const sessionStore = createInMemorySessionStore();
    const agent = new AcpGatewayAgent(createAcpConnection(), createAcpGateway(), {
      sessionStore,
      sessionCreateRateLimit: {
        maxRequests: 1,
        windowMs: 60_000,
      },
    });

    await agent.loadSession(createLoadSessionRequest("shared-session"));
    await agent.loadSession(createLoadSessionRequest("shared-session"));
    await expect(agent.loadSession(createLoadSessionRequest("new-session"))).rejects.toThrow(
      /session creation rate limit exceeded/i,
    );

    sessionStore.clearAllSessionsForTest();
  });
});

describe("acp prompt size hardening", () => {
  it("rejects oversized prompt blocks without leaking active runs", async () => {
    await expectOversizedPromptRejected({
      sessionId: "prompt-limit-oversize",
      text: "a".repeat(2 * 1024 * 1024 + 1),
    });
  });

  it("rejects oversize final messages from cwd prefix without leaking active runs", async () => {
    await expectOversizedPromptRejected({
      sessionId: "prompt-limit-prefix",
      text: "a".repeat(2 * 1024 * 1024),
    });
  });
});
