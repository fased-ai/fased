import { describe, expect, it, vi } from "vitest";
import type { WizardPrompter } from "../../../wizard/prompts.js";
import { blueBubblesOnboardingAdapter } from "./bluebubbles.js";

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

describe("bluebubbles onboarding", () => {
  it("saves default account server credentials through CLI onboarding", async () => {
    const result = await blueBubblesOnboardingAdapter.configure({
      cfg: {},
      runtime,
      prompter: createPrompter({
        textValues: ["192.168.1.100:1234", "bb-password"],
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
          bluebubbles: {
            enabled: true,
            serverUrl: "http://192.168.1.100:1234",
            password: "bb-password",
            webhookPath: "/bluebubbles-webhook",
          },
        },
      },
    });
  });

  it("saves named account server credentials and custom webhook path", async () => {
    const result = await blueBubblesOnboardingAdapter.configure({
      cfg: {},
      runtime,
      prompter: createPrompter({
        textValues: ["https://bluebubbles.example.com", "ops-password", "/ops-bluebubbles"],
        confirmValues: [true],
      }),
      options: {},
      accountOverrides: { bluebubbles: "ops" },
      shouldPromptAccountIds: false,
      forceAllowFrom: false,
    });

    expect(result).toMatchObject({
      accountId: "ops",
      cfg: {
        channels: {
          bluebubbles: {
            enabled: true,
            accounts: {
              ops: {
                enabled: true,
                serverUrl: "https://bluebubbles.example.com",
                password: "ops-password",
                webhookPath: "/ops-bluebubbles",
              },
            },
          },
        },
      },
    });
  });

  it("prompts and saves account allowlist entries", async () => {
    const result = await blueBubblesOnboardingAdapter.dmPolicy?.promptAllowFrom?.({
      cfg: {},
      prompter: createPrompter({
        textValues: ["+15555550123, chat_id:123"],
      }),
      accountId: "ops",
    });

    expect(result).toMatchObject({
      channels: {
        bluebubbles: {
          enabled: true,
          accounts: {
            ops: {
              enabled: true,
              allowFrom: ["+15555550123", "chat_id:123"],
            },
          },
        },
      },
    });
  });
});
