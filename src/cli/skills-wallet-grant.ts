import type { FasedAgentConfig } from "../config/config.js";
import { readConfigFileSnapshotForWrite, writeConfigFile } from "../config/config.js";
import { danger, info } from "../globals.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";

const RISKY_WALLET_ACTIONS = new Set([
  "send",
  "swap",
  "schedule_plan",
  "schedule_send",
  "limit_order",
]);
const VALID_ACTIONS = new Set([
  "prepare",
  "send",
  "plan",
  "quote",
  "swap",
  "schedule_plan",
  "schedule_send",
  "limit_order",
  "limit_cancel",
  "limit_history",
]);
const VALID_CHAINS = new Set(["solana"]);

export type SkillsWalletGrantOptions = {
  actions?: string | string[];
  action?: string[];
  registry?: string[];
  role?: string;
  walletId?: string | string[];
  chain?: string | string[];
  inputMint?: string[];
  outputMint?: string[];
  maxAmount?: string;
  maxSlippageBps?: string | number;
  autonomous?: boolean;
  cron?: boolean;
  json?: boolean;
  dryRun?: boolean;
};

type WalletActionsGrant = {
  actions: string[];
  roles: ["agent"];
  walletIds?: string[];
  chains: string[];
  registries?: string[];
  inputMints?: string[];
  outputMints?: string[];
  maxAmount?: string;
  maxSlippageBps?: number;
  autonomous?: boolean;
  cron?: boolean;
};

function splitList(values: string | string[] | undefined): string[] {
  const raw = Array.isArray(values) ? values : values ? [values] : [];
  return [
    ...new Set(
      raw
        .flatMap((value) => value.split(","))
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}

function normalizeRegistryUrl(value: string): string {
  const raw = value.trim();
  if (!raw) {
    throw new Error("registry cannot be empty");
  }
  try {
    const url = new URL(raw);
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString().replace(/\/+$/, "");
  } catch {
    return raw.replace(/\/+$/, "");
  }
}

function validateSkillId(skillId: string): string {
  const id = skillId.trim();
  if (!id || id.includes("/") || id.includes("\\") || id.includes("..")) {
    throw new Error(`invalid skill id: ${skillId}`);
  }
  return id;
}

function parseMaxSlippageBps(value: string | number | undefined): number | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("max slippage bps must be a non-negative number");
  }
  return Math.floor(parsed);
}

export function buildWalletActionsGrant(opts: SkillsWalletGrantOptions): WalletActionsGrant {
  const actions = splitList([...(opts.action ?? []), ...splitList(opts.actions)]);
  if (actions.length === 0) {
    throw new Error("at least one wallet action is required");
  }
  for (const action of actions) {
    if (!VALID_ACTIONS.has(action)) {
      throw new Error(`invalid wallet action: ${action}`);
    }
  }
  const role = opts.role?.trim() || "agent";
  if (role !== "agent") {
    throw new Error("wallet skills can only be granted role=agent");
  }
  const walletIds = splitList(opts.walletId);
  if (walletIds.length === 0) {
    throw new Error("at least one Agent wallet id is required");
  }
  const chains = splitList(opts.chain).length > 0 ? splitList(opts.chain) : ["solana"];
  for (const chain of chains) {
    if (!VALID_CHAINS.has(chain)) {
      throw new Error(`invalid wallet chain: ${chain}`);
    }
  }
  const maxAmount = opts.maxAmount?.trim();
  if (actions.some((action) => RISKY_WALLET_ACTIONS.has(action)) && !maxAmount) {
    throw new Error(
      "max amount is required for send/swap/schedule_plan/schedule_send/limit_order grants",
    );
  }
  return {
    actions,
    roles: ["agent"],
    walletIds,
    chains,
    registries: splitList(opts.registry).map(normalizeRegistryUrl),
    inputMints: splitList(opts.inputMint),
    outputMints: splitList(opts.outputMint),
    maxAmount: maxAmount || undefined,
    maxSlippageBps: parseMaxSlippageBps(opts.maxSlippageBps),
    autonomous: opts.autonomous === true ? true : undefined,
    cron: opts.cron === true ? true : undefined,
  };
}

function compactWalletActionsGrant(grant: WalletActionsGrant): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(grant).filter(([, value]) => {
      if (Array.isArray(value)) {
        return value.length > 0;
      }
      return value !== undefined;
    }),
  );
}

export function applySkillWalletGrantConfig(params: {
  config: FasedAgentConfig;
  skillId: string;
  grant: WalletActionsGrant;
}): FasedAgentConfig {
  const skillId = validateSkillId(params.skillId);
  const next = structuredClone(params.config);
  next.skills = next.skills ?? {};
  next.skills.entries = next.skills.entries ?? {};
  next.skills.entries[skillId] = next.skills.entries[skillId] ?? {};
  const skillEntry = next.skills.entries[skillId];
  skillEntry.config = {
    ...skillEntry.config,
    walletActions: compactWalletActionsGrant(params.grant),
  };
  const registries = params.grant.registries ?? [];
  if (registries.length > 0) {
    next.skills.marketplace = next.skills.marketplace ?? {};
    const existing = next.skills.marketplace.allowRegistries ?? [];
    next.skills.marketplace.allowRegistries = [...new Set([...existing, ...registries])];
  }
  return next;
}

export function clearSkillWalletGrantConfig(params: {
  config: FasedAgentConfig;
  skillId: string;
}): FasedAgentConfig {
  const skillId = validateSkillId(params.skillId);
  const next = structuredClone(params.config);
  const skillEntry = next.skills?.entries?.[skillId];
  if (skillEntry?.config && typeof skillEntry.config === "object") {
    delete skillEntry.config.walletActions;
  }
  return next;
}

export async function runSkillsWalletGrant(params: {
  skillId: string;
  opts: SkillsWalletGrantOptions;
  runtime?: RuntimeEnv;
}): Promise<void> {
  const runtime = params.runtime ?? defaultRuntime;
  try {
    const grant = buildWalletActionsGrant(params.opts);
    const writeSnapshot = await readConfigFileSnapshotForWrite();
    if (!writeSnapshot.snapshot.valid) {
      runtime.error(danger(`Config invalid at ${writeSnapshot.snapshot.path}.`));
      for (const issue of writeSnapshot.snapshot.issues) {
        runtime.error(danger(`- ${issue.path || "<root>"}: ${issue.message}`));
      }
      runtime.exit(1);
      return;
    }
    const next = applySkillWalletGrantConfig({
      config: writeSnapshot.snapshot.resolved,
      skillId: params.skillId,
      grant,
    });
    if (params.opts.json) {
      runtime.log(
        JSON.stringify(
          {
            skillId: validateSkillId(params.skillId),
            walletActions: compactWalletActionsGrant(grant),
            dryRun: params.opts.dryRun === true,
          },
          null,
          2,
        ),
      );
    }
    if (!params.opts.dryRun) {
      await writeConfigFile(next, writeSnapshot.writeOptions);
      if (!params.opts.json) {
        runtime.log(info(`Granted wallet actions for skill "${validateSkillId(params.skillId)}".`));
      }
    }
  } catch (err) {
    runtime.error(danger(String(err)));
    runtime.exit(1);
  }
}
