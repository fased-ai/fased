import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerFederationCli } from "./federation-cli.js";
import { registerMiningCli } from "./mining-cli.js";

describe("top-level mining and federation CLIs", () => {
  it("registers the expected mining subcommands", () => {
    const program = new Command();
    registerMiningCli(program);

    const mining = program.commands.find((command) => command.name() === "mining");
    expect(mining).toBeTruthy();
    expect(mining?.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining([
        "status",
        "readiness",
        "wallets",
        "start",
        "stop",
        "history",
        "deposit-capital",
        "withdraw-capital",
        "set-commit",
      ]),
    );
  });

  it("registers the expected federation subcommands", () => {
    const program = new Command();
    registerFederationCli(program);

    const federation = program.commands.find((command) => command.name() === "federation");
    expect(federation).toBeTruthy();
    expect(federation?.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining(["status", "token", "paths", "bond-wallet"]),
    );
  });
});
