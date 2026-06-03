import { describe, expect, it, vi } from "vitest";
import type { WizardPrompter } from "../../../wizard/prompts.js";
import { lineOnboardingAdapter } from "./line.js";

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

describe("line onboarding", () => {
  it("saves default account token and secret through CLI onboarding", async () => {
    const result = await lineOnboardingAdapter.configure({
      cfg: {},
      runtime,
      prompter: createPrompter({
        textValues: ["line-token", "line-secret"],
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
          line: {
            enabled: true,
            channelAccessToken: "line-token",
            channelSecret: "line-secret",
            webhookPath: "/line/webhook",
          },
        },
      },
    });
  });

  it("saves named account token, secret, and custom webhook path", async () => {
    const result = await lineOnboardingAdapter.configure({
      cfg: {},
      runtime,
      prompter: createPrompter({
        textValues: ["ops-token", "ops-secret", "/line/ops"],
        confirmValues: [true],
      }),
      options: {},
      accountOverrides: { line: "ops" },
      shouldPromptAccountIds: false,
      forceAllowFrom: false,
    });

    expect(result).toMatchObject({
      accountId: "ops",
      cfg: {
        channels: {
          line: {
            enabled: true,
            accounts: {
              ops: {
                enabled: true,
                channelAccessToken: "ops-token",
                channelSecret: "ops-secret",
                webhookPath: "/line/ops",
              },
            },
          },
        },
      },
    });
  });

  it("applies account allowlist when forceAllowFrom is enabled", async () => {
    const result = await lineOnboardingAdapter.configure({
      cfg: {},
      runtime,
      prompter: createPrompter({
        textValues: ["line-token", "line-secret", "line:user:UABC, UDEF"],
        confirmValues: [false],
      }),
      options: {},
      accountOverrides: {},
      shouldPromptAccountIds: false,
      forceAllowFrom: true,
    });

    expect(result).toMatchObject({
      cfg: {
        channels: {
          line: {
            dmPolicy: "allowlist",
            allowFrom: ["UABC", "UDEF"],
          },
        },
      },
    });
  });
});
