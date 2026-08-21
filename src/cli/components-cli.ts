import type { Command } from "commander";
import {
  buildCapabilityReadinessReport,
  formatCapabilityReadinessSummary,
} from "../capabilities/catalog.js";
import { installCapabilityComponent } from "../capabilities/install.js";
import { loadConfig, writeConfigFile } from "../config/config.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { renderTable } from "../terminal/table.js";
import { theme } from "../terminal/theme.js";

export function registerComponentsCli(program: Command) {
  const components = program
    .command("components")
    .description("Show bundled and external component readiness")
    .option("--json", "Output JSON", false)
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/install/components", "docs.fased.ai/install/components")}\n`,
    )
    .action((options: { json?: boolean }) => {
      renderComponentReport(options);
    });

  components
    .command("list")
    .description("Show bundled and external component readiness")
    .option("--json", "Output JSON", false)
    .action((options: { json?: boolean }) => {
      renderComponentReport(options);
    });

  components
    .command("install")
    .description("Enable a core component or install a signed managed component")
    .argument("<id>", "Component id from `fased components`")
    .option("--catalog <path>", "Exact local P6 component catalog")
    .option("--catalog-digest <sha256>", "Exact canonical catalog digest")
    .option("--archive <path>", "Exact local P6 component archive")
    .action(async (id: string, options: ComponentInstallOptions) => {
      await installComponentCommand(id, options);
    });
}

type ComponentInstallOptions = {
  catalog?: string;
  catalogDigest?: string;
  archive?: string;
};

export async function installComponentCommand(id: string, options: ComponentInstallOptions = {}) {
  const transaction =
    options.catalog || options.catalogDigest || options.archive
      ? {
          catalogPath: options.catalog ?? "",
          catalogDigest: options.catalogDigest ?? "",
          archivePath: options.archive ?? "",
        }
      : undefined;
  const result = await installCapabilityComponent({ id, config: loadConfig(), transaction });
  await writeConfigFile(result.config);
  for (const warning of result.slotWarnings) {
    defaultRuntime.log(theme.warn(warning));
  }
  defaultRuntime.log(
    result.entry.delivery === "managed-component"
      ? `Installed signed component: ${result.entry.label}`
      : `Enabled core component: ${result.entry.label}`,
  );
  if (result.entry.restartRequired !== false) {
    defaultRuntime.log("Restart the gateway to apply the component.");
  }
}

export function renderComponentReport(options: { json?: boolean }) {
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
}
