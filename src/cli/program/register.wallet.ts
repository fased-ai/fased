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
  walletPolicyActivateRoleBaselineCommand,
  walletProviderConfigureCommand,
  walletRotateKeysCommand,
  walletRecoveryExportCommand,
  walletRecoveryImportCommand,
  walletRawExportCommand,
  walletRetireCommand,
  walletRpcSetCommand,
  walletRoleSetCommand,
  walletSetupCommand,
  walletSignerServeCommand,
  walletSignerDoctorCommand,
  walletStatusCommand,
} from "../../commands/wallet.js";
import { defaultRuntime } from "../../runtime.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import {
  addGatewayClientOptions,
  callGatewayFromCli,
  type GatewayRpcOpts,
} from "../gateway-rpc.js";

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

  const recovery = wallet.command("recovery").description("Signer-owned encrypted recovery");
  recovery
    .command("export")
    .description("Create an Argon2id + authenticated-encryption recovery package")
    .requiredOption("--wallet-id <id>", "Registered signer-owned wallet id")
    .requiredOption("--output <absolute-path>", "New owner-only recovery package path")
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await walletRecoveryExportCommand(defaultRuntime, {
          walletId: String(opts.walletId),
          output: String(opts.output),
        });
      });
    });

  recovery
    .command("restore")
    .alias("import")
    .description("Restore an encrypted signer recovery package into a new signer-owned wallet")
    .requiredOption("--wallet-id <id>", "New registered signer-owned wallet id")
    .requiredOption("--wallet-name <name>", "Wallet display name")
    .requiredOption("--role <role>", "Permanent signer role: agent|mining|vault")
    .requiredOption("--file <absolute-path>", "Owner-only encrypted recovery package")
    .requiredOption("--rpc-url <url>", "One primary Solana RPC URL")
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await walletRecoveryImportCommand(defaultRuntime, {
          walletId: String(opts.walletId),
          walletName: String(opts.walletName),
          role: String(opts.role),
          recoveryFile: String(opts.file),
          rpcUrl: String(opts.rpcUrl),
        });
      });
    });

  recovery
    .command("export-raw")
    .description("Advanced: export a raw Solana keypair and reduce signer custody protection")
    .requiredOption("--wallet-id <id>", "Registered signer-owned wallet id")
    .requiredOption("--output <absolute-path>", "New owner-only raw keypair path")
    .requiredOption(
      "--acknowledge-custody-reduction",
      "Confirm that raw export makes the wallet key portable",
    )
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await walletRawExportCommand(defaultRuntime, {
          walletId: String(opts.walletId),
          output: String(opts.output),
          acknowledgeCustodyReduction: Boolean(opts.acknowledgeCustodyReduction),
        });
      });
    });

  wallet
    .command("export-raw")
    .description("Advanced: export a raw Solana keypair and reduce signer custody protection")
    .requiredOption("--wallet-id <id>", "Registered signer-owned wallet id")
    .requiredOption("--output <absolute-path>", "New owner-only raw keypair path")
    .requiredOption(
      "--acknowledge-custody-reduction",
      "Confirm that raw export makes the wallet key portable",
    )
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await walletRawExportCommand(defaultRuntime, {
          walletId: String(opts.walletId),
          output: String(opts.output),
          acknowledgeCustodyReduction: Boolean(opts.acknowledgeCustodyReduction),
        });
      });
    });

  wallet
    .command("create")
    .description("Create a role-ready signer-owned Solana wallet")
    .option("--wallet-id <id>", "Named wallet id")
    .option("--wallet-name <name>", "Wallet display name")
    .option("--role <role>", "Permanent signer role: agent|mining|vault")
    .option("--rpc-url <url>", "One primary Solana RPC URL")
    .option("--force", "Resume only the same existing signer wallet and role", false)
    .option("--non-interactive", "Do not prompt; require all inputs", false)
    .option("--json", "Print JSON output", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await walletSetupCommand(defaultRuntime, {
          mode: "local-signer-create",
          chain: "solana",
          walletId: typeof opts.walletId === "string" ? opts.walletId : undefined,
          walletName: typeof opts.walletName === "string" ? opts.walletName : undefined,
          role: typeof opts.role === "string" ? opts.role : undefined,
          rpcUrl: typeof opts.rpcUrl === "string" ? opts.rpcUrl : undefined,
          force: Boolean(opts.force),
          nonInteractive: Boolean(opts.nonInteractive),
          json: Boolean(opts.json),
        });
      });
    });

  wallet
    .command("import")
    .description("Import an owner-only Solana keypair through the native signer lifecycle")
    .option("--wallet-id <id>", "Named wallet id")
    .option("--wallet-name <name>", "Wallet display name")
    .option("--role <role>", "Permanent signer role: agent|mining|vault")
    .option("--file <absolute-path>", "Owner-only Solana keypair JSON")
    .option("--rpc-url <url>", "One primary Solana RPC URL")
    .option("--non-interactive", "Do not prompt; require all inputs", false)
    .option("--json", "Print JSON output", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await walletSetupCommand(defaultRuntime, {
          mode: "local-signer-import",
          chain: "solana",
          walletId: typeof opts.walletId === "string" ? opts.walletId : undefined,
          walletName: typeof opts.walletName === "string" ? opts.walletName : undefined,
          role: typeof opts.role === "string" ? opts.role : undefined,
          importFile: typeof opts.file === "string" ? opts.file : undefined,
          rpcUrl: typeof opts.rpcUrl === "string" ? opts.rpcUrl : undefined,
          nonInteractive: Boolean(opts.nonInteractive),
          json: Boolean(opts.json),
        });
      });
    });

  addGatewayClientOptions(
    wallet
      .command("retire")
      .description("Safely retire and replace the active signer-owned Mining wallet")
      .requiredOption("--wallet-id <id>", "Active Mining wallet id")
      .requiredOption("--successor-wallet-id <id>", "New distinct Mining wallet id")
      .requiredOption("--successor-wallet-name <name>", "New Mining wallet display name")
      .requiredOption(
        "--recovery-file <absolute-path>",
        "Encrypted recovery package for the old wallet",
      )
      .requiredOption("--rpc-url <url>", "One primary Solana RPC URL for the successor")
      .option("--json", "Print JSON output", false),
  ).action(async (opts: GatewayRpcOpts & Record<string, unknown>) => {
    await runCommandWithRuntime(defaultRuntime, async () => {
      let liveMiningStatus: unknown = {};
      try {
        await callGatewayFromCli("sat.stopMining", opts, {}, { progress: opts.json !== true });
        liveMiningStatus = await callGatewayFromCli(
          "sat.getMiningStatus",
          opts,
          {},
          {
            progress: opts.json !== true,
          },
        );
      } catch (error) {
        liveMiningStatus = {
          retirementGatewayError: error instanceof Error ? error.message : String(error),
        };
      }
      await walletRetireCommand(defaultRuntime, {
        walletId: String(opts.walletId),
        successorWalletId: String(opts.successorWalletId),
        successorWalletName: String(opts.successorWalletName),
        recoveryFile: String(opts.recoveryFile),
        rpcUrl: String(opts.rpcUrl),
        liveMiningStatus,
        json: opts.json === true,
      });
    });
  });

  const rpc = wallet.command("rpc").description("Signer-owned Solana RPC configuration");
  rpc
    .command("set")
    .description("Verify and set one primary Solana RPC")
    .requiredOption("--wallet-id <id>", "Registered signer-owned wallet id")
    .requiredOption("--rpc-url <url>", "Primary Solana RPC URL")
    .option("--json", "Print JSON output", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await walletRpcSetCommand(defaultRuntime, {
          walletId: String(opts.walletId),
          rpcUrl: String(opts.rpcUrl),
          json: Boolean(opts.json),
        });
      });
    });

  wallet
    .command("setup")
    .description("Create a signer-owned Solana wallet or configure a supported provider")
    .option(
      "--mode <mode>",
      "local-signer-create|local-signer-import|local-signer-recovery-import|local-signer|turnkey|alchemy",
    )
    .option("--chain <chain>", "solana", "solana")
    .option("--wallet-id <id>", "Named wallet id (examples: agent, mining, vault)")
    .option("--wallet-name <value>", "Friendly wallet display name (for UI/skills/plugins)")
    .option("--role <role>", "Permanent signer role: agent|mining|vault")
    .option(
      "--import-file <absolute-path>",
      "Owner-only Solana keypair JSON for local-signer-import; secret is passed by file descriptor, never argv/env",
    )
    .option(
      "--recovery-file <absolute-path>",
      "Owner-only encrypted package for local-signer-recovery-import",
    )
    .option("--api-key <value>", "Alchemy API key")
    .option("--rpc-url <url>", "Solana RPC URL")
    .option("--turnkey-api-public-key <value>", "Turnkey API public key (turnkey mode)")
    .option("--turnkey-api-private-key <value>", "Turnkey API private key (turnkey mode)")
    .option("--turnkey-organization-id <value>", "Turnkey organization ID (turnkey mode)")
    .option("--turnkey-policy-id <value>", "Turnkey policy ID (turnkey mode)")
    .option("--turnkey-base-url <value>", "Turnkey base URL override (turnkey mode)")
    .option(
      "--enable-limit-orders",
      "Legacy alias: configure Gateway Jupiter Swap API access (Trigger is signer-owned)",
      false,
    )
    .option("--disable-limit-orders", "Remove stored Gateway Jupiter Swap API key", false)
    .option("--jupiter-api-key <value>", "Jupiter API key for Gateway swap crafting only")
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
          importFile: typeof opts.importFile === "string" ? opts.importFile : undefined,
          recoveryFile: typeof opts.recoveryFile === "string" ? opts.recoveryFile : undefined,
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
          nonInteractive: Boolean(opts.nonInteractive),
          noDoctor: Boolean(opts.noDoctor),
          json: Boolean(opts.json),
        });
      });
    });

  wallet
    .command("limit-orders")
    .description(
      "Configure Gateway Jupiter Swap API access; Trigger credentials remain signer-owned",
    )
    .option("--enable", "Store a Gateway Jupiter Swap API key", false)
    .option("--disable", "Remove the stored Gateway Jupiter Swap API key", false)
    .option("--jupiter-api-key <value>", "Jupiter API key for Gateway swap crafting only")
    .option("--non-interactive", "Do not prompt; require explicit inputs", false)
    .option("--json", "Print JSON output", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await walletLimitOrdersConfigureCommand(defaultRuntime, {
          enable: Boolean(opts.enable),
          disable: Boolean(opts.disable),
          jupiterApiKey: typeof opts.jupiterApiKey === "string" ? opts.jupiterApiKey : undefined,
          nonInteractive: Boolean(opts.nonInteractive),
          json: Boolean(opts.json),
        });
      });
    });

  wallet
    .command("status")
    .description("Show wallet service and policy status")
    .option("--wallet-id <id>", "Show one registered wallet")
    .option("--json", "Print JSON output", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await walletStatusCommand(defaultRuntime, {
          json: Boolean(opts.json),
          walletId: typeof opts.walletId === "string" ? opts.walletId : undefined,
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
      "Set Default Agent wallet fallback or initialize a missing Agent/Vault purpose. Existing purpose stays permanent.",
    )
    .option("--primary", "Make this the Default Agent wallet fallback", false)
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
    .command("activate-role-baseline")
    .description("Explicitly migrate one existing deny-all signer wallet to its role baseline")
    .requiredOption("--wallet-id <id>", "Registered signer-owned wallet id")
    .requiredOption("--role <role>", "Immutable signer role: agent|mining|vault")
    .requiredOption("--confirm", "Confirm activation after reviewing the selected role")
    .option("--json", "Print JSON output", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await walletPolicyActivateRoleBaselineCommand(defaultRuntime, {
          walletId: String(opts.walletId),
          role: String(opts.role),
          confirm: Boolean(opts.confirm),
          json: Boolean(opts.json),
        });
      });
    });

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
