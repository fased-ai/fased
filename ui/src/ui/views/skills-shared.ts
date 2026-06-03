import { html, nothing } from "lit";
import type { SkillStatusEntry } from "../types.ts";

export type SkillReadinessKind =
  | "ready"
  | "needs-api-key"
  | "needs-dependency"
  | "needs-config"
  | "unsupported-os"
  | "disabled";

export type SkillReadiness = {
  kind: SkillReadinessKind;
  label: string;
  tone: "ok" | "warn" | "muted";
  detail: string;
  missing: string[];
};

export function computeSkillMissing(skill: SkillStatusEntry): string[] {
  return [
    ...skill.missing.bins.map((b) => `bin:${b}`),
    ...skill.missing.env.map((e) => `env:${e}`),
    ...skill.missing.config.map((c) => `config:${c}`),
    ...skill.missing.os.map((o) => `os:${o}`),
  ];
}

export function computeSkillReasons(skill: SkillStatusEntry): string[] {
  const reasons: string[] = [];
  if (skill.disabled) {
    reasons.push("disabled");
  }
  if (skill.blockedByAllowlist) {
    reasons.push("blocked by allowlist");
  }
  return reasons;
}

export function isBundledSkill(skill: SkillStatusEntry): boolean {
  return Boolean(skill.bundled || skill.source === "fased-bundled");
}

export function getSkillReadiness(skill: SkillStatusEntry): SkillReadiness {
  const missing = computeSkillMissing(skill);
  if (skill.disabled) {
    return {
      kind: "disabled",
      label: "Hidden",
      tone: "muted",
      detail: "Skill is hidden from the library.",
      missing,
    };
  }
  if (skill.missing.os.length > 0) {
    return {
      kind: "unsupported-os",
      label: "Unsupported OS",
      tone: "muted",
      detail: `Requires ${skill.missing.os.join(", ")}.`,
      missing,
    };
  }
  if (skill.missing.env.length > 0) {
    const primaryMissing =
      skill.primaryEnv && skill.missing.env.includes(skill.primaryEnv)
        ? skill.primaryEnv
        : skill.missing.env[0];
    return {
      kind: "needs-api-key",
      label: "Needs API key",
      tone: "warn",
      detail: primaryMissing ? `Missing ${primaryMissing}.` : "Missing provider credential.",
      missing,
    };
  }
  if (skill.missing.bins.length > 0) {
    return {
      kind: "needs-dependency",
      label: "Needs dependency",
      tone: "warn",
      detail: `Missing ${skill.missing.bins.map((bin) => `bin:${bin}`).join(", ")}.`,
      missing,
    };
  }
  if (skill.blockedByAllowlist || skill.missing.config.length > 0 || !skill.eligible) {
    return {
      kind: "needs-config",
      label: "Needs config",
      tone: "warn",
      detail: skill.blockedByAllowlist
        ? "This agent's skill allowlist blocks it."
        : skill.missing.config.length > 0
          ? `Missing ${skill.missing.config.map((name) => `config:${name}`).join(", ")}.`
          : "Skill configuration is incomplete.",
      missing,
    };
  }
  return {
    kind: "ready",
    label: "Ready",
    tone: "ok",
    detail: "Ready to use.",
    missing,
  };
}

export function skillReadinessClass(skill: SkillStatusEntry): string {
  const readiness = getSkillReadiness(skill);
  return readiness.tone === "muted" ? "muted" : readiness.tone;
}

export function isSkillReady(skill: SkillStatusEntry): boolean {
  return getSkillReadiness(skill).kind === "ready";
}

export function skillSourceLabel(skill: SkillStatusEntry): string {
  if (skill.marketplace?.source === "clawhub") {
    return "Installed from ClawHub";
  }
  switch (skill.source) {
    case "fased-workspace":
    case "workspace":
      return "Agent workspace";
    case "fased-managed":
      return "Shared library";
    case "agents-skills-project":
      return "Project skill";
    case "agents-skills-personal":
      return "Personal skill";
    case "fased-bundled":
      return "Bundled";
    default:
      return skill.bundled ? "Bundled" : skill.source || "Unknown source";
  }
}

export function summarizeSkillReadiness(skills: SkillStatusEntry[]) {
  const summary = {
    bundled: 0,
    ready: 0,
    needsApiKey: 0,
    needsDependency: 0,
    needsConfig: 0,
    unsupportedOs: 0,
    disabled: 0,
    needsSetup: 0,
  };
  for (const skill of skills) {
    if (isBundledSkill(skill)) {
      summary.bundled++;
    }
    switch (getSkillReadiness(skill).kind) {
      case "ready":
        summary.ready++;
        break;
      case "needs-api-key":
        summary.needsApiKey++;
        summary.needsSetup++;
        break;
      case "needs-dependency":
        summary.needsDependency++;
        summary.needsSetup++;
        break;
      case "needs-config":
        summary.needsConfig++;
        summary.needsSetup++;
        break;
      case "unsupported-os":
        summary.unsupportedOs++;
        summary.needsSetup++;
        break;
      case "disabled":
        summary.disabled++;
        summary.needsSetup++;
        break;
    }
  }
  return summary;
}

export function renderSkillStatusChips(params: {
  skill: SkillStatusEntry;
  showBundledBadge?: boolean;
}) {
  const skill = params.skill;
  const readiness = getSkillReadiness(skill);
  const sourceLabel = skillSourceLabel(skill);
  const showBundledBadge =
    Boolean(params.showBundledBadge) && isBundledSkill(skill) && sourceLabel !== "Bundled";
  return html`
    <div class="chip-row" style="margin-top: 6px;">
      <span class="chip" title="Where this SKILL.md was loaded from.">${sourceLabel}</span>
      ${
        skill.marketplace?.source === "clawhub"
          ? html`
              <span class="chip">ClawHub</span>
              <span class="chip">v${skill.marketplace.installedVersion}</span>
            `
          : nothing
      }
      ${
        showBundledBadge
          ? html`
              <span class="chip">bundled</span>
            `
          : nothing
      }
      <span class="chip ${readiness.tone === "ok" ? "chip-ok" : "chip-warn"}">
        ${readiness.label}
      </span>
    </div>
  `;
}
