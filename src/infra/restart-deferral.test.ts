import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __testing, deferGatewayRestartUntilIdle } from "./restart.js";

describe("Gateway restart deferral cancellation", () => {
  const onSigusr1 = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    __testing.resetSigusr1State();
    onSigusr1.mockReset();
    process.on("SIGUSR1", onSigusr1);
  });

  afterEach(() => {
    process.off("SIGUSR1", onSigusr1);
    __testing.resetSigusr1State();
    vi.useRealTimers();
  });

  it("cancels a pending poll without emitting a restart", async () => {
    let pendingCount = 1;
    const onReady = vi.fn();
    const deferral = deferGatewayRestartUntilIdle({
      getPendingCount: () => pendingCount,
      hooks: { onReady },
      pollMs: 10,
      maxWaitMs: 100,
    });

    expect(deferral.isPending()).toBe(true);
    expect(deferral.cancel()).toBe(true);
    expect(deferral.isPending()).toBe(false);
    expect(deferral.cancel()).toBe(false);

    pendingCount = 0;
    await vi.advanceTimersByTimeAsync(200);
    expect(onReady).not.toHaveBeenCalled();
    expect(onSigusr1).not.toHaveBeenCalled();
  });

  it("cannot cancel a restart that was already emitted", () => {
    const deferral = deferGatewayRestartUntilIdle({
      getPendingCount: () => 0,
      pollMs: 10,
      maxWaitMs: 100,
    });

    expect(onSigusr1).toHaveBeenCalledTimes(1);
    expect(deferral.isPending()).toBe(false);
    expect(deferral.cancel()).toBe(false);
  });
});
