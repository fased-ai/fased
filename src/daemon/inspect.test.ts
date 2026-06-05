import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findExtraGatewayServices } from "./inspect.js";

const { execSchtasksMock } = vi.hoisted(() => ({
  execSchtasksMock: vi.fn(),
}));

vi.mock("./schtasks-exec.js", () => ({
  execSchtasks: (...args: unknown[]) => execSchtasksMock(...args),
}));

describe("findExtraGatewayServices (win32)", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "win32",
    });
    execSchtasksMock.mockReset();
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: originalPlatform,
    });
  });

  it("skips schtasks queries unless deep mode is enabled", async () => {
    const result = await findExtraGatewayServices({});
    expect(result).toEqual([]);
    expect(execSchtasksMock).not.toHaveBeenCalled();
  });

  it("returns empty results when schtasks query fails", async () => {
    execSchtasksMock.mockResolvedValueOnce({
      code: 1,
      stdout: "",
      stderr: "error",
    });

    const result = await findExtraGatewayServices({}, { deep: true });
    expect(result).toEqual([]);
  });

  it("ignores managed Fased tasks and unrelated tasks", async () => {
    execSchtasksMock.mockResolvedValueOnce({
      code: 0,
      stdout: [
        "TaskName: FasedAgent Gateway",
        "Task To Run: C:\\Program Files\\FasedAgent\\fased.exe gateway run",
        "",
        "TaskName: Other Task",
        "Task To Run: C:\\tools\\helper.exe",
        "",
      ].join("\n"),
      stderr: "",
    });

    const result = await findExtraGatewayServices({}, { deep: true });
    expect(result).toEqual([]);
  });
});

describe("findExtraGatewayServices (linux)", () => {
  const originalPlatform = process.platform;
  let tempHome: string | null = null;

  beforeEach(async () => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "linux",
    });
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "fased-inspect-"));
  });

  afterEach(async () => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: originalPlatform,
    });
    if (tempHome) {
      await fs.rm(tempHome, { recursive: true, force: true });
      tempHome = null;
    }
  });

  it("ignores Fased SAT maintainer units and reports only gateway services", async () => {
    const userUnitDir = path.join(tempHome!, ".config", "systemd", "user");
    await fs.mkdir(userUnitDir, { recursive: true });
    await fs.writeFile(
      path.join(userUnitDir, "fased-sat-maintainer.service"),
      [
        "[Unit]",
        "Description=Fased SAT maintainer",
        "[Service]",
        "Environment=FASED_SERVICE_MARKER=fased",
        "Environment=FASED_SERVICE_KIND=sat-maintainer",
        "ExecStart=/home/app/fased/scripts/sat-maintainer-monitor.sh",
      ].join("\n"),
    );
    await fs.writeFile(
      path.join(userUnitDir, "fased-gateway-work.service"),
      [
        "[Unit]",
        "Description=Fased gateway",
        "[Service]",
        "Environment=FASED_SERVICE_MARKER=fased",
        "Environment=FASED_SERVICE_KIND=gateway",
        "ExecStart=/usr/bin/node /home/app/fased/dist/index.js gateway",
      ].join("\n"),
    );

    const result = await findExtraGatewayServices({ HOME: tempHome! });

    expect(result.map((svc) => svc.label)).toEqual(["fased-gateway-work.service"]);
  });
});
