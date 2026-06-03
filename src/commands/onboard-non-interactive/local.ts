import { formatCliCommand } from "../../cli/command-format.js";
import type { FasedAgentConfig } from "../../config/config.js";
import { resolveGatewayPort, writeConfigFile } from "../../config/config.js";
import { logConfigUpdated } from "../../config/logging.js";
import { clearDeviceAuthStore } from "../../infra/device-auth-store.js";
import type { RuntimeEnv } from "../../runtime.js";
import { isHostedSecurityCapableSession } from "../../wizard/host-security-capability.js";
import { applyHostingSecurity } from "../../wizard/onboarding.host-security.js";
import { DEFAULT_GATEWAY_DAEMON_RUNTIME } from "../daemon-runtime.js";
import { formatHealthCheckFailure } from "../health-format.js";
import { healthCommand } from "../health.js";
import { applyOnboardingLocalWorkspaceConfig } from "../onboard-config.js";
import {
  applyWizardMetadata,
  DEFAULT_WORKSPACE,
  ensureWorkspaceAndSessions,
  resolveControlUiLinks,
  waitForGatewayReachable,
} from "../onboard-helpers.js";
import { applyRecommendedInternalHooks } from "../onboard-hooks.js";
import type { OnboardOptions } from "../onboard-types.js";
import { inferAuthChoiceFromFlags } from "./local/auth-choice-inference.js";
import { applyNonInteractiveAuthChoice } from "./local/auth-choice.js";
import { installGatewayDaemonNonInteractive } from "./local/daemon-install.js";
import { applyNonInteractiveGatewayConfig } from "./local/gateway-config.js";
import { logNonInteractiveOnboardingJson } from "./local/output.js";
import { applyNonInteractiveSkillsConfig } from "./local/skills-config.js";
import { applyNonInteractiveWalletConfig } from "./local/wallet-config.js";
import { resolveNonInteractiveWorkspaceDir } from "./local/workspace.js";

