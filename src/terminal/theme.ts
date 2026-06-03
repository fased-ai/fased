import chalk, { Chalk } from "chalk";
import { FASED_PALETTE } from "./palette.js";

const hasForceColor =
  typeof process.env.FORCE_COLOR === "string" &&
  process.env.FORCE_COLOR.trim().length > 0 &&
  process.env.FORCE_COLOR.trim() !== "0";

const baseChalk = process.env.NO_COLOR && !hasForceColor ? new Chalk({ level: 0 }) : chalk;

const hex = (value: string) => baseChalk.hex(value);

export const theme = {
  accent: hex(FASED_PALETTE.accent),
  accentBright: hex(FASED_PALETTE.accentBright),
  accentDim: hex(FASED_PALETTE.accentDim),
  info: hex(FASED_PALETTE.info),
  success: hex(FASED_PALETTE.success),
  warn: hex(FASED_PALETTE.warn),
  error: hex(FASED_PALETTE.error),
  muted: hex(FASED_PALETTE.muted),
  heading: baseChalk.bold.hex(FASED_PALETTE.accent),
  command: hex(FASED_PALETTE.accentBright),
  option: hex(FASED_PALETTE.warn),
} as const;

export const isRich = () => Boolean(baseChalk.level > 0);

export const colorize = (rich: boolean, color: (value: string) => string, value: string) =>
  rich ? color(value) : value;
