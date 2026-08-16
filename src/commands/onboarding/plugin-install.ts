import fs from "node:fs";
import path from "node:path";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import {
  resolveChannelPluginExpectedPluginIds,
  type ChannelPluginCatalogEntry,
} from "../../channels/plugins/catalog.js";
import type { FasedAgentConfig } from "../../config/config.js";
import { resolveFasedAgentPackageRootSync } from "../../infra/fased-root.js";
import { isManagedLifecycleRuntime } from "../../infra/managed-runtime-authority.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { installPluginFromNpmSpec } from "../../plugins/install.js";
import { buildNpmResolutionInstallFields } from "../../plugins/installs.js";
import { finalizeInstalledPluginConfig } from "../../plugins/lifecycle.js";
import { loadFasedAgentPlugins } from "../../plugins/loader.js";
import { createPluginLoaderLogger } from "../../plugins/logger.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { WizardPrompter } from "../../wizard/prompts.js";

type InstallChoice = "npm" | "local" | "skip";

type InstallResult = {
  cfg: FasedAgentConfig;
  installed: boolean;
};

function resolveLocalPath(
  entry: ChannelPluginCatalogEntry,
  workspaceDir: string | undefined,
): string | null {
  const raw = entry.install.localPath?.trim();
  if (!raw) {
    return null;
  }
  const candidates = new Set<string>();
  candidates.add(path.resolve(process.cwd(), raw));
  if (workspaceDir && workspaceDir !== process.cwd()) {
    candidates.add(path.resolve(workspaceDir, raw));
  }
  const packageRoot = resolveFasedAgentPackageRootSync({
    cwd: process.cwd(),
    moduleUrl: import.meta.url,
  });
  if (packageRoot) {
    candidates.add(path.resolve(packageRoot, raw));
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function promptInstallChoice(params: {
  entry: ChannelPluginCatalogEntry;
  localPath?: string | null;
  defaultChoice: InstallChoice;
  prompter: WizardPrompter;
}): Promise<InstallChoice> {
  const { entry, localPath, prompter, defaultChoice } = params;
  const npmSpec = entry.install.npmSpec?.trim();
  const npmOptions: Array<{ value: InstallChoice; label: string; hint?: string }> = npmSpec
    ? [{ value: "npm", label: `Download from npm (${npmSpec})` }]
    : [];
  const localOptions: Array<{ value: InstallChoice; label: string; hint?: string }> = localPath
    ? [
        {
          value: "local",
          label: "Use local plugin path",
          hint: localPath,
        },
      ]
    : [];
  const options: Array<{ value: InstallChoice; label: string; hint?: string }> = [
    ...npmOptions,
    ...localOptions,
    { value: "skip", label: "Skip for now" },
  ];
  const initialValue: InstallChoice = options.some((option) => option.value === defaultChoice)
    ? defaultChoice
    : (options[0]?.value ?? "skip");
  return await prompter.select<InstallChoice>({
    message: `Install ${entry.meta.label} plugin?`,
    options,
    initialValue,
  });
}

function resolveInstallDefaultChoice(params: {
  cfg: FasedAgentConfig;
  entry: ChannelPluginCatalogEntry;
  localPath?: string | null;
}): InstallChoice {
  const { cfg, entry, localPath } = params;
  const updateChannel = cfg.update?.channel;
  if (updateChannel === "dev") {
    return localPath ? "local" : entry.install.npmSpec ? "npm" : "skip";
  }
  if (updateChannel === "stable" || updateChannel === "beta") {
    return entry.install.npmSpec ? "npm" : localPath ? "local" : "skip";
  }
  const entryDefault = entry.install.defaultChoice;
  if (entryDefault === "local") {
    return localPath ? "local" : entry.install.npmSpec ? "npm" : "skip";
  }
  if (entryDefault === "npm") {
    return entry.install.npmSpec ? "npm" : localPath ? "local" : "skip";
  }
  return localPath ? "local" : entry.install.npmSpec ? "npm" : "skip";
}

export async function ensureOnboardingPluginInstalled(params: {
  cfg: FasedAgentConfig;
  entry: ChannelPluginCatalogEntry;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  workspaceDir?: string;
}): Promise<InstallResult> {
  const { entry, prompter, runtime, workspaceDir } = params;
  let next = params.cfg;
  const localPath = resolveLocalPath(entry, workspaceDir);
  const bundledLocalPlugin =
    entry.delivery === "bundled" &&
    (entry.catalogSource === "bundled" || entry.catalogSource === "official-catalog") &&
    Boolean(localPath);
  if (isManagedLifecycleRuntime() && !bundledLocalPlugin) {
    await prompter.note(
      "Managed installations bundle Fased-owned plugins inside the signed core artifact. Third-party plugin code installation is disabled until the separate digest-bound plugin transaction is available.",
      "Plugin install",
    );
    return { cfg: next, installed: false };
  }
  const defaultChoice = resolveInstallDefaultChoice({
    cfg: next,
    entry,
    localPath,
  });
  const choice = await promptInstallChoice({
    entry,
    localPath,
    defaultChoice,
    prompter,
  });

  if (choice === "skip") {
    return { cfg: next, installed: false };
  }

  if (choice === "local" && localPath) {
    const isBundledLocalPlugin = bundledLocalPlugin;
    next = finalizeInstalledPluginConfig({
      config: next,
      pluginId: entry.id,
      ...(isBundledLocalPlugin ? {} : { loadPath: localPath }),
    }).config;
    return { cfg: next, installed: true };
  }

  const npmSpec = entry.install.npmSpec?.trim();
  if (!npmSpec) {
    await prompter.note(
      `${entry.meta.label} has no npm install source available${
        localPath ? "; use the local plugin path instead." : "."
      }`,
      "Plugin install",
    );
    return { cfg: next, installed: false };
  }

  const result = await installPluginFromNpmSpec({
    spec: npmSpec,
    expectedPluginId: entry.id,
    expectedPluginIds: resolveChannelPluginExpectedPluginIds(entry),
    expectedIntegrity: entry.install.expectedIntegrity,
    logger: {
      info: (msg) => runtime.log?.(msg),
      warn: (msg) => runtime.log?.(msg),
    },
  });

  if (result.ok) {
    next = finalizeInstalledPluginConfig({
      config: next,
      pluginId: result.pluginId,
      refreshManifestRegistry: true,
      installRecord: {
        source: "npm",
        spec: npmSpec,
        installPath: result.targetDir,
        version: result.version,
        ...buildNpmResolutionInstallFields(result.npmResolution),
      },
    }).config;
    return { cfg: next, installed: true };
  }

  await prompter.note(`Failed to install ${npmSpec}: ${result.error}`, "Plugin install");

  if (localPath) {
    const fallback = await prompter.confirm({
      message: `Use local plugin path instead? (${localPath})`,
      initialValue: true,
    });
    if (fallback) {
      const isBundledLocalPlugin =
        entry.delivery === "bundled" &&
        (entry.catalogSource === "bundled" || entry.catalogSource === "official-catalog");
      next = finalizeInstalledPluginConfig({
        config: next,
        pluginId: entry.id,
        ...(isBundledLocalPlugin ? {} : { loadPath: localPath }),
      }).config;
      return { cfg: next, installed: true };
    }
  }

  runtime.error?.(`Plugin install failed: ${result.error}`);
  return { cfg: next, installed: false };
}

export function reloadOnboardingPluginRegistry(params: {
  cfg: FasedAgentConfig;
  runtime: RuntimeEnv;
  workspaceDir?: string;
}): void {
  const workspaceDir =
    params.workspaceDir ?? resolveAgentWorkspaceDir(params.cfg, resolveDefaultAgentId(params.cfg));
  const log = createSubsystemLogger("plugins");
  loadFasedAgentPlugins({
    config: params.cfg,
    workspaceDir,
    cache: false,
    logger: createPluginLoaderLogger(log),
  });
}
