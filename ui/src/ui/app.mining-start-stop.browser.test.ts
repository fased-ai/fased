import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./app-lifecycle.ts", () => ({
  handleConnected: vi.fn(),
  handleDisconnected: vi.fn(),
  handleFirstUpdated: vi.fn(),
  handleUpdated: vi.fn(),
}));

type FixtureStatus = {
  running: boolean;
  enabledWanted: boolean;
  walletId: string;
  network: "devnet";
  riskMode: "balanced";
  blocked: boolean;
  nextAction: "wait" | "starting";
  nextActionDetail: string;
  updatedAt: string;
  currentSolBalanceLamports?: string;
  currentSatBalanceRaw?: string;
  currentCapitalFundedLamports?: string;
  currentCapitalLockedLamports?: string;
  currentCapitalFreeLamports?: string;
  activeCommitLamports?: string;
  recentActions: Array<{
    action: string;
    txHash: string | null;
    status: "success" | "failure";
    at: string;
    message?: string | null;
  }>;
  recentPlannerOutcomes?: FixturePlannerOutcome[];
  settledHistory?: FixturePlannerOutcome[];
  archivedFailures: Array<never>;
};

type FixturePlannerOutcome = {
  cycleId: number;
  committedLamports: string;
  totalSatEarnedRaw: string;
  totalRebateLamports: string;
  txFeeLamports: string;
  netLiveCostLamports: string;
  validParticipation: boolean;
  strategyExecution: "auto" | "deterministic";
  strategyFallbackUsed: boolean;
  recordedAt: string;
};

