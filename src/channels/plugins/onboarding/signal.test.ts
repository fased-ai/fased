import { describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../../../runtime.js";
import type { WizardPrompter } from "../../../wizard/prompts.js";
import {
  normalizeSignalAccountInput,
  parseSignalAllowFromEntries,
  signalOnboardingAdapter,
} from "./signal.js";

function createPrompterHarness(params?: { textValues?: string[]; confirmValues?: boolean[] }) {
  const textValues = [...(params?.textValues ?? [])];
  const confirmValues = [...(params?.confirmValues ?? [])];
  const prompter = {
    intro: vi.fn(async () => undefined),
    outro: vi.fn(async () => undefined),
    note: vi.fn(async () => undefined),
    select: vi.fn(async () => ""),
    multiselect: vi.fn(async () => [] as string[]),
    text: vi.fn(async () => textValues.shift() ?? ""),
    confirm: vi.fn(async () => confirmValues.shift() ?? false),
    progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
  } as unknown as WizardPrompter;
  return { prompter };
}

function createRuntime(): RuntimeEnv {
  return { error: vi.fn() } as unknown as RuntimeEnv;
}

describe("normalizeSignalAccountInput", () => {
  it("normalizes valid E.164 numbers", () => {
    expect(normalizeSignalAccountInput(" +1 (555) 555-0123 ")).toBe("+15555550123");
  });

  it("rejects invalid values", () => {
    expect(normalizeSignalAccountInput("abc")).toBeNull();
  });
});

describe("parseSignalAllowFromEntries", () => {
  it("parses e164, uuid and wildcard entries", () => {
    expect(
      parseSignalAllowFromEntries("+15555550123, uuid:123e4567-e89b-12d3-a456-426614174000, *"),
    ).toEqual({
      entries: ["+15555550123", "uuid:123e4567-e89b-12d3-a456-426614174000", "*"],
    });
  });

  it("normalizes bare uuid values", () => {
    expect(parseSignalAllowFromEntries("123e4567-e89b-12d3-a456-426614174000")).toEqual({
      entries: ["uuid:123e4567-e89b-12d3-a456-426614174000"],
    });
  });

  it("returns validation errors for invalid entries", () => {
    expect(parseSignalAllowFromEntries("uuid:")).toEqual({
      entries: [],
      error: "Invalid uuid entry",
    });
    expect(parseSignalAllowFromEntries("invalid")).toEqual({
      entries: [],
      error: "Invalid entry: invalid",
    });
  });
});

describe("signalOnboardingAdapter", () => {
  it("does not count cliPath alone as configured", async () => {
    await expect(
      signalOnboardingAdapter.getStatus({
        cfg: { channels: { signal: { cliPath: "signal-cli" } } },
        accountOverrides: {},
      }),
    ).resolves.toMatchObject({ configured: false });

    await expect(
      signalOnboardingAdapter.getStatus({
        cfg: { channels: { signal: { account: "+15555550123", cliPath: "signal-cli" } } },
        accountOverrides: {},
      }),
    ).resolves.toMatchObject({ configured: true });
  });

  it("saves Signal number and cli path during onboarding", async () => {
    const harness = createPrompterHarness({
      textValues: ["+1 (555) 555-0123"],
    });

    const result = await signalOnboardingAdapter.configure({
      cfg: {},
      runtime: createRuntime(),
      prompter: harness.prompter,
      options: {},
      accountOverrides: {},
      shouldPromptAccountIds: false,
      forceAllowFrom: false,
    });

    expect(result.cfg.channels?.signal).toMatchObject({
      enabled: true,
      account: "+15555550123",
      cliPath: "signal-cli",
    });
  });
});
