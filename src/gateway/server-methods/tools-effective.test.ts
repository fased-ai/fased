import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../protocol/index.js";
import { toolsEffectiveHandlers } from "./tools-effective.js";

const runtimeMocks = vi.hoisted(() => ({
  deliveryContextFromSession: vi.fn(() => ({
    channel: "telegram",
    to: "channel-1",
    accountId: "acct-1",
    threadId: "thread-2",
  })),
  listAgentIds: vi.fn(() => ["main"]),
  loadSessionEntry: vi.fn(() => ({
    cfg: {},
    canonicalKey: "main:abc",
    entry: {
      sessionId: "session-1",
      updatedAt: 1,
      lastChannel: "telegram",
      lastAccountId: "acct-1",
      lastThreadId: "thread-2",
      lastTo: "channel-1",
      groupId: "group-4",
      groupChannel: "#ops",
      space: "workspace-5",
      chatType: "group",
      modelProvider: "openai",
      model: "gpt-4.1",
    },
  })),
  resolveEffectiveToolInventory: vi.fn(() => ({
    agentId: "main",
    profile: "coding",
    groups: [
      {
        id: "core",
        label: "Built-in tools",
        source: "core",
        tools: [
          {
            id: "exec",
            label: "Exec",
            description: "Run shell commands",
            rawDescription: "Long internal shell command instructions",
            source: "core",
          },
        ],
      },
      {
        id: "plugin",
        label: "Connected tools",
        source: "plugin",
        tools: [
          {
            id: "docs_lookup",
            label: "Docs Lookup",
            description: "Search docs",
            rawDescription: "Long plugin instructions",
            source: "plugin",
            pluginId: "docs",
          },
        ],
      },
    ],
  })),
  resolveReplyToMode: vi.fn(() => "first"),
  resolveSessionAgentId: vi.fn(() => "main"),
  resolveSessionModelRef: vi.fn(() => ({ provider: "openai", model: "gpt-4.1" })),
}));

vi.mock("./tools-effective.runtime.js", () => runtimeMocks);

type RespondCall = [boolean, unknown?, { code: number; message: string }?];

function createInvokeParams(params: Record<string, unknown>, scopes?: string[]) {
  const respond = vi.fn();
  return {
    respond,
    invoke: () =>
      toolsEffectiveHandlers["tools.effective"]({
        params,
        respond: respond as never,
        context: { getRuntimeConfig: () => ({}) } as never,
        client: scopes ? ({ connect: { scopes } } as never) : null,
        req: { type: "req", id: "req-1", method: "tools.effective" },
        isWebchatConnect: () => false,
      }),
  };
}

function createInvokeParamsWithoutRuntimeConfig(params: Record<string, unknown>) {
  const respond = vi.fn();
  return {
    respond,
    invoke: () =>
      toolsEffectiveHandlers["tools.effective"]({
        params,
        respond: respond as never,
        context: {} as never,
        client: null,
        req: { type: "req", id: "req-1", method: "tools.effective" },
        isWebchatConnect: () => false,
      }),
  };
}

