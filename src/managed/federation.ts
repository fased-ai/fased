import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

export type ManagedFederationTokenSummary = {
  path: string;
  exists: boolean;
  handle?: string;
  tokenId?: string;
  expiresAt?: string;
  agentSlug?: string;
  publicUrl?: string;
  hasZrokToken: boolean;
};

const MANAGED_AGENT_DOMAIN_SUFFIX = ".agents.fased.app";

export function resolveManagedFederationPublicUrl(params: {
  publicUrl?: string;
  agentSlug?: string;
}): string | undefined {
  const explicit = typeof params.publicUrl === "string" ? params.publicUrl.trim() : "";
  if (explicit) {
    return explicit;
  }
  const slug = typeof params.agentSlug === "string" ? params.agentSlug.trim() : "";
  if (!slug) {
    return undefined;
  }
  return `https://${slug}${MANAGED_AGENT_DOMAIN_SUFFIX}`;
}

export function resolveFederationAccessTokenPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "federation", "access-token.json");
}

export function readManagedFederationTokenSummary(
  env: NodeJS.ProcessEnv = process.env,
): ManagedFederationTokenSummary {
  const tokenPath = resolveFederationAccessTokenPath(env);
  if (!fs.existsSync(tokenPath)) {
    return {
      path: tokenPath,
      exists: false,
      hasZrokToken: false,
    };
  }
  try {
    const payload = JSON.parse(fs.readFileSync(tokenPath, "utf8")) as Record<string, unknown>;
    const agentSlug = typeof payload.agentSlug === "string" ? payload.agentSlug : undefined;
    const publicUrl = resolveManagedFederationPublicUrl({
      publicUrl: typeof payload.publicUrl === "string" ? payload.publicUrl : undefined,
      agentSlug,
    });
    return {
      path: tokenPath,
      exists: true,
      handle: typeof payload.handle === "string" ? payload.handle : undefined,
      tokenId: typeof payload.tokenId === "string" ? payload.tokenId : undefined,
      expiresAt: typeof payload.expiresAt === "string" ? payload.expiresAt : undefined,
      agentSlug,
      publicUrl,
      hasZrokToken: typeof payload.zrokToken === "string" && payload.zrokToken.trim().length > 0,
    };
  } catch {
    return {
      path: tokenPath,
      exists: true,
      hasZrokToken: false,
    };
  }
}
