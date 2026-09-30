import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerWalletCommands } from "./register.wallet.js";

describe("native wallet CLI contract", () => {
  it("exposes the same create/import/RPC/recovery/export/status lifecycle on Local and Hosting", () => {
    const program = new Command();
    registerWalletCommands(program);
    const wallet = program.commands.find((command) => command.name() === "wallet");
    expect(wallet).toBeDefined();
    const commands = new Map(wallet?.commands.map((command) => [command.name(), command]));
    for (const name of [
      "create",
      "import",
      "retire",
      "rpc",
      "recovery",
      "export-raw",
      "status",
      "wen-btc-review",
    ]) {
      expect(commands.has(name), `missing fased wallet ${name}`).toBe(true);
    }
    expect(commands.get("rpc")?.commands.map((command) => command.name())).toContain("set");
    const recovery = commands.get("recovery");
    expect(recovery?.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining(["export", "restore", "export-raw"]),
    );
    expect(recovery?.commands.find((command) => command.name() === "restore")?.aliases()).toContain(
      "import",
    );
  });
  it("presents standard wallets without requiring legacy role choices", () => {
    const program = new Command();
    registerWalletCommands(program);
    const wallet = program.commands.find((command) => command.name() === "wallet")!;
    for (const name of ["create", "import", "setup"]) {
      const command = wallet.commands.find((item) => item.name() === name)!;
      expect(command.helpInformation()).not.toContain("--role");
      expect(command.helpInformation()).not.toContain("role-ready");
      const legacy = command.options.find((option) => option.long === "--role");
      expect(legacy?.mandatory).toBe(false);
      expect(legacy?.hidden).toBe(true);
    }
    expect(wallet.helpInformation()).not.toContain("role set");
  });
});
