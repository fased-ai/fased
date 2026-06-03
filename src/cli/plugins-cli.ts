import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Command } from "commander";
import type { FasedAgentConfig } from "../config/config.js";
import { loadConfig, writeConfigFile } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { resolveArchiveKind } from "../infra/archive.js";
import { findBundledPluginByNpmSpec } from "../plugins/bundled-sources.js";
import { enablePluginInConfig } from "../plugins/enable.js";
import { installPluginFromNpmSpec, installPluginFromPath } from "../plugins/install.js";
import {
  applySlotSelectionForPlugin,
  buildPluginLifecycleReport,
  buildPluginUninstallPreview,
  executePluginUninstallLifecycle,
  executePluginUpdateLifecycle,
  finalizeInstalledPluginConfig,
  resolvePluginLifecycleEntry,
} from "../plugins/lifecycle.js";
import {
  buildPluginMarketplaceUpdateReview,
  formatPluginMarketplaceUpdateReviewWarnings,
} from "../plugins/marketplace-update-review.js";
import {
  buildPluginMarketplaceReport,
  type PluginMarketplaceEntry,
} from "../plugins/marketplace.js";
import type { PluginRecord } from "../plugins/registry.js";
import {
  getPluginRuntimeSessionReadGrant,
  setPluginRuntimeSessionReadGrant,
} from "../plugins/runtime-helper-grants.js";
import { resolvePluginSourceRoots, formatPluginSourceForTable } from "../plugins/source-display.js";
import { buildPluginStatusReport } from "../plugins/status.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { renderTable } from "../terminal/table.js";
import { theme } from "../terminal/theme.js";
import { resolveUserPath, shortenHomeInString, shortenHomePath } from "../utils.js";
import { resolvePinnedNpmInstallRecordForCli } from "./npm-resolution.js";
import { setPluginEnabledInConfig } from "./plugins-config.js";
import { promptYesNo } from "./prompt.js";

export type PluginsListOptions = {
  json?: boolean;
  enabled?: boolean;
  verbose?: boolean;
};

export type PluginInfoOptions = {
  json?: boolean;
};

export type PluginUpdateOptions = {
  all?: boolean;
  dryRun?: boolean;
  approveRiskyChanges?: boolean;
};

export type PluginUninstallOptions = {
  keepFiles?: boolean;
  keepConfig?: boolean;
  force?: boolean;
  dryRun?: boolean;
};

export type PluginHelperSessionsStatusOptions = {
  json?: boolean;
};

function resolveFileNpmSpecToLocalPath(
  raw: string,
): { ok: true; path: string } | { ok: false; error: string } | null {
  const trimmed = raw.trim();
  if (!trimmed.toLowerCase().startsWith("file:")) {
    return null;
  }
  const rest = trimmed.slice("file:".length);
  if (!rest) {
    return { ok: false, error: "unsupported file: spec: missing path" };
  }
  if (rest.startsWith("///")) {
    // file:///abs/path -> /abs/path
    return { ok: true, path: rest.slice(2) };
  }
  if (rest.startsWith("//localhost/")) {
    // file://localhost/abs/path -> /abs/path
    return { ok: true, path: rest.slice("//localhost".length) };
  }
  if (rest.startsWith("//")) {
    return {
      ok: false,
      error: 'unsupported file: URL host (expected "file:<path>" or "file:///abs/path")',
    };
  }
  return { ok: true, path: rest };
}

function formatPluginUpdateReviewLines(params: {
  pluginId: string;
  review: ReturnType<typeof buildPluginMarketplaceUpdateReview>;
}): string[] {
  const { pluginId, review } = params;
  const lines = [
    `Update review for "${pluginId}": ${review.approvalRequired ? "approval required" : "no approval required"}`,
    `- source: ${review.sourceTrust.source}${
      review.sourceTrust.spec ? ` ${review.sourceTrust.spec}` : ""
    } (${review.sourceTrust.reason})`,
  ];
  const added = [
    ...review.permissionDiff.added.channels.map((value) => `channel:${value}`),
    ...review.permissionDiff.added.providers.map((value) => `provider:${value}`),
    ...review.permissionDiff.added.tools.map((value) => `tool:${value}`),
    ...review.permissionDiff.added.skills.map((value) => `skill:${value}`),
  ];
  if (added.length > 0) {
    lines.push(`- added surfaces: ${added.join(", ")}`);
  }
  if (review.permissionDiff.changed.length > 0) {
    lines.push(`- changed: ${review.permissionDiff.changed.join(", ")}`);
  }
  for (const warning of formatPluginMarketplaceUpdateReviewWarnings(review)) {
    lines.push(`- ${warning}`);
  }
  return lines;
}

