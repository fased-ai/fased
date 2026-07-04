import {
  normalizeGatewayTokenInput,
  randomToken,
  validateGatewayPasswordInput,
} from "../commands/onboard-helpers.js";
import type { GatewayAuthChoice } from "../commands/onboard-types.js";
import type { GatewayBindMode, GatewayTailscaleMode, FasedAgentConfig } from "../config/config.js";
import { getTailscaleMissingBinNoteLines } from "../gateway/gateway-config-prompts.shared.js";
import { findTailscaleBinary } from "../infra/tailscale.js";
import type { RuntimeEnv } from "../runtime.js";
import { validateIPv4AddressInput } from "../shared/net/ipv4.js";
import type {
  GatewayWizardSettings,
  HostSetupProfile,
  QuickstartGatewayDefaults,
  WizardFlow,
} from "./onboarding.types.js";
import type { WizardPrompter } from "./prompts.js";

async function promptSecretOrText(
  prompter: WizardPrompter,
  params: Parameters<WizardPrompter["text"]>[0],
): Promise<string> {
  if (typeof prompter.secret === "function") {
    return await prompter.secret(params);
  }
  return await prompter.text(params);
}

// These commands are "high risk" (privacy writes/recording) and should be
// explicitly armed by the user when they want to use them.
//
// This only affects what the gateway will accept via node.invoke; the iOS app
// still prompts for OS permissions (camera/photos/contacts/etc) on first use.
const DEFAULT_DANGEROUS_NODE_DENY_COMMANDS = [
  "camera.snap",
  "camera.clip",
  "screen.record",
  "calendar.add",
  "contacts.add",
  "reminders.add",
];

const HOSTED_TAILSCALE_TRUSTED_PROXIES = ["127.0.0.1/32", "::1/128"];

type ConfigureGatewayOptions = {
  flow: WizardFlow;
  hostProfile: HostSetupProfile;
  baseConfig: FasedAgentConfig;
  nextConfig: FasedAgentConfig;
  localPort: number;
  quickstartGateway: QuickstartGatewayDefaults;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
};

type ConfigureGatewayResult = {
  nextConfig: FasedAgentConfig;
  settings: GatewayWizardSettings;
};

function resolveWizardBindInitialValue(
  value: QuickstartGatewayDefaults["bind"],
): Extract<GatewayWizardSettings["bind"], "loopback" | "lan" | "custom"> {
  if (value === "lan" || value === "custom") {
    return value;
  }
  return "loopback";
}

