import { afterEach, expect, it, vi } from "vitest";
import "./wen-economy.js";
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("shows verified facts and unavailable NAV only after a manual read", async () => {
  const panel = document.createElement("wen-economy-panel") as WenEconomyPanel;
  const observedAtMs = Date.parse("2026-09-25T12:00:00.000Z");
  vi.spyOn(Date, "now").mockReturnValue(observedAtMs);
  const request = vi.fn().mockResolvedValue({
    signingEnabled: false,
    identity: { economy: "sat-v1", program: "program" },
    slot: "123",
    observedAtMs,
    expiresAtMs: observedAtMs + 60001,
    rows: [
      {
        id: "issuedSupply",
        status: "reported",
        value: "100",
        unit: "atoms",
        evidence: "onchain",
        source: "finalized account",
        scope: "Current account",
        observedAtMs: Date.parse("2026-09-25T12:00:00.000Z"),
      },
      { id: "economicNav", status: "unavailable", value: null, reason: "Coverage incomplete" },
    ],
  });
  panel.client = { request };
  panel.connected = true;
  document.body.append(panel);
  try {
    await panel.updateComplete;
    expect(request).not.toHaveBeenCalled();
    panel.querySelector("button")!.click();
    await vi.waitFor(() => expect(panel.textContent).toContain("100 atoms"));
    expect(request).toHaveBeenCalledWith("wen.economy.read", {});
    expect(panel.textContent).toContain("Unavailable: Coverage incomplete");
    expect(panel.textContent).toContain("onchain · finalized account · Current account");
    expect(panel.textContent).toContain("2026-09-25T12:00:00.000Z");
    expect(panel.textContent).toContain("cannot sign or spend");
  } finally {
    panel.remove();
  }
});

it("drops an in-flight read when its gateway client changes", async () => {
  const panel = document.createElement("wen-economy-panel") as WenEconomyPanel;
  let resolve!: (value: unknown) => void;
  panel.client = {
    request: vi.fn().mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    ),
  };
  panel.connected = true;
  document.body.append(panel);
  try {
    await panel.updateComplete;
    panel.querySelector("button")!.click();
    panel.client = { request: vi.fn() };
    await panel.updateComplete;
    resolve({
      signingEnabled: false,
      identity: { economy: "sat-v1", program: "program" },
      slot: "1",
      rows: [],
    });
    await vi.waitFor(() => expect(panel.snapshot).toBeNull());
  } finally {
    panel.remove();
  }
});

it("lets the replacement gateway refresh while an old read remains pending", async () => {
  const panel = document.createElement("wen-economy-panel") as WenEconomyPanel;
  let resolveOld!: (value: unknown) => void;
  const oldRequest = vi.fn().mockReturnValue(
    new Promise((resolve) => {
      resolveOld = resolve;
    }),
  );
  const newer = {
    signingEnabled: false,
    identity: { economy: "sat-v1", program: "program" },
    slot: "456",
    observedAtMs: Date.now(),
    expiresAtMs: Date.now() + 60001,
    rows: [{ id: "economicNav", status: "unavailable", value: null, reason: "History unresolved" }],
  };
  const newRequest = vi.fn().mockResolvedValue(newer);
  panel.client = { request: oldRequest };
  panel.connected = true;
  document.body.append(panel);
  try {
    await panel.updateComplete;
    panel.querySelector("button")!.click();
    expect(oldRequest).toHaveBeenCalledTimes(1);
    panel.client = { request: newRequest };
    await panel.updateComplete;
    panel.querySelector("button")!.click();
    await vi.waitFor(() => expect(panel.textContent).toContain("History unresolved"));
    expect(newRequest).toHaveBeenCalledTimes(1);
    resolveOld(newer);
    await vi.waitFor(() => expect(panel.busy).toBe(false));
    expect(panel.snapshot?.slot).toBe("456");
  } finally {
    panel.remove();
  }
});

it("does not display a reported value without provenance", async () => {
  const panel = document.createElement("wen-economy-panel") as WenEconomyPanel;
  panel.client = {
    request: vi.fn().mockResolvedValue({
      signingEnabled: false,
      identity: { economy: "sat-v1", program: "program" },
      slot: "123",
      rows: [{ id: "issuedSupply", status: "reported", value: "100", unit: "atoms" }],
    }),
  };
  panel.connected = true;
  document.body.append(panel);
  try {
    await panel.updateComplete;
    panel.querySelector("button")!.click();
    await vi.waitFor(() =>
      expect(panel.textContent).toContain("Verified WEN economy read unavailable"),
    );
    expect(panel.textContent).not.toContain("100 atoms");
  } finally {
    panel.remove();
  }
});

