import type { Command } from "commander";
import { managedUpCommand } from "../../commands/managed-up.js";
import { defaultRuntime } from "../../runtime.js";
import { runCommandWithRuntime } from "../cli-utils.js";

export function registerManagedCommand(program: Command) {
  const managed = program.command("managed").description("Managed public startup helpers");

  managed
    .command("up")
    .description("Run managed startup lifecycle (gateway + federation + tunnel + wallet checks)")
    .option("--json", "Print managed preflight summary and exit", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await managedUpCommand(defaultRuntime, {
          json: Boolean(opts.json),
        });
      });
    });
}