export async function configureGatewayForOnboarding(
  opts: ConfigureGatewayOptions,
): Promise<ConfigureGatewayResult> {
  const { hostProfile, localPort, quickstartGateway, prompter } = opts;
  let { nextConfig } = opts;
  const strictHosting = hostProfile === "hosting";
  const localProfile = hostProfile === "local";

  const port =
    strictHosting || localProfile
      ? quickstartGateway.port || localPort
      : Number.parseInt(
          String(
            await prompter.text({
              message: "Gateway port",
              initialValue: String(quickstartGateway.port || localPort),
              validate: (value) => (Number.isFinite(Number(value)) ? undefined : "Invalid port"),
            }),
          ),
          10,
        );

  let bind: GatewayWizardSettings["bind"];
  if (strictHosting) {
    bind = "loopback";
  } else {
    bind = await prompter.select<GatewayWizardSettings["bind"]>({
      message: "Gateway bind",
      options: [
        {
          value: "loopback",
          label: "Loopback (127.0.0.1)",
        },
        { value: "lan", label: "LAN (0.0.0.0)" },
        { value: "custom", label: "Custom IP" },
      ],
      initialValue: resolveWizardBindInitialValue(quickstartGateway.bind),
    });
  }

  let customBindHost = quickstartGateway.customBindHost;
  if (bind === "custom") {
    const input = await prompter.text({
      message: "Custom IP address",
      placeholder: "192.168.1.100",
      initialValue: customBindHost ?? "",
      validate: validateIPv4AddressInput,
    });
    customBindHost = typeof input === "string" ? input.trim() : undefined;
  }

  let authMode: GatewayAuthChoice;
  if (strictHosting) {
    authMode = "token";
  } else {
    authMode = (await prompter.select({
      message: "Gateway auth",
      options: [
        {
          value: "token",
          label: "Token",
        },
        { value: "password", label: "Password" },
      ],
      initialValue: quickstartGateway.authMode,
    })) as GatewayAuthChoice;
  }

  let gatewayToken: string | undefined;
  if (authMode === "token") {
    const existingToken = normalizeGatewayTokenInput(quickstartGateway.token ?? "");
    if (strictHosting) {
      gatewayToken = existingToken || randomToken();
    } else {
      const tokenInput = await promptSecretOrText(prompter, {
        message: existingToken
          ? "Gateway token (blank to keep current)"
          : "Gateway token (blank to generate)",
        placeholder: existingToken
          ? "Press Enter to keep the current token"
          : "Needed for multi-machine or non-loopback access",
        initialValue: quickstartGateway.token ?? "",
      });
      gatewayToken = normalizeGatewayTokenInput(tokenInput) || existingToken || randomToken();
    }
  }

  const tailscaleMode: GatewayWizardSettings["tailscaleMode"] = strictHosting
    ? "serve"
    : localProfile
      ? quickstartGateway.tailscaleMode
      : await prompter.select<GatewayWizardSettings["tailscaleMode"]>({
          message: "Tailscale exposure",
          options: localProfile
            ? [
                { value: "off", label: "Off", hint: "No Tailscale exposure" },
                {
                  value: "serve",
                  label: "Serve",
                  hint: "Private HTTPS for your tailnet (devices on Tailscale)",
                },
              ]
            : [
                { value: "off", label: "Off", hint: "No Tailscale exposure" },
                {
                  value: "serve",
                  label: "Serve",
                  hint: "Private HTTPS for your tailnet (devices on Tailscale)",
                },
                {
                  value: "funnel",
                  label: "Funnel",
                  hint: "Public HTTPS via Tailscale Funnel (internet)",
                },
              ],
          initialValue: quickstartGateway.tailscaleMode,
        });

  // Hosting installs/authenticates Tailscale later during host hardening.
  // Keep the early gateway-config stage quiet there and let the real setup stage
  // own Tailscale messaging.
  if (!strictHosting && tailscaleMode !== "off") {
    const tailscaleBin = await findTailscaleBinary();
    if (!tailscaleBin) {
      const message = getTailscaleMissingBinNoteLines().join("\n");
      await prompter.note(message, "Tailscale Warning");
    }
  }

  let tailscaleResetOnExit = strictHosting ? false : quickstartGateway.tailscaleResetOnExit;
  if (tailscaleMode !== "off" && !strictHosting) {
    await prompter.note(
      ["Docs:", "https://docs.fased.ai/gateway/tailscale", "https://docs.fased.ai/web"].join("\n"),
      "Tailscale",
    );
    tailscaleResetOnExit = Boolean(
      await prompter.confirm({
        message: "Reset Tailscale serve/funnel on exit?",
        initialValue: false,
      }),
    );
  }

  // Safety + constraints:
  // - Tailscale wants bind=loopback so we never expose a non-loopback server + tailscale serve/funnel at once.
  // - Funnel requires password auth.
  if (tailscaleMode !== "off" && bind !== "loopback") {
    await prompter.note("Tailscale requires bind=loopback. Adjusting bind to loopback.", "Note");
    bind = "loopback";
    customBindHost = undefined;
  }

  if (tailscaleMode === "funnel" && authMode !== "password") {
    await prompter.note("Tailscale funnel requires password auth.", "Note");
    authMode = "password";
  }

  if (authMode === "password") {
    const password =
      (quickstartGateway.password ?? "").trim() ||
      (await promptSecretOrText(prompter, {
        message: "Gateway password",
        validate: validateGatewayPasswordInput,
      }));
    nextConfig = {
      ...nextConfig,
      gateway: {
        ...nextConfig.gateway,
        auth: {
          ...nextConfig.gateway?.auth,
          mode: "password",
          password: String(password ?? "").trim(),
        },
      },
    };
  } else if (authMode === "token") {
    nextConfig = {
      ...nextConfig,
      gateway: {
        ...nextConfig.gateway,
        auth: {
          ...nextConfig.gateway?.auth,
          mode: "token",
          token: gatewayToken,
        },
      },
    };
  }

  nextConfig = {
    ...nextConfig,
    gateway: {
      ...nextConfig.gateway,
      mode: "local",
      port,
      bind: bind as GatewayBindMode,
      trustedProxies:
        strictHosting && tailscaleMode === "serve"
          ? Array.from(
              new Set([
                ...(nextConfig.gateway?.trustedProxies ?? []),
                ...HOSTED_TAILSCALE_TRUSTED_PROXIES,
              ]),
            )
          : nextConfig.gateway?.trustedProxies,
      controlUi:
        strictHosting && tailscaleMode === "serve"
          ? {
              ...nextConfig.gateway?.controlUi,
              allowInsecureAuth: true,
            }
          : nextConfig.gateway?.controlUi,
      ...(bind === "custom" && customBindHost ? { customBindHost } : {}),
      tailscale: {
        ...nextConfig.gateway?.tailscale,
        mode: tailscaleMode as GatewayTailscaleMode,
        resetOnExit: tailscaleResetOnExit,
      },
    },
  };

  // If this is a new gateway setup (no existing gateway settings), start with a
  // denylist for high-risk node commands. Users can arm these temporarily via
  // /phone arm ... (phone-control plugin).
  if (
    !quickstartGateway.hasExisting &&
    nextConfig.gateway?.nodes?.denyCommands === undefined &&
    nextConfig.gateway?.nodes?.allowCommands === undefined &&
    nextConfig.gateway?.nodes?.browser === undefined
  ) {
    const denyCommands = [...DEFAULT_DANGEROUS_NODE_DENY_COMMANDS];

    nextConfig = {
      ...nextConfig,
      gateway: {
        ...nextConfig.gateway,
        nodes: {
          ...nextConfig.gateway?.nodes,
          denyCommands,
        },
      },
    };
  }

  return {
    nextConfig,
    settings: {
      port,
      bind: bind as GatewayBindMode,
      customBindHost: bind === "custom" ? customBindHost : undefined,
      authMode,
      gatewayToken,
      tailscaleMode: tailscaleMode as GatewayTailscaleMode,
      tailscaleResetOnExit,
    },
  };
}
