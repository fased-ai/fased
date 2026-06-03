import type { Command } from "commander";
import { formatDocsLink } from "../../terminal/links.js";
import { theme } from "../../terminal/theme.js";
import {
  registerCronAddCommand,
  registerCronListCommand,
  registerCronStatusCommand,
} from "./register.cron-add.js";
import { registerCronEditCommand } from "./register.cron-edit.js";
import { registerCronSimpleCommands } from "./register.cron-simple.js";
import { registerCronSmokeCommand } from "./register.cron-smoke.js";
import { registerCronWorkerCommand } from "./register.cron-worker.js";

type CronCliRegistrationOptions = {
  commandName?: "cron" | "task";
  description?: string;
  docsPath?: string;
  docsLabel?: string;
};

export function registerCronCli(program: Command, opts: CronCliRegistrationOptions = {}) {
  const commandName = opts.commandName ?? "cron";
  const cron = program
    .command(commandName)
    .description(
      opts.description ??
        (commandName === "cron"
          ? "Manage scheduled Agent tasks (compatibility alias)"
          : "Manage scheduled Agent tasks"),
    )
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink(
          opts.docsPath ?? "/cli/task",
          opts.docsLabel ?? "docs.fased.ai/cli/task",
        )}\n`,
    );

  registerCronStatusCommand(cron);
  registerCronListCommand(cron);
  registerCronAddCommand(cron);
  registerCronSimpleCommands(cron);
  registerCronSmokeCommand(cron);
  registerCronEditCommand(cron);
  registerCronWorkerCommand(cron);
}

export function registerTaskCli(program: Command) {
  registerCronCli(program, {
    commandName: "task",
    description: "Manage scheduled Agent tasks",
    docsPath: "/cli/task",
    docsLabel: "docs.fased.ai/cli/task",
  });
}
