import { afterEach, describe, expect, it, vi } from "vitest";
import "../styles.css";
import { installGlobalSelectEnhancer } from "./select-enhancer.ts";

let cleanup: (() => void) | null = null;

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

afterEach(() => {
  cleanup?.();
  cleanup = null;
  document.body.innerHTML = "";
});

describe("global select enhancer", () => {
  it("opens a themed listbox for normal selects and updates the native select value", async () => {
    const host = document.createElement("div");
    host.innerHTML = `
      <select aria-label="Provider">
        <option value="openrouter">OpenRouter</option>
        <option value="openai">OpenAI</option>
      </select>
    `;
    document.body.append(host);
    const select = host.querySelector("select");
    expect(select).not.toBeNull();
    if (!select) {
      return;
    }
    const onChange = vi.fn();
    select.addEventListener("change", onChange);
    cleanup = installGlobalSelectEnhancer(host);

    select.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    await nextFrame();
    await nextFrame();

    const popover = document.querySelector<HTMLElement>(".fased-select-popover");
    expect(popover).not.toBeNull();
    expect(popover?.getAttribute("role")).toBe("listbox");
    expect(popover?.textContent).toContain("OpenAI");

    const openAi = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".fased-select-popover__option"),
    ).find((button) => button.textContent?.trim() === "OpenAI");
    expect(openAi).not.toBeUndefined();
    openAi?.click();

    expect(select.value).toBe("openai");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".fased-select-popover")).toBeNull();
  });

  it("opens upward when the select is near the bottom of the viewport", async () => {
    const host = document.createElement("div");
    host.innerHTML = `
      <select aria-label="Bottom select">
        <option value="one">One</option>
        <option value="two">Two</option>
        <option value="three">Three</option>
      </select>
    `;
    document.body.append(host);
    const select = host.querySelector("select");
    expect(select).not.toBeNull();
    if (!select) {
      return;
    }
    Object.assign(select.style, {
      bottom: "8px",
      left: "20px",
      position: "fixed",
      width: "260px",
    });
    cleanup = installGlobalSelectEnhancer(host);

    select.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    await nextFrame();
    await nextFrame();

    const popover = document.querySelector<HTMLElement>(".fased-select-popover");
    expect(popover).not.toBeNull();
    expect(popover?.dataset.placement).toBe("up");
  });

  it("keeps long dropdowns open while their own list scrolls", async () => {
    const host = document.createElement("div");
    host.innerHTML = `
      <select aria-label="Model">
        ${Array.from({ length: 40 }, (_, index) => `<option value="m${index}">Model ${index}</option>`).join("")}
      </select>
    `;
    document.body.append(host);
    const select = host.querySelector("select");
    expect(select).not.toBeNull();
    if (!select) {
      return;
    }
    cleanup = installGlobalSelectEnhancer(host);

    select.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    await nextFrame();
    await nextFrame();

    const popover = document.querySelector<HTMLElement>(".fased-select-popover");
    expect(popover).not.toBeNull();
    popover!.scrollTop = 120;
    popover!.dispatchEvent(new Event("scroll", { bubbles: true }));

    expect(document.querySelector(".fased-select-popover")).not.toBeNull();

    document.dispatchEvent(new Event("scroll"));
    expect(document.querySelector(".fased-select-popover")).toBeNull();
  });

  it("keeps select popovers inside an open dialog", async () => {
    const host = document.createElement("div");
    host.innerHTML = `
      <dialog open>
        <select aria-label="Provider" style="width: 220px">
          <option value="">Inherit default</option>
          <option value="openai">OpenAI</option>
        </select>
      </dialog>
    `;
    document.body.append(host);
    const dialog = host.querySelector("dialog");
    const select = host.querySelector("select");
    expect(dialog).not.toBeNull();
    expect(select).not.toBeNull();
    if (!dialog || !select) {
      return;
    }
    cleanup = installGlobalSelectEnhancer(host);

    select.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    await nextFrame();
    await nextFrame();

    const popover = dialog.querySelector<HTMLElement>(".fased-select-popover");
    expect(popover).not.toBeNull();
    expect(document.body.querySelector(":scope > .fased-select-popover")).toBeNull();
    expect(popover?.style.position).toBe("absolute");
    expect(popover?.style.width).toBe(`${select.getBoundingClientRect().width}px`);
  });

  it("positions chat-style dropdowns up or down based on viewport space", async () => {
    const host = document.createElement("div");
    host.innerHTML = `
      <div class="chat-select">
        <details class="chat-select__popover">
          <summary class="chat-select__button">Model</summary>
          <div class="chat-select__panel" style="width: 220px">
            <button type="button">One</button>
          </div>
        </details>
      </div>
    `;
    document.body.append(host);
    const root = host.querySelector<HTMLElement>(".chat-select");
    const details = host.querySelector<HTMLDetailsElement>("details");
    const button = host.querySelector<HTMLElement>(".chat-select__button");
    const panel = host.querySelector<HTMLElement>(".chat-select__panel");
    expect(root).not.toBeNull();
    expect(details).not.toBeNull();
    expect(button).not.toBeNull();
    expect(panel).not.toBeNull();
    if (!root || !details || !button || !panel) {
      return;
    }
    cleanup = installGlobalSelectEnhancer(host);
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 720 });
    Object.defineProperty(button, "getBoundingClientRect", {
      configurable: true,
      value: () =>
        ({
          bottom: 680,
          height: 36,
          left: 20,
          right: 240,
          top: 644,
          width: 220,
          x: 20,
          y: 644,
          toJSON: () => ({}),
        }) as DOMRect,
    });
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
    await nextFrame();
    expect(root.dataset.placement).toBe("up");

    Object.defineProperty(button, "getBoundingClientRect", {
      configurable: true,
      value: () =>
        ({
          bottom: 96,
          height: 36,
          left: 20,
          right: 240,
          top: 60,
          width: 220,
          x: 20,
          y: 60,
          toJSON: () => ({}),
        }) as DOMRect,
    });
    details.dispatchEvent(new Event("toggle"));
    await nextFrame();
    expect(root.dataset.placement).toBe("down");
  });

  it("floats opted-in chat-style dropdown panels beyond scroll containers", async () => {
    const host = document.createElement("div");
    host.innerHTML = `
      <div class="chat-select" data-floating-select="true">
        <details class="chat-select__popover">
          <summary class="chat-select__button">Model</summary>
          <div class="chat-select__panel" style="width: 220px">
            <button type="button">One</button>
          </div>
        </details>
      </div>
    `;
    document.body.append(host);
    const root = host.querySelector<HTMLElement>(".chat-select");
    const details = host.querySelector<HTMLDetailsElement>("details");
    const button = host.querySelector<HTMLElement>(".chat-select__button");
    const panel = host.querySelector<HTMLElement>(".chat-select__panel");
    expect(root).not.toBeNull();
    expect(details).not.toBeNull();
    expect(button).not.toBeNull();
    expect(panel).not.toBeNull();
    if (!root || !details || !button || !panel) {
      return;
    }
    cleanup = installGlobalSelectEnhancer(host);
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 900 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 720 });
    Object.defineProperty(button, "getBoundingClientRect", {
      configurable: true,
      value: () =>
        ({
          bottom: 126,
          height: 36,
          left: 40,
          right: 260,
          top: 90,
          width: 220,
          x: 40,
          y: 90,
          toJSON: () => ({}),
        }) as DOMRect,
    });
    Object.defineProperty(panel, "getBoundingClientRect", {
      configurable: true,
      value: () =>
        ({
          bottom: 0,
          height: 160,
          left: 0,
          right: 320,
          top: 0,
          width: 320,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect,
    });
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
    await nextFrame();
    await nextFrame();
    expect(root.dataset.placement).toBe("down");
    expect(panel.style.position).toBe("fixed");
    expect(panel.style.width).toBe("320px");
    expect(panel.style.left).toBe("40px");
    expect(panel.style.top).toBe("132px");
    expect(panel.style.visibility).toBe("");
  });
});
