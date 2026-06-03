import type { GatewayAuthChoice } from "../commands/onboard-types.js";

export type WizardFlow = "quickstart" | "advanced";
export type HostSetupProfile = "local" | "hosting";

export function isHostingProfile(value: string | undefined): boolean {
  return value === "hosting";
}

export type QuickstartGatewayDefaults = {
  hasExisting: boolean;
  port: number;
  bind: "loopback" | "lan" | "auto" | "custom" | "tailnet";
  authMode: GatewayAuthChoice;
  tailscaleMode: "off" | "serve" | "funnel";
  token?: string;
  password?: string;
  customBindHost?: string;
  tailscaleResetOnExit: boolean;
  federationEnabled: boolean;
  federationHandle?: string;
};

export type GatewayWizardSettings = {
  port: number;
  bind: "loopback" | "lan" | "auto" | "custom" | "tailnet";
  customBindHost?: string;
  authMode: GatewayAuthChoice;
  gatewayToken?: string;
  tailscaleMode: "off" | "serve" | "funnel";
  tailscaleResetOnExit: boolean;
};

export type FederationWizardSettings = {
  enabled: boolean;
  handle?: string;
  baseUrl?: string;
};
