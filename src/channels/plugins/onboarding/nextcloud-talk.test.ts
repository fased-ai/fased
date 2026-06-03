import { describe, expect, it, vi } from "vitest";
import type { WizardPrompter } from "../../../wizard/prompts.js";
import { nextcloudTalkOnboardingAdapter } from "./nextcloud-talk.js";

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

describe("nextcloud talk onboarding", () => {
  it("saves default account URL and bot secret through CLI onboarding", async () => {
    const result = await nextcloudTalkOnboardingAdapter.configure({
      cfg: {},
      runtime,
      prompter: createPrompter({
        textValues: ["https://cloud.example.com", "secret-1"],
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
          "nextcloud-talk": {
            enabled: true,
            baseUrl: "https://cloud.example.com",
            botSecret: "secret-1",
          },
        },
      },
    });
  });

  it("saves named account URL and bot secret through CLI onboarding", async () => {
    const result = await nextcloudTalkOnboardingAdapter.configure({
      cfg: {},
      runtime,
      prompter: createPrompter({
        textValues: ["https://ops-cloud.example.com", "ops-secret"],
      }),
      options: {},
      accountOverrides: { "nextcloud-talk": "ops" },
      shouldPromptAccountIds: false,
      forceAllowFrom: false,
    });

    expect(result).toMatchObject({
      accountId: "ops",
      cfg: {
        channels: {
          "nextcloud-talk": {
            enabled: true,
            accounts: {
              ops: {
                enabled: true,
                baseUrl: "https://ops-cloud.example.com",
                botSecret: "ops-secret",
              },
            },
          },
        },
      },
    });
  });

  it("applies account allowlist when forceAllowFrom is enabled", async () => {
    const result = await nextcloudTalkOnboardingAdapter.configure({
      cfg: {},
      runtime,
      prompter: createPrompter({
        textValues: ["https://cloud.example.com", "secret-1", "alice, Bob"],
      }),
      options: {},
      accountOverrides: {},
      shouldPromptAccountIds: false,
      forceAllowFrom: true,
    });

    expect(result).toMatchObject({
      cfg: {
        channels: {
          "nextcloud-talk": {
            dmPolicy: "allowlist",
            allowFrom: ["alice", "bob"],
          },
        },
      },
    });
  });
});
