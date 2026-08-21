import process from "node:process";
import {
  readCurrentPackageVersion,
  readValidPluginStatusCache,
} from "../../plugins/status-cache.js";

export async function run(argv: string[] = process.argv): Promise<boolean> {
  if (argv[2] !== "plugins" || argv[3] !== "doctor") {
    return false;
  }
  const packageVersion = readCurrentPackageVersion(argv[1]);
  const cache = packageVersion ? readValidPluginStatusCache({ packageVersion }) : null;
  if (!cache) {
    return false;
  }
  const errors = cache.plugins.filter((plugin) => plugin.status === "error");
  const diagnostics = cache.diagnostics.filter((diagnostic) => diagnostic.level === "error");
  if (argv.includes("--json")) {
    console.log(
      JSON.stringify(
        {
          ok: errors.length === 0 && diagnostics.length === 0,
          plugins: cache.plugins,
          errors,
          diagnostics,
        },
        null,
        2,
      ),
    );
  } else if (errors.length === 0 && diagnostics.length === 0) {
    console.log("No plugin issues detected.");
  } else {
    for (const plugin of errors) {
      console.error(`- ${plugin.id}: ${plugin.error ?? "failed to load"} (${plugin.source})`);
    }
    for (const diagnostic of diagnostics) {
      console.error(
        `- ${diagnostic.pluginId ? `${diagnostic.pluginId}: ` : ""}${diagnostic.message}`,
      );
    }
    process.exitCode = 1;
  }
  return true;
}
