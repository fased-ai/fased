import { describe, expect, it } from "vitest";
import { FasedAgentSchema } from "./zod-schema.js";

describe("agent runtime config schema", () => {
  it("accepts SecretRef web-search keys and Firecrawl fetch config", () => {
    const parsed = FasedAgentSchema.safeParse({
      tools: {
        web: {
          search: {
            enabled: true,
            provider: "gemini",
            gemini: {
              apiKey: {
                source: "env",
                provider: "default",
                id: "GEMINI_API_KEY",
              },
            },
          },
          fetch: {
            enabled: true,
            readability: true,
            firecrawl: {
              enabled: true,
              apiKey: {
                source: "env",
                provider: "default",
                id: "FIRECRAWL_API_KEY",
              },
              baseUrl: "https://api.firecrawl.dev",
              onlyMainContent: true,
              maxAgeMs: 1000,
              timeoutSeconds: 15,
            },
          },
        },
      },
    });

    expect(parsed.success).toBe(true);
  });
});
