import process from "node:process";
import {
  readCurrentPackageVersion,
  readValidPluginStatusCache,
} from "../../plugins/status-cache.js";

function findPluginId(argv: string[]): string | null {
  for (const token of argv.slice(4)) {
    if (token && !token.startsWith("-")) {
      return token;
    }
  }
  return null;
}

export async function run(argv: string[] = process.argv): Promise<boolean> {
  const id = argv[2] === "plugins" && argv[3] === "info" ? findPluginId(argv) : null;
  const packageVersion = readCurrentPackageVersion(argv[1]);
  const cache = packageVersion ? readValidPluginStatusCache({ packageVersion }) : null;
  const plugin = id ? cache?.plugins.find((entry) => entry.id === id || entry.name === id) : null;
  if (!plugin) {
    return false;
  }
  if (argv.includes("--json")) {
    console.log(JSON.stringify(plugin, null, 2));
    return true;
  }
  const lines = [plugin.name || plugin.id];
  if (plugin.name && plugin.name !== plugin.id) {
    lines.push(`id: ${plugin.id}`);
  }
  if (plugin.description) {
    lines.push(plugin.description);
  }
  lines.push(
    "",
    `Status: ${plugin.status}`,
    `Source: ${plugin.source}`,
    `Origin: ${plugin.origin}`,
  );
  if (plugin.version) {
    lines.push(`Version: ${plugin.version}`);
  }
  console.log(lines.join("\n"));
  return true;
}