describe("tools.effective handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects missing sessionKey", async () => {
    const { respond, invoke } = createInvokeParams({});
    await invoke();
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(call?.[2]?.message).toContain("invalid tools.effective params");
  });

  it("rejects caller-supplied auth context params", async () => {
    const { respond, invoke } = createInvokeParams({
      sessionKey: "main:abc",
      senderIsOwner: true,
    });
    await invoke();
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(call?.[2]?.message).toContain("invalid tools.effective params");
  });

  it("rejects unknown agent ids before resolving session context", async () => {
    const { respond, invoke } = createInvokeParams({
      sessionKey: "main:abc",
      agentId: "unknown-agent",
    });
    await invoke();
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(call?.[2]?.message).toContain("unknown agent id");
    expect(runtimeMocks.loadSessionEntry).not.toHaveBeenCalled();
  });

  it("rejects unknown session keys", async () => {
    runtimeMocks.loadSessionEntry.mockReturnValueOnce({
      cfg: {},
      canonicalKey: "missing-session",
      entry: undefined,
      legacyKey: undefined,
      storePath: "/tmp/sessions.json",
    } as never);
    const { respond, invoke } = createInvokeParams({ sessionKey: "missing-session" });
    await invoke();
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(call?.[2]?.message).toContain('unknown session key "missing-session"');
  });

  it("rejects agent ids that do not match the session agent", async () => {
    runtimeMocks.listAgentIds.mockReturnValueOnce(["main", "other"]);
    const { respond, invoke } = createInvokeParams({
      sessionKey: "main:abc",
      agentId: "other",
    });
    await invoke();
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(call?.[2]?.message).toContain('agent id "other" does not match session agent "main"');
  });

  it("returns session-effective runtime inventory without raw descriptions", async () => {
    const { respond, invoke } = createInvokeParams({ sessionKey: "main:abc" });
    await invoke();

    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    expect(call?.[1]).toEqual({
      agentId: "main",
      profile: "coding",
      groups: [
        {
          id: "core",
          label: "Built-in tools",
          source: "core",
          tools: [
            {
              id: "exec",
              label: "Exec",
              description: "Run shell commands",
              source: "core",
            },
          ],
        },
        {
          id: "plugin",
          label: "Connected tools",
          source: "plugin",
          tools: [
            {
              id: "docs_lookup",
              label: "Docs Lookup",
              description: "Search docs",
              source: "plugin",
              pluginId: "docs",
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(call?.[1])).not.toContain("rawDescription");
    expect(runtimeMocks.resolveEffectiveToolInventory).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        sessionKey: "main:abc",
        senderIsOwner: false,
        currentChannelId: "channel-1",
        currentThreadTs: "thread-2",
        accountId: "acct-1",
        groupId: "group-4",
        groupChannel: "#ops",
        groupSpace: "workspace-5",
        replyToMode: "first",
        messageProvider: "telegram",
        modelProvider: "openai",
        modelId: "gpt-4.1",
      }),
    );
  });

  it("falls back to session config when request context has no runtime config getter", async () => {
    const { respond, invoke } = createInvokeParamsWithoutRuntimeConfig({ sessionKey: "main:abc" });
    await invoke();

    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    expect(runtimeMocks.loadSessionEntry).toHaveBeenCalledWith("main:abc");
  });

  it("sets senderIsOwner from admin scope only", async () => {
    const { respond, invoke } = createInvokeParams({ sessionKey: "main:abc" }, ["operator.admin"]);
    await invoke();

    expect(runtimeMocks.resolveEffectiveToolInventory).toHaveBeenCalledWith(
      expect.objectContaining({ senderIsOwner: true }),
    );
    expect((respond.mock.calls[0] as RespondCall | undefined)?.[0]).toBe(true);
  });

  it("falls back to origin thread id when delivery context omits thread metadata", async () => {
    runtimeMocks.loadSessionEntry.mockReturnValueOnce({
      cfg: {},
      canonicalKey: "main:abc",
      entry: {
        sessionId: "session-origin-thread",
        updatedAt: 1,
        lastChannel: "telegram",
        lastAccountId: "acct-1",
        lastTo: "channel-1",
        origin: {
          provider: "telegram",
          accountId: "acct-1",
          threadId: 42,
        },
        groupId: "group-4",
        groupChannel: "#ops",
        space: "workspace-5",
        chatType: "group",
        modelProvider: "openai",
        model: "gpt-4.1",
      },
    } as never);
    runtimeMocks.deliveryContextFromSession.mockReturnValueOnce({
      channel: "telegram",
      to: "channel-1",
      accountId: "acct-1",
      threadId: "42",
    });

    const { respond, invoke } = createInvokeParams({ sessionKey: "main:abc" });
    await invoke();

    expect(runtimeMocks.resolveEffectiveToolInventory).toHaveBeenCalledWith(
      expect.objectContaining({
        currentThreadTs: "42",
      }),
    );
    expect((respond.mock.calls[0] as RespondCall | undefined)?.[0]).toBe(true);
  });
});
