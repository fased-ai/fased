import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";

const mocks = vi.hoisted(() => ({
  runInteractiveOnboarding: vi.fn(async () => {}),
  runNonInteractiveOnboarding: vi.fn(async () => {}),
  handleOnboardingRepair: vi.fn(async () => {}),
}));

vi.mock("./onboard-interactive.js", () => ({
  runInteractiveOnboarding: mocks.runInteractiveOnboarding,
}));

vi.mock("./onboard-non-interactive.js", () => ({
  runNonInteractiveOnboarding: mocks.runNonInteractiveOnboarding,
}));

vi.mock("./onboard-helpers.js", () => ({
  handleOnboardingRepair: mocks.handleOnboardingRepair,
}));

const { onboardCommand } = await import("./onboard.js");

function makeRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn() as unknown as RuntimeEnv["exit"],
  };
}

describe("onboardCommand", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("fails fast for invalid secret-input-mode before onboarding starts", async () => {
    const runtime = makeRuntime();

    await onboardCommand(
      {
        secretInputMode: "invalid" as never,
      },
      runtime,
    );

    expect(runtime.error).toHaveBeenCalledWith(
      'Invalid --secret-input-mode. Use "plaintext" or "ref".',
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(mocks.runInteractiveOnboarding).not.toHaveBeenCalled();
    expect(mocks.runNonInteractiveOnboarding).not.toHaveBeenCalled();
  });

  it("defaults --reset to auth+sessions repair scope", async () => {
    const runtime = makeRuntime();

    await onboardCommand(
      {
        reset: true,
      },
      runtime,
    );

    expect(mocks.handleOnboardingRepair).toHaveBeenCalledWith("auth+sessions", runtime);
  });

  it("accepts explicit --reset-scope sessions", async () => {
    const runtime = makeRuntime();

    await onboardCommand(
      {
        reset: true,
        resetScope: "sessions",
      },
      runtime,
    );

    expect(mocks.handleOnboardingRepair).toHaveBeenCalledWith("sessions", runtime);
  });

  it("accepts explicit --reset-scope auth", async () => {
    const runtime = makeRuntime();

    await onboardCommand(
      {
        reset: true,
        resetScope: "auth",
      },
      runtime,
    );

    expect(mocks.handleOnboardingRepair).toHaveBeenCalledWith("auth", runtime);
  });

  it("fails fast for invalid --reset-scope", async () => {
    const runtime = makeRuntime();

    await onboardCommand(
      {
        reset: true,
        resetScope: "invalid" as never,
      },
      runtime,
    );

    expect(runtime.error).toHaveBeenCalledWith(
      'Invalid --reset-scope. Use "sessions", "auth", or "auth+sessions".',
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(mocks.handleOnboardingRepair).not.toHaveBeenCalled();
    expect(mocks.runInteractiveOnboarding).not.toHaveBeenCalled();
    expect(mocks.runNonInteractiveOnboarding).not.toHaveBeenCalled();
  });
});
