import fs from "node:fs/promises";
import type { FasedAgentConfig } from "../../config/config.js";
import { loadConfig } from "../../config/config.js";
import { defaultRuntime } from "../../runtime.js";
import { resolveUserPath } from "../../utils.js";
import { syncSkillsToWorkspace } from "../skills.js";
import { DEFAULT_AGENT_WORKSPACE_DIR } from "../workspace.js";
import { resolveSandboxBackend } from "./backend.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import { ensureSandboxContainer } from "./docker.js";
import { createSandboxFsBridge } from "./fs-bridge.js";
import { maybePruneSandboxes } from "./prune.js";
import { resolveSandboxRuntimeStatus } from "./runtime-status.js";
import { resolveSandboxScopeKey, resolveSandboxWorkspaceDir } from "./shared.js";
import type { SandboxContext, SandboxDockerConfig, SandboxWorkspaceInfo } from "./types.js";
import { ensureSandboxWorkspace } from "./workspace.js";

async function ensureSandboxWorkspaceLayout(params: {
  cfg: ReturnType<typeof resolveSandboxConfigForAgent>;
  rawSessionKey: string;
  config?: FasedAgentConfig;
  workspaceDir?: string;
}): Promise<{
  agentWorkspaceDir: string;
  scopeKey: string;
  sandboxWorkspaceDir: string;
  workspaceDir: string;
}> {
  const { cfg, rawSessionKey } = params;

  const agentWorkspaceDir = resolveUserPath(
    params.workspaceDir?.trim() || DEFAULT_AGENT_WORKSPACE_DIR,
  );
  const workspaceRoot = resolveUserPath(cfg.workspaceRoot);
  const scopeKey = resolveSandboxScopeKey(cfg.scope, rawSessionKey);
  const sandboxWorkspaceDir =
    cfg.scope === "shared" ? workspaceRoot : resolveSandboxWorkspaceDir(workspaceRoot, scopeKey);
  const workspaceDir = cfg.workspaceAccess === "rw" ? agentWorkspaceDir : sandboxWorkspaceDir;

  if (workspaceDir === sandboxWorkspaceDir) {
    await ensureSandboxWorkspace(
      sandboxWorkspaceDir,
      agentWorkspaceDir,
      params.config?.agents?.defaults?.skipBootstrap,
    );
    if (cfg.workspaceAccess !== "rw") {
      try {
        await syncSkillsToWorkspace({
          sourceWorkspaceDir: agentWorkspaceDir,
          targetWorkspaceDir: sandboxWorkspaceDir,
          config: params.config,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : JSON.stringify(error);
        defaultRuntime.error?.(`Sandbox skill sync failed: ${message}`);
      }
    }
  } else {
    await fs.mkdir(workspaceDir, { recursive: true });
  }

  return { agentWorkspaceDir, scopeKey, sandboxWorkspaceDir, workspaceDir };
}

export async function resolveSandboxDockerUser(params: {
  docker: SandboxDockerConfig;
  workspaceDir: string;
  stat?: (workspaceDir: string) => Promise<{ uid: number; gid: number }>;
}): Promise<SandboxDockerConfig> {
  const configuredUser = params.docker.user?.trim();
  if (configuredUser) {
    return params.docker;
  }
  const stat = params.stat ?? ((workspaceDir: string) => fs.stat(workspaceDir));
  try {
    const workspaceStat = await stat(params.workspaceDir);
    const uid = Number.isInteger(workspaceStat.uid) ? workspaceStat.uid : null;
    const gid = Number.isInteger(workspaceStat.gid) ? workspaceStat.gid : null;
    if (uid === null || gid === null || uid < 0 || gid < 0) {
      return params.docker;
    }
    return { ...params.docker, user: `${uid}:${gid}` };
  } catch {
    return params.docker;
  }
}

function resolveSandboxSession(params: {
  config?: FasedAgentConfig;
  sessionKey?: string;
  forceUntrustedIsolation?: boolean;
}) {
  const rawSessionKey = params.sessionKey?.trim();
  if (!rawSessionKey) {
    return null;
  }

  const runtime = resolveSandboxRuntimeStatus({
    cfg: params.config,
    sessionKey: rawSessionKey,
  });
  if (!runtime.sandboxed && !params.forceUntrustedIsolation) {
    return null;
  }

  const resolvedConfig = resolveSandboxConfigForAgent(params.config, runtime.agentId);
  const cfg = params.forceUntrustedIsolation
    ? {
        ...resolvedConfig,
        mode: "all" as const,
        scope: "session" as const,
        workspaceAccess: "none" as const,
        docker: {
          ...resolvedConfig.docker,
          readOnlyRoot: true,
          network: "none",
          capDrop: ["ALL"],
          binds: undefined,
          dangerouslyAllowReservedContainerTargets: false,
          dangerouslyAllowExternalBindSources: false,
          dangerouslyAllowContainerNamespaceJoin: false,
        },
        browser: { ...resolvedConfig.browser, enabled: false, allowHostControl: false },
        tools: { allow: ["read"], deny: [] },
      }
    : resolvedConfig;
  return { rawSessionKey, runtime, cfg };
}

export async function resolveSandboxContext(params: {
  config?: FasedAgentConfig;
  sessionKey?: string;
  workspaceDir?: string;
  /** Force a per-session, no-network sandbox for marketplace skill instructions. */
  forceUntrustedIsolation?: boolean;
}): Promise<SandboxContext | null> {
  const resolved = resolveSandboxSession(params);
  if (!resolved) {
    return null;
  }
  const { rawSessionKey, cfg } = resolved;

  await maybePruneSandboxes(cfg);

  const { agentWorkspaceDir, scopeKey, workspaceDir } = await ensureSandboxWorkspaceLayout({
    cfg,
    rawSessionKey,
    config: params.config,
    workspaceDir: params.workspaceDir,
  });

  const backendId = cfg.backend ?? "docker";
  if (backendId !== "docker") {
    const backend = await resolveSandboxBackend(backendId);
    if (!backend) {
      throw new Error(`Sandbox backend not registered: ${backendId}`);
    }
    const sandboxContext: SandboxContext = {
      enabled: true,
      backendId: backend.id,
      backend,
      sessionKey: rawSessionKey,
      workspaceDir,
      agentWorkspaceDir,
      workspaceAccess: cfg.workspaceAccess,
      runtimeId: backend.runtimeId,
      runtimeLabel: backend.runtimeLabel,
      containerName: backend.runtimeId,
      containerWorkdir: backend.workdir,
      docker: cfg.docker,
      tools: cfg.tools,
      browserAllowHostControl: false,
    };
    sandboxContext.fsBridge = createSandboxFsBridge({ sandbox: sandboxContext });
    return sandboxContext;
  }

  const docker = await resolveSandboxDockerUser({
    docker: cfg.docker,
    workspaceDir,
  });
  const resolvedCfg = docker === cfg.docker ? cfg : { ...cfg, docker };

  const containerName = await ensureSandboxContainer({
    sessionKey: rawSessionKey,
    workspaceDir,
    agentWorkspaceDir,
    cfg: resolvedCfg,
  });

  let browser: SandboxContext["browser"];
  if (cfg.browser.enabled) {
    const [{ DEFAULT_BROWSER_EVALUATE_ENABLED }, controlAuth, { ensureSandboxBrowser }] =
      await Promise.all([
        import("../../browser/constants.js"),
        import("../../browser/control-auth.js"),
        import("./browser.js"),
      ]);
    const evaluateEnabled =
      params.config?.browser?.evaluateEnabled ?? DEFAULT_BROWSER_EVALUATE_ENABLED;
    // Sandbox browser bridge server runs on a loopback TCP port; always wire up
    // the same auth that loopback browser clients will send (token/password).
    const cfgForAuth = params.config ?? loadConfig();
    let browserAuth = controlAuth.resolveBrowserControlAuth(cfgForAuth);
    try {
      const ensured = await controlAuth.ensureBrowserControlAuth({ cfg: cfgForAuth });
      browserAuth = ensured.auth;
    } catch (error) {
      const message = error instanceof Error ? error.message : JSON.stringify(error);
      defaultRuntime.error?.(`Sandbox browser auth ensure failed: ${message}`);
    }
    browser =
      (await ensureSandboxBrowser({
        scopeKey,
        workspaceDir,
        agentWorkspaceDir,
        cfg: resolvedCfg,
        evaluateEnabled,
        bridgeAuth: browserAuth,
      })) ?? undefined;
  }

  const sandboxContext: SandboxContext = {
    enabled: true,
    sessionKey: rawSessionKey,
    workspaceDir,
    agentWorkspaceDir,
    workspaceAccess: resolvedCfg.workspaceAccess,
    containerName,
    containerWorkdir: resolvedCfg.docker.workdir,
    docker: resolvedCfg.docker,
    tools: resolvedCfg.tools,
    browserAllowHostControl: resolvedCfg.browser.allowHostControl,
    browser,
  };

  sandboxContext.fsBridge = createSandboxFsBridge({ sandbox: sandboxContext });

  return sandboxContext;
}

export async function ensureSandboxWorkspaceForSession(params: {
  config?: FasedAgentConfig;
  sessionKey?: string;
  workspaceDir?: string;
}): Promise<SandboxWorkspaceInfo | null> {
  const resolved = resolveSandboxSession(params);
  if (!resolved) {
    return null;
  }
  const { rawSessionKey, cfg } = resolved;

  const { workspaceDir } = await ensureSandboxWorkspaceLayout({
    cfg,
    rawSessionKey,
    config: params.config,
    workspaceDir: params.workspaceDir,
  });

  return {
    workspaceDir,
    containerWorkdir: cfg.docker.workdir,
  };
}
