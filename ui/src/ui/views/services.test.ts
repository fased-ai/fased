import { describe, expect, it, vi } from "vitest";

type LitTemplateLike = {
  strings?: ArrayLike<string>;
  values?: unknown[];
};

function flattenTemplateText(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((entry) => flattenTemplateText(entry)).join(" ");
  }
  if (value && typeof value === "object") {
    const template = value as LitTemplateLike;
    if (template.strings && Array.isArray(template.values)) {
      return [
        ...Array.from(template.strings),
        ...template.values.map((entry) => flattenTemplateText(entry)),
      ].join(" ");
    }
  }
  return typeof value === "string" ? value : "";
}

describe("renderServices", () => {
  it("explains services as APIs separate from channels and extensions", async () => {
    const { renderServices } = await import("./services.ts");
    const text = flattenTemplateText(
      renderServices({
        configForm: null,
        skillsReport: null,
        skillsLoading: false,
        pluginsMarketplace: null,
        configSaving: false,
        configDirty: false,
        onNavigate: vi.fn(),
        onConfigPatch: vi.fn(),
        onConfigSave: vi.fn(),
        onConfigReload: vi.fn(),
      }),
    );

    expect(text).toContain("Services");
    expect(text).toContain("Gmail");
    expect(text).toContain("Web/search");
    expect(text).toContain("Talk / TTS");
    expect(text).toContain("Channels are chat apps");
    expect(text).toContain("Extensions are runtime code");
    expect(text).toContain("Services connect APIs");
    expect(text).toContain("Agent > Tools grants or blocks");
    expect(text).not.toContain("Wallet and mining");
    expect(text).not.toContain("Custom APIs");
    expect(text).not.toContain("Attach to agent");
    expect(text).not.toContain("Advanced Config");
  });

  it("shows connector status and quick config for real service families", async () => {
    const { renderServices } = await import("./services.ts");
    const text = flattenTemplateText(
      renderServices({
        configForm: {
          hooks: {
            gmail: {
              account: "ops@example.com",
              project: "ops-project",
              topic: "gmail-topic",
              subscription: "gmail-subscription",
              hookUrl: "https://example.test/hooks/gmail",
              serve: { port: 8788, path: "/gmail-pubsub" },
              tailscale: { mode: "funnel", path: "/gmail-pubsub" },
            },
          },
          tools: {
            web: {
              search: { enabled: true, provider: "brave", apiKey: "redacted" },
              fetch: {
                enabled: false,
                firecrawl: { enabled: true, apiKey: "fc-redacted" },
              },
            },
            media: {
              image: { enabled: true, models: [{ provider: "openai", model: "gpt-image" }] },
            },
          },
          browser: { enabled: true },
          talk: {
            provider: "elevenlabs",
            providers: {
              elevenlabs: {
                apiKey: "talk-redacted",
                voiceId: "voice-123",
                modelId: "eleven_multilingual_v2",
              },
            },
            interruptOnSpeech: true,
          },
          skills: {
            entries: {
              "gh-issues": {
                apiKey: "github-token",
              },
            },
          },
        },
        skillsReport: {
          workspaceDir: "/tmp/workspace",
          managedSkillsDir: "/tmp/skills",
          skills: [
            {
              name: "gog",
              description: "Google Workspace",
              source: "bundled",
              filePath: "/tmp/gog/SKILL.md",
              baseDir: "/tmp/gog",
              skillKey: "gog",
              always: false,
              disabled: false,
              blockedByAllowlist: false,
              eligible: true,
              requirements: { bins: ["gog"], env: [], config: [], os: [] },
              missing: { bins: ["gog"], env: [], config: [], os: [] },
              configChecks: [],
              install: [{ id: "brew", kind: "brew", label: "Install gog", bins: ["gog"] }],
            },
            {
              name: "github",
              description: "GitHub CLI",
              source: "bundled",
              filePath: "/tmp/github/SKILL.md",
              baseDir: "/tmp/github",
              skillKey: "github",
              always: false,
              disabled: false,
              blockedByAllowlist: false,
              eligible: true,
              requirements: { bins: [], env: [], config: [], os: [] },
              missing: { bins: [], env: [], config: [], os: [] },
              configChecks: [],
              install: [],
            },
          ],
        },
        skillsLoading: false,
        pluginsMarketplace: {
          agentId: "main",
          diagnostics: [],
          plugins: [
            {
              id: "custom-api",
              name: "Custom API",
              description: "Custom API bridge",
              status: "installed",
              source: "local",
              version: "1.0.0",
              enabled: true,
              installed: true,
              services: ["custom.api"],
              diagnostics: { errors: [], warnings: [], info: [] },
            } as never,
          ],
        },
        configSaving: false,
        configDirty: false,
        onNavigate: vi.fn(),
        onConfigPatch: vi.fn(),
        onConfigSave: vi.fn(),
        onConfigReload: vi.fn(),
      }),
    );

    expect(text).toContain("Ready");
    expect(text).toContain("Setup needed");
    expect(text).toContain("Google Workspace");
    expect(text).toContain("Gmail hook configured");
    expect(text).toContain("GCP project");
    expect(text).toContain("Pub/Sub topic");
    expect(text).toContain("Subscription");
    expect(text).toContain("Hook URL");
    expect(text).toContain("Serve port");
    expect(text).toContain("Tailscale path");
    expect(text).toContain("Save Gmail");
    expect(text).toContain("Clear Gmail");
    expect(text).toContain("Provision Gmail");
    expect(text).toContain("gog needs setup");
    expect(text).toContain("GitHub");
    expect(text).toContain("GitHub token configured");
    expect(text).toContain("Credential source");
    expect(text).toContain("Env SecretRef");
    expect(text).toContain("GitHub token");
    expect(text).toContain("GH_TOKEN");
    expect(text).toContain("GitHub OAuth/App auth needs a");
    expect(text).toContain("Save GitHub");
    expect(text).toContain("Clear GitHub");
    expect(text).toContain("Web/search");
    expect(text).toContain("web_search enabled");
    expect(text).toContain("web_fetch off");
    expect(text).toContain("Save Web/search");
    expect(text).toContain("Firecrawl");
    expect(text).toContain("fallback ready");
    expect(text).toContain("Save Firecrawl");
    expect(text).toContain("Media and browser");
    expect(text).toContain("browser enabled");
    expect(text).toContain("image enabled");
    expect(text).toContain("Save Media");
    expect(text).toContain("Talk / TTS");
    expect(text).toContain("elevenlabs");
    expect(text).toContain("Voice ID");
    expect(text).toContain("Model ID");
    expect(text).toContain("Save Talk");
    expect(text).toContain("Open Nodes");
    expect(text).not.toContain("Changes");
    expect(text).not.toContain("Wallet and mining");
    expect(text).not.toContain("Custom APIs");
    expect(text).not.toContain("extension services");
    expect(text).not.toContain("Task access recovery");
    expect(text).not.toContain("Attach to agent");
    expect(text).toContain("Save");
  });

  it("renders plugin web-search providers from the runtime provider list", async () => {
    const { renderServices } = await import("./services.ts");
    const text = flattenTemplateText(
      renderServices({
        configForm: {
          tools: {
            web: {
              search: { enabled: true, provider: "demo" },
            },
          },
          plugins: {
            entries: {
              "demo-search": {
                config: {
                  webSearch: {
                    apiKey: { source: "env", provider: "default", id: "DEMO_SEARCH_API_KEY" },
                  },
                },
              },
            },
          },
        },
        skillsReport: null,
        skillsLoading: false,
        pluginsMarketplace: null,
        webSearchProviders: [
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
        ],
        configSaving: false,
        configDirty: false,
        onNavigate: vi.fn(),
        onConfigPatch: vi.fn(),
        onConfigSave: vi.fn(),
        onConfigReload: vi.fn(),
      }),
    );

    expect(text).toContain("Demo Search");
    expect(text).toContain("Credential source");
    expect(text).toContain("Env SecretRef");
    expect(text).toContain("DEMO_SEARCH_API_KEY");
    expect(text).toContain("web_search enabled");
  });
});
