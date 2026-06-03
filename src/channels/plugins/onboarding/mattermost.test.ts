import { describe, expect, it, vi } from "vitest";
import type { WizardPrompter } from "../../../wizard/prompts.js";
import { mattermostOnboardingAdapter } from "./mattermost.js";

function createPrompter(params: { textValues?: string[]; confirmValues?: boolean[] }) {
  const textValues = [...(params.textValues ?? [])];
  const confirmValues = [...(params.confirmValues ?? [])];
  return {
    intro: vi.fn(async () => undefined),
    outro: vi.fn(async () => undefined),
    note: vi.fn(async () => undefined),
    select: vi.fn(async () => "allowlist"),
    multiselect: vi.fn(async () => []),
    text: vi.fn(async () => textValues.shift() ?? ""),
    confirm: vi.fn(async () => confirmValues.shift() ?? false),
    progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
  } as unknown as WizardPrompter;
}

const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

describe("mattermost onboarding", () => {
  it("saves default account credentials through CLI onboarding", async () => {
    const result = await mattermostOnboardingAdapter.configure({
      cfg: {},
      runtime,
      prompter: createPrompter({
        textValues: ["mattermost-token", "https://chat.example.com"],
      }),
      options: {},
      accountOverrides: {},
      shouldPromptAccountIds: false,
      forceAllowFrom: false,
    });

    expect(result).toMatchObject({
      accountId: "default",
      cfg: {
        channels: {
          mattermost: {
            enabled: true,
            botToken: "mattermost-token",
            baseUrl: "https://chat.example.com",
          },
        },
      },
    });
  });

  it("saves non-default account credentials through CLI onboarding", async () => {
    const result = await mattermostOnboardingAdapter.configure({
      cfg: {},
      runtime,
      prompter: createPrompter({
        textValues: ["ops-token", "https://ops.example.com"],
      }),
      options: {},
      accountOverrides: { mattermost: "ops" },
      shouldPromptAccountIds: false,
      forceAllowFrom: false,
    });

    expect(result).toMatchObject({
      accountId: "ops",
      cfg: {
        channels: {
          mattermost: {
            enabled: true,
            accounts: {
              ops: {
                enabled: true,
                botToken: "ops-token",
                baseUrl: "https://ops.example.com",
              },
            },
          },
        },
      },
    });
  });
});
