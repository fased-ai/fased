import { describe, expect, it } from "vitest";
import {
  describeAdminControlShortcut,
  describeWalletAutomationPolicySummary,
  describeWalletSendFlow,
  renderWallet,
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
      createName: "Reserve",
      createRpcUrl: "https://rpc.example/solana",
    });
    const text = flattenTemplateText(rendered);
    expect(text).toContain("Create wallet");
    expect(text).toContain("Name (optional)");
    expect(text).not.toContain("Wallet role");
    expect(text).not.toContain("Select a role");
    expect(text).toContain("Use a signer-owned verified profile, or enter a direct RPC below");
    expect(text).not.toContain("capped automation");
    expect(text).not.toContain("singleton SAT operations");
    expect(text).not.toContain("reviewed operations only");
    expect(text).not.toContain("Custody provider");
    expect(text).not.toContain("Permanent wallet ID");
    expect(text).not.toContain("Choose a wallet role; Agent is never selected silently.");
    expect(text).toContain("Connect wallet");
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

    expect(text).toContain("RPC **** Limits");
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
      detail: expect.stringContaining("Wallet permissions are configured separately"),
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
      detail: expect.stringContaining("Agent automation"),
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
      detail: expect.stringContaining("Autonomous signer policies"),
      enableVisible: false,
      enrollVisible: false,
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
    ).toContain("signer independently enforces");
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

describe("renderWallet", () => {
  it("shows purpose labels without changing wallet identity or authority metadata", () => {
    const wallet = {
      ...namedWallets[0],
      name: "Wallet",
      metadata: { role: "agent", walletModel: 1, purposeLabels: ["WEN", "News"] },
    };
    const before = JSON.stringify(wallet);
    const text = flattenTemplateText(renderWalletForTest({ namedWallets: [wallet] }));
    expect(text).toContain("WEN");
    expect(text).toContain("News");
    expect(JSON.stringify(wallet)).toBe(before);
  });

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

    expect(text).toContain("Agent assignments");
    expect(text).toContain("Explicit handles and scoped wallet grants take precedence");
    expect(text).toContain("Owner");
    expect(text).toContain("Research");
    expect(text).toContain("Current: wallet-agent");
    expect(text).toContain("Save");
    expect(text).toContain("Clear");
  });

  it("redirects stale skill-grant panel state to ordinary wallets", () => {
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

    expect(text).toContain("Wallets");
    expect(text).not.toContain("Skill Grants");
    expect(text).not.toContain("daily-dca");
    expect(text).not.toContain("Agent wallet ids");
  });
});
