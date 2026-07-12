declare const __FASED_UI_VERSION__: string | undefined;

export const CONTROL_UI_BUILD_VERSION =
  typeof __FASED_UI_VERSION__ === "string" && __FASED_UI_VERSION__.trim()
    ? __FASED_UI_VERSION__.trim()
    : "dev";

export function controlUiVersionMismatch(
  serverVersion: string | null | undefined,
  uiVersion = CONTROL_UI_BUILD_VERSION,
): boolean {
  const server = serverVersion?.trim();
  const ui = uiVersion.trim();
  return Boolean(server && ui && ui !== "dev" && server !== ui);
}
