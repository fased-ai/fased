import { describe, expect, it } from "vitest";
import {
  describeAdminControlShortcut,
  describeVaultSignerApproval,
  describeWalletAutomationPolicySummary,
  describeWalletSendFlow,
  describeAgentDefaultAction,
  describeWalletRoleBadges,
  orderWalletsForDisplay,
  renderWallet,
  resolveOperatorWalletRoles,
  type WalletViewProps,
} from "./wallet.ts";

const namedWallets = [
  {
    id: "wallet-agent",
    name: "Agent Wallet",
    providerId: "embedded-keystore" as const,
    addresses: { solana: "So11111111111111111111111111111111111111112" },
    balances: { solana: "2" },
    metadata: { role: "agent" },
    readiness: { keystore: true, rpc: true },
  },
  {
    id: "wallet-mining",
    name: "Mining Wallet",
    providerId: "embedded-keystore" as const,
    addresses: { solana: "So11111111111111111111111111111111111111113" },
    balances: { solana: "3" },
    readiness: { keystore: true, rpc: true },
  },
  {
    id: "wallet-vault",
    name: "Vault Wallet",
    providerId: "embedded-keystore" as const,
    addresses: { solana: "So11111111111111111111111111111111111111114" },
    balances: { solana: "4" },
    metadata: { role: "vault" },
    readiness: { keystore: true, rpc: true },
  },
];

type LitTemplateLike = {
  strings?: ArrayLike<string>;
  values?: unknown[];
};

function flattenTemplateText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) => flattenTemplateText(entry))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }
  if (value && typeof value === "object") {
    const template = value as LitTemplateLike;
    if (template.strings && Array.isArray(template.values)) {
      const parts: string[] = [];
      const strings = Array.from(template.strings);
      for (let index = 0; index < strings.length; index += 1) {
        parts.push(strings[index] ?? "");
        if (index < template.values.length) {
          parts.push(flattenTemplateText(template.values[index]));
        }
      }
      return parts
        .join(" ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    }
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }
  if (typeof value === "function" || value == null || typeof value === "boolean") {
    return "";
  }
  return "";
}

function flattenTemplateSource(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => flattenTemplateSource(entry)).join(" ");
  }
  if (value && typeof value === "object") {
    const template = value as LitTemplateLike;
    if (template.strings && Array.isArray(template.values)) {
      const strings = Array.from(template.strings);
      return strings
        .map(
          (part, index) =>
            `${part}${
              index < template.values!.length ? flattenTemplateSource(template.values![index]) : ""
            }`,
        )
        .join("");
    }
  }
  return "";
}

function renderWalletForTest(overrides: Partial<WalletViewProps>) {
  return renderWallet({
    loading: false,
    error: null,
    status: null,
    namedWallets,
    balancesLoading: false,
    balancesError: null,
    balances: null,
    defaultWalletId: "wallet-agent",
    settingsBusy: false,
    settingsError: null,
    settingsMessage: null,
    settings: null,
    skillGrantsLoading: false,
    skillGrantsError: null,
    skillGrantsMessage: null,
    skillGrantsWorkspace: "/tmp/workspace",
    skillGrantRows: [],
    skillGrantDraft: {
      skillId: "",
      actions: ["quote"],
      walletIds: "",
      chain: "solana",
      registry: "https://clawhub.com",
      inputMints: "",
      outputMints: "",
      maxAmount: "",
      maxSlippageBps: "",
      autonomous: false,
      cron: false,
    },
    skillGrantBusy: false,
    rpcChain: "solana",
    policySolMaxPerTx: "",
    policySolMaxDaily: "",
    policySolanaTokenCaps: {},
    policyTokenCapMint: "",
    policyTokenCapDecimals: "",
    policyTokenCapMaxPerTx: "",
    policyTokenCapMaxDaily: "",
    policyTokenSearchQuery: "",
    policyTokenSearchLoading: false,
    policyTokenSearchError: null,
    policyTokenSearchResults: [],
    recurringTransferEnabled: false,
    recurringTransferDestination: "",
    recurringTransferMint: "",
    recurringTransferAmountMode: "fixed",
    recurringTransferAmount: "",
    recurringTransferPercentage: "",
    recurringTransferMinAmount: "",
    recurringTransferKeepAmount: "",
    recurringTransferDecimals: "",
    recurringTransferCron: "",
    recurringTransferTz: "UTC",
    recurringTransferName: "",
    actionMessage: null,
    passkeyBusy: false,
    passkeyError: null,
    passkeyLabel: "",
    auditEntries: [],
    activityPage: 1,
    sendModalVisible: false,
    onSendModalOpen: () => undefined,
    onSendModalClose: () => undefined,
    sendCreateBusy: false,
    sendCreateError: null,
    sendCreateForm: {
      chain: "solana",
      walletId: "wallet-agent",
      to: "",
      amount: "",
      program: "",
      memo: "",
    },
    walletDetailsWalletId: "wallet-agent",
    approvalsLoading: false,
    approvalsBusyId: null,
    approvalsError: null,
    approvalsFilter: "pending",
    approvals: [],
    onSendCreatePatch: () => undefined,
    onWalletDetailsWalletChange: () => undefined,
    onApprovalsFilterChange: () => undefined,
    onApproveRequest: () => undefined,
    onRejectRequest: () => undefined,
    onSetDefaultWallet: () => undefined,
    onPasskeyLabelChange: () => undefined,
    onEnablePasskeyApproval: () => undefined,
    onEnrollPasskey: () => undefined,
    onPatchSettings: () => undefined,
    onActivityPageChange: () => undefined,
    onRpcChainChange: () => undefined,
    onPolicyDraftChange: () => undefined,
    onTokenSearchQueryChange: () => undefined,
    onTokenSearch: () => undefined,
    onTokenSearchSelect: () => undefined,
    onSavePolicy: () => undefined,
    onRefresh: () => undefined,
    onSkillGrantSelect: () => undefined,
    onSkillGrantDraftPatch: () => undefined,
    onSkillGrantActionToggle: () => undefined,
    onSkillGrantSave: () => undefined,
    onSkillGrantClear: () => undefined,
    onCreateSendRequest: () => undefined,
    miningProfile: null,
    miningReadiness: null,
    miningStatus: null,
    ...overrides,
  });
}

describe("wallet creation", () => {
  it("shows only an implemented signer-owned creation path", () => {
    const rendered = renderWalletForTest({
      providers: [
        {
          id: "local-socket-signer",
          enabled: true,
          operationsImplemented: true,
          credentialsConfigured: true,
          health: { ok: true },
          capabilities: {
            operations: { createWallet: true },
            requiresCredentials: false,
          },
        } as never,
      ],
      createRole: "vault",
      createName: "Reserve",
      createRpcUrl: "https://rpc.example/solana",
    });
    const text = flattenTemplateText(rendered);
    expect(text).toContain("Create wallet");
    expect(text).toContain("Name (optional)");
    expect(text).toContain(
      "Select a role Agent Mining Vault Profile Strategy (deny-all) Reusable RPC profile",
    );
    expect(text).toContain("Use a signer-owned verified profile, or enter a direct RPC below");
    expect(text).not.toContain("capped automation");
    expect(text).not.toContain("singleton SAT operations");
    expect(text).not.toContain("reviewed operations only");
    expect(text).not.toContain("Custody provider");
    expect(text).not.toContain("Permanent wallet ID");
    expect(text).not.toContain("Choose a wallet role; Agent is never selected silently.");
    expect(text).toContain("Connect browser wallet as Vault");
    expect(text).not.toContain("Connect hardware Vault");
    expect(text).toContain("Any Solana RPC provider works");
    expect(text).not.toContain("Embedded keystore");
    expect(text).not.toContain("Privy");
    expect(text).toContain("Wallet Activity");
    expect(text).toContain("No recent wallet activity.");
    expect(text).toContain("@wallet:wallet-agent");
    expect(text).toContain("So..12");
  });
});

