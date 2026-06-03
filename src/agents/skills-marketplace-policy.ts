import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { parseFrontmatterBlock } from "../markdown/frontmatter.js";
import { resolveFasedAgentManifestBlock, normalizeStringList } from "../shared/frontmatter.js";

const VALID_WALLET_ACTIONS = new Set([
  "prepare",
  "send",
  "plan",
  "quote",
  "swap",
  "schedule_plan",
  "limit_order",
  "limit_cancel",
  "limit_history",
]);
const VALID_WALLET_ROLES = new Set(["agent"]);
const VALID_WALLET_CHAINS = new Set(["solana"]);
const RISKY_WALLET_ACTIONS = new Set(["send", "swap", "schedule_plan", "limit_order"]);

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

export type SkillMarketplaceManifestInspection = {
  skillFile: string;
  permissions: SkillMarketplacePermissionSummary;
};

async function findSkillFile(rootDir: string): Promise<string> {
  for (const candidate of ["SKILL.md", "skill.md", "skills.md", "SKILL.MD"]) {
    const file = path.join(rootDir, candidate);
    try {
      const stat = await fs.stat(file);
      if (stat.isFile()) {
        return file;
      }
    } catch {
      // try the next conventional name
    }
  }
  throw new Error("downloaded archive is missing SKILL.md");
}

function uniqueSorted(values: string[] | undefined): string[] | undefined {
  if (!values || values.length === 0) {
    return undefined;
  }
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].toSorted();
}

function normalizeNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`invalid marketplace walletActions.${field}`);
  }
  return Math.floor(parsed);
}

function normalizeBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function normalizeWalletActionsRequest(raw: unknown): SkillMarketplaceWalletActionsRequest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("invalid marketplace walletActions manifest");
  }
  const input = raw as Record<string, unknown>;
  const actions = uniqueSorted(normalizeStringList(input.actions));
  const roles = uniqueSorted(normalizeStringList(input.roles));
  const chains = uniqueSorted(normalizeStringList(input.chains));
  for (const action of actions ?? []) {
    if (!VALID_WALLET_ACTIONS.has(action)) {
      throw new Error(`invalid marketplace wallet action: ${action}`);
    }
  }
  for (const role of roles ?? []) {
    if (!VALID_WALLET_ROLES.has(role)) {
      throw new Error(`invalid marketplace wallet role: ${role}`);
    }
  }
  for (const chain of chains ?? []) {
    if (!VALID_WALLET_CHAINS.has(chain)) {
      throw new Error(`invalid marketplace wallet chain: ${chain}`);
    }
  }
  const maxAmount = typeof input.maxAmount === "string" ? input.maxAmount.trim() : "";
  const request: SkillMarketplaceWalletActionsRequest = {
    actions,
    roles,
    chains,
    inputMints: uniqueSorted(normalizeStringList(input.inputMints)),
    outputMints: uniqueSorted(normalizeStringList(input.outputMints)),
    maxAmount: maxAmount || undefined,
    maxSlippageBps: normalizeNumber(input.maxSlippageBps, "maxSlippageBps"),
    autonomous: normalizeBoolean(input.autonomous),
    cron: normalizeBoolean(input.cron),
  };
  return Object.fromEntries(
    Object.entries(request).filter(([, value]) =>
      Array.isArray(value) ? value.length > 0 : value !== undefined,
    ),
  ) as SkillMarketplaceWalletActionsRequest;
}

function readWalletActionsManifest(metadata: Record<string, unknown> | undefined): unknown {
  if (!metadata) {
    return undefined;
  }
  if (metadata.walletActions !== undefined) {
    return metadata.walletActions;
  }
  const permissions =
    metadata.permissions &&
    typeof metadata.permissions === "object" &&
    !Array.isArray(metadata.permissions)
      ? (metadata.permissions as Record<string, unknown>)
      : undefined;
  return permissions?.walletActions;
}

function readToolAccessManifest(
  metadata: Record<string, unknown> | undefined,
): string[] | undefined {
  if (!metadata) {
    return undefined;
  }
  const permissions =
    metadata.permissions &&
    typeof metadata.permissions === "object" &&
    !Array.isArray(metadata.permissions)
      ? (metadata.permissions as Record<string, unknown>)
      : undefined;
  const tools = uniqueSorted([
    ...normalizeStringList(metadata.tools),
    ...normalizeStringList(metadata.toolAccess),
    ...normalizeStringList(permissions?.tools),
    ...normalizeStringList(permissions?.toolAccess),
  ]);
  return tools && tools.length > 0 ? tools : undefined;
}

