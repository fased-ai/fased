import type { GatewayBrowserClient } from "../gateway.ts";
import type { CommandsListResult } from "../types.ts";

export type CommandsCatalogScope = "native" | "text" | "both";

export type CommandsCatalogState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  commandsCatalogLoading: boolean;
  commandsCatalogError: string | null;
  commandsCatalog: CommandsListResult | null;
  commandsCatalogScope: CommandsCatalogScope;
};

function getErrorMessage(err: unknown) {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

export async function loadCommandsCatalog(state: CommandsCatalogState, opts?: { quiet?: boolean }) {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.commandsCatalogLoading) {
    return;
  }
  state.commandsCatalogLoading = true;
  if (!opts?.quiet) {
    state.commandsCatalogError = null;
  }
  try {
    const res = await state.client.request<CommandsListResult>("commands.list", {
      scope: state.commandsCatalogScope,
      includeArgs: true,
    });
    state.commandsCatalog = res;
  } catch (err) {
    if (!opts?.quiet) {
      state.commandsCatalogError = getErrorMessage(err);
    }
  } finally {
    state.commandsCatalogLoading = false;
  }
}
