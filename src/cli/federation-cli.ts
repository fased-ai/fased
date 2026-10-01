import type { Command } from "commander";
import {
  loadPersistedFederationToken,
  resolveFederationTokenPath,
} from "../federation/access-token.js";
import {
  DEFAULT_FEDERATION_BASE_URL,
  resolveAgentPublicOrigin,
  resolveFederationBaseUrl,
  resolveFederationHandle,
} from "../federation/runtime.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { readManagedFederationTokenSummary } from "../managed/federation.js";
import { defaultRuntime } from "../runtime.js";
import { theme } from "../terminal/theme.js";
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
}
