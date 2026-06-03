import type { Command } from "commander";
import {
  walletCanaryCommand,
  walletCustodyLockCommand,
  walletCustodyInitCommand,
  walletInboundListCommand,
  walletInboundPollCommand,
  walletInboundReconcileCommand,
  walletKeystoreImportCommand,
  walletKeystoreInitCommand,
  walletKeystorePassphraseInitCommand,
  walletKeystorePassphraseRotateCommand,
  walletKeystoreExportCommand,
  walletKeystoreStatusCommand,
  walletKeystoreValidateCommand,
  walletLimitOrdersConfigureCommand,
  walletMigrateCommand,
  walletPolicyProfileApplyCommand,
  walletProviderConfigureCommand,
  walletRotateKeysCommand,
  walletRoleSetCommand,
  walletSetupCommand,
  walletSignerBrokerCommand,
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
    .description("Wallet providers, keystore, custody, and policy status")
    .action(() => {
      wallet.help({ error: true });
    });

  wallet
    .command("setup")
    .description("Guided Solana wallet setup (create/import local signer wallet)")
    .option(
      "--mode <mode>",
      "embedded-create|embedded-import|local-signer|turnkey (embedded alias allowed)",
    )
    .option("--chain <chain>", "solana", "solana")
    .option("--wallet-id <id>", "Named wallet id (examples: agent, mining, vault)")
    .option("--wallet-name <value>", "Friendly wallet display name (for UI/skills/plugins)")
    .option("--role <role>", "agent|vault. SAT mining is attached separately.")
    .option("--private-key <value>", "Private key for import mode (prefer env)")
    .option("--api-key <value>", "Hosted wallet provider API key (alchemy/privy mode)")
    .option("--rpc-url <url>", "RPC URL hint for embedded create/import")
    .option(
      "--show-private-key-once",
      "For embedded-create: print generated private key once",
      false,
    )
    .option(
      "--confirm-private-key-print <text>",
      'Required with --show-private-key-once; type "SHOW PRIVATE KEY"',
    )
    .option("--turnkey-api-public-key <value>", "Turnkey API public key (turnkey mode)")
    .option("--turnkey-api-private-key <value>", "Turnkey API private key (turnkey mode)")
    .option("--turnkey-organization-id <value>", "Turnkey organization ID (turnkey mode)")
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
          privateKey: typeof opts.privateKey === "string" ? opts.privateKey : undefined,
          apiKey: typeof opts.apiKey === "string" ? opts.apiKey : undefined,
          rpcUrl: typeof opts.rpcUrl === "string" ? opts.rpcUrl : undefined,
          showPrivateKeyOnce: Boolean(opts.showPrivateKeyOnce),
          confirmPrivateKeyPrint:
            typeof opts.confirmPrivateKeyPrint === "string"
              ? opts.confirmPrivateKeyPrint
              : undefined,
          turnkeyApiPublicKey:
            typeof opts.turnkeyApiPublicKey === "string" ? opts.turnkeyApiPublicKey : undefined,
          turnkeyApiPrivateKey:
            typeof opts.turnkeyApiPrivateKey === "string" ? opts.turnkeyApiPrivateKey : undefined,
          turnkeyOrganizationId:
            typeof opts.turnkeyOrganizationId === "string" ? opts.turnkeyOrganizationId : undefined,
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
    .description("Rotate local wallet keys (provider-specific; deprecated command name)")
    .option("--json", "Print JSON output", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await walletRotateKeysCommand(defaultRuntime, {
          json: Boolean(opts.json),
        });
      });
    });

  const keystore = wallet
    .command("keystore")
    .description("Manage encrypted local Solana keystore wallets");

  keystore
    .command("init")
    .description("Create a new encrypted keystore and set provider=embedded-keystore")
    .option("--chain <chain>", "Key type: solana", "solana")
    .option("--wallet-id <id>", "Named wallet id (agent, mining, vault, ...)")
    .option("--out <path>", "Output keystore path (default: <state>/wallet/keystore.v1.enc)")
    .option(
      "--passphrase <value>",
      "Keystore passphrase (prefer env/file in shell history-safe use)",
    )
    .option("--rpc-url <url>", "Optional RPC URL hint (still typically set via env)")
    .option("--show-private-key-once", "Print generated private key once (dangerous)", false)
    .option(
      "--confirm-private-key-print <text>",
      'Required with --show-private-key-once; type "SHOW PRIVATE KEY"',
    )
    .option("--name <value>", "Named wallet label for UI")
    .option("--role <role>", "agent|vault. SAT mining is attached separately.")
    .option("--force", "Overwrite existing keystore", false)
    .option("--json", "Print JSON output", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await walletKeystoreInitCommand(defaultRuntime, {
          json: Boolean(opts.json),
          chain: resolvePublicWalletSetupChain(opts.chain) ?? "solana",
          walletId: typeof opts.walletId === "string" ? opts.walletId : undefined,
          out: typeof opts.out === "string" ? opts.out : undefined,
          passphrase: typeof opts.passphrase === "string" ? opts.passphrase : undefined,
          rpcUrl: typeof opts.rpcUrl === "string" ? opts.rpcUrl : undefined,
          showPrivateKeyOnce: Boolean(opts.showPrivateKeyOnce),
          confirmPrivateKeyPrint:
            typeof opts.confirmPrivateKeyPrint === "string"
              ? opts.confirmPrivateKeyPrint
              : undefined,
          name: typeof opts.name === "string" ? opts.name : undefined,
          role: typeof opts.role === "string" ? opts.role : undefined,
          force: Boolean(opts.force),
        });
      });
    });

  keystore
    .command("import")
    .description("Import a raw Solana private key into an encrypted keystore and set provider")
    .option("--chain <chain>", "Key type: solana", "solana")
    .option("--wallet-id <id>", "Named wallet id (agent, mining, vault, ...)")
    .option("--private-key <value>", "Solana private key (prefer env FASED_WALLET_PRIVATE_KEY)")
    .option("--out <path>", "Output keystore path (default: <state>/wallet/keystore.v1.enc)")
    .option(
      "--passphrase <value>",
      "Keystore passphrase (prefer env/file in shell history-safe use)",
    )
    .option("--rpc-url <url>", "Optional RPC URL hint (still typically set via env)")
    .option("--name <value>", "Named wallet label for UI")
    .option("--role <role>", "agent|vault. SAT mining is attached separately.")
    .option("--force", "Overwrite existing keystore", false)
    .option("--json", "Print JSON output", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await walletKeystoreImportCommand(defaultRuntime, {
          json: Boolean(opts.json),
          walletId: typeof opts.walletId === "string" ? opts.walletId : undefined,
          out: typeof opts.out === "string" ? opts.out : undefined,
          passphrase: typeof opts.passphrase === "string" ? opts.passphrase : undefined,
          rpcUrl: typeof opts.rpcUrl === "string" ? opts.rpcUrl : undefined,
          privateKey: typeof opts.privateKey === "string" ? opts.privateKey : undefined,
          chain: resolvePublicWalletSetupChain(opts.chain) ?? "solana",
          name: typeof opts.name === "string" ? opts.name : undefined,
          role: typeof opts.role === "string" ? opts.role : undefined,
          force: Boolean(opts.force),
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

  keystore
    .command("passphrase-init")
    .description("Generate keystore passphrase file (0600) and print env export hint")
    .option("--out <path>", "Passphrase file path (default: <state>/wallet/passphrase)")
    .option("--length <bytes>", "Random bytes length", (v) => Number.parseInt(v, 10))
    .option("--force", "Overwrite existing file", false)
    .option("--json", "Print JSON output", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await walletKeystorePassphraseInitCommand(defaultRuntime, {
          out: typeof opts.out === "string" ? opts.out : undefined,
          length:
            typeof opts.length === "number" && Number.isFinite(opts.length)
              ? opts.length
              : undefined,
          force: Boolean(opts.force),
          json: Boolean(opts.json),
        });
      });
    });

  keystore
    .command("rotate-passphrase")
    .description("Re-encrypt embedded keystore with a new passphrase and update passphrase file")
    .option("--file <path>", "Passphrase file path (default: env or <state>/wallet/passphrase)")
    .option("--old-passphrase <value>", "Old passphrase (avoid shell history; prefer file/env)")
    .option("--new-passphrase <value>", "New passphrase (omit to auto-generate)")
    .option("--json", "Print JSON output", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await walletKeystorePassphraseRotateCommand(defaultRuntime, {
          file: typeof opts.file === "string" ? opts.file : undefined,
          oldPassphrase: typeof opts.oldPassphrase === "string" ? opts.oldPassphrase : undefined,
          newPassphrase: typeof opts.newPassphrase === "string" ? opts.newPassphrase : undefined,
          json: Boolean(opts.json),
        });
      });
    });

  keystore
    .command("export")
    .description("Export encrypted keystore backup (dangerous if printing)")
    .option("--out <path>", "Write backup copy to path")
    .option("--include-secret", "Include encrypted keystore content in JSON output", false)
    .option(
      "--confirm-include-secret <text>",
      'Required with --include-secret; type "EXPORT KEYSTORE"',
    )
    .option("--json", "Print JSON output", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await walletKeystoreExportCommand(defaultRuntime, {
          out: typeof opts.out === "string" ? opts.out : undefined,
          includeSecret: Boolean(opts.includeSecret),
          confirmIncludeSecret:
            typeof opts.confirmIncludeSecret === "string" ? opts.confirmIncludeSecret : undefined,
          json: Boolean(opts.json),
        });
      });
    });

  keystore
    .command("status")
    .description("Show embedded keystore presence/unlock status")
    .option("--chain <chain>", "Target chain: solana", "solana")
    .option("--wallet-id <id>", "Named wallet id (uses chain-specific signer env fallback paths)")
    .option("--json", "Print JSON output", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await walletKeystoreStatusCommand(defaultRuntime, {
          json: Boolean(opts.json),
          walletId: typeof opts.walletId === "string" ? opts.walletId : undefined,
          chain: resolvePublicWalletSetupChain(opts.chain) ?? "solana",
        });
      });
    });

  keystore
    .command("validate")
    .description("Validate embedded keystore unlock + RPC connectivity + chain + balance")
    .option("--chain <chain>", "Keystore chain override: solana")
    .option("--wallet-id <id>", "Named wallet id (agent, mining, vault, ...)")
    .option("--json", "Print JSON output", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await walletKeystoreValidateCommand(defaultRuntime, {
          json: Boolean(opts.json),
          walletId: typeof opts.walletId === "string" ? opts.walletId : undefined,
          chain: resolvePublicWalletSetupChain(opts.chain),
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
        providerArg === "turnkey" || providerArg === "privy" || providerArg === "alchemy"
          ? providerArg
          : null;
      if (!providerId) {
        throw new Error("provider must be one of: turnkey, privy, alchemy");
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
    .command("broker")
    .description("Run the app-facing local signer broker daemon")
    .option("--socket <path>", "App-facing Unix socket path")
    .option("--backend-socket <path>", "Private backend signer socket path")
    .option("--read-only", "Read-only mode", false)
    .option("--pid-file <path>", "PID file path")
    .option("--audit-log <path>", "Audit log path")
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await walletSignerBrokerCommand(defaultRuntime, {
          socketPath: typeof opts.socket === "string" ? opts.socket : undefined,
          backendSocketPath:
            typeof opts.backendSocket === "string" ? opts.backendSocket : undefined,
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
    .command("custody-init")
    .description("Initialize split-key custody ceremony (device/hot/cold share state)")
    .option("--json", "Print JSON output", false)
    .option("--force", "Overwrite existing custody ceremony state", false)
    .option("--wallet <walletId>", "Target wallet id for per-wallet custody state")
    .option(
      "--device-share <base64>",
      "Optional pre-generated device share (base64/base64url, 32 bytes)",
    )
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await walletCustodyInitCommand(defaultRuntime, {
          json: Boolean(opts.json),
          force: Boolean(opts.force),
          walletId: typeof opts.wallet === "string" ? opts.wallet : undefined,
          deviceShare: typeof opts.deviceShare === "string" ? opts.deviceShare : undefined,
        });
      });
    });

  wallet
    .command("custody-lock")
    .description(
      "Immediately end active custody unlock sessions (clears ephemeral signing material)",
    )
    .option("--host <host>", "Only lock unlock sessions for this host")
    .option("--wallet <walletId>", "Only lock unlock sessions for this wallet")
    .option("--json", "Print JSON output", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await walletCustodyLockCommand(defaultRuntime, {
          json: Boolean(opts.json),
          host: typeof opts.host === "string" ? opts.host : undefined,
          walletId: typeof opts.wallet === "string" ? opts.wallet : undefined,
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
    .option(
      "--providers <ids>",
      "Comma-separated provider ids (embedded-keystore,alchemy,turnkey,privy)",
    )
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
    .option("--provider <id>", "Provider id (embedded-keystore|alchemy|turnkey|privy)")
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
    .option("--provider <id>", "Provider id (embedded-keystore|alchemy|turnkey|privy)")
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
