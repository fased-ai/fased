import { resolvePluginLifecycleEntry } from "../plugins/lifecycle.js";
import { buildPluginManifestStatusReport } from "../plugins/status-manifest.js";
import { defaultRuntime } from "../runtime.js";
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
