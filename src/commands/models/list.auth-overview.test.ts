import { describe, expect, it } from "vitest";
import { resolveProviderAuthOverview } from "./list.auth-overview.js";

describe("resolveProviderAuthOverview", () => {
  it("reports configured local runtimes as local instead of signed-in profiles", () => {
    const overview = resolveProviderAuthOverview({
      provider: "ollama",
      cfg: {
        models: {
          providers: {
            ollama: {
              baseUrl: "http://172.28.64.1:11434",
              api: "ollama",
              apiKey: "ollama-local",
              models: [],
            },
          },
        },
      },
      store: {
        version: 1,
        profiles: {
          "ollama:default": {
            type: "api_key",
            provider: "ollama",
            key: "ollama-local",
          },
        },
      },
      modelsPath: "/tmp/models.json",
    });

    expect(overview.effective).toEqual({
      kind: "local",
      detail: "http://172.28.64.1:11434",
    });
  });

  it("does not throw when token profile only has tokenRef", () => {
    const overview = resolveProviderAuthOverview({
      provider: "github-copilot",
      cfg: {},
      store: {
        version: 1,
        profiles: {
          "github-copilot:default": {
            type: "token",
            provider: "github-copilot",
            tokenRef: { source: "env", provider: "default", id: "GITHUB_TOKEN" },
          },
        },
      } as never,
      modelsPath: "/tmp/models.json",
    });

    expect(overview.profiles.labels[0]).toContain("token:ref(env:GITHUB_TOKEN)");
  });
});
