export type GatewayReadinessSnapshot = {
  ready: boolean;
  failing: string[];
  uptimeMs: number;
};

export type ReadinessChecker = () => GatewayReadinessSnapshot;
