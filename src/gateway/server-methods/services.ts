import {
  buildCapabilityReadinessReport,
  loadCapabilityCatalog,
} from "../../capabilities/catalog.js";
import { installCapabilityComponent } from "../../capabilities/install.js";
import { loadConfig, writeConfigFile } from "../../config/config.js";
import { runGmailSetup, type GmailSetupOptions } from "../../hooks/gmail-ops.js";
import { scheduleGatewaySigusr1Restart } from "../../infra/restart.js";
import { listConfiguredWebSearchProviders, runWebSearch } from "../../web-search/runtime.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestHandlers } from "./types.js";

function stringParam(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function numberParam(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

function booleanParam(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key];
  return typeof value === "boolean" ? value : undefined;
}

function gmailSetupOptions(params: Record<string, unknown>): GmailSetupOptions | null {
  const account = stringParam(params, "account");
  if (!account) {
    return null;
  }
  return {
    account,
    project: stringParam(params, "project"),
    topic: stringParam(params, "topic"),
    subscription: stringParam(params, "subscription"),
    label: stringParam(params, "label"),
    hookUrl: stringParam(params, "hookUrl"),
    hookToken: stringParam(params, "hookToken"),
    pushToken: stringParam(params, "pushToken"),
    bind: stringParam(params, "bind"),
    port: numberParam(params, "port"),
    path: stringParam(params, "path"),
    includeBody: booleanParam(params, "includeBody"),
    maxBytes: numberParam(params, "maxBytes"),
    renewEveryMinutes: numberParam(params, "renewEveryMinutes"),
    tailscale: stringParam(params, "tailscale") as GmailSetupOptions["tailscale"],
    tailscalePath: stringParam(params, "tailscalePath"),
    tailscaleTarget: stringParam(params, "tailscaleTarget"),
    pushEndpoint: stringParam(params, "pushEndpoint"),
    json: true,
  };
}

export const servicesHandlers: GatewayRequestHandlers = {
  "services.capabilities": async ({ respond }) => {
    try {
      respond(true, buildCapabilityReadinessReport());
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "services.component.install": async ({ respond, params }) => {
    try {
      const id = stringParam(params, "id");
      if (!id) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "Component id is required"),
        );
        return;
      }
      const result = await installCapabilityComponent({ id, config: loadConfig() });
      await writeConfigFile(result.config);
      respond(true, {
        ok: true,
        id,
        pluginId: result.pluginId,
        message: `Enabled bundled component ${result.entry.label}.`,
        restartRequired: result.entry.restartRequired !== false,
        warnings: result.slotWarnings,
        report: buildCapabilityReadinessReport({ config: result.config }),
      });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "services.component.restart": async ({ respond, params }) => {
    try {
      const id = stringParam(params, "id");
      const entry = id ? loadCapabilityCatalog().find((candidate) => candidate.id === id) : null;
      if (!entry) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "Known component id is required"),
        );
        return;
      }
      const restart = scheduleGatewaySigusr1Restart({
        reason: `services.component.restart:${entry.id}`,
      });
      respond(true, {
        ok: true,
        id: entry.id,
        message: restart.coalesced
          ? `Gateway restart already pending for ${entry.label}.`
          : `Scheduled Gateway restart for ${entry.label}.`,
      });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "services.gmail.setup": async ({ respond, params }) => {
    try {
      const parsed = gmailSetupOptions(params);
      if (!parsed) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "Gmail account is required"),
        );
        return;
      }
      const summary = await runGmailSetup(parsed);
      respond(true, { ok: true, summary });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "services.webSearch.providers": async ({ respond }) => {
    try {
      const cfg = loadConfig();
      const providers = listConfiguredWebSearchProviders({ config: cfg }).map((provider) => ({
        id: provider.id,
        label: provider.label,
        hint: provider.hint ?? "",
        pluginId: provider.pluginId,
        envVars: provider.envVars,
        placeholder: provider.placeholder ?? "",
        signupUrl: provider.signupUrl ?? "",
        credentialPath: provider.credentialPath,
        requiresCredential: provider.requiresCredential !== false,
      }));
      respond(true, { providers });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "services.webSearch.test": async ({ respond, params }) => {
    try {
      const cfg = loadConfig();
      const query =
        typeof params.query === "string" && params.query.trim()
          ? params.query.trim()
          : "Fased web_search connectivity test";
      const run = await runWebSearch({
        config: cfg,
        args: { query, count: 1 },
      });
      const { provider, result } = run;
      if (typeof result.error === "string") {
        respond(
          false,
          { provider, result },
          errorShape(
            ErrorCodes.UNAVAILABLE,
            typeof result.message === "string" ? result.message : result.error,
          ),
        );
        return;
      }
      respond(true, { provider, result });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
};
