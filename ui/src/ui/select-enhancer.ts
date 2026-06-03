type SelectEnhancerCleanup = () => void;

type OptionRow =
  | { kind: "group"; label: string }
  | {
      kind: "option";
      disabled: boolean;
      index: number;
      label: string;
      selected: boolean;
      title: string;
      value: string;
    };

const POPOVER_CLASS = "fased-select-popover";
const OPTION_SELECTOR = "[data-fased-select-option]";
const CHAT_SELECT_DETAILS_SELECTOR = "details.chat-select__popover";
const SKIP_SELECT_SELECTOR = [
  ".chat-select__native",
  "[data-native-select='true']",
  "[aria-hidden='true']",
].join(",");

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}

function isVisibleSelect(select: HTMLSelectElement): boolean {
  if (
    select.multiple ||
    select.size > 1 ||
    select.disabled ||
    select.matches(SKIP_SELECT_SELECTOR)
  ) {
    return false;
  }
  const rect = select.getBoundingClientRect();
  return rect.width > 2 && rect.height > 2;
}

function collectRows(select: HTMLSelectElement): OptionRow[] {
  const rows: OptionRow[] = [];
  let index = 0;
  for (const child of Array.from(select.children)) {
    if (child instanceof HTMLOptGroupElement) {
      if (child.hidden) {
        continue;
      }
      rows.push({ kind: "group", label: child.label });
      for (const option of Array.from(child.children)) {
        if (!(option instanceof HTMLOptionElement) || option.hidden) {
          continue;
        }
        rows.push({
          kind: "option",
          disabled: child.disabled || option.disabled,
          index,
          label: option.label || option.textContent?.trim() || option.value,
          selected: option.selected,
          title: option.title || option.label || option.textContent?.trim() || option.value,
          value: option.value,
        });
        index += 1;
      }
      continue;
    }
    if (child instanceof HTMLOptionElement) {
      if (child.hidden) {
        continue;
      }
      rows.push({
        kind: "option",
        disabled: child.disabled,
        index,
        label: child.label || child.textContent?.trim() || child.value,
        selected: child.selected,
        title: child.title || child.label || child.textContent?.trim() || child.value,
        value: child.value,
      });
      index += 1;
    }
  }
  return rows;
}

function optionButtons(panel: HTMLElement): HTMLButtonElement[] {
  return Array.from(panel.querySelectorAll<HTMLButtonElement>(OPTION_SELECTOR)).filter(
    (button) => !button.disabled,
  );
}

function focusOption(panel: HTMLElement, direction: 1 | -1 | "first" | "last") {
  const buttons = optionButtons(panel);
  if (buttons.length === 0) {
    return;
  }
  const current =
    document.activeElement instanceof HTMLButtonElement
      ? buttons.indexOf(document.activeElement)
      : -1;
  const nextIndex =
    direction === "first"
      ? 0
      : direction === "last"
        ? buttons.length - 1
        : current < 0
          ? 0
          : clamp(current + direction, 0, buttons.length - 1);
  buttons[nextIndex]?.focus({ preventScroll: true });
  buttons[nextIndex]?.scrollIntoView({ block: "nearest" });
}

function popoverHostForSelect(select: HTMLSelectElement): HTMLElement {
  const dialog = select.closest<HTMLDialogElement>("dialog[open]");
  return dialog ?? document.body;
}

