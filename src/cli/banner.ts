import { formatFasedDisplayLine } from "../brand.js";
import { visibleWidth } from "../terminal/ansi.js";
import { isRich, theme } from "../terminal/theme.js";
import { hasRootVersionAlias } from "./argv.js";

type BannerOptions = {
  argv?: string[];
  commit?: string | null;
  columns?: number;
  richTty?: boolean;
};

let bannerEmitted = false;

const graphemeSegmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

function splitGraphemes(value: string): string[] {
  if (!graphemeSegmenter) {
    return Array.from(value);
  }
  try {
    return Array.from(graphemeSegmenter.segment(value), (seg) => seg.segment);
  } catch {
    return Array.from(value);
  }
}

const hasJsonFlag = (argv: string[]) =>
  argv.some((arg) => arg === "--json" || arg.startsWith("--json="));

const hasVersionFlag = (argv: string[]) =>
  argv.some((arg) => arg === "--version" || arg === "-V") || hasRootVersionAlias(argv);

export function formatCliBannerLine(version: string, options: BannerOptions = {}): string {
  const rich = options.richTty ?? isRich();
  const title = formatFasedDisplayLine() || version;
  const columns = options.columns ?? process.stdout.columns ?? 120;
  const fitsOnOneLine = visibleWidth(title) <= columns;
  if (rich) {
    return fitsOnOneLine ? theme.heading(title) : theme.heading(title);
  }
  return title;
}

const BANNER_ASCII = [
  "▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄",
  "██░▄▄▄░██░▄▄░██░▄▄▄██░▀██░██░▄▄▀██░████░▄▄▀██░███░██",
  "██░███░██░▀▀░██░▄▄▄██░█░█░██░█████░████░▀▀░██░█░█░██",
  "██░▀▀▀░██░█████░▀▀▀██░██▄░██░▀▀▄██░▀▀░█░██░██▄▀▄▀▄██",
  "▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀",
  "                                                    ",
  " ",
];

export function formatCliBannerArt(options: BannerOptions = {}): string {
  const rich = options.richTty ?? isRich();
  if (!rich) {
    return BANNER_ASCII.join("\n");
  }

  const colorChar = (ch: string) => {
    if (ch === "█") {
      return theme.accentBright(ch);
    }
    if (ch === "░") {
      return theme.accentDim(ch);
    }
    if (ch === "▀") {
      return theme.accent(ch);
    }
    return theme.muted(ch);
  };

  const colored = BANNER_ASCII.map((line) => {
    if (line.includes("FASED")) {
      return theme.muted("                                                    ");
    }
    return splitGraphemes(line).map(colorChar).join("");
  });

  return colored.join("\n");
}

export function emitCliBanner(version: string, options: BannerOptions = {}) {
  if (bannerEmitted) {
    return;
  }
  const argv = options.argv ?? process.argv;
  if (!process.stdout.isTTY) {
    return;
  }
  if (hasJsonFlag(argv)) {
    return;
  }
  if (hasVersionFlag(argv)) {
    return;
  }
  const line = formatCliBannerLine(version, options);
  process.stdout.write(`\n${line}\n\n`);
  bannerEmitted = true;
}

export function hasEmittedCliBanner(): boolean {
  return bannerEmitted;
}
