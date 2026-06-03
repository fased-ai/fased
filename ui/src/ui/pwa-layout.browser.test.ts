import { afterEach, describe, expect, it } from "vitest";
import { commands, page } from "vitest/browser";
import "../styles.css";
import { mountApp as mountTestApp, registerAppMountHooks } from "./test-helpers/app-mount.ts";

registerAppMountHooks();

const MOBILE_VIEWPORT = { width: 390, height: 844 };
const DESKTOP_VIEWPORT = { width: 1280, height: 800 };

afterEach(async () => {
  await page.viewport(MOBILE_VIEWPORT.width, MOBILE_VIEWPORT.height);
});

function nextFrame() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

async function mountAtViewport(pathname: string, viewport: { width: number; height: number }) {
  await page.viewport(viewport.width, viewport.height);
  const app = mountTestApp(pathname);
  app.applySettings({ ...app.settings, token: "owner-token-for-pwa-layout-test" });
  await app.updateComplete;
  await nextFrame();
  await nextFrame();
  return app;
}

function requireElement<T extends HTMLElement>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  expect(element, selector).not.toBeNull();
  if (!element) {
    throw new Error(`Missing ${selector}`);
  }
  return element;
}

function expectNoHorizontalOverflow(label: string) {
  expect(document.documentElement.scrollWidth, `${label} document overflow`).toBeLessThanOrEqual(
    window.innerWidth + 1,
  );
  expect(document.body.scrollWidth, `${label} body overflow`).toBeLessThanOrEqual(
    window.innerWidth + 1,
  );
}

function expectVisibleWithinViewport(element: HTMLElement, label: string) {
  const rect = element.getBoundingClientRect();
  expect(rect.width, `${label} width`).toBeGreaterThan(0);
  expect(rect.height, `${label} height`).toBeGreaterThan(0);
  expect(rect.left, `${label} left`).toBeGreaterThanOrEqual(-1);
  expect(rect.right, `${label} right`).toBeLessThanOrEqual(window.innerWidth + 1);
  expect(rect.top, `${label} top`).toBeGreaterThanOrEqual(-1);
  expect(rect.top, `${label} top visible`).toBeLessThanOrEqual(window.innerHeight + 1);
}

async function expectScreenshotCaptured(label: string) {
  const screenshot = await page.screenshot({
    path: `__screenshots__/pwa-layout/${label}.png`,
    save: false,
  });
  expect(screenshot.length, `${label} screenshot bytes`).toBeGreaterThan(5000);
}

function expectAppChromeGeometry(app: HTMLElement, label: string) {
  const shell = requireElement<HTMLElement>(app, ".shell");
  const topbar = requireElement<HTMLElement>(app, ".topbar");
  const nav = requireElement<HTMLElement>(app, ".nav");
  const content = requireElement<HTMLElement>(app, ".content");
  const shellRect = shell.getBoundingClientRect();
  const topbarRect = topbar.getBoundingClientRect();
  const navRect = nav.getBoundingClientRect();
  const contentRect = content.getBoundingClientRect();

  expectVisibleWithinViewport(shell, `${label} shell`);
  expectVisibleWithinViewport(topbar, `${label} topbar`);
  expectVisibleWithinViewport(nav, `${label} nav`);
  expectVisibleWithinViewport(content, `${label} content`);
  expectNoHorizontalOverflow(label);

  expect(shellRect.width, `${label} shell width`).toBeLessThanOrEqual(window.innerWidth + 1);
  expect(shellRect.height, `${label} shell height`).toBeGreaterThanOrEqual(window.innerHeight - 1);
  expect(topbarRect.bottom, `${label} topbar before content`).toBeLessThanOrEqual(
    contentRect.top + 1,
  );
  const hasStackedNav = navRect.bottom <= contentRect.top + 1;
  const hasSideNav = navRect.right <= contentRect.left + 1;
  if (hasStackedNav) {
    expect(topbarRect.bottom, `${label} topbar before nav`).toBeLessThanOrEqual(navRect.top + 1);
  }
  expect(hasStackedNav || hasSideNav, `${label} nav/content order`).toBe(true);
}

describe("iOS standalone PWA layout", () => {
  it("keeps standalone iOS metadata and safe-area capable CSS in place", async () => {
    const index = await commands.readFile("index.html");
    const styles = await commands.readFile("src/styles/components.css");
    const layout = await commands.readFile("src/styles/layout.css");

    expect(index).toContain('name="viewport" content="width=device-width, initial-scale=1.0"');
    expect(index).toContain('name="apple-mobile-web-app-capable" content="yes"');
    expect(index).toContain(
      'name="apple-mobile-web-app-status-bar-style" content="black-translucent"',
    );
    expect(index).toContain('name="mobile-web-app-capable" content="yes"');
    expect(index).toContain('rel="manifest" href="/manifest.webmanifest"');
    expect(index).toContain('rel="apple-touch-icon" sizes="180x180"');
    expect(layout).toContain("@supports (height: 100dvh)");
    expect(styles).toContain("env(safe-area-inset-bottom");
  });

  it("captures and checks the standalone mobile shell at an iPhone-sized viewport", async () => {
    const app = await mountAtViewport("/overview", MOBILE_VIEWPORT);

    expect(window.innerWidth).toBe(MOBILE_VIEWPORT.width);
    expect(window.innerHeight).toBe(MOBILE_VIEWPORT.height);
    expect(window.matchMedia("(max-width: 600px)").matches).toBe(true);

    expectAppChromeGeometry(app, "mobile");
    await expectScreenshotCaptured("mobile-overview");
  });

  it("captures and checks the desktop shell so PWA changes do not collapse wide layout", async () => {
    const app = await mountAtViewport("/overview", DESKTOP_VIEWPORT);

    expect(window.innerWidth).toBe(DESKTOP_VIEWPORT.width);
    expect(window.innerHeight).toBe(DESKTOP_VIEWPORT.height);
    expect(window.matchMedia("(min-width: 769px)").matches).toBe(true);

    expectAppChromeGeometry(app, "desktop");
    await expectScreenshotCaptured("desktop-overview");
  });

  it("captures representative Control UI polish pages on desktop and mobile", async () => {
    for (const pathname of ["/chat", "/agents", "/providers", "/cron", "/debug"]) {
      const mobile = await mountAtViewport(pathname, MOBILE_VIEWPORT);
      expectAppChromeGeometry(mobile, `mobile-${pathname}`);
      await expectScreenshotCaptured(`mobile-${pathname.slice(1)}`);
      mobile.remove();

      const desktop = await mountAtViewport(pathname, DESKTOP_VIEWPORT);
      expectAppChromeGeometry(desktop, `desktop-${pathname}`);
      await expectScreenshotCaptured(`desktop-${pathname.slice(1)}`);
      desktop.remove();
    }
  });
});
