const KEY = "fased.control.settings.v1";
const TOKEN_LOCAL_KEY = "fased.control.token.local.v1";
const TOKEN_SESSION_KEY = "fased.control.token.session.v1";

import { isSupportedLocale } from "../i18n/index.ts";
import {
  normalizeNotificationRoutePrefs,
  type NotificationRouteMode,
  type NotificationRoutePrefs,
} from "./notifications.ts";
import type { ThemeMode } from "./theme.ts";

export type AuthStorageMode = "local" | "session";
export type ChatDeliveryMode = "operator" | "channel" | "follow";

export type UiSettings = {
  gatewayUrl: string;
  token: string;
  authStorage: AuthStorageMode;
  sessionKey: string;
  lastActiveSessionKey: string;
  theme: ThemeMode;
  chatFocusMode: boolean;
  chatShowThinking: boolean;
  chatShowToolCalls: boolean;
  chatCommandHelpersCollapsed: boolean;
  chatSessionUsageVisible: boolean;
  chatDeliveryMode: ChatDeliveryMode;
  splitRatio: number; // Sidebar split ratio (0.4 to 0.7, default 0.6)
  navCollapsed: boolean; // Collapsible sidebar state
  navGroupsCollapsed: Record<string, boolean>; // Which nav groups are collapsed
  notificationRouteMode: NotificationRouteMode;
  notificationRouteChannel: string;
  notificationRouteAccountId: string;
  notificationRouteTo: string;
  notificationEventPrefs: NotificationRoutePrefs;
  locale?: string;
};