describe("wallet management", () => {
  const localWallets = [
    {
      id: "mining",
      name: "Mining",
      providerId: "local-socket-signer" as const,
      addresses: { solana: "So11111111111111111111111111111111111111113" },
      metadata: { role: "mining" },
      readiness: { keystore: true, rpc: true, ready: true },
    },
    {
      id: "vault",
      name: "Vault",
      providerId: "local-socket-signer" as const,
      addresses: { solana: "So11111111111111111111111111111111111111114" },
      metadata: { role: "vault" },
      readiness: { keystore: true, rpc: true, ready: true },
    },
  ];

  it("routes Mining to retirement and offers archive for other local wallets", () => {
    const miningText = flattenTemplateText(
      renderWalletForTest({
        namedWallets: localWallets,
        expandedWalletId: "mining",
        expandedPanel: "security",
        walletDetailsWalletId: "mining",
        miningProfile: { walletId: "mining" } as never,
      }),
    );
    expect(miningText).toContain("Retire and replace Mining wallet");
    expect(miningText).not.toContain("Archive wallet");

    const vaultText = flattenTemplateText(
      renderWalletForTest({
        namedWallets: localWallets,
        expandedWalletId: "vault",
        expandedPanel: "security",
        walletDetailsWalletId: "vault",
        miningProfile: { walletId: "mining" } as never,
      }),
    );
    expect(vaultText).toContain("Archive wallet");
    expect(vaultText).toContain("It does not move funds");
  });

  it("offers safe Fased-only removal for an attached browser wallet", () => {
    const browserText = flattenTemplateText(
      renderWalletForTest({
        namedWallets: [
          {
            id: "browser-vault",
            name: "Browser Vault",
            providerId: "wallet-standard",
            addresses: { solana: "So11111111111111111111111111111111111111114" },
            metadata: { role: "vault" },
            readiness: { keystore: true, rpc: true },
          },
        ],
        expandedWalletId: "browser-vault",
        expandedPanel: "security",
        walletDetailsWalletId: "browser-vault",
      }),
    );

    expect(browserText).toContain("Remove wallet");
    expect(browserText).toContain("browser wallet and its funds are unchanged");
    expect(browserText).not.toContain("Archive wallet");
  });

  it("renders a compact masked RPC row before wallet policy controls", () => {
    const rendered = renderWalletForTest({
      namedWallets: [
        {
          ...localWallets[1],
          rpc: { configured: true, maskedUrl: "****" },
          readiness: {
            keystore: true,
            rpc: true,
            ready: true,
            signer: { networkReady: true, ready: true },
          },
        } as never,
      ],
      expandedWalletId: "vault",
      expandedPanel: "security",
      walletDetailsWalletId: "vault",
      onCopyWalletRpc: () => undefined,
      onToggleWalletRpcEditor: () => undefined,
    });
    const text = flattenTemplateText(rendered);
    const source = flattenTemplateSource(rendered);

    expect(text).toContain("RPC **** Send limits");
    expect(text).not.toContain("Solana RPC: connected");
    expect(text).not.toContain("Change RPC");
    expect(source).toContain('aria-label="Copy RPC"');
    expect(source).toContain('aria-label="Edit RPC"');
    expect(source).not.toContain('aria-label="Show RPC"');
    expect(source.indexOf("wallet-rpc-settings")).toBeLessThan(
      source.indexOf("wallet-policy-tabs"),
    );
  });
});

describe("resolveOperatorWalletRoles", () => {
  it("separates admin, Agent, and mining roles when distinct wallets are configured", () => {
    const roles = resolveOperatorWalletRoles({
      status: {
        approvalAuth: {
          mode: "webauthn",
          ready: true,
          passkeyCount: 2,
          notes: [],
          passkeys: [],
          statePath: "/tmp/passkeys.json",
        },
      } as never,
      namedWallets,
      defaultWalletId: "wallet-agent",
      federationBond: {
        walletId: "wallet-vault",
        status: "active",
        tier: "operator-bond",
        quotaBand: "operator",
      } as never,
      miningProfile: { walletId: "wallet-mining" } as never,
      miningReadiness: null,
      miningStatus: null,
    });

    expect(roles.admin.summary).toBe("Optional · enabled");
    expect(roles.agent.summary).toBe("Agent Wallet");
    expect(roles.agent.detail).toContain(
      "If no explicit, skill, or Agent assignment exists, approved wallet actions use this optional fallback.",
    );
    expect(roles.agent.walletId).toBe("wallet-agent");
    expect(roles.mining.summary).toBe("Mining Wallet");
    expect(roles.mining.detail).toContain("singleton @wallet:mining wallet");
    expect(roles.mining.detail).not.toContain("attached wallet");
    expect(roles.mining.walletId).toBe("wallet-mining");
    expect(roles.bond.summary).toBe("Vault Wallet");
    expect(roles.bond.walletId).toBe("wallet-vault");
    expect(roles.sharedWalletWarning).toBeNull();
  });

  it("warns when Agent and mining share the same wallet", () => {
    const roles = resolveOperatorWalletRoles({
      status: {
        approvalAuth: {
          mode: "none",
          ready: false,
          passkeyCount: 0,
          notes: [],
          passkeys: [],
          statePath: "/tmp/passkeys.json",
        },
      } as never,
      namedWallets,
      defaultWalletId: "wallet-agent",
      federationBond: null,
      miningProfile: { walletId: "wallet-agent" } as never,
      miningReadiness: null,
      miningStatus: null,
    });

    expect(roles.sharedWalletWarning).toContain("must stay separate");
    expect(roles.sharedWalletWarning).not.toContain("detach");
    expect(roles.sharedWalletWarning).not.toContain("switch");
    expect(roles.agent.walletId).toBe("wallet-agent");
    expect(roles.mining.walletId).toBe("wallet-agent");
  });

  it("warns when no Agent wallet is configured", () => {
    const roles = resolveOperatorWalletRoles({
      status: null,
      namedWallets,
      defaultWalletId: null,
      federationBond: null,
      miningProfile: null,
      miningReadiness: null,
      miningStatus: null,
    });

    expect(roles.agent.summary).toBe("1 set · no fallback");
    expect(roles.agent.tone).toBe("warn");
    expect(roles.mining.summary).toBe("Not configured");
    expect(roles.mining.detail).toContain("Create or import @wallet:mining");
    expect(roles.mining.detail).not.toContain("Attach");
  });
});

