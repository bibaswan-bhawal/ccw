import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ResolvedConfig } from '../config.ts';
import { envPaths, envRoot, type EnvPaths } from './paths.ts';
import { findHook, hookEnv, type HookLookup, type HookName } from './hooks.ts';
import { allocateSlot, isPidAlive, pruneAttachments, readState, withLock, writeState, type EnvState, type EnvPhase } from './state.ts';

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

export interface StartResult {
  started: boolean;
  alreadyRunning: boolean;
  warning?: string;
}

/**
 * Spawn env-start detached in its own process group, output to env.log.
 * ccw does NOT wait or watch — readiness is computed lazily by getStatus.
 * The child must not hold our stdio: Claude owns the terminal next.
 */
export async function startEnvironment(handle: EnvHandle): Promise<StartResult> {
  const lookup = hook(handle, 'env-start');
  if (!lookup) return { started: false, alreadyRunning: false };
  if (!lookup.executable) return { started: false, alreadyRunning: false, warning: notExecutableWarning(lookup) };

  const state = await ensureState(handle);
  if (state.pid && isPidAlive(state.pid)) return { started: false, alreadyRunning: true };

  mkdirSync(handle.paths.scratchDir, { recursive: true });
  const logFd = openSync(handle.paths.logFile, 'a');
  let child;
  try {
    child = spawn(lookup.path, [], {
      cwd: handle.hookCwd,
      env: buildHookEnv(handle, state.slot),
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });
  } finally {
    closeSync(logFd);
  }
  child.unref();

  const pid = child.pid;
  if (!pid) {
    return { started: false, alreadyRunning: false, warning: `env-start failed to spawn — see ${handle.paths.logFile}` };
  }

  await withLock(handle.paths.lockFile, () => {
    const current = readState(handle.paths) ?? state;
    writeState(handle.paths, { ...current, phase: 'starting', pid, startedAt: new Date().toISOString() });
  });
  return { started: true, alreadyRunning: false };
}

const STOP_HOOK_TIMEOUT_MS = 30_000;
const KILL_GRACE_MS = 5_000;

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function killProcessGroup(pid: number): Promise<void> {
  const signal = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig); // whole group
    } catch {
      try {
        process.kill(pid, sig); // group already gone; try the leader
      } catch {
        /* already dead */
      }
    }
  };
  signal('SIGTERM');
  const deadline = Date.now() + KILL_GRACE_MS;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return;
    await sleepMs(100);
  }
  signal('SIGKILL');
}

/**
 * Teardown: env-stop hook first (bounded — teardown must never hang the
 * terminal), then reap whatever's left of the process group. Safe to call
 * when nothing is running.
 */
export async function stopEnvironment(handle: EnvHandle): Promise<void> {
  const state = readState(handle.paths);
  if (!state) return;

  const lookup = hook(handle, 'env-stop');
  if (lookup?.executable) {
    mkdirSync(handle.paths.scratchDir, { recursive: true });
    const logFd = openSync(handle.paths.logFile, 'a');
    try {
      spawnSync(lookup.path, [], {
        cwd: handle.hookCwd,
        env: buildHookEnv(handle, state.slot),
        stdio: ['ignore', logFd, logFd],
        timeout: STOP_HOOK_TIMEOUT_MS,
      });
    } finally {
      closeSync(logFd);
    }
  }

  if (state.pid && isPidAlive(state.pid)) {
    await killProcessGroup(state.pid);
  }

  await withLock(handle.paths.lockFile, () => {
    const current = readState(handle.paths);
    if (!current) return;
    const { pid: _pid, ...rest } = current;
    writeState(handle.paths, { ...rest, phase: 'stopped' });
  });
}

/** `ccw rm`: teardown, then delete the env dir — which frees the slot. */
export async function removeEnvironment(handle: EnvHandle): Promise<void> {
  await stopEnvironment(handle);
  rmSync(handle.paths.root, { recursive: true, force: true });
}

const STATUS_HOOK_TIMEOUT_MS = 10_000;

export interface EnvStatus {
  exists: boolean;
  phase: EnvPhase;
  alive: boolean;
  ready?: boolean;
  /** Parsed env-status hook JSON, verbatim. */
  hookStatus?: unknown;
  warnings: string[];
  logFile: string;
  slot?: number;
  attachedSessions: number;
}

interface ReconcileResult {
  state: EnvState | undefined;
  prunedToEmpty: boolean;
}

/** Prune dead attachers inside the lock; caller handles teardown outside it. */
async function reconcile(handle: EnvHandle): Promise<ReconcileResult> {
  return withLock(handle.paths.lockFile, () => {
    const state = readState(handle.paths);
    if (!state) return { state: undefined, prunedToEmpty: false };
    const pruned = pruneAttachments(state);
    if (pruned.changed) writeState(handle.paths, pruned.state);
    return { state: pruned.state, prunedToEmpty: pruned.prunedToEmpty };
  });
}

