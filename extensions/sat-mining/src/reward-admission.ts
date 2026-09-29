/** Entry-only guard: existing commitments and claims must remain drainable. */
export async function assertSatRewardAdmissionForAction(
  action: string | undefined,
  inspect: () => Promise<void>,
): Promise<void> {
  if (action === "openCycleV2" || action === "commitCycleV2") {
    await inspect();
  }
}

export function assertSatRewardRecipient(actual: string | undefined, expected: string): void {
  if (!actual || actual !== expected) {
    throw new Error(
      "SAT new mining entry blocked: distributor recipient is incompatible with epoch rewards; preserve existing claims and complete legacy drain/migration",
    );
  }
}
