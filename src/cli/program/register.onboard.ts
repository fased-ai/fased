import type { Command } from "commander";
import { formatAuthChoiceChoicesForCli } from "../../commands/auth-choice-options.js";
import type { GatewayDaemonRuntime } from "../../commands/daemon-runtime.js";
import { resolveOnboardProviderAuthFlags } from "../../commands/onboard-provider-auth-flags.js";
import type {
  AuthChoice,
  GatewayAuthChoice,
  GatewayBind,
  NodeManagerChoice,
  TailscaleMode,
} from "../../commands/onboard-types.js";
import { onboardCommand } from "../../commands/onboard.js";
import { defaultRuntime } from "../../runtime.js";
import { formatDocsLink } from "../../terminal/links.js";
import { theme } from "../../terminal/theme.js";
import { runCommandWithRuntime } from "../cli-utils.js";

function resolveInstallDaemonFlag(
  command: unknown,
  opts: { installDaemon?: boolean },
): boolean | undefined {
  if (!command || typeof command !== "object") {
    return undefined;
  }
  const getOptionValueSource =
    "getOptionValueSource" in command ? command.getOptionValueSource : undefined;
  if (typeof getOptionValueSource !== "function") {
    return undefined;
  }

  // Commander doesn't support option conflicts natively; keep original behavior.
  // If --skip-daemon is explicitly passed, it wins.
  if (getOptionValueSource.call(command, "skipDaemon") === "cli") {
    return false;
  }
  if (getOptionValueSource.call(command, "installDaemon") === "cli") {
    return Boolean(opts.installDaemon);
  }
  return undefined;
}

function resolveOptionalBooleanFlag(
  command: unknown,
  optionName: string,
  value: boolean | undefined,
): boolean | undefined {
  if (!command || typeof command !== "object") {
    return undefined;
  }
  const getOptionValueSource =
    "getOptionValueSource" in command ? command.getOptionValueSource : undefined;
  if (typeof getOptionValueSource !== "function") {
    return undefined;
  }
  if (getOptionValueSource.call(command, optionName) === "cli") {
    return Boolean(value);
  }
  return undefined;
}

function resolveOptionalBooleanPairFlag(
  command: unknown,
  trueOption: string,
  falseOption: string,
  values: { whenTrue?: boolean; whenFalse?: boolean },
): boolean | undefined {
  const falseValue = resolveOptionalBooleanFlag(command, falseOption, values.whenFalse);
  if (falseValue !== undefined) {
    return false;
  }
  const trueValue = resolveOptionalBooleanFlag(command, trueOption, values.whenTrue);
  if (trueValue !== undefined) {
    return true;
  }
  return undefined;
}

function resolveProviderAuthFlagValues(opts: Record<string, unknown>) {
  const values: Record<string, unknown> = {};

  for (const providerFlag of resolveOnboardProviderAuthFlags()) {
    values[providerFlag.optionKey] = opts[providerFlag.optionKey];
  }

  return values;
}

const AUTH_CHOICE_HELP = formatAuthChoiceChoicesForCli({
  includeLegacyAliases: true,
  includeSkip: true,
});

