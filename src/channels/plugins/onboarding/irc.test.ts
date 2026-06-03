import { describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../../../runtime.js";
import type { WizardPrompter } from "../../../wizard/prompts.js";
import { ircOnboardingAdapter } from "./irc.js";

function createPrompterHarness(params?: { textValues?: string[] }) {
  const textValues = [...(params?.textValues ?? [])];
  const prompter = {
    intro: vi.fn(async () => undefined),
    outro: vi.fn(async () => undefined),
    note: vi.fn(async () => undefined),
    select: vi.fn(async () => ""),
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

describe("ircOnboardingAdapter", () => {
  it("reports IRC as configured only when host and nick exist", async () => {
    await expect(
      ircOnboardingAdapter.getStatus({
        cfg: {},
        accountOverrides: {},
      }),
    ).resolves.toMatchObject({ configured: false, selectionHint: "needs server and nick" });

    await expect(
      ircOnboardingAdapter.getStatus({
        cfg: { channels: { irc: { host: "irc.libera.chat", nick: "fased-bot" } } },
        accountOverrides: {},
      }),
    ).resolves.toMatchObject({ configured: true, selectionHint: "configured" });
  });

  it("saves server, nick, channels, and port during onboarding", async () => {
    const harness = createPrompterHarness({
      textValues: ["irc.libera.chat", "fased-bot", "#fased, #ops", "6697"],
    });

    const result = await ircOnboardingAdapter.configure({
      cfg: {},
      runtime: createRuntime(),
      prompter: harness.prompter,
      options: {},
      accountOverrides: {},
      shouldPromptAccountIds: false,
      forceAllowFrom: false,
    });

    expect(result.cfg.channels?.irc).toMatchObject({
      enabled: true,
      host: "irc.libera.chat",
      nick: "fased-bot",
      channels: ["#fased", "#ops"],
      port: 6697,
    });
  });
});
