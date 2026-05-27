/**
 * Names that must not be used as feature names / worktree directories.
 *
 * Most of these are ccw subcommands that the CLI would otherwise treat as
 * a positional feature name (e.g. `ccw help` could create a "help" worktree).
 * Keep this list in sync with the subcommands declared in src/index.ts.
 */
export const RESERVED_NAMES = [
  'init',
  'ls',
  'list',
  'rm',
  'remove',
  'config',
  'update',
  'help',
  'version',
  // Common flags mistaken for commands
  '--help',
  '-h',
  '--version',
  '-v',
  '-V',
] as const;

const reservedSet = new Set<string>(RESERVED_NAMES);

export function isReservedName(name: string): boolean {
  return reservedSet.has(name.toLowerCase());
}