export function registerOnboardCommand(program: Command) {
  const providerAuthFlags = resolveOnboardProviderAuthFlags();
  const command = program
    .command("onboard")
    .description("Interactive wizard to set up the gateway, workspace, and skills")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/onboard", "docs.fased.ai/cli/onboard")}\n`,
    )
    .option("--workspace <dir>", "Agent workspace directory (default: ~/.fased/workspace)")
    .option("--reset", "Repair auth/session state before running wizard")
    .option("--reset-scope <scope>", "Repair scope: sessions|auth|auth+sessions")
    .option("--non-interactive", "Run without prompts", false)
    .option(
      "--accept-risk",
      "Acknowledge that agents are powerful and full system access is risky (required for --non-interactive)",
      false,
    )
    .option("--flow <flow>", "Wizard flow: quickstart|advanced|manual")
    .option("--mode <mode>", "Wizard mode: local|remote")
    .option("--host-profile <profile>", "Host security profile: local|hosting")
    .option(
      "--host-security-capable",
      "Internal: host security was prepared by a root-started installer session",
    )
    .option(
      "--host-maintenance-session",
      "Internal: post-bootstrap hosted rerun from the app user over Tailscale",
    )
    .option("--ts-authkey <key>", "Tailscale auth key for hosting setup")
    .option("--allow-insecure", "Allow continuing when hosting security setup fails")
    .option("--swap-gb <n>", "Swap size in GB for hosting setup (default: 2)")
    .option("--auth-choice <choice>", `Auth: ${AUTH_CHOICE_HELP}`)
    .option(
      "--token-provider <id>",
      "Token provider id (non-interactive; used with --auth-choice token)",
    )
    .option("--token <token>", "Token value (non-interactive; used with --auth-choice token)")
    .option(
      "--token-profile-id <id>",
      "Auth profile id (non-interactive; default: <provider>:manual)",
    )
    .option("--token-expires-in <duration>", "Optional token expiry duration (e.g. 365d, 12h)")
    .option("--cloudflare-ai-gateway-account-id <id>", "Cloudflare Account ID")
    .option("--cloudflare-ai-gateway-gateway-id <id>", "Cloudflare AI Gateway ID");

  for (const providerFlag of providerAuthFlags) {
    command.option(providerFlag.cliOption, providerFlag.description);
  }

  command
    .option("--custom-base-url <url>", "Custom provider base URL")
    .option("--custom-api-key <key>", "Custom provider API key (optional)")
    .option("--custom-model-id <id>", "Custom provider model ID")
    .option("--custom-provider-id <id>", "Custom provider ID (optional; auto-derived by default)")
    .option(
      "--custom-compatibility <mode>",
      "Custom provider API compatibility: openai|anthropic (default: openai)",
    )
    .option(
      "--allow-private-network",
      "Allow a custom local/private model provider endpoint in non-interactive onboarding",
    )
    .option("--gateway-port <port>", "Gateway port")
    .option("--gateway-bind <mode>", "Gateway bind: loopback|tailnet|lan|auto|custom")
    .option("--gateway-auth <mode>", "Gateway auth: token|password")
    .option("--gateway-token <token>", "Gateway token (token auth)")
    .option("--gateway-password <password>", "Gateway password (password auth)")
    .option("--wallet-enabled", "Enable wallet integration")
    .option("--wallet-disabled", "Disable wallet integration")
    .option("--wallet-mode <mode>", "Wallet mode: managed|external")
    .option("--wallet-runtime <runtime>", "Wallet runtime: external-docker|external-custom")
    .option(
      "--wallet-providers <ids>",
      "Enabled wallet providers CSV (embedded-keystore,local-socket-signer,alchemy,turnkey,privy)",
    )
    .option(
      "--wallet-default-provider <id>",
      "Default wallet provider id (embedded-keystore|local-socket-signer|alchemy|turnkey|privy)",
    )
    .option("--wallet-chains <chains>", "Wallet chains CSV (solana)")
    .option("--wallet-host <host>", "External self-hosted signer host (advanced/deprecated)")
    .option("--wallet-port <port>", "External self-hosted signer port (advanced/deprecated)")
    .option("--wallet-install-enabled", "Enable wallet runtime auto-install")
    .option("--wallet-install-disabled", "Disable wallet runtime auto-install")
    .option("--wallet-install-version <version>", "Legacy self-host signer runtime version")
    .option("--wallet-direct-signing", "Enable automated wallet execution for approved Agent tools")
    .option(
      "--wallet-no-direct-signing",
      "Disable automated wallet execution for approved Agent tools",
    )
    .option("--wallet-solana-allow-programs <programs>", "CSV allowlist of Solana programs")
    .option("--wallet-solana-max-per-tx <amount>", "Solana per-transaction cap (lamports)")
    .option("--wallet-solana-max-daily <amount>", "Solana daily cap (lamports)")
    .option("--wallet-tool-access-mode <mode>", "Wallet tool access: owner-only|allowlist|all")
    .option("--wallet-tool-access-allow-agents <agents>", "CSV allowlist agent IDs for wallet tool")
    .option("--remote-url <url>", "Remote Gateway WebSocket URL")
    .option("--remote-token <token>", "Remote Gateway token (optional)")
    .option("--tailscale <mode>", "Tailscale: off|serve|funnel")
    .option("--tailscale-reset-on-exit", "Reset tailscale serve/funnel on exit")
    .option("--install-daemon", "Install gateway service")
    .option("--no-install-daemon", "Skip gateway service install")
    .option("--skip-daemon", "Skip gateway service install")
    .option("--daemon-runtime <runtime>", "Daemon runtime: node|bun")
    .option("--skip-channels", "Skip channel setup")
    .option("--skip-skills", "Skip skills setup")
    .option("--skip-health", "Skip health check")
    .option(
      "--fast-health",
      "Use fast health mode (skip long probe waits and non-critical startup gating)",
      true,
    )
    .option("--no-fast-health", "Disable fast health mode")
    .option("--skip-ui", "Skip Control UI/TUI prompts")
    .option("--node-manager <name>", "Node manager for skills: npm|pnpm|bun")
    .option("--json", "Output JSON summary", false);

  command.action(async (opts, commandRuntime) => {
    await runCommandWithRuntime(defaultRuntime, async () => {
      const installDaemon = resolveInstallDaemonFlag(commandRuntime, {
        installDaemon: Boolean(opts.installDaemon),
      });
      const walletEnabled = resolveOptionalBooleanPairFlag(
        commandRuntime,
        "walletEnabled",
        "walletDisabled",
        {
          whenTrue: Boolean(opts.walletEnabled),
          whenFalse: Boolean(opts.walletDisabled),
        },
      );
      const walletInstallEnabled = resolveOptionalBooleanPairFlag(
        commandRuntime,
        "walletInstallEnabled",
        "walletInstallDisabled",
        {
          whenTrue: Boolean(opts.walletInstallEnabled),
          whenFalse: Boolean(opts.walletInstallDisabled),
        },
      );
      const walletDirectSigning = resolveOptionalBooleanPairFlag(
        commandRuntime,
        "walletDirectSigning",
        "walletNoDirectSigning",
        {
          whenTrue: Boolean(opts.walletDirectSigning),
          whenFalse: Boolean(opts.walletNoDirectSigning),
        },
      );
      const gatewayPort =
        typeof opts.gatewayPort === "string" ? Number.parseInt(opts.gatewayPort, 10) : undefined;
      const walletPort =
        typeof opts.walletPort === "string" ? Number.parseInt(opts.walletPort, 10) : undefined;
      const swapGbRaw =
        typeof opts.swapGb === "string" ? Number.parseInt(opts.swapGb, 10) : undefined;
      await onboardCommand(
        {
          hostProfile: opts.hostProfile as "local" | "hosting" | undefined,
          hostSecurityCapable: Boolean(opts.hostSecurityCapable),
          hostMaintenanceSession: Boolean(opts.hostMaintenanceSession),
          tsAuthkey: opts.tsAuthkey as string | undefined,
          allowInsecure: Boolean(opts.allowInsecure),
          swapGb:
            typeof swapGbRaw === "number" && Number.isFinite(swapGbRaw) ? swapGbRaw : undefined,
          workspace: opts.workspace as string | undefined,
          nonInteractive: Boolean(opts.nonInteractive),
          acceptRisk: Boolean(opts.acceptRisk),
          flow: opts.flow as "quickstart" | "advanced" | "manual" | undefined,
          mode: opts.mode as "local" | "remote" | undefined,
          authChoice: opts.authChoice as AuthChoice | undefined,
          tokenProvider: opts.tokenProvider as string | undefined,
          token: opts.token as string | undefined,
          tokenProfileId: opts.tokenProfileId as string | undefined,
          tokenExpiresIn: opts.tokenExpiresIn as string | undefined,
          resetScope: opts.resetScope as "sessions" | "auth" | "auth+sessions" | undefined,
          ...resolveProviderAuthFlagValues(opts as Record<string, unknown>),
          anthropicApiKey: opts.anthropicApiKey as string | undefined,
          openaiApiKey: opts.openaiApiKey as string | undefined,
          openrouterApiKey: opts.openrouterApiKey as string | undefined,
          aiGatewayApiKey: opts.aiGatewayApiKey as string | undefined,
          cloudflareAiGatewayAccountId: opts.cloudflareAiGatewayAccountId as string | undefined,
          cloudflareAiGatewayGatewayId: opts.cloudflareAiGatewayGatewayId as string | undefined,
          cloudflareAiGatewayApiKey: opts.cloudflareAiGatewayApiKey as string | undefined,
          moonshotApiKey: opts.moonshotApiKey as string | undefined,
          kimiCodeApiKey: opts.kimiCodeApiKey as string | undefined,
          geminiApiKey: opts.geminiApiKey as string | undefined,
          zaiApiKey: opts.zaiApiKey as string | undefined,
          xiaomiApiKey: opts.xiaomiApiKey as string | undefined,
          qianfanApiKey: opts.qianfanApiKey as string | undefined,
          minimaxApiKey: opts.minimaxApiKey as string | undefined,
          syntheticApiKey: opts.syntheticApiKey as string | undefined,
          veniceApiKey: opts.veniceApiKey as string | undefined,
          togetherApiKey: opts.togetherApiKey as string | undefined,
          huggingfaceApiKey: opts.huggingfaceApiKey as string | undefined,
          opencodeZenApiKey: opts.opencodeZenApiKey as string | undefined,
          xaiApiKey: opts.xaiApiKey as string | undefined,
          litellmApiKey: opts.litellmApiKey as string | undefined,
          customBaseUrl: opts.customBaseUrl as string | undefined,
          customApiKey: opts.customApiKey as string | undefined,
          customModelId: opts.customModelId as string | undefined,
          customProviderId: opts.customProviderId as string | undefined,
          customCompatibility: opts.customCompatibility as "openai" | "anthropic" | undefined,
          allowPrivateNetwork: opts.allowPrivateNetwork === true,
          gatewayPort:
            typeof gatewayPort === "number" && Number.isFinite(gatewayPort)
              ? gatewayPort
              : undefined,
          gatewayBind: opts.gatewayBind as GatewayBind | undefined,
          gatewayAuth: opts.gatewayAuth as GatewayAuthChoice | undefined,
          gatewayToken: opts.gatewayToken as string | undefined,
          gatewayPassword: opts.gatewayPassword as string | undefined,
          walletEnabled,
          walletMode: opts.walletMode as "managed" | "external" | undefined,
          walletRuntime: opts.walletRuntime as "external-docker" | "external-custom" | undefined,
          walletProviders: opts.walletProviders as string | undefined,
          walletDefaultProvider: opts.walletDefaultProvider as
            | "alchemy"
            | "turnkey"
            | "privy"
            | undefined,
          walletChains: opts.walletChains as string | undefined,
          walletHost: opts.walletHost as string | undefined,
          walletPort:
            typeof walletPort === "number" && Number.isFinite(walletPort) ? walletPort : undefined,
          walletInstallEnabled,
          walletInstallVersion: opts.walletInstallVersion as string | undefined,
          walletDirectSigning,
          walletSolanaAllowPrograms: opts.walletSolanaAllowPrograms as string | undefined,
          walletSolanaMaxPerTx: opts.walletSolanaMaxPerTx as string | undefined,
          walletSolanaMaxDaily: opts.walletSolanaMaxDaily as string | undefined,
          walletToolAccessMode: opts.walletToolAccessMode as
            | "owner-only"
            | "allowlist"
            | "all"
            | undefined,
          walletToolAccessAllowAgents: opts.walletToolAccessAllowAgents as string | undefined,
          remoteUrl: opts.remoteUrl as string | undefined,
          remoteToken: opts.remoteToken as string | undefined,
          tailscale: opts.tailscale as TailscaleMode | undefined,
          tailscaleResetOnExit: Boolean(opts.tailscaleResetOnExit),
          reset: Boolean(opts.reset),
          installDaemon,
          daemonRuntime: opts.daemonRuntime as GatewayDaemonRuntime | undefined,
          skipChannels: Boolean(opts.skipChannels),
          skipSkills: Boolean(opts.skipSkills),
          skipHealth: Boolean(opts.skipHealth),
          fastHealth: opts.fastHealth as boolean | undefined,
          skipUi: Boolean(opts.skipUi),
          nodeManager: opts.nodeManager as NodeManagerChoice | undefined,
          json: Boolean(opts.json),
        },
        defaultRuntime,
      );
    });
  });
}
