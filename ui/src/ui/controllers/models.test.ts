import { describe, expect, it, vi } from "vitest";
import { loadModels } from "./models.ts";

describe("loadModels", () => {
  it("passes the selected session key to models.list", async () => {
    const request = vi.fn(async () => ({
      models: [{ id: "openrouter/auto", provider: "openrouter", name: "OpenRouter Auto" }],
    }));

    const models = await loadModels({ request } as unknown as Parameters<typeof loadModels>[0], {
      sessionKey: " agent:trader:main ",
    });

    expect(request).toHaveBeenCalledWith("models.list", {
      includeMetadata: true,
      sessionKey: "agent:trader:main",
    });
    expect(models).toEqual([
      { id: "openrouter/auto", provider: "openrouter", name: "OpenRouter Auto" },
    ]);
  });

  it("omits an empty session key", async () => {
    const request = vi.fn(async () => ({ models: [] }));

    await loadModels({ request } as unknown as Parameters<typeof loadModels>[0], {
      sessionKey: "   ",
    });

    expect(request).toHaveBeenCalledWith("models.list", {
      includeMetadata: true,
    });
  });

  it("passes full catalog and provider filters to models.list", async () => {
    const request = vi.fn(async () => ({ models: [] }));

    await loadModels({ request } as unknown as Parameters<typeof loadModels>[0], {
      all: true,
      provider: " openai-codex ",
    });

    expect(request).toHaveBeenCalledWith("models.list", {
      includeMetadata: true,
      all: true,
      provider: "openai-codex",
    });
  });

  it("requests the authenticated provider catalog independently of Agent allowlists", async () => {
    const request = vi.fn(async () => ({ models: [] }));

    await loadModels({ request } as unknown as Parameters<typeof loadModels>[0], {
      available: true,
      sessionKey: "agent:main:main",
    });

    expect(request).toHaveBeenCalledWith("models.list", {
      includeMetadata: true,
      available: true,
      sessionKey: "agent:main:main",
    });
  });

  it("falls back to legacy models.list when the running gateway rejects sessionKey", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("invalid models.list params: unexpected property sessionKey"),
      )
      .mockResolvedValueOnce({
        models: [{ id: "gpt-5.4-mini", provider: "openai", name: "GPT-5.4 Mini" }],
      });

    const models = await loadModels({ request } as unknown as Parameters<typeof loadModels>[0], {
      sessionKey: "agent:main:main",
    });

    expect(request).toHaveBeenNthCalledWith(1, "models.list", {
      includeMetadata: true,
      sessionKey: "agent:main:main",
    });
    expect(request).toHaveBeenNthCalledWith(2, "models.list", {
      includeMetadata: true,
    });
    expect(models).toEqual([{ id: "gpt-5.4-mini", provider: "openai", name: "GPT-5.4 Mini" }]);
  });
});
