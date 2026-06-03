import type { FasedAgentConfig } from "../../config/config.js";
import type { DmPolicy } from "../../config/types.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { WizardPrompter } from "../../wizard/prompts.js";
import type { ChannelId } from "./types.js";

export type SetupChannelsOptions = {
  allowDisable?: boolean;
  allowSignalInstall?: boolean;
  onSelection?: (selection: ChannelId[]) => void;
  accountIds?: Partial<Record<ChannelId, string>>;
  onAccountId?: (channel: ChannelId, accountId: string) => void;
  promptAccountIds?: boolean;
  whatsappAccountId?: string;
  promptWhatsAppAccountId?: boolean;
  onWhatsAppAccountId?: (accountId: string) => void;
  forceAllowFromChannels?: ChannelId[];
  skipStatusNote?: boolean;
  skipPrimerNote?: boolean;
  skipDmPolicyPrompt?: boolean;
  skipConfirm?: boolean;
  quickstartDefaults?: boolean;
  initialSelection?: ChannelId[];
};

export type PromptAccountIdParams = {
  cfg: FasedAgentConfig;
  prompter: WizardPrompter;
  label: string;
  currentId?: string;
  listAccountIds: (cfg: FasedAgentConfig) => string[];
  defaultAccountId: string;
};

export type PromptAccountId = (params: PromptAccountIdParams) => Promise<string>;

export type ChannelOnboardingStatus = {
  channel: ChannelId;
  configured: boolean;
  statusLines: string[];
  selectionHint?: string;
  quickstartScore?: number;
};

export type ChannelOnboardingStatusContext = {
  cfg: FasedAgentConfig;
  options?: SetupChannelsOptions;
  accountOverrides: Partial<Record<ChannelId, string>>;
};

export type ChannelOnboardingConfigureContext = {
  cfg: FasedAgentConfig;
  runtime: RuntimeEnv;
  prompter: WizardPrompter;
  options?: SetupChannelsOptions;
  accountOverrides: Partial<Record<ChannelId, string>>;
  shouldPromptAccountIds: boolean;
  forceAllowFrom: boolean;
};

export type ChannelOnboardingResult = {
  cfg: FasedAgentConfig;
  accountId?: string;
};

export type ChannelOnboardingConfiguredResult = ChannelOnboardingResult | "skip";

export type ChannelOnboardingInteractiveContext = ChannelOnboardingConfigureContext & {
  configured: boolean;
  label: string;
};

export type ChannelOnboardingDmPolicy = {
  label: string;
  channel: ChannelId;
  policyKey: string;
  allowFromKey: string;
  getCurrent: (cfg: FasedAgentConfig) => DmPolicy;
  setPolicy: (cfg: FasedAgentConfig, policy: DmPolicy) => FasedAgentConfig;
  promptAllowFrom?: (params: {
    cfg: FasedAgentConfig;
    prompter: WizardPrompter;
    accountId?: string;
  }) => Promise<FasedAgentConfig>;
};

export type ChannelOnboardingUiField = {
  label: string;
  path: Array<string | number>;
  placeholder?: string;
  kind?: "text" | "password" | "number" | "list" | "select" | "boolean";
  options?: Array<{ label: string; value: string }>;
};

export type ChannelOnboardingUiAccess =
  | { kind: "whatsapp-dm"; label?: string; note?: string }
  | { kind: "discord-channels"; label?: string; note?: string; placeholder?: string }
  | { kind: "slack-channels"; label?: string; note?: string; placeholder?: string }
  | { kind: "msteams-channels"; label?: string; note?: string; placeholder?: string }
  | { kind: "irc-channels"; label?: string; note?: string; placeholder?: string }
  | { kind: "matrix-rooms"; label?: string; note?: string; placeholder?: string }
  | { kind: "zalouser-groups"; label?: string; note?: string; placeholder?: string };

export type ChannelOnboardingUiDmPolicy = {
  label: string;
  policyKey: string;
  allowFromKey: string;
};

export type ChannelOnboardingUiSetup = {
  title: string;
  detail: string;
  notes?: string[];
  fields: ChannelOnboardingUiField[];
  qrLogin?: {
    startLabel?: string;
    waitLabel?: string;
    alt?: string;
  };
  access?: ChannelOnboardingUiAccess;
  dmPolicy?: ChannelOnboardingUiDmPolicy;
};

export type ChannelOnboardingAdapter = {
  channel: ChannelId;
  uiSetup?: ChannelOnboardingUiSetup;
  getStatus: (ctx: ChannelOnboardingStatusContext) => Promise<ChannelOnboardingStatus>;
  configure: (ctx: ChannelOnboardingConfigureContext) => Promise<ChannelOnboardingResult>;
  configureInteractive?: (
    ctx: ChannelOnboardingInteractiveContext,
  ) => Promise<ChannelOnboardingConfiguredResult>;
  configureWhenConfigured?: (
    ctx: ChannelOnboardingInteractiveContext,
  ) => Promise<ChannelOnboardingConfiguredResult>;
  dmPolicy?: ChannelOnboardingDmPolicy;
  onAccountRecorded?: (accountId: string, options?: SetupChannelsOptions) => void;
  disable?: (cfg: FasedAgentConfig) => FasedAgentConfig;
};
