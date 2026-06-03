import { describe, expect, it, vi } from "vitest";
import {
  clearWalletSkillGrant,
  createEmptyWalletSkillGrantDraft,
  draftFromWalletSkillRow,
  loadWalletSkillGrants,
  saveWalletSkillGrant,
  type WalletSkillGrantsState,
} from "./wallet-skill-grants.ts";

function createState(): { state: WalletSkillGrantsState; request: ReturnType<typeof vi.fn> } {
  const request = vi.fn();
  const state: WalletSkillGrantsState = {
    client: { request } as unknown as WalletSkillGrantsState["client"],
    connected: true,
    walletSkillGrantsLoading: false,
    walletSkillGrantsError: null,
    walletSkillGrantsMessage: null,
    walletSkillGrantsWorkspace: null,
    walletSkillGrantRows: [],
    walletSkillGrantDraft: createEmptyWalletSkillGrantDraft(),
    walletSkillGrantBusy: false,
  };
  return { state, request };
}

describe("wallet skill grants", () => {
  it("loads grants and seeds the draft from the first row", async () => {
    const { state, request } = createState();
    request.mockResolvedValue({
      workspaceDir: "/tmp/workspace",
      rows: [
        {
          skillId: "daily-dca",
          source: "clawhub",
          registry: "https://clawhub.com",
          version: "1.0.0",
          requestedWalletActions: { actions: ["quote", "swap"], chains: ["solana"] },
          grantedWalletActions: null,
          requestedPermissionRisky: true,
          autonomousRequested: false,
          autonomousGranted: false,
          cronRequested: false,
          cronGranted: false,
        },
      ],
    });

    await loadWalletSkillGrants(state);

    expect(request).toHaveBeenCalledWith("skills.wallet.grants", {});
    expect(state.walletSkillGrantsWorkspace).toBe("/tmp/workspace");
    expect(state.walletSkillGrantDraft.skillId).toBe("daily-dca");
    expect(state.walletSkillGrantDraft.actions).toEqual(["quote", "swap"]);
  });

  it("saves narrow wallet grant params through the gateway", async () => {
    const { state, request } = createState();
    state.walletSkillGrantDraft = {
      skillId: "daily-dca",
      actions: ["swap"],
      chain: "solana",
      registry: "https://clawhub.com",
      walletIds: "agent-1",
      inputMints: "So111",
      outputMints: "Token111",
      maxAmount: "1000",
      maxSlippageBps: "50",
      autonomous: true,
      cron: false,
    };
    request.mockResolvedValue({ workspaceDir: "/tmp/workspace", rows: [] });

    await saveWalletSkillGrant(state);

    expect(request).toHaveBeenCalledWith("skills.wallet.grant.set", {
      skillId: "daily-dca",
      actions: ["swap"],
      registry: ["https://clawhub.com"],
      walletId: ["agent-1"],
      chain: ["solana"],
      inputMint: ["So111"],
      outputMint: ["Token111"],
      maxAmount: "1000",
      maxSlippageBps: "50",
      autonomous: true,
      cron: false,
    });
    expect(state.walletSkillGrantsMessage).toContain("Saved wallet grant");
  });

  it("clears a wallet grant through the gateway", async () => {
    const { state, request } = createState();
    state.walletSkillGrantDraft = {
      skillId: "daily-dca",
      actions: ["swap"],
      chain: "solana",
      registry: "https://clawhub.com",
      walletIds: "",
      inputMints: "",
      outputMints: "",
      maxAmount: "1000",
      maxSlippageBps: "50",
      autonomous: false,
      cron: false,
    };
    request.mockResolvedValue({
      workspaceDir: "/tmp/workspace",
      rows: [
        {
          skillId: "daily-dca",
          source: "clawhub",
          registry: "https://clawhub.com",
          version: "1.0.0",
          requestedWalletActions: { actions: ["quote"], chains: ["solana"] },
          grantedWalletActions: null,
          requestedPermissionRisky: false,
          autonomousRequested: false,
          autonomousGranted: false,
          cronRequested: false,
          cronGranted: false,
        },
      ],
    });

    await clearWalletSkillGrant(state, "daily-dca");

    expect(request).toHaveBeenCalledWith("skills.wallet.grant.clear", { skillId: "daily-dca" });
    expect(state.walletSkillGrantDraft.actions).toEqual(["quote"]);
    expect(state.walletSkillGrantDraft.maxAmount).toBe("");
  });

  it("prefills existing grants before requested permissions", () => {
    const draft = draftFromWalletSkillRow({
      skillId: "daily-dca",
      source: "clawhub",
      registry: "https://clawhub.com",
      version: "1.0.0",
      requestedWalletActions: { actions: ["quote"], chains: ["solana"] },
      grantedWalletActions: { actions: ["swap"], chains: ["solana"], maxAmount: "1000" },
      requestedPermissionRisky: true,
      autonomousRequested: false,
      autonomousGranted: false,
      cronRequested: false,
      cronGranted: false,
    });

    expect(draft.actions).toEqual(["swap"]);
    expect(draft.maxAmount).toBe("1000");
  });
});
