import type { CronJob, CronTaskAccessBlock } from "./types.js";

function compactText(parts: Array<string | undefined>): string {
  return parts
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join("\n");
}

function accessBlock(params: {
  code: string;
  service: string;
  reason: string;
  setupCommand?: string;
  setupPath?: string;
  source: CronTaskAccessBlock["source"];
  detectedAtMs: number;
}): CronTaskAccessBlock {
  return {
    code: params.code,
    service: params.service,
    reason: params.reason,
    setupCommand: params.setupCommand,
    setupPath: params.setupPath,
    source: params.source,
    detectedAtMs: Math.max(0, Math.floor(params.detectedAtMs)),
  };
}

export function missingBraveSearchAccessBlock(params: {
  source: CronTaskAccessBlock["source"];
  detectedAtMs: number;
}): CronTaskAccessBlock {
  return accessBlock({
    code: "missing_brave_api_key",
    service: "web_search",
    reason: "Missing Brave Search API key for web_search.",
    setupCommand: "fased configure --section web",
    setupPath: "/services#service-web-search",
    source: params.source,
    detectedAtMs: params.detectedAtMs,
  });
}

export function missingCheapCheckModelRoleAccessBlock(params: {
  source: CronTaskAccessBlock["source"];
  detectedAtMs: number;
}): CronTaskAccessBlock {
  return accessBlock({
    code: "missing_cheap_check_model_role",
    service: "agent_models",
    reason: "Needs model role: cheap/check.",
    setupPath: "/agents",
    source: params.source,
    detectedAtMs: params.detectedAtMs,
  });
}

