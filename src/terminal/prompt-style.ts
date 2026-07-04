import { isRich, theme } from "./theme.js";

const WIZARD_ASCII = [
  "  _____   _     ____   _____  ____",
  " |  ___| / \\   / ___| | ____||  _ \\",
  " | |_   / _ \\  \\___ \\ |  _|  | | | |",
  " |  _| / ___ \\  ___) || |___ | |_| |",
  " |_|  /_/   \\_\\|____/ |_____||____/",
].join("\n");

const DISPLAY_MESSAGE_OVERRIDES = new Map<string, string>([
  ["Wallet setup action", "Wallet setup"],
  ["Set up model providers?", "Model providers"],
  ["Set up chat channels?", "Chat channels"],
  ["Set up skills?", "Skills"],
  ["Set up hooks?", "Hooks"],
]);

function displayPromptMessage(message: string): string {
  const trimmed = message.trim();
  return DISPLAY_MESSAGE_OVERRIDES.get(trimmed) ?? message;
}

function normalizeSectionTitle(value: string): string {
  return value.trim().toUpperCase();
}

function sectionHeading(value: string): string {
  const text = normalizeSectionTitle(value);
  return isRich() ? theme.noteTitle(text) : text;
}

export function formatWizardIntro(title: string): string {
  const heading = sectionHeading(title);
  if (process.env.FASED_INSTALLER_ONBOARD === "1") {
    return heading;
  }
  const ascii = isRich() ? theme.noteChrome(WIZARD_ASCII) : WIZARD_ASCII;
  return `${ascii}\n\n${heading}`;
}

export const stylePromptMessage = (message: string): string =>
  sectionHeading(displayPromptMessage(message));

export const stylePromptTitle = (title?: string): string | undefined =>
  title ? sectionHeading(title) : title;

export const styleProgressTitle = (title: string): string => sectionHeading(title);

export const stylePromptHint = (hint?: string): string | undefined =>
  hint && isRich() ? theme.muted(hint) : hint;
