export const GATEWAY_EVENT_MINING_CHANGED = "mining.changed" as const;

export type GatewayMiningChangedEventPayload = {
  method: SatMiningMutationMethod;
  atMs: number;
  status?: unknown;
  started?: boolean;
  stopped?: boolean;
  submitted?: unknown;
};

type SatMiningMethodDefinition = {
  method: string;
  kind: "read" | "mutation";
};

export const SAT_MINING_METHOD_INVENTORY = [
  { method: "sat.abortEmptyCycle", kind: "mutation" },
  { method: "sat.claimBacklog", kind: "mutation" },
  { method: "sat.claimCycleRewards", kind: "mutation" },
  { method: "sat.claimCycleRewardsBatch", kind: "mutation" },
  { method: "sat.claimProtocolDistributorSat", kind: "mutation" },
  { method: "sat.claimProtocolTreasury", kind: "mutation" },
  { method: "sat.cleanupDistributionLookupTable", kind: "mutation" },
  { method: "sat.clearMiningHistory", kind: "mutation" },
  { method: "sat.closeCommitPhase", kind: "mutation" },
  { method: "sat.closeResolvedCycleAccounts", kind: "mutation" },
  { method: "sat.commitCycle", kind: "mutation" },
  { method: "sat.compactPendingCycleRange", kind: "mutation" },
  { method: "sat.depositMinerCapital", kind: "mutation" },
  { method: "sat.distributeCyclePage", kind: "mutation" },
  { method: "sat.finalizeCycleSettlement", kind: "mutation" },
  { method: "sat.getDispute", kind: "read" },
  { method: "sat.getEpoch", kind: "read" },
  { method: "sat.getMainnetSyncStatus", kind: "read" },
  { method: "sat.getMinerProfile", kind: "read" },
  { method: "sat.getMiningActionPage", kind: "read" },
  { method: "sat.getMiningHistory", kind: "read" },
  { method: "sat.getMiningHistorySeries", kind: "read" },
  { method: "sat.getMiningOutcomePage", kind: "read" },
  { method: "sat.getMiningReadiness", kind: "read" },
  { method: "sat.getMiningRecovery", kind: "read" },
  { method: "sat.getMiningStatus", kind: "read" },
  { method: "sat.getMiningWalletAttachment", kind: "read" },
  { method: "sat.getRecoverySummary", kind: "read" },
  { method: "sat.getValidatorAttestation", kind: "read" },
  { method: "sat.initMinerCapital", kind: "mutation" },
  { method: "sat.listDisputes", kind: "read" },
  { method: "sat.listMiningWallets", kind: "read" },
  { method: "sat.listValidatorAttestations", kind: "read" },
  { method: "sat.openCycle", kind: "mutation" },
  { method: "sat.openDispute", kind: "mutation" },
  { method: "sat.queryMiningActions", kind: "read" },
  { method: "sat.queryMiningOutcomes", kind: "read" },
  { method: "sat.refillRegistryReserveFromTreasury", kind: "mutation" },
  { method: "sat.releaseUnrevealedCommit", kind: "mutation" },
  { method: "sat.republishEpochRoots", kind: "mutation" },
  { method: "sat.resolveDispute", kind: "mutation" },
  { method: "sat.retargetUnlock", kind: "mutation" },
  { method: "sat.revealCycle", kind: "mutation" },
  { method: "sat.runKeeperOnce", kind: "mutation" },
  { method: "sat.runProtocolMaintenanceOnce", kind: "mutation" },
  { method: "sat.scoreCyclePage", kind: "mutation" },
  { method: "sat.sealCycleEntropy", kind: "mutation" },
  { method: "sat.setActiveCommit", kind: "mutation" },
  { method: "sat.setMinerProfile", kind: "mutation" },
  { method: "sat.settleCyclePage", kind: "mutation" },
  { method: "sat.snapshotKeeperCapabilities", kind: "mutation" },
  { method: "sat.startMining", kind: "mutation" },
  { method: "sat.status", kind: "read" },
  { method: "sat.stopMining", kind: "mutation" },
  { method: "sat.submitCycle", kind: "mutation" },
  { method: "sat.submitValidatorAttestation", kind: "mutation" },
  { method: "sat.syncMainnet", kind: "mutation" },
  { method: "sat.topUpRegistryReserve", kind: "mutation" },
  { method: "sat.withdrawMinerCapital", kind: "mutation" },
] as const satisfies readonly SatMiningMethodDefinition[];

