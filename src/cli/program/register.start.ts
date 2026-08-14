import type { Command } from "commander";
import { startCommand } from "../../commands/start.js";
import { defaultRuntime } from "../../runtime.js";
import { runCommandWithRuntime } from "../cli-utils.js";

export function registerStartCommand(program: Command) {
  program
    .command("start")
    .description("Start the developer Gateway runtime")
    .option("--mode <mode>", "Startup mode: auto|gateway", "auto")
    .action(async (opts) => {
      const rawMode = String(opts.mode ?? "auto")
        .trim()
        .toLowerCase();
      const mode = rawMode === "auto" || rawMode === "gateway" ? rawMode : null;
      if (!mode) {
        defaultRuntime.error("Invalid --mode (use auto or gateway).");
        defaultRuntime.exit(1);
        return;
      }
      await runCommandWithRuntime(defaultRuntime, async () => {
        await startCommand({ mode }, defaultRuntime);
      });
    });
}
