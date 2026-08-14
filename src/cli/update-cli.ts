import type { Command } from "commander";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";
import { inheritOptionFromParent } from "./command-options.js";
import { formatHelpExamples } from "./help-format.js";
import { type UpdateCommandOptions, type UpdateStatusOptions } from "./update-cli/shared.js";
import { updateStatusCommand } from "./update-cli/status.js";
import { updateCommand } from "./update-cli/update-command.js";

export { updateCommand, updateStatusCommand };
export type { UpdateCommandOptions, UpdateStatusOptions };

function inheritedUpdateJson(command?: Command): boolean {
  return Boolean(inheritOptionFromParent<boolean>(command, "json"));
}

function inheritedUpdateTimeout(
  opts: { timeout?: unknown },
  command?: Command,
): string | undefined {
  const timeout = opts.timeout as string | undefined;
  if (timeout) {
    return timeout;
  }
  return inheritOptionFromParent<string>(command, "timeout");
}

export function registerUpdateCli(program: Command) {
  const update = program
    .command("update")
    .description("Enter the verified managed lifecycle updater")
    .option("--json", "Output result as JSON", false)
    .option("--verbose", "Show detailed update timing", false)
    .option("--channel <stable|beta>", "Select a signed managed release channel")
    .option("--tag <version>", "Select an exact signed managed release")
    .option("--timeout <seconds>", "Bound the managed lifecycle transaction")
    .option("--yes", "Confirm non-interactively", false)
    .addHelpText("after", () => {
      const examples = [
        ["fased update", "Update to the configured channel (stable by default)"],
        ["fased update --channel beta", "Select the signed beta channel"],
        ["fased update --tag 1.2.3", "Select an exact signed release"],
        ["fased update --json", "Output result as JSON"],
        ["fased dev update-source", "Update a developer source checkout"],
        ["fased --update", "Shorthand for fased update"],
      ] as const;
      const fmtExamples = examples
        .map(([cmd, desc]) => `  ${theme.command(cmd)} ${theme.muted(`# ${desc}`)}`)
        .join("\n");
      return `
${theme.heading("What this does:")}
  - The installed stable launcher routes managed Local and Hosting updates to Go
  - Direct Node/package invocation does not mutate a managed installation
  - Developer source updates use the separate fased dev update-source command

${theme.heading("Switch channels:")}
  - Use --channel stable|beta for a signed managed channel
  - Use --tag <version> for an exact signed release
  - Run fased update status to read canonical installed lifecycle identity

${theme.heading("Non-interactive:")}
  - Combine --yes with --channel/--tag/--json/--timeout as needed

${theme.heading("Examples:")}
${fmtExamples}

${theme.heading("Notes:")}
  - Managed installation and update never use npm, pnpm, Git, or application mutation code
  - If this command reaches Node directly, rerun the verified public installer

${theme.muted("Docs:")} ${formatDocsLink("/cli/update", "docs.fased.ai/cli/update")}`;
    })
    .action(async (opts) => {
      try {
        await updateCommand({
          json: Boolean(opts.json),
          verbose: Boolean(opts.verbose),
          channel: opts.channel as string | undefined,
          tag: opts.tag as string | undefined,
          timeout: opts.timeout as string | undefined,
          yes: Boolean(opts.yes),
        });
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  update
    .command("status")
    .description("Show canonical managed lifecycle identity")
    .option("--json", "Output result as JSON", false)
    .option("--timeout <seconds>", "Timeout for update checks in seconds (default: 3)")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["fased update status", "Show signed installed lifecycle identity."],
          ["fased update status --json", "JSON output."],
          ["fased update status --timeout 10", "Custom timeout."],
        ])}\n\n${theme.heading("Notes:")}\n${theme.muted(
          "- The installed launcher routes this command to the Go lifecycle status authority",
        )}\n${theme.muted("- Direct Node/package invocation refuses instead of inventing status")}\n\n${theme.muted(
          "Docs:",
        )} ${formatDocsLink("/cli/update", "docs.fased.ai/cli/update")}`,
    )
    .action(async (opts, command) => {
      try {
        await updateStatusCommand({
          json: Boolean(opts.json) || inheritedUpdateJson(command),
          timeout: inheritedUpdateTimeout(opts, command),
        });
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });
}
