import { describe, expect, it } from "vitest";
import { __testing } from "./q0-protected-local-controller-candidate.mjs";

describe("Q0 protected Local controller candidate", () => {
  it("binds the injected controller identity to the target release", () => {
    expect(
      __testing.parseArguments([
        "activate",
        "--instance",
        "0123456789abcdef",
        "--source-root",
        "/repo",
        "--target-version",
        "v1.2.3-rc.4",
      ]),
    ).toEqual({
      operation: "activate",
      instanceId: "0123456789abcdef",
      sourceRoot: "/repo",
      targetVersion: "1.2.3-rc.4",
    });
    expect(
      __testing.q0ControllerGenerationRoot(
        "/opt/fased/controller/releases",
        "1.2.3-rc.4",
        "a".repeat(64),
      ),
    ).toBe("/opt/fased/controller/releases/v1.2.3-rc.4.q0.aaaaaaaaaaaa");
  });

  it("rejects target-less or malformed candidate activation", () => {
    expect(() =>
      __testing.parseArguments([
        "activate",
        "--instance",
        "0123456789abcdef",
        "--source-root",
        "/repo",
      ]),
    ).toThrow(/target-version/u);
    expect(() =>
      __testing.parseArguments([
        "activate",
        "--instance",
        "0123456789abcdef",
        "--source-root",
        "/repo",
        "--target-version",
        "../candidate",
      ]),
    ).toThrow(/target-version/u);
  });
});
