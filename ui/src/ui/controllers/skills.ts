import type { GatewayBrowserClient } from "../gateway.ts";
import type { SkillStatusEntry, SkillStatusReport } from "../types.ts";

export type ClawHubInstallTarget =
  | { scope: "shared" }
  | { scope: "default-agent" }
  | { scope: "agent"; agentId: string };

export type ClawHubInstallTargetValue = "shared" | "default-agent" | `agent:${string}`;

export type SkillCreateTemplate =
  | "general"
  | "research"
  | "tool"
  | "wallet-safe"
  | "runbook"
  | "task"
  | "channel";

export type ClawHubSearchResult = {
  score: number;
  slug: string;
  displayName: string;
  summary?: string;
  version?: string;
  updatedAt?: number;
};

export type ClawHubSkillDetail = {
  skill: {
    slug: string;
    displayName: string;
    summary?: string;
    tags?: Record<string, string>;
    createdAt: number;
    updatedAt: number;
  } | null;
  latestVersion?: {
    version: string;
    createdAt: number;
    changelog?: string;
  } | null;
  metadata?: {
    os?: string[] | null;
    systems?: string[] | null;
  } | null;
  owner?: {
    handle?: string | null;
    displayName?: string | null;
    image?: string | null;
  } | null;
};

export type SkillMarketplaceWalletActionsRequest = {
  actions?: string[];
  roles?: string[];
  chains?: string[];
  inputMints?: string[];
  outputMints?: string[];
  maxAmount?: string;
  maxSlippageBps?: number;
  autonomous?: boolean;
  cron?: boolean;
};

export type SkillMarketplaceInstallRequest = {
  kinds?: string[];
  bins?: string[];
};

export type SkillMarketplacePermissionSummary = {
  version: 1;
  walletActions?: SkillMarketplaceWalletActionsRequest;
  toolAccess?: string[];
  install?: SkillMarketplaceInstallRequest;
  risky: boolean;
  digest: string;
};

export type SkillMarketplaceArchiveFinding = {
  severity: "block" | "warn";
  code: string;
  path: string;
  message: string;
};

export type SkillMarketplaceArchiveScan = {
  version: 1;
  fileCount: number;
  totalBytes: number;
  files?: string[];
  filesTruncated?: boolean;
  findings: SkillMarketplaceArchiveFinding[];
  blocked: boolean;
};

export type SkillMarketplaceSourceTrust = {
  registry: string;
  trusted: true;
  mode: "allowlist" | "tracked-legacy";
  allowlist: string[];
};

export type SkillMarketplaceUpdateReview = {
  version: 1;
  approvalRequired: boolean;
  reasons: string[];
  permissionDigestChanged: boolean;
  previousPermissionDigest?: string;
  nextPermissionDigest: string;
  permissionDiff?: {
    added: string[];
    removed: string[];
  };
  addedScanFindings: Array<{
    severity: "warn";
    code: string;
    path: string;
    message: string;
  }>;
};

export type ClawHubMarketplaceReviewMode = "install" | "update";

export type ClawHubMarketplaceReview =
  | {
      ok: true;
      mode: ClawHubMarketplaceReviewMode;
      slug: string;
      version: string;
      previousVersion?: string | null;
      changed?: boolean;
      targetDir: string;
      sourceTrust?: SkillMarketplaceSourceTrust;
      detail?: ClawHubSkillDetail;
      permissions: SkillMarketplacePermissionSummary;
      installScan: SkillMarketplaceArchiveScan;
      updateReview: SkillMarketplaceUpdateReview;
      target?: ClawHubInstallTarget;
    }
  | {
      ok: false;
      mode: ClawHubMarketplaceReviewMode;
      slug: string;
      error: string;
      target?: ClawHubInstallTarget;
    };

