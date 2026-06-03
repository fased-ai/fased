import type { Command } from "commander";
import {
  loadConfig,
  readConfigFileSnapshotForWrite,
  validateConfigObjectWithPlugins,
  writeConfigFile,
} from "../config/config.js";
import {
  loadPersistedFederationToken,
  resolveFederationTokenPath,
} from "../federation/access-token.js";
import {
  DEFAULT_FEDERATION_BASE_URL,
  resolveAgentPublicOrigin,
  resolveFederationBaseUrl,
  resolveFederationBondWalletId,
  resolveFederationHandle,
} from "../federation/runtime.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { readManagedFederationTokenSummary } from "../managed/federation.js";
import { defaultRuntime } from "../runtime.js";
import { theme } from "../terminal/theme.js";
import { resolveFederationBondWallet } from "../wallet/solana-bond-signing.js";
import {
  readWalletProviderRegistry,
  resolveWalletUserRole,
} from "../wallet/wallet-provider-registry.js";
import { runCommandWithRuntime } from "./cli-utils.js";
import { formatCliCommand } from "./command-format.js";
import { formatHelpExamples } from "./help-format.js";

type FederationCliOptions = {
  json?: boolean;
};

type FederationStatusPayload = {
  configured: boolean;
  autoConnectEnabled: boolean;
  baseUrl: string;
  defaultBaseUrl: string;
  handle: string;
  publicOrigin: string;
  tokenPath: string;
  tokenPresent: boolean;
  tokenId?: string;
  expiresAt?: string;
  scopes?: string[];
  trustState?: string;
  hostedState?: string;
  agentSlug?: string;
  publicUrl?: string;
  lastAttestOrRenewAt?: string;
  managedToken: ReturnType<typeof readManagedFederationTokenSummary>;
};

function runFederationCommand(action: () => Promise<void>, label?: string) {
  return runCommandWithRuntime(defaultRuntime, action, (err) => {
    const message = err instanceof Error ? err.message : String(err);
    defaultRuntime.error(label ? `${label}: ${message}` : message);
    defaultRuntime.exit(1);
  });
}

async function buildFederationStatus(): Promise<FederationStatusPayload> {
  const token = await loadPersistedFederationToken(process.env);
  const managedToken = readManagedFederationTokenSummary(process.env);
  const autoConnectEnabled = isTruthyEnvValue(process.env.FASED_FEDERATION_AUTO_CONNECT);
  const configured =
    autoConnectEnabled ||
    Boolean(process.env.FASED_FEDERATION_BASE_URL?.trim()) ||
    Boolean(process.env.FASED_A2A_HANDLE?.trim()) ||
    Boolean(process.env.FASED_FEDERATION_HANDLE?.trim()) ||
    Boolean(token);
  return {
    configured,
    autoConnectEnabled,
    baseUrl: resolveFederationBaseUrl(process.env),
    defaultBaseUrl: DEFAULT_FEDERATION_BASE_URL,
    handle: resolveFederationHandle({ env: process.env }),
    publicOrigin: resolveAgentPublicOrigin(process.env),
    tokenPath: resolveFederationTokenPath(process.env),
    tokenPresent: Boolean(token),
    tokenId: token?.tokenId,
    expiresAt: token?.expiresAt,
    scopes: token?.scopes,
    trustState: token?.trustState,
    hostedState: token?.hostedState,
    agentSlug: token?.agentSlug,
    publicUrl: token?.publicUrl ?? managedToken.publicUrl,
    lastAttestOrRenewAt: token?.lastAttestOrRenewAt,
    managedToken,
  };
}

