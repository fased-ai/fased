import { vi } from "vitest";
import { installChromeUserDataDirHooks } from "./chrome-user-data-dir.test-harness.js";

const chromeUserDataDir = { dir: "/tmp/fased" };
installChromeUserDataDirHooks(chromeUserDataDir);

vi.mock("./chrome.js", () => ({
  isChromeCdpReady: vi.fn(async () => true),
  isChromeReachable: vi.fn(async () => true),
  launchFasedAgentChrome: vi.fn(async () => {
    throw new Error("unexpected launch");
  }),
  resolveFasedAgentUserDataDir: vi.fn(() => chromeUserDataDir.dir),
  stopFasedAgentChrome: vi.fn(async () => {}),
}));
