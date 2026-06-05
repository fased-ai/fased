import { readConfigFileSnapshot, resolveGatewayPort } from "../config/config.js";
import { normalizeControlUiBasePath } from "../gateway/control-ui-shared.js";
import { copyToClipboard } from "../infra/clipboard.js";
import { getTailnetHostname } from "../infra/tailscale.js";
import { runExec } from "../process/exec.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import {
  detectBrowserOpenSupport,
  formatControlUiSshHint,
  openUrl,
  resolveControlUiLinks,
} from "./onboard-helpers.js";

type DashboardOptions = {
  noOpen?: boolean;
};

function buildDashboardUrl(params: { httpUrl: string; token?: string }): string {
  const url = new URL(params.httpUrl);
  const hashParams = new URLSearchParams();
  const token = params.token?.trim();
  if (token) {
    hashParams.set("token", token);
  }
  const hash = hashParams.toString();
  url.hash = hash ? `#${hash}` : "";
  return url.toString();
}

async function resolveHostedDashboardHttpUrl(params: {
  tailscaleMode?: "off" | "serve" | "funnel";
  basePath?: string;
}): Promise<string | null> {
  if (!params.tailscaleMode || params.tailscaleMode === "off") {
    return null;
  }
  const dns = await getTailnetHostname((cmd, args) =>
    runExec(cmd, args, { timeoutMs: 1200, maxBuffer: 200_000 }),
  ).catch(() => null);
  if (!dns) {
    return null;
  }
  const basePath = normalizeControlUiBasePath(params.basePath);
  return `https://${dns}${basePath || "/"}`;
}

export async function dashboardCommand(
  runtime: RuntimeEnv = defaultRuntime,
  options: DashboardOptions = {},
) {
  const snapshot = await readConfigFileSnapshot();
  const cfg = snapshot.valid ? snapshot.config : {};
  const port = resolveGatewayPort(cfg);
  const bind = cfg.gateway?.bind ?? "loopback";
  const basePath = cfg.gateway?.controlUi?.basePath;
  const customBindHost = cfg.gateway?.customBindHost;
  const token = cfg.gateway?.auth?.token ?? process.env.FASED_GATEWAY_TOKEN ?? "";

  // LAN URLs fail secure-context checks in browsers.
  // Coerce only lan->loopback and preserve other bind modes.
  const links = resolveControlUiLinks({
    port,
    bind: bind === "lan" ? "loopback" : bind,
    customBindHost,
    basePath,
  });
  const hostedHttpUrl =
    (await resolveHostedDashboardHttpUrl({
      tailscaleMode: cfg.gateway?.tailscale?.mode ?? "off",
      basePath,
    })) ?? links.httpUrl;
  // Prefer URL fragment to avoid leaking auth tokens via query params.
  const dashboardUrl = buildDashboardUrl({
    httpUrl: hostedHttpUrl,
    token,
  });

  runtime.log(`Dashboard URL: ${dashboardUrl}`);

  const copied = await copyToClipboard(dashboardUrl).catch(() => false);
  runtime.log(copied ? "Copied to clipboard." : "Copy to clipboard unavailable.");

  let opened = false;
  let hint: string | undefined;
  if (!options.noOpen) {
    const browserSupport = await detectBrowserOpenSupport();
    if (browserSupport.ok) {
      opened = await openUrl(dashboardUrl);
    }
    if (!opened) {
      hint = formatControlUiSshHint({
        port,
        basePath,
        token: token || undefined,
      });
    }
  } else {
    hint = "Browser launch disabled (--no-open). Use the URL above.";
  }

  if (opened) {
    runtime.log("Opened in your browser. Keep that tab to control Fased Agent.");
  } else if (hint) {
    runtime.log(hint);
  }
}
