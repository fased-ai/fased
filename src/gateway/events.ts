import type { UpdateAvailable } from "../infra/update-startup.js";

export const GATEWAY_EVENT_UPDATE_AVAILABLE = "update.available" as const;
export const GATEWAY_EVENT_MINING_CHANGED = "mining.changed" as const;

export type GatewayUpdateAvailableEventPayload = {
  updateAvailable: UpdateAvailable | null;
};

export type GatewayMiningChangedEventPayload = {
  method: string;
  atMs: number;
  status?: unknown;
  started?: boolean;
  stopped?: boolean;
  submitted?: unknown;
};
