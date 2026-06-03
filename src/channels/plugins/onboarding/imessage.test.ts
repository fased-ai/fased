import { describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../../../runtime.js";
import type { WizardPrompter } from "../../../wizard/prompts.js";
import { imessageOnboardingAdapter, parseIMessageAllowFromEntries } from "./imessage.js";

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

describe("parseIMessageAllowFromEntries", () => {
  it("parses handles and chat targets", () => {
    expect(parseIMessageAllowFromEntries("+15555550123, chat_id:123, chat_guid:abc")).toEqual({
      entries: ["+15555550123", "chat_id:123", "chat_guid:abc"],
    });
  });

  it("returns validation errors for invalid chat_id", () => {
    expect(parseIMessageAllowFromEntries("chat_id:abc")).toEqual({
      entries: [],
      error: "Invalid chat_id: chat_id:abc",
    });
  });

  it("returns validation errors for invalid chat_identifier entries", () => {
    expect(parseIMessageAllowFromEntries("chat_identifier:")).toEqual({
      entries: [],
      error: "Invalid chat_identifier entry",
    });
  });
});

describe("imessageOnboardingAdapter", () => {
  it("does not count policy fields as configured", async () => {
    await expect(
      imessageOnboardingAdapter.getStatus({
        cfg: { channels: { imessage: { dmPolicy: "pairing", allowFrom: ["alice@example.com"] } } },
        accountOverrides: {},
      }),
    ).resolves.toMatchObject({ configured: false });

    await expect(
      imessageOnboardingAdapter.getStatus({
        cfg: { channels: { imessage: { cliPath: "imsg" } } },
        accountOverrides: {},
      }),
    ).resolves.toMatchObject({ configured: true });
  });

  it("saves the imsg CLI path during onboarding", async () => {
    const harness = createPrompterHarness({
      textValues: ["/usr/local/bin/imsg"],
    });

    const result = await imessageOnboardingAdapter.configure({
      cfg: { channels: { imessage: { cliPath: "/definitely/not/imsg" } } },
      runtime: createRuntime(),
      prompter: harness.prompter,
      options: {},
      accountOverrides: {},
      shouldPromptAccountIds: false,
      forceAllowFrom: false,
    });

    expect(result.cfg.channels?.imessage).toMatchObject({
      enabled: true,
      cliPath: "/usr/local/bin/imsg",
    });
  });
});
