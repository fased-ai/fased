import { describe, it, expect, vi } from "vitest";
import type { FasedAgentConfig } from "../config/config.js";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import {
  buildAllowedModelSet,
  inferUniqueProviderFromConfiguredModels,
  parseModelRef,
  buildModelAliasIndex,
  modelKey,
  normalizeProviderId,
  resolveAllowedModelRef,
  resolveConfiguredModelRef,
  resolveModelRefFromString,
  resolvePersistedModelRef,
} from "./model-selection.js";

describe("model-selection", () => {
  describe("normalizeProviderId", () => {
    it("should normalize provider names", () => {
      expect(normalizeProviderId("Anthropic")).toBe("anthropic");
      expect(normalizeProviderId("Z.ai")).toBe("zai");
      expect(normalizeProviderId("z-ai")).toBe("zai");
      expect(normalizeProviderId("OpenCode-Zen")).toBe("opencode");
      expect(normalizeProviderId("qwen")).toBe("qwen");
      expect(normalizeProviderId("kimi-code")).toBe("kimi-coding");
      expect(normalizeProviderId("bedrock")).toBe("bedrock");
      expect(normalizeProviderId("aws-bedrock")).toBe("aws-bedrock");
      expect(normalizeProviderId("amazon-bedrock")).toBe("amazon-bedrock");
    });
  });

  describe("parseModelRef", () => {
    it("should parse full model refs", () => {
      expect(parseModelRef("anthropic/claude-3-5-sonnet", "openai")).toEqual({
        provider: "anthropic",
        model: "claude-3-5-sonnet",
      });
    });

    it("preserves nested model ids after provider prefix", () => {
      expect(parseModelRef("nvidia/moonshotai/kimi-k2.5", "anthropic")).toEqual({
        provider: "nvidia",
        model: "moonshotai/kimi-k2.5",
      });
    });

    it("normalizes anthropic alias refs to canonical model ids", () => {
      expect(parseModelRef("anthropic/opus-4.6", "openai")).toEqual({
        provider: "anthropic",
        model: "claude-opus-4-6",
      });
      expect(parseModelRef("opus-4.6", "anthropic")).toEqual({
        provider: "anthropic",
        model: "claude-opus-4-6",
      });
      expect(parseModelRef("anthropic/sonnet-4.6", "openai")).toEqual({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
      });
      expect(parseModelRef("sonnet-4.6", "anthropic")).toEqual({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
      });
    });

    it("should use default provider if none specified", () => {
      expect(parseModelRef("claude-3-5-sonnet", "anthropic")).toEqual({
        provider: "anthropic",
        model: "claude-3-5-sonnet",
      });
    });

    it("normalizes openai gpt-5.3 codex refs to openai-codex provider", () => {
      expect(parseModelRef("openai/gpt-5.3-codex", "anthropic")).toEqual({
        provider: "openai-codex",
        model: "gpt-5.3-codex",
      });
      expect(parseModelRef("gpt-5.3-codex", "openai")).toEqual({
        provider: "openai-codex",
        model: "gpt-5.3-codex",
      });
      expect(parseModelRef("openai/gpt-5.3-codex-codex", "anthropic")).toEqual({
        provider: "openai-codex",
        model: "gpt-5.3-codex-codex",
      });
    });

    it("should return null for empty strings", () => {
      expect(parseModelRef("", "anthropic")).toBeNull();
      expect(parseModelRef("  ", "anthropic")).toBeNull();
    });

    it("should preserve openrouter/ prefix for native models", () => {
      expect(parseModelRef("openrouter/aurora-alpha", "openai")).toEqual({
        provider: "openrouter",
        model: "openrouter/aurora-alpha",
      });
    });

    it("should pass through openrouter external provider models as-is", () => {
      expect(parseModelRef("openrouter/anthropic/claude-sonnet-4-5", "openai")).toEqual({
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4-5",
      });
    });

    it("normalizes Vercel Claude shorthand to anthropic-prefixed model ids", () => {
      expect(parseModelRef("vercel-ai-gateway/claude-opus-4.6", "openai")).toEqual({
        provider: "vercel-ai-gateway",
        model: "anthropic/claude-opus-4.6",
      });
      expect(parseModelRef("vercel-ai-gateway/opus-4.6", "openai")).toEqual({
        provider: "vercel-ai-gateway",
        model: "anthropic/claude-opus-4-6",
      });
    });

    it("keeps already-prefixed Vercel Anthropic models unchanged", () => {
      expect(parseModelRef("vercel-ai-gateway/anthropic/claude-opus-4.6", "openai")).toEqual({
        provider: "vercel-ai-gateway",
        model: "anthropic/claude-opus-4.6",
      });
    });

    it("normalizes Vercel OpenAI shorthand to openai-prefixed model ids", () => {
      expect(parseModelRef("vercel-ai-gateway/gpt-5.5", "openai")).toEqual({
        provider: "vercel-ai-gateway",
        model: "openai/gpt-5.5",
      });
      expect(parseModelRef("vercel-ai-gateway/openai/gpt-5.2", "openai")).toEqual({
        provider: "vercel-ai-gateway",
        model: "openai/gpt-5.2",
      });
    });

    it("should handle invalid slash usage", () => {
      expect(parseModelRef("/", "anthropic")).toBeNull();
      expect(parseModelRef("anthropic/", "anthropic")).toBeNull();
      expect(parseModelRef("/model", "anthropic")).toBeNull();
    });
  });

  describe("resolvePersistedModelRef", () => {
    it("preserves recorded provider when runtime model contains a vendor prefix", () => {
      expect(
        resolvePersistedModelRef({
          defaultProvider: "openai",
          runtimeProvider: "openrouter",
          runtimeModel: "anthropic/claude-haiku-4.5",
        }),
      ).toEqual({
        provider: "openrouter",
        model: "anthropic/claude-haiku-4.5",
      });
    });

    it("uses saved override provider with its own model field", () => {
      expect(
        resolvePersistedModelRef({
          defaultProvider: "openai",
          overrideProvider: "openrouter",
          overrideModel: "qwen/qwen3.6-flash",
        }),
      ).toEqual({
        provider: "openrouter",
        model: "qwen/qwen3.6-flash",
      });
    });

    it("parses legacy combined override model refs when provider is absent", () => {
      expect(
        resolvePersistedModelRef({
          defaultProvider: "openai",
          overrideModel: "ollama-beelink2/qwen2.5-coder:7b",
        }),
      ).toEqual({
        provider: "ollama-beelink2",
        model: "qwen2.5-coder:7b",
      });
    });

    it("returns null when neither runtime nor override model exists", () => {
      expect(resolvePersistedModelRef({ defaultProvider: "openai" })).toBeNull();
    });
  });

  describe("inferUniqueProviderFromConfiguredModels", () => {
    it("infers provider when configured model match is unique", () => {
      const cfg = {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-sonnet-4-6": {},
            },
          },
        },
      } as FasedAgentConfig;

      expect(
        inferUniqueProviderFromConfiguredModels({
          cfg,
          model: "claude-sonnet-4-6",
        }),
      ).toBe("anthropic");
    });

    it("returns undefined when configured matches are ambiguous", () => {
      const cfg = {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-sonnet-4-6": {},
              "minimax/claude-sonnet-4-6": {},
            },
          },
        },
      } as FasedAgentConfig;

      expect(
        inferUniqueProviderFromConfiguredModels({
          cfg,
          model: "claude-sonnet-4-6",
        }),
      ).toBeUndefined();
    });

    it("returns undefined for provider-prefixed model ids", () => {
      const cfg = {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-sonnet-4-6": {},
            },
          },
        },
      } as FasedAgentConfig;

      expect(
        inferUniqueProviderFromConfiguredModels({
          cfg,
          model: "anthropic/claude-sonnet-4-6",
        }),
      ).toBeUndefined();
    });

    it("infers provider for slash-containing model id when allowlist match is unique", () => {
      const cfg = {
        agents: {
          defaults: {
            models: {
              "vercel-ai-gateway/anthropic/claude-sonnet-4-6": {},
            },
          },
        },
      } as FasedAgentConfig;

      expect(
        inferUniqueProviderFromConfiguredModels({
          cfg,
          model: "anthropic/claude-sonnet-4-6",
        }),
      ).toBe("vercel-ai-gateway");
    });
  });

  describe("buildModelAliasIndex", () => {
    it("should build alias index from config", () => {
      const cfg: Partial<FasedAgentConfig> = {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-3-5-sonnet": { alias: "fast" },
              "openai/gpt-4o": { alias: "smart" },
            },
          },
        },
      };

      const index = buildModelAliasIndex({
        cfg: cfg,
        defaultProvider: "anthropic",
      });

      expect(index.byAlias.get("fast")?.ref).toEqual({
        provider: "anthropic",
        model: "claude-3-5-sonnet",
      });
      expect(index.byAlias.get("smart")?.ref).toEqual({ provider: "openai", model: "gpt-4o" });
      expect(index.byKey.get(modelKey("anthropic", "claude-3-5-sonnet"))).toEqual(["fast"]);
    });
  });

  describe("buildAllowedModelSet", () => {
    it("keeps explicitly allowlisted models even when missing from bundled catalog", () => {
      const cfg: FasedAgentConfig = {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.2" },
            models: {
              "anthropic/claude-sonnet-4-6": { alias: "sonnet" },
            },
          },
        },
      } as FasedAgentConfig;

      const catalog = [
        { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
        { provider: "openai", id: "gpt-5.2", name: "gpt-5.2" },
      ];

      const result = buildAllowedModelSet({
        cfg,
        catalog,
        defaultProvider: "anthropic",
      });

      expect(result.allowAny).toBe(false);
      expect(result.allowedKeys.has("anthropic/claude-sonnet-4-6")).toBe(true);
      expect(result.allowedCatalog).toEqual([
        { provider: "anthropic", id: "claude-sonnet-4-6", name: "claude-sonnet-4-6" },
      ]);
    });

    it("adds catalog models from authenticated providers to a configured allowlist", () => {
      const cfg: FasedAgentConfig = {
        agents: {
          defaults: {
            models: {
              "openrouter/openrouter/auto": {},
            },
          },
        },
      } as FasedAgentConfig;

      const catalog = [
        { provider: "openrouter", id: "openrouter/auto", name: "OpenRouter Auto" },
        { provider: "openai", id: "gpt-5.5", name: "GPT-5.5" },
        { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
      ];

      const result = buildAllowedModelSet({
        cfg,
        catalog,
        defaultProvider: "openrouter",
        additionalAllowedProviders: ["openai"],
      });

      expect(result.allowAny).toBe(false);
      expect(result.allowedCatalog.map((entry) => `${entry.provider}/${entry.id}`)).toEqual([
        "openrouter/openrouter/auto",
        "openai/gpt-5.5",
      ]);
      expect(result.allowedKeys.has("anthropic/claude-sonnet-4-6")).toBe(false);
    });

    it("treats configured task model roles as allowed model refs", () => {
      const cfg: FasedAgentConfig = {
        agents: {
          defaults: {
            model: { primary: "openrouter/auto" },
            models: {
              "openrouter/openrouter/auto": {},
            },
            taskModels: {
              cheapCheck: "openrouter/z-ai/glm-5.1",
              escalation: "openrouter/qwen/qwen3.6-flash",
            },
          },
        },
      } as FasedAgentConfig;

      const result = buildAllowedModelSet({
        cfg,
        catalog: [{ provider: "openrouter", id: "openrouter/auto", name: "OpenRouter Auto" }],
        defaultProvider: "openrouter",
      });

      expect(result.allowAny).toBe(false);
      expect(result.allowedKeys.has("openrouter/z-ai/glm-5.1")).toBe(true);
      expect(result.allowedKeys.has("openrouter/qwen/qwen3.6-flash")).toBe(true);
      expect(result.allowedCatalog.map((entry) => `${entry.provider}/${entry.id}`)).toEqual([
        "openrouter/openrouter/auto",
        "openrouter/z-ai/glm-5.1",
        "openrouter/qwen/qwen3.6-flash",
      ]);
    });

    it("treats per-agent task model roles and fallbacks as allowed model refs", () => {
      const cfg: FasedAgentConfig = {
        agents: {
          defaults: {
            models: {
              "openrouter/openrouter/auto": {},
            },
          },
          list: [
            {
              id: "main",
              model: {
                primary: "openrouter/openrouter/auto",
                fallbacks: ["openrouter/z-ai/glm-5.1"],
              },
              taskModels: {
                cheapCheck: "openrouter/qwen/qwen3.6-flash",
                escalation: "openrouter/deepseek/deepseek-chat",
              },
            },
          ],
        },
      } as FasedAgentConfig;

      const result = buildAllowedModelSet({
        cfg,
        catalog: [{ provider: "openrouter", id: "openrouter/auto", name: "OpenRouter Auto" }],
        defaultProvider: "openrouter",
      });

      expect(result.allowAny).toBe(false);
      expect(result.allowedKeys.has("openrouter/z-ai/glm-5.1")).toBe(true);
      expect(result.allowedKeys.has("openrouter/qwen/qwen3.6-flash")).toBe(true);
      expect(result.allowedKeys.has("openrouter/deepseek/deepseek-chat")).toBe(true);
      expect(result.allowedCatalog.map((entry) => `${entry.provider}/${entry.id}`)).toEqual([
        "openrouter/openrouter/auto",
        "openrouter/z-ai/glm-5.1",
        "openrouter/qwen/qwen3.6-flash",
        "openrouter/deepseek/deepseek-chat",
      ]);
    });

    it("allows provider model IDs with slashes when they are the selected default model", () => {
      const cfg: FasedAgentConfig = {
        agents: {
          defaults: {
            models: {
              "openrouter/openrouter/auto": {},
            },
          },
        },
      } as FasedAgentConfig;

      const result = buildAllowedModelSet({
        cfg,
        catalog: [
          { provider: "openrouter", id: "openrouter/auto", name: "OpenRouter Auto" },
          { provider: "openrouter", id: "z-ai/glm-5.1", name: "Z.ai GLM 5.1" },
        ],
        defaultProvider: "openrouter",
        defaultModel: "z-ai/glm-5.1",
      });

      expect(result.allowAny).toBe(false);
      expect(result.allowedKeys.has("openrouter/z-ai/glm-5.1")).toBe(true);
      expect(result.allowedCatalog.map((entry) => `${entry.provider}/${entry.id}`)).toEqual([
        "openrouter/openrouter/auto",
        "openrouter/z-ai/glm-5.1",
      ]);
    });
  });

  describe("resolveAllowedModelRef", () => {
    it("accepts explicit allowlist refs absent from bundled catalog", () => {
      const cfg: FasedAgentConfig = {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.2" },
            models: {
              "anthropic/claude-sonnet-4-6": { alias: "sonnet" },
            },
          },
        },
      } as FasedAgentConfig;

      const catalog = [
        { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
        { provider: "openai", id: "gpt-5.2", name: "gpt-5.2" },
      ];

      const result = resolveAllowedModelRef({
        cfg,
        catalog,
        raw: "anthropic/claude-sonnet-4-6",
        defaultProvider: "openai",
        defaultModel: "gpt-5.2",
      });

      expect(result).toEqual({
        key: "anthropic/claude-sonnet-4-6",
        ref: { provider: "anthropic", model: "claude-sonnet-4-6" },
      });
    });

    it("strips trailing auth profile suffix before allowlist matching", () => {
      const cfg: FasedAgentConfig = {
        agents: {
          defaults: {
            models: {
              "openai/@cf/openai/gpt-oss-20b": {},
            },
          },
        },
      } as FasedAgentConfig;

      const result = resolveAllowedModelRef({
        cfg,
        catalog: [],
        raw: "openai/@cf/openai/gpt-oss-20b@cf:default",
        defaultProvider: "anthropic",
      });

      expect(result).toEqual({
        key: "openai/@cf/openai/gpt-oss-20b",
        ref: { provider: "openai", model: "@cf/openai/gpt-oss-20b" },
      });
    });

    it("allows selecting catalog models from authenticated providers", () => {
      const cfg: FasedAgentConfig = {
        agents: {
          defaults: {
            models: {
              "openrouter/openrouter/auto": {},
            },
          },
        },
      } as FasedAgentConfig;

      const result = resolveAllowedModelRef({
        cfg,
        catalog: [
          { provider: "openrouter", id: "openrouter/auto", name: "OpenRouter Auto" },
          { provider: "openai", id: "gpt-5.5", name: "GPT-5.5" },
        ],
        raw: "openai/gpt-5.5",
        defaultProvider: "openrouter",
        additionalAllowedProviders: ["openai"],
      });

      expect(result).toEqual({
        key: "openai/gpt-5.5",
        ref: { provider: "openai", model: "gpt-5.5" },
      });
    });

    it("accepts OpenRouter slash IDs when they are the selected default model", () => {
      const cfg: FasedAgentConfig = {
        agents: {
          defaults: {
            models: {
              "openrouter/openrouter/auto": {},
            },
          },
        },
      } as FasedAgentConfig;

      const result = resolveAllowedModelRef({
        cfg,
        catalog: [
          { provider: "openrouter", id: "openrouter/auto", name: "OpenRouter Auto" },
          { provider: "openrouter", id: "z-ai/glm-5.1", name: "Z.ai GLM 5.1" },
        ],
        raw: "openrouter/z-ai/glm-5.1",
        defaultProvider: "openrouter",
        defaultModel: "z-ai/glm-5.1",
      });

      expect(result).toEqual({
        key: "openrouter/z-ai/glm-5.1",
        ref: { provider: "openrouter", model: "z-ai/glm-5.1" },
      });
    });
  });

  describe("resolveModelRefFromString", () => {
    it("should resolve from string with alias", () => {
      const index = {
        byAlias: new Map([
          ["fast", { alias: "fast", ref: { provider: "anthropic", model: "sonnet" } }],
        ]),
        byKey: new Map(),
      };

      const resolved = resolveModelRefFromString({
        raw: "fast",
        defaultProvider: "openai",
        aliasIndex: index,
      });

      expect(resolved?.ref).toEqual({ provider: "anthropic", model: "sonnet" });
      expect(resolved?.alias).toBe("fast");
    });

    it("should resolve direct ref if no alias match", () => {
      const resolved = resolveModelRefFromString({
        raw: "openai/gpt-4",
        defaultProvider: "anthropic",
      });
      expect(resolved?.ref).toEqual({ provider: "openai", model: "gpt-4" });
    });

    it("strips trailing profile suffix for simple model refs", () => {
      const resolved = resolveModelRefFromString({
        raw: "gpt-5@myprofile",
        defaultProvider: "openai",
      });
      expect(resolved?.ref).toEqual({ provider: "openai", model: "gpt-5" });
    });

    it("strips trailing profile suffix for provider/model refs", () => {
      const resolved = resolveModelRefFromString({
        raw: "google/gemini-flash-latest@google:bevfresh",
        defaultProvider: "anthropic",
      });
      expect(resolved?.ref).toEqual({
        provider: "google",
        model: "gemini-flash-latest",
      });
    });

    it("preserves Cloudflare @cf model segments", () => {
      const resolved = resolveModelRefFromString({
        raw: "openai/@cf/openai/gpt-oss-20b",
        defaultProvider: "anthropic",
      });
      expect(resolved?.ref).toEqual({
        provider: "openai",
        model: "@cf/openai/gpt-oss-20b",
      });
    });

    it("preserves OpenRouter @preset model segments", () => {
      const resolved = resolveModelRefFromString({
        raw: "openrouter/@preset/kimi-2-5",
        defaultProvider: "anthropic",
      });
      expect(resolved?.ref).toEqual({
        provider: "openrouter",
        model: "@preset/kimi-2-5",
      });
    });

    it("splits trailing profile suffix after OpenRouter preset paths", () => {
      const resolved = resolveModelRefFromString({
        raw: "openrouter/@preset/kimi-2-5@work",
        defaultProvider: "anthropic",
      });
      expect(resolved?.ref).toEqual({
        provider: "openrouter",
        model: "@preset/kimi-2-5",
      });
    });

    it("strips profile suffix before alias resolution", () => {
      const index = {
        byAlias: new Map([
          ["kimi", { alias: "kimi", ref: { provider: "nvidia", model: "moonshotai/kimi-k2.5" } }],
        ]),
        byKey: new Map(),
      };

      const resolved = resolveModelRefFromString({
        raw: "kimi@nvidia:default",
        defaultProvider: "openai",
        aliasIndex: index,
      });
      expect(resolved?.ref).toEqual({
        provider: "nvidia",
        model: "moonshotai/kimi-k2.5",
      });
      expect(resolved?.alias).toBe("kimi");
    });
  });

  describe("resolveConfiguredModelRef", () => {
    it("should fall back to anthropic and warn if provider is missing for non-alias", () => {
      setLoggerOverride({ level: "silent", consoleLevel: "warn" });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const cfg: Partial<FasedAgentConfig> = {
          agents: {
            defaults: {
              model: { primary: "claude-3-5-sonnet" },
            },
          },
        };

        const result = resolveConfiguredModelRef({
          cfg: cfg,
          defaultProvider: "google",
          defaultModel: "gemini-pro",
        });

        expect(result).toEqual({ provider: "anthropic", model: "claude-3-5-sonnet" });
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('Falling back to "anthropic/claude-3-5-sonnet"'),
        );
      } finally {
        setLoggerOverride(null);
        resetLogger();
      }
    });

    it("should use default provider/model if config is empty", () => {
      const cfg: Partial<FasedAgentConfig> = {};
      const result = resolveConfiguredModelRef({
        cfg: cfg,
        defaultProvider: "openai",
        defaultModel: "gpt-4",
      });
      expect(result).toEqual({ provider: "openai", model: "gpt-4" });
    });
  });
});
