import { beforeEach, vi } from "vitest";

const storage = new Map<string, string>();

beforeEach(() => {
  storage.clear();
});

vi.stubGlobal("localStorage", {
  getItem(key: string) {
    return storage.get(key) ?? null;
  },
  setItem(key: string, value: string) {
    storage.set(key, value);
  },
  removeItem(key: string) {
    storage.delete(key);
  },
  clear() {
    storage.clear();
  },
});

vi.stubGlobal("sessionStorage", {
  getItem(key: string) {
    return storage.get(`session:${key}`) ?? null;
  },
  setItem(key: string, value: string) {
    storage.set(`session:${key}`, value);
  },
  removeItem(key: string) {
    storage.delete(`session:${key}`);
  },
  clear() {
    for (const key of Array.from(storage.keys())) {
      if (key.startsWith("session:")) {
        storage.delete(key);
      }
    }
  },
});

vi.stubGlobal("navigator", {
  language: "en-US",
  platform: "test",
  userAgent: "vitest",
});

const nodeWindow = {
  location: { href: "http://127.0.0.1:18789/" },
  localStorage: globalThis.localStorage,
  sessionStorage: globalThis.sessionStorage,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  setTimeout: (handler: (...args: unknown[]) => void, timeout?: number, ...args: unknown[]) =>
    globalThis.setTimeout(() => handler(...args), timeout),
  clearTimeout: (timeoutId: ReturnType<typeof globalThis.setTimeout> | undefined) =>
    globalThis.clearTimeout(timeoutId),
};

vi.stubGlobal("window", nodeWindow);
