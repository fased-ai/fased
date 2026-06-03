import { describe, expect, it, vi } from "vitest";
import { configureFederationForOnboarding } from "./onboarding.federation.js";
import type { WizardPrompter } from "./prompts.js";

function makePrompter(params?: {
  confirm?: WizardPrompter["confirm"];
  text?: WizardPrompter["text"];
}): WizardPrompter {
  return {
    intro: vi.fn(async () => {}),
    outro: vi.fn(async () => {}),
    note: vi.fn(async () => {}),
    select: vi.fn(async (opts) => opts.options[0]!.value),
    multiselect: vi.fn(async () => []),
    text: params?.text ?? vi.fn(async (opts) => opts.initialValue ?? ""),
    confirm: params?.confirm ?? vi.fn(async () => true),
    progress: vi.fn(() => ({
      update: vi.fn(),
      stop: vi.fn(),
    })),
  };
}

describe("configureFederationForOnboarding", () => {
  it("keeps existing federation settings when rerunning quickstart", async () => {
    const confirm = vi.fn(async () => true);
    const text = vi.fn(async (opts) => opts.initialValue ?? "");
    const prompter = makePrompter({ confirm, text });

    const result = await configureFederationForOnboarding({
      flow: "quickstart",
      hostProfile: "local",
      baseConfig: {
        env: {
          vars: {
            FASED_FEDERATION_AUTO_CONNECT: "1",
            FASED_FEDERATION_BASE_URL: "https://ff1.fased.app",
            FASED_FEDERATION_HANDLE: "@agent@ff1.fased.app",
          },
        },
      },
      prompter,
    });

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Keep Fased Network enabled?",
        initialValue: true,
      }),
    );
    expect(text).not.toHaveBeenCalled();
    expect(result).toEqual({
      enabled: true,
      baseUrl: "https://ff1.fased.app",
      handle: "@agent@ff1.fased.app",
    });
  });
});
