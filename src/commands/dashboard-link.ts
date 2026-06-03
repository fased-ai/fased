import fs from "node:fs";
import path from "node:path";
import { parseDurationMs } from "../cli/parse-duration.js";
import { readConfigFileSnapshot } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import {
  CONTROL_UI_LOGIN_DEFAULT_GRANT_TTL_MS,
  createLoginGrant,
  normalizePublicHost,
} from "../gateway/control-ui-login.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";

const AGENT_DOMAIN_SUFFIX = ".agents.fased.app";

export type DashboardLinkOptions = {
  publicUrl: string;
  ttl?: string;
  onboarding?: boolean;
  allowCustomHost?: boolean;
  token?: string;
};

type DashboardLinkSnapshot = {
  valid: boolean;
  config?: { gateway?: { auth?: { token?: string } } };
};

type TokenCandidate = {
  source: "option" | "env" | "state-file" | "config";
  token: string;
};

function readStateGatewayToken(env: NodeJS.ProcessEnv = process.env): string {
  try {
    const filePath = path.join(resolveStateDir(env), "gateway-secret");
    if (!fs.existsSync(filePath)) {
      return "";
    }
    return fs.readFileSync(filePath, "utf8").trim();
  } catch {
    return "";
  }
}

function collectGatewayTokenCandidates(
  snapshot: DashboardLinkSnapshot,
  options: DashboardLinkOptions,
): TokenCandidate[] {
  const out: TokenCandidate[] = [];
  const optionToken = options.token?.trim() || "";
  if (optionToken) {
    out.push({ source: "option", token: optionToken });
  }
  const envToken = process.env.FASED_GATEWAY_TOKEN?.trim() || "";
  if (envToken) {
    out.push({ source: "env", token: envToken });
  }
  const stateToken = readStateGatewayToken(process.env);
  if (stateToken) {
    out.push({ source: "state-file", token: stateToken });
  }
  if (snapshot.valid) {
    const configuredToken = snapshot.config?.gateway?.auth?.token?.trim();
    if (configuredToken) {
      out.push({ source: "config", token: configuredToken });
    }
  }
  return out;
}

function resolveGatewayToken(
  snapshot: DashboardLinkSnapshot,
  options: DashboardLinkOptions,
): { token: string; source: TokenCandidate["source"] } {
  const optionToken = options.token?.trim() || "";
  if (optionToken) {
    // Explicit CLI override is authoritative for operational recovery.
    return { token: optionToken, source: "option" };
  }
  const candidates = collectGatewayTokenCandidates(snapshot, options);
  const distinct = new Map<string, TokenCandidate["source"][]>();
  for (const candidate of candidates) {
    const list = distinct.get(candidate.token) ?? [];
    list.push(candidate.source);
    distinct.set(candidate.token, list);
  }
  if (distinct.size > 1) {
    const parts = candidates.map((candidate) => `${candidate.source}=set`).join(", ");
    throw new Error(
      `gateway token mismatch across sources (${parts}); align --token / FASED_GATEWAY_TOKEN / ~/.fased/gateway-secret / gateway.auth.token`,
    );
  }
  if (candidates.length === 0) {
    return { token: "", source: "config" };
  }
  return { token: candidates[0].token, source: candidates[0].source };
}

export async function dashboardLinkCommand(
  runtime: RuntimeEnv = defaultRuntime,
  options: DashboardLinkOptions,
) {
  const rawPublicUrl = options.publicUrl?.trim() || "";
  if (!rawPublicUrl) {
    throw new Error("missing required --public-url");
  }

  let parsed: URL;
  try {
    parsed = new URL(rawPublicUrl);
  } catch {
    throw new Error("invalid --public-url");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("public URL must use https://");
  }

  const host = normalizePublicHost(parsed.host);
  if (!host) {
    throw new Error("public URL host is invalid");
  }
  if (!options.allowCustomHost && !host.endsWith(AGENT_DOMAIN_SUFFIX)) {
    throw new Error(
      "public URL host must be under *.agents.fased.app (use --allow-custom-host to override)",
    );
  }

  const snapshot = await readConfigFileSnapshot();
  const resolvedToken = resolveGatewayToken(snapshot, options);
  const gatewayToken = resolvedToken.token;
  if (!gatewayToken) {
    throw new Error(
      "gateway token not configured (set --token, FASED_GATEWAY_TOKEN, ~/.fased/gateway-secret, or gateway.auth.token)",
    );
  }

  const ttlMs = options.ttl
    ? parseDurationMs(options.ttl, { defaultUnit: "m" })
    : CONTROL_UI_LOGIN_DEFAULT_GRANT_TTL_MS;
  if (ttlMs <= 0) {
    throw new Error("ttl must be greater than 0");
  }

  const grant = createLoginGrant({
    gatewayToken,
    host,
    ttlMs,
  });

  const finalUrl = new URL(parsed.toString());
  const hashParams = new URLSearchParams();
  hashParams.set("login", grant);
  if (options.onboarding) {
    hashParams.set("onboarding", "1");
  }
  finalUrl.hash = hashParams.toString();

  runtime.log(`Dashboard login URL: ${finalUrl.toString()}`);
  runtime.log(`Grant TTL: ${Math.ceil(ttlMs / 1000)}s`);
  runtime.log(`Gateway token source: ${resolvedToken.source}`);
  runtime.log("This link is one-time use. If leaked, revoke by rotating gateway token.");
}
