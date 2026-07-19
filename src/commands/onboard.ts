import { formatCliCommand } from "../cli/command-format.js";
import { assertSupportedRuntime } from "../infra/runtime-guard.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { isDeprecatedAuthChoice, normalizeLegacyOnboardAuthChoice } from "./auth-choice-legacy.js";
import { handleOnboardingRepair } from "./onboard-helpers.js";
import { runInteractiveOnboarding } from "./onboard-interactive.js";
import { runNonInteractiveOnboarding } from "./onboard-non-interactive.js";
import type { OnboardOptions, OnboardRepairScope } from "./onboard-types.js";

const VALID_REPAIR_SCOPES = new Set<OnboardRepairScope>(["sessions", "auth", "auth+sessions"]);

export async function onboardCommand(opts: OnboardOptions, runtime: RuntimeEnv = defaultRuntime) {
  assertSupportedRuntime(runtime);
  const originalAuthChoice = opts.authChoice;
  const normalizedAuthChoice = normalizeLegacyOnboardAuthChoice(originalAuthChoice);
  if (opts.nonInteractive && isDeprecatedAuthChoice(originalAuthChoice)) {
    runtime.error(
      [
        `Auth choice "${String(originalAuthChoice)}" is deprecated.`,
        'Use "--auth-choice anthropic-oauth", "--auth-choice token" (Anthropic setup-token), or "--auth-choice openai-codex".',
      ].join("\n"),
    );
    runtime.exit(1);
    return;
  }
  if (originalAuthChoice === "claude-cli") {
    runtime.log('Auth choice "claude-cli" is deprecated; using setup-token flow instead.');
  }
  if (originalAuthChoice === "codex-cli") {
    runtime.log('Auth choice "codex-cli" is deprecated; using OpenAI sign-in instead.');
  }
  const flow = opts.flow === "manual" ? ("advanced" as const) : opts.flow;
  const normalizedOpts =
    normalizedAuthChoice === opts.authChoice && flow === opts.flow
      ? opts
      : { ...opts, authChoice: normalizedAuthChoice, flow };
  if (
    normalizedOpts.secretInputMode &&
    normalizedOpts.secretInputMode !== "plaintext" &&
    normalizedOpts.secretInputMode !== "ref"
  ) {
    runtime.error('Invalid --secret-input-mode. Use "plaintext" or "ref".');
    runtime.exit(1);
    return;
  }

  if (normalizedOpts.resetScope && !VALID_REPAIR_SCOPES.has(normalizedOpts.resetScope)) {
    runtime.error('Invalid --reset-scope. Use "sessions", "auth", or "auth+sessions".');
    runtime.exit(1);
    return;
  }

  if (normalizedOpts.nonInteractive && normalizedOpts.acceptRisk !== true) {
    runtime.error(
      [
        "Non-interactive onboarding requires explicit risk acknowledgement.",
        "Read: https://docs.fased.ai/security",
        `Re-run with: ${formatCliCommand("fased onboard --non-interactive --accept-risk ...")}`,
      ].join("\n"),
    );
    runtime.exit(1);
    return;
  }

  if (normalizedOpts.reset) {
    const repairScope: OnboardRepairScope = normalizedOpts.resetScope ?? "auth+sessions";
    await handleOnboardingRepair(repairScope, runtime);
  }

  const previousSuppressOverwrite = process.env.FASED_SUPPRESS_CONFIG_OVERWRITE_LOG;
  process.env.FASED_SUPPRESS_CONFIG_OVERWRITE_LOG = "1";
  try {
    if (normalizedOpts.nonInteractive) {
      await runNonInteractiveOnboarding(normalizedOpts, runtime);
      return;
    }

    await runInteractiveOnboarding(normalizedOpts, runtime);
  } finally {
    if (previousSuppressOverwrite === undefined) {
      delete process.env.FASED_SUPPRESS_CONFIG_OVERWRITE_LOG;
    } else {
      process.env.FASED_SUPPRESS_CONFIG_OVERWRITE_LOG = previousSuppressOverwrite;
    }
  }
}

export type { OnboardOptions } from "./onboard-types.js";
