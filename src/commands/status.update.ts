import { formatCliCommand } from "../cli/command-format.js";
import { resolveFasedAgentPackageRoot } from "../infra/fased-root.js";
import type { UpdateChannel } from "../infra/update-channels.js";
import { checkUpdateStatus, type UpdateCheckResult } from "../infra/update-check.js";

export async function getUpdateCheckResult(params: {
  timeoutMs: number;
  fetchGit: boolean;
  includeRegistry: boolean;
}): Promise<UpdateCheckResult> {
  const root = await resolveFasedAgentPackageRoot({
    moduleUrl: import.meta.url,
    argv1: process.argv[1],
    cwd: process.cwd(),
  });
  return await checkUpdateStatus({
    root,
    timeoutMs: params.timeoutMs,
    fetchGit: params.fetchGit,
    includeRegistry: params.includeRegistry,
  });
}

export type UpdateAvailability = {
  available: boolean;
  hasGitUpdate: boolean;
  gitBehind: number | null;
};

export function resolveUpdateAvailability(
  update: UpdateCheckResult,
  opts: { channel?: UpdateChannel } = {},
): UpdateAvailability {
  const includeGitBehind = opts.channel == null || opts.channel === "dev";
  const gitBehind =
    includeGitBehind && update.installKind === "git" && typeof update.git?.behind === "number"
      ? update.git.behind
      : null;
  const hasGitUpdate = gitBehind != null && gitBehind > 0;

  return {
    available: hasGitUpdate,
    hasGitUpdate,
    gitBehind,
  };
}

export function formatUpdateAvailableHint(
  update: UpdateCheckResult,
  opts: { channel?: UpdateChannel } = {},
): string | null {
  const availability = resolveUpdateAvailability(update, opts);
  if (!availability.available) {
    return null;
  }

  const suffix = availability.gitBehind != null ? ` (git behind ${availability.gitBehind})` : "";
  return `Developer source update available${suffix}. Run: ${formatCliCommand("fased dev update-source")}`;
}

export function formatUpdateOneLiner(
  update: UpdateCheckResult,
  opts: { channel?: UpdateChannel } = {},
): string {
  const parts: string[] = [];

  if (update.installKind === "git" && update.git) {
    if (opts.channel && opts.channel !== "dev") {
      parts.push(`${opts.channel} channel`);
      if (update.git.dirty === true) {
        parts.push("dirty");
      }
    } else {
      const branch = update.git.branch ? `git ${update.git.branch}` : "git";
      parts.push(branch);
      if (update.git.upstream) {
        parts.push(`↔ ${update.git.upstream}`);
      }
      if (update.git.dirty === true) {
        parts.push("dirty");
      }
      if (update.git.behind != null && update.git.ahead != null) {
        if (update.git.behind === 0 && update.git.ahead === 0) {
          parts.push("up to date");
        } else if (update.git.behind > 0 && update.git.ahead === 0) {
          parts.push(`behind ${update.git.behind}`);
        } else if (update.git.behind === 0 && update.git.ahead > 0) {
          parts.push(`ahead ${update.git.ahead}`);
        } else if (update.git.behind > 0 && update.git.ahead > 0) {
          parts.push(`diverged (ahead ${update.git.ahead}, behind ${update.git.behind})`);
        }
      }
      if (update.git.fetchOk === false) {
        parts.push("fetch failed");
      }
    }
  } else {
    parts.push("managed lifecycle status via fased update status");
  }

  if (update.deps) {
    if (update.deps.status === "ok") {
      parts.push("deps ok");
    }
    if (update.deps.status === "missing") {
      parts.push("deps missing");
    }
    if (update.deps.status === "stale") {
      parts.push("deps stale");
    }
  }
  return `Update: ${parts.join(" · ")}`;
}
