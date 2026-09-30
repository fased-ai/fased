import type { Command } from "commander";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";
import { formatHelpExamples } from "./help-format.js";

export type MemoryCommandOptions = {
  agent?: string;
  json?: boolean;
  deep?: boolean;
  index?: boolean;
  force?: boolean;
  verbose?: boolean;
};

export type MemoryRepairExecuteOptions = {
  agent?: string;
  proposalId?: string[];
  executionId?: string;
  yes?: boolean;
  json?: boolean;
};

type MemorySearchOptions = MemoryCommandOptions & {
  query?: string;
  maxResults?: number;
  minScore?: number;
};

export async function runMemoryDoctorStatus(opts: Pick<MemoryCommandOptions, "agent" | "json">) {
  return (await import("./memory-cli-actions.js")).runMemoryDoctorStatus(opts);
}

export async function runMemoryRepairExecute(opts: MemoryRepairExecuteOptions) {
  return (await import("./memory-cli-actions.js")).runMemoryRepairExecute(opts);
}

export async function runMemoryStatus(opts: MemoryCommandOptions) {
  return (await import("./memory-cli-actions.js")).runMemoryStatus(opts);
}

export function registerMemoryCli(program: Command) {
  const memory = program
    .command("memory")
    .description("Search, inspect, and reindex memory files")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["fased memory status", "Show index and provider status."],
          ["fased memory doctor", "Show read-only memory doctor diagnostics."],
          [
            "fased memory repair execute --proposal-id memory-repair-preview-1 --yes",
            "Execute a selected Memory Doctor repair proposal.",
          ],
          ["fased memory index --force", "Force a full reindex."],
          ['fased memory search --query "deployment notes"', "Search indexed memory entries."],
          ["fased memory status --json", "Output machine-readable JSON."],
        ])}\n\n${theme.muted("Docs:")} ${formatDocsLink("/cli/memory", "docs.fased.ai/cli/memory")}\n`,
    );

  memory
    .command("status")
    .description("Show memory search index status")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--json", "Print JSON")
    .option("--deep", "Probe embedding provider availability")
    .option("--index", "Reindex if dirty (implies --deep)")
    .option("--verbose", "Verbose logging", false)
    .action(async (opts: MemoryCommandOptions & { force?: boolean }) => {
      await runMemoryStatus(opts);
    });

  memory
    .command("doctor")
    .description("Show read-only memory doctor diagnostics")
    .option("--agent <id>", "Agent id (default: all configured agents)")
    .option("--json", "Print JSON")
    .action(async (opts: Pick<MemoryCommandOptions, "agent" | "json">) => {
      await runMemoryDoctorStatus(opts);
    });

  const collectProposalId = (value: string, previous: string[] = []) => [...previous, value];
  memory
    .command("repair")
    .description("Execute gated Memory Doctor repairs")
    .command("execute")
    .description("Execute selected Memory Doctor repair proposals with backup and audit")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option(
      "--proposal-id <id>",
      "Proposal id to execute; repeat for multiple proposals",
      collectProposalId,
      [],
    )
    .option("--execution-id <id>", "Safe execution id for idempotency/audit records")
    .option("--yes", "Confirm write-capable memory repair execution", false)
    .option("--json", "Print JSON")
    .action(async (opts: MemoryRepairExecuteOptions) => {
      await runMemoryRepairExecute(opts);
    });

  memory
    .command("index")
    .description("Reindex memory files")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--force", "Force full reindex", false)
    .option("--verbose", "Verbose logging", false)
    .action(async (opts: MemoryCommandOptions) => {
      await (await import("./memory-cli-actions.js")).runMemoryIndex(opts);
    });

  memory
    .command("search")
    .description("Search memory files")
    .argument("[query]", "Search query")
    .option("--query <text>", "Search query (alternative to positional argument)")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--max-results <n>", "Max results", (value: string) => Number(value))
    .option("--min-score <n>", "Minimum score", (value: string) => Number(value))
    .option("--json", "Print JSON")
    .action(async (queryArg: string | undefined, opts: MemorySearchOptions) => {
      await (await import("./memory-cli-actions.js")).runMemorySearch(queryArg, opts);
    });
}
