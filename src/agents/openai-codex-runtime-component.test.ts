import { describe, expect, it, vi } from "vitest";
import type { CapabilityComponentInstallResult } from "../capabilities/install.js";
import {
  ensureOpenAICodexRuntimeComponent,
  hasConfiguredOpenAICodexProfile,
} from "./openai-codex-runtime-component.js";

describe("managed OpenAI runtime component", () => {
  const installResult = (config: CapabilityComponentInstallResult["config"]) =>
    ({
      config,
      entry: {
        id: "openai-runtime",
        label: "OpenAI Sign-In Runtime",
        category: "provider",
        delivery: "core",
        packageName: "@fased/openai-runtime",
        pluginId: "openai-runtime",
        docsPath: "/providers/openai",
        surface: "Agent > Models",
        description: "OpenAI runtime",
      },
      pluginId: "openai-runtime",
      slotWarnings: [],
    }) satisfies CapabilityComponentInstallResult;

  it("detects a configured ChatGPT sign-in profile", () => {
    expect(
      hasConfiguredOpenAICodexProfile({
        auth: {
          profiles: {
            "openai-codex:user@example.com": {
              provider: "openai-codex",
              mode: "oauth",
            },
          },
        },
      }),
    ).toBe(true);
    expect(hasConfiguredOpenAICodexProfile({})).toBe(false);
  });

  it("keeps an existing managed or source runtime without installing", async () => {
    const installComponent = vi.fn();
    const result = await ensureOpenAICodexRuntimeComponent({
      config: {},
      resolveExecutable: () => "/opt/fased/openai-runtime/codex",
      installComponent,
    });

    expect(result.installed).toBe(false);
    expect(result.executable).toBe("/opt/fased/openai-runtime/codex");
    expect(installComponent).not.toHaveBeenCalled();
  });

  it("enables the bundled runtime when no owned executable is resolved", async () => {
    let executable: string | null = null;
    const installComponent = vi.fn(async () => {
      executable = "/opt/fased/openai-runtime/codex";
      return installResult({ plugins: { entries: { "openai-runtime": { enabled: true } } } });
    });

    const result = await ensureOpenAICodexRuntimeComponent({
      config: {},
      resolveExecutable: () => executable,
      installComponent,
    });

    expect(installComponent).toHaveBeenCalledWith({
      id: "openai-runtime",
      config: {},
    });
    expect(result.installed).toBe(true);
    expect(result.executable).toBe("/opt/fased/openai-runtime/codex");
    expect(result.config.plugins?.entries?.["openai-runtime"]?.enabled).toBe(true);
  });

  it("does not accept an incomplete signed generation", async () => {
    await expect(
      ensureOpenAICodexRuntimeComponent({
        config: {},
        resolveExecutable: () => null,
        installComponent: vi.fn(async () => installResult({})),
      }),
    ).rejects.toThrow("signed Fased generation is missing");
  });
});
