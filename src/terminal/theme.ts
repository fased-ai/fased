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
  success: baseChalk.green,
  warn: baseChalk.yellow,
  error: hex(FASED_PALETTE.error),
  muted: hex(FASED_PALETTE.muted),
  noteChrome: baseChalk.gray,
  noteTitle: baseChalk.bold.gray,
  noteHeading: baseChalk.bold.yellow,
  heading: baseChalk.bold,
  command: baseChalk.green,
  option: baseChalk.yellow,
} as const;

export const isRich = () => Boolean(baseChalk.level > 0);

export const colorize = (rich: boolean, color: (value: string) => string, value: string) =>
  rich ? color(value) : value;
