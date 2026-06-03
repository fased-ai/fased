import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

import { splitArgsPreservingQuotes } from "./arg-split.js";
import { parseSystemdExecStart } from "./systemd-unit.js";
import {
  isSystemdUserServiceAvailable,
  parseSystemdShow,
  restartSystemdService,
  resolveSystemdUserUnitPath,
  stopSystemdService,
} from "./systemd.js";

describe("systemd availability", () => {
  beforeEach(() => {
    execFileMock.mockClear();
  });

  it("returns true when systemctl --user succeeds", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(null, "", "");
    });
    await expect(isSystemdUserServiceAvailable()).resolves.toBe(true);
  });

  it("returns false when systemd user bus is unavailable", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      const err = new Error("Failed to connect to bus") as Error & {
        stderr?: string;
        code?: number;
      };
      err.stderr = "Failed to connect to bus";
      err.code = 1;
      cb(err, "", "");
    });
    await expect(isSystemdUserServiceAvailable()).resolves.toBe(false);
  });
});

describe("systemd runtime parsing", () => {
  it("parses active state details", () => {
    const output = [
      "ActiveState=inactive",
      "SubState=dead",
      "MainPID=0",
      "ExecMainStatus=2",
      "ExecMainCode=exited",
    ].join("\n");
    expect(parseSystemdShow(output)).toEqual({
      activeState: "inactive",
      subState: "dead",
      execMainStatus: 2,
      execMainCode: "exited",
    });
  });
});

describe("resolveSystemdUserUnitPath", () => {
  it.each([
    {
      name: "uses default service name when FASED_PROFILE is unset",
      env: { HOME: "/home/test" },
      expected: "/home/test/.config/systemd/user/fased-gateway.service",
    },
    {
      name: "uses profile-specific service name when FASED_PROFILE is set to a custom value",
      env: { HOME: "/home/test", FASED_PROFILE: "jbphoenix" },
      expected: "/home/test/.config/systemd/user/fased-gateway-jbphoenix.service",
    },
    {
      name: "prefers FASED_SYSTEMD_UNIT over FASED_PROFILE",
      env: {
        HOME: "/home/test",
        FASED_PROFILE: "jbphoenix",
        FASED_SYSTEMD_UNIT: "custom-unit",
      },
      expected: "/home/test/.config/systemd/user/custom-unit.service",
    },
    {
      name: "handles FASED_SYSTEMD_UNIT with .service suffix",
      env: {
        HOME: "/home/test",
        FASED_SYSTEMD_UNIT: "custom-unit.service",
      },
      expected: "/home/test/.config/systemd/user/custom-unit.service",
    },
    {
      name: "trims whitespace from FASED_SYSTEMD_UNIT",
      env: {
        HOME: "/home/test",
        FASED_SYSTEMD_UNIT: "  custom-unit  ",
      },
      expected: "/home/test/.config/systemd/user/custom-unit.service",
    },
  ])("$name", ({ env, expected }) => {
    expect(resolveSystemdUserUnitPath(env)).toBe(expected);
  });
});

describe("splitArgsPreservingQuotes", () => {
  it("splits on whitespace outside quotes", () => {
    expect(splitArgsPreservingQuotes('/usr/bin/fased gateway start --name "My Bot"')).toEqual([
      "/usr/bin/fased",
      "gateway",
      "start",
      "--name",
      "My Bot",
    ]);
  });

  it("supports systemd-style backslash escaping", () => {
    expect(
      splitArgsPreservingQuotes('fased --name "My \\"Bot\\"" --foo bar', {
        escapeMode: "backslash",
      }),
    ).toEqual(["fased", "--name", 'My "Bot"', "--foo", "bar"]);
  });

  it("supports schtasks-style escaped quotes while preserving other backslashes", () => {
    expect(
      splitArgsPreservingQuotes('fased --path "C:\\\\Program Files\\\\FasedAgent"', {
        escapeMode: "backslash-quote-only",
      }),
    ).toEqual(["fased", "--path", "C:\\\\Program Files\\\\FasedAgent"]);

    expect(
      splitArgsPreservingQuotes('fased --label "My \\"Quoted\\" Name"', {
        escapeMode: "backslash-quote-only",
      }),
    ).toEqual(["fased", "--label", 'My "Quoted" Name']);
  });
});

describe("parseSystemdExecStart", () => {
  it("preserves quoted arguments", () => {
    const execStart = '/usr/bin/fased gateway start --name "My Bot"';
    expect(parseSystemdExecStart(execStart)).toEqual([
      "/usr/bin/fased",
      "gateway",
      "start",
      "--name",
      "My Bot",
    ]);
  });
});

describe("systemd service control", () => {
  beforeEach(() => {
    execFileMock.mockClear();
  });

  it("stops the resolved user unit", async () => {
    execFileMock
      .mockImplementationOnce((_cmd, _args, _opts, cb) => cb(null, "", ""))
      .mockImplementationOnce((_cmd, args, _opts, cb) => {
        expect(args).toEqual(["--user", "stop", "fased-gateway.service"]);
        cb(null, "", "");
      });
    const write = vi.fn();
    const stdout = { write } as unknown as NodeJS.WritableStream;

    await stopSystemdService({ stdout, env: {} });

    expect(write).toHaveBeenCalledTimes(1);
    expect(String(write.mock.calls[0]?.[0])).toContain("Stopped systemd service");
  });

  it("restarts a profile-specific user unit", async () => {
    execFileMock
      .mockImplementationOnce((_cmd, _args, _opts, cb) => cb(null, "", ""))
      .mockImplementationOnce((_cmd, args, _opts, cb) => {
        expect(args).toEqual(["--user", "restart", "fased-gateway-work.service"]);
        cb(null, "", "");
      });
    const write = vi.fn();
    const stdout = { write } as unknown as NodeJS.WritableStream;

    await restartSystemdService({ stdout, env: { FASED_PROFILE: "work" } });

    expect(write).toHaveBeenCalledTimes(1);
    expect(String(write.mock.calls[0]?.[0])).toContain("Restarted systemd service");
  });

  it("surfaces stop failures with systemctl detail", async () => {
    execFileMock
      .mockImplementationOnce((_cmd, _args, _opts, cb) => cb(null, "", ""))
      .mockImplementationOnce((_cmd, _args, _opts, cb) => {
        const err = new Error("stop failed") as Error & { code?: number };
        err.code = 1;
        cb(err, "", "permission denied");
      });

    await expect(
      stopSystemdService({
        stdout: { write: vi.fn() } as unknown as NodeJS.WritableStream,
        env: {},
      }),
    ).rejects.toThrow("systemctl stop failed: permission denied");
  });
});
