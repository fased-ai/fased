import type { RuntimeEnv, WizardPrompter } from "fased/plugin-sdk";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { zalouserOnboardingAdapter } from "./onboarding.js";
import { checkZcaInstalled, runZca, runZcaInteractive } from "./zca.js";

vi.mock("./zca.js", () => ({
  checkZcaInstalled: vi.fn(),
  runZca: vi.fn(),
  runZcaInteractive: vi.fn(),
  parseJsonOutput: vi.fn((stdout: string) => {
    try {
      return JSON.parse(stdout);
    } catch {
      return null;
    }
  }),
}));

function createPrompter(params: { confirmValues?: boolean[]; textValues?: string[] } = {}) {
  const confirmValues = [...(params.confirmValues ?? [])];
  const textValues = [...(params.textValues ?? [])];
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

describe("zalouser onboarding", () => {
  beforeEach(() => {
    vi.mocked(checkZcaInstalled).mockReset();
    vi.mocked(runZca).mockReset();
    vi.mocked(runZcaInteractive).mockReset();
  });

  it("exposes UI setup fields that match the CLI QR profile and group flow", () => {
    expect(zalouserOnboardingAdapter.uiSetup).toMatchObject({
      title: "Zalo Personal",
      detail: "Personal Zalo account through zca-cli QR login.",
      notes: expect.arrayContaining([
        expect.stringContaining("zca-cli"),
        expect.stringContaining("QR login"),
      ]),
      fields: [
        expect.objectContaining({
          label: "ZCA profile",
          path: ["channels", "zalouser", "profile"],
          placeholder: "default",
        }),
      ],
      qrLogin: expect.objectContaining({
        startLabel: "Show QR",
        waitLabel: "Wait for scan",
        alt: "Zalo Personal QR",
      }),
      access: expect.objectContaining({
        kind: "zalouser-groups",
        label: "Zalo groups",
        placeholder: "Family, Work, 123456789",
      }),
    });
    expect(zalouserOnboardingAdapter.dmPolicy).toMatchObject({
      label: "Zalo Personal",
      policyKey: "channels.zalouser.dmPolicy",
      allowFromKey: "channels.zalouser.allowFrom",
    });
  });

  it("reports configured based on zca authentication", async () => {
    vi.mocked(runZca).mockResolvedValueOnce({
      ok: false,
      stdout: "",
      stderr: "not logged in",
      exitCode: 1,
    });

    await expect(
      zalouserOnboardingAdapter.getStatus({ cfg: {}, accountOverrides: {} }),
    ).resolves.toMatchObject({
      configured: false,
      selectionHint: "recommended · QR login",
    });

    vi.mocked(runZca).mockResolvedValueOnce({
      ok: true,
      stdout: "",
      stderr: "",
      exitCode: 0,
    });

    await expect(
      zalouserOnboardingAdapter.getStatus({ cfg: {}, accountOverrides: {} }),
    ).resolves.toMatchObject({
      configured: true,
      selectionHint: "recommended · logged in",
    });
  });

  it("saves a named zca profile through CLI onboarding", async () => {
    vi.mocked(checkZcaInstalled).mockResolvedValue(true);
    vi.mocked(runZca).mockResolvedValue({
      ok: true,
      stdout: "",
      stderr: "",
      exitCode: 0,
    });

    const result = await zalouserOnboardingAdapter.configure({
      cfg: {},
      runtime: {} as RuntimeEnv,
      prompter: createPrompter({ confirmValues: [true, false] }),
      options: {},
      accountOverrides: { zalouser: "work" },
      shouldPromptAccountIds: false,
      forceAllowFrom: false,
    });

    expect(result).toMatchObject({
      accountId: "work",
      cfg: {
        channels: {
          zalouser: {
            enabled: true,
            accounts: {
              work: {
                enabled: true,
                profile: "work",
              },
            },
          },
        },
      },
    });
    expect(runZcaInteractive).not.toHaveBeenCalled();
  });
});
