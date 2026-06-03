import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import { icons } from "../icons.ts";
import { formatPresenceAge } from "../presenter.ts";
import type { PresenceEntry } from "../types.ts";

export type InstancesProps = {
  loading: boolean;
  entries: PresenceEntry[];
  lastError: string | null;
  statusMessage: string | null;
  onRefresh: () => void;
};

let hostsRevealed = false;

export function renderInstances(props: InstancesProps) {
  const masked = !hostsRevealed;
  const summary = summarizeInstances(props.entries);

  return html`
    <style>
      .instances-shell {
        display: grid;
        gap: 16px;
      }
      .instances-card {
        border-radius: 20px;
        border: 1px solid var(--border);
        background: var(--card);
        box-shadow: var(--shadow-md);
        padding: 16px;
      }
      .instances-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
        gap: 14px;
        margin-top: 16px;
      }
      .instances-summary-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(156px, 1fr));
        gap: 10px;
        margin-top: 14px;
      }
      .instances-summary-pill {
        border-radius: 16px;
        border: 1px solid var(--border);
        background: var(--bg-elevated);
        padding: 12px;
      }
      .instances-summary-pill__value {
        color: var(--text-strong);
        font-size: 22px;
        font-weight: 720;
        line-height: 1;
      }
      .instances-summary-pill__label {
        margin-top: 6px;
        color: var(--muted);
        font-size: 12px;
      }
      .instances-entry-card {
        display: grid;
        gap: 12px;
        border-radius: 18px;
        border: 1px solid var(--border);
        background: var(--secondary);
        padding: 14px;
      }
      .instances-entry-card__head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
      }
      .instances-entry-card__title {
        color: var(--text-strong);
        font-size: 17px;
        font-weight: 680;
        line-height: 1.15;
      }
      .instances-entry-card__sub {
        margin-top: 6px;
        color: var(--muted);
        line-height: 1.45;
        word-break: break-word;
      }
      .instances-entry-card__age {
        color: var(--text-strong);
        font-size: 13px;
        font-weight: 560;
        white-space: nowrap;
      }
      .instances-meta-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(132px, 1fr));
        gap: 10px;
      }
      .instances-meta-pill {
        border-radius: 14px;
        border: 1px solid var(--border);
        background: var(--bg-elevated);
        padding: 10px 12px;
        display: grid;
        gap: 4px;
      }
      .instances-meta-pill__label {
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.12em;
        color: var(--muted);
      }
      .instances-meta-pill__value {
        color: var(--text-strong);
        font-weight: 600;
        line-height: 1.35;
        word-break: break-word;
      }
      @media (max-width: 720px) {
        .instances-card {
          padding: 14px;
        }
      }
    </style>

    <section class="instances-shell">
      <section class="card instances-card">
        <div class="row" style="justify-content: space-between; gap: 12px;">
          <div>
            <div class="card-title">${t("instances.title")}</div>
            <div class="card-sub">${t("instances.subtitle")}</div>
          </div>
          <div class="row" style="gap: 8px;">
            <button
              class="btn btn--icon ${masked ? "" : "active"}"
              @click=${() => {
                hostsRevealed = !hostsRevealed;
                props.onRefresh();
              }}
              title=${masked ? t("instances.showHosts") : t("instances.hideHosts")}
              aria-label=${t("instances.toggleHostVisibility")}
              aria-pressed=${!masked}
              style="width: 36px; height: 36px;"
            >
              ${masked ? icons.eyeOff : icons.eye}
            </button>
            <button class="btn" ?disabled=${props.loading} @click=${props.onRefresh}>
              ${props.loading ? t("common.loading") : t("common.refresh")}
            </button>
          </div>
        </div>
        ${
          props.lastError
            ? html`<div class="callout danger" style="margin-top: 12px;">${props.lastError}</div>`
            : nothing
        }
        ${
          props.statusMessage
            ? html`<div class="callout" style="margin-top: 12px;">${props.statusMessage}</div>`
            : nothing
        }
        <div class="instances-summary-grid" aria-label="Runtime client summary">
          <div class="instances-summary-pill">
            <div class="instances-summary-pill__value">${summary.total}</div>
            <div class="instances-summary-pill__label">runtime clients</div>
          </div>
          <div class="instances-summary-pill">
            <div class="instances-summary-pill__value">${summary.active}</div>
            <div class="instances-summary-pill__label">recently active</div>
          </div>
          <div class="instances-summary-pill">
            <div class="instances-summary-pill__value">${summary.roles}</div>
            <div class="instances-summary-pill__label">advertised roles</div>
          </div>
          <div class="instances-summary-pill">
            <div class="instances-summary-pill__value">${summary.scopes}</div>
            <div class="instances-summary-pill__label">advertised scopes</div>
          </div>
        </div>
        <div class="callout info" style="margin-top: 12px;">
          Runtime/client status is read-only here. Host and IP values stay masked unless you reveal
          them for local troubleshooting.
        </div>
        <div class="instances-grid">
          ${
            props.entries.length === 0
              ? html`<div class="muted">${t("instances.noInstances")}</div>`
              : props.entries.map((entry) => renderEntry(entry, masked))
          }
        </div>
      </section>
    </section>
  `;
}

