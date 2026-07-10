import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, type ResolvedConfig } from '../lib/config.ts';
import { createWorktree, fetchBranch, refExists } from '../lib/git.ts';
import { generateSessionId, getSessionId, saveSessionId, setTask } from '../lib/sessions.ts';
import { buildContextOnlySystemPrompt, buildPlanningSystemPrompt, launchClaude } from '../lib/claude.ts';
import { createPluginHost, type ActivePlugin, type PluginHost } from '../lib/plugin-host.ts';
import type { Task } from '../lib/plugin.ts';
import { withSpinner } from '../lib/spinner.tsx';
import { ui } from '../lib/ui.ts';

export async function runCreate(featureName: string): Promise<void> {
  const cfg = loadConfig();
  const host = createPluginHost(cfg);
  const worktreePath = join(cfg.worktreeDir, featureName);
  const branchName = featureName;

  if (existsSync(worktreePath)) {
    await resumeWorktree(cfg, host, featureName, worktreePath);
    return;
  }

  mkdirSync(cfg.worktreeDir, { recursive: true });

  await withSpinner(`Fetching ${cfg.baseBranch} from origin...`, async () => {
    await fetchBranch(cfg.gitRoot, cfg.baseBranch);
  });

  const remoteRef = `origin/${cfg.baseBranch}`;
  const baseRef = refExists(cfg.gitRoot, remoteRef) ? remoteRef : cfg.baseBranch;

  await withSpinner(
    `Creating worktree ${ui.bold(featureName)}...`,
    async () => createWorktree(cfg.gitRoot, worktreePath, branchName, baseRef),
    { successMessage: `Worktree created at ${ui.cyan(worktreePath)}` },
  );

  const targetDir =
    cfg.appSubdir && existsSync(join(worktreePath, cfg.appSubdir)) ? join(worktreePath, cfg.appSubdir) : worktreePath;

  const sessionId = generateSessionId();
  saveSessionId(cfg.sessionsFile, featureName, sessionId);
  ui.step(`Session ${ui.dim(sessionId)} saved for ${featureName}`);

  const claudeArgs = ['--session-id', sessionId, '--name', featureName];

  const detected = host.detectTask(featureName);
  if (detected) {
    ui.info(`Detected ${detected.plugin.plugin.name} task: ${ui.bold(detected.key)}`);
    const { task, warning } = await withSpinner(
      `Fetching ${detected.plugin.plugin.name} task ${detected.key}...`,
      async () => tryFetchTask(host, detected.plugin, detected.key),
      {
        successMessage: (result) =>
          result.task ? `Task context loaded for ${detected.key}` : `Task context unavailable`,
      },
    );
    if (warning) ui.warn(warning);
    if (task) {
      setTask(cfg.sessionsFile, featureName, {
        id: task.id,
        provider: detected.plugin.plugin.name,
      });
      claudeArgs.push('--append-system-prompt', buildPlanningSystemPrompt(task));
      claudeArgs.push('Analyze the task in your context and present an implementation plan.');
    } else {
      ui.warn('Continuing without task context.');
    }
  }

  ui.info(`Starting Claude Code in ${ui.cyan(targetDir)}`);
  ui.blank();
  const exitCode = await launchClaude(claudeArgs, targetDir);
  process.exit(exitCode);
}

async function resumeWorktree(
  cfg: ResolvedConfig,
  host: PluginHost,
  featureName: string,
  worktreePath: string,
): Promise<void> {
  ui.info(`Worktree already exists at ${ui.cyan(worktreePath)}`);
  const targetDir =
    cfg.appSubdir && existsSync(join(worktreePath, cfg.appSubdir)) ? join(worktreePath, cfg.appSubdir) : worktreePath;

  const existingSessionId = getSessionId(cfg.sessionsFile, featureName);

  if (existingSessionId) {
    ui.success(`Resuming Claude Code session ${ui.dim(existingSessionId)}`);
    ui.blank();
    const exitCode = await launchClaude(['--resume', existingSessionId, '--name', featureName], targetDir);
    process.exit(exitCode);
  }

  ui.warn('No saved session found. Starting fresh Claude Code session...');
  const sessionId = generateSessionId();
  saveSessionId(cfg.sessionsFile, featureName, sessionId);

  const claudeArgs = ['--session-id', sessionId, '--name', featureName];
  const detected = host.detectTask(featureName);
  if (detected) {
    const { task } = await tryFetchTask(host, detected.plugin, detected.key);
    if (task) {
      setTask(cfg.sessionsFile, featureName, {
        id: task.id,
        provider: detected.plugin.plugin.name,
      });
      claudeArgs.push('--append-system-prompt', buildContextOnlySystemPrompt(task));
    }
  }

  ui.blank();
  const exitCode = await launchClaude(claudeArgs, targetDir);
  process.exit(exitCode);
}

interface FetchResult {
  task: Task | undefined;
  warning?: string;
}

async function tryFetchTask(host: PluginHost, active: ActivePlugin, key: string): Promise<FetchResult> {
  try {
    const task = await host.fetchTask(active, key);
    return { task };
  } catch (err) {
    const message = err instanceof Error ? err.message : `Could not fetch task ${key}`;
    return { task: undefined, warning: message };
  }
}
