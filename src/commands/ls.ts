import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { loadConfig, type ResolvedConfig } from '../lib/config.ts';
import { listWorktrees, type WorktreeEntry } from '../lib/git.ts';
import { getSession } from '../lib/sessions.ts';
import { launchClaude } from '../lib/claude.ts';
import { createPluginHost, type PluginHost } from '../lib/plugin-host.ts';
import { pick, pickerFooter, type PickerItem } from '../lib/picker.tsx';
import { ui } from '../lib/ui.ts';

interface Row {
  label: string;
  value: string;
}

function renderRows(rows: Row[]): string[] {
  const maxLabel = Math.max(...rows.map((r) => r.label.length));
  return rows.map(({ label, value }) => {
    const padded = label.padEnd(maxLabel);
    return `${ui.dim(`${padded}  `)}${value}`;
  });
}

function renderWorktree(
  cfg: ResolvedConfig,
  host: PluginHost,
  entry: WorktreeEntry,
): { heading: string; rows: string[] } {
  const name = basename(entry.path);
  const session = getSession(cfg.sessionsFile, name);

  const rows: Row[] = [
    { label: 'branch', value: `${ui.cyan(entry.branch)} ${ui.dim(`(${entry.sha})`)}` },
    {
      label: 'session',
      value: session?.sessionId ? ui.dim(session.sessionId) : ui.yellow('no session'),
    },
  ];
  if (session?.taskId && session.taskProvider) {
    const badge = host.badgeForStoredTask(session.taskId, session.taskProvider);
    if (badge) {
      rows.push({ label: 'task', value: ui.link(ui.cyan(badge.label), badge.url) });
    }
  }

  return { heading: ui.bold(name), rows: renderRows(rows) };
}

function getCcwWorktrees(cfg: ResolvedConfig): WorktreeEntry[] {
  if (!existsSync(cfg.worktreeDir)) return [];
  return listWorktrees(cfg.gitRoot).filter((e) => e.path.startsWith(cfg.worktreeDir));
}

function printWorktrees(cfg: ResolvedConfig, host: PluginHost, entries: WorktreeEntry[]): void {
  ui.heading(`Active worktrees for ${cfg.repoName}`);

  if (entries.length === 0) {
    ui.hint('  (none)');
    return;
  }

  for (const entry of entries) {
    const { heading, rows } = renderWorktree(cfg, host, entry);
    console.log(`  ${heading}`);
    for (const row of rows) {
      console.log(`    ${row}`);
    }
  }

  ui.hint(`${entries.length} worktree(s)`);
}

/**
 * Interactive picker: arrow keys to move, Enter to resume Claude in the
 * selected worktree. Ctrl+C / Esc cancels.
 */
async function pickAndLaunch(cfg: ResolvedConfig, host: PluginHost, entries: WorktreeEntry[]): Promise<void> {
  if (entries.length === 0) {
    ui.info(`No worktrees yet for ${ui.bold(cfg.repoName)}.`);
    ui.hint("Run 'ccw <feature-name>' to create one.");
    return;
  }

  const items: PickerItem<string>[] = entries.map((entry) => {
    const { heading, rows } = renderWorktree(cfg, host, entry);
    // Indent row lines so they align under the heading text (after the 2-char
    // prefix the picker prepends).
    const indentedRows = rows.map((r) => `  ${r}`);
    return {
      value: basename(entry.path),
      lines: [heading, ...indentedRows],
      selectedLines: [ui.bold(ui.cyan(basename(entry.path))), ...indentedRows],
    };
  });

  const selected = await pick({
    items,
    header: `Active worktrees for ${cfg.repoName}`,
    footer: pickerFooter(items.length, '↑/↓ to move · Enter to resume'),
    fullscreen: true,
  });

  if (!selected) {
    ui.hint('Cancelled.');
    return;
  }

  const worktreePath = join(cfg.worktreeDir, selected);
  const targetDir =
    cfg.appSubdir && existsSync(join(worktreePath, cfg.appSubdir)) ? join(worktreePath, cfg.appSubdir) : worktreePath;

  const sessionId = getSession(cfg.sessionsFile, selected)?.sessionId;
  if (sessionId) {
    ui.success(`Resuming Claude Code session ${ui.dim(sessionId)}`);
    ui.blank();
    const exitCode = await launchClaude(['--resume', sessionId], targetDir);
    process.exit(exitCode);
  }

  ui.warn('No saved session for this worktree; starting Claude Code without resume.');
  ui.blank();
  const exitCode = await launchClaude([], targetDir);
  process.exit(exitCode);
}

export interface LsOptions {
  pipe?: boolean;
}

export async function runLs(opts: LsOptions = {}): Promise<void> {
  const cfg = loadConfig();
  const host = createPluginHost(cfg);
  const entries = getCcwWorktrees(cfg);

  const interactive = !opts.pipe && process.stdout.isTTY;

  if (interactive) {
    await pickAndLaunch(cfg, host, entries);
    return;
  }

  printWorktrees(cfg, host, entries);
}

/**
 * Exposed for the default `ccw` (no args) command.
 */
export async function runPicker(): Promise<void> {
  const cfg = loadConfig();
  const host = createPluginHost(cfg);
  const entries = getCcwWorktrees(cfg);

  if (!process.stdout.isTTY) {
    printWorktrees(cfg, host, entries);
    return;
  }

  await pickAndLaunch(cfg, host, entries);
}