export type SkillsState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  skillsLoading: boolean;
  skillsReport: SkillStatusReport | null;
  skillsError: string | null;
  skillsBusyKey: string | null;
  skillEdits: Record<string, string>;
  skillEnvEdits: Record<string, Record<string, string>>;
  skillConfigEdits: Record<string, string>;
  skillMessages: SkillMessageMap;
  skillCreateOpen: boolean;
  skillCreateName: string;
  skillCreateDescription: string;
  skillCreateAgentId: string;
  skillCreateTemplate: SkillCreateTemplate;
  skillCreateBusy: boolean;
  skillCreateError: string | null;
  skillEditor: SkillEditorState | null;
  skillEditorDraft: string;
  skillEditorLoading: boolean;
  skillEditorSaving: boolean;
  skillEditorError: string | null;
  clawhubSearchQuery: string;
  clawhubSearchResults: ClawHubSearchResult[] | null;
  clawhubSearchLoading: boolean;
  clawhubSearchError: string | null;
  clawhubDetail: ClawHubSkillDetail | null;
  clawhubDetailSlug: string | null;
  clawhubDetailLoading: boolean;
  clawhubDetailError: string | null;
  clawhubInstallSlug: string | null;
  clawhubInstallMessage: { kind: "success" | "error"; text: string } | null;
  clawhubReview: ClawHubMarketplaceReview | null;
  clawhubReviewLoading: boolean;
  clawhubReviewError: string | null;
  clawhubInstallTarget: ClawHubInstallTargetValue;
};

export type SkillMessage = {
  kind: "success" | "error";
  message: string;
};

export type SkillMessageMap = Record<string, SkillMessage>;

type SkillInstallRpcResult = {
  ok?: boolean;
  message?: string;
  stdout?: string;
  stderr?: string;
  code?: number | null;
  warnings?: string[];
};

export type SkillEditorState = {
  skillKey: string;
  name: string;
  source: string;
  filePath: string;
  contents: string;
};

type LoadSkillsOptions = {
  clearMessages?: boolean;
};

function setSkillMessage(state: SkillsState, key: string, message?: SkillMessage) {
  if (!key.trim()) {
    return;
  }
  const next = { ...state.skillMessages };
  if (message) {
    next[key] = message;
  } else {
    delete next[key];
  }
  state.skillMessages = next;
}

