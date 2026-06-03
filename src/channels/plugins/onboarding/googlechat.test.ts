import { describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../../../runtime.js";
import type { WizardPrompter } from "../../../wizard/prompts.js";
import { googleChatOnboardingAdapter } from "./googlechat.js";

function createPrompterHarness(params?: { textValues?: string[]; selectValues?: string[] }) {
  const textValues = [...(params?.textValues ?? [])];
  const selectValues = [...(params?.selectValues ?? [])];
  const prompter = {
    intro: vi.fn(async () => undefined),
    outro: vi.fn(async () => undefined),
    note: vi.fn(async () => undefined),
    select: vi.fn(async () => selectValues.shift() ?? "app-url"),
    multiselect: vi.fn(async () => [] as string[]),
    text: vi.fn(async () => textValues.shift() ?? ""),
    confirm: vi.fn(async () => false),
    progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
  } as unknown as WizardPrompter;
  return { prompter };
}

function createRuntime(): RuntimeEnv {
  return { error: vi.fn() } as unknown as RuntimeEnv;
}

describe("googleChatOnboardingAdapter", () => {
  it("requires service account, webhook config, and audience", async () => {
    await expect(
      googleChatOnboardingAdapter.getStatus({
        cfg: { channels: { googlechat: { serviceAccountFile: "/tmp/chat.json" } } },
        accountOverrides: {},
      }),
    ).resolves.toMatchObject({
      configured: false,
      selectionHint: "needs service account, webhook, and audience",
    });

    await expect(
      googleChatOnboardingAdapter.getStatus({
        cfg: {
          channels: {
            googlechat: {
              serviceAccountFile: "/tmp/chat.json",
              webhookPath: "/googlechat",
            },
          },
        },
        accountOverrides: {},
      }),
    ).resolves.toMatchObject({
      configured: false,
      selectionHint: "needs service account, webhook, and audience",
    });

    await expect(
      googleChatOnboardingAdapter.getStatus({
        cfg: {
          channels: {
            googlechat: {
              serviceAccountFile: "/tmp/chat.json",
              webhookPath: "/googlechat",
              audienceType: "app-url",
              audience: "https://agent.example.com/googlechat",
            },
          },
        },
        accountOverrides: {},
      }),
    ).resolves.toMatchObject({ configured: true, selectionHint: "configured" });
  });

  it("saves service account, webhook, audience, and bot user during onboarding", async () => {
    const harness = createPrompterHarness({
      textValues: [
        "/run/secrets/google-chat.json",
        "/googlechat",
        "https://agent.example.com/googlechat",
        "https://agent.example.com/googlechat",
        "users/123",
      ],
      selectValues: ["app-url"],
    });

    const result = await googleChatOnboardingAdapter.configure({
      cfg: {},
      runtime: createRuntime(),
      prompter: harness.prompter,
      options: {},
      accountOverrides: {},
      shouldPromptAccountIds: false,
      forceAllowFrom: false,
    });

    expect(result.cfg.channels?.googlechat).toMatchObject({
      enabled: true,
      serviceAccountFile: "/run/secrets/google-chat.json",
      webhookPath: "/googlechat",
      webhookUrl: "https://agent.example.com/googlechat",
      audienceType: "app-url",
      audience: "https://agent.example.com/googlechat",
      botUser: "users/123",
    });
  });
});
