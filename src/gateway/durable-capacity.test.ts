import { describe, expect, test, vi } from "vitest";
import { durableCapacityStatus, emitDurableCapacityWarning } from "./durable-capacity.js";

describe("durable state capacity alerting", () => {
  test("starts warnings at exactly eighty percent", () => {
    expect(durableCapacityStatus(79, 100)).toMatchObject({ warnAt: 80, warning: false });
    expect(durableCapacityStatus(80, 100)).toMatchObject({ warnAt: 80, warning: true });
  });

  test("emits one operator warning per capacity incident and resets below threshold", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    emitDurableCapacityWarning("test-ledger", 80, 100);
    emitDurableCapacityWarning("test-ledger", 81, 100);
    expect(warn).toHaveBeenCalledTimes(1);
    emitDurableCapacityWarning("test-ledger", 79, 100);
    emitDurableCapacityWarning("test-ledger", 80, 100);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
