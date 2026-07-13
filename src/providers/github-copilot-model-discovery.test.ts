import { describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../agents/auth-profiles.js";
import type { FasedAgentConfig } from "../config/types.js";
import { discoverGitHubCopilotModels } from "./github-copilot-model-discovery.js";

const resolveCopilotApiToken = vi.hoisted(() => vi.fn());

vi.mock("./github-copilot-token.js", () => ({
  resolveCopilotApiToken,
}));

describe("GitHub Copilot account model discovery", () => {
  it("exchanges the stored GitHub credential and returns the account catalog", async () => {
    resolveCopilotApiToken.mockResolvedValue({
      token: "copilot-runtime-token",
      expiresAt: Date.now() + 60_000,
      source: "test",
      baseUrl: "https://api.individual.githubcopilot.com",
    });
    const store = {
      version: 1,
      profiles: {
        "github-copilot:default": {
          type: "oauth",
          provider: "github-copilot",
          access: "github-access",
          refresh: "github-refresh",
          expires: Date.now() + 60_000,
        },
      },
    } satisfies AuthProfileStore;
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer copilot-runtime-token",
        "X-Github-Api-Version": "2025-04-01",
      });
      return Response.json({
        data: [
          {
            id: "gpt-5.5",
            capabilities: { vision: { supported: true }, tools: { supported: true } },
            context_window: 128_000,
          },
          { id: "claude-sonnet-5" },
        ],
      });
    });

    const models = await discoverGitHubCopilotModels({
      cfg: {} as FasedAgentConfig,
      store,
      fetchImpl,
    });

    expect(resolveCopilotApiToken).toHaveBeenCalledWith({
      githubToken: "github-access",
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.individual.githubcopilot.com/models",
      expect.any(Object),
    );
    expect(models).toEqual([
      expect.objectContaining({
        id: "gpt-5.5",
        input: ["text", "image"],
        tools: true,
        contextWindow: 128_000,
        source: "github-copilot-account",
      }),
      expect.objectContaining({ id: "claude-sonnet-5", source: "github-copilot-account" }),
    ]);
  });
});
