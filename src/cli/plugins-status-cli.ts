import { resolvePluginLifecycleEntry } from "../plugins/lifecycle.js";
import {
  buildNativePluginStatusReport,
  buildPluginManifestStatusReport,
} from "../plugins/status.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";
import { shortenHomeInString } from "../utils.js";

export type PluginStatusCliOptions = { json?: boolean };

export function pluginInfoCommand(id: string, opts: PluginStatusCliOptions = {}): void {
  const report = buildPluginManifestStatusReport();
  const plugin = resolvePluginLifecycleEntry({ idOrName: id, report });
  if (!plugin) {
    defaultRuntime.error(`Plugin not found: ${id}`);
    defaultRuntime.exit(1);
    return;
  }
  if (opts.json) {
    defaultRuntime.log(JSON.stringify(plugin, null, 2));
    return;
  }
  const lines = [theme.heading(plugin.name || plugin.id)];
  if (plugin.name && plugin.name !== plugin.id) {
    lines.push(theme.muted(`id: ${plugin.id}`));
  }
  if (plugin.description) {
    lines.push(plugin.description);
  }
  lines.push(
    "",
    `${theme.muted("Status:")} ${plugin.status}`,
    `${theme.muted("Source:")} ${shortenHomeInString(plugin.source)}`,
    `${theme.muted("Origin:")} ${plugin.origin}`,
  );
  if (plugin.version) {
    lines.push(`${theme.muted("Version:")} ${plugin.version}`);
  }
  if (plugin.channelIds.length > 0) {
    lines.push(`${theme.muted("Channels:")} ${plugin.channelIds.join(", ")}`);
  }
  if (plugin.providerIds.length > 0) {
    lines.push(`${theme.muted("Providers:")} ${plugin.providerIds.join(", ")}`);
  }
  if (plugin.hookNames.length > 0) {
    lines.push(`${theme.muted("Hooks:")} ${plugin.hookNames.join(", ")}`);
  }
  if (plugin.error) {
    lines.push(`${theme.muted("Note:")} ${plugin.error}`);
  }
  defaultRuntime.log(lines.join("\n"));
}

export async function pluginDoctorCommand(opts: PluginStatusCliOptions = {}): Promise<void> {
  const report = await buildNativePluginStatusReport();
  const errors = report.plugins.filter((plugin) => plugin.status === "error");
  const diagnostics = report.diagnostics.filter((diagnostic) => diagnostic.level === "error");
  if (opts.json) {
    defaultRuntime.log(
      JSON.stringify(
        { ok: errors.length === 0 && diagnostics.length === 0, errors, diagnostics },
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
