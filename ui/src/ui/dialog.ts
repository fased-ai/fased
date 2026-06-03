export function openDialogSafely(el?: Element | null): void {
  if (!(el instanceof HTMLDialogElement) || el.open) {
    return;
  }
  if (typeof el.showModal === "function") {
    try {
      el.showModal();
      return;
    } catch {
      // Fall back to non-modal open if another modal is already active.
    }
  }
  el.setAttribute("open", "");
}

export function closeDialogOnBackdropClick(event: MouseEvent): void {
  const dialog = event.currentTarget;
  if (!(dialog instanceof HTMLDialogElement) || event.target !== dialog) {
    return;
  }
  const rect = dialog.getBoundingClientRect();
  const hasMeasuredRect = rect.width > 0 || rect.height > 0;
  const isInsideDialog =
    hasMeasuredRect &&
    event.clientX >= rect.left &&
    event.clientX <= rect.right &&
    event.clientY >= rect.top &&
    event.clientY <= rect.bottom;
  if (!isInsideDialog) {
    dialog.close();
  }
}