function buildPluginUpdateReviews(params: {
  entries: Map<string, PluginMarketplaceEntry>;
  result: Awaited<ReturnType<typeof executePluginUpdateLifecycle>>;
}) {
  return params.result.outcomes.flatMap((outcome) => {
    if (outcome.status === "error" || outcome.status === "skipped") {
      return [];
    }
    const entry = params.entries.get(outcome.pluginId);
    if (!entry) {
      return [];
    }
    return [
      {
        pluginId: outcome.pluginId,
        review: buildPluginMarketplaceUpdateReview({ entry, outcome }),
      },
    ];
  });
}

function formatPluginLine(plugin: PluginRecord, verbose = false): string {
  const status =
    plugin.status === "loaded"
      ? theme.success("loaded")
      : plugin.status === "disabled"
        ? theme.warn("disabled")
        : theme.error("error");
  const name = theme.command(plugin.name || plugin.id);
  const idSuffix = plugin.name && plugin.name !== plugin.id ? theme.muted(` (${plugin.id})`) : "";
  const desc = plugin.description
    ? theme.muted(
        plugin.description.length > 60
          ? `${plugin.description.slice(0, 57)}...`
          : plugin.description,
      )
    : theme.muted("(no description)");

  if (!verbose) {
    return `${name}${idSuffix} ${status} - ${desc}`;
  }

  const parts = [
    `${name}${idSuffix} ${status}`,
    `  source: ${theme.muted(shortenHomeInString(plugin.source))}`,
    `  origin: ${plugin.origin}`,
  ];
  if (plugin.version) {
    parts.push(`  version: ${plugin.version}`);
  }
  if (plugin.providerIds.length > 0) {
    parts.push(`  providers: ${plugin.providerIds.join(", ")}`);
  }
  if (plugin.error) {
    parts.push(theme.error(`  error: ${plugin.error}`));
  }
  return parts.join("\n");
}

function createPluginInstallLogger(): { info: (msg: string) => void; warn: (msg: string) => void } {
  return {
    info: (msg) => defaultRuntime.log(msg),
    warn: (msg) => defaultRuntime.log(theme.warn(msg)),
  };
}

function logSlotWarnings(warnings: string[]) {
  if (warnings.length === 0) {
    return;
  }
  for (const warning of warnings) {
    defaultRuntime.log(theme.warn(warning));
  }
}

function isPackageNotFoundInstallError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("npm pack failed:") &&
    (lower.includes("e404") ||
      lower.includes("404 not found") ||
      lower.includes("could not be found"))
  );
}

