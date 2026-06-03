export type SessionEventSubscriberRegistry = {
  subscribe: (connId: string) => void;
  unsubscribe: (connId: string) => void;
  unsubscribeAll: (connId: string) => void;
  getAll: () => ReadonlySet<string>;
  clear: () => void;
};

export type SessionMessageSubscriberRegistry = {
  subscribe: (connId: string, sessionKey: string) => void;
  unsubscribe: (connId: string, sessionKey: string) => void;
  unsubscribeAll: (connId: string) => void;
  get: (sessionKey: string) => ReadonlySet<string>;
  clear: () => void;
};

const EMPTY_CONN_IDS = new Set<string>();

function normalizeSubscriptionToken(value: string): string {
  return value.trim();
}

export function createSessionEventSubscriberRegistry(): SessionEventSubscriberRegistry {
  const connIds = new Set<string>();

  const unsubscribe = (connId: string) => {
    const normalizedConnId = normalizeSubscriptionToken(connId);
    if (!normalizedConnId) {
      return;
    }
    connIds.delete(normalizedConnId);
  };

  return {
    subscribe: (connId: string) => {
      const normalizedConnId = normalizeSubscriptionToken(connId);
      if (!normalizedConnId) {
        return;
      }
      connIds.add(normalizedConnId);
    },
    unsubscribe,
    unsubscribeAll: unsubscribe,
    getAll: () => (connIds.size > 0 ? connIds : EMPTY_CONN_IDS),
    clear: () => {
      connIds.clear();
    },
  };
}

export function createSessionMessageSubscriberRegistry(): SessionMessageSubscriberRegistry {
  const sessionToConnIds = new Map<string, Set<string>>();
  const connToSessionKeys = new Map<string, Set<string>>();

  const unsubscribe = (connId: string, sessionKey: string) => {
    const normalizedConnId = normalizeSubscriptionToken(connId);
    const normalizedSessionKey = normalizeSubscriptionToken(sessionKey);
    if (!normalizedConnId || !normalizedSessionKey) {
      return;
    }

    const connIds = sessionToConnIds.get(normalizedSessionKey);
    connIds?.delete(normalizedConnId);
    if (connIds?.size === 0) {
      sessionToConnIds.delete(normalizedSessionKey);
    }

    const sessionKeys = connToSessionKeys.get(normalizedConnId);
    sessionKeys?.delete(normalizedSessionKey);
    if (sessionKeys?.size === 0) {
      connToSessionKeys.delete(normalizedConnId);
    }
  };

  return {
    subscribe: (connId: string, sessionKey: string) => {
      const normalizedConnId = normalizeSubscriptionToken(connId);
      const normalizedSessionKey = normalizeSubscriptionToken(sessionKey);
      if (!normalizedConnId || !normalizedSessionKey) {
        return;
      }

      let connIds = sessionToConnIds.get(normalizedSessionKey);
      if (!connIds) {
        connIds = new Set<string>();
        sessionToConnIds.set(normalizedSessionKey, connIds);
      }
      connIds.add(normalizedConnId);

      let sessionKeys = connToSessionKeys.get(normalizedConnId);
      if (!sessionKeys) {
        sessionKeys = new Set<string>();
        connToSessionKeys.set(normalizedConnId, sessionKeys);
      }
      sessionKeys.add(normalizedSessionKey);
    },
    unsubscribe,
    unsubscribeAll: (connId: string) => {
      const normalizedConnId = normalizeSubscriptionToken(connId);
      if (!normalizedConnId) {
        return;
      }
      const sessionKeys = connToSessionKeys.get(normalizedConnId);
      if (!sessionKeys) {
        return;
      }
      for (const sessionKey of sessionKeys) {
        const connIds = sessionToConnIds.get(sessionKey);
        connIds?.delete(normalizedConnId);
        if (connIds?.size === 0) {
          sessionToConnIds.delete(sessionKey);
        }
      }
      connToSessionKeys.delete(normalizedConnId);
    },
    get: (sessionKey: string) => {
      const normalizedSessionKey = normalizeSubscriptionToken(sessionKey);
      if (!normalizedSessionKey) {
        return EMPTY_CONN_IDS;
      }
      return sessionToConnIds.get(normalizedSessionKey) ?? EMPTY_CONN_IDS;
    },
    clear: () => {
      sessionToConnIds.clear();
      connToSessionKeys.clear();
    },
  };
}
