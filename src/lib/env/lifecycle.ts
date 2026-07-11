import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import type { ResolvedConfig } from '../config.ts';
import { envPaths, envRoot, type EnvPaths } from './paths.ts';
import { findHook, hookEnv, type HookLookup, type HookName } from './hooks.ts';
import { allocateSlot, readState, withLock, writeState, type EnvState } from './state.ts';

/** Everything lifecycle functions need, precomputed once from ResolvedConfig. */
export interface EnvHandle {
  featureName: string;
  worktreePath: string;
  /** Where hooks run: the worktree, or its appSubdir when configured + present. */
  hookCwd: string;
  gitRoot: string;
  repoConfigPath: string;
  readyPattern?: string;
  paths: EnvPaths;
}

export function createEnvHandle(cfg: ResolvedConfig, featureName: string, worktreePath: string): EnvHandle {
  const hookCwd =
    cfg.appSubdir && existsSync(join(worktreePath, cfg.appSubdir)) ? join(worktreePath, cfg.appSubdir) : worktreePath;
  return {
    featureName,
    worktreePath,
    hookCwd,
    gitRoot: cfg.gitRoot,
    repoConfigPath: cfg.repoConfigPath,
    readyPattern: cfg.environment.readyPattern,
    paths: envPaths(cfg.repoConfigPath, featureName),
  };
}

export function hook(handle: EnvHandle, name: HookName): HookLookup | undefined {
  return findHook(name, handle.worktreePath, handle.repoConfigPath);
}

const ALL_HOOKS: HookName[] = ['env-setup', 'env-start', 'env-stop', 'env-status'];

export function hasEnvHooks(handle: EnvHandle): boolean {
  return ALL_HOOKS.some((name) => hook(handle, name) !== undefined);
}

export function notExecutableWarning(lookup: HookLookup): string {
  return `Hook ${lookup.path} is not executable — run: chmod +x ${lookup.path}`;
}

function buildHookEnv(handle: EnvHandle, slot: number): NodeJS.ProcessEnv {
  return hookEnv({
    worktreePath: handle.worktreePath,
    worktreeName: handle.featureName,
    gitRoot: handle.gitRoot,
    scratchDir: handle.paths.scratchDir,
    slot,
  });
}

/**
 * First touch creates the state file and claims a slot. Slot allocation
 * scans sibling worktrees, so it takes a repo-wide lock (not the per-feature
 * one) to keep two concurrent creates from picking the same slot.
 */
export async function ensureState(handle: EnvHandle): Promise<EnvState> {
  const slotLock = join(envRoot(handle.repoConfigPath), '.slots.lock');
  return withLock(slotLock, () => {
    const existing = readState(handle.paths);
    if (existing) return existing;
    const fresh: EnvState = {
      slot: allocateSlot(handle.repoConfigPath),
      phase: 'setup',
      attachedSessions: [],
    };
    writeState(handle.paths, fresh);
    return fresh;
  });
}

export interface SetupResult {
  ran: boolean;
  ok: boolean;
  warning?: string;
}

const SETUP_TIMEOUT_MS = 10 * 60 * 1000; // installs can be slow; still bounded

/**
 * Run env-setup once, blocking, output appended to env.log. Success is
 * recorded as setupCompletedAt; failure marks phase=failed but the worktree
 * remains usable (a broken env script must not lock the user out).
 */
export async function runSetup(handle: EnvHandle): Promise<SetupResult> {
  const lookup = hook(handle, 'env-setup');
  if (!lookup) return { ran: false, ok: true };
  if (!lookup.executable) return { ran: false, ok: false, warning: notExecutableWarning(lookup) };

  const state = await ensureState(handle);
  if (state.setupCompletedAt) return { ran: false, ok: true };

  mkdirSync(handle.paths.scratchDir, { recursive: true });
  const logFd = openSync(handle.paths.logFile, 'a');
  let result;
  try {
    result = spawnSync(lookup.path, [], {
      cwd: handle.hookCwd,
      env: buildHookEnv(handle, state.slot),
      stdio: ['ignore', logFd, logFd],
      timeout: SETUP_TIMEOUT_MS,
    });
  } finally {
    closeSync(logFd);
  }

  if (result.status === 0) {
    await withLock(handle.paths.lockFile, () => {
      const current = readState(handle.paths) ?? state;
      writeState(handle.paths, { ...current, setupCompletedAt: new Date().toISOString() });
    });
    return { ran: true, ok: true };
  }

  await withLock(handle.paths.lockFile, () => {
    const current = readState(handle.paths) ?? state;
    writeState(handle.paths, { ...current, phase: 'failed' });
  });
  const reason = result.error ? result.error.message : `exit code ${result.status}`;
  return { ran: true, ok: false, warning: `env-setup failed (${reason}) — see ${handle.paths.logFile}` };
}
