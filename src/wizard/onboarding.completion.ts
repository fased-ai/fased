import { resolveCliName } from "../cli/cli-name.js";
import { installCompletion } from "../cli/completion-cli.js";
import type { ShellCompletionStatus } from "../commands/doctor-completion.js";
import {
  checkShellCompletionStatus,
  ensureCompletionCacheExists,
} from "../commands/doctor-completion.js";
import type { WizardFlow } from "./onboarding.types.js";
import type { WizardPrompter } from "./prompts.js";

type CompletionDeps = {
  resolveCliName: () => string;
  checkShellCompletionStatus: (binName: string) => Promise<ShellCompletionStatus>;
  ensureCompletionCacheExists: (binName: string) => Promise<boolean>;
  installCompletion: (shell: string, yes: boolean, binName?: string) => Promise<void>;
};

export async function setupOnboardingShellCompletion(params: {
  flow: WizardFlow;
  prompter: Pick<WizardPrompter, "confirm" | "note">;
  deps?: Partial<CompletionDeps>;
}): Promise<void> {
  const deps: CompletionDeps = {
    resolveCliName,
    checkShellCompletionStatus,
    ensureCompletionCacheExists,
    installCompletion,
    ...params.deps,
  };

  const cliName = deps.resolveCliName();
  const completionStatus = await deps.checkShellCompletionStatus(cliName);

  if (completionStatus.usesSlowPattern) {
    // Case 1: Profile uses slow dynamic pattern - silently upgrade to cached version
    const cacheGenerated = await deps.ensureCompletionCacheExists(cliName);
    if (cacheGenerated) {
      await deps.installCompletion(completionStatus.shell, true, cliName);
    }
    return;
  }

  if (completionStatus.profileInstalled && !completionStatus.cacheExists) {
    // Case 2: Profile has completion but no cache - auto-fix silently
    await deps.ensureCompletionCacheExists(cliName);
    return;
  }

  if (!completionStatus.profileInstalled) {
    // Case 3: No completion at all
    const shouldInstall =
      params.flow === "quickstart"
        ? true
        : await params.prompter.confirm({
            message: `Enable ${completionStatus.shell} shell completion for ${cliName}?`,
            initialValue: true,
          });

    if (!shouldInstall) {
      return;
    }

    // Generate cache first (required for fast shell startup)
    const cacheGenerated = await deps.ensureCompletionCacheExists(cliName);
    if (!cacheGenerated) {
      return;
    }

    // Install to shell profile
    await deps.installCompletion(completionStatus.shell, true, cliName);
  }
  // Case 4: Both profile and cache exist (using cached version) - all good, nothing to do
}