describe("describeWalletRoleBadges", () => {
  it("keeps wallet cards free of duplicate text role chips", () => {
    expect(
      describeWalletRoleBadges("wallet-agent", {
        defaultWalletId: "wallet-agent",
        federationBond: null,
        namedWallets,
        miningProfile: { walletId: "wallet-mining" } as never,
        miningReadiness: null,
        miningStatus: null,
      }),
    ).toEqual([]);

    expect(
      describeWalletRoleBadges("wallet-mining", {
        defaultWalletId: "wallet-agent",
        federationBond: {
          walletId: "wallet-mining",
          status: "active",
        } as never,
        namedWallets,
        miningProfile: { walletId: "wallet-mining" } as never,
        miningReadiness: null,
        miningStatus: null,
      }),
    ).toEqual([]);

    expect(
      describeWalletRoleBadges("wallet-vault", {
        defaultWalletId: "wallet-agent",
        federationBond: null,
        namedWallets,
        miningProfile: { walletId: "wallet-mining" } as never,
        miningReadiness: null,
        miningStatus: null,
      }),
    ).toEqual([]);
  });

  it("blocks setting the Agent default to the SAT mining wallet", () => {
    expect(
      describeAgentDefaultAction("wallet-mining", {
        defaultWalletId: "wallet-agent",
        settingsBusy: false,
        namedWallets,
        miningProfile: { walletId: "wallet-mining" } as never,
        miningReadiness: null,
        miningStatus: null,
      }),
    ).toMatchObject({
      label: "Set fallback",
      disabled: true,
    });

    expect(
      describeAgentDefaultAction("wallet-agent", {
        defaultWalletId: "wallet-agent",
        settingsBusy: false,
        namedWallets,
        miningProfile: { walletId: "wallet-agent" } as never,
        miningReadiness: null,
        miningStatus: null,
      }),
    ).toMatchObject({
      label: "Clear fallback",
      disabled: false,
    });
  });
});

describe("describeAdminControlShortcut", () => {
  it("offers enable action when approval auth is still session-based", () => {
    expect(
      describeAdminControlShortcut({
        status: {
          approvalAuth: {
            mode: "none",
            ready: false,
            passkeyCount: 0,
            notes: [],
            passkeys: [],
            statePath: "/tmp/passkeys.json",
          },
        } as never,
        settingsBusy: false,
        passkeyBusy: false,
      }),
    ).toMatchObject({
      summary: "Optional",
      detail: expect.stringContaining("Agent or Mining wallet readiness"),
      enableVisible: true,
      enableLabel: "Add account passkey",
      enrollVisible: false,
    });
  });

  it("offers enrollment after webauthn is enabled but before a passkey exists", () => {
    expect(
      describeAdminControlShortcut({
        status: {
          approvalAuth: {
            mode: "webauthn",
            ready: false,
            passkeyCount: 0,
            notes: [],
            passkeys: [],
            statePath: "/tmp/passkeys.json",
          },
        } as never,
        settingsBusy: false,
        passkeyBusy: false,
      }),
    ).toMatchObject({
      summary: "Setup incomplete",
      detail: expect.stringContaining("Mining automation"),
      enableVisible: false,
      enrollVisible: true,
      enrollLabel: "Enroll passkey",
    });
  });

  it("does not offer another passkey on the primary wallet page when approval is ready", () => {
    expect(
      describeAdminControlShortcut({
        status: {
          approvalAuth: {
            mode: "webauthn",
            ready: true,
            passkeyCount: 1,
            notes: [],
            passkeys: [],
            statePath: "/tmp/passkeys.json",
          },
        } as never,
        settingsBusy: false,
        passkeyBusy: false,
      }),
    ).toMatchObject({
      summary: "Enabled",
      detail: expect.stringContaining("Mining autonomous signer policies"),
      enableVisible: false,
      enrollVisible: false,
    });
  });
});

describe("describeVaultSignerApproval", () => {
  it("keeps Vault optional and points enrollment to the signer-owner ceremony", () => {
    expect(
      describeVaultSignerApproval({
        nativeSignerApproval: {
          configured: true,
          ready: false,
          credentialCount: 0,
          credentialVersion: 1,
        },
      }),
    ).toMatchObject({
      summary: "Not enrolled",
      setupCommand: expect.stringContaining("fased-signer-owner webauthn-enroll"),
    });
  });

  it("reports signer-owned readiness without treating it as wallet creation readiness", () => {
    expect(
      describeVaultSignerApproval({
        nativeSignerApproval: {
          configured: true,
          ready: true,
          credentialCount: 2,
          credentialVersion: 4,
        },
      }),
    ).toEqual({
      summary: "Ready · 2 devices",
      detail:
        "The native signer has an approval device. This Vault still needs an acknowledged manual policy for the exact operation before Send becomes available.",
      setupCommand: null,
    });
  });
});

describe("describeWalletSendFlow", () => {
  it("explains that direct user send creates an approval request", () => {
    expect(
      describeWalletSendFlow({
        policy: { executionMode: "manual" },
        approvalAuth: { passkeyCount: 1 },
      } as never),
    ).toMatchObject({
      mode: "manual",
      submitLabel: "Create Approval Request",
    });
  });

  it("keeps direct user send reviewed even when automation policy is autonomous", () => {
    expect(
      describeWalletSendFlow({
        policy: { executionMode: "autonomous" },
        approvalAuth: { passkeyCount: 1 },
      } as never),
    ).toMatchObject({
      mode: "manual",
      submitLabel: "Create Approval Request",
    });
  });
});

describe("describeWalletAutomationPolicySummary", () => {
  it("explains when task/payment automation is disabled", () => {
    expect(
      describeWalletAutomationPolicySummary({
        policy: { directSigning: false },
      } as never),
    ).toMatchObject({
      label: "Automation off",
    });
    expect(
      describeWalletAutomationPolicySummary({
        policy: { directSigning: false },
      } as never).operatorDetail,
    ).toContain("not SAT mining cycle limits");
  });

  it("explains when task/payment automation is enabled", () => {
    expect(
      describeWalletAutomationPolicySummary({
        policy: { directSigning: true },
      } as never),
    ).toMatchObject({
      label: "Automation on",
    });
    expect(
      describeWalletAutomationPolicySummary({
        policy: { directSigning: true },
      } as never).detail,
    ).toContain("background actions");
  });
});

describe("orderWalletsForDisplay", () => {
  it("orders Mining first, then Vault, then Agent wallets", () => {
    expect(
      orderWalletsForDisplay([...namedWallets].toReversed(), {
        namedWallets,
        defaultWalletId: "wallet-agent",
        miningProfile: { walletId: "wallet-mining" } as never,
        miningReadiness: null,
        miningStatus: null,
      }).map((wallet) => wallet.id),
    ).toEqual(["wallet-mining", "wallet-vault", "wallet-agent"]);
  });
});