function getLocalStorageSafe(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function getSessionStorageSafe(): Storage | undefined {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}

export function loadSettings(): UiSettings {
  const defaultUrl = (() => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${location.host}`;
  })();

  const defaults: UiSettings = {
    gatewayUrl: defaultUrl,
    token: "",
    authStorage: "local",
    sessionKey: "main",
    lastActiveSessionKey: "main",
    theme: "system",
    chatFocusMode: false,
    chatShowThinking: true,
    chatShowToolCalls: true,
    chatCommandHelpersCollapsed: false,
    chatSessionUsageVisible: true,
    chatDeliveryMode: "operator",
    splitRatio: 0.6,
    navCollapsed: false,
    navGroupsCollapsed: {},
    notificationRouteMode: "ui-only",
    notificationRouteChannel: "",
    notificationRouteAccountId: "",
    notificationRouteTo: "",
    notificationEventPrefs: normalizeNotificationRoutePrefs(undefined),
  };

  try {
    const localStorageSafe = getLocalStorageSafe();
    const sessionStorageSafe = getSessionStorageSafe();
    const raw = localStorageSafe?.getItem(KEY) ?? null;
    if (!raw) {
      const localToken = localStorageSafe?.getItem(TOKEN_LOCAL_KEY) ?? "";
      return {
        ...defaults,
        token: localToken,
      };
    }
    const parsed = JSON.parse(raw) as Partial<UiSettings>;
    const authStorage: AuthStorageMode = parsed.authStorage === "session" ? "session" : "local";
    const resolveToken = () => {
      if (authStorage === "session") {
        const sessionToken = sessionStorageSafe?.getItem(TOKEN_SESSION_KEY);
        if (typeof sessionToken === "string") {
          return sessionToken;
        }
      } else {
        const localToken = localStorageSafe?.getItem(TOKEN_LOCAL_KEY);
        if (typeof localToken === "string") {
          return localToken;
        }
      }
      return typeof parsed.token === "string" ? parsed.token : defaults.token;
    };
    return {
      gatewayUrl:
        typeof parsed.gatewayUrl === "string" && parsed.gatewayUrl.trim()
          ? parsed.gatewayUrl.trim()
          : defaults.gatewayUrl,
      token: resolveToken(),
      authStorage,
      sessionKey:
        typeof parsed.sessionKey === "string" && parsed.sessionKey.trim()
          ? parsed.sessionKey.trim()
          : defaults.sessionKey,
      lastActiveSessionKey:
        typeof parsed.lastActiveSessionKey === "string" && parsed.lastActiveSessionKey.trim()
          ? parsed.lastActiveSessionKey.trim()
          : (typeof parsed.sessionKey === "string" && parsed.sessionKey.trim()) ||
            defaults.lastActiveSessionKey,
      theme:
        parsed.theme === "light" || parsed.theme === "dark" || parsed.theme === "system"
          ? parsed.theme
          : defaults.theme,
      chatFocusMode:
        typeof parsed.chatFocusMode === "boolean" ? parsed.chatFocusMode : defaults.chatFocusMode,
      chatShowThinking:
        typeof parsed.chatShowThinking === "boolean"
          ? parsed.chatShowThinking
          : defaults.chatShowThinking,
      chatShowToolCalls:
        typeof parsed.chatShowToolCalls === "boolean"
          ? parsed.chatShowToolCalls
          : defaults.chatShowToolCalls,
      chatCommandHelpersCollapsed:
        typeof parsed.chatCommandHelpersCollapsed === "boolean"
          ? parsed.chatCommandHelpersCollapsed
          : defaults.chatCommandHelpersCollapsed,
      chatSessionUsageVisible:
        typeof parsed.chatSessionUsageVisible === "boolean"
          ? parsed.chatSessionUsageVisible
          : defaults.chatSessionUsageVisible,
      chatDeliveryMode:
        parsed.chatDeliveryMode === "channel" || parsed.chatDeliveryMode === "follow"
          ? parsed.chatDeliveryMode
          : defaults.chatDeliveryMode,
      splitRatio:
        typeof parsed.splitRatio === "number" &&
        parsed.splitRatio >= 0.4 &&
        parsed.splitRatio <= 0.7
          ? parsed.splitRatio
          : defaults.splitRatio,
      navCollapsed:
        typeof parsed.navCollapsed === "boolean" ? parsed.navCollapsed : defaults.navCollapsed,
      navGroupsCollapsed:
        typeof parsed.navGroupsCollapsed === "object" && parsed.navGroupsCollapsed !== null
          ? parsed.navGroupsCollapsed
          : defaults.navGroupsCollapsed,
      notificationRouteMode:
        parsed.notificationRouteMode === "channel" ? "channel" : defaults.notificationRouteMode,
      notificationRouteChannel:
        typeof parsed.notificationRouteChannel === "string"
          ? parsed.notificationRouteChannel.trim()
          : defaults.notificationRouteChannel,
      notificationRouteAccountId:
        typeof parsed.notificationRouteAccountId === "string"
          ? parsed.notificationRouteAccountId.trim()
          : defaults.notificationRouteAccountId,
      notificationRouteTo:
        typeof parsed.notificationRouteTo === "string"
          ? parsed.notificationRouteTo.trim()
          : defaults.notificationRouteTo,
      notificationEventPrefs: normalizeNotificationRoutePrefs(parsed.notificationEventPrefs),
      locale: isSupportedLocale(parsed.locale) ? parsed.locale : undefined,
    };
  } catch {
    return defaults;
  }
}

export function saveSettings(next: UiSettings) {
  const localStorageSafe = getLocalStorageSafe();
  const sessionStorageSafe = getSessionStorageSafe();
  const authStorage: AuthStorageMode = next.authStorage === "session" ? "session" : "local";
  const persisted: UiSettings = {
    ...next,
    authStorage,
    token: "",
  };
  localStorageSafe?.setItem(KEY, JSON.stringify(persisted));
  if (authStorage === "session") {
    sessionStorageSafe?.setItem(TOKEN_SESSION_KEY, next.token);
    localStorageSafe?.removeItem(TOKEN_LOCAL_KEY);
    return;
  }
  localStorageSafe?.setItem(TOKEN_LOCAL_KEY, next.token);
  sessionStorageSafe?.removeItem(TOKEN_SESSION_KEY);
}
