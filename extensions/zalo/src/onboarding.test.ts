import type { RuntimeEnv, WizardPrompter } from "fased/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { zaloOnboardingAdapter } from "./onboarding.js";

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

describe("zalo onboarding", () => {
  it("exposes UI setup fields that match the CLI bot token and webhook flow", () => {
    expect(zaloOnboardingAdapter.uiSetup).toMatchObject({
      title: "Zalo",
      detail: "Bot API token with optional webhook mode.",
      notes: expect.arrayContaining([
        expect.stringContaining("Zalo Bot Platform"),
        expect.stringContaining("webhook mode"),
      ]),
      fields: expect.arrayContaining([
        expect.objectContaining({
          label: "Bot token",
          path: ["channels", "zalo", "botToken"],
          kind: "password",
        }),
        expect.objectContaining({
          label: "Token file",
          path: ["channels", "zalo", "tokenFile"],
        }),
        expect.objectContaining({
          label: "Webhook URL",
          path: ["channels", "zalo", "webhookUrl"],
        }),
        expect.objectContaining({
          label: "Webhook secret",
          path: ["channels", "zalo", "webhookSecret"],
          kind: "password",
        }),
        expect.objectContaining({
          label: "Webhook path",
          path: ["channels", "zalo", "webhookPath"],
        }),
      ]),
    });
    expect(zaloOnboardingAdapter.dmPolicy).toMatchObject({
      label: "Zalo",
      policyKey: "channels.zalo.dmPolicy",
      allowFromKey: "channels.zalo.allowFrom",
    });
  });

  it("reports configured when a bot token is saved", async () => {
    await expect(
      zaloOnboardingAdapter.getStatus({ cfg: {}, accountOverrides: {} }),
    ).resolves.toMatchObject({
      configured: false,
      selectionHint: "recommended · newcomer-friendly",
    });

    await expect(
      zaloOnboardingAdapter.getStatus({
        cfg: {
          channels: {
            zalo: {
              botToken: "123456789:abc-xyz",
            },
          },
        },
        accountOverrides: {},
      }),
    ).resolves.toMatchObject({
      configured: true,
      selectionHint: "recommended · configured",
    });
  });

  it("saves a token in polling mode through CLI onboarding", async () => {
    const result = await zaloOnboardingAdapter.configure({
      cfg: {},
      runtime: {} as RuntimeEnv,
      prompter: createPrompter({
        textValues: ["123456789:abc-xyz"],
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
          zalo: {
            enabled: true,
            botToken: "123456789:abc-xyz",
          },
        },
      },
    });
    expect(result.cfg.channels?.zalo?.webhookUrl).toBeUndefined();
    expect(result.cfg.channels?.zalo?.webhookSecret).toBeUndefined();
  });

  it("saves webhook mode through CLI onboarding", async () => {
    const result = await zaloOnboardingAdapter.configure({
      cfg: {},
      runtime: {} as RuntimeEnv,
      prompter: createPrompter({
        textValues: [
          "123456789:abc-xyz",
          "https://gateway.example.com/zalo-webhook",
          "super-secret",
          "/zalo-webhook",
        ],
        confirmValues: [true],
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
          zalo: {
            enabled: true,
            botToken: "123456789:abc-xyz",
            webhookUrl: "https://gateway.example.com/zalo-webhook",
            webhookSecret: "super-secret",
            webhookPath: "/zalo-webhook",
          },
        },
      },
    });
  });
});