function positionChatSelect(details: HTMLDetailsElement) {
  if (!details.open) {
    return;
  }
  const root = details.closest<HTMLElement>(".chat-select");
  const button = details.querySelector<HTMLElement>(".chat-select__button");
  const panel = details.querySelector<HTMLElement>(".chat-select__panel");
  if (!root || !button || !panel) {
    return;
  }
  const rect = button.getBoundingClientRect();
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1024;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 768;
  const gutter = 8;
  const spaceBelow = Math.max(0, viewportHeight - rect.bottom - gutter);
  const spaceAbove = Math.max(0, rect.top - gutter);
  const placement = spaceBelow >= 180 || spaceBelow >= spaceAbove ? "down" : "up";
  const available = Math.max(96, (placement === "down" ? spaceBelow : spaceAbove) - 6);
  root.dataset.placement = placement;
  panel.style.maxHeight = `${Math.min(360, available)}px`;

  if (root.dataset.floatingSelect === "true") {
    const maxWidth = viewportWidth - gutter * 2;
    const width = clamp(Math.max(rect.width, 320), Math.min(rect.width, maxWidth), maxWidth);
    const left = clamp(rect.left, gutter, viewportWidth - width - gutter);
    panel.style.position = "fixed";
    panel.style.left = `${left}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
    panel.style.width = `${width}px`;
    panel.style.minWidth = "0px";
    panel.style.maxWidth = `${width}px`;
    panel.style.setProperty("--chat-select-panel-x", "0px");
    panel.style.top = "0px";
    panel.style.visibility = "hidden";
    requestAnimationFrame(() => {
      if (!details.open) {
        return;
      }
      const measured = panel.getBoundingClientRect();
      const rawTop = placement === "up" ? rect.top - measured.height - 6 : rect.bottom + 6;
      panel.style.top = `${clamp(rawTop, gutter, viewportHeight - measured.height - gutter)}px`;
      panel.style.visibility = "";
    });
    return;
  }

  const panelWidth = panel.getBoundingClientRect().width || rect.width;
  const overflowRight = Math.max(0, rect.left + panelWidth - viewportWidth + gutter);
  const overflowLeft = Math.max(0, gutter - (rect.left - overflowRight));
  const offset = overflowLeft - overflowRight;
  panel.style.setProperty("--chat-select-panel-x", `${offset}px`);
}

export function installGlobalSelectEnhancer(root: ParentNode): SelectEnhancerCleanup {
  let activeSelect: HTMLSelectElement | null = null;
  let panel: HTMLElement | null = null;

  const close = (opts?: { focusSelect?: boolean }) => {
    const select = activeSelect;
    panel?.remove();
    panel = null;
    activeSelect = null;
    if (opts?.focusSelect && select && document.contains(select)) {
      select.focus({ preventScroll: true });
    }
  };
  const closeForEvent = () => close();

  const selectValue = (value: string) => {
    if (!activeSelect || activeSelect.value === value) {
      close({ focusSelect: true });
      return;
    }
    activeSelect.value = value;
    activeSelect.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    activeSelect.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    close({ focusSelect: true });
  };

  const positionPanel = (select: HTMLSelectElement, popover: HTMLElement, host: HTMLElement) => {
    const rect = select.getBoundingClientRect();
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1024;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 768;
    const gutter = 8;
    const hostRect = host instanceof HTMLDialogElement ? host.getBoundingClientRect() : null;
    const bounds = hostRect ?? {
      bottom: viewportHeight,
      height: viewportHeight,
      left: 0,
      right: viewportWidth,
      top: 0,
      width: viewportWidth,
    };
    const width = clamp(rect.width, 80, Math.max(80, bounds.width - gutter * 2));
    const spaceBelow = Math.max(0, bounds.bottom - rect.bottom - gutter);
    const spaceAbove = Math.max(0, rect.top - bounds.top - gutter);
    const placement = spaceBelow < 220 && spaceAbove > spaceBelow ? "up" : "down";
    const available = placement === "up" ? spaceAbove : spaceBelow;
    const maxHeight = clamp(Math.min(320, Math.max(available - 6, 96)), 96, 320);
    const left = hostRect
      ? clamp(rect.left - hostRect.left, gutter, bounds.width - width - gutter)
      : clamp(rect.left, gutter, viewportWidth - width - gutter);
    popover.style.position = hostRect ? "absolute" : "fixed";
    popover.style.width = `${width}px`;
    popover.style.minWidth = "0px";
    popover.style.maxWidth = `${width}px`;
    popover.style.maxHeight = `${maxHeight}px`;
    popover.style.left = `${left}px`;
    popover.style.top = "0px";
    popover.dataset.placement = placement;
    popover.style.visibility = "hidden";
    requestAnimationFrame(() => {
      if (popover !== panel || !activeSelect) {
        return;
      }
      const measured = popover.getBoundingClientRect();
      const rawTop = hostRect
        ? placement === "up"
          ? rect.top - hostRect.top - measured.height - 6
          : rect.bottom - hostRect.top + 6
        : placement === "up"
          ? rect.top - measured.height - 6
          : rect.bottom + 6;
      const top = hostRect
        ? clamp(rawTop, gutter, bounds.height - measured.height - gutter)
        : clamp(rawTop, gutter, viewportHeight - measured.height - gutter);
      popover.style.top = `${top}px`;
      popover.style.visibility = "";
    });
  };

  const open = (select: HTMLSelectElement) => {
    if (!root.contains(select) || !isVisibleSelect(select)) {
      return;
    }
    close();
    activeSelect = select;
    const rows = collectRows(select);
    panel = document.createElement("div");
    panel.className = POPOVER_CLASS;
    panel.setAttribute("role", "listbox");
    panel.setAttribute(
      "aria-label",
      select.getAttribute("aria-label") || select.name || "Select option",
    );
    panel.tabIndex = -1;
    panel.innerHTML = rows
      .map((row) => {
        if (row.kind === "group") {
          return `<div class="fased-select-popover__group">${escapeHtml(row.label)}</div>`;
        }
        const disabled = row.disabled ? " disabled" : "";
        const selected = row.selected ? " true" : " false";
        const active = row.selected ? " active" : "";
        return `<button type="button" class="fased-select-popover__option${active}" role="option" aria-selected="${selected.trim()}" data-fased-select-option="${row.index}" data-value="${escapeHtml(row.value)}" title="${escapeHtml(row.title)}"${disabled}>${escapeHtml(row.label)}</button>`;
      })
      .join("");
    panel.addEventListener("click", (event) => {
      const target =
        event.target instanceof Element
          ? event.target.closest<HTMLButtonElement>(OPTION_SELECTOR)
          : null;
      if (!target || target.disabled) {
        return;
      }
      selectValue(target.dataset.value ?? "");
    });
    panel.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close({ focusSelect: true });
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        focusOption(panel!, 1);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        focusOption(panel!, -1);
        return;
      }
      if (event.key === "Home") {
        event.preventDefault();
        focusOption(panel!, "first");
        return;
      }
      if (event.key === "End") {
        event.preventDefault();
        focusOption(panel!, "last");
      }
    });
    const host = popoverHostForSelect(select);
    host.append(panel);
    positionPanel(select, panel, host);
    const selectedButton =
      panel.querySelector<HTMLButtonElement>(
        ".fased-select-popover__option.active:not(:disabled)",
      ) ?? optionButtons(panel)[0];
    requestAnimationFrame(() => {
      if (panel) {
        selectedButton?.focus({ preventScroll: true });
        selectedButton?.scrollIntoView({ block: "nearest" });
      }
    });
  };

  const handlePointerDown = (event: PointerEvent) => {
    const target = event.target instanceof Element ? event.target : null;
    const chatSelectDetails = target?.closest<HTMLDetailsElement>(CHAT_SELECT_DETAILS_SELECTOR);
    if (
      chatSelectDetails &&
      root.contains(chatSelectDetails) &&
      target?.closest(".chat-select__button")
    ) {
      requestAnimationFrame(() => positionChatSelect(chatSelectDetails));
    }
    if (target?.closest(`.${POPOVER_CLASS}`)) {
      return;
    }
    const select = target instanceof HTMLSelectElement ? target : target?.closest("select");
    if (select instanceof HTMLSelectElement && root.contains(select) && isVisibleSelect(select)) {
      event.preventDefault();
      event.stopPropagation();
      open(select);
      return;
    }
    close();
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    const target = event.target;
    if (
      !(target instanceof HTMLSelectElement) ||
      !root.contains(target) ||
      !isVisibleSelect(target)
    ) {
      return;
    }
    if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown") {
      event.preventDefault();
      open(target);
    }
  };

  const handleScroll = (event: Event) => {
    const target = event.target;
    if (panel && target instanceof Node && panel.contains(target)) {
      return;
    }
    close();
  };

  const handleDetailsToggle = (event: Event) => {
    const details = event.target;
    if (
      !(details instanceof HTMLDetailsElement) ||
      !details.matches(CHAT_SELECT_DETAILS_SELECTOR)
    ) {
      return;
    }
    if (!root.contains(details)) {
      return;
    }
    positionChatSelect(details);
  };

  document.addEventListener("pointerdown", handlePointerDown, true);
  document.addEventListener("keydown", handleKeyDown, true);
  document.addEventListener("scroll", handleScroll, true);
  document.addEventListener("toggle", handleDetailsToggle as EventListener, true);
  window.addEventListener("resize", closeForEvent);

  return () => {
    close();
    document.removeEventListener("pointerdown", handlePointerDown, true);
    document.removeEventListener("keydown", handleKeyDown, true);
    document.removeEventListener("scroll", handleScroll, true);
    document.removeEventListener("toggle", handleDetailsToggle as EventListener, true);
    window.removeEventListener("resize", closeForEvent);
  };
}
