import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { loadConfig, type ResolvedConfig } from '../lib/config.ts';
import { branchExists, deleteBranch, listWorktrees, removeWorktree, type WorktreeEntry } from '../lib/git.ts';
import { getSession, removeSessionId } from '../lib/sessions.ts';
import { createPluginHost, type PluginHost } from '../lib/plugin-host.ts';
import { confirm } from '../lib/prompt.tsx';
import { pickMany, pickerFooter, type PickerItem } from '../lib/picker.tsx';
import { withSpinner } from '../lib/spinner.tsx';
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

async function removeOne(cfg: ResolvedConfig, featureName: string): Promise<void> {
  const worktreePath = join(cfg.worktreeDir, featureName);

  if (!existsSync(worktreePath)) {
    ui.error(`Worktree not found: ${worktreePath}`);
    ui.hint("Run 'ccw ls' to see active worktrees.");
    process.exit(1);
  }

  await withSpinner(
    `Removing ${ui.bold(featureName)}...`,
    async () => {
      await removeWorktree(cfg.gitRoot, worktreePath);
      removeSessionId(cfg.sessionsFile, featureName);
      if (branchExists(cfg.gitRoot, featureName)) {
        await deleteBranch(cfg.gitRoot, featureName);
      }
    },
    { successMessage: `Removed ${ui.bold(featureName)}` },
  );
}

async function pickAndRemove(cfg: ResolvedConfig, host: PluginHost, entries: WorktreeEntry[]): Promise<void> {
  if (entries.length === 0) {
    ui.info(`No worktrees to remove for ${ui.bold(cfg.repoName)}.`);
    return;
  }

  const items: PickerItem<string>[] = entries.map((entry) => {
    const { heading, rows } = renderWorktree(cfg, host, entry);
    const indentedRows = rows.map((r) => `  ${r}`);
    return {
      value: basename(entry.path),
      lines: [heading, ...indentedRows],
      selectedLines: [ui.bold(ui.cyan(basename(entry.path))), ...indentedRows],
    };
  });

  const selected = await pickMany({
    items,
    header: `Select worktrees to remove from ${cfg.repoName}`,
    footer: pickerFooter(items.length, '↑/↓ to move · Space to toggle · a to toggle all · Enter to remove'),
    fullscreen: true,
  });

  if (selected === undefined) {
    ui.hint('Cancelled.');
    return;
  }
  if (selected.length === 0) {
    ui.hint('Nothing selected.');
    return;
  }

  ui.blank();
  ui.warn(`About to remove ${selected.length} worktree(s):`);
  for (const name of selected) {
    console.log(`  ${ui.bold(name)}`);
  }
  ui.blank();
  const ok = await confirm('Proceed?', false);
  if (!ok) {
    ui.hint('Aborted.');
    return;
  }

  ui.blank();
  for (const name of selected) {
    const path = join(cfg.worktreeDir, name);
    try {
      await withSpinner(
        `Removing ${ui.bold(name)}...`,
        async () => {
          await removeWorktree(cfg.gitRoot, path);
          removeSessionId(cfg.sessionsFile, name);
          // Branches are typically already deleted (merged PRs). If one
          // still exists locally, drop it now — the worktree's gone, so
          // it's just dangling state.
          if (branchExists(cfg.gitRoot, name)) {
            await deleteBranch(cfg.gitRoot, name);
          }
        },
        { successMessage: `Removed ${ui.bold(name)}` },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ui.error(`Failed to remove ${name}: ${message}`);
    }
  }
}

export async function runRm(featureName: string | undefined): Promise<void> {
  const cfg = loadConfig();

  if (featureName) {
    await removeOne(cfg, featureName);
    return;
  }

  if (!process.stdout.isTTY) {
    ui.error('ccw rm requires a feature name when stdout is not a TTY.');
    ui.hint('Usage: ccw rm <feature-name>');
    process.exit(1);
  }

  const host = createPluginHost(cfg);
  const entries = getCcwWorktrees(cfg);
  await pickAndRemove(cfg, host, entries);
}
