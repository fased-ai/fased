import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runRegisteredCli } from "../test-utils/command-runner.js";

const mocks = vi.hoisted(() => ({
  runDeveloperSourceUpdate: vi.fn(async (_opts: unknown) => {}),
}));

vi.mock("./update-cli/source-update-command.js", () => ({
  runDeveloperSourceUpdate: (opts: unknown) => mocks.runDeveloperSourceUpdate(opts),
}));

beforeEach(() => {
  mocks.runDeveloperSourceUpdate.mockClear();
});

describe("developer source update CLI", () => {
  it("routes source mutation only through fased dev update-source", async () => {
    const { registerDevCli } = await import("./dev-cli.js");

    await runRegisteredCli({
      register: registerDevCli as (program: Command) => void,
      argv: ["dev", "update-source", "--dry-run", "--channel", "dev"],
    });

    expect(mocks.runDeveloperSourceUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true, channel: "dev" }),
    );
  });
});
