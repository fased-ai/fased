import { describe, expect, it } from "vitest";
import type { FasedAgentConfig } from "../config/config.js";
import { resolveCliBackendConfig } from "./cli-backends.js";

describe("resolveCliBackendConfig reliability merge", () => {
  it("clears inherited Claude provider-routing and auth env by default", () => {
    const resolved = resolveCliBackendConfig("claude-cli");

    expect(resolved).not.toBeNull();
    expect(resolved?.config.env).toEqual({
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
    });
    expect(resolved?.config.clearEnv).toEqual(
      expect.arrayContaining([
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_API_KEY_OLD",
        "ANTHROPIC_API_TOKEN",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_CUSTOM_HEADERS",
        "ANTHROPIC_OAUTH_TOKEN",
        "ANTHROPIC_UNIX_SOCKET",
        "CLAUDE_CONFIG_DIR",
        "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "CLAUDE_CODE_PLUGIN_CACHE_DIR",
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
        "OTEL_EXPORTER_OTLP_ENDPOINT",
        "OTEL_SDK_DISABLED",
      ]),
    );
  });

  it("deep-merges reliability watchdog overrides for codex", () => {
    const cfg = {
      agents: {
        defaults: {
          cliBackends: {
            "codex-cli": {
              command: "codex",
              reliability: {
                watchdog: {
                  resume: {
                    noOutputTimeoutMs: 42_000,
                  },
                },
              },
            },
          },
        },
      },
    } satisfies FasedAgentConfig;

    const resolved = resolveCliBackendConfig("codex-cli", cfg);

    expect(resolved).not.toBeNull();
    expect(resolved?.config.reliability?.watchdog?.resume?.noOutputTimeoutMs).toBe(42_000);
    // Ensure defaults are retained when only one field is overridden.
    expect(resolved?.config.reliability?.watchdog?.resume?.noOutputTimeoutRatio).toBe(0.3);
    expect(resolved?.config.reliability?.watchdog?.resume?.minMs).toBe(60_000);
    expect(resolved?.config.reliability?.watchdog?.resume?.maxMs).toBe(180_000);
    expect(resolved?.config.reliability?.watchdog?.fresh?.noOutputTimeoutRatio).toBe(0.8);
  });
});
