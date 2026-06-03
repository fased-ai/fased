export type DashboardWidgetId = "agents" | "usage" | "wallet" | "mining" | "network";

export type DashboardColumnWidth = "narrow" | "normal" | "wide";

export type DashboardColumn = {
  id: string;
  title: string;
  width: DashboardColumnWidth;
  widgets: DashboardWidgetId[];
};

export type DashboardLayout = {
  version: 1;
  columns: DashboardColumn[];
};

const STORAGE_KEY = "fased.control.dashboard.layout.v1";
const DASHBOARD_COLUMN_ID = "dashboard";

export const DEFAULT_DASHBOARD_LAYOUT: DashboardLayout = {
  version: 1,
  columns: [
    {
      id: DASHBOARD_COLUMN_ID,
      title: "Dashboard",
      width: "wide",
      widgets: ["agents", "usage", "wallet", "mining", "network"],
    },
  ],
};

const VALID_WIDGETS = new Set<DashboardWidgetId>(
  DEFAULT_DASHBOARD_LAYOUT.columns.flatMap((column) => column.widgets),
);

function cloneLayout(layout: DashboardLayout): DashboardLayout {
  return {
    version: 1,
    columns: layout.columns.map((column) => ({
      ...column,
      widgets: [...column.widgets],
    })),
  };
}

export function normalizeDashboardLayout(value: unknown): DashboardLayout {
  const candidate = value as Partial<DashboardLayout> | null;
  if (!candidate || candidate.version !== 1 || !Array.isArray(candidate.columns)) {
    return cloneLayout(DEFAULT_DASHBOARD_LAYOUT);
  }

  const seen = new Set<DashboardWidgetId>();
  const widgets = candidate.columns
    .flatMap((column) => {
      if (!column || typeof column !== "object") {
        return [];
      }
      const raw = column as Partial<DashboardColumn>;
      const rawWidgets = Array.isArray(raw.widgets) ? (raw.widgets as unknown[]) : [];
      return rawWidgets.length
        ? rawWidgets
            .map((widget) => (widget === "quick-actions" ? "agents" : widget))
            .filter((widget): widget is DashboardWidgetId => {
              if (typeof widget !== "string") {
                return false;
              }
              const normalized = widget as DashboardWidgetId;
              if (!VALID_WIDGETS.has(normalized)) {
                return false;
              }
              if (seen.has(normalized)) {
                return false;
              }
              seen.add(normalized);
              return true;
            })
        : [];
    })
    .filter((widget): widget is DashboardWidgetId => VALID_WIDGETS.has(widget));

  if (seen.size === 0) {
    return cloneLayout(DEFAULT_DASHBOARD_LAYOUT);
  }

  return {
    version: 1,
    columns: [
      {
        id: DASHBOARD_COLUMN_ID,
        title: "Dashboard",
        width: "wide",
        widgets,
      },
    ],
  };
}

export function loadDashboardLayout(): DashboardLayout {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    return raw ? normalizeDashboardLayout(JSON.parse(raw)) : cloneLayout(DEFAULT_DASHBOARD_LAYOUT);
  } catch {
    return cloneLayout(DEFAULT_DASHBOARD_LAYOUT);
  }
}

export function saveDashboardLayout(layout: DashboardLayout): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(normalizeDashboardLayout(layout)));
  } catch {
    // Local storage can be unavailable in private contexts; keep the in-memory layout.
  }
}

export function dashboardWidgetIds(layout: DashboardLayout): DashboardWidgetId[] {
  return layout.columns.flatMap((column) => column.widgets);
}

export function resetDashboardLayout(): DashboardLayout {
  return cloneLayout(DEFAULT_DASHBOARD_LAYOUT);
}

export function addDashboardWidget(
  layout: DashboardLayout,
  widgetId: DashboardWidgetId,
  _columnId?: string,
): DashboardLayout {
  if (!VALID_WIDGETS.has(widgetId) || dashboardWidgetIds(layout).includes(widgetId)) {
    return normalizeDashboardLayout(layout);
  }
  const next = cloneLayout(layout);
  const target = next.columns[0];
  if (!target) {
    return normalizeDashboardLayout(DEFAULT_DASHBOARD_LAYOUT);
  }
  target.widgets.push(widgetId);
  return normalizeDashboardLayout(next);
}

export function removeDashboardWidget(
  layout: DashboardLayout,
  widgetId: DashboardWidgetId,
): DashboardLayout {
  const next = cloneLayout(layout);
  for (const column of next.columns) {
    column.widgets = column.widgets.filter((widget) => widget !== widgetId);
  }
  return normalizeDashboardLayout(next);
}

export function moveDashboardWidget(
  layout: DashboardLayout,
  widgetId: DashboardWidgetId,
  _targetColumnId: string,
  beforeWidgetId?: DashboardWidgetId,
): DashboardLayout {
  const widgets = dashboardWidgetIds(normalizeDashboardLayout(layout));
  if (!widgets.includes(widgetId)) {
    return normalizeDashboardLayout(layout);
  }
  const remaining = widgets.filter((widget) => widget !== widgetId);
  const targetIndex = beforeWidgetId ? remaining.indexOf(beforeWidgetId) : -1;
  if (targetIndex >= 0) {
    remaining.splice(targetIndex, 0, widgetId);
  } else {
    remaining.push(widgetId);
  }
  return normalizeDashboardLayout({
    version: 1,
    columns: [{ id: DASHBOARD_COLUMN_ID, title: "Dashboard", width: "wide", widgets: remaining }],
  });
}