export function detectCronTaskAccessBlockFromText(params: {
  text: string;
  source: CronTaskAccessBlock["source"];
  detectedAtMs: number;
}): CronTaskAccessBlock | undefined {
  const text = params.text.trim();
  if (!text) {
    return undefined;
  }
  const lower = text.toLowerCase();

  if (
    lower.includes("missing_brave_api_key") ||
    /brave search api key (?:is )?(?:missing|required)/i.test(text) ||
    /web_search[\s\S]{0,160}(?:brave search )?api key/i.test(text)
  ) {
    return missingBraveSearchAccessBlock(params);
  }

  if (
    lower.includes("missing_perplexity_api_key") ||
    /web_search \(perplexity\) needs an api key/i.test(text)
  ) {
    return accessBlock({
      code: "missing_perplexity_api_key",
      service: "web_search",
      reason: "Missing Perplexity or OpenRouter API key for web_search.",
      setupCommand: "fased configure --section web",
      setupPath: "/services#service-web-search",
      source: params.source,
      detectedAtMs: params.detectedAtMs,
    });
  }

  if (
    lower.includes("missing_xai_api_key") ||
    /web_search \(grok\) needs an xai api key/i.test(text)
  ) {
    return accessBlock({
      code: "missing_xai_api_key",
      service: "web_search",
      reason: "Missing xAI API key for Grok web_search.",
      setupCommand: "fased configure --section web",
      setupPath: "/services#service-web-search",
      source: params.source,
      detectedAtMs: params.detectedAtMs,
    });
  }

  if (
    lower.includes("missing_gemini_api_key") ||
    /web_search \(gemini\) needs an api key/i.test(text)
  ) {
    return accessBlock({
      code: "missing_gemini_api_key",
      service: "web_search",
      reason: "Missing Gemini API key for web_search.",
      setupCommand: "fased configure --section web",
      setupPath: "/services#service-web-search",
      source: params.source,
      detectedAtMs: params.detectedAtMs,
    });
  }

  if (
    lower.includes("missing_kimi_api_key") ||
    /web_search \(kimi\) needs a moonshot api key/i.test(text)
  ) {
    return accessBlock({
      code: "missing_kimi_api_key",
      service: "web_search",
      reason: "Missing Moonshot/Kimi API key for web_search.",
      setupCommand: "fased configure --section web",
      setupPath: "/services#service-web-search",
      source: params.source,
      detectedAtMs: params.detectedAtMs,
    });
  }

  if (/authentication token has been invalidated/i.test(text)) {
    return accessBlock({
      code: "provider_auth_invalidated",
      service: "model_provider",
      reason: "Model provider authentication token was invalidated.",
      setupPath: "/providers",
      source: params.source,
      detectedAtMs: params.detectedAtMs,
    });
  }

  if (/skill-only tool is not available/i.test(text)) {
    return accessBlock({
      code: "missing_skill_tool",
      service: "skills",
      reason: "Selected skill-only tool is not available.",
      setupPath: "/skills#skill-library",
      source: params.source,
      detectedAtMs: params.detectedAtMs,
    });
  }

  if (/skill-only tool is not allowed/i.test(text)) {
    return accessBlock({
      code: "skill_action_not_allowed",
      service: "agent_skills",
      reason: "Selected skill-only tool is not allowed by this task policy.",
      setupPath: "/agents#agent-access",
      source: params.source,
      detectedAtMs: params.detectedAtMs,
    });
  }

  if (/wallet policy (?:blocked|rejected|requires approval)|wallet approval required/i.test(text)) {
    return accessBlock({
      code: "wallet_policy_blocked",
      service: "wallet_grants",
      reason: "Wallet policy blocks this task until approval or policy setup is complete.",
      setupPath: "/wallet#wallet-skill-grants",
      source: params.source,
      detectedAtMs: params.detectedAtMs,
    });
  }

  if (
    /github|gh[_\s-]?issues|gh_token/i.test(text) &&
    /missing|required|requires?|needs?|token|credential/i.test(text)
  ) {
    return accessBlock({
      code: "missing_github_credential",
      service: "github",
      reason: "Task requires a missing GitHub token or credential.",
      setupPath: "/services#service-github",
      source: params.source,
      detectedAtMs: params.detectedAtMs,
    });
  }

  if (
    /gmail|google workspace|google api|pubsub|pub\/sub|gog/i.test(text) &&
    /missing|required|requires?|needs?|token|credential|oauth/i.test(text)
  ) {
    return accessBlock({
      code: "missing_google_workspace_credential",
      service: "google_workspace",
      reason: "Task requires missing Google Workspace or Gmail access.",
      setupPath: "/services#service-google-workspace",
      source: params.source,
      detectedAtMs: params.detectedAtMs,
    });
  }

  if (
    /firecrawl/i.test(text) &&
    /missing|required|requires?|needs?|api key|credential/i.test(text)
  ) {
    return accessBlock({
      code: "missing_firecrawl_credential",
      service: "firecrawl",
      reason: "Task requires a missing Firecrawl API key.",
      setupPath: "/services#service-firecrawl",
      source: params.source,
      detectedAtMs: params.detectedAtMs,
    });
  }

  if (
    /(?:browser|chrome|chromium|cdp|playwright|web\.login|web login|image|audio|video|media)/i.test(
      text,
    ) &&
    /missing|required|requires?|needs?|not configured|disabled|not enabled|unavailable|not running/i.test(
      text,
    )
  ) {
    return accessBlock({
      code: "media_browser_unavailable",
      service: "media_browser",
      reason: "Task requires media or browser service setup.",
      setupPath: "/services#service-media-browser",
      source: params.source,
      detectedAtMs: params.detectedAtMs,
    });
  }

  if (
    /(?:plugin service|extension service|runtime service|plugin-managed service|custom service)/i.test(
      text,
    ) &&
    /missing|required|requires?|needs?|not configured|disabled|not enabled|unavailable|not loaded/i.test(
      text,
    )
  ) {
    return accessBlock({
      code: "plugin_service_unavailable",
      service: "plugin_services",
      reason: "Task requires a plugin-provided service that is not available.",
      setupPath: "/services#service-plugin-services",
      source: params.source,
      detectedAtMs: params.detectedAtMs,
    });
  }

  if (
    /(?:channel delivery|delivery target|telegram|discord|slack|whatsapp|signal|imessage|irc|matrix|mattermost|msteams|google chat|bot token|webhook)/i.test(
      text,
    ) &&
    /missing|required|requires?|needs?|not configured|disabled|not enabled|unavailable|credential|token/i.test(
      text,
    )
  ) {
    return accessBlock({
      code: "channel_delivery_unavailable",
      service: "channel_delivery",
      reason: "Task requires channel delivery setup or credentials.",
      setupPath: "/channels",
      source: params.source,
      detectedAtMs: params.detectedAtMs,
    });
  }

  if (
    /(?:missing|requires?|needs?) (?:an? )?(?:[a-z0-9_.-]+ )?(?:api key|token|credential)/i.test(
      text,
    )
  ) {
    if (/github|gh[_\s-]?issues|gh_token/i.test(text)) {
      return accessBlock({
        code: "missing_github_credential",
        service: "github",
        reason: "Task requires a missing GitHub token or credential.",
        setupPath: "/services#service-github",
        source: params.source,
        detectedAtMs: params.detectedAtMs,
      });
    }
    if (/gmail|google workspace|google api|pubsub|pub\/sub|gog/i.test(text)) {
      return accessBlock({
        code: "missing_google_workspace_credential",
        service: "google_workspace",
        reason: "Task requires missing Google Workspace or Gmail access.",
        setupPath: "/services#service-google-workspace",
        source: params.source,
        detectedAtMs: params.detectedAtMs,
      });
    }
    if (/firecrawl/i.test(text)) {
      return accessBlock({
        code: "missing_firecrawl_credential",
        service: "firecrawl",
        reason: "Task requires a missing Firecrawl API key.",
        setupPath: "/services#service-firecrawl",
        source: params.source,
        detectedAtMs: params.detectedAtMs,
      });
    }
    return accessBlock({
      code: "missing_credential",
      service: "task_access",
      reason: "Task requires a missing credential or access token.",
      setupPath: "/services",
      source: params.source,
      detectedAtMs: params.detectedAtMs,
    });
  }

  return undefined;
}

