import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ensureAuthProfileStore,
  markAuthProfileFailure,
  type AuthProfileStore,
} from "./auth-profiles.js";
import { shouldPreserveTransientCooldownProbeSlot } from "./failover-policy.js";
import { classifyFailoverReason } from "./pi-embedded-helpers.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function readSource(relativePath: string): Promise<string> {
  return fs.readFile(path.join(repoRoot, relativePath), "utf-8");
}

async function sourceExists(relativePath: string): Promise<boolean> {
  return Boolean(await fs.stat(path.join(repoRoot, relativePath)).catch(() => null));
}

async function withAuthProfileStore(
  fn: (ctx: { agentDir: string; store: AuthProfileStore }) => Promise<void>,
): Promise<void> {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-auth-policy-audit-"));
  try {
    await fs.writeFile(
      path.join(agentDir, "auth-profiles.json"),
      JSON.stringify({
        version: 1,
        profiles: {
          "anthropic:default": {
            type: "api_key",
            provider: "anthropic",
            key: "sk-default",
          },
        },
      }),
      "utf-8",
    );
    await fn({ agentDir, store: ensureAuthProfileStore(agentDir) });
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
}

describe("Lane 5 auth profile failure policy audit", () => {
  it("maps upstream 7a2e7dba73 to current Fased auth-profile failure surfaces", async () => {
    const runSource = await readSource("src/agents/pi-embedded-runner/run.ts");
    const usageSource = await readSource("src/agents/auth-profiles/usage.ts");
    const failoverPolicySource = await readSource("src/agents/failover-policy.ts");

    expect(
      await sourceExists("src/agents/pi-embedded-runner/run/auth-profile-failure-policy.ts"),
    ).toBe(false);
    expect(
      await sourceExists("src/agents/pi-embedded-runner/run/auth-profile-failure-policy.test.ts"),
    ).toBe(false);

    expect(runSource).toContain("const maybeMarkAuthProfileFailure = async");
    expect(runSource).toContain("function resolveSharedAuthProfileFailureReason");
    expect(runSource).toContain('reason === "timeout"');
    expect(runSource).toContain('reason === "format"');
    expect(runSource).toContain("classifyFailoverReason(errorText)");
    expect(runSource).toContain("classifyFailoverReason(lastAssistant?.errorMessage ??");
    expect(runSource).toContain("throw new FailoverError");

    expect(usageSource).toContain('"format"');
    expect(usageSource).toContain("failureCounts[params.reason]");
    expect(usageSource).toContain("markAuthProfileFailure");

    expect(failoverPolicySource).toContain('reason === "format"');
    expect(failoverPolicySource).toContain("shouldPreserveTransientCooldownProbeSlot");
  });

  it("preserves direct Fased format classification and profile cooldown semantics", async () => {
    expect(classifyFailoverReason("invalid request format")).toBe("format");
    expect(shouldPreserveTransientCooldownProbeSlot("format")).toBe(true);

    await withAuthProfileStore(async ({ agentDir, store }) => {
      await markAuthProfileFailure({
        store,
        profileId: "anthropic:default",
        reason: "format",
        agentDir,
      });

      const stats = store.usageStats?.["anthropic:default"];
      expect(typeof stats?.cooldownUntil).toBe("number");
      expect(stats?.disabledUntil).toBeUndefined();
      expect(stats?.disabledReason).toBeUndefined();
      expect(stats?.failureCounts?.format).toBe(1);
    });
  });

  it("keeps provider auth status and model fallback ownership separate from this audit", async () => {
    const modelFallback = await readSource("src/agents/model-fallback.ts");
    const gatewayModels = await readSource("src/gateway/server-methods/models.ts");
    const modelFailoverDocs = await readSource("docs/concepts/model-failover.md");

    expect(modelFallback).toContain("runWithModelFallback");
    expect(modelFallback).toContain("resolveCooldownDecision");
    expect(modelFallback).toContain("resolveProbeThrottleKey");

    expect(gatewayModels).toContain("authStatus");
    expect(gatewayModels).toContain("unusableKind");

    expect(modelFailoverDocs).toContain("Fased uses auth profiles");
    expect(modelFailoverDocs).toContain("Model fallback");
  });

  it("excludes format rejections from shared auth-profile cooldown after provider policy review", async () => {
    const runSource = await readSource("src/agents/pi-embedded-runner/run.ts");
    const resolverStart = runSource.indexOf("function resolveSharedAuthProfileFailureReason");
    const resolverEnd = runSource.indexOf("function scrubAnthropicRefusalMagic");
    const resolverBlock = runSource.slice(resolverStart, resolverEnd);
    const markStart = runSource.indexOf("const maybeMarkAuthProfileFailure = async");
    const markEnd = runSource.indexOf("try {", markStart);
    const markBlock = runSource.slice(markStart, markEnd);

    expect(resolverStart).toBeGreaterThan(-1);
    expect(resolverEnd).toBeGreaterThan(resolverStart);
    expect(resolverBlock).toContain('reason === "timeout"');
    expect(resolverBlock).toContain('reason === "format"');
    expect(resolverBlock).toContain("return null");
    expect(resolverBlock).toContain("return reason");

    expect(markStart).toBeGreaterThan(-1);
    expect(markEnd).toBeGreaterThan(markStart);
    expect(markBlock).toContain(
      "const sharedReason = resolveSharedAuthProfileFailureReason(reason)",
    );
    expect(markBlock).toContain("if (!profileId || !sharedReason)");
    expect(markBlock).toContain("reason: sharedReason");
    expect(markBlock).not.toContain("reason,");
  });
});
