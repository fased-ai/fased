import { buildNativePluginStatusReport } from "../plugins/status.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";
import type { PluginStatusCliOptions } from "./plugins-info-cli.js";

export async function pluginDoctorCommand(opts: PluginStatusCliOptions = {}): Promise<void> {
  const report = await buildNativePluginStatusReport();
  const errors = report.plugins.filter((plugin) => plugin.status === "error");
  const diagnostics = report.diagnostics.filter((diagnostic) => diagnostic.level === "error");
  if (opts.json) {
    defaultRuntime.log(
      JSON.stringify(
        {
          ok: errors.length === 0 && diagnostics.length === 0,
          plugins: report.plugins,
          errors,
          diagnostics,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (errors.length === 0 && diagnostics.length === 0) {
    defaultRuntime.log("No plugin issues detected.");
    return;
  }
  const lines: string[] = [];
  if (errors.length > 0) {
    lines.push(theme.error("Plugin errors:"));
    for (const entry of errors) {
      lines.push(`- ${entry.id}: ${entry.error ?? "failed to load"} (${entry.source})`);
    }
  }
  if (diagnostics.length > 0) {
    if (lines.length > 0) {
      lines.push("");
    }
    lines.push(theme.warn("Diagnostics:"));
    for (const diagnostic of diagnostics) {
      const target = diagnostic.pluginId ? `${diagnostic.pluginId}: ` : "";
      lines.push(`- ${target}${diagnostic.message}`);
    }
  }
  lines.push("", `${theme.muted("Docs:")} ${formatDocsLink("/plugin", "docs.fased.ai/plugin")}`);
  defaultRuntime.log(lines.join("\n"));
}