function getErrorMessage(err: unknown) {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

function formatSkillInstallFailure(result: SkillInstallRpcResult): string {
  const base = result.message?.trim() || "Skill dependency install failed.";
  const details = [
    result.stderr?.trim() ? `stderr: ${result.stderr.trim()}` : "",
    result.warnings?.length ? `warnings: ${result.warnings.join("; ")}` : "",
  ].filter(Boolean);
  return details.length > 0 ? `${base} ${details.join(" ")}` : base;
}

function missingGatewayMessage(action: string): string {
  return `Connect to the gateway before ${action}.`;
}

function reportMissingGateway(
  state: SkillsState,
  action: string,
  options?: { skillKey?: string },
): false {
  const message = missingGatewayMessage(action);
  state.skillsError = message;
  if (options?.skillKey) {
    setSkillMessage(state, options.skillKey, { kind: "error", message });
  }
  return false;
}

function hasGateway(state: SkillsState): state is SkillsState & {
  client: GatewayBrowserClient;
} {
  return Boolean(state.client && state.connected);
}

function findSkillByKey(state: SkillsState, skillKey: string): SkillStatusEntry | null {
  return state.skillsReport?.skills.find((skill) => skill.skillKey === skillKey) ?? null;
}

function isMarketplaceEnableBlocked(skill: SkillStatusEntry): boolean {
  const marketplace = skill.marketplace;
  if (!marketplace) {
    return false;
  }
  return (
    marketplace.scanBlocked || marketplace.scanBlocks > 0 || marketplace.updateApprovalRequired
  );
}

export function setClawHubSearchQuery(state: SkillsState, query: string) {
  state.clawhubSearchQuery = query;
  state.clawhubInstallMessage = null;
  state.clawhubSearchResults = null;
  state.clawhubSearchError = null;
  state.clawhubSearchLoading = false;
  state.clawhubReview = null;
  state.clawhubReviewError = null;
  state.clawhubReviewLoading = false;
}

export function setClawHubInstallTarget(state: SkillsState, target: string) {
  state.clawhubInstallTarget = normalizeClawHubInstallTargetValue(target);
  state.clawhubReview = null;
  state.clawhubReviewError = null;
  state.clawhubReviewLoading = false;
  state.clawhubInstallMessage = null;
}

export function normalizeClawHubInstallTargetValue(
  target?: string | null,
): ClawHubInstallTargetValue {
  const trimmed = target?.trim() ?? "";
  if (trimmed === "shared" || trimmed === "default-agent") {
    return trimmed;
  }
  if (trimmed.startsWith("agent:")) {
    const agentId = trimmed.slice("agent:".length).trim();
    if (agentId) {
      return `agent:${agentId}`;
    }
  }
  return "default-agent";
}

export function resolveClawHubInstallTarget(target?: string | null): ClawHubInstallTarget {
  const normalized = normalizeClawHubInstallTargetValue(target);
  if (normalized === "shared") {
    return { scope: "shared" };
  }
  if (normalized === "default-agent") {
    return { scope: "default-agent" };
  }
  return { scope: "agent", agentId: normalized.slice("agent:".length) };
}

export async function loadSkills(state: SkillsState, options?: LoadSkillsOptions) {
  if (options?.clearMessages && Object.keys(state.skillMessages).length > 0) {
    state.skillMessages = {};
  }
  if (!state.client || !state.connected) {
    return;
  }
  if (state.skillsLoading) {
    return;
  }
  state.skillsLoading = true;
  state.skillsError = null;
  try {
    const res = await state.client.request<SkillStatusReport | undefined>("skills.status", {});
    if (res) {
      state.skillsReport = res;
    }
  } catch (err) {
    state.skillsError = getErrorMessage(err);
  } finally {
    state.skillsLoading = false;
  }
}

export function updateSkillEdit(state: SkillsState, skillKey: string, value: string) {
  state.skillEdits = { ...state.skillEdits, [skillKey]: value };
}

export function updateSkillEnvEdit(
  state: SkillsState,
  skillKey: string,
  envName: string,
  value: string,
) {
  const current = state.skillEnvEdits[skillKey] ?? {};
  state.skillEnvEdits = {
    ...state.skillEnvEdits,
    [skillKey]: {
      ...current,
      [envName]: value,
    },
  };
}

export function updateSkillConfigEdit(state: SkillsState, skillKey: string, value: string) {
  state.skillConfigEdits = { ...state.skillConfigEdits, [skillKey]: value };
}

export function openSkillCreateDialog(state: SkillsState) {
  state.skillCreateOpen = true;
  state.skillCreateError = null;
}

export function closeSkillCreateDialog(state: SkillsState) {
  if (state.skillCreateBusy) {
    return;
  }
  state.skillCreateOpen = false;
  state.skillCreateError = null;
}

export function updateSkillCreateDraft(
  state: SkillsState,
  patch: Partial<
    Pick<
      SkillsState,
      "skillCreateName" | "skillCreateDescription" | "skillCreateAgentId" | "skillCreateTemplate"
    >
  >,
) {
  if (patch.skillCreateName !== undefined) {
    state.skillCreateName = patch.skillCreateName;
  }
  if (patch.skillCreateDescription !== undefined) {
    state.skillCreateDescription = patch.skillCreateDescription;
  }
  if (patch.skillCreateAgentId !== undefined) {
    state.skillCreateAgentId = patch.skillCreateAgentId;
  }
  if (patch.skillCreateTemplate !== undefined) {
    state.skillCreateTemplate = patch.skillCreateTemplate;
  }
}

export async function updateSkillEnabled(state: SkillsState, skillKey: string, enabled: boolean) {
  if (!hasGateway(state)) {
    reportMissingGateway(state, enabled ? "enabling this skill" : "hiding this skill", {
      skillKey,
    });
    return;
  }
  const skill = findSkillByKey(state, skillKey);
  if (enabled && skill && isMarketplaceEnableBlocked(skill)) {
    const marketplace = skill.marketplace;
    const message = marketplace?.updateApprovalRequired
      ? "Review this ClawHub skill update before enabling it."
      : "This ClawHub skill archive has blocked scan findings and cannot be enabled.";
    state.skillsError = message;
    setSkillMessage(state, skillKey, {
      kind: "error",
      message,
    });
    return;
  }
  state.skillsBusyKey = skillKey;
  state.skillsError = null;
  try {
    await state.client.request("skills.update", { skillKey, enabled });
    await loadSkills(state);
    setSkillMessage(state, skillKey, {
      kind: "success",
      message: enabled ? "Skill available in library" : "Skill hidden from library",
    });
  } catch (err) {
    const message = getErrorMessage(err);
    state.skillsError = message;
    setSkillMessage(state, skillKey, {
      kind: "error",
      message,
    });
  } finally {
    state.skillsBusyKey = null;
  }
}

export async function createSkill(state: SkillsState) {
  if (!hasGateway(state)) {
    state.skillCreateError = missingGatewayMessage("creating a skill");
    return;
  }
  const name = state.skillCreateName.trim();
  if (!name) {
    state.skillCreateError = "Skill name is required.";
    return;
  }
  state.skillCreateBusy = true;
  state.skillCreateError = null;
  try {
    const result = await state.client.request<{ skillKey?: string; name?: string }>(
      "skills.create",
      {
        name,
        description: state.skillCreateDescription,
        template: state.skillCreateTemplate,
        ...(state.skillCreateAgentId.trim() ? { agentId: state.skillCreateAgentId.trim() } : {}),
      },
    );
    await loadSkills(state);
    const skillKey = result?.skillKey ?? name;
    state.skillCreateOpen = false;
    state.skillCreateName = "";
    state.skillCreateDescription = "";
    state.skillCreateTemplate = "general";
    setSkillMessage(state, skillKey, {
      kind: "success",
      message: `Created ${result?.name ?? name}`,
    });
  } catch (err) {
    state.skillCreateError = getErrorMessage(err);
  } finally {
    state.skillCreateBusy = false;
  }
}

export async function saveSkillApiKey(state: SkillsState, skillKey: string) {
  if (!hasGateway(state)) {
    reportMissingGateway(state, "saving this skill API key", { skillKey });
    return;
  }
  state.skillsBusyKey = skillKey;
  state.skillsError = null;
  try {
    const apiKey = state.skillEdits[skillKey] ?? "";
    await state.client.request("skills.update", { skillKey, apiKey });
    await loadSkills(state);
    setSkillMessage(state, skillKey, {
      kind: "success",
      message: `API key saved — stored in config (skills.entries.${skillKey})`,
    });
  } catch (err) {
    const message = getErrorMessage(err);
    state.skillsError = message;
    setSkillMessage(state, skillKey, {
      kind: "error",
      message,
    });
  } finally {
    state.skillsBusyKey = null;
  }
}

export async function saveSkillEnv(state: SkillsState, skillKey: string) {
  if (!hasGateway(state)) {
    reportMissingGateway(state, "saving this skill environment config", { skillKey });
    return;
  }
  state.skillsBusyKey = skillKey;
  state.skillsError = null;
  try {
    const env = state.skillEnvEdits[skillKey] ?? {};
    await state.client.request("skills.update", { skillKey, env });
    await loadSkills(state);
    setSkillMessage(state, skillKey, {
      kind: "success",
      message: `Environment config saved — stored in config (skills.entries.${skillKey}.env)`,
    });
  } catch (err) {
    const message = getErrorMessage(err);
    state.skillsError = message;
    setSkillMessage(state, skillKey, {
      kind: "error",
      message,
    });
  } finally {
    state.skillsBusyKey = null;
  }
}

export async function saveSkillConfig(state: SkillsState, skillKey: string) {
  if (!hasGateway(state)) {
    reportMissingGateway(state, "saving this skill config", { skillKey });
    return;
  }
  state.skillsBusyKey = skillKey;
  state.skillsError = null;
  try {
    const raw = state.skillConfigEdits[skillKey] ?? "{}";
    const config = raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      throw new Error("Skill config must be a JSON object.");
    }
    await state.client.request("skills.update", { skillKey, config });
    await loadSkills(state);
    setSkillMessage(state, skillKey, {
      kind: "success",
      message: `Skill config saved — stored in config (skills.entries.${skillKey}.config)`,
    });
  } catch (err) {
    const message = getErrorMessage(err);
    state.skillsError = message;
    setSkillMessage(state, skillKey, {
      kind: "error",
      message,
    });
  } finally {
    state.skillsBusyKey = null;
  }
}

