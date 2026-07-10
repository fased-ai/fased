import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../protocol/index.js";
import { servicesHandlers } from "./services.js";

const mocks = vi.hoisted(() => ({
  buildCapabilityReadinessReport: vi.fn(),
  loadConfig: vi.fn(),
  listConfiguredWebSearchProviders: vi.fn(),
  runWebSearch: vi.fn(),
  runGmailSetup: vi.fn(),
}));

vi.mock("../../capabilities/catalog.js", () => ({
  buildCapabilityReadinessReport: mocks.buildCapabilityReadinessReport,
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: mocks.loadConfig,
}));

vi.mock("../../web-search/runtime.js", () => ({
  listConfiguredWebSearchProviders: mocks.listConfiguredWebSearchProviders,
  runWebSearch: mocks.runWebSearch,
}));

vi.mock("../../hooks/gmail-ops.js", () => ({
  runGmailSetup: mocks.runGmailSetup,
}));

type RespondCall = [boolean, unknown?, { code: number; message: string }?];

async function invoke(params: Record<string, unknown> = {}) {
  const respond = vi.fn();
  await servicesHandlers["services.webSearch.test"]({
    params,
    respond: respond as never,
    context: {} as never,
    frame: {} as never,
    client: {} as never,
    req: { type: "req", id: "req-1", method: "services.webSearch.test" },
    isWebchatConnect: () => false,
  });
  return respond.mock.calls[0] as RespondCall | undefined;
}

describe("services.webSearch.test handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("tests the selected provider", async () => {
    const config = {
      tools: { web: { search: { enabled: true, provider: "gemini" } } },
    };
    mocks.loadConfig.mockReturnValue(config);
    mocks.runWebSearch.mockResolvedValue({ provider: "gemini", result: { ok: true, results: [] } });

    const call = await invoke();

    expect(mocks.runWebSearch).toHaveBeenCalledWith({
      config,
      args: { query: "Fased web_search connectivity test", count: 1 },
    });
    expect(call?.[0]).toBe(true);
    expect(call?.[1]).toMatchObject({ provider: "gemini" });
  });

  it("lists configured built-in and plugin web search providers", async () => {
    const config = {
      tools: { web: { search: { enabled: true, provider: "demo" } } },
    };
    mocks.loadConfig.mockReturnValue(config);
    mocks.listConfiguredWebSearchProviders.mockReturnValue([
      {
        id: "demo",
        label: "Demo Search",
        hint: "Plugin search",
        pluginId: "demo-search",
        envVars: ["DEMO_SEARCH_API_KEY"],
        placeholder: "demo-...",
        signupUrl: "https://example.test/demo",
        credentialPath: "plugins.entries.demo-search.config.webSearch.apiKey",
        requiresCredential: true,
      },
    ]);

    const respond = vi.fn();
    await servicesHandlers["services.webSearch.providers"]({
      params: {},
      respond: respond as never,
      context: {} as never,
      frame: {} as never,
      client: {} as never,
      req: { type: "req", id: "req-1", method: "services.webSearch.providers" },
      isWebchatConnect: () => false,
    });

    expect(mocks.listConfiguredWebSearchProviders).toHaveBeenCalledWith({ config });
    expect(respond.mock.calls[0]?.[0]).toBe(true);
    expect(respond.mock.calls[0]?.[1]).toMatchObject({
      providers: [
        {
          id: "demo",
          label: "Demo Search",
          credentialPath: "plugins.entries.demo-search.config.webSearch.apiKey",
        },
      ],
    });
  });

  it("returns the shared capability readiness report", async () => {
    const report = {
      entries: [{ id: "agent-core", state: "included" }],
      summary: { total: 1, errors: 0 },
    };
    mocks.buildCapabilityReadinessReport.mockReturnValue(report);
    const respond = vi.fn();
    await servicesHandlers["services.capabilities"]({
      params: {},
      respond: respond as never,
      context: {} as never,
      frame: {} as never,
      client: {} as never,
      req: { type: "req", id: "req-1", method: "services.capabilities" },
      isWebchatConnect: () => false,
    });
    expect(respond.mock.calls[0]).toEqual([true, report]);
  });

  it("returns unavailable when web_search is disabled", async () => {
    mocks.loadConfig.mockReturnValue({});
    mocks.runWebSearch.mockRejectedValue(new Error("web_search is disabled"));

    const call = await invoke();

    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.code).toBe(ErrorCodes.UNAVAILABLE);
    expect(call?.[2]?.message).toContain("web_search is disabled");
  });

  it("runs Gmail setup with provisioning params", async () => {
    mocks.runGmailSetup.mockResolvedValue({
      projectId: "demo",
      topic: "projects/demo/topics/gmail",
      subscription: "gmail-subscription",
    });

    const respond = vi.fn();
    await servicesHandlers["services.gmail.setup"]({
      params: {
        account: " ops@example.com ",
        project: "demo",
        topic: "gmail",
        subscription: "gmail-subscription",
        includeBody: true,
        maxBytes: "65536",
      },
      respond: respond as never,
      context: {} as never,
      frame: {} as never,
      client: {} as never,
      req: { type: "req", id: "req-1", method: "services.gmail.setup" },
      isWebchatConnect: () => false,
    });

    expect(mocks.runGmailSetup).toHaveBeenCalledWith(
      expect.objectContaining({
        account: "ops@example.com",
        project: "demo",
        topic: "gmail",
        subscription: "gmail-subscription",
        includeBody: true,
        maxBytes: 65536,
        json: true,
      }),
    );
    expect(respond.mock.calls[0]?.[0]).toBe(true);
    expect(respond.mock.calls[0]?.[1]).toMatchObject({ ok: true });
  });

  it("rejects Gmail setup without an account", async () => {
    const respond = vi.fn();
    await servicesHandlers["services.gmail.setup"]({
      params: {},
      respond: respond as never,
      context: {} as never,
      frame: {} as never,
      client: {} as never,
      req: { type: "req", id: "req-1", method: "services.gmail.setup" },
      isWebchatConnect: () => false,
    });

    expect(mocks.runGmailSetup).not.toHaveBeenCalled();
    expect(respond.mock.calls[0]?.[0]).toBe(false);
    expect(respond.mock.calls[0]?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
  });
});
