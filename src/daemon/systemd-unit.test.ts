import { describe, expect, it } from "vitest";
import { buildSystemdUnit } from "./systemd-unit.js";

describe("buildSystemdUnit", () => {
  it("quotes arguments with whitespace", () => {
    const unit = buildSystemdUnit({
      description: "FasedAgent Gateway",
      programArguments: ["/usr/bin/fased", "gateway", "--name", "My Bot"],
      environment: {},
    });
    const execStart = unit.split("\n").find((line) => line.startsWith("ExecStart="));
    expect(execStart).toBe('ExecStart=/usr/bin/fased gateway --name "My Bot"');
  });

  it("stops the full managed process group on restart", () => {
    const unit = buildSystemdUnit({
      description: "FasedAgent Gateway",
      programArguments: ["/bin/bash", "/srv/fased/scripts/start-managed.sh"],
      environment: {},
    });
    expect(unit).toContain("KillMode=control-group");
    expect(unit).not.toContain("KillMode=mixed");
  });

  it("rejects environment values with line breaks", () => {
    expect(() =>
      buildSystemdUnit({
        description: "FasedAgent Gateway",
        programArguments: ["/usr/bin/fased", "gateway", "start"],
        environment: {
          INJECT: "ok\nExecStartPre=/bin/touch /tmp/oc15789_rce",
        },
      }),
    ).toThrow(/CR or LF/);
  });
});