export async function openSkillEditor(state: SkillsState, skillKey: string) {
  if (!hasGateway(state)) {
    state.skillEditorError = missingGatewayMessage("opening the skill editor");
    reportMissingGateway(state, "opening the skill editor", { skillKey });
    return;
  }
  const skill = findSkillByKey(state, skillKey);
  if (!skill) {
    state.skillEditorError = `Skill not found: ${skillKey}`;
    return;
  }
  state.skillEditorLoading = true;
  state.skillEditorSaving = false;
  state.skillEditorError = null;
  try {
    const res = await state.client.request<{
      skillKey: string;
      name: string;
      source: string;
      filePath: string;
      content: string;
    }>("skills.file.get", { skillKey });
    const contents = res?.content ?? "";
    state.skillEditor = {
      skillKey: res?.skillKey ?? skillKey,
      name: res?.name ?? skill.name,
      source: res?.source ?? skill.source,
      filePath: res?.filePath ?? skill.filePath,
      contents,
    };
    state.skillEditorDraft = contents;
  } catch (err) {
    state.skillEditorError = getErrorMessage(err);
  } finally {
    state.skillEditorLoading = false;
  }
}

export async function copySkillToWorkspace(state: SkillsState, skillKey: string, agentId: string) {
  if (!hasGateway(state)) {
    reportMissingGateway(state, "copying this skill into a workspace", { skillKey });
    return;
  }
  state.skillsBusyKey = skillKey;
  state.skillsError = null;
  state.skillEditorError = null;
  try {
    const result = await state.client.request<{
      skillKey: string;
      name?: string;
      filePath?: string;
      copiedFiles?: number;
    }>("skills.copy", {
      skillKey,
      ...(agentId.trim() ? { agentId: agentId.trim() } : {}),
    });
    await loadSkills(state);
    setSkillMessage(state, result?.skillKey ?? skillKey, {
      kind: "success",
      message: `Copied ${result?.name ?? skillKey} into the Agent workspace`,
    });
    await openSkillEditor(state, result?.skillKey ?? skillKey);
  } catch (err) {
    const message = getErrorMessage(err);
    state.skillsError = message;
    setSkillMessage(state, skillKey, {
      kind: "error",
      message,
    });
  } finally {
    state.skillsBusyKey = null;
  }
}

