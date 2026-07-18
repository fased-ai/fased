const WARNING_PERCENT = 80;
const emittedWarnings = new Set<string>();

export type DurableCapacityStatus = {
  used: number;
  maximum: number;
  warnAt: number;
  warning: boolean;
};

export function durableCapacityStatus(used: number, maximum: number): DurableCapacityStatus {
  if (!Number.isSafeInteger(used) || used < 0 || !Number.isSafeInteger(maximum) || maximum < 1) {
    throw new Error("durable capacity values must be non-negative safe integers");
  }
  const warnAt = Math.ceil((maximum * WARNING_PERCENT) / 100);
  return { used, maximum, warnAt, warning: used >= warnAt };
}

export function emitDurableCapacityWarning(label: string, used: number, maximum: number): void {
  const status = durableCapacityStatus(used, maximum);
  const key = `${label}\0${maximum}`;
  if (!status.warning) {
    emittedWarnings.delete(key);
    return;
  }
  if (emittedWarnings.has(key)) {
    return;
  }
  emittedWarnings.add(key);
  console.warn(
    `[fased] ${label} capacity warning: ${status.used}/${status.maximum} records (warning threshold ${status.warnAt}); archive/retention review is required before the fail-closed limit`,
  );
}
