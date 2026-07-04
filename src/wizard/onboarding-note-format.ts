import { theme } from "../terminal/theme.js";

export function noteHeading(value: string): string {
  return theme.success(value.toUpperCase());
}

export function noteStep(index: number, value: string): string {
  return noteHeading(`${index}. ${value}`);
}

export function noteLabel(value: string): string {
  return theme.success(value);
}

export function noteKey(value: string): string {
  return theme.accentBright(value);
}

export function noteSuccess(value: string): string {
  return theme.success(value);
}

export function noteWarn(value: string): string {
  return theme.warn(value);
}

export function noteMuted(value: string): string {
  return theme.muted(value);
}

export function noteCommand(value: string): string {
  return theme.command(value);
}

export function noteBullet(value: string): string {
  return `- ${value}`;
}

export function noteCommands(commands: string[]): string[] {
  return ["", ...commands.map((command) => noteCommand(command)), ""];
}
