import type { Command } from "commander";
import {
  buildCapabilityReadinessReport,
  formatCapabilityReadinessSummary,
} from "../capabilities/catalog.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { renderTable } from "../terminal/table.js";
import { theme } from "../terminal/theme.js";

export function registerComponentsCli(program: Command) {
  program
    .command("components")
    .description("Show core, add-on, and external component readiness")
    .option("--json", "Output JSON", false)
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/install/components", "docs.fased.ai/install/components")}\n`,
    )
    .action((options: { json?: boolean }) => {
      const report = buildCapabilityReadinessReport();
      if (options.json) {
        defaultRuntime.log(JSON.stringify(report, null, 2));
        return;
      }
      const width = Math.max(80, (process.stdout.columns ?? 120) - 1);
      defaultRuntime.log(theme.heading("Fased components"));
      defaultRuntime.log(theme.muted(formatCapabilityReadinessSummary(report)));
      defaultRuntime.log(
        renderTable({
          width,
          columns: [
            { key: "Component", header: "Component", minWidth: 18, flex: true },
            { key: "Category", header: "Category", minWidth: 10 },
            { key: "Delivery", header: "Delivery", minWidth: 16 },
            { key: "State", header: "State", minWidth: 18 },
            { key: "Next", header: "Next", minWidth: 10 },
          ],
          rows: report.entries.map((entry) => ({
            Component: entry.label,
            Category: entry.category,
            Delivery: entry.delivery,
            State: entry.state,
            Next: entry.action,
          })),
        }).trimEnd(),
      );
    });
}
