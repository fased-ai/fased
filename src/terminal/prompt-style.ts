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

function sectionHeading(value: string, marker: string): string {
  const text = `${marker} ${value}`;
  return isRich() ? theme.heading(text) : text;
}

export function formatWizardIntro(title: string): string {
  const ascii = isRich() ? theme.accentBright(WIZARD_ASCII) : WIZARD_ASCII;
  return `${ascii}\n\n${sectionHeading(title, "◆")}`;
}

export const stylePromptMessage = (message: string): string =>
  sectionHeading(displayPromptMessage(message), "◆");

export const stylePromptTitle = (title?: string): string | undefined =>
  title ? sectionHeading(title, "▰") : title;

export const styleProgressTitle = (title: string): string => sectionHeading(title, "●");

export const stylePromptHint = (hint?: string): string | undefined =>
  hint && isRich() ? theme.muted(hint) : hint;