function createMiningFixture() {
  const requests: Array<{ method: string; path: string }> = [];
  let status: FixtureStatus = {
    running: false,
    enabledWanted: false,
    walletId: "wallet-a",
    network: "devnet",
    riskMode: "balanced",
    blocked: false,
    nextAction: "wait",
    nextActionDetail: "Mining is stopped",
    updatedAt: new Date().toISOString(),
    currentSolBalanceLamports: "1000000000",
    currentSatBalanceRaw: "0",
    currentCapitalFundedLamports: "5000000000",
    currentCapitalLockedLamports: "0",
    currentCapitalFreeLamports: "5000000000",
    activeCommitLamports: "250000000",
    recentActions: [],
    recentPlannerOutcomes: [],
    archivedFailures: [],
  };

  const json = (payload: unknown, init?: ResponseInit) =>
    new Response(JSON.stringify(payload), {
      status: init?.status ?? 200,
      headers: { "content-type": "application/json" },
    });

  const updateStatus = (patch: Partial<FixtureStatus>) => {
    status = {
      ...status,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
  };

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    const method = String(init?.method ?? "GET").toUpperCase();
    const requestUrl = new URL(url, window.location.origin);
    const path = `${requestUrl.pathname}${requestUrl.search}`;
    requests.push({ method, path });

    if (path === "/api/mining/wallets" && method === "GET") {
      return json({
        ok: true,
        wallets: [
          {
            walletId: "wallet-a",
            walletName: "Wallet A",
            providerId: "embedded-keystore",
            signerCapability: "background-ready",
            address: "miner-1",
            rpcReady: true,
            solBalanceLamports: "1000000000",
            solBalanceDisplay: "1.0 SOL",
          },
        ],
        defaultWalletId: "wallet-a",
      });
    }

    if (path === "/api/mining/profile" && method === "GET") {
      return json({ ok: true, profile: null });
    }

    if (path === "/api/mining/profile" && method === "PUT") {
      const body =
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as { profile?: unknown })
          : { profile: null };
      return json({ ok: true, profile: body.profile ?? null });
    }

    if (path === "/api/mining/wallet-attachment" && method === "GET") {
      return json({ ok: true, attachment: { walletId: "wallet-a", attached: true } });
    }

    if (path.startsWith("/api/mining/readiness") && method === "GET") {
      return json({
        ok: true,
        readiness: {
          ok: true,
          selectedWalletId: "wallet-a",
          selectedAddress: "miner-1",
          signerCapability: "background-ready",
          checks: [
            { key: "walletSelected", ok: true, level: "info", label: "Wallet selected" },
            { key: "signerReady", ok: true, level: "info", label: "Signer ready" },
            { key: "rpcReady", ok: true, level: "info", label: "RPC ready" },
            { key: "fundingReady", ok: true, level: "info", label: "Funding ready" },
            { key: "minerInitialized", ok: true, level: "info", label: "Miner initialized" },
          ],
          warnings: [],
          balances: {
            solBalanceLamports: "1000000000",
            solBalanceDisplay: "1.0 SOL",
            satBalanceRaw: "0",
            satBalanceDisplay: "0 SAT",
          },
        },
      });
    }

    if (path === "/api/mining/status" && method === "GET") {
      return json({ ok: true, status });
    }

    if (path === "/api/mining/recovery" && method === "GET") {
      return json({
        ok: true,
        recovery: {
          blocked: false,
          recommendedAction: "none",
          detail: "No recovery needed",
        },
      });
    }

    if (path === "/api/mining/start" && method === "POST") {
      updateStatus({
        running: true,
        enabledWanted: true,
        nextAction: "wait",
        nextActionDetail: "Waiting for next round",
        recentActions: [
          {
            action: "startMining",
            txHash: null,
            status: "success",
            at: new Date().toISOString(),
          },
        ],
      });
      return json({ ok: true, started: true, status });
    }

    if (path === "/api/mining/stop" && method === "POST") {
      updateStatus({
        running: false,
        enabledWanted: false,
        nextAction: "wait",
        nextActionDetail: "Mining is stopped",
        recentActions: [
          {
            action: "stopMining",
            txHash: null,
            status: "success",
            at: new Date().toISOString(),
          },
        ],
      });
      return json({ ok: true, stopped: true, status });
    }

    if (path === "/api/mining/capital/deposit" && method === "POST") {
      updateStatus({
        recentActions: [
          {
            action: "depositMinerCapital",
            txHash: "tx-deposit-capital",
            status: "success",
            at: new Date().toISOString(),
          },
        ],
      });
      return json({
        ok: true,
        submitted: { txHash: "tx-deposit-capital", signer: "miner-1" },
        status,
      });
    }

    if (path === "/api/mining/capital/withdraw" && method === "POST") {
      updateStatus({
        recentActions: [
          {
            action: "withdrawMinerCapital",
            txHash: "tx-withdraw-capital",
            status: "success",
            at: new Date().toISOString(),
          },
        ],
      });
      return json({
        ok: true,
        submitted: { txHash: "tx-withdraw-capital", signer: "miner-1" },
        status,
      });
    }

    if (path === "/api/mining/capital/commit" && method === "POST") {
      updateStatus({
        activeCommitLamports: "250000000",
        recentActions: [
          {
            action: "setActiveCommit",
            txHash: "tx-set-commit",
            status: "success",
            at: new Date().toISOString(),
          },
        ],
      });
      return json({
        ok: true,
        submitted: { txHash: "tx-set-commit", signer: "miner-1" },
        status,
      });
    }

    throw new Error(`Unhandled fixture request: ${method} ${path}`);
  });

  return {
    fetchMock,
    requests,
    getStatus: () => status,
  };
}

function seedAuthenticatedSettings() {
  localStorage.setItem(
    "fased.control.settings.v1",
    JSON.stringify({
      gatewayUrl: "ws://127.0.0.1:18789",
      token: "",
      authStorage: "local",
      sessionKey: "main",
      lastActiveSessionKey: "main",
      theme: "system",
      chatFocusMode: false,
      chatShowThinking: true,
      splitRatio: 0.6,
      navCollapsed: false,
      navGroupsCollapsed: {},
    }),
  );
  localStorage.setItem(
    "fased.control.token.local.v1",
    "081eb8d3e0e9df981fcf85af6aacf09263cbdc0c505bfb19",
  );
}

function buttonByText(container: ParentNode, label: string): HTMLButtonElement | null {
  return (
    Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.replace(/\s+/g, " ").trim().includes(label),
    ) ?? null
  );
}

function miningHeaderButton(container: ParentNode, label: string): HTMLButtonElement | null {
  return (
    Array.from(container.querySelectorAll<HTMLButtonElement>(".mining-header-actions button")).find(
      (button) => button.textContent?.replace(/\s+/g, " ").trim().includes(label),
    ) ?? null
  );
}

