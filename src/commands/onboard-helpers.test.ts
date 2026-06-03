import { beforeEach, describe, expect, it, vi } from "vitest";

const hasEmittedCliBannerMock = vi.fn(() => false);

vi.mock("../cli/banner.js", () => ({
  hasEmittedCliBanner: hasEmittedCliBannerMock,
}));

const { printWizardHeader } = await import("./onboard-helpers.js");

describe("printWizardHeader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    hasEmittedCliBannerMock.mockReturnValue(false);
  });

  it("prints the product header when no CLI banner was emitted", () => {
    const log = vi.fn();
    printWizardHeader({ log } as never);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0] ?? "")).toMatch(/Fased Agent v\d+\.\d+\.\d+/);
  });

  it("suppresses the duplicate product header after the CLI banner was already emitted", () => {
    hasEmittedCliBannerMock.mockReturnValue(true);
    const log = vi.fn();
    printWizardHeader({ log } as never);
    expect(log).not.toHaveBeenCalled();
  });

  it("suppresses the duplicate product header when launched from install.sh", () => {
    vi.stubEnv("FASED_INSTALLER_ONBOARD", "1");
    const log = vi.fn();
    printWizardHeader({ log } as never);
    expect(log).not.toHaveBeenCalled();
  });
});