export function detectCronTaskAccessBlockFromRun(params: {
  error?: string;
  summary?: string;
  outputText?: string;
  detectedAtMs: number;
}): CronTaskAccessBlock | undefined {
  const text = compactText([params.error, params.summary, params.outputText]);
  return detectCronTaskAccessBlockFromText({
    text,
    source: "run-output",
    detectedAtMs: params.detectedAtMs,
  });
}

export function taskExplicitlyUsesWebSearch(job: CronJob): boolean {
  const allowed = job.executionPolicy?.allowedSkills ?? [];
  if (
    allowed.some((entry) => {
      const key = entry.trim().toLowerCase();
      return key === "web_search" || key === "search" || key === "web" || key === "group:web";
    })
  ) {
    return true;
  }
  const toolName = job.executionPolicy?.skillAction?.toolName?.trim().toLowerCase();
  return toolName === "web_search" || toolName === "$web_search";
}

function normalizeSkillKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^\$/, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function isSelectedSkillActionAllowed(job: CronJob, toolName: string): boolean {
  const policy = job.executionPolicy;
  if (policy?.skillScope !== "selected") {
    return true;
  }
  const allowed = policy.allowedSkills ?? [];
  if (allowed.length === 0) {
    return false;
  }
  const normalizedTool = normalizeSkillKey(toolName);
  return allowed.some((entry) => {
    const key = normalizeSkillKey(entry.replace(/^group:/i, ""));
    return key === normalizedTool || normalizedTool.startsWith(`${key}_`);
  });
}

export function detectCronTaskStaticAccessBlock(
  job: CronJob,
  detectedAtMs: number,
): CronTaskAccessBlock | undefined {
  const policy = job.executionPolicy;
  if (policy?.executionMode !== "skill-only") {
    return undefined;
  }
  if (policy.skillScope === "none") {
    return accessBlock({
      code: "skill_scope_none",
      service: "agent_skills",
      reason: "Skill-only task cannot run while task skills are set to none.",
      setupPath: "/agents#agent-access",
      source: "preflight",
      detectedAtMs,
    });
  }
  const toolName = policy.skillAction?.toolName?.trim();
  if (!toolName) {
    return accessBlock({
      code: "missing_skill_action",
      service: "agent_skills",
      reason: "Skill-only task needs a selected tool before it can run.",
      setupPath: "/agents#agent-access",
      source: "preflight",
      detectedAtMs,
    });
  }
  if (!isSelectedSkillActionAllowed(job, toolName)) {
    return accessBlock({
      code: "skill_action_not_allowed",
      service: "agent_skills",
      reason: "Selected skill-only tool is not allowed by this task policy.",
      setupPath: "/agents#agent-access",
      source: "preflight",
      detectedAtMs,
    });
  }
  return undefined;
}
