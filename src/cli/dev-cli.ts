import type { Command } from "commander";
import { defaultRuntime } from "../runtime.js";
import { runDeveloperSourceUpdate } from "./update-cli/source-update-command.js";

export function registerDevCli(program: Command): void {
  const dev = program.command("dev").description("Explicit source-development operations");
  dev
    .command("update-source")
    .description("Update and rebuild a developer source checkout")
    .option("--json", "Output result as JSON", false)
    .option("--verbose", "Show detailed update timing", false)
    .option("--no-restart", "Skip restarting the developer Gateway")
    .option("--dry-run", "Preview source update actions", false)
    .option("--channel <dev>", "Select the developer source channel", "dev")
    .option("--timeout <seconds>", "Timeout for each source update step")
    .option("--yes", "Skip confirmation prompts", false)
    .action(async (opts) => {
      try {
        await runDeveloperSourceUpdate({
          json: Boolean(opts.json),
          verbose: Boolean(opts.verbose),
          restart: Boolean(opts.restart),
          dryRun: Boolean(opts.dryRun),
          channel: opts.channel as string | undefined,
          timeout: opts.timeout as string | undefined,
          yes: Boolean(opts.yes),
        });
      } catch (error) {
        defaultRuntime.error(String(error));
        defaultRuntime.exit(1);
      }
    });
}
