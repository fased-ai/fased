import type { Command } from "commander";
import {
  walletCanaryCommand,
  walletInboundListCommand,
  walletInboundPollCommand,
  walletInboundReconcileCommand,
  walletLegacyMigrationFinalizeCommand,
  walletLimitOrdersConfigureCommand,
  walletMigrateCommand,
  walletPolicyProfileApplyCommand,
  walletProviderConfigureCommand,
  walletRotateKeysCommand,
  walletRoleSetCommand,
  walletSetupCommand,
  walletSignerServeCommand,
  walletSignerDoctorCommand,
  walletStatusCommand,
} from "../../commands/wallet.js";
import { defaultRuntime } from "../../runtime.js";
import { runCommandWithRuntime } from "../cli-utils.js";

function resolvePublicWalletSetupChain(raw: unknown): "solana" | undefined {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!value) {
    return undefined;
  }
  if (value === "solana") {
    return "solana";
  }
  throw new Error("Wallet setup is Solana-only. Use --chain solana.");
}

export function registerWalletCommands(program: Command) {
  const wallet = program
    .command("wallet")
    .description("Wallet providers, native signer, and policy status")
    .action(() => {
      wallet.help({ error: true });
    });

  wallet
    .command("setup")
    .description("Guided Solana wallet setup (create/import local signer wallet)")
    .option("--mode <mode>", "local-signer-create|local-signer-import|local-signer|turnkey|alchemy")
    .option("--chain <chain>", "solana", "solana")
    .option("--wallet-id <id>", "Named wallet id (examples: agent, mining, vault)")
    .option("--wallet-name <value>", "Friendly wallet display name (for UI/skills/plugins)")
    .option("--role <role>", "agent|vault. SAT mining is attached separately.")
    .option("--api-key <value>", "Alchemy API key")
    .option("--rpc-url <url>", "Solana RPC URL")
    .option("--turnkey-api-public-key <value>", "Turnkey API public key (turnkey mode)")
    .option("--turnkey-api-private-key <value>", "Turnkey API private key (turnkey mode)")
    .option("--turnkey-organization-id <value>", "Turnkey organization ID (turnkey mode)")
    .option("--turnkey-policy-id <value>", "Turnkey policy ID (turnkey mode)")
    .option("--turnkey-base-url <value>", "Turnkey base URL override (turnkey mode)")
    .option(
      "--enable-limit-orders",
      "Store Jupiter API key config for policy-gated wallet actions",
      false,
    )
    .option("--disable-limit-orders", "Remove stored Jupiter wallet-action config", false)
    .option("--jupiter-api-key <value>", "Jupiter API key for policy-gated wallet actions")
    .option(
      "--jupiter-trigger-api-base-url <url>",
      "Advanced: Jupiter Trigger API base URL override",
    )
    .option("--non-interactive", "Do not prompt; require mode/inputs", false)
    .option("--no-doctor", "Skip signer doctor in local-signer mode", false)
    .option("--json", "Print JSON output", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await walletSetupCommand(defaultRuntime, {
          mode: typeof opts.mode === "string" ? opts.mode : undefined,
          chain: resolvePublicWalletSetupChain(opts.chain),
          walletId: typeof opts.walletId === "string" ? opts.walletId : undefined,
          walletName: typeof opts.walletName === "string" ? opts.walletName : undefined,
          role: typeof opts.role === "string" ? opts.role : undefined,
          apiKey: typeof opts.apiKey === "string" ? opts.apiKey : undefined,
          rpcUrl: typeof opts.rpcUrl === "string" ? opts.rpcUrl : undefined,
          turnkeyApiPublicKey:
            typeof opts.turnkeyApiPublicKey === "string" ? opts.turnkeyApiPublicKey : undefined,
          turnkeyApiPrivateKey:
            typeof opts.turnkeyApiPrivateKey === "string" ? opts.turnkeyApiPrivateKey : undefined,
          turnkeyOrganizationId:
            typeof opts.turnkeyOrganizationId === "string" ? opts.turnkeyOrganizationId : undefined,
          turnkeyPolicyId:
            typeof opts.turnkeyPolicyId === "string" ? opts.turnkeyPolicyId : undefined,
          turnkeyBaseUrl: typeof opts.turnkeyBaseUrl === "string" ? opts.turnkeyBaseUrl : undefined,
          enableLimitOrders: Boolean(opts.enableLimitOrders),
          disableLimitOrders: Boolean(opts.disableLimitOrders),
          jupiterApiKey: typeof opts.jupiterApiKey === "string" ? opts.jupiterApiKey : undefined,
          jupiterTriggerApiBaseUrl:
            typeof opts.jupiterTriggerApiBaseUrl === "string"
              ? opts.jupiterTriggerApiBaseUrl
              : undefined,
          nonInteractive: Boolean(opts.nonInteractive),
          noDoctor: Boolean(opts.noDoctor),
          json: Boolean(opts.json),
        });
      });
    });

  wallet
    .command("limit-orders")
    .description("Configure Jupiter Trigger support for policy-gated Agent wallet actions")
    .option("--enable", "Enable Jupiter wallet-action support and store API key config", false)
    .option("--disable", "Remove stored Jupiter wallet-action config", false)
    .option("--jupiter-api-key <value>", "Jupiter API key for policy-gated wallet actions")
    .option(
      "--jupiter-trigger-api-base-url <url>",
      "Advanced: Jupiter Trigger API base URL override",
    )
    .option("--non-interactive", "Do not prompt; require explicit inputs", false)
    .option("--json", "Print JSON output", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await walletLimitOrdersConfigureCommand(defaultRuntime, {
          enable: Boolean(opts.enable),
          disable: Boolean(opts.disable),
          jupiterApiKey: typeof opts.jupiterApiKey === "string" ? opts.jupiterApiKey : undefined,
          jupiterTriggerApiBaseUrl:
            typeof opts.jupiterTriggerApiBaseUrl === "string"
              ? opts.jupiterTriggerApiBaseUrl
              : undefined,
          nonInteractive: Boolean(opts.nonInteractive),
          json: Boolean(opts.json),
        });
      });
    });

  wallet
    .command("status")
    .description("Show wallet service and policy status")
    .option("--json", "Print JSON output", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await walletStatusCommand(defaultRuntime, {
          json: Boolean(opts.json),
        });
      });
    });

  wallet
    .command("rotate-keys")
    .description("Removed Gateway key rotation; prints native/provider authority guidance")
    .option("--json", "Print JSON output", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await walletRotateKeysCommand(defaultRuntime, {
          json: Boolean(opts.json),
        });
      });
    });

  wallet
    .command("finalize-legacy-migration")
    .description(
      "Verify a completed native signer import and retire legacy config/registry references",
    )
    .requiredOption("--wallet-id <id>", "Legacy wallet id imported into fased-signerd")
    .option("--wallet-name <name>", "Name when the legacy registry row is missing")
    .option("--json", "Print JSON output", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await walletLegacyMigrationFinalizeCommand(defaultRuntime, {
          walletId: String(opts.walletId),
          walletName: typeof opts.walletName === "string" ? opts.walletName : undefined,
          json: Boolean(opts.json),
        });
      });
    });

  wallet
    .command("role set <wallet-id> <role>")
    .description(
      "Set primary Agent fallback or initialize a missing Agent/Vault purpose. Existing purpose stays permanent.",
    )
    .option("--primary", "Make this Agent wallet the primary fallback", false)
    .option("--json", "Print JSON output", false)
    .action(async (walletId, role, opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await walletRoleSetCommand(defaultRuntime, {
          walletId: String(walletId),
          role: String(role),
          primary: Boolean(opts.primary),
          json: Boolean(opts.json),
        });
      });
    });

  const provider = wallet
    .command("provider")
    .description("Configure hosted wallet provider credentials (stored encrypted locally)");

  provider
    .command("configure <providerId>")
    .description("Configure hosted provider credentials and set wallet.provider.id")
    .option(
      "--set <key=value>",
      "Credential field (repeatable)",
      (v, acc: string[]) => [...acc, v],
      [],
    )
    .option("--rpc-url <url>", "Optional RPC URL hint to store with provider credentials")
    .option("--json", "Print JSON output", false)
    .action(async (providerArg, opts) => {
      const providerId =
        providerArg === "turnkey" || providerArg === "alchemy" ? providerArg : null;
      if (!providerId) {
        throw new Error("provider must be one of: turnkey, alchemy; Privy is unavailable");
      }
      await runCommandWithRuntime(defaultRuntime, async () => {
        await walletProviderConfigureCommand(defaultRuntime, {
          providerId,
          json: Boolean(opts.json),
          rpcUrl: typeof opts.rpcUrl === "string" ? opts.rpcUrl : undefined,
          values: Array.isArray(opts.set) ? opts.set.map(String) : [],
        });
      });
    });

  const policy = wallet.command("policy").description("Wallet policy presets and controls");

  policy
    .command("profile <name>")
    .description("Apply wallet policy profile (autonomous-strict|autonomous-moderate|manual-owner)")
    .option(
      "--allow-skill <id>",
      "Allow skill id (repeatable)",
      (v, acc: string[]) => [...acc, v],
      [],
    )
    .option(
      "--allow-source <id>",
      "Allow source id (repeatable)",
      (v, acc: string[]) => [...acc, v],
      [],
    )
    .option("--json", "Print JSON output", false)
    .action(async (name, opts) => {
      if (
        name !== "autonomous-strict" &&
        name !== "autonomous-moderate" &&
        name !== "manual-owner"
      ) {
        throw new Error(
          "profile must be one of: autonomous-strict, autonomous-moderate, manual-owner",
        );
      }
      await runCommandWithRuntime(defaultRuntime, async () => {
        await walletPolicyProfileApplyCommand(defaultRuntime, {
          profile: name,
          allowSkills: Array.isArray(opts.allowSkill) ? opts.allowSkill.map(String) : [],
          allowSources: Array.isArray(opts.allowSource) ? opts.allowSource.map(String) : [],
          json: Boolean(opts.json),
        });
      });
    });

  const signer = wallet.command("signer").description("Local signer daemon utilities");

  signer
    .command("serve")
    .description("Removed legacy Node signer entrypoint (use native fased-signerd)")
    .option("--socket <path>", "Unix socket path")
    .option("--read-only", "Read-only mode", false)
    .option("--pid-file <path>", "PID file path")
    .option("--audit-log <path>", "Audit log path")
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await walletSignerServeCommand(defaultRuntime, {
          socketPath: typeof opts.socket === "string" ? opts.socket : undefined,
          readOnly: Boolean(opts.readOnly),
          pidFile: typeof opts.pidFile === "string" ? opts.pidFile : undefined,
          auditLog: typeof opts.auditLog === "string" ? opts.auditLog : undefined,
        });
      });
    });

  signer
    .command("doctor")
    .description("Validate native/local signer socket, pid, audit log, rpc, and keystore readiness")
    .option("--socket <path>", "Unix socket path")
    .option("--json", "Print JSON output", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await walletSignerDoctorCommand(defaultRuntime, {
          socketPath: typeof opts.socket === "string" ? opts.socket : undefined,
          json: Boolean(opts.json),
        });
      });
    });

  wallet
    .command("migrate")
    .description("Migrate wallet runtime source")
    .requiredOption("--from <runtime>", "Current runtime: external-docker|external-custom")
    .requiredOption("--to <runtime>", "Target runtime: external-docker|external-custom")
    .option("--json", "Print JSON output", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await walletMigrateCommand(defaultRuntime, {
          from: String(opts.from),
          to: String(opts.to),
          json: Boolean(opts.json),
        });
      });
    });

  wallet
    .command("canary")
    .description("Run real-chain canary checks (and optional recovery drill)")
    .option("--json", "Print JSON output", false)
    .option("--no-require-real-chain", "Allow non-real-chain readiness failures in checks")
    .option(
      "--execute-provider-e2e",
      "Run provider-level E2E checks (create/address/balance/reject/audit; send when enabled)",
      false,
    )
    .option(
      "--execute-live-send",
      "Allow real on-chain send execution in provider E2E (requires canary target env vars)",
      false,
    )
    .option("--providers <ids>", "Comma-separated provider ids (alchemy,turnkey)")
    .option(
      "--execute-recovery-drill",
      "Run stack down/up recovery drill (external-docker runtime only)",
      false,
    )
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await walletCanaryCommand(defaultRuntime, {
          json: Boolean(opts.json),
          requireRealChain: Boolean(opts.requireRealChain),
          executeRecoveryDrill: Boolean(opts.executeRecoveryDrill),
          executeProviderE2E: Boolean(opts.executeProviderE2E),
          executeLiveSend: Boolean(opts.executeLiveSend),
          providers:
            typeof opts.providers === "string"
              ? opts.providers
                  .split(",")
                  .map((entry: string) => entry.trim())
                  .filter(Boolean)
              : [],
        });
      });
    });

  const inbound = wallet.command("inbound").description("Inbound receive/deposit monitoring");

  inbound
    .command("poll")
    .description("Poll balances and detect inbound/outbound delta events")
    .option("--provider <id>", "Provider id (local-socket-signer|alchemy|turnkey|wallet-standard)")
    .option("--wallet-id <id>", "Named wallet id scope")
    .option("--wallet-name <name>", "Named wallet name scope")
    .option("--chain <chain>", "solana|all", "all")
    .option("--json", "Print JSON output", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await walletInboundPollCommand(defaultRuntime, {
          json: Boolean(opts.json),
          providerId: typeof opts.provider === "string" ? opts.provider : undefined,
          walletId: typeof opts.walletId === "string" ? opts.walletId : undefined,
          walletName: typeof opts.walletName === "string" ? opts.walletName : undefined,
          chain:
            opts.chain === "all" ? "all" : (resolvePublicWalletSetupChain(opts.chain) ?? "all"),
        });
      });
    });

  inbound
    .command("list")
    .description("List inbound/deposit events from local wallet ledger")
    .option("--provider <id>", "Provider id (local-socket-signer|alchemy|turnkey|wallet-standard)")
    .option("--wallet-id <id>", "Named wallet id filter")
    .option("--chain <chain>", "solana")
    .option("--status <status>", "all|detected|confirmed|reconciled|ignored", "all")
    .option("--limit <count>", "Result limit", "100")
    .option("--json", "Print JSON output", false)
    .action(async (opts) => {
      const limit =
        typeof opts.limit === "string" && opts.limit.trim()
          ? Number.parseInt(opts.limit, 10)
          : undefined;
      await runCommandWithRuntime(defaultRuntime, async () => {
        await walletInboundListCommand(defaultRuntime, {
          json: Boolean(opts.json),
          providerId: typeof opts.provider === "string" ? opts.provider : undefined,
          walletId: typeof opts.walletId === "string" ? opts.walletId : undefined,
          chain: resolvePublicWalletSetupChain(opts.chain),
          status:
            opts.status === "all" ||
            opts.status === "detected" ||
            opts.status === "confirmed" ||
            opts.status === "reconciled" ||
            opts.status === "ignored"
              ? opts.status
              : "all",
          limit: Number.isFinite(limit) ? limit : undefined,
        });
      });
    });

  inbound
    .command("reconcile")
    .description("Reconcile inbound events against wallet audit history by tx hash")
    .option("--json", "Print JSON output", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await walletInboundReconcileCommand(defaultRuntime, {
          json: Boolean(opts.json),
        });
      });
    });
}
