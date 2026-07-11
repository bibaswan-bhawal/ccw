import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, type ResolvedConfig } from '../lib/config.ts';
import { createWorktree, fetchBranch, refExists } from '../lib/git.ts';
import { generateSessionId, getSessionId, saveSessionId, setTask } from '../lib/sessions.ts';
import {
  buildContextOnlySystemPrompt,
  buildEnvironmentSystemPrompt,
  buildPlanningSystemPrompt,
  combineSystemPrompts,
  launchClaude,
} from '../lib/claude.ts';
import {
  attachSession,
  createEnvHandle,
  detachSession,
  runSetup,
  startEnvironment,
  hook as envHook,
  type EnvHandle,
} from '../lib/env/lifecycle.ts';
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
  const promptSections: Array<string | undefined> = [];
  let initialPrompt: string | undefined;

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
      promptSections.push(buildPlanningSystemPrompt(task));
      initialPrompt = 'Analyze the task in your context and present an implementation plan.';
    } else {
      ui.warn('Continuing without task context.');
    }
  }

  const env = createEnvHandle(cfg, featureName, worktreePath);
  const envRunning = await prepareEnvironment(env, sessionId, promptSections);

  const prompt = combineSystemPrompts(promptSections);
  if (prompt) claudeArgs.push('--append-system-prompt', prompt);
  // Positional initial prompt must be argv-last, after every flag.
  if (initialPrompt) claudeArgs.push(initialPrompt);

  ui.info(`Starting Claude Code in ${ui.cyan(targetDir)}`);
  ui.blank();
  const exitCode = await launchClaude(claudeArgs, targetDir);
  if (envRunning) await tryDetach(env, sessionId);
  process.exit(exitCode);
}

/**
 * detachSession failures must never clobber Claude's exit code — Claude
 * already ran to completion, so a bookkeeping error here is a warning, not
 * a reason to report failure (or crash) on the way out.
 */
async function tryDetach(env: EnvHandle, sessionId: string): Promise<void> {
  try {
    await detachSession(env, sessionId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ui.warn(`Environment detach failed (${message}) — it may still be running; use ccw env stop.`);
  }
}

/**
 * Environment bring-up for both create and resume. Setup blocks (with
 * spinner); start is fire-and-forget. Returns true when this session
 * attached to a started/running environment (caller must detach after
 * Claude exits).
 */
async function prepareEnvironment(
  env: EnvHandle,
  sessionId: string,
  promptSections: Array<string | undefined>,
): Promise<boolean> {
  if (!envHook(env, 'env-start') && !envHook(env, 'env-setup')) return false;

  const setup = await withSpinner('Setting up environment...', async () => runSetup(env), {
    successMessage: (r) => (r.ran ? 'Environment setup complete' : 'Environment setup already done'),
  });
  if (setup.warning) ui.warn(setup.warning);
  if (!setup.ok) {
    ui.warn('Continuing without environment.');
    return false;
  }

  if (!envHook(env, 'env-start')) return false;
  const start = await startEnvironment(env);
  if (start.warning) ui.warn(start.warning);
  if (!start.started && !start.alreadyRunning) return false;

  await attachSession(env, sessionId);
  ui.info(`Environment ${start.alreadyRunning ? 'already running' : 'starting in background'} (${ui.bold('ccw env status')})`);
  promptSections.push(buildEnvironmentSystemPrompt(env.paths.logFile));
  return true;
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

  const env = createEnvHandle(cfg, featureName, worktreePath);
  const existingSessionId = getSessionId(cfg.sessionsFile, featureName);

  if (existingSessionId) {
    const envRunning = await prepareEnvironment(env, existingSessionId, []);
    ui.success(`Resuming Claude Code session ${ui.dim(existingSessionId)}`);
    ui.blank();
    const exitCode = await launchClaude(['--resume', existingSessionId, '--name', featureName], targetDir);
    if (envRunning) await tryDetach(env, existingSessionId);
    process.exit(exitCode);
  }

  ui.warn('No saved session found. Starting fresh Claude Code session...');
  const sessionId = generateSessionId();
  saveSessionId(cfg.sessionsFile, featureName, sessionId);

  const claudeArgs = ['--session-id', sessionId, '--name', featureName];
  const promptSections: Array<string | undefined> = [];
  const detected = host.detectTask(featureName);
  if (detected) {
    const { task } = await tryFetchTask(host, detected.plugin, detected.key);
    if (task) {
      setTask(cfg.sessionsFile, featureName, {
        id: task.id,
        provider: detected.plugin.plugin.name,
      });
      promptSections.push(buildContextOnlySystemPrompt(task));
    }
  }

  const envRunning = await prepareEnvironment(env, sessionId, promptSections);
  const prompt = combineSystemPrompts(promptSections);
  if (prompt) claudeArgs.push('--append-system-prompt', prompt);

  ui.blank();
  const exitCode = await launchClaude(claudeArgs, targetDir);
  if (envRunning) await tryDetach(env, sessionId);
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
