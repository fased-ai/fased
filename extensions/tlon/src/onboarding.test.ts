import type { RuntimeEnv, WizardPrompter } from "fased/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { tlonOnboardingAdapter } from "./onboarding.js";

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

describe("tlon onboarding", () => {
  it("exposes UI setup fields that match the CLI Urbit flow", () => {
    expect(tlonOnboardingAdapter.uiSetup).toMatchObject({
      title: "Tlon",
      detail: "Urbit ship URL, login code, groups, and DM allowlist.",
      notes: expect.arrayContaining([
        expect.stringContaining("Urbit ship URL"),
        expect.stringContaining("private-network approval"),
      ]),
      fields: expect.arrayContaining([
        expect.objectContaining({
          label: "Ship name",
          path: ["channels", "tlon", "ship"],
        }),
        expect.objectContaining({
          label: "Ship URL",
          path: ["channels", "tlon", "url"],
        }),
        expect.objectContaining({
          label: "Login code",
          path: ["channels", "tlon", "code"],
          kind: "password",
        }),
        expect.objectContaining({
          label: "Allow private network",
          path: ["channels", "tlon", "allowPrivateNetwork"],
          kind: "boolean",
        }),
        expect.objectContaining({
          label: "Group channels",
          path: ["channels", "tlon", "groupChannels"],
          kind: "list",
        }),
        expect.objectContaining({
          label: "DM allowlist",
          path: ["channels", "tlon", "dmAllowlist"],
          kind: "list",
        }),
        expect.objectContaining({
          label: "Auto-discover groups",
          path: ["channels", "tlon", "autoDiscoverChannels"],
          kind: "boolean",
        }),
      ]),
    });
  });

  it("reports configured when ship URL and code are saved", async () => {
    await expect(
      tlonOnboardingAdapter.getStatus({ cfg: {}, accountOverrides: {} }),
    ).resolves.toMatchObject({
      configured: false,
      selectionHint: "urbit messenger",
    });

    await expect(
      tlonOnboardingAdapter.getStatus({
        cfg: {
          channels: {
            tlon: {
              ship: "~sampel-palnet",
              url: "https://ship.example",
              code: "lidlut-tabwed-pillex-ridrup",
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

  it("saves Tlon ship credentials and access controls through CLI onboarding", async () => {
    const result = await tlonOnboardingAdapter.configure({
      cfg: {},
      runtime: {} as RuntimeEnv,
      prompter: createPrompter({
        textValues: [
          "~sampel-palnet",
          "https://ship.example",
          "lidlut-tabwed-pillex-ridrup",
          "chat/~host-ship/general",
          "~zod, ~nec",
        ],
        confirmValues: [true, true, false],
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
          tlon: {
            enabled: true,
            ship: "~sampel-palnet",
            url: "https://ship.example",
            code: "lidlut-tabwed-pillex-ridrup",
            groupChannels: ["chat/~host-ship/general"],
            dmAllowlist: ["~zod", "~nec"],
            autoDiscoverChannels: false,
          },
        },
      },
    });
  });
});
