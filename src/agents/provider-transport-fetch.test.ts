import type { Model } from "@mariozechner/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { attachModelProviderRequestTransport } from "./provider-request-config.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

const { buildGuardedModelFetch } = await import("./provider-transport-fetch.js");

function buildModel(): Model<"openai-completions"> {
  return {
    id: "local-large",
    name: "Local Large",
    api: "openai-completions",
    provider: "local-vllm",
    baseUrl: "http://127.0.0.1:8000/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 4096,
  };
}

describe("provider transport fetch private-network policy", () => {
  beforeEach(() => {
    fetchWithSsrFGuardMock.mockReset();
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response("ok"),
      release: vi.fn(),
    });
  });

  it("does not allow private network by default", async () => {
    const fetch = buildGuardedModelFetch(
      attachModelProviderRequestTransport(buildModel(), { allowPrivateNetwork: false }),
    );

    await fetch("http://127.0.0.1:8000/v1/chat/completions");

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.not.objectContaining({
        policy: { allowPrivateNetwork: true },
      }),
    );
  });

  it("allows private network only with explicit model-provider opt-in", async () => {
    const fetch = buildGuardedModelFetch(
      attachModelProviderRequestTransport(buildModel(), { allowPrivateNetwork: true }),
    );

    await fetch("http://127.0.0.1:8000/v1/chat/completions");

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        policy: { allowPrivateNetwork: true },
      }),
    );
  });
});
