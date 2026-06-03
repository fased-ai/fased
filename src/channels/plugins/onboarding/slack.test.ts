import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../../../runtime.js";
import type { WizardPrompter } from "../../../wizard/prompts.js";
import { slackOnboardingAdapter } from "./slack.js";

function createPrompterHarness(params?: { textValues?: string[]; confirmValues?: boolean[] }) {
  const textValues = [...(params?.textValues ?? [])];
  const confirmValues = [...(params?.confirmValues ?? [])];
  const prompter = {
    intro: vi.fn(async () => undefined),
    outro: vi.fn(async () => undefined),
    note: vi.fn(async () => undefined),
    select: vi.fn(async () => "allowlist"),
    multiselect: vi.fn(async () => [] as string[]),
    text: vi.fn(async () => textValues.shift() ?? ""),
    confirm: vi.fn(async () => confirmValues.shift() ?? false),
    progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
  } as unknown as WizardPrompter;
  return { prompter };
}

function createRuntime(): RuntimeEnv {
  return { error: vi.fn() } as unknown as RuntimeEnv;
}

describe("slackOnboardingAdapter", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("requires both bot and app tokens", async () => {
    vi.stubEnv("SLACK_BOT_TOKEN", "");
    vi.stubEnv("SLACK_APP_TOKEN", "");

    await expect(
      slackOnboardingAdapter.getStatus({
        cfg: {},
        accountOverrides: {},
      }),
    ).resolves.toMatchObject({ configured: false, selectionHint: "needs tokens" });

    await expect(
      slackOnboardingAdapter.getStatus({
        cfg: { channels: { slack: { botToken: "xoxb-test" } } },
        accountOverrides: {},
      }),
    ).resolves.toMatchObject({ configured: false, selectionHint: "needs tokens" });

    await expect(
      slackOnboardingAdapter.getStatus({
        cfg: { channels: { slack: { botToken: "xoxb-test", appToken: "xapp-test" } } },
        accountOverrides: {},
      }),
    ).resolves.toMatchObject({ configured: true, selectionHint: "configured" });
  });

  it("saves tokens and enables Slack during onboarding", async () => {
    vi.stubEnv("SLACK_BOT_TOKEN", "");
    vi.stubEnv("SLACK_APP_TOKEN", "");
    const harness = createPrompterHarness({
      textValues: ["FasedAgent", "xoxb-test", "xapp-test"],
      confirmValues: [false],
    });

    const result = await slackOnboardingAdapter.configure({
      cfg: {},
      runtime: createRuntime(),
      prompter: harness.prompter,
      options: {},
      accountOverrides: {},
      shouldPromptAccountIds: false,
      forceAllowFrom: false,
    });

    expect(result.cfg.channels?.slack).toMatchObject({
      enabled: true,
      botToken: "xoxb-test",
      appToken: "xapp-test",
    });
  });
});