export type SatMiningGatewayMethod = (typeof SAT_MINING_METHOD_INVENTORY)[number]["method"];
export type SatMiningMethodKind = (typeof SAT_MINING_METHOD_INVENTORY)[number]["kind"];
export type SatMiningMutationMethod = Extract<
  (typeof SAT_MINING_METHOD_INVENTORY)[number],
  { kind: "mutation" }
>["method"];
export type SatMiningReadMethod = Extract<
  (typeof SAT_MINING_METHOD_INVENTORY)[number],
  { kind: "read" }
>["method"];

export type SatMiningGatewayMethodRegistration = {
  method: string;
  kind: SatMiningMethodKind;
};

export type SatMiningGatewayMethodHandlerRegistration<Handler> =
  SatMiningGatewayMethodRegistration & {
    handler: Handler;
  };

export const SAT_MINING_GATEWAY_METHODS: readonly SatMiningGatewayMethod[] =
  SAT_MINING_METHOD_INVENTORY.map((entry) => entry.method);
export const SAT_MINING_MUTATION_METHODS: ReadonlySet<SatMiningMutationMethod> = new Set(
  SAT_MINING_METHOD_INVENTORY.filter(
    (entry): entry is Extract<(typeof SAT_MINING_METHOD_INVENTORY)[number], { kind: "mutation" }> =>
      entry.kind === "mutation",
  ).map((entry) => entry.method),
);
export const SAT_MINING_READ_METHODS: ReadonlySet<SatMiningReadMethod> = new Set(
  SAT_MINING_METHOD_INVENTORY.filter(
    (entry): entry is Extract<(typeof SAT_MINING_METHOD_INVENTORY)[number], { kind: "read" }> =>
      entry.kind === "read",
  ).map((entry) => entry.method),
);

const miningMethodKinds: ReadonlyMap<string, SatMiningMethodKind> = new Map(
  SAT_MINING_METHOD_INVENTORY.map((entry) => [entry.method, entry.kind] as const),
);

export function isSatMiningGatewayMethod(method: string): method is SatMiningGatewayMethod {
  return miningMethodKinds.has(method);
}

export function isSatMiningMutationMethod(method: string): method is SatMiningMutationMethod {
  return miningMethodKinds.get(method) === "mutation";
}

export function isSatMiningReadMethod(method: string): method is SatMiningReadMethod {
  return miningMethodKinds.get(method) === "read";
}

export function assertSatMiningGatewayMethodRegistrations(
  registrations: readonly SatMiningGatewayMethodRegistration[],
): void {
  const registered = new Set<string>();
  for (const registration of registrations) {
    if (registered.has(registration.method)) {
      throw new Error(`duplicate SAT Mining Gateway method registration: ${registration.method}`);
    }
    registered.add(registration.method);
    const expectedKind = miningMethodKinds.get(registration.method);
    if (!expectedKind) {
      throw new Error(`undeclared SAT Mining Gateway method registration: ${registration.method}`);
    }
    if (expectedKind !== registration.kind) {
      throw new Error(
        `SAT Mining Gateway method classification mismatch for ${registration.method}: expected ${expectedKind}, received ${registration.kind}`,
      );
    }
  }
  const missing = SAT_MINING_GATEWAY_METHODS.filter((method) => !registered.has(method));
  if (missing.length > 0) {
    throw new Error(`missing SAT Mining Gateway method registrations: ${missing.join(", ")}`);
  }
}

export function registerSatMiningGatewayMethods<Handler>(
  registrations: readonly SatMiningGatewayMethodHandlerRegistration<Handler>[],
  register: (method: SatMiningGatewayMethod, handler: Handler) => void,
): void {
  assertSatMiningGatewayMethodRegistrations(registrations);
  for (const registration of registrations) {
    register(registration.method as SatMiningGatewayMethod, registration.handler);
  }
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

export function buildGatewayMiningChangedEventPayload(
  method: SatMiningMutationMethod,
  responsePayload: unknown,
): GatewayMiningChangedEventPayload {
  const responseRecord = readRecord(responsePayload);
  const payloadRecord = readRecord(responseRecord?.payload);
  const status = payloadRecord?.status ?? responseRecord?.status;
  return {
    method,
    atMs: Date.now(),
    ...(status ? { status } : {}),
    ...(typeof payloadRecord?.started === "boolean" ? { started: payloadRecord.started } : {}),
    ...(typeof payloadRecord?.stopped === "boolean" ? { stopped: payloadRecord.stopped } : {}),
    ...("submitted" in (payloadRecord ?? {}) ? { submitted: payloadRecord?.submitted } : {}),
  };
}
