import type { RuntimeEnv, WizardPrompter } from "fased/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { nostrOnboardingAdapter } from "./onboarding.js";

function createPrompter(textValues: string[]): WizardPrompter {
  const values = [...textValues];
  return {
    intro: vi.fn(async () => undefined),
    outro: vi.fn(async () => undefined),
    note: vi.fn(async () => undefined),
    select: vi.fn(async () => ""),
    multiselect: vi.fn(async () => []),
    text: vi.fn(async () => values.shift() ?? ""),
    confirm: vi.fn(async () => false),
    progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
  } as unknown as WizardPrompter;
}

describe("nostr onboarding", () => {
  it("exposes UI setup fields for the Nostr private key and relays", () => {
    expect(nostrOnboardingAdapter.uiSetup).toMatchObject({
      title: "Nostr",
      detail: "Nostr private key and relays.",
      fields: expect.arrayContaining([
        expect.objectContaining({
          label: "Private key",
          path: ["channels", "nostr", "privateKey"],
          kind: "password",
        }),
        expect.objectContaining({
          label: "Relays",
          path: ["channels", "nostr", "relays"],
          kind: "list",
        }),
      ]),
    });
    expect(nostrOnboardingAdapter.uiSetup?.access).toBeUndefined();
  });

  it("reports configured when a private key is saved", async () => {
    await expect(
      nostrOnboardingAdapter.getStatus({ cfg: {}, accountOverrides: {} }),
    ).resolves.toMatchObject({
      configured: false,
      selectionHint: "needs private key",
    });

    await expect(
      nostrOnboardingAdapter.getStatus({
        cfg: {
          channels: {
            nostr: {
              privateKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
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

  it("saves the private key and relays through CLI onboarding", async () => {
    const result = await nostrOnboardingAdapter.configure({
      cfg: {},
      runtime: {} as RuntimeEnv,
      prompter: createPrompter(["nsec1test", "wss://relay.damus.io, wss://nos.lol"]),
      options: {},
      accountOverrides: {},
      shouldPromptAccountIds: false,
      forceAllowFrom: false,
    });

    expect(result).toMatchObject({
      accountId: "default",
      cfg: {
        channels: {
          nostr: {
            enabled: true,
            privateKey: "nsec1test",
            relays: ["wss://relay.damus.io", "wss://nos.lol"],
          },
        },
      },
    });
  });
});