it("expires displayed facts without another read and refreshes only on request", async () => {
  vi.useFakeTimers();
  const observedAtMs = Date.now();
  const snapshot = {
    signingEnabled: false,
    identity: { economy: "sat-v1", program: "program" },
    slot: "123",
    observedAtMs,
    expiresAtMs: observedAtMs + 101,
    rows: [
      {
        id: "issuedSupply",
        status: "reported",
        value: "100",
        unit: "atoms",
        evidence: "onchain",
        source: "account",
        scope: "custody",
        observedAtMs,
      },
    ],
  };
  const request = vi.fn().mockResolvedValue(snapshot);
  const panel = document.createElement("wen-economy-panel") as WenEconomyPanel;
  panel.client = { request };
  panel.connected = true;
  document.body.append(panel);
  await panel.updateComplete;
  await panel.refresh();
  await panel.updateComplete;
  expect(panel.textContent).toContain("100 atoms");
  await vi.advanceTimersByTimeAsync(101);
  await panel.updateComplete;
  expect(panel.snapshot).toBeNull();
  expect(panel.textContent).not.toContain("100 atoms");
  expect(panel.textContent).toContain("WEN facts expired");
  expect(request).toHaveBeenCalledTimes(1);
  request.mockResolvedValue({
    ...snapshot,
    observedAtMs: Date.now(),
    expiresAtMs: Date.now() + 101,
    rows: [{ ...snapshot.rows[0], observedAtMs: Date.now() }],
  });
  await panel.refresh();
  await panel.updateComplete;
  expect(panel.textContent).toContain("100 atoms");
  expect(request).toHaveBeenCalledTimes(2);
  panel.remove();
  expect(vi.getTimerCount()).toBe(0);
});

it("rejects an already-expired response and clears a disconnected snapshot", async () => {
  const now = Date.now();
  const response = {
    signingEnabled: false,
    identity: { economy: "sat-v1", program: "program" },
    slot: "123",
    observedAtMs: now,
    expiresAtMs: now,
    rows: [],
  };
  const request = vi.fn().mockResolvedValue(response);
  const panel = document.createElement("wen-economy-panel") as WenEconomyPanel;
  panel.client = { request };
  panel.connected = true;
  document.body.append(panel);
  await panel.updateComplete;
  await panel.refresh();
  await panel.updateComplete;
  expect(panel.snapshot).toBeNull();
  expect(panel.textContent).toContain("read unavailable");
  request.mockResolvedValue({
    ...response,
    observedAtMs: Date.now(),
    expiresAtMs: Date.now() + 60001,
  });
  await panel.refresh();
  await panel.updateComplete;
  expect(panel.snapshot).not.toBeNull();
  panel.connected = false;
  await panel.updateComplete;
  expect(panel.snapshot).toBeNull();
  panel.remove();
});

it("clears expired facts on visibility return even when the expiry timer was throttled", async () => {
  const observedAtMs = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(observedAtMs);
  const request = vi.fn().mockResolvedValue({
    signingEnabled: false,
    identity: { economy: "sat-v1", program: "program" },
    slot: "123",
    observedAtMs,
    expiresAtMs: observedAtMs + 60001,
    rows: [
      { id: "economicNav", status: "unavailable", value: null, reason: "Coverage incomplete" },
    ],
  });
  const panel = document.createElement("wen-economy-panel") as WenEconomyPanel;
  panel.client = { request };
  panel.connected = true;
  document.body.append(panel);
  await panel.updateComplete;
  await panel.refresh();
  await panel.updateComplete;
  expect(panel.snapshot).not.toBeNull();
  clock.mockReturnValue(observedAtMs + 60001);
  document.dispatchEvent(new Event("visibilitychange"));
  await panel.updateComplete;
  expect(panel.snapshot).toBeNull();
  expect(request).toHaveBeenCalledTimes(1);
  expect(panel.textContent).toContain("WEN facts expired");
  panel.remove();
});