function runStatusHook(handle: EnvHandle, slot: number): { json?: unknown; warning?: string } {
  const lookup = hook(handle, 'env-status');
  if (!lookup) return {};
  if (!lookup.executable) return { warning: notExecutableWarning(lookup) };
  const result = spawnSync(lookup.path, [], {
    cwd: handle.hookCwd,
    env: buildHookEnv(handle, slot),
    encoding: 'utf-8',
    timeout: STATUS_HOOK_TIMEOUT_MS,
  });
  if (result.status !== 0) {
    return { warning: `env-status exited with code ${result.status}` };
  }
  try {
    return { json: JSON.parse(result.stdout) };
  } catch {
    return { warning: 'env-status did not print valid JSON' };
  }
}

function grepReady(handle: EnvHandle): boolean | undefined {
  if (!handle.readyPattern) return undefined;
  if (!existsSync(handle.paths.logFile)) return false;
  try {
    return new RegExp(handle.readyPattern).test(readFileSync(handle.paths.logFile, 'utf-8'));
  } catch {
    // Invalid regex in config — fall back to substring.
    return readFileSync(handle.paths.logFile, 'utf-8').includes(handle.readyPattern);
  }
}

/**
 * The lazy supervisor: called only on demand (ccw env status, create/resume,
 * ls --json paths). Prunes crashed attachers (tearing down on the non-empty
 * -> empty transition), reconciles phase against PID/hook/log evidence, and
 * persists what it learned.
 */
export async function getStatus(handle: EnvHandle): Promise<EnvStatus> {
  const { state, prunedToEmpty } = await reconcile(handle);
  if (!state) {
    return { exists: false, phase: 'stopped', alive: false, warnings: [], logFile: handle.paths.logFile, attachedSessions: 0 };
  }

  const wasActive = state.phase === 'starting' || state.phase === 'running';
  if (prunedToEmpty && wasActive) {
    await stopEnvironment(handle);
    const after = readState(handle.paths);
    return {
      exists: true,
      phase: after?.phase ?? 'stopped',
      alive: false,
      warnings: ['All attached sessions were gone (crashed?) — environment torn down.'],
      logFile: handle.paths.logFile,
      slot: state.slot,
      attachedSessions: 0,
    };
  }

  const warnings: string[] = [];
  const alive = state.pid !== undefined && isPidAlive(state.pid);
  const hookResult = wasActive || alive ? runStatusHook(handle, state.slot) : {};
  if (hookResult.warning) warnings.push(hookResult.warning);

  let ready: boolean | undefined;
  if (hookResult.json !== undefined) {
    ready = (hookResult.json as { ready?: unknown }).ready === true;
  } else {
    ready = grepReady(handle);
  }

  let phase = state.phase;
  if (wasActive) {
    if (alive) {
      phase = ready === false ? 'starting' : 'running';
    } else if (ready === true && hookResult.json !== undefined) {
      // Self-daemonized: the start process is gone but the hook says healthy.
      phase = 'running';
      if (!hook(handle, 'env-stop')) {
        warnings.push(
          'Environment appears self-daemonizing but has no env-stop hook — ccw cannot tear it down automatically.',
        );
      }
    } else {
      phase = 'failed';
    }
    if (phase !== state.phase) {
      await withLock(handle.paths.lockFile, () => {
        const current = readState(handle.paths);
        if (current) writeState(handle.paths, { ...current, phase });
      });
    }
  }

  return {
    exists: true,
    phase,
    alive,
    ready,
    hookStatus: hookResult.json,
    warnings,
    logFile: handle.paths.logFile,
    slot: state.slot,
    attachedSessions: state.attachedSessions.length,
  };
}

/** Record this ccw process as evidence that a session is using the env. */
export async function attachSession(handle: EnvHandle, sessionId: string): Promise<void> {
  await withLock(handle.paths.lockFile, () => {
    const state = readState(handle.paths);
    if (!state) return;
    const attached = state.attachedSessions.filter((s) => s.sessionId !== sessionId);
    attached.push({ sessionId, ccwPid: process.pid });
    writeState(handle.paths, { ...state, attachedSessions: attached });
  });
}

/** Remove our attachment; last one out turns off the lights. */
export async function detachSession(handle: EnvHandle, sessionId: string): Promise<void> {
  const lastOut = await withLock(handle.paths.lockFile, () => {
    const state = readState(handle.paths);
    if (!state) return false;
    const pruned = pruneAttachments(state);
    const remaining = pruned.state.attachedSessions.filter(
      (s) => !(s.sessionId === sessionId && s.ccwPid === process.pid),
    );
    writeState(handle.paths, { ...pruned.state, attachedSessions: remaining });
    return state.attachedSessions.length > 0 && remaining.length === 0;
  });
  if (lastOut) await stopEnvironment(handle);
}
