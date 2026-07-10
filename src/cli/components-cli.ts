import type { Command } from "commander";
import {
  buildCapabilityReadinessReport,
  formatCapabilityReadinessSummary,
  loadCapabilityCatalog,
} from "../capabilities/catalog.js";
import { loadConfig, writeConfigFile } from "../config/config.js";
import { installPluginFromNpmSpec } from "../plugins/install.js";
import { buildNpmResolutionInstallFields } from "../plugins/installs.js";
import { finalizeInstalledPluginConfig } from "../plugins/lifecycle.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { renderTable } from "../terminal/table.js";
import { theme } from "../terminal/theme.js";

export function registerComponentsCli(program: Command) {
  const components = program
    .command("components")
    .description("Show core, add-on, and external component readiness")
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
    .description("Show core, add-on, and external component readiness")
    .option("--json", "Output JSON", false)
    .action((options: { json?: boolean }) => {
      renderComponentReport(options);
    });

  components
    .command("install")
    .description("Install a cataloged optional component")
    .argument("<id>", "Component id from `fased components`")
    .action(async (id: string) => {
      const entry = loadCapabilityCatalog().find((candidate) => candidate.id === id);
      if (!entry) {
        throw new Error(`Unknown component: ${id}. Run \`fased components\` to list choices.`);
      }
      if (entry.delivery !== "npm-addon" || !entry.packageName || !entry.pluginId) {
        throw new Error(
          `${entry.label} is delivered as ${entry.delivery} and cannot be installed as an add-on. See ${entry.docsPath}.`,
        );
      }

      const result = await installPluginFromNpmSpec({ spec: entry.packageName });
      if (!result.ok) {
        throw new Error(result.error);
      }
      const config = loadConfig();
      const finalized = finalizeInstalledPluginConfig({
        config,
        pluginId: result.pluginId,
        refreshManifestRegistry: true,
        installRecord: {
          source: "npm",
          spec: entry.packageName,
          installPath: result.targetDir,
          version: result.version,
          ...buildNpmResolutionInstallFields(result.npmResolution),
        },
      });
      await writeConfigFile(finalized.config);
      for (const warning of finalized.slotWarnings) {
        defaultRuntime.log(theme.warn(warning));
      }
      defaultRuntime.log(`Installed component: ${entry.label} (${entry.packageName})`);
      if (entry.restartRequired !== false) {
        defaultRuntime.log("Restart the gateway to apply the component.");
      }
    });
}

function renderComponentReport(options: { json?: boolean }) {
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
