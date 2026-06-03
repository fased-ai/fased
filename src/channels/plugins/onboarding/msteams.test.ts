import { describe, expect, it, vi } from "vitest";
import type { WizardPrompter } from "../../../wizard/prompts.js";
import { msteamsOnboardingAdapter } from "./msteams.js";

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

describe("msteams onboarding", () => {
  it("saves app credentials and channel access through CLI onboarding", async () => {
    const result = await msteamsOnboardingAdapter.configure({
      cfg: {},
      runtime,
      prompter: createPrompter({
        textValues: ["app-1", "secret-1", "tenant-1", "Ops/General"],
        confirmValues: [true],
        selectValues: ["allowlist"],
      }),
      options: {},
      accountOverrides: {},
      shouldPromptAccountIds: false,
      forceAllowFrom: false,
    });

    expect(result).toMatchObject({
      cfg: {
        channels: {
          msteams: {
            enabled: true,
            appId: "app-1",
            appPassword: "secret-1",
            tenantId: "tenant-1",
            groupPolicy: "allowlist",
            teams: {
              Ops: {
                channels: {
                  General: {},
                },
              },
            },
          },
        },
      },
    });
  });
});