function readInstallManifest(
  metadata: Record<string, unknown> | undefined,
): SkillMarketplaceInstallRequest | undefined {
  const raw = metadata?.install;
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const kinds: string[] = [];
  const bins: string[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const item = entry as Record<string, unknown>;
    const kind =
      typeof item.kind === "string" ? item.kind : typeof item.type === "string" ? item.type : "";
    if (kind.trim()) {
      kinds.push(kind.trim().toLowerCase());
    }
    bins.push(...normalizeStringList(item.bins));
  }
  const request: SkillMarketplaceInstallRequest = {
    kinds: uniqueSorted(kinds),
    bins: uniqueSorted(bins),
  };
  return Object.fromEntries(
    Object.entries(request).filter(([, value]) => Array.isArray(value) && value.length > 0),
  ) as SkillMarketplaceInstallRequest;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digestPermissions(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function hasRiskyWalletActions(request: SkillMarketplaceWalletActionsRequest | undefined): boolean {
  if (!request) {
    return false;
  }
  if (request.autonomous === true || request.cron === true) {
    return true;
  }
  return (request.actions ?? []).some((action) => RISKY_WALLET_ACTIONS.has(action));
}

function hasRequestedInstallOrToolAccess(params: {
  install?: SkillMarketplaceInstallRequest;
  toolAccess?: string[];
}): boolean {
  return Boolean(
    params.toolAccess?.length || params.install?.kinds?.length || params.install?.bins?.length,
  );
}

export async function inspectSkillMarketplaceManifest(
  rootDir: string,
): Promise<SkillMarketplaceManifestInspection> {
  const skillFile = await findSkillFile(rootDir);
  const raw = await fs.readFile(skillFile, "utf8");
  const frontmatter = parseFrontmatterBlock(raw);
  const metadata = resolveFasedAgentManifestBlock({ frontmatter });
  const walletActionsRaw = readWalletActionsManifest(metadata);
  const walletActions =
    walletActionsRaw === undefined ? undefined : normalizeWalletActionsRequest(walletActionsRaw);
  const toolAccess = readToolAccessManifest(metadata);
  const install = readInstallManifest(metadata);
  const payload = { install, toolAccess, walletActions };
  return {
    skillFile,
    permissions: {
      version: 1,
      walletActions,
      toolAccess,
      install,
      risky:
        hasRiskyWalletActions(walletActions) ||
        hasRequestedInstallOrToolAccess({ install, toolAccess }),
      digest: digestPermissions(payload),
    },
  };
}

export function formatMarketplacePermissionSummary(
  summary: SkillMarketplacePermissionSummary | undefined,
): string {
  const wallet = summary?.walletActions;
  if (!wallet) {
    const parts = ["wallet actions: none requested"];
    if (summary?.toolAccess?.length) {
      parts.push(`tools: ${summary.toolAccess.join(",")}`);
    }
    if (summary?.install?.kinds?.length || summary?.install?.bins?.length) {
      parts.push(
        `install: ${summary.install.kinds?.join(",") || "unspecified"}${
          summary.install.bins?.length ? `; bins: ${summary.install.bins.join(",")}` : ""
        }`,
      );
    }
    return parts.join("; ");
  }
  const actions = wallet.actions?.join(",") || "unspecified";
  const autonomous = wallet.autonomous === true ? "yes" : "no";
  const cron = wallet.cron === true ? "yes" : "no";
  const parts = [`wallet actions: ${actions}`, `autonomous: ${autonomous}`, `cron: ${cron}`];
  if (summary?.toolAccess?.length) {
    parts.push(`tools: ${summary.toolAccess.join(",")}`);
  }
  if (summary?.install?.kinds?.length || summary?.install?.bins?.length) {
    parts.push(
      `install: ${summary.install.kinds?.join(",") || "unspecified"}${
        summary.install.bins?.length ? `; bins: ${summary.install.bins.join(",")}` : ""
      }`,
    );
  }
  return parts.join("; ");
}
