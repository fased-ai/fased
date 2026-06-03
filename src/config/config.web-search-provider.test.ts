import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateConfigObject } from "./config.js";
import { buildWebSearchProviderConfig } from "./test-helpers.js";

vi.mock("../runtime.js", () => ({
  defaultRuntime: { log: vi.fn(), error: vi.fn() },
}));

const { __testing } = await import("../agents/tools/web-search.js");
const { resolveSearchProvider } = __testing;

describe("web search provider config", () => {
  it("accepts perplexity provider and config", () => {
    const res = validateConfigObject(
      buildWebSearchProviderConfig({
        enabled: true,
        provider: "perplexity",
        providerConfig: {
          apiKey: "test-key",
          baseUrl: "https://api.perplexity.ai",
          model: "perplexity/sonar-pro",
        },
      }),
    );

    expect(res.ok).toBe(true);
  });

  it("accepts gemini provider and config", () => {
    const res = validateConfigObject(
      buildWebSearchProviderConfig({
        enabled: true,
        provider: "gemini",
        providerConfig: {
          apiKey: "test-key",
          model: "gemini-2.5-flash",
        },
      }),
    );

    expect(res.ok).toBe(true);
  });

  it("accepts gemini provider with no extra config", () => {
    const res = validateConfigObject(
      buildWebSearchProviderConfig({
        provider: "gemini",
      }),
    );

    expect(res.ok).toBe(true);
  });

  it("accepts Exa, SearXNG, and Tavily provider config", () => {
    expect(
      validateConfigObject(
        buildWebSearchProviderConfig({
          provider: "exa",
          providerConfig: { apiKey: "exa-key", type: "auto" },
        }),
      ).ok,
    ).toBe(true);
    expect(
      validateConfigObject(
        buildWebSearchProviderConfig({
          provider: "searxng",
          providerConfig: { baseUrl: "http://127.0.0.1:8080", categories: "general" },
        }),
      ).ok,
    ).toBe(true);
    expect(
      validateConfigObject(
        buildWebSearchProviderConfig({
          provider: "tavily",
          providerConfig: { apiKey: "tvly-key", includeAnswer: true, searchDepth: "basic" },
        }),
      ).ok,
    ).toBe(true);
  });
});

describe("web search provider auto-detection", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.BRAVE_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.KIMI_API_KEY;
    delete process.env.MOONSHOT_API_KEY;
    delete process.env.PERPLEXITY_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.XAI_API_KEY;
    delete process.env.KIMI_API_KEY;
    delete process.env.MOONSHOT_API_KEY;
    delete process.env.EXA_API_KEY;
    delete process.env.FIRECRAWL_API_KEY;
    delete process.env.SEARXNG_BASE_URL;
    delete process.env.TAVILY_API_KEY;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    vi.restoreAllMocks();
  });

  it("falls back to duckduckgo when no keys are available", () => {
    expect(resolveSearchProvider({})).toBe("duckduckgo");
  });

  it("auto-detects brave when only BRAVE_API_KEY is set", () => {
    process.env.BRAVE_API_KEY = "test-brave-key";
    expect(resolveSearchProvider({})).toBe("brave");
  });

  it("auto-detects gemini when only GEMINI_API_KEY is set", () => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    expect(resolveSearchProvider({})).toBe("gemini");
  });

  it("auto-detects kimi when only KIMI_API_KEY is set", () => {
    process.env.KIMI_API_KEY = "test-kimi-key";
    expect(resolveSearchProvider({})).toBe("kimi");
  });

  it("auto-detects perplexity when only PERPLEXITY_API_KEY is set", () => {
    process.env.PERPLEXITY_API_KEY = "test-perplexity-key";
    expect(resolveSearchProvider({})).toBe("perplexity");
  });

  it("auto-detects grok when only XAI_API_KEY is set", () => {
    process.env.XAI_API_KEY = "test-xai-key";
    expect(resolveSearchProvider({})).toBe("grok");
  });

  it("auto-detects exa when only EXA_API_KEY is set", () => {
    process.env.EXA_API_KEY = "test-exa-key";
    expect(resolveSearchProvider({})).toBe("exa");
  });

  it("auto-detects tavily when only TAVILY_API_KEY is set", () => {
    process.env.TAVILY_API_KEY = "test-tavily-key";
    expect(resolveSearchProvider({})).toBe("tavily");
  });

  it("auto-detects firecrawl when only FIRECRAWL_API_KEY is set", () => {
    process.env.FIRECRAWL_API_KEY = "test-firecrawl-key";
    expect(resolveSearchProvider({})).toBe("firecrawl");
  });

  it("auto-detects searxng when only SEARXNG_BASE_URL is set", () => {
    process.env.SEARXNG_BASE_URL = "http://127.0.0.1:8080";
    expect(resolveSearchProvider({})).toBe("searxng");
  });

  it("auto-detects kimi when only KIMI_API_KEY is set", () => {
    process.env.KIMI_API_KEY = "test-kimi-key";
    expect(resolveSearchProvider({})).toBe("kimi");
  });

  it("auto-detects kimi when only MOONSHOT_API_KEY is set", () => {
    process.env.MOONSHOT_API_KEY = "test-moonshot-key";
    expect(resolveSearchProvider({})).toBe("kimi");
  });

  it("follows priority order — brave wins when multiple keys available", () => {
    process.env.BRAVE_API_KEY = "test-brave-key";
    process.env.GEMINI_API_KEY = "test-gemini-key";
    process.env.XAI_API_KEY = "test-xai-key";
    expect(resolveSearchProvider({})).toBe("brave");
  });

  it("gemini wins over perplexity and grok when brave unavailable", () => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    process.env.PERPLEXITY_API_KEY = "test-perplexity-key";
    expect(resolveSearchProvider({})).toBe("gemini");
  });

  it("explicit provider always wins regardless of keys", () => {
    process.env.BRAVE_API_KEY = "test-brave-key";
    expect(
      resolveSearchProvider({ provider: "gemini" } as unknown as Parameters<
        typeof resolveSearchProvider
      >[0]),
    ).toBe("gemini");
  });
});
