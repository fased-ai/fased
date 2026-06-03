import { html, nothing } from "lit";
import type { GatewaySessionRow } from "../types.ts";

const CONTEXT_NOTICE_RATIO = 0.85;

function parseHexRgb(hex: string): [number, number, number] | null {
  const h = hex.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) {
    return null;
  }
  return [
    Number.parseInt(h.slice(0, 2), 16),
    Number.parseInt(h.slice(2, 4), 16),
    Number.parseInt(h.slice(4, 6), 16),
  ];
}

function getThemeColor(name: string, fallback: [number, number, number]): [number, number, number] {
  if (typeof document === "undefined") {
    return fallback;
  }
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return parseHexRgb(value) ?? fallback;
}

export function renderContextNotice(
  session: GatewaySessionRow | undefined,
  defaultContextTokens: number | null,
) {
  if (session?.totalTokensFresh === false) {
    return nothing;
  }
  const used = session?.totalTokens ?? 0;
  const limit = session?.contextTokens ?? defaultContextTokens ?? 0;
  if (!used || !limit) {
    return nothing;
  }

  const ratio = used / limit;
  if (ratio < CONTEXT_NOTICE_RATIO) {
    return nothing;
  }

  const pct = Math.min(Math.round(ratio * 100), 100);
  const warn = getThemeColor("--warn", [245, 158, 11]);
  const danger = getThemeColor("--danger", [239, 68, 68]);
  const t = Math.min(Math.max((ratio - CONTEXT_NOTICE_RATIO) / 0.1, 0), 1);
  const r = Math.round(warn[0] + (danger[0] - warn[0]) * t);
  const g = Math.round(warn[1] + (danger[1] - warn[1]) * t);
  const b = Math.round(warn[2] + (danger[2] - warn[2]) * t);
  const color = `rgb(${r}, ${g}, ${b})`;
  const bg = `rgba(${r}, ${g}, ${b}, ${0.08 + 0.08 * t})`;

  return html`
    <div
      class="context-notice"
      role="status"
      style="--ctx-color:${color};--ctx-bg:${bg}"
    >
      <svg
        class="context-notice__icon"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
      <span>${pct}% context used</span>
      <span class="context-notice__detail">
        ${formatTokensCompact(used)} / ${formatTokensCompact(limit)}
      </span>
    </div>
  `;
}

function formatTokensCompact(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  return String(n);
}
