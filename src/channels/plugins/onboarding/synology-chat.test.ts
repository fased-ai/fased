import { describe, expect, it, vi } from "vitest";
import type { WizardPrompter } from "../../../wizard/prompts.js";
import { synologyChatOnboardingAdapter } from "./synology-chat.js";

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

describe("synology chat onboarding", () => {
  it("saves default account webhooks and allowlist through CLI onboarding", async () => {
    const result = await synologyChatOnboardingAdapter.configure({
      cfg: {},
      runtime,
      prompter: createPrompter({
        textValues: ["outgoing-token", "https://nas.example.com/webhook/incoming", "123, 456"],
        confirmValues: [false],
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
          "synology-chat": {
            enabled: true,
            token: "outgoing-token",
            incomingUrl: "https://nas.example.com/webhook/incoming",
            webhookPath: "/webhook/synology",
            dmPolicy: "allowlist",
            allowedUserIds: ["123", "456"],
            rateLimitPerMinute: 30,
          },
        },
      },
    });
  });

  it("saves named account webhooks and custom webhook path", async () => {
    const result = await synologyChatOnboardingAdapter.configure({
      cfg: {},
      runtime,
      prompter: createPrompter({
        textValues: [
          "alerts-token",
          "https://nas.example.com/webhook/alerts",
          "/webhook/synology-alerts",
          "987654",
        ],
        confirmValues: [true],
      }),
      options: {},
      accountOverrides: { "synology-chat": "alerts" },
      shouldPromptAccountIds: false,
      forceAllowFrom: false,
    });

    expect(result).toMatchObject({
      accountId: "alerts",
      cfg: {
        channels: {
          "synology-chat": {
            enabled: true,
            accounts: {
              alerts: {
                enabled: true,
                token: "alerts-token",
                incomingUrl: "https://nas.example.com/webhook/alerts",
                webhookPath: "/webhook/synology-alerts",
                dmPolicy: "allowlist",
                allowedUserIds: ["987654"],
                rateLimitPerMinute: 30,
              },
            },
          },
        },
      },
    });
  });

  it("does not prompt allowlist when configured open", async () => {
    const prompter = createPrompter({
      textValues: ["open-token", "https://nas.example.com/webhook/open"],
      confirmValues: [false],
    });
    const result = await synologyChatOnboardingAdapter.configure({
      cfg: { channels: { "synology-chat": { dmPolicy: "open" } } },
      runtime,
      prompter,
      options: {},
      accountOverrides: {},
      shouldPromptAccountIds: false,
      forceAllowFrom: false,
    });

    expect(result).toMatchObject({
      cfg: {
        channels: {
          "synology-chat": {
            dmPolicy: "open",
            token: "open-token",
            incomingUrl: "https://nas.example.com/webhook/open",
          },
        },
      },
    });
    expect(prompter.text).toHaveBeenCalledTimes(2);
  });
});
