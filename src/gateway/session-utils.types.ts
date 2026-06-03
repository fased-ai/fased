import type { ChatType } from "../channels/chat-type.js";
import type { SessionCompactionCheckpointReason, SessionEntry } from "../config/sessions.js";
import type { DeliveryContext } from "../utils/delivery-context.js";

export type GatewaySessionsDefaults = {
  modelProvider: string | null;
  model: string | null;
  contextTokens: number | null;
};

export type GatewaySessionCompactionCheckpointSummary = {
  checkpointId: string;
  createdAt: number;
  reason: SessionCompactionCheckpointReason;
  tokensBefore?: number;
  tokensAfter?: number;
  summary?: string;
};

export type GatewaySessionRow = {
  key: string;
  kind: "direct" | "group" | "global" | "unknown";
  label?: string;
  displayName?: string;
  derivedTitle?: string;
  lastMessagePreview?: string;
  channel?: string;
  subject?: string;
  groupChannel?: string;
  space?: string;
  chatType?: ChatType;
  origin?: SessionEntry["origin"];
  updatedAt: number | null;
  sessionId?: string;
  systemSent?: boolean;
  abortedLastRun?: boolean;
  thinkingLevel?: string;
  verboseLevel?: string;
  reasoningLevel?: string;
  elevatedLevel?: string;
  sendPolicy?: "allow" | "deny";
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  totalTokensFresh?: boolean;
  responseUsage?: "on" | "off" | "tokens" | "full";
  modelProvider?: string;
  model?: string;
  skills?: {
    count: number;
    names: string[];
    skillFilter?: string[];
  };
  contextTokens?: number;
  compactionCheckpointCount?: number;
  compactionCheckpoints?: GatewaySessionCompactionCheckpointSummary[];
  deliveryContext?: DeliveryContext;
  lastChannel?: SessionEntry["lastChannel"];
  lastTo?: string;
  lastAccountId?: string;
  hasActiveRun?: boolean;
  activeRunIds?: string[];
};

export type GatewayAgentRow = {
  id: string;
  name?: string;
  identity?: {
    name?: string;
    theme?: string;
    emoji?: string;
    avatar?: string;
    avatarUrl?: string;
  };
};

export type SessionPreviewItem = {
  role: "user" | "assistant" | "tool" | "system" | "other";
  text: string;
};

export type SessionsPreviewEntry = {
  key: string;
  status: "ok" | "empty" | "missing" | "error";
  items: SessionPreviewItem[];
};

export type SessionsPreviewResult = {
  ts: number;
  previews: SessionsPreviewEntry[];
};

export type SessionsListResult = {
  ts: number;
  path: string;
  count: number;
  totalCount?: number;
  limitApplied?: number;
  offset?: number;
  nextOffset?: number | null;
  hasMore?: boolean;
  defaults: GatewaySessionsDefaults;
  sessions: GatewaySessionRow[];
};

export type SessionsPatchResult = {
  ok: true;
  path: string;
  key: string;
  entry: SessionEntry;
  resolved?: {
    modelProvider?: string;
    model?: string;
  };
};
