export const TAILSCALE_EXPOSURE_OPTIONS = [
  { value: "off", label: "Off", hint: "No Tailscale exposure" },
  {
    value: "serve",
    label: "Serve",
    hint: "Private HTTPS for your tailnet (devices on Tailscale)",
  },
  {
    value: "funnel",
    label: "Funnel",
    hint: "Public HTTPS via Tailscale Funnel (internet)",
  },
] as const;

export function getTailscaleMissingBinNoteLines(platform: NodeJS.Platform = process.platform) {
  if (platform === "darwin") {
    return [
      "Tailscale binary not found in PATH or /Applications.",
      "Ensure Tailscale is installed from:",
      "  https://tailscale.com/download/mac",
      "",
      "You can continue setup, but serve/funnel will fail at runtime.",
    ] as const;
  }
  return [
    "Tailscale binary not found in PATH.",
    "Ensure Tailscale is installed from:",
    "  https://tailscale.com/download",
    "",
    "You can continue setup, but serve/funnel will fail at runtime.",
  ] as const;
}

export const TAILSCALE_DOCS_LINES = [
  "Docs:",
  "https://docs.fased.ai/gateway/tailscale",
  "https://docs.fased.ai/web",
] as const;
