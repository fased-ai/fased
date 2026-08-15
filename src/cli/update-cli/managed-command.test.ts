import { beforeEach, describe, expect, it, vi } from "vitest";

const defaultRuntime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

vi.mock("../../runtime.js", () => ({ defaultRuntime }));

beforeEach(() => {
  defaultRuntime.log.mockClear();
  defaultRuntime.error.mockClear();
  defaultRuntime.exit.mockClear();
});

describe("direct Node update boundary", () => {
  it("refuses mutation and gives the verified installer repair path", async () => {
    const { updateCommand } = await import("./update-command.js");

    await updateCommand({});

    expect(defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringContaining("not a managed update authority"),
    );
    expect(defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringContaining("releases/latest/download/install.sh"),
    );
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("returns a machine-readable repair response", async () => {
    const { updateCommand } = await import("./update-command.js");

    await updateCommand({ json: true });

    expect(JSON.parse(String(defaultRuntime.log.mock.calls[0]?.[0]))).toMatchObject({
      status: "repair-required",
      reason: "verified-installer-required",
    });
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("refuses a second Node status authority", async () => {
    const { updateStatusCommand } = await import("./status.js");

    await updateStatusCommand({ json: true });

    expect(JSON.parse(String(defaultRuntime.log.mock.calls[0]?.[0]))).toMatchObject({
      status: "repair-required",
      reason: "managed-launcher-required",
    });
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });
});
