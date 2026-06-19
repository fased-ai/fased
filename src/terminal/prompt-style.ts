import { isRich, theme } from "./theme.js";

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

export const stylePromptMessage = (message: string): string =>
  isRich() ? theme.heading(displayPromptMessage(message)) : displayPromptMessage(message);

export const stylePromptTitle = (title?: string): string | undefined =>
  title && isRich() ? theme.heading(title) : title;

export const stylePromptHint = (hint?: string): string | undefined =>
  hint && isRich() ? theme.muted(hint) : hint;