function renderFederationStatus(payload: FederationStatusPayload): void {
  defaultRuntime.log(theme.heading("Federation"));
  defaultRuntime.log(`${theme.muted("Configured:")} ${payload.configured ? "yes" : "no"}`);
  defaultRuntime.log(
    `${theme.muted("Auto-connect:")} ${payload.autoConnectEnabled ? "enabled" : "disabled"}`,
  );
  defaultRuntime.log(`${theme.muted("Base URL:")} ${payload.baseUrl || payload.defaultBaseUrl}`);
  defaultRuntime.log(`${theme.muted("Handle:")} ${payload.handle}`);
  defaultRuntime.log(`${theme.muted("Public origin:")} ${payload.publicOrigin}`);
  defaultRuntime.log(`${theme.muted("Token path:")} ${payload.tokenPath}`);
  defaultRuntime.log(`${theme.muted("Token:")} ${payload.tokenPresent ? "present" : "missing"}`);
  if (payload.trustState) {
    defaultRuntime.log(`${theme.muted("Trust state:")} ${payload.trustState}`);
  }
  if (payload.hostedState) {
    defaultRuntime.log(`${theme.muted("Hosted state:")} ${payload.hostedState}`);
  }
  if (payload.publicUrl) {
    defaultRuntime.log(`${theme.muted("Public URL:")} ${payload.publicUrl}`);
  }
  if (payload.expiresAt) {
    defaultRuntime.log(`${theme.muted("Expires:")} ${payload.expiresAt}`);
  }
  const cfg = loadConfig();
  const bondWalletId = resolveFederationBondWalletId({ env: process.env, cfg });
  if (bondWalletId) {
    defaultRuntime.log(`${theme.muted("Bond Vault:")} ${bondWalletId}`);
  }
}

