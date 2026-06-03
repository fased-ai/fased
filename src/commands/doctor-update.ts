import { formatCliCommand } from "../cli/command-format.js";
import type { FasedAgentConfig } from "../config/config.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { runGatewayUpdate } from "../infra/update-runner.js";
import { repairUpdateOwnedPluginInstallState } from "../plugins/installs.js";
import { runCommandWithTimeout } from "../process/exec.js";
import type { RuntimeEnv } from "../runtime.js";
import { note } from "../terminal/note.js";
import type { DoctorOptions } from "./doctor-prompter.js";

export const POST_UPDATE_DOCTOR_REPAIR_PHASE = "post-update-doctor" as const;

export type PostUpdateDoctorRepairResult = {
  phase: typeof POST_UPDATE_DOCTOR_REPAIR_PHASE;
  config: FasedAgentConfig;
  changed: boolean;
  repairs: string[];
  skippedRepairs: string[];
  changes: string[];
  warnings: string[];
};

async function detectFasedAgentGitCheckout(root: string): Promise<"git" | "not-git" | "unknown"> {
  const res = await runCommandWithTimeout(["git", "-C", root, "rev-parse", "--show-toplevel"], {
    timeoutMs: 5000,
  }).catch(() => null);
  if (!res) {
    return "unknown";
  }
  if (res.code !== 0) {
    // Avoid noisy "Update via package manager" notes when git is missing/broken,
    // but do show it when this is clearly not a git checkout.
    if (res.stderr.toLowerCase().includes("not a git repository")) {
      return "not-git";
    }
    return "unknown";
  }
  return res.stdout.trim() === root ? "git" : "not-git";
}

export function runPostUpdateDoctorRepair(params: {
  config: FasedAgentConfig;
  updateCompleted: boolean;
  resolveNpmInstallPath?: (pluginId: string) => string;
}): PostUpdateDoctorRepairResult {
  if (!params.updateCompleted) {
    return {
      phase: POST_UPDATE_DOCTOR_REPAIR_PHASE,
      config: params.config,
      changed: false,
      repairs: [],
      skippedRepairs: [],
      changes: [],
      warnings: [],
    };
  }

  const installRepair = repairUpdateOwnedPluginInstallState(params.config, {
    resolveNpmInstallPath: params.resolveNpmInstallPath,
  });

  return {
    phase: POST_UPDATE_DOCTOR_REPAIR_PHASE,
    config: installRepair.config,
    changed: installRepair.changed,
    repairs: installRepair.changed ? ["configured-install-ledger"] : [],
    skippedRepairs: ["runtime-symlink-cleanup:not-applicable-to-fased-pack-installs"],
    changes: installRepair.changes,
    warnings: installRepair.warnings,
  };
}

export async function maybeOfferUpdateBeforeDoctor(params: {
  runtime: RuntimeEnv;
  options: DoctorOptions;
  root: string | null;
  confirm: (p: { message: string; initialValue: boolean }) => Promise<boolean>;
  outro: (message: string) => void;
}) {
  const updateInProgress = isTruthyEnvValue(process.env.FASED_UPDATE_IN_PROGRESS);
  const canOfferUpdate =
    !updateInProgress &&
    params.options.nonInteractive !== true &&
    params.options.yes !== true &&
    params.options.repair !== true &&
    Boolean(process.stdin.isTTY);
  if (!canOfferUpdate || !params.root) {
    return { updated: false };
  }

  const git = await detectFasedAgentGitCheckout(params.root);
  if (git === "git") {
    const shouldUpdate = await params.confirm({
      message: "Update FasedAgent from git before running doctor?",
      initialValue: true,
    });
    if (!shouldUpdate) {
      return { updated: false };
    }
    note("Running update (fetch/rebase/build/ui:build/doctor)…", "Update");
    const result = await runGatewayUpdate({
      cwd: params.root,
      argv1: process.argv[1],
    });
    note(
      [
        `Status: ${result.status}`,
        `Mode: ${result.mode}`,
        result.root ? `Root: ${result.root}` : null,
        result.reason ? `Reason: ${result.reason}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
      "Update result",
    );
    if (result.status === "ok") {
      params.outro("Update completed (doctor already ran as part of the update).");
      return { updated: true, handled: true };
    }
    return { updated: true, handled: false };
  }

  if (git === "not-git") {
    note(
      [
        "This install is not a git checkout.",
        `Run \`${formatCliCommand("fased update")}\` to update via your package manager (npm/pnpm), then rerun doctor.`,
      ].join("\n"),
      "Update",
    );
  }

  return { updated: false };
}