export function closeSkillEditor(state: SkillsState) {
  state.skillEditor = null;
  state.skillEditorDraft = "";
  state.skillEditorLoading = false;
  state.skillEditorSaving = false;
  state.skillEditorError = null;
}

export function updateSkillEditorDraft(state: SkillsState, draft: string) {
  state.skillEditorDraft = draft;
}

export async function saveSkillEditor(state: SkillsState) {
  if (!state.skillEditor) {
    return;
  }
  if (!hasGateway(state)) {
    state.skillEditorError = missingGatewayMessage("saving the skill file");
    return;
  }
  state.skillEditorSaving = true;
  state.skillEditorError = null;
  try {
    await state.client.request("skills.file.set", {
      skillKey: state.skillEditor.skillKey,
      content: state.skillEditorDraft,
    });
    state.skillEditor = {
      ...state.skillEditor,
      contents: state.skillEditorDraft,
    };
    setSkillMessage(state, state.skillEditor.skillKey, {
      kind: "success",
      message: "Skill file saved",
    });
    await loadSkills(state);
  } catch (err) {
    state.skillEditorError = getErrorMessage(err);
  } finally {
    state.skillEditorSaving = false;
  }
}

export async function installSkill(
  state: SkillsState,
  skillKey: string,
  name: string,
  installId: string,
) {
  if (!hasGateway(state)) {
    reportMissingGateway(state, "installing this skill dependency", { skillKey });
    return;
  }
  state.skillsBusyKey = skillKey;
  state.skillsError = null;
  try {
    const result = await state.client.request<SkillInstallRpcResult>("skills.install", {
      name,
      installId,
      timeoutMs: 120000,
    });
    if (result?.ok === false) {
      throw new Error(formatSkillInstallFailure(result));
    }
    await loadSkills(state);
    const warningText = result?.warnings?.length ? ` Warnings: ${result.warnings.join("; ")}` : "";
    setSkillMessage(state, skillKey, {
      kind: "success",
      message: `${result?.message ?? "Installed"}${warningText}`,
    });
  } catch (err) {
    const message = getErrorMessage(err);
    await loadSkills(state).catch(() => undefined);
    state.skillsError = message;
    setSkillMessage(state, skillKey, {
      kind: "error",
      message,
    });
  } finally {
    state.skillsBusyKey = null;
  }
}