async function settle(app: { updateComplete: Promise<unknown> }) {
  await Promise.resolve();
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  await app.updateComplete;
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  await app.updateComplete;
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000) {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for browser mining fixture state");
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, 25));
  }
}

describe("mining start/stop (browser)", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    document.body.innerHTML = "";
    seedAuthenticatedSettings();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
    localStorage.clear();
    sessionStorage.clear();
  });

  it("clicks Start mining and Stop mining against the local mining fixture", async () => {
    const fixture = createMiningFixture();
    vi.stubGlobal("fetch", fixture.fetchMock);

    const { FasedAgentApp } = await import("./app.ts");

    const app = new FasedAgentApp();
    app.tab = "mining";
    document.body.appendChild(app);
    await app.updateComplete;

    await app.handleMiningLoad();
    await settle(app);
    await waitFor(() => miningHeaderButton(app, "Start") !== null);

    const startButtonBefore = miningHeaderButton(app, "Start");
    const stopButtonBefore = miningHeaderButton(app, "Stop");
    expect(startButtonBefore).not.toBeNull();
    expect(stopButtonBefore).not.toBeNull();
    expect(startButtonBefore?.disabled).toBe(false);
    expect(stopButtonBefore?.disabled).toBe(true);

    startButtonBefore?.click();
    await settle(app);
    await waitFor(
      () =>
        !app.miningActionBusy &&
        fixture.requests.some(
          (request) => request.method === "POST" && request.path === "/api/mining/start",
        ),
    );
    await settle(app);

    const stopButtonAfterStart = miningHeaderButton(app, "Stop");
    expect(app.miningStatus?.running).toBe(true);
    expect(app.miningStatus?.enabledWanted).toBe(true);
    expect(app.miningMessage).toContain("SAT mining started.");
    expect(stopButtonAfterStart).not.toBeNull();
    expect(stopButtonAfterStart?.disabled).toBe(false);

    stopButtonAfterStart?.click();
    await settle(app);
    await waitFor(
      () =>
        !app.miningActionBusy &&
        fixture.requests.some(
          (request) => request.method === "POST" && request.path === "/api/mining/stop",
        ),
    );
    await settle(app);

    const startButtonAfterStop = miningHeaderButton(app, "Start");
    expect(app.miningStatus?.running).toBe(false);
    expect(app.miningStatus?.enabledWanted).toBe(false);
    expect(app.miningMessage).toContain("SAT mining stopped.");
    expect(startButtonAfterStop).not.toBeNull();
    expect(startButtonAfterStop?.disabled).toBe(false);
    expect(fixture.getStatus().nextActionDetail).toBe("Mining is stopped");
    expect(
      fixture.requests.some(
        (request) => request.method === "POST" && request.path === "/api/mining/start",
      ),
    ).toBe(true);
    expect(
      fixture.requests.some(
        (request) => request.method === "POST" && request.path === "/api/mining/stop",
      ),
    ).toBe(true);
  });

  it("shows visible capital-action feedback when Fund and Withdraw are clicked", async () => {
    const fixture = createMiningFixture();
    vi.stubGlobal("fetch", fixture.fetchMock);

    const { FasedAgentApp } = await import("./app.ts");

    const app = new FasedAgentApp();
    app.tab = "mining";
    document.body.appendChild(app);
    await app.updateComplete;

    await app.handleMiningLoad();
    await settle(app);
    await waitFor(() => miningHeaderButton(app, "Start") !== null);

    expect(app.textContent ?? "").toContain("Mining capital");
    expect(app.textContent ?? "").toContain("Recent activity");
    expect(app.textContent ?? "").not.toContain("Mining activity");
    expect(app.textContent ?? "").not.toContain(
      "Latest mining messages, action results, and runtime failures for this wallet.",
    );

    const depositInput = app.querySelector<HTMLInputElement>(
      ".mining-capital-actions .mining-action-inline:first-child input",
    );
    const withdrawInput = app.querySelector<HTMLInputElement>(
      ".mining-action-inline--triple input",
    );
    expect(depositInput).toBeTruthy();
    expect(withdrawInput).toBeTruthy();

    depositInput!.value = "0.01";
    depositInput!.dispatchEvent(new Event("input", { bubbles: true }));
    await settle(app);
    const fundButton = buttonByText(app, "Fund");
    expect(fundButton).not.toBeNull();
    fundButton!.click();
    await settle(app);
    await waitFor(() => !app.miningActionBusy);
    await settle(app);

    expect(app.miningMessage).toContain("Mining capital deposited.");
    expect(app.textContent ?? "").toContain("Fund submitted");
    expect(
      fixture.requests.some(
        (request) => request.method === "POST" && request.path === "/api/mining/capital/deposit",
      ),
    ).toBe(true);

    const currentWithdrawInput = app.querySelector<HTMLInputElement>(
      ".mining-action-inline--triple input",
    );
    expect(currentWithdrawInput).toBeTruthy();
    currentWithdrawInput!.value = "0.01";
    currentWithdrawInput!.dispatchEvent(new Event("input", { bubbles: true }));
    await settle(app);
    const withdrawButton = buttonByText(app, "Withdraw");
    expect(withdrawButton).not.toBeNull();
    expect(withdrawButton!.disabled).toBe(false);
    withdrawButton!.click();
    await settle(app);
    await waitFor(() => !app.miningActionBusy);
    await settle(app);

    expect(app.miningMessage).toContain("Mining capital withdrawn.");
    expect(app.textContent ?? "").toContain("Withdraw submitted");
    expect(
      fixture.requests.some(
        (request) => request.method === "POST" && request.path === "/api/mining/capital/withdraw",
      ),
    ).toBe(true);
  });

  it("shows visible commit activity when Update is clicked", async () => {
    const fixture = createMiningFixture();
    vi.stubGlobal("fetch", fixture.fetchMock);

    const { FasedAgentApp } = await import("./app.ts");

    const app = new FasedAgentApp();
    app.tab = "mining";
    document.body.appendChild(app);
    await app.updateComplete;

    await app.handleMiningLoad();
    await settle(app);
    await waitFor(() => app.querySelector(".mining-commit-inline button") !== null);

    const updateButton = app.querySelector<HTMLButtonElement>(".mining-commit-inline button");
    expect(updateButton).not.toBeNull();
    updateButton!.click();
    await settle(app);
    await waitFor(
      () =>
        !app.miningActionBusy &&
        fixture.requests.some(
          (request) => request.method === "POST" && request.path === "/api/mining/capital/commit",
        ),
    );
    await settle(app);

    expect(app.miningMessage).toContain("Active commit updated.");
    expect(app.textContent ?? "").toContain("Commit applied");
    expect(
      fixture.requests.some(
        (request) => request.method === "POST" && request.path === "/api/mining/capital/commit",
      ),
    ).toBe(true);
  });

  it("renders personal mining history bars when planner outcomes exist", async () => {
    const fixture = createMiningFixture();
    const now = Date.now();
    fixture.getStatus().settledHistory = Array.from({ length: 6 }, (_, index) => ({
      cycleId: 9863000 + index,
      committedLamports: String(5_000_000_000 + index * 100_000_000),
      totalSatEarnedRaw: String(3_020_000_000_000 + index * 5_000_000),
      totalRebateLamports: "150000",
      txFeeLamports: "30000",
      netLiveCostLamports: String(70_000 + index * 2_000),
      validParticipation: true,
      strategyExecution: "auto",
      strategyFallbackUsed: false,
      recordedAt: new Date(now - (5 - index) * 60 * 60 * 1000).toISOString(),
    }));
    vi.stubGlobal("fetch", fixture.fetchMock);

    const { FasedAgentApp } = await import("./app.ts");

    const app = new FasedAgentApp();
    app.tab = "mining";
    document.body.appendChild(app);
    await app.updateComplete;

    await app.handleMiningLoad();
    await settle(app);
    await waitFor(() => (app.textContent ?? "").includes("Mining history"));

    const chartBars = app.querySelectorAll(".mining-history-bars__bar");
    expect(chartBars.length).toBeGreaterThan(0);
    expect(app.textContent ?? "").toContain("Mining history");
    expect(app.textContent ?? "").toContain("1H");
    expect(app.textContent ?? "").toContain("24H");
  });
});
