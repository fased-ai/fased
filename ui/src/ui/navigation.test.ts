import { describe, expect, it } from "vitest";
import {
  TAB_GROUPS,
  iconForTab,
  inferBasePathFromPathname,
  navTitleForTab,
  normalizeBasePath,
  normalizePath,
  pathForTab,
  subtitleForTab,
  tabFromPath,
  titleForTab,
  type Tab,
} from "./navigation.ts";

/** All valid tab identifiers derived from TAB_GROUPS */
const ALL_TABS: Tab[] = TAB_GROUPS.flatMap((group) => group.tabs) as Tab[];

describe("iconForTab", () => {
  it("returns a non-empty string for every tab", () => {
    for (const tab of ALL_TABS) {
      const icon = iconForTab(tab);
      expect(icon).toBeTruthy();
      expect(typeof icon).toBe("string");
      expect(icon.length).toBeGreaterThan(0);
    }
  });

  it("returns stable icons for known tabs", () => {
    expect(iconForTab("chat")).toBe("messageSquare");
    expect(iconForTab("overview")).toBe("barChart");
    expect(iconForTab("providers")).toBe("settings");
    expect(iconForTab("federation")).toBe("network");
    expect(iconForTab("services")).toBe("link");
    expect(iconForTab("marketplace")).toBe("store");
    expect(iconForTab("channels")).toBe("link");
    expect(iconForTab("instances")).toBe("radio");
    expect(iconForTab("sessions")).toBe("fileText");
    expect(iconForTab("memory")).toBe("brain");
    expect(iconForTab("cron")).toBe("loader");
    expect(iconForTab("skills")).toBe("zap");
    expect(iconForTab("nodes")).toBe("monitor");
    expect(iconForTab("config")).toBe("settings");
    expect(iconForTab("debug")).toBe("bug");
    expect(iconForTab("logs")).toBe("scrollText");
  });

  it("returns a fallback icon for unknown tab", () => {
    // TypeScript won't allow this normally, but runtime could receive unexpected values
    const unknownTab = "unknown" as Tab;
    expect(iconForTab(unknownTab)).toBe("folder");
  });
});

describe("titleForTab", () => {
  it("returns a non-empty string for every tab", () => {
    for (const tab of ALL_TABS) {
      const title = titleForTab(tab);
      expect(title).toBeTruthy();
      expect(typeof title).toBe("string");
    }
  });

  it("returns expected titles", () => {
    expect(titleForTab("chat")).toBe("Chat");
    expect(titleForTab("overview")).toBe("Dashboard");
    expect(titleForTab("providers")).toBe("Providers");
    expect(titleForTab("services")).toBe("Services");
    expect(titleForTab("federation")).toBe("Fased Network");
    expect(titleForTab("wallet")).toBe("Wallets");
    expect(titleForTab("marketplace")).toBe("Marketplace");
    expect(titleForTab("plugins")).toBe("Extensions");
    expect(titleForTab("skills")).toBe("Skills");
    expect(titleForTab("memory")).toBe("Memory");
    expect(titleForTab("cron")).toBe("Tasks");
    expect(titleForTab("config")).toBe("Advanced");
  });
});

describe("navTitleForTab", () => {
  it("uses the compact navigation label for the Fased Network tab", () => {
    expect(navTitleForTab("federation")).toBe("Network");
    expect(navTitleForTab("channels")).toBe("Channels");
    expect(navTitleForTab("plugins")).toBe("Extensions");
    expect(navTitleForTab("marketplace")).toBe("Marketplace");
    expect(navTitleForTab("config")).toBe("Advanced");
  });
});

describe("subtitleForTab", () => {
  it("returns a string for every tab", () => {
    for (const tab of ALL_TABS) {
      const subtitle = subtitleForTab(tab);
      expect(typeof subtitle).toBe("string");
    }
  });

  it("returns descriptive subtitles", () => {
    expect(subtitleForTab("chat")).toContain("Working terminal");
    expect(subtitleForTab("providers")).toContain("paste API keys");
    expect(subtitleForTab("services")).toContain("Gmail");
    expect(subtitleForTab("plugins")).toContain("Runtime extensions");
    expect(subtitleForTab("memory")).toContain("Session archives");
    expect(subtitleForTab("config")).toContain("Advanced");
  });
});

