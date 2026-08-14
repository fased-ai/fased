import type { Command } from "commander";
import { buildCapabilityReadinessReport } from "../capabilities/catalog.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";
import { installComponentCommand, renderComponentReport } from "./components-cli.js";

export function registerServicesCli(program: Command) {
  const services = program
    .command("services")
    .description("Inspect bundled components and external runtimes");

  services
    .command("status")
    .description("Show service and component readiness")
    .option("--json", "Output JSON", false)
    .action((options: { json?: boolean }) => renderComponentReport(options));

  services
    .command("install")
    .description("Enable an official bundled component")
    .argument("<id>", "Component id from `fased services status`")
    .action(async (id: string) => installComponentCommand(id));

  services
    .command("connect")
    .description("Show the canonical component connection surface")
    .argument("<id>", "Component id from `fased services status`")
    .action(async (id: string) => {
      const entry = buildCapabilityReadinessReport().entries.find(
        (candidate) => candidate.id === id.trim(),
      );
      if (!entry) {
        throw new Error(`Unknown service component: ${id}. Run \`fased services status\`.`);
      }
      defaultRuntime.log(`${theme.heading(entry.label)}: ${entry.detail}`);
      defaultRuntime.log(`Connect from: ${entry.surface}`);
      defaultRuntime.log(
        `Docs: ${formatDocsLink(entry.docsPath, `docs.fased.ai${entry.docsPath}`)}`,
      );
    });
}