export async function searchClawHub(state: SkillsState, query: string) {
  if (!query.trim()) {
    state.clawhubSearchResults = null;
    state.clawhubSearchError = null;
    state.clawhubSearchLoading = false;
    return;
  }
  if (!hasGateway(state)) {
    state.clawhubSearchResults = null;
    state.clawhubSearchLoading = false;
    state.clawhubSearchError = missingGatewayMessage("searching ClawHub");
    return;
  }
  // Clear stale entries as soon as a new search begins so the UI cannot act on
  // results that no longer match the current query while the next request is in flight.
  state.clawhubSearchResults = null;
  state.clawhubSearchLoading = true;
  state.clawhubSearchError = null;
  try {
    const res = await state.client.request<{ results: ClawHubSearchResult[] }>("skills.search", {
      query,
      limit: 20,
    });
    if (query !== state.clawhubSearchQuery) {
      return;
    }
    state.clawhubSearchResults = res?.results ?? [];
  } catch (err) {
    if (query !== state.clawhubSearchQuery) {
      return;
    }
    state.clawhubSearchError = getErrorMessage(err);
  } finally {
    if (query === state.clawhubSearchQuery) {
      state.clawhubSearchLoading = false;
    }
  }
}

export async function loadClawHubDetail(state: SkillsState, slug: string) {
  state.clawhubDetailSlug = slug;
  state.clawhubDetailLoading = true;
  state.clawhubDetailError = null;
  state.clawhubDetail = null;
  if (!hasGateway(state)) {
    state.clawhubDetailLoading = false;
    state.clawhubDetailError = missingGatewayMessage("loading skill details");
    return;
  }
  try {
    const res = await state.client.request<ClawHubSkillDetail>("skills.detail", { slug });
    if (slug !== state.clawhubDetailSlug) {
      return;
    }
    state.clawhubDetail = res ?? null;
  } catch (err) {
    if (slug !== state.clawhubDetailSlug) {
      return;
    }
    state.clawhubDetailError = getErrorMessage(err);
  } finally {
    if (slug === state.clawhubDetailSlug) {
      state.clawhubDetailLoading = false;
    }
  }
}

export function closeClawHubDetail(state: SkillsState) {
  state.clawhubDetailSlug = null;
  state.clawhubDetail = null;
  state.clawhubDetailError = null;
  state.clawhubDetailLoading = false;
}

export async function installFromClawHub(state: SkillsState, slug: string) {
  closeClawHubDetail(state);
  await previewClawHubInstall(state, slug);
}