describe("normalizeBasePath", () => {
  it("returns empty string for falsy input", () => {
    expect(normalizeBasePath("")).toBe("");
  });

  it("adds leading slash if missing", () => {
    expect(normalizeBasePath("ui")).toBe("/ui");
  });

  it("removes trailing slash", () => {
    expect(normalizeBasePath("/ui/")).toBe("/ui");
  });

  it("returns empty string for root path", () => {
    expect(normalizeBasePath("/")).toBe("");
  });

  it("handles nested paths", () => {
    expect(normalizeBasePath("/apps/fased")).toBe("/apps/fased");
  });
});

describe("normalizePath", () => {
  it("returns / for falsy input", () => {
    expect(normalizePath("")).toBe("/");
  });

  it("adds leading slash if missing", () => {
    expect(normalizePath("chat")).toBe("/chat");
  });

  it("removes trailing slash except for root", () => {
    expect(normalizePath("/chat/")).toBe("/chat");
    expect(normalizePath("/")).toBe("/");
  });
});

describe("pathForTab", () => {
  it("returns correct path without base", () => {
    expect(pathForTab("chat")).toBe("/chat");
    expect(pathForTab("overview")).toBe("/dash");
    expect(pathForTab("providers")).toBe("/providers");
    expect(pathForTab("services")).toBe("/services");
    expect(pathForTab("plugins")).toBe("/extensions");
    expect(pathForTab("memory")).toBe("/memory");
    expect(pathForTab("marketplace")).toBe("/marketplace");
  });

  it("prepends base path", () => {
    expect(pathForTab("chat", "/ui")).toBe("/ui/chat");
    expect(pathForTab("sessions", "/apps/fased")).toBe("/apps/fased/sessions");
  });
});

describe("tabFromPath", () => {
  it("returns tab for valid path", () => {
    expect(tabFromPath("/chat")).toBe("chat");
    expect(tabFromPath("/dash")).toBe("overview");
    expect(tabFromPath("/overview")).toBe("overview");
    expect(tabFromPath("/marketplace")).toBe("marketplace");
    expect(tabFromPath("/providers")).toBe("providers");
    expect(tabFromPath("/services")).toBe("services");
    expect(tabFromPath("/extensions")).toBe("plugins");
    expect(tabFromPath("/plugins")).toBe("plugins");
    expect(tabFromPath("/sessions")).toBe("sessions");
    expect(tabFromPath("/memory")).toBe("memory");
    expect(tabFromPath("/wallet")).toBe("wallet");
    expect(tabFromPath("/mining")).toBe("mining");
  });

  it("returns overview for root path", () => {
    expect(tabFromPath("/")).toBe("overview");
  });

  it("handles base paths", () => {
    expect(tabFromPath("/ui/chat", "/ui")).toBe("chat");
    expect(tabFromPath("/apps/fased/sessions", "/apps/fased")).toBe("sessions");
  });

  it("returns null for unknown path", () => {
    expect(tabFromPath("/unknown")).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(tabFromPath("/CHAT")).toBe("chat");
    expect(tabFromPath("/DASH")).toBe("overview");
    expect(tabFromPath("/Overview")).toBe("overview");
  });
});

describe("inferBasePathFromPathname", () => {
  it("returns empty string for root", () => {
    expect(inferBasePathFromPathname("/")).toBe("");
  });

  it("returns empty string for direct tab path", () => {
    expect(inferBasePathFromPathname("/chat")).toBe("");
    expect(inferBasePathFromPathname("/dash")).toBe("");
    expect(inferBasePathFromPathname("/overview")).toBe("");
    expect(inferBasePathFromPathname("/memory")).toBe("");
    expect(inferBasePathFromPathname("/wallet")).toBe("");
    expect(inferBasePathFromPathname("/mining")).toBe("");
  });

  it("infers base path from nested paths", () => {
    expect(inferBasePathFromPathname("/ui/chat")).toBe("/ui");
    expect(inferBasePathFromPathname("/apps/fased/sessions")).toBe("/apps/fased");
  });

  it("handles index.html suffix", () => {
    expect(inferBasePathFromPathname("/index.html")).toBe("");
    expect(inferBasePathFromPathname("/ui/index.html")).toBe("/ui");
  });
});

describe("TAB_GROUPS", () => {
  it("uses a single flat navigation group", () => {
    expect(TAB_GROUPS.map((g) => g.label)).toEqual(["Navigation"]);
  });

  it("all tabs are unique", () => {
    const allTabs = TAB_GROUPS.flatMap((g) => g.tabs);
    const uniqueTabs = new Set(allTabs);
    expect(uniqueTabs.size).toBe(allTabs.length);
  });
});
