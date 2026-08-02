export type GatewayReadinessSnapshot = {
  ready: boolean;
  failing: string[];
  uptimeMs: number;
};

export type ReadinessChecker = () => GatewayReadinessSnapshot;

export type GatewayReadinessLatch = {
  snapshot: ReadinessChecker;
  markReady: () => void;
};

export function createGatewayReadinessLatch(now: () => number = Date.now): GatewayReadinessLatch {
  const startedAt = now();
  let ready = false;

  return {
    snapshot: () => ({
      ready,
      failing: ready ? [] : ["startup"],
      uptimeMs: Math.max(0, now() - startedAt),
    }),
    markReady: () => {
      ready = true;
    },
  };
}