export async function runNonInteractiveOnboardingLocal(params: {
  opts: OnboardOptions;
  runtime: RuntimeEnv;
  baseConfig: FasedAgentConfig;
}) {
  const { opts, runtime, baseConfig } = params;
  const mode = "local" as const;
  const hostSecurityCapable = isHostedSecurityCapableSession(opts.hostSecurityCapable === true);
  if (
    typeof opts.hostProfile === "string" &&
    opts.hostProfile !== "local" &&
    opts.hostProfile !== "hosting"
  ) {
    runtime.error("Invalid --host-profile. Use local or hosting.");
    runtime.exit(1);
    return;
  }

  if (
    opts.hostProfile === "hosting" &&
    !hostSecurityCapable &&
    opts.hostMaintenanceSession !== true
  ) {
    runtime.error(
      [
        "Hosted non-interactive onboarding requires a root-started installer session.",
        `Re-run ${formatCliCommand("./install.sh")} from root and select a hosting profile there, or use the explicit hosted installer flags from root.`,
      ].join("\n"),
    );
    runtime.exit(1);
    return;
  }

  const workspaceDir = resolveNonInteractiveWorkspaceDir({
    opts,
    baseConfig,
    defaultWorkspaceDir: DEFAULT_WORKSPACE,
  });

  const hostSecurity = await applyHostingSecurity({ opts, runtime });
  if (hostSecurity.profile === "hosting" && hostSecurity.checks.length > 0) {
    runtime.log("Hosting host security checklist:");
    for (const check of hostSecurity.checks) {
      runtime.log(`${check.ok ? "✓" : "✗"} ${check.name}: ${check.detail}`);
    }
  }

  let nextConfig: FasedAgentConfig = applyOnboardingLocalWorkspaceConfig(baseConfig, workspaceDir);

  const inferredAuthChoice = inferAuthChoiceFromFlags(opts);
  if (!opts.authChoice && inferredAuthChoice.matches.length > 1) {
    runtime.error(
      [
        "Multiple API key flags were provided for non-interactive onboarding.",
        "Use a single provider flag or pass --auth-choice explicitly.",
        `Flags: ${inferredAuthChoice.matches.map((match) => match.label).join(", ")}`,
      ].join("\n"),
    );
    runtime.exit(1);
    return;
  }
  const authChoice = opts.authChoice ?? inferredAuthChoice.choice ?? "skip";
  const nextConfigAfterAuth = await applyNonInteractiveAuthChoice({
    nextConfig,
    authChoice,
    opts,
    runtime,
    baseConfig,
  });
  if (!nextConfigAfterAuth) {
    return;
  }
  nextConfig = nextConfigAfterAuth;

  const gatewayBasePort = resolveGatewayPort(baseConfig);
  const gatewayResult = applyNonInteractiveGatewayConfig({
    nextConfig,
    opts,
    runtime,
    defaultPort: gatewayBasePort,
  });
  if (!gatewayResult) {
    return;
  }
  nextConfig = gatewayResult.nextConfig;

  nextConfig = applyNonInteractiveSkillsConfig({ nextConfig, opts, runtime });
  nextConfig = applyRecommendedInternalHooks(nextConfig);
  nextConfig = applyNonInteractiveWalletConfig({ nextConfig, opts, runtime });

  nextConfig = applyWizardMetadata(nextConfig, { command: "onboard", mode });
  await writeConfigFile(nextConfig);
  logConfigUpdated(runtime);

  await ensureWorkspaceAndSessions(workspaceDir, runtime, {
    skipBootstrap: Boolean(nextConfig.agents?.defaults?.skipBootstrap),
  });

  try {
    const { syncLocalSocketSignerFromConfig } = await import("../../wizard/onboarding.wallet.js");
    await syncLocalSocketSignerFromConfig({
      config: nextConfig,
      env: process.env,
      restart: true,
    });
  } catch (err) {
    runtime.error(
      `Wallet signer refresh failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    runtime.exit(1);
    return;
  }

  await installGatewayDaemonNonInteractive({
    nextConfig,
    opts,
    runtime,
    port: gatewayResult.port,
    gatewayToken: gatewayResult.gatewayToken,
  });

  const daemonRuntimeRaw = opts.daemonRuntime ?? DEFAULT_GATEWAY_DAEMON_RUNTIME;
  if (!opts.skipHealth) {
    const links = resolveControlUiLinks({
      bind: gatewayResult.bind as "auto" | "lan" | "loopback" | "custom" | "tailnet",
      port: gatewayResult.port,
      customBindHost: nextConfig.gateway?.customBindHost,
      basePath: undefined,
    });
    const fastHealth = Boolean(opts.fastHealth);
    const fastProbeTimeoutMs = 1_500;
    let fastHealthSatisfied = false;
    if (fastHealth) {
      let fastProbe = await waitForGatewayReachable({
        url: links.wsUrl,
        token: gatewayResult.gatewayToken,
        deadlineMs: 1_500,
        probeTimeoutMs: fastProbeTimeoutMs,
        pollMs: 200,
      });
      if (
        !fastProbe.ok &&
        String(fastProbe.detail ?? "")
          .toLowerCase()
          .includes("device token mismatch")
      ) {
        const cleared = clearDeviceAuthStore(process.env);
        runtime.log(
          cleared
            ? "Detected stale local device auth cache; cleared and retrying fast health probe once."
            : "Detected device token mismatch; cache already empty, retrying fast health probe once.",
        );
        fastProbe = await waitForGatewayReachable({
          url: links.wsUrl,
          token: gatewayResult.gatewayToken,
          deadlineMs: 1_500,
          probeTimeoutMs: fastProbeTimeoutMs,
          pollMs: 200,
        });
      }
      if (fastProbe.ok) {
        fastHealthSatisfied = true;
        runtime.log("Fast health mode: gateway already healthy; skipping extended health waits.");
      }
    }

    if (!fastHealthSatisfied) {
      await waitForGatewayReachable({
        url: links.wsUrl,
        token: gatewayResult.gatewayToken,
        deadlineMs: 15_000,
      });
      try {
        await healthCommand({ json: false, timeoutMs: 10_000 }, runtime);
      } catch (err) {
        let finalError = err;
        if (String(err).toLowerCase().includes("device token mismatch")) {
          const cleared = clearDeviceAuthStore(process.env);
          runtime.log(
            cleared
              ? "Detected stale local device auth cache; cleared and retrying health check once."
              : "Detected device token mismatch; cache already empty, retrying health check once.",
          );
          try {
            await healthCommand({ json: false, timeoutMs: 10_000 }, runtime);
            finalError = null;
          } catch (retryErr) {
            finalError = retryErr;
          }
        }
        if (finalError) {
          runtime.error(formatHealthCheckFailure(finalError));
          runtime.exit(1);
          return;
        }
      }
    }
  }

  logNonInteractiveOnboardingJson({
    opts,
    runtime,
    mode,
    workspaceDir,
    authChoice,
    gateway: {
      port: gatewayResult.port,
      bind: gatewayResult.bind,
      authMode: gatewayResult.authMode,
      tailscaleMode: gatewayResult.tailscaleMode,
    },
    installDaemon: Boolean(opts.installDaemon),
    daemonRuntime: opts.installDaemon ? daemonRuntimeRaw : undefined,
    skipSkills: Boolean(opts.skipSkills),
    skipHealth: Boolean(opts.skipHealth),
    fastHealth: Boolean(opts.fastHealth),
    wallet: {
      enabled: nextConfig.wallet?.runtime?.enabled ?? false,
      mode: nextConfig.wallet?.runtime?.mode ?? "managed",
      chains: nextConfig.wallet?.runtime?.chains ?? [],
      toolAccessMode: nextConfig.wallet?.runtime?.toolAccess?.mode ?? "owner-only",
      directSigning: nextConfig.wallet?.runtime?.policy?.directSigning ?? false,
    },
  });

  if (!opts.json) {
    if (!opts.installDaemon) {
      runtime.log(`Start runtime with: ${formatCliCommand("fased start")}`);
    }
    runtime.log(
      `Tip: run \`${formatCliCommand("fased configure --section web")}\` to select a web_search provider and store its API key. Docs: https://docs.fased.ai/tools/web`,
    );
  }
}
