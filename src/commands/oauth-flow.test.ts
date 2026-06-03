import { describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { createVpsAwareOAuthHandlers } from "./oauth-flow.js";

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

function createPrompter(overrides: Partial<WizardPrompter> = {}): WizardPrompter {
  return {
    intro: vi.fn(async () => {}),
    outro: vi.fn(async () => {}),
    note: vi.fn(async () => {}),
    select: vi.fn(async (params) => params.options[0]?.value as never),
    multiselect: vi.fn(async () => []),
    text: vi.fn(async () => "http://127.0.0.1:1455/callback?code=ok"),
    confirm: vi.fn(async () => true),
    progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
    ...overrides,
  };
}

describe("createVpsAwareOAuthHandlers", () => {
  it("puts the remote OAuth URL in the browser-visible text prompt", async () => {
    const prompter = createPrompter();
    const runtime = createRuntime();
    const spin = { update: vi.fn(), stop: vi.fn() };
    const handlers = createVpsAwareOAuthHandlers({
      isRemote: true,
      prompter,
      runtime,
      spin,
      openUrl: vi.fn(async () => {}),
      localBrowserMessage: "Complete sign-in in browser...",
    });

    await handlers.onAuth({ url: "https://auth.example.test/device" });
    const redirect = await handlers.onPrompt({ message: "Paste redirect URL" });

    expect(spin.stop).toHaveBeenCalledWith("OAuth URL ready");
    expect(prompter.text).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("https://auth.example.test/device"),
      }),
    );
    expect(redirect).toBe("http://127.0.0.1:1455/callback?code=ok");
  });

  it("uses the injected local browser opener for UI-driven OAuth", async () => {
    const prompter = createPrompter();
    const runtime = createRuntime();
    const spin = { update: vi.fn(), stop: vi.fn() };
    const openUrl = vi.fn(async () => {});
    const handlers = createVpsAwareOAuthHandlers({
      isRemote: false,
      prompter,
      runtime,
      spin,
      openUrl,
      localBrowserMessage: "Complete sign-in in browser...",
    });

    await handlers.onAuth({ url: "https://auth.example.test/oauth" });

    expect(spin.update).toHaveBeenCalledWith("Complete sign-in in browser...");
    expect(openUrl).toHaveBeenCalledWith("https://auth.example.test/oauth");
  });
});
