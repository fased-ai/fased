import type { Command } from "commander";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { loadConfig } from "../config/config.js";
import { getRemoteSkillEligibility } from "../infra/skills-remote.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";
import { formatSkillInfo, formatSkillsCheck, formatSkillsList } from "./skills-cli.format.js";
import {
  runSkillsMarketplaceInstall,
  runSkillsMarketplaceUpdate,
} from "./skills-marketplace-actions.js";
import {
  runSkillsMarketplaceInspect,
  runSkillsMarketplaceList,
} from "./skills-marketplace-list.js";
import { runSkillsWalletGrant } from "./skills-wallet-grant.js";

export type {
  SkillInfoOptions,
  SkillsCheckOptions,
  SkillsListOptions,
} from "./skills-cli.format.js";
export { formatSkillInfo, formatSkillsCheck, formatSkillsList } from "./skills-cli.format.js";

type SkillStatusReport = Awaited<
  ReturnType<(typeof import("../agents/skills-status.js"))["buildWorkspaceSkillStatus"]>
>;

async function loadSkillsStatusReport(): Promise<SkillStatusReport> {
  const config = loadConfig();
  const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
  const { buildWorkspaceSkillStatus } = await import("../agents/skills-status.js");
  return buildWorkspaceSkillStatus(workspaceDir, {
    config,
    eligibility: { remote: getRemoteSkillEligibility() },
  });
}

async function runSkillsAction(render: (report: SkillStatusReport) => string): Promise<void> {
  try {
    const report = await loadSkillsStatusReport();
    defaultRuntime.log(render(report));
  } catch (err) {
    defaultRuntime.error(String(err));
    defaultRuntime.exit(1);
  }
}

/**
 * Register the skills CLI commands
 */
export function registerSkillsCli(program: Command) {
  const skills = program
    .command("skills")
    .description("List and inspect available skills")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/skills", "docs.fased.ai/cli/skills")}\n`,
    );

  skills
    .command("list")
    .description("List all available skills")
    .option("--json", "Output as JSON", false)
    .option("--eligible", "Show only eligible (ready to use) skills", false)
    .option("-v, --verbose", "Show more details including missing requirements", false)
    .action(async (opts) => {
      await runSkillsAction((report) => formatSkillsList(report, opts));
    });

  skills
    .command("inspect")
    .description("Inspect a skill, including marketplace source and permissions when tracked")
    .argument("<name>", "Skill name")
    .option("--json", "Output as JSON", false)
    .action(async (name, opts) => {
      await runSkillsAction((report) => formatSkillInfo(report, name, opts));
    });

  skills
    .command("permissions")
    .description("Show marketplace source, requested permissions, grants, and update review")
    .argument("<skill-id>", "Skill id")
    .option("--json", "Output JSON", false)
    .action(async (skillId: string, opts) => {
      await runSkillsMarketplaceInspect({ skillId, opts });
    });

  skills
    .command("info")
    .description("Show detailed information about a skill")
    .argument("<name>", "Skill name")
    .option("--json", "Output as JSON", false)
    .action(async (name, opts) => {
      await runSkillsAction((report) => formatSkillInfo(report, name, opts));
    });

  skills
    .command("check")
    .description("Check which skills are ready vs missing requirements")
    .option("--json", "Output as JSON", false)
    .action(async (opts) => {
      await runSkillsAction((report) => formatSkillsCheck(report, opts));
    });

  const wallet = skills.command("wallet").description("Manage skill wallet-action permissions");

  const marketplace = skills
    .command("marketplace")
    .description("Inspect installed marketplace skill sources and permissions");

  marketplace
    .command("list")
    .description("List tracked ClawHub skills, requested permissions, and wallet grants")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runSkillsMarketplaceList({ opts });
    });

  marketplace
    .command("install")
    .description("Install a skill from ClawHub with Fased marketplace safety checks")
    .argument("<slug>", "ClawHub skill slug")
    .option("--version <version>", "Install a specific ClawHub skill version")
    .option("--registry <url>", "ClawHub registry URL", undefined)
    .option("--force", "Replace an existing installed skill", false)
    .option("--dry-run", "Preview install permission review without installing", false)
    .option(
      "--approve-permission-change",
      "Explicitly approve risky permission changes when --force updates an existing skill",
      false,
    )
    .option("--json", "Output JSON", false)
    .action(async (slug: string, opts) => {
      await runSkillsMarketplaceInstall({ slug, opts });
    });

  marketplace
    .command("update")
    .description("Update tracked ClawHub skills with permission-review enforcement")
    .argument("[slug]", "Optional tracked ClawHub skill slug")
    .option("--registry <url>", "ClawHub registry URL for legacy lockfile-only entries", undefined)
    .option("--dry-run", "Preview update permission review without installing", false)
    .option("--approve-permission-change", "Explicitly approve risky permission changes", false)
    .option("--json", "Output JSON", false)
    .action(async (slug: string | undefined, opts) => {
      await runSkillsMarketplaceUpdate({ slug, opts });
    });

  wallet
    .command("grant")
    .description("Grant a skill narrow wallet-action permissions")
    .argument("<skill-id>", "Skill id")
    .option(
      "--actions <list>",
      "Comma-separated wallet actions such as quote,swap,schedule_plan,schedule_send",
    )
    .option(
      "--action <name>",
      "Wallet action to allow; repeatable",
      (value, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option(
      "--registry <url>",
      "Allowed ClawHub registry origin; repeatable",
      (value, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option("--role <role>", "Wallet role to allow; only agent is supported", "agent")
    .option(
      "--wallet-id <id>",
      "Agent wallet id this skill may use; repeatable",
      (value, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option(
      "--chain <chain>",
      "Wallet chain to allow; repeatable or comma-separated",
      (value, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option(
      "--input-mint <mint>",
      "Allowed input mint; repeatable",
      (value, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option(
      "--output-mint <mint>",
      "Allowed output mint; repeatable",
      (value, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option("--max-amount <base-units>", "Maximum input amount in base units")
    .option("--max-slippage-bps <bps>", "Maximum slippage in basis points")
    .option("--autonomous", "Allow autonomous execution", false)
    .option("--cron", "Allow scheduled wallet-action plans", false)
    .option("--dry-run", "Print/write nothing; use with --json to preview", false)
    .option("--json", "Output JSON", false)
    .action(async (skillId: string, opts) => {
      await runSkillsWalletGrant({ skillId, opts });
    });

  // Default action (no subcommand) - show list
  skills.action(async () => {
    await runSkillsAction((report) => formatSkillsList(report, {}));
  });
}