export function registerPluginsCli(program: Command) {
  const plugins = program
    .command("plugins")
    .description("Manage FasedAgent plugins and extensions")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/plugins", "docs.fased.ai/cli/plugins")}\n`,
    );

  plugins
    .command("list")
    .description("List discovered plugins")
    .option("--json", "Print JSON")
    .option("--enabled", "Only show enabled plugins", false)
    .option("--verbose", "Show detailed entries", false)
    .action((opts: PluginsListOptions) => {
      const report = buildPluginLifecycleReport();
      const list = opts.enabled
        ? report.plugins.filter((p) => p.status === "loaded")
        : report.plugins;

      if (opts.json) {
        const payload = {
          workspaceDir: report.workspaceDir,
          plugins: list,
          diagnostics: report.diagnostics,
        };
        defaultRuntime.log(JSON.stringify(payload, null, 2));
        return;
      }

      if (list.length === 0) {
        defaultRuntime.log(theme.muted("No plugins found."));
        return;
      }

      const loaded = list.filter((p) => p.status === "loaded").length;
      defaultRuntime.log(
        `${theme.heading("Plugins")} ${theme.muted(`(${loaded}/${list.length} loaded)`)}`,
      );

      if (!opts.verbose) {
        const tableWidth = Math.max(60, (process.stdout.columns ?? 120) - 1);
        const sourceRoots = resolvePluginSourceRoots({
          workspaceDir: report.workspaceDir,
        });
        const usedRoots = new Set<keyof typeof sourceRoots>();
        const rows = list.map((plugin) => {
          const desc = plugin.description ? theme.muted(plugin.description) : "";
          const formattedSource = formatPluginSourceForTable(plugin, sourceRoots);
          if (formattedSource.rootKey) {
            usedRoots.add(formattedSource.rootKey);
          }
          const sourceLine = desc ? `${formattedSource.value}\n${desc}` : formattedSource.value;
          return {
            Name: plugin.name || plugin.id,
            ID: plugin.name && plugin.name !== plugin.id ? plugin.id : "",
            Status:
              plugin.status === "loaded"
                ? theme.success("loaded")
                : plugin.status === "disabled"
                  ? theme.warn("disabled")
                  : theme.error("error"),
            Source: sourceLine,
            Version: plugin.version ?? "",
          };
        });

        if (usedRoots.size > 0) {
          defaultRuntime.log(theme.muted("Source roots:"));
          for (const key of ["stock", "workspace", "global"] as const) {
            if (!usedRoots.has(key)) {
              continue;
            }
            const dir = sourceRoots[key];
            if (!dir) {
              continue;
            }
            defaultRuntime.log(`  ${theme.command(`${key}:`)} ${theme.muted(dir)}`);
          }
          defaultRuntime.log("");
        }

        defaultRuntime.log(
          renderTable({
            width: tableWidth,
            columns: [
              { key: "Name", header: "Name", minWidth: 14, flex: true },
              { key: "ID", header: "ID", minWidth: 10, flex: true },
              { key: "Status", header: "Status", minWidth: 10 },
              { key: "Source", header: "Source", minWidth: 26, flex: true },
              { key: "Version", header: "Version", minWidth: 8 },
            ],
            rows,
          }).trimEnd(),
        );
        return;
      }

      const lines: string[] = [];
      for (const plugin of list) {
        lines.push(formatPluginLine(plugin, true));
        lines.push("");
      }
      defaultRuntime.log(lines.join("\n").trim());
    });

  plugins
    .command("info")
    .description("Show plugin details")
    .argument("<id>", "Plugin id")
    .option("--json", "Print JSON")
    .action((id: string, opts: PluginInfoOptions) => {
      const report = buildPluginLifecycleReport();
      const plugin = resolvePluginLifecycleEntry({
        idOrName: id,
        report,
      });
      if (!plugin) {
        defaultRuntime.error(`Plugin not found: ${id}`);
        process.exit(1);
      }

      if (opts.json) {
        defaultRuntime.log(JSON.stringify(plugin, null, 2));
        return;
      }

      const lines: string[] = [];
      lines.push(theme.heading(plugin.name || plugin.id));
      if (plugin.name && plugin.name !== plugin.id) {
        lines.push(theme.muted(`id: ${plugin.id}`));
      }
      if (plugin.description) {
        lines.push(plugin.description);
      }
      lines.push("");
      lines.push(`${theme.muted("Status:")} ${plugin.status}`);
      lines.push(`${theme.muted("Source:")} ${shortenHomeInString(plugin.source)}`);
      lines.push(`${theme.muted("Origin:")} ${plugin.origin}`);
      if (plugin.version) {
        lines.push(`${theme.muted("Version:")} ${plugin.version}`);
      }
      if (plugin.toolNames.length > 0) {
        lines.push(`${theme.muted("Tools:")} ${plugin.toolNames.join(", ")}`);
      }
      if (plugin.hookNames.length > 0) {
        lines.push(`${theme.muted("Hooks:")} ${plugin.hookNames.join(", ")}`);
      }
      if (plugin.gatewayMethods.length > 0) {
        lines.push(`${theme.muted("Gateway methods:")} ${plugin.gatewayMethods.join(", ")}`);
      }
      if (plugin.providerIds.length > 0) {
        lines.push(`${theme.muted("Providers:")} ${plugin.providerIds.join(", ")}`);
      }
      if (plugin.cliCommands.length > 0) {
        lines.push(`${theme.muted("CLI commands:")} ${plugin.cliCommands.join(", ")}`);
      }
      if (plugin.services.length > 0) {
        lines.push(`${theme.muted("Services:")} ${plugin.services.join(", ")}`);
      }
      if (plugin.error) {
        lines.push(`${theme.error("Error:")} ${plugin.error}`);
      }
      if (plugin.install) {
        lines.push("");
        lines.push(`${theme.muted("Install:")} ${plugin.install.source}`);
        if (plugin.install.spec) {
          lines.push(`${theme.muted("Spec:")} ${plugin.install.spec}`);
        }
        if (plugin.install.sourcePath) {
          lines.push(
            `${theme.muted("Source path:")} ${shortenHomePath(plugin.install.sourcePath)}`,
          );
        }
        if (plugin.install.installPath) {
          lines.push(
            `${theme.muted("Install path:")} ${shortenHomePath(plugin.install.installPath)}`,
          );
        }
        if (plugin.install.version) {
          lines.push(`${theme.muted("Recorded version:")} ${plugin.install.version}`);
        }
        if (plugin.install.installedAt) {
          lines.push(`${theme.muted("Installed at:")} ${plugin.install.installedAt}`);
        }
      }
      defaultRuntime.log(lines.join("\n"));
    });

  plugins
    .command("enable")
    .description("Enable a plugin in config")
    .argument("<id>", "Plugin id")
    .action(async (id: string) => {
      const cfg = loadConfig();
      const enableResult = enablePluginInConfig(cfg, id);
      let next: FasedAgentConfig = enableResult.config;
      const slotResult = applySlotSelectionForPlugin(next, id);
      next = slotResult.config;
      await writeConfigFile(next);
      logSlotWarnings(slotResult.warnings);
      if (enableResult.enabled) {
        defaultRuntime.log(`Enabled plugin "${id}". Restart the gateway to apply.`);
        return;
      }
      defaultRuntime.log(
        theme.warn(
          `Plugin "${id}" could not be enabled (${enableResult.reason ?? "unknown reason"}).`,
        ),
      );
    });

  plugins
    .command("disable")
    .description("Disable a plugin in config")
    .argument("<id>", "Plugin id")
    .action(async (id: string) => {
      const cfg = loadConfig();
      const next = setPluginEnabledInConfig(cfg, id, false);
      await writeConfigFile(next);
      defaultRuntime.log(`Disabled plugin "${id}". Restart the gateway to apply.`);
    });

  const helpers = plugins
    .command("helpers")
    .description("Manage explicit plugin runtime helper grants");

  const sessionHelpers = helpers
    .command("sessions")
    .description("Manage read-only session metadata helper grants");

  sessionHelpers
    .command("status")
    .description("Show runtime.helpers.sessions.read grant status")
    .argument("[id]", "Plugin id")
    .option("--json", "Print JSON")
    .action((id: string | undefined, opts: PluginHelperSessionsStatusOptions) => {
      const cfg = loadConfig();
      const report = buildPluginLifecycleReport({ config: cfg });
      const ids = id?.trim()
        ? [id.trim()]
        : [
            ...new Set([
              ...report.plugins.map((plugin) => plugin.id),
              ...Object.keys(cfg.plugins?.entries ?? {}),
            ]),
          ].toSorted((left, right) => left.localeCompare(right));

      const rows = ids.map((pluginId) => {
        const plugin = report.plugins.find((entry) => entry.id === pluginId);
        return {
          pluginId,
          sessionsRead: getPluginRuntimeSessionReadGrant(cfg, pluginId),
          status: plugin?.status ?? "not discovered",
          loaded: plugin?.status === "loaded",
          enabled: plugin?.enabled ?? false,
          managed: plugin?.managed ?? Boolean(cfg.plugins?.entries?.[pluginId]),
        };
      });

      if (opts.json) {
        defaultRuntime.log(JSON.stringify(id?.trim() ? rows[0] : rows, null, 2));
        return;
      }

      if (rows.length === 0) {
        defaultRuntime.log(theme.muted("No plugin entries found."));
        return;
      }

      if (id?.trim()) {
        const row = rows[0];
        if (!row) {
          defaultRuntime.error(`Plugin not found: ${id}`);
          process.exit(1);
        }
        defaultRuntime.log(theme.heading(`Plugin helper grants: ${row.pluginId}`));
        defaultRuntime.log(
          `${theme.muted("sessions.read:")} ${
            row.sessionsRead ? theme.success("enabled") : theme.warn("disabled")
          }`,
        );
        defaultRuntime.log(`${theme.muted("status:")} ${row.status}`);
        defaultRuntime.log(`${theme.muted("managed:")} ${row.managed ? "yes" : "no"}`);
        return;
      }

      defaultRuntime.log(theme.heading("Plugin session helper grants"));
      defaultRuntime.log(
        renderTable({
          width: Math.max(60, (process.stdout.columns ?? 120) - 1),
          columns: [
            { key: "Plugin", header: "Plugin", minWidth: 18, flex: true },
            { key: "Sessions", header: "sessions.read", minWidth: 14 },
            { key: "Status", header: "Status", minWidth: 14 },
            { key: "Managed", header: "Managed", minWidth: 10 },
          ],
          rows: rows.map((row) => ({
            Plugin: row.pluginId,
            Sessions: row.sessionsRead ? theme.success("enabled") : theme.warn("disabled"),
            Status: row.status,
            Managed: row.managed ? "yes" : "no",
          })),
        }).trimEnd(),
      );
    });

  sessionHelpers
    .command("enable")
    .description("Allow a plugin to read sanitized session metadata/status")
    .argument("<id>", "Plugin id")
    .action(async (id: string) => {
      const cfg = loadConfig();
      const result = setPluginRuntimeSessionReadGrant(cfg, id, true);
      if (result.changed) {
        await writeConfigFile(result.config);
      }
      defaultRuntime.log(
        result.changed
          ? `Enabled runtime.helpers.sessions.read for plugin "${result.pluginId}". Restart the gateway to apply.`
          : `runtime.helpers.sessions.read is already enabled for plugin "${result.pluginId}".`,
      );
    });

  sessionHelpers
    .command("disable")
    .description("Deny a plugin read-only session metadata/status helper access")
    .argument("<id>", "Plugin id")
    .action(async (id: string) => {
      const cfg = loadConfig();
      const result = setPluginRuntimeSessionReadGrant(cfg, id, false);
      if (result.changed) {
        await writeConfigFile(result.config);
      }
      defaultRuntime.log(
        result.changed
          ? `Disabled runtime.helpers.sessions.read for plugin "${result.pluginId}". Restart the gateway to apply.`
          : `runtime.helpers.sessions.read is already disabled for plugin "${result.pluginId}".`,
      );
    });

  plugins
    .command("uninstall")
    .description("Uninstall a plugin")
    .argument("<id>", "Plugin id")
    .option("--keep-files", "Keep installed files on disk", false)
    .option("--keep-config", "Deprecated alias for --keep-files", false)
    .option("--force", "Skip confirmation prompt", false)
    .option("--dry-run", "Show what would be removed without making changes", false)
    .action(async (id: string, opts: PluginUninstallOptions) => {
      const cfg = loadConfig();
      const report = buildPluginLifecycleReport({ config: cfg });
      const extensionsDir = path.join(resolveStateDir(process.env, os.homedir), "extensions");
      const keepFiles = Boolean(opts.keepFiles || opts.keepConfig);

      if (opts.keepConfig) {
        defaultRuntime.log(theme.warn("`--keep-config` is deprecated, use `--keep-files`."));
      }

      const preview = buildPluginUninstallPreview({
        config: cfg,
        idOrName: id,
        keepFiles,
        extensionsDir,
        report,
      });
      if (!preview.ok) {
        defaultRuntime.error(preview.error);
        process.exit(1);
      }

      const pluginName = preview.pluginName;
      defaultRuntime.log(
        `Plugin: ${theme.command(pluginName)}${pluginName !== preview.pluginId ? theme.muted(` (${preview.pluginId})`) : ""}`,
      );
      defaultRuntime.log(
        `Will remove: ${preview.preview.length > 0 ? preview.preview.map((item) => (item.startsWith("directory: ") ? `directory: ${shortenHomePath(item.slice("directory: ".length))}` : item)).join(", ") : "(nothing)"}`,
      );

      if (opts.dryRun) {
        defaultRuntime.log(theme.muted("Dry run, no changes made."));
        return;
      }

      if (!opts.force) {
        const confirmed = await promptYesNo(`Uninstall plugin "${preview.pluginId}"?`);
        if (!confirmed) {
          defaultRuntime.log("Cancelled.");
          return;
        }
      }

      const result = await executePluginUninstallLifecycle({
        config: cfg,
        pluginId: preview.pluginId,
        deleteFiles: !keepFiles,
        extensionsDir,
      });

      if (!result.ok) {
        defaultRuntime.error(result.error);
        process.exit(1);
      }
      for (const warning of result.warnings) {
        defaultRuntime.log(theme.warn(warning));
      }

      await writeConfigFile(result.config);

      const removed: string[] = [];
      if (result.actions.entry) {
        removed.push("config entry");
      }
      if (result.actions.install) {
        removed.push("install record");
      }
      if (result.actions.allowlist) {
        removed.push("allowlist");
      }
      if (result.actions.loadPath) {
        removed.push("load path");
      }
      if (result.actions.memorySlot) {
        removed.push("memory slot");
      }
      if (result.actions.directory) {
        removed.push("directory");
      }

      defaultRuntime.log(
        `Uninstalled plugin "${preview.pluginId}". Removed: ${removed.length > 0 ? removed.join(", ") : "nothing"}.`,
      );
      defaultRuntime.log("Restart the gateway to apply changes.");
    });

  plugins
    .command("install")
    .description("Install a plugin (path, archive, or npm spec)")
    .argument("<path-or-spec>", "Path (.ts/.js/.zip/.tgz/.tar.gz) or an npm package spec")
    .option("-l, --link", "Link a local path instead of copying", false)
    .option("--pin", "Record npm installs as exact resolved <name>@<version>", false)
    .action(async (raw: string, opts: { link?: boolean; pin?: boolean }) => {
      const fileSpec = resolveFileNpmSpecToLocalPath(raw);
      if (fileSpec && !fileSpec.ok) {
        defaultRuntime.error(fileSpec.error);
        process.exit(1);
      }
      const normalized = fileSpec && fileSpec.ok ? fileSpec.path : raw;
      const resolved = resolveUserPath(normalized);
      const cfg = loadConfig();

      if (fs.existsSync(resolved)) {
        if (opts.link) {
          const probe = await installPluginFromPath({ path: resolved, dryRun: true });
          if (!probe.ok) {
            defaultRuntime.error(probe.error);
            process.exit(1);
          }

          const finalized = finalizeInstalledPluginConfig({
            config: cfg,
            pluginId: probe.pluginId,
            loadPath: resolved,
            installRecord: {
              source: "path",
              sourcePath: resolved,
              installPath: resolved,
              version: probe.version,
            },
          });
          await writeConfigFile(finalized.config);
          logSlotWarnings(finalized.slotWarnings);
          defaultRuntime.log(`Linked plugin path: ${shortenHomePath(resolved)}`);
          defaultRuntime.log(`Restart the gateway to load plugins.`);
          return;
        }

        const result = await installPluginFromPath({
          path: resolved,
          logger: createPluginInstallLogger(),
        });
        if (!result.ok) {
          defaultRuntime.error(result.error);
          process.exit(1);
        }
        // Plugin CLI registrars may have warmed the manifest registry cache before install;
        // force a rescan so config validation sees the freshly installed plugin.
        const source: "archive" | "path" = resolveArchiveKind(resolved) ? "archive" : "path";
        const finalized = finalizeInstalledPluginConfig({
          config: cfg,
          pluginId: result.pluginId,
          refreshManifestRegistry: true,
          installRecord: {
            source,
            sourcePath: resolved,
            installPath: result.targetDir,
            version: result.version,
          },
        });
        await writeConfigFile(finalized.config);
        logSlotWarnings(finalized.slotWarnings);
        defaultRuntime.log(`Installed plugin: ${result.pluginId}`);
        defaultRuntime.log(`Restart the gateway to load plugins.`);
        return;
      }

      if (opts.link) {
        defaultRuntime.error("`--link` requires a local path.");
        process.exit(1);
      }

      const looksLikePath =
        raw.startsWith(".") ||
        raw.startsWith("~") ||
        path.isAbsolute(raw) ||
        raw.endsWith(".ts") ||
        raw.endsWith(".js") ||
        raw.endsWith(".mjs") ||
        raw.endsWith(".cjs") ||
        raw.endsWith(".tgz") ||
        raw.endsWith(".tar.gz") ||
        raw.endsWith(".tar") ||
        raw.endsWith(".zip");
      if (looksLikePath) {
        defaultRuntime.error(`Path not found: ${resolved}`);
        process.exit(1);
      }

      const result = await installPluginFromNpmSpec({
        spec: raw,
        logger: createPluginInstallLogger(),
      });
      if (!result.ok) {
        const bundledFallback = isPackageNotFoundInstallError(result.error)
          ? findBundledPluginByNpmSpec({ spec: raw })
          : undefined;
        if (!bundledFallback) {
          defaultRuntime.error(result.error);
          process.exit(1);
        }

        const finalized = finalizeInstalledPluginConfig({
          config: cfg,
          pluginId: bundledFallback.pluginId,
          loadPath: bundledFallback.localPath,
          installRecord: {
            source: "path",
            spec: raw,
            sourcePath: bundledFallback.localPath,
            installPath: bundledFallback.localPath,
          },
        });
        await writeConfigFile(finalized.config);
        logSlotWarnings(finalized.slotWarnings);
        defaultRuntime.log(
          theme.warn(
            `npm package unavailable for ${raw}; using bundled plugin at ${shortenHomePath(bundledFallback.localPath)}.`,
          ),
        );
        defaultRuntime.log(`Installed plugin: ${bundledFallback.pluginId}`);
        defaultRuntime.log(`Restart the gateway to load plugins.`);
        return;
      }
      // Ensure config validation sees newly installed plugin(s) even if the cache was warmed at startup.
      const installRecord = resolvePinnedNpmInstallRecordForCli(
        raw,
        Boolean(opts.pin),
        result.targetDir,
        result.version,
        result.npmResolution,
        defaultRuntime.log,
        theme.warn,
      );
      const finalized = finalizeInstalledPluginConfig({
        config: cfg,
        pluginId: result.pluginId,
        refreshManifestRegistry: true,
        installRecord,
      });
      await writeConfigFile(finalized.config);
      logSlotWarnings(finalized.slotWarnings);
      defaultRuntime.log(`Installed plugin: ${result.pluginId}`);
      defaultRuntime.log(`Restart the gateway to load plugins.`);
    });

  plugins
    .command("update")
    .description("Update installed plugins (npm installs only)")
    .argument("[id]", "Plugin id (omit with --all)")
    .option("--all", "Update all tracked plugins", false)
    .option("--dry-run", "Show what would change without writing", false)
    .option(
      "--approve-risky-changes",
      "Explicitly approve source, dependency/script, or permission-surface changes",
      false,
    )
    .action(async (id: string | undefined, opts: PluginUpdateOptions) => {
      const cfg = loadConfig();
      const installs = cfg.plugins?.installs ?? {};
      const targets = opts.all ? Object.keys(installs) : id ? [id] : [];

      if (targets.length === 0) {
        if (opts.all) {
          defaultRuntime.log("No npm-installed plugins to update.");
          return;
        }
        defaultRuntime.error("Provide a plugin id or use --all.");
        process.exit(1);
      }

      const marketplaceEntries = new Map(
        buildPluginMarketplaceReport({ config: cfg }).plugins.map((entry) => [entry.id, entry]),
      );
      const preview = await executePluginUpdateLifecycle({
        config: cfg,
        pluginIds: targets,
        dryRun: true,
        logger: {
          info: (msg) => defaultRuntime.log(msg),
          warn: (msg) => defaultRuntime.log(theme.warn(msg)),
        },
        onIntegrityDrift: async (drift) => {
          const specLabel = drift.resolvedSpec ?? drift.spec;
          defaultRuntime.log(
            theme.warn(
              `Integrity drift detected for "${drift.pluginId}" (${specLabel})` +
                `\nExpected: ${drift.expectedIntegrity}` +
                `\nActual:   ${drift.actualIntegrity}`,
            ),
          );
          if (drift.dryRun) {
            return true;
          }
          return await promptYesNo(`Continue updating "${drift.pluginId}" with this artifact?`);
        },
      });
      const updateReviews = buildPluginUpdateReviews({
        entries: marketplaceEntries,
        result: preview,
      });

      for (const item of updateReviews) {
        defaultRuntime.log(formatPluginUpdateReviewLines(item).join("\n"));
      }

      if (opts.dryRun) {
        for (const outcome of preview.outcomes) {
          if (outcome.status === "error") {
            defaultRuntime.log(theme.error(outcome.message));
            continue;
          }
          if (outcome.status === "skipped") {
            defaultRuntime.log(theme.warn(outcome.message));
            continue;
          }
          defaultRuntime.log(outcome.message);
        }
        return;
      }

      const riskyReviews = updateReviews.filter((item) => item.review.approvalRequired);
      if (riskyReviews.length > 0 && opts.approveRiskyChanges !== true) {
        const approved = await promptYesNo(
          `Continue plugin update with ${riskyReviews.length} risky review${
            riskyReviews.length === 1 ? "" : "s"
          }?`,
        );
        if (!approved) {
          defaultRuntime.error("Plugin update cancelled.");
          process.exitCode = 1;
          return;
        }
      }

      const result = await executePluginUpdateLifecycle({
        config: cfg,
        pluginIds: targets,
        dryRun: false,
        logger: {
          info: (msg) => defaultRuntime.log(msg),
          warn: (msg) => defaultRuntime.log(theme.warn(msg)),
        },
        onIntegrityDrift: async (drift) => {
          const specLabel = drift.resolvedSpec ?? drift.spec;
          defaultRuntime.log(
            theme.warn(
              `Integrity drift detected for "${drift.pluginId}" (${specLabel})` +
                `\nExpected: ${drift.expectedIntegrity}` +
                `\nActual:   ${drift.actualIntegrity}`,
            ),
          );
          return await promptYesNo(`Continue updating "${drift.pluginId}" with this artifact?`);
        },
      });

      for (const outcome of result.outcomes) {
        if (outcome.status === "error") {
          defaultRuntime.log(theme.error(outcome.message));
          continue;
        }
        if (outcome.status === "skipped") {
          defaultRuntime.log(theme.warn(outcome.message));
          continue;
        }
        defaultRuntime.log(outcome.message);
      }

      if (!opts.dryRun && result.changed) {
        await writeConfigFile(result.config);
        defaultRuntime.log("Restart the gateway to load plugins.");
      }
    });

  plugins
    .command("doctor")
    .description("Report plugin load issues")
    .action(() => {
      const report = buildPluginStatusReport();
      const errors = report.plugins.filter((p) => p.status === "error");
      const diags = report.diagnostics.filter((d) => d.level === "error");

      if (errors.length === 0 && diags.length === 0) {
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
      if (diags.length > 0) {
        if (lines.length > 0) {
          lines.push("");
        }
        lines.push(theme.warn("Diagnostics:"));
        for (const diag of diags) {
          const target = diag.pluginId ? `${diag.pluginId}: ` : "";
          lines.push(`- ${target}${diag.message}`);
        }
      }
      const docs = formatDocsLink("/plugin", "docs.fased.ai/plugin");
      lines.push("");
      lines.push(`${theme.muted("Docs:")} ${docs}`);
      defaultRuntime.log(lines.join("\n"));
    });
}