describe("renderWallet", () => {
  it("shows an unavailable balance instead of a false zero after an RPC read failure", () => {
    const text = flattenTemplateText(
      renderWalletForTest({
        namedWallets: namedWallets.map((wallet) => ({ ...wallet, balances: undefined })),
      }),
    );

    expect(text).toContain("Unavailable");
  });

  it("shows a compact Agent-to-wallet assignment control with skill precedence", () => {
    const text = flattenTemplateText(
      renderWalletForTest({
        mainPanel: "access",
        agents: [
          { id: "owner", name: "Owner" },
          { id: "research", name: "Research" },
        ],
        assignments: { research: "wallet-agent" },
        assignAgentId: "research",
        assignWalletId: "wallet-agent",
      }),
    );

    expect(text).toContain("Agent wallet routing");
    expect(text).toContain("Explicit handles and one-wallet skill grants take precedence");
    expect(text).toContain("Owner");
    expect(text).toContain("Research");
    expect(text).toContain("Current: wallet-agent");
    expect(text).toContain("Save");
    expect(text).toContain("Clear");
  });

  it("renders approval and activity amounts in human chain units", () => {
    const text = flattenTemplateText(
      renderWalletForTest({
        loading: false,
        error: null,
        status: {
          capabilities: { canSend: true, canEditPolicy: true },
          policy: { executionMode: "manual", directSigning: false },
          approvalAuth: {
            mode: "webauthn",
            ready: true,
            passkeyCount: 1,
            notes: [],
            passkeys: [],
            statePath: "/tmp/passkeys.json",
          },
        } as never,
        namedWallets,
        balancesLoading: false,
        balancesError: null,
        balances: {
          ok: true,
          chain: "all",
          provider: "embedded-keystore",
          walletId: "wallet-agent",
          walletName: "Primary Agent",
          balances: {
            solana: {
              ok: true,
              chain: "solana",
              balance: "3000000000",
              unit: "lamports",
            },
          },
          assets: {
            solana: [
              {
                id: "solana:spl-token:SatMint111111111111111111111111111111111",
                chain: "solana",
                kind: "spl-token",
                symbol: "SAT",
                name: "SAT",
                amountRaw: "31798000000000",
                amountDisplay: "317.98",
                decimals: 11,
                unit: "raw",
                isNative: false,
                address: "SatAta111111111111111111111111111111111111",
                program: "SatMint111111111111111111111111111111111",
                tokenProgramId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // pragma: allowlist secret
              },
            ],
          },
          checkedAt: "2026-04-09T12:00:00.000Z",
        },
        defaultWalletId: "wallet-agent",
        settingsBusy: false,
        settingsError: null,
        settingsMessage: null,
        settings: null,
        rpcChain: "solana",
        policySolMaxPerTx: "",
        policySolMaxDaily: "",
        actionMessage: null,
        passkeyBusy: false,
        passkeyError: null,
        passkeyLabel: "",
        auditEntries: [
          {
            id: "audit-0",
            at: "2026-04-09T11:59:00.000Z",
            action: "send_requested",
            details: {
              chain: "solana",
              amount: "100000000",
              to: "So11111111111111111111111111111111111111119",
            },
          },
          {
            id: "audit-1",
            at: "2026-04-09T12:00:00.000Z",
            action: "send_executed",
            details: {
              chain: "solana",
              amount: "100000000",
              to: "So11111111111111111111111111111111111111119",
              txHash: "solana-tx-1",
            },
          },
          {
            id: "audit-2",
            at: "2026-04-09T12:01:00.000Z",
            action: "send_requested",
            details: {
              chain: "solana",
              amount: "3041914712993",
              program: "SatMint111111111111111111111111111111111",
              to: "Vault11111111111111111111111111111111111111",
            },
          },
          {
            id: "audit-3",
            at: "2026-04-09T12:02:00.000Z",
            action: "send_executed",
            details: {
              chain: "solana",
              amount: "1234500",
              program: "MintNoLongerInBalance111111111111111111111",
              assetSymbol: "USDC",
              assetName: "USD Coin",
              assetDecimals: 6,
              to: "Vault11111111111111111111111111111111111111",
              txHash: "spl-tx-1",
            },
          },
        ] as never,
        activityPage: 1,
        sendModalVisible: false,
        onSendModalOpen: () => undefined,
        onSendModalClose: () => undefined,
        sendCreateBusy: false,
        sendCreateError: null,
        sendCreateForm: {
          chain: "solana",
          walletId: "wallet-agent",
          to: "",
          amount: "",
          program: "",
          memo: "",
        },
        walletDetailsWalletId: "",
        approvalsLoading: false,
        approvalsBusyId: null,
        approvalsError: null,
        approvalsFilter: "pending",
        approvals: [
          {
            id: "approval-1",
            createdAt: "2026-04-09T12:00:00.000Z",
            state: "pending",
            payload: {
              chain: "solana",
              amount: "100000000",
              to: "So11111111111111111111111111111111111111119",
            },
          },
        ] as never,
        onSendCreatePatch: () => undefined,
        onWalletDetailsWalletChange: () => undefined,
        onApprovalsFilterChange: () => undefined,
        onApproveRequest: () => undefined,
        onRejectRequest: () => undefined,
        onSetDefaultWallet: () => undefined,
        onPasskeyLabelChange: () => undefined,
        onEnablePasskeyApproval: () => undefined,
        onEnrollPasskey: () => undefined,
        onPatchSettings: () => undefined,
        onActivityPageChange: () => undefined,
        onRpcChainChange: () => undefined,
        onPolicyDraftChange: () => undefined,
        onSavePolicy: () => undefined,
        onRefresh: () => undefined,
        onCreateSendRequest: () => undefined,
        miningProfile: null,
        miningReadiness: null,
        miningStatus: null,
      }),
    );

    expect(text).toContain("Wallet Activity");
    expect(text).toContain("Recent send requests and outcomes.");
    expect(text).toContain("0.1 SOL");
    expect(text).toContain("30.42 SAT");
    expect(text).toContain("1.23 USDC");
    expect(text).toContain("Mint");
    expect(text).not.toContain("SOL 30.74 SAT");
    expect(text).not.toContain("3041.914712993 SOL");
    expect(text).toContain("Request created");
    expect(text).toContain("Executed");
    expect(text).toContain("Page");
    expect(text).toContain("Prev");
    expect(text).toContain("Next");
    expect(text).not.toContain("Operator Wallet Roles");
    expect(text).not.toContain("Global limits for both chains. Save to apply.");
    expect(text).not.toContain("Set Agent default");
    expect(text).not.toContain("Clear Agent default");
  });

  it("renders compact wallet cards with icon-only roles and a native balance pill", () => {
    const text = flattenTemplateText(
      renderWalletForTest({
        loading: false,
        error: null,
        status: {
          capabilities: { canSend: true, canEditPolicy: true },
          policy: { executionMode: "manual", directSigning: false },
          approvalAuth: {
            mode: "webauthn",
            ready: true,
            passkeyCount: 1,
            notes: [],
            passkeys: [],
            statePath: "/tmp/passkeys.json",
          },
        } as never,
        namedWallets,
        balancesLoading: false,
        balancesError: null,
        balances: null,
        defaultWalletId: "wallet-agent",
        settingsBusy: false,
        settingsError: null,
        settingsMessage: null,
        settings: null,
        rpcChain: "solana",
        policySolMaxPerTx: "",
        policySolMaxDaily: "",
        actionMessage: null,
        passkeyBusy: false,
        passkeyError: null,
        passkeyLabel: "",
        auditEntries: [],
        activityPage: 1,
        sendModalVisible: false,
        onSendModalOpen: () => undefined,
        onSendModalClose: () => undefined,
        sendCreateBusy: false,
        sendCreateError: null,
        sendCreateForm: {
          chain: "solana",
          walletId: "wallet-agent",
          to: "",
          amount: "",
          program: "",
          memo: "",
        },
        walletDetailsWalletId: "wallet-mining",
        expandedWalletId: "wallet-mining",
        expandedPanel: "security",
        approvalsLoading: false,
        approvalsBusyId: null,
        approvalsError: null,
        approvalsFilter: "pending",
        approvals: [],
        onSendCreatePatch: () => undefined,
        onWalletDetailsWalletChange: () => undefined,
        onApprovalsFilterChange: () => undefined,
        onApproveRequest: () => undefined,
        onRejectRequest: () => undefined,
        onSetDefaultWallet: () => undefined,
        onPasskeyLabelChange: () => undefined,
        onEnablePasskeyApproval: () => undefined,
        onEnrollPasskey: () => undefined,
        onPatchSettings: () => undefined,
        onActivityPageChange: () => undefined,
        onRpcChainChange: () => undefined,
        onPolicyDraftChange: () => undefined,
        onSavePolicy: () => undefined,
        onRefresh: () => undefined,
        onCreateSendRequest: () => undefined,
        miningProfile: { walletId: "wallet-mining" } as never,
        miningReadiness: {
          selectedWalletId: "wallet-mining",
          balances: {
            solBalanceDisplay: "4.321 SOL",
            satBalanceDisplay: "30.87 SAT",
          },
        } as never,
        miningStatus: null,
      }),
    );

    expect(text).toContain("Agent");
    expect(text).toContain("Mining");
    expect(text).toContain("Settings");
    expect(text).toContain("SAT");
    expect(text).toContain("Mining Wallet");
    expect(text).toContain("Sweep");
    expect(text).not.toContain("After each successful claim");
    expect(text).not.toContain("Browser storage");
    expect(text).not.toContain("Manual recovery, device shares, and compatibility");
    expect(text).not.toContain("Optional local helper");
    expect(text).not.toContain("Wallet Guide");
    expect(text).not.toContain("Legacy");
    expect(text).not.toContain("Interactive-only");
    expect(text).not.toContain("RPC ready");
    expect(text).not.toContain("Balances and RPC");
    expect(text).not.toContain("Primary Agent");
    expect(text).not.toContain("Bond active");
  });

  it("renders wallet skill grants without granting mining or vault wallet access", () => {
    const text = flattenTemplateText(
      renderWalletForTest({
        mainPanel: "skill-grants",
        skillGrantRows: [
          {
            skillId: "daily-dca",
            source: "clawhub",
            registry: "https://clawhub.com",
            version: "1.0.0",
            requestedWalletActions: {
              actions: ["quote", "swap"],
              roles: ["agent"],
              chains: ["solana"],
              autonomous: true,
            },
            grantedWalletActions: null,
            requestedPermissionRisky: true,
            autonomousRequested: true,
            autonomousGranted: false,
            cronRequested: false,
            cronGranted: false,
          },
        ],
        skillGrantDraft: {
          skillId: "daily-dca",
          actions: ["quote", "swap"],
          walletIds: "wallet-agent",
          chain: "solana",
          registry: "https://clawhub.com",
          inputMints: "",
          outputMints: "",
          maxAmount: "1000000",
          maxSlippageBps: "50",
          autonomous: true,
          cron: false,
        },
      }),
    );

    expect(text).toContain("Skill Grants");
    expect(text).toContain("daily-dca");
    expect(text).toContain("Agent wallet ids");
    expect(text).toContain("quote, swap");
  });

  it("renders Agent policy without legacy custody controls", () => {
    const text = flattenTemplateText(
      renderWalletForTest({
        loading: false,
        error: null,
        status: {
          capabilities: { canSend: true, canEditPolicy: true },
          policy: {
            executionMode: "manual",
            directSigning: true,
            toolAccessMode: "owner-only",
            allowAgents: [],
            solana: {
              allowPrograms: [],
              maxPerTx: "1000000000",
              maxDaily: "5000000000",
            },
          },
          approvalAuth: {
            mode: "webauthn",
            ready: true,
            passkeyCount: 1,
            notes: [],
            passkeys: [],
            statePath: "/tmp/passkeys.json",
          },
        } as never,
        namedWallets,
        balancesLoading: false,
        balancesError: null,
        balances: null,
        defaultWalletId: "wallet-agent",
        settingsBusy: false,
        settingsError: null,
        settingsMessage: null,
        settings: {
          providerId: "local-socket-signer",
          execution: { mode: "manual" },
          approvalAuth: { mode: "webauthn", challengeTtlSeconds: 300, grantTtlSeconds: 900 },
          policy: {
            directSigning: true,
            solana: { allowPrograms: [], maxPerTx: "1000000000", maxDaily: "5000000000" },
          },
          signerPolicy: {
            state: "locked",
            walletId: "wallet-agent",
            role: "agent",
            version: 3,
            hash: `sha256:${"e".repeat(64)}`,
            operations: [],
            programs: [],
            assets: [],
            guidance:
              "Review the immutable role, then run fased wallet policy activate-role-baseline.",
          },
          toolAccess: { mode: "owner-only", allowAgents: [] },
          providerCredentials: {
            configured: false,
            providerId: "local-socket-signer",
            fields: [],
            path: "/tmp/none",
            source: "none",
          },
          rpc: {
            configured: true,
            providerId: "local-socket-signer",
            chain: "solana",
            provider: "custom",
            path: "/tmp/rpc",
          },
          checkedAt: new Date().toISOString(),
        } as never,
        rpcChain: "solana",
        policySolMaxPerTx: "1",
        policySolMaxDaily: "5",
        policySolanaAllowPrograms: "",
        auditEntries: [],
        activityPage: 1,
        sendModalVisible: false,
        onSendModalOpen: () => undefined,
        onSendModalClose: () => undefined,
        sendCreateBusy: false,
        sendCreateError: null,
        sendCreateForm: {
          chain: "solana",
          walletId: "wallet-agent",
          to: "",
          amount: "",
          program: "",
          memo: "",
        },
        walletDetailsWalletId: "wallet-agent",
        expandedWalletId: "wallet-agent",
        expandedPanel: "security",
        approvalsLoading: false,
        approvalsBusyId: null,
        approvalsError: null,
        approvalsFilter: "pending",
        approvals: [],
        onSendCreatePatch: () => undefined,
        onWalletDetailsWalletChange: () => undefined,
        onApprovalsFilterChange: () => undefined,
        onApproveRequest: () => undefined,
        onRejectRequest: () => undefined,
        onSetDefaultWallet: () => undefined,
        onPasskeyLabelChange: () => undefined,
        onEnablePasskeyApproval: () => undefined,
        onEnrollPasskey: () => undefined,
        onApplyRecommendedPolicy: () => undefined,
        onPatchSettings: () => undefined,
        onActivityPageChange: () => undefined,
        onRpcChainChange: () => undefined,
        onPolicyDraftChange: () => undefined,
        onSavePolicy: () => undefined,
        onRefresh: () => undefined,
        onCreateSendRequest: () => undefined,
        miningProfile: null,
        miningReadiness: null,
        miningStatus: null,
      }),
    );

    expect(text).toContain("Limits");
    expect(text).toContain("Off");
    expect(text).toContain("SOL");
    expect(text).toContain("Preset");
    expect(text).toContain("Send");
    expect(text).toContain("Auto");
    expect(text).toContain("Save");
    expect(text).not.toContain("Caps are normal display amounts");
    expect(text).not.toContain("Add asset cap");
    expect(text).not.toContain("Enable security");
    expect(text).toContain("Tx");
    expect(text).toContain("Small Agent spend");
    expect(text).toContain("Wallet setup incomplete");
    expect(text).toContain("Run Fased Update to finish this wallet automatically.");
    expect(text).not.toContain("Version 3");
    expect(text).not.toContain(`sha256:${"e".repeat(64)}`);
    expect(text).not.toContain("fased wallet policy activate-role-baseline");
    expect(text).not.toContain("Selected Wallet Policy");
    expect(text).not.toContain("Advanced spend caps");
    expect(text).not.toContain("Apply recommended Agent template");
    expect(text).not.toContain("Solana program allowlist");
    expect(text).not.toContain("Manual recovery, device shares, and compatibility");
    expect(text).not.toContain("Recovery and device transfer (advanced)");
    expect(text).not.toContain(
      "Browser-held encrypted storage is the primary off-host path on this device.",
    );
    expect(text).not.toContain("Wallet Guide");
  });

  it("renders token approvals with token amount instead of native chain amount", () => {
    const text = flattenTemplateText(
      renderWalletForTest({
        loading: false,
        error: null,
        status: {
          capabilities: { canSend: true, canEditPolicy: true },
          policy: { executionMode: "manual", directSigning: false },
          approvalAuth: {
            mode: "webauthn",
            ready: true,
            passkeyCount: 1,
            notes: [],
            passkeys: [],
            statePath: "/tmp/passkeys.json",
          },
        } as never,
        namedWallets,
        balancesLoading: false,
        balancesError: null,
        balances: null,
        defaultWalletId: "wallet-agent",
        settingsBusy: false,
        settingsError: null,
        settingsMessage: null,
        settings: null,
        rpcChain: "solana",
        policySolMaxPerTx: "",
        policySolMaxDaily: "",
        actionMessage: null,
        passkeyBusy: false,
        passkeyError: null,
        passkeyLabel: "",
        auditEntries: [],
        activityPage: 1,
        sendModalVisible: false,
        onSendModalOpen: () => undefined,
        onSendModalClose: () => undefined,
        sendCreateBusy: false,
        sendCreateError: null,
        sendCreateForm: {
          chain: "solana",
          walletId: "wallet-mining",
          assetId: "solana:spl-token:SatMint",
          to: "",
          amount: "",
          program: "SatMint",
          memo: "",
        },
        walletDetailsWalletId: "wallet-mining",
        approvalsLoading: false,
        approvalsBusyId: null,
        approvalsError: null,
        approvalsFilter: "pending",
        approvals: [
          {
            id: "approval-sat-1",
            createdAt: "2026-04-13T22:38:39.000Z",
            expiresAt: "2026-04-13T22:53:39.000Z",
            status: "pending",
            requestedBy: "control-ui",
            payload: {
              chain: "solana",
              amount: "100000000000",
              amountDisplay: "1",
              assetSymbol: "SAT",
              assetName: "SAT Token",
              assetId: "solana:spl-token:SatMint",
              walletId: "wallet-mining",
              walletName: "Mining Wallet",
              program: "SatMint",
              to: "DSUtCCvUFakeRecipientRgmE4b",
            },
            approvalDiff: {
              fromWalletId: "wallet-mining",
              fromWalletName: "Mining Wallet",
              fromRole: "mining",
              to: "DSUtCCvUFakeRecipientRgmE4b",
              chain: "solana",
              token: "SAT",
              mint: "SatMint",
              amount: "100000000000",
              amountDisplay: "1",
              source: "control-ui",
            },
          },
        ],
        onSendCreatePatch: () => undefined,
        onWalletDetailsWalletChange: () => undefined,
        onApprovalsFilterChange: () => undefined,
        onApproveRequest: () => undefined,
        onRejectRequest: () => undefined,
        onSetDefaultWallet: () => undefined,
        onPasskeyLabelChange: () => undefined,
        onEnablePasskeyApproval: () => undefined,
        onEnrollPasskey: () => undefined,
        onPatchSettings: () => undefined,
        onActivityPageChange: () => undefined,
        onRpcChainChange: () => undefined,
        onPolicyDraftChange: () => undefined,
        onSavePolicy: () => undefined,
        onRefresh: () => undefined,
        onCreateSendRequest: () => undefined,
        miningProfile: null,
        miningReadiness: null,
        miningStatus: null,
      }),
    );

    expect(text).toContain("1");
    expect(text).toContain("SAT Token");
    expect(text).toContain("From");
    expect(text).toContain("So..13");
    expect(text).toContain("To");
    expect(text).toContain("Spend 1 SAT");
    expect(text).toContain("triggered by control-ui");
    expect(text).toContain("Approve");
    expect(text).toContain("Reject");
    expect(text).not.toContain("100 SOL");
  });

  it("renders legacy token approvals from wallet asset metadata instead of native sol amount", () => {
    const text = flattenTemplateText(
      renderWalletForTest({
        loading: false,
        error: null,
        status: {
          capabilities: { canSend: true, canEditPolicy: true },
          policy: { executionMode: "manual", directSigning: false },
          approvalAuth: {
            mode: "webauthn",
            ready: true,
            passkeyCount: 1,
            notes: [],
            passkeys: [],
            statePath: "/tmp/passkeys.json",
          },
        } as never,
        namedWallets,
        balancesLoading: false,
        balancesError: null,
        balances: {
          ok: true,
          chain: "all",
          provider: "embedded-keystore",
          walletId: "wallet-mining",
          walletName: "Mining Wallet",
          balances: {
            solana: {
              ok: true,
              chain: "solana",
              balance: "3000000000",
              unit: "lamports",
            },
          },
          assets: {
            solana: [
              {
                id: "solana:native",
                chain: "solana",
                kind: "native",
                symbol: "SOL",
                name: "Solana",
                amountRaw: "3000000000",
                amountDisplay: "3",
                decimals: 9,
                unit: "lamports",
                isNative: true,
                address: "So11111111111111111111111111111111111111113",
              },
              {
                id: "solana:spl-token:SatMint",
                chain: "solana",
                kind: "spl-token",
                symbol: "SAT",
                name: "SAT Token",
                amountRaw: "100000000000",
                amountDisplay: "1",
                decimals: 11,
                unit: "raw",
                isNative: false,
                address: "Ata1111111111111111111111111111111111111111",
                program: "SatMint",
                tokenProgramId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // pragma: allowlist secret
              },
            ],
          },
          checkedAt: "2026-04-13T22:38:39.000Z",
        },
        defaultWalletId: "wallet-agent",
        settingsBusy: false,
        settingsError: null,
        settingsMessage: null,
        settings: null,
        rpcChain: "solana",
        policySolMaxPerTx: "",
        policySolMaxDaily: "",
        actionMessage: null,
        passkeyBusy: false,
        passkeyError: null,
        passkeyLabel: "",
        auditEntries: [],
        activityPage: 1,
        sendModalVisible: false,
        onSendModalOpen: () => undefined,
        onSendModalClose: () => undefined,
        sendCreateBusy: false,
        sendCreateError: null,
        sendCreateForm: {
          chain: "solana",
          walletId: "wallet-mining",
          assetId: "solana:spl-token:SatMint",
          to: "",
          amount: "",
          program: "SatMint",
          memo: "",
        },
        walletDetailsWalletId: "wallet-mining",
        approvalsLoading: false,
        approvalsBusyId: null,
        approvalsError: null,
        approvalsFilter: "pending",
        approvals: [
          {
            id: "approval-sat-legacy-1",
            createdAt: "2026-04-13T22:38:39.000Z",
            expiresAt: "2026-04-13T22:53:39.000Z",
            status: "pending",
            requestedBy: "control-ui",
            payload: {
              chain: "solana",
              amount: "100000000000",
              walletId: "wallet-mining",
              walletName: "Mining Wallet",
              program: "SatMint",
              to: "DSUtCCvUFakeRecipientRgmE4b",
            },
          },
        ],
        onSendCreatePatch: () => undefined,
        onWalletDetailsWalletChange: () => undefined,
        onApprovalsFilterChange: () => undefined,
        onApproveRequest: () => undefined,
        onRejectRequest: () => undefined,
        onSetDefaultWallet: () => undefined,
        onPasskeyLabelChange: () => undefined,
        onEnablePasskeyApproval: () => undefined,
        onEnrollPasskey: () => undefined,
        onPatchSettings: () => undefined,
        onActivityPageChange: () => undefined,
        onRpcChainChange: () => undefined,
        onPolicyDraftChange: () => undefined,
        onSavePolicy: () => undefined,
        onRefresh: () => undefined,
        onCreateSendRequest: () => undefined,
        miningProfile: null,
        miningReadiness: null,
        miningStatus: null,
      }),
    );

    expect(text).toContain("1");
    expect(text).toContain("SAT Token");
    expect(text).toContain("From");
    expect(text).toContain("So..13");
    expect(text).toContain("To");
    expect(text).not.toContain("100 SOL");
  });

  it("shows source wallet name and source address in the send modal", () => {
    const text = flattenTemplateText(
      renderWalletForTest({
        loading: false,
        error: null,
        status: {
          capabilities: { canSend: true, canEditPolicy: true },
          policy: { executionMode: "manual", directSigning: false },
          approvalAuth: {
            mode: "webauthn",
            ready: true,
            passkeyCount: 1,
            notes: [],
            passkeys: [],
            statePath: "/tmp/passkeys.json",
          },
        } as never,
        namedWallets,
        balancesLoading: false,
        balancesError: null,
        balances: null,
        defaultWalletId: "wallet-agent",
        settingsBusy: false,
        settingsError: null,
        settingsMessage: null,
        settings: null,
        rpcChain: "solana",
        policySolMaxPerTx: "",
        policySolMaxDaily: "",
        actionMessage: null,
        passkeyBusy: false,
        passkeyError: null,
        passkeyLabel: "",
        auditEntries: [],
        activityPage: 1,
        sendModalVisible: true,
        onSendModalOpen: () => undefined,
        onSendModalClose: () => undefined,
        sendCreateBusy: false,
        sendCreateError: null,
        sendCreateForm: {
          chain: "solana",
          walletId: "wallet-mining",
          walletName: "Mining Wallet",
          to: "",
          amount: "",
          program: "",
          memo: "",
        },
        walletDetailsWalletId: "wallet-mining",
        approvalsLoading: false,
        approvalsBusyId: null,
        approvalsError: null,
        approvalsFilter: "pending",
        approvals: [],
        onSendCreatePatch: () => undefined,
        onWalletDetailsWalletChange: () => undefined,
        onApprovalsFilterChange: () => undefined,
        onApproveRequest: () => undefined,
        onRejectRequest: () => undefined,
        onSetDefaultWallet: () => undefined,
        onPasskeyLabelChange: () => undefined,
        onEnablePasskeyApproval: () => undefined,
        onEnrollPasskey: () => undefined,
        onPatchSettings: () => undefined,
        onActivityPageChange: () => undefined,
        onRpcChainChange: () => undefined,
        onPolicyDraftChange: () => undefined,
        onSavePolicy: () => undefined,
        onRefresh: () => undefined,
        onCreateSendRequest: () => undefined,
        miningProfile: { walletId: "wallet-mining" } as never,
        miningReadiness: null,
        miningStatus: null,
      }),
    );

    expect(text).toContain("Send Asset");
    expect(text).toContain("From");
    expect(text).toContain("Mining Wallet");
    expect(text).toContain("wallet-mining");
    expect(text).toContain("So11...1113");
    expect(text).toContain("Destination");
    expect(text).not.toContain("Source Wallet");
  });

  it("renders card balance expansion and token-aware send labels for Solana wallets", () => {
    const text = flattenTemplateText(
      renderWalletForTest({
        loading: false,
        error: null,
        status: {
          capabilities: { canSend: true, canEditPolicy: true },
          policy: { executionMode: "manual", directSigning: false },
          approvalAuth: {
            mode: "webauthn",
            ready: true,
            passkeyCount: 1,
            notes: [],
            passkeys: [],
            statePath: "/tmp/passkeys.json",
          },
        } as never,
        namedWallets,
        balancesLoading: false,
        balancesError: null,
        balances: {
          ok: true,
          chain: "all",
          provider: "embedded-keystore",
          walletId: "wallet-mining",
          walletName: "Mining Wallet",
          balances: {
            solana: {
              ok: true,
              chain: "solana",
              balance: "3000000000",
              unit: "lamports",
            },
          },
          assets: {
            solana: [
              {
                id: "solana:native",
                chain: "solana",
                kind: "native",
                symbol: "SOL",
                name: "Solana",
                amountRaw: "3000000000",
                amountDisplay: "3",
                decimals: 9,
                unit: "lamports",
                isNative: true,
                address: "So11111111111111111111111111111111111111113",
              },
              {
                id: "solana:spl-token:mint-usdc",
                chain: "solana",
                kind: "spl-token",
                symbol: "USDC",
                name: "USD Coin",
                amountRaw: "1234500",
                amountDisplay: "1.2345",
                decimals: 6,
                unit: "raw",
                isNative: false,
                address: "Ata1111111111111111111111111111111111111111",
                program: "mint-usdc",
                tokenProgramId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // pragma: allowlist secret
                logoUri: "https://img.example/usdc.png",
                verificationStatus: "verified",
                verificationSource: "jupiter",
                priceUsd: 1,
                valueUsd: 1.2345,
                tags: ["verified"],
              },
            ],
          },
          checkedAt: "2026-04-09T12:00:00.000Z",
        },
        defaultWalletId: "wallet-agent",
        settingsBusy: false,
        settingsError: null,
        settingsMessage: null,
        settings: null,
        rpcChain: "solana",
        policySolMaxPerTx: "",
        policySolMaxDaily: "",
        actionMessage: null,
        passkeyBusy: false,
        passkeyError: null,
        passkeyLabel: "",
        auditEntries: [],
        activityPage: 1,
        sendModalVisible: true,
        onSendModalOpen: () => undefined,
        onSendModalClose: () => undefined,
        sendCreateBusy: false,
        sendCreateError: null,
        sendCreateForm: {
          chain: "solana",
          walletId: "wallet-mining",
          walletName: "Mining Wallet",
          assetId: "solana:spl-token:mint-usdc",
          to: "",
          amount: "",
          program: "mint-usdc",
          memo: "",
        },
        walletDetailsWalletId: "wallet-mining",
        approvalsLoading: false,
        approvalsBusyId: null,
        approvalsError: null,
        approvalsFilter: "pending",
        approvals: [],
        onSendCreatePatch: () => undefined,
        onWalletDetailsWalletChange: () => undefined,
        onApprovalsFilterChange: () => undefined,
        onApproveRequest: () => undefined,
        onRejectRequest: () => undefined,
        onSetDefaultWallet: () => undefined,
        onPasskeyLabelChange: () => undefined,
        onEnablePasskeyApproval: () => undefined,
        onEnrollPasskey: () => undefined,
        onPatchSettings: () => undefined,
        onActivityPageChange: () => undefined,
        onRpcChainChange: () => undefined,
        onPolicyDraftChange: () => undefined,
        onSavePolicy: () => undefined,
        onRefresh: () => undefined,
        onCreateSendRequest: () => undefined,
        miningProfile: { walletId: "wallet-mining" } as never,
        miningReadiness: null,
        miningStatus: null,
      }),
    );

    expect(text).not.toContain("Asset Inventory");
    expect(text).toContain("Balance");
    expect(text).toContain("USDC");
    expect(text).toContain("USD Coin");
    expect(text).toContain("1.2");
  });

  it("renders exact signer-bound Trigger and Vault semantics in approval cards", () => {
    const text = flattenTemplateText(
      renderWalletForTest({
        approvals: [
          {
            id: "trigger-review-1",
            createdAt: "2026-07-17T10:00:00.000Z",
            expiresAt: "2026-07-17T10:15:00.000Z",
            status: "pending",
            requestedBy: "control-ui",
            payload: {
              chain: "solana",
              actionKind: "signer_review",
              signerSemanticIntent: {
                type: "solana.jupiter.trigger.create",
                jupiter: {
                  owner: "Owner1111111111111111111111111111111111111",
                  inputMint: "InputMint111111111111111111111111111111111",
                  outputMint: "OutputMint11111111111111111111111111111111",
                  inputAmount: "2500000",
                  maxInputAmount: "2500000",
                  minimumOutputAmount: "0",
                  maxFeeLamports: "5000",
                  programs: ["TriggerProgram111111111111111111111111111111"],
                  trigger: {
                    operation: "create",
                    program: "TriggerProgram111111111111111111111111111111",
                    triggerMint: "TriggerMint1111111111111111111111111111111",
                    condition: "below",
                    targetPriceUsd: "123.45",
                    slippageBps: 75,
                    expiresAt: "2026-07-18T10:00:00.000Z",
                    expectedOrderState: "new",
                  },
                },
              },
            },
          },
          {
            id: "vault-review-1",
            createdAt: "2026-07-17T10:00:00.000Z",
            expiresAt: "2026-07-17T10:15:00.000Z",
            status: "pending",
            requestedBy: "control-ui",
            payload: {
              chain: "solana",
              actionKind: "signer_review",
              signerSemanticIntent: {
                type: "solana.vaultBondAction",
                cluster: "mainnet-beta",
                action: "bond.release",
                programId: "BondProgram11111111111111111111111111111111",
                dataBase64: "AA==",
                keys: [],
                context: {
                  targetAuthority: "Target111111111111111111111111111111111111",
                  intervalStartCycleId: "cycle-42",
                },
              },
            },
          },
        ],
      }),
    );

    expect(text).toContain("Signer intent solana.jupiter.trigger.create");
    expect(text).toContain("Input mint : InputMint111111111111111111111111111111111");
    expect(text).toContain("Condition : below");
    expect(text).toContain("Target price (USD) : 123.45");
    expect(text).toContain("Slippage (bps) : 75");
    expect(text).toContain("Order expiry : 2026-07-18T10:00:00.000Z");
    expect(text).toContain("Trigger mint : TriggerMint1111111111111111111111111111111");
    expect(text).toContain("Signer intent solana.vaultBondAction");
    expect(text).toContain("Vault action : bond.release");
    expect(text).toContain("Target authority : Target111111111111111111111111111111111111");
    expect(text).not.toContain("Do not approve this Trigger review");
  });

  it("collapses fallback mint-derived token identity in the send summary", () => {
    const text = flattenTemplateText(
      renderWalletForTest({
        loading: false,
        error: null,
        status: {
          capabilities: { canSend: true, canEditPolicy: true },
          policy: { executionMode: "manual", directSigning: false },
          approvalAuth: {
            mode: "webauthn",
            ready: true,
            passkeyCount: 1,
            notes: [],
            passkeys: [],
            statePath: "/tmp/passkeys.json",
          },
        } as never,
        namedWallets,
        balancesLoading: false,
        balancesError: null,
        balances: {
          ok: true,
          chain: "all",
          provider: "embedded-keystore",
          walletId: "wallet-mining",
          walletName: "Mining Wallet",
          balances: {
            solana: {
              ok: true,
              chain: "solana",
              balance: "3000000000",
              unit: "lamports",
            },
          },
          assets: {
            solana: [
              {
                id: "solana:spl-token:unknown",
                chain: "solana",
                kind: "spl-token",
                symbol: "2QWA…VFP7",
                name: "Token 2QWA…VFP7",
                amountRaw: "1445983921855608",
                amountDisplay: "14459.83921855608",
                decimals: 11,
                unit: "raw",
                isNative: false,
                address: "Ata1111111111111111111111111111111111111111",
                program: "2qwAVnGm1234567890123456789kg1jVfP7",
                tokenProgramId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // pragma: allowlist secret
              },
            ],
          },
          checkedAt: "2026-04-09T12:00:00.000Z",
        },
        defaultWalletId: "wallet-agent",
        settingsBusy: false,
        settingsError: null,
        settingsMessage: null,
        settings: null,
        rpcChain: "solana",
        policySolMaxPerTx: "",
        policySolMaxDaily: "",
        actionMessage: null,
        passkeyBusy: false,
        passkeyError: null,
        passkeyLabel: "",
        auditEntries: [],
        activityPage: 1,
        sendModalVisible: true,
        onSendModalOpen: () => undefined,
        onSendModalClose: () => undefined,
        sendCreateBusy: false,
        sendCreateError: null,
        sendCreateForm: {
          chain: "solana",
          walletId: "wallet-mining",
          walletName: "Mining Wallet",
          assetId: "solana:spl-token:unknown",
          to: "",
          amount: "",
          program: "2qwAVnGm1234567890123456789kg1jVfP7",
          memo: "",
        },
        walletDetailsWalletId: "wallet-mining",
        approvalsLoading: false,
        approvalsBusyId: null,
        approvalsError: null,
        approvalsFilter: "pending",
        approvals: [],
        onSendCreatePatch: () => undefined,
        onWalletDetailsWalletChange: () => undefined,
        onApprovalsFilterChange: () => undefined,
        onApproveRequest: () => undefined,
        onRejectRequest: () => undefined,
        onSetDefaultWallet: () => undefined,
        onPasskeyLabelChange: () => undefined,
        onEnablePasskeyApproval: () => undefined,
        onEnrollPasskey: () => undefined,
        onPatchSettings: () => undefined,
        onActivityPageChange: () => undefined,
        onRpcChainChange: () => undefined,
        onPolicyDraftChange: () => undefined,
        onSavePolicy: () => undefined,
        onRefresh: () => undefined,
        onCreateSendRequest: () => undefined,
        miningProfile: { walletId: "wallet-mining" } as never,
        miningReadiness: null,
        miningStatus: null,
      }),
    );

    expect(text).toContain("2QWA…VFP7");
    expect(text).toContain("14,459.8");
    expect(text).not.toContain("SPL Mint (optional)");
  });
});