function summarizeInstances(entries: PresenceEntry[]) {
  const roleSet = new Set<string>();
  const scopeSet = new Set<string>();
  let active = 0;
  for (const entry of entries) {
    const age = entry.lastInputSeconds;
    if (typeof age === "number" && Number.isFinite(age) && age <= 300) {
      active++;
    }
    for (const role of entry.roles ?? []) {
      if (role.trim()) {
        roleSet.add(role.trim());
      }
    }
    for (const scope of entry.scopes ?? []) {
      if (scope.trim()) {
        scopeSet.add(scope.trim());
      }
    }
  }
  return {
    total: entries.length,
    active,
    roles: roleSet.size,
    scopes: scopeSet.size,
  };
}

function renderEntry(entry: PresenceEntry, masked: boolean) {
  const lastInput =
    entry.lastInputSeconds != null
      ? t("common.secondsAgo", { count: String(entry.lastInputSeconds) })
      : t("common.na");
  const mode = entry.mode ?? "unknown";
  const host = entry.host ?? "unknown host";
  const ip = entry.ip ?? null;
  const roles = Array.isArray(entry.roles) ? entry.roles.filter(Boolean) : [];
  const scopes = Array.isArray(entry.scopes) ? entry.scopes.filter(Boolean) : [];
  const scopesLabel =
    scopes.length > 0
      ? scopes.length > 3
        ? `${scopes.length} scopes`
        : `scopes: ${scopes.join(", ")}`
      : null;
  return html`
    <div class="instances-entry-card">
      <div class="instances-entry-card__head">
        <div>
          <div class="instances-entry-card__title">
            <span class="${masked ? "redacted" : ""}">${host}</span>
          </div>
          <div class="instances-entry-card__sub">
            ${ip ? html`<span class="${masked ? "redacted" : ""}">${ip}</span> ` : nothing}${mode}
            ${entry.version ?? ""}
          </div>
        </div>
        <div class="instances-entry-card__age">${formatPresenceAge(entry)}</div>
      </div>
      <div class="instances-meta-grid">
        <div class="instances-meta-pill">
          <div class="instances-meta-pill__label">Mode</div>
          <div class="instances-meta-pill__value">${mode}</div>
        </div>
        <div class="instances-meta-pill">
          <div class="instances-meta-pill__label">Last Input</div>
          <div class="instances-meta-pill__value">${lastInput}</div>
        </div>
        <div class="instances-meta-pill">
          <div class="instances-meta-pill__label">Reason</div>
          <div class="instances-meta-pill__value">${entry.reason ?? "n/a"}</div>
        </div>
      </div>
      <div class="chip-row">
        <span class="chip">${mode}</span>
        ${roles.map((role) => html`<span class="chip">${role}</span>`)}
        ${scopesLabel ? html`<span class="chip">${scopesLabel}</span>` : nothing}
        ${entry.platform ? html`<span class="chip">${entry.platform}</span>` : nothing}
        ${entry.deviceFamily ? html`<span class="chip">${entry.deviceFamily}</span>` : nothing}
        ${entry.modelIdentifier ? html`<span class="chip">${entry.modelIdentifier}</span>` : nothing}
        ${entry.version ? html`<span class="chip">${entry.version}</span>` : nothing}
      </div>
    </div>
  `;
}
