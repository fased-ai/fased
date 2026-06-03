import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { FasedAgentConfig } from "../config/config.js";
import { ensureActiveMemoryPluginAllowlisted } from "../config/plugins-allowlist.js";
import { buildWorkspaceHookStatus } from "../hooks/hooks-status.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";

const RECOMMENDED_INTERNAL_HOOKS = ["session-memory"] as const;
const BUNDLED_ONBOARDING_HOOKS = [
  {
    name: "boot-md",
    description: "Run BOOT.md on gateway startup",
    emoji: "🚀",
  },
  {
    name: "bootstrap-extra-files",
    description: "Inject additional workspace bootstrap files via glob/path patterns",
    emoji: "📎",
  },
  {
    name: "command-logger",
    description: "Log all command events to a centralized audit file",
    emoji: "📝",
  },
  {
    name: "session-memory",
    description: "Save session context to memory when /new or /reset command is issued",
    emoji: "💾",
  },
] as const;

export function applyRecommendedInternalHooks(cfg: FasedAgentConfig): FasedAgentConfig {
  if (cfg.hooks?.internal?.enabled === false) {
    return cfg;
  }

  const entries = { ...cfg.hooks?.internal?.entries };
  let changed = false;
  for (const name of RECOMMENDED_INTERNAL_HOOKS) {
    if (entries[name]) {
      continue;
    }
    entries[name] = { enabled: true };
    changed = true;
  }

  if (!changed) {
    return cfg;
  }

  return ensureActiveMemoryPluginAllowlisted({
    ...cfg,
    hooks: {
      ...cfg.hooks,
      internal: {
        ...cfg.hooks?.internal,
        enabled: true,
        entries,
      },
    },
  });
}

export async function setupInternalHooks(
  cfg: FasedAgentConfig,
  runtime: RuntimeEnv,
  prompter: WizardPrompter,
  options: { skipIntroNote?: boolean } = {},
): Promise<FasedAgentConfig> {
  if (!options.skipIntroNote) {
    await prompter.note(
      [
        "Hooks let you automate actions when agent commands are issued.",
        "Example: Save session context to memory when you issue /new or /reset.",
        "",
        "Learn more: https://docs.fased.ai/automation/hooks",
      ].join("\n"),
      "Hooks",
    );
  }

  // Discover available hooks using the hook discovery system
  const workspaceDir = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
  const report = buildWorkspaceHookStatus(workspaceDir, { config: cfg });

  // Show every eligible hook so users can opt in during onboarding.
  const eligibleHooks =
    report.hooks.filter((h) => h.eligible).length > 0
      ? report.hooks.filter((h) => h.eligible)
      : BUNDLED_ONBOARDING_HOOKS.filter(
          (hook) => cfg.hooks?.internal?.entries?.[hook.name]?.enabled !== false,
        );

  if (eligibleHooks.length === 0) {
    if (!options.skipIntroNote) {
      await prompter.note(
        "No eligible hooks found. You can configure hooks later in your config.",
        "No Hooks Available",
      );
    }
    return cfg;
  }

  const toEnable = await prompter.multiselect({
    message: "Enable hooks?",
    initialValues: eligibleHooks
      .filter(
        (hook) =>
          RECOMMENDED_INTERNAL_HOOKS.includes(
            hook.name as (typeof RECOMMENDED_INTERNAL_HOOKS)[number],
          ) && cfg.hooks?.internal?.entries?.[hook.name]?.enabled !== false,
      )
      .map((hook) => hook.name),
    options: [
      { value: "__skip__", label: "Skip for now" },
      ...eligibleHooks.map((hook) => ({
        value: hook.name,
        label: `${hook.emoji ?? "🔗"} ${hook.name}`,
        hint: hook.description,
      })),
    ],
  });

  const selected = toEnable.filter((name) => name !== "__skip__");
  if (selected.length === 0) {
    return cfg;
  }

  // Enable selected hooks using the new entries config format
  const entries = { ...cfg.hooks?.internal?.entries };
  for (const name of selected) {
    entries[name] = { enabled: true };
  }

  const next: FasedAgentConfig = ensureActiveMemoryPluginAllowlisted({
    ...cfg,
    hooks: {
      ...cfg.hooks,
      internal: {
        enabled: true,
        entries,
      },
    },
  });

  await prompter.note(
    [
      `Enabled ${selected.length} hook${selected.length > 1 ? "s" : ""}: ${selected.join(", ")}`,
      "",
      "You can manage hooks later with:",
      `  ${formatCliCommand("fased hooks list")}`,
      `  ${formatCliCommand("fased hooks enable <name>")}`,
      `  ${formatCliCommand("fased hooks disable <name>")}`,
    ].join("\n"),
    "Hooks Configured",
  );

  return next;
}
