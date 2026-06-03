import { describe, expect, it, vi } from "vitest";
import type { WizardPrompter } from "../../../wizard/prompts.js";
import { matrixOnboardingAdapter } from "./matrix.js";

function createPrompter(params: {
  textValues?: string[];
  confirmValues?: boolean[];
  selectValues?: string[];
}) {
  const textValues = [...(params.textValues ?? [])];
  const confirmValues = [...(params.confirmValues ?? [])];
  const selectValues = [...(params.selectValues ?? [])];
  return {
    intro: vi.fn(async () => undefined),
    outro: vi.fn(async () => undefined),
    note: vi.fn(async () => undefined),
    select: vi.fn(async () => selectValues.shift() ?? "allowlist"),
    multiselect: vi.fn(async () => []),
    text: vi.fn(async () => textValues.shift() ?? ""),
    confirm: vi.fn(async () => confirmValues.shift() ?? false),
    progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
  } as unknown as WizardPrompter;
}

const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

describe("matrix onboarding", () => {
  it("saves token auth, optional encryption, and room access through CLI onboarding", async () => {
    const result = await matrixOnboardingAdapter.configure({
      cfg: {},
      runtime,
      prompter: createPrompter({
        textValues: [
          "https://matrix.example.org",
          "token-1",
          "FasedAgent Gateway",
          "!ops:example.org",
        ],
        confirmValues: [true, true],
        selectValues: ["token", "allowlist"],
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
          matrix: {
            enabled: true,
            homeserver: "https://matrix.example.org",
            accessToken: "token-1",
            deviceName: "FasedAgent Gateway",
            encryption: true,
            groupPolicy: "allowlist",
            groups: {
              "!ops:example.org": { allow: true },
            },
          },
        },
      },
    });
    expect(result.cfg.channels?.matrix?.userId).toBeUndefined();
    expect(result.cfg.channels?.matrix?.password).toBeUndefined();
  });

  it("saves password auth when selected", async () => {
    const result = await matrixOnboardingAdapter.configure({
      cfg: {},
      runtime,
      prompter: createPrompter({
        textValues: [
          "https://matrix.example.org",
          "@bot:example.org",
          "password-1",
          "FasedAgent Gateway",
        ],
        confirmValues: [false, false],
        selectValues: ["password"],
      }),
      options: {},
      accountOverrides: {},
      shouldPromptAccountIds: false,
      forceAllowFrom: false,
    });

    expect(result).toMatchObject({
      cfg: {
        channels: {
          matrix: {
            enabled: true,
            homeserver: "https://matrix.example.org",
            userId: "@bot:example.org",
            password: "password-1",
            deviceName: "FasedAgent Gateway",
          },
        },
      },
    });
  });
});