export async function previewClawHubInstall(state: SkillsState, slug: string) {
  state.clawhubReviewLoading = true;
  state.clawhubReviewError = null;
  state.clawhubReview = null;
  state.clawhubInstallMessage = null;
  const target = resolveClawHubInstallTarget(state.clawhubInstallTarget);
  if (!hasGateway(state)) {
    const message = missingGatewayMessage("reviewing a ClawHub install");
    state.clawhubReviewError = message;
    state.clawhubReview = { ok: false, mode: "install", slug, target, error: message };
    state.clawhubReviewLoading = false;
    return;
  }
  try {
    const result = await state.client.request<ClawHubMarketplaceReview>(
      "skills.marketplace.install.preview",
      { slug, target },
    );
    if (result?.ok) {
      state.clawhubReview = { ...result, mode: "install", target };
    } else {
      const message =
        result && "error" in result ? result.error : "Could not preview skill install.";
      state.clawhubReview = {
        ok: false,
        mode: "install",
        slug,
        target,
        error: message,
      };
      state.clawhubInstallMessage = { kind: "error", text: message };
    }
  } catch (err) {
    const message = getErrorMessage(err);
    state.clawhubReviewError = message;
    state.clawhubInstallMessage = { kind: "error", text: message };
    state.clawhubReview = {
      ok: false,
      mode: "install",
      slug,
      target,
      error: message,
    };
  } finally {
    state.clawhubReviewLoading = false;
  }
}

export async function previewClawHubUpdate(state: SkillsState, slug: string) {
  state.clawhubReviewLoading = true;
  state.clawhubReviewError = null;
  state.clawhubReview = null;
  state.clawhubInstallMessage = null;
  const target = resolveClawHubInstallTarget(state.clawhubInstallTarget);
  if (!hasGateway(state)) {
    const message = missingGatewayMessage("reviewing a ClawHub update");
    state.clawhubReviewError = message;
    state.clawhubReview = { ok: false, mode: "update", slug, target, error: message };
    state.clawhubReviewLoading = false;
    return;
  }
  try {
    const result = await state.client.request<{ results: ClawHubMarketplaceReview[] }>(
      "skills.marketplace.update.preview",
      { slug, target },
    );
    const first = result?.results?.[0];
    if (first?.ok) {
      state.clawhubReview = { ...first, mode: "update", target };
    } else {
      const message = first && "error" in first ? first.error : "Could not preview skill update.";
      state.clawhubReview = {
        ok: false,
        mode: "update",
        slug,
        target,
        error: message,
      };
      state.clawhubInstallMessage = { kind: "error", text: message };
    }
  } catch (err) {
    const message = getErrorMessage(err);
    state.clawhubReviewError = message;
    state.clawhubInstallMessage = { kind: "error", text: message };
    state.clawhubReview = {
      ok: false,
      mode: "update",
      slug,
      target,
      error: message,
    };
  } finally {
    state.clawhubReviewLoading = false;
  }
}

export function closeClawHubReview(state: SkillsState) {
  state.clawhubReview = null;
  state.clawhubReviewError = null;
  state.clawhubReviewLoading = false;
}

export async function confirmClawHubMarketplaceReview(state: SkillsState) {
  const review = state.clawhubReview;
  if (!review?.ok) {
    return;
  }
  if (!hasGateway(state)) {
    const message = missingGatewayMessage("installing this ClawHub skill");
    state.clawhubReviewError = message;
    state.clawhubInstallMessage = { kind: "error", text: message };
    return;
  }
  state.clawhubInstallSlug = review.slug;
  state.clawhubInstallMessage = null;
  state.clawhubReviewError = null;
  try {
    if (review.mode === "install") {
      await state.client.request("skills.marketplace.install", {
        slug: review.slug,
        version: review.version,
        target: review.target,
      });
      state.clawhubInstallMessage = {
        kind: "success",
        text: `Installed ${review.slug}`,
      };
    } else {
      await state.client.request("skills.marketplace.update", {
        slug: review.slug,
        target: review.target,
        allowPermissionChanges: true,
      });
      state.clawhubInstallMessage = {
        kind: "success",
        text: `Updated ${review.slug}`,
      };
    }
    await loadSkills(state);
    closeClawHubReview(state);
  } catch (err) {
    const message = getErrorMessage(err);
    state.clawhubReviewError = message;
    state.clawhubInstallMessage = { kind: "error", text: message };
  } finally {
    state.clawhubInstallSlug = null;
  }
}