async function updateFederationBondWalletConfig(
  walletId: string | null,
): Promise<{ walletId: string | null }> {
  const writeSnapshot = await readConfigFileSnapshotForWrite();
  const baseConfig = structuredClone(writeSnapshot.snapshot.resolved ?? {});
  if (walletId) {
    baseConfig.federation = baseConfig.federation ?? {};
    baseConfig.federation.bond = baseConfig.federation.bond ?? {};
    baseConfig.federation.bond.walletId = walletId;
  } else if (baseConfig.federation?.bond) {
    delete baseConfig.federation.bond.walletId;
    if (Object.keys(baseConfig.federation.bond).length === 0) {
      delete baseConfig.federation.bond;
    }
    if (baseConfig.federation && Object.keys(baseConfig.federation).length === 0) {
      delete baseConfig.federation;
    }
  }
  const validated = validateConfigObjectWithPlugins(baseConfig);
  if (!validated.ok) {
    const detail = validated.issues
      .slice(0, 3)
      .map((issue) => `${issue.path || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new Error(detail || "invalid federation bond config");
  }
  await writeConfigFile(validated.config, writeSnapshot.writeOptions);
  return { walletId };
}

export function registerFederationCli(program: Command) {
  const federation = program
    .command("federation")
    .description("Inspect federation runtime, token, and hosted routing state")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          [formatCliCommand("fased federation status"), "Show live federation runtime state."],
          [
            formatCliCommand("fased federation token --json"),
            "Inspect the persisted federation token summary.",
          ],
          [
            formatCliCommand("fased federation paths"),
            "Show where federation state is stored on disk.",
          ],
        ])}\n`,
    );

  federation
    .command("status")
    .description("Show federation runtime, handle, and hosted state")
    .option("--json", "Output JSON", false)
    .action(async (opts: FederationCliOptions) => {
      await runFederationCommand(async () => {
        const payload = await buildFederationStatus();
        if (opts.json) {
          defaultRuntime.log(JSON.stringify(payload, null, 2));
          return;
        }
        renderFederationStatus(payload);
      }, "Federation status failed");
    });

  federation
    .command("token")
    .description("Show the persisted federation token summary")
    .option("--json", "Output JSON", false)
    .action(async (opts: FederationCliOptions) => {
      await runFederationCommand(async () => {
        const token = await loadPersistedFederationToken(process.env);
        const managed = readManagedFederationTokenSummary(process.env);
        const payload = {
          path: resolveFederationTokenPath(process.env),
          token,
          managed,
        };
        if (opts.json) {
          defaultRuntime.log(JSON.stringify(payload, null, 2));
          return;
        }
        if (!token) {
          defaultRuntime.log("No federation token is persisted.");
          defaultRuntime.log(`${theme.muted("Path:")} ${payload.path}`);
          return;
        }
        defaultRuntime.log(theme.heading("Federation Token"));
        defaultRuntime.log(`${theme.muted("Token ID:")} ${token.tokenId}`);
        defaultRuntime.log(`${theme.muted("Handle:")} ${token.handle}`);
        defaultRuntime.log(`${theme.muted("Issued:")} ${token.issuedAt}`);
        defaultRuntime.log(`${theme.muted("Expires:")} ${token.expiresAt}`);
        defaultRuntime.log(`${theme.muted("Trust state:")} ${token.trustState ?? "pending"}`);
        defaultRuntime.log(`${theme.muted("Hosted state:")} ${token.hostedState ?? "disabled"}`);
        defaultRuntime.log(
          `${theme.muted("Scopes:")} ${(token.scopes ?? []).join(", ") || "none"}`,
        );
        defaultRuntime.log(`${theme.muted("Path:")} ${payload.path}`);
        if (managed.publicUrl) {
          defaultRuntime.log(`${theme.muted("Public URL:")} ${managed.publicUrl}`);
        }
      }, "Federation token inspection failed");
    });

  federation
    .command("paths")
    .description("Show federation state file locations")
    .option("--json", "Output JSON", false)
    .action(async (opts: FederationCliOptions) => {
      await runFederationCommand(async () => {
        const managed = readManagedFederationTokenSummary(process.env);
        const payload = {
          tokenPath: resolveFederationTokenPath(process.env),
          managedTokenPath: managed.path,
        };
        if (opts.json) {
          defaultRuntime.log(JSON.stringify(payload, null, 2));
          return;
        }
        defaultRuntime.log(theme.heading("Federation Paths"));
        defaultRuntime.log(`${theme.muted("Token path:")} ${payload.tokenPath}`);
        defaultRuntime.log(`${theme.muted("Managed token path:")} ${payload.managedTokenPath}`);
      }, "Federation paths failed");
    });

  const bondWallet = federation
    .command("bond-wallet")
    .description("Inspect or set the Vault wallet assigned to federation bond");

  bondWallet
    .command("status")
    .description("Show the currently configured federation bond Vault")
    .option("--json", "Output JSON", false)
    .action(async (opts: FederationCliOptions) => {
      await runFederationCommand(async () => {
        const cfg = loadConfig();
        const walletId = resolveFederationBondWalletId({ env: process.env, cfg }) || null;
        const registry = readWalletProviderRegistry(process.env);
        const wallet = walletId
          ? registry.wallets.find((entry) => entry.id === walletId)
          : undefined;
        let walletAddress: string | undefined;
        if (walletId) {
          try {
            walletAddress = (await resolveFederationBondWallet({ env: process.env, cfg, walletId }))
              .walletAddress;
          } catch {
            walletAddress = wallet?.addresses?.solana;
          }
        }
        const payload = {
          walletId,
          walletName: wallet?.name,
          walletAddress: walletAddress ?? wallet?.addresses?.solana,
        };
        if (opts.json) {
          defaultRuntime.log(JSON.stringify(payload, null, 2));
          return;
        }
        defaultRuntime.log(theme.heading("Federation Bond Vault"));
        defaultRuntime.log(`${theme.muted("Wallet ID:")} ${payload.walletId ?? "not set"}`);
        if (payload.walletName) {
          defaultRuntime.log(`${theme.muted("Wallet name:")} ${payload.walletName}`);
        }
        if (payload.walletAddress) {
          defaultRuntime.log(`${theme.muted("Wallet address:")} ${payload.walletAddress}`);
        }
      }, "Federation bond Vault status failed");
    });

  bondWallet
    .command("set")
    .description("Set the Vault wallet assigned to federation bond")
    .argument("<walletId>", "Wallet id from the local wallet registry")
    .action(async (walletId: string) => {
      await runFederationCommand(async () => {
        const normalized = walletId.trim();
        if (!normalized) {
          throw new Error("walletId is required");
        }
        const registry = readWalletProviderRegistry(process.env);
        const wallet = registry.wallets.find((entry) => entry.id === normalized);
        if (!wallet) {
          throw new Error(`walletId not found: ${normalized}`);
        }
        const purpose = resolveWalletUserRole(wallet);
        if (normalized === registry.defaultWalletId || purpose === "agent") {
          throw new Error("Federation bond requires a Vault wallet, not an Agent wallet.");
        }
        if (purpose === "mining") {
          throw new Error("Federation bond requires a Vault wallet, not the Mining wallet.");
        }
        if (purpose !== "vault") {
          throw new Error("Federation bond requires a Vault wallet.");
        }
        if (!wallet.addresses?.solana?.trim()) {
          throw new Error("Federation bond requires a Vault wallet with a Solana address.");
        }
        await updateFederationBondWalletConfig(normalized);
        defaultRuntime.log(`Federation bond Vault set to ${normalized}`);
      }, "Federation bond Vault update failed");
    });

  bondWallet
    .command("clear")
    .description("Clear the configured federation bond Vault")
    .action(async () => {
      await runFederationCommand(async () => {
        await updateFederationBondWalletConfig(null);
        defaultRuntime.log("Federation bond Vault cleared");
      }, "Federation bond Vault clear failed");
    });
}
