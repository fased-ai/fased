import type { RuntimeEnv, WizardPrompter } from "fased/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { msteamsOnboardingAdapter } from "./onboarding.js";

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

describe("msteams onboarding", () => {
  it("exposes UI setup fields that match the CLI credential flow", () => {
    expect(msteamsOnboardingAdapter.uiSetup).toMatchObject({
      title: "Microsoft Teams",
      detail: "Bot Framework app credentials.",
      notes: expect.arrayContaining([
        expect.stringContaining("Azure Bot registration"),
        expect.stringContaining("App Password"),
      ]),
      fields: expect.arrayContaining([
        expect.objectContaining({
          label: "App ID",
          path: ["channels", "msteams", "appId"],
        }),
        expect.objectContaining({
          label: "App Password",
          path: ["channels", "msteams", "appPassword"],
          kind: "password",
        }),
        expect.objectContaining({
          label: "Tenant ID",
          path: ["channels", "msteams", "tenantId"],
        }),
      ]),
      access: expect.objectContaining({
        kind: "msteams-channels",
        label: "MS Teams channels",
      }),
    });
  });

  it("reports configured when app credentials are saved", async () => {
    await expect(
      msteamsOnboardingAdapter.getStatus({ cfg: {}, accountOverrides: {} }),
    ).resolves.toMatchObject({
      configured: false,
      selectionHint: "needs app creds",
    });

    await expect(
      msteamsOnboardingAdapter.getStatus({
        cfg: {
          channels: {
            msteams: {
              appId: "app-1",
              appPassword: "secret-1",
              tenantId: "tenant-1",
            },
          },
        },
        accountOverrides: {},
      }),
    ).resolves.toMatchObject({
      configured: true,
      selectionHint: "configured",
    });
  });

  it("saves app credentials through CLI onboarding", async () => {
    const result = await msteamsOnboardingAdapter.configure({
      cfg: {},
      runtime: {} as RuntimeEnv,
      prompter: createPrompter({
        textValues: ["app-1", "secret-1", "tenant-1"],
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
          msteams: {
            enabled: true,
            appId: "app-1",
            appPassword: "secret-1",
            tenantId: "tenant-1",
          },
        },
      },
    });
  });
});
