import { getLogger, isFileLogLevelEnabled } from "./logging/logger.js";
import { theme } from "./terminal/theme.js";

let globalVerbose = false;
let globalYes = false;

export function setVerbose(v: boolean) {
  globalVerbose = v;
}

export function isVerbose() {
  return globalVerbose;
}

export function shouldLogVerbose() {
  return globalVerbose || isFileLogLevelEnabled("debug");
}

export function logVerbose(message: string) {
  if (!shouldLogVerbose()) {
    return;
  }
  try {
    getLogger().debug({ message }, "verbose");
  } catch {
    // ignore logger failures to avoid breaking verbose printing
  }
  if (!globalVerbose) {
    return;
  }
  console.log(theme.muted(message));
}

export function logVerboseConsole(message: string) {
  if (!globalVerbose) {
    return;
  }
  console.log(theme.muted(message));
}

export function setYes(v: boolean) {
  globalYes = v;
}

export function isYes() {
  return globalYes;
}

export function success(value: string) {
  return theme.success(value);
}

export function warn(value: string) {
  return theme.warn(value);
}

export function info(value: string) {
  return theme.info(value);
}

export function danger(value: string) {
  return theme.error(value);
}
