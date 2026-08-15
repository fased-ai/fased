export const GATEWAY_EVENT_MINING_CHANGED = "mining.changed" as const;

export type GatewayMiningChangedEventPayload = {
  method: string;
  atMs: number;
  status?: unknown;
  started?: boolean;
  stopped?: boolean;
  submitted?: unknown;
};
