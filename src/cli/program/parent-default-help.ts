import type { Command } from "commander";

const parentDefaultHelpCommands = new WeakSet<Command>();

export function applyParentDefaultHelpAction(parent: Command): void {
  parentDefaultHelpCommands.add(parent);
  parent.action(() => {
    parent.outputHelp();
    process.exitCode = 0;
  });
}

export function isParentDefaultHelpAction(parent: Command): boolean {
  return parentDefaultHelpCommands.has(parent);
}
