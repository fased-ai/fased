export type ControlUiBootStage =
  | "entry-loaded"
  | "app-import-start"
  | "app-imported"
  | "custom-element-defined"
  | "connected"
  | "first-updated"
  | "rendered"
  | "boot-failed";

type ControlUiBootState = {
  stage?: string;
  detail?: string;
  updatedAt?: number;
  mark?: (stage: string, detail?: string) => void;
};

const BOOT_STAGE_RANK: Record<ControlUiBootStage, number> = {
  "entry-loaded": 10,
  "app-import-start": 20,
  "app-imported": 30,
  "custom-element-defined": 40,
  connected: 50,
  "first-updated": 60,
  rendered: 70,
  "boot-failed": 100,
};

declare global {
  interface Window {
    __FASED_CONTROL_UI_BOOT?: ControlUiBootState;
  }
}

export function markControlUiBootStage(stage: ControlUiBootStage, detail?: string) {
  if (typeof window === "undefined") {
    return;
  }
  const state = (window.__FASED_CONTROL_UI_BOOT = window.__FASED_CONTROL_UI_BOOT ?? {});
  const currentRank = BOOT_STAGE_RANK[state.stage as ControlUiBootStage] ?? 0;
  const nextRank = BOOT_STAGE_RANK[stage];
  if (nextRank < currentRank && state.stage !== "boot-failed") {
    return;
  }
  state.stage = stage;
  state.detail = detail ?? "";
  state.updatedAt = Date.now();
  if (typeof state.mark === "function") {
    state.mark(stage, detail);
  }
  if (typeof window.dispatchEvent === "function" && typeof CustomEvent === "function") {
    window.dispatchEvent(
      new CustomEvent("fased-control-ui-boot", {
        detail: {
          stage,
          detail: detail ?? "",
        },
      }),
    );
  }
}
