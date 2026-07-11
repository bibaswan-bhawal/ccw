import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { EnvPaths } from './paths.ts';
import { envRoot } from './paths.ts';

export type EnvPhase = 'setup' | 'starting' | 'running' | 'stopped' | 'failed';

/**
 * Evidence of a live attachment: the Claude session id and the PID of the
 * ccw process hosting it. Readers verify ccwPid against the OS rather than
 * trusting a counter — a crashed ccw can't decrement, but its PID dies.
 */
export interface AttachedSession {
  sessionId: string;
  ccwPid: number;
}

export interface EnvState {
  /** Stable per-worktree uniqueness token (CCW_WORKTREE_SLOT). */
  slot: number;
  phase: EnvPhase;
  /** env-start process-group leader; may be dead if the hook self-daemonized. */
  pid?: number;
  startedAt?: string;
  /** Present ⇒ env-setup succeeded once; don't re-run. */
  setupCompletedAt?: string;
  attachedSessions: AttachedSession[];
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readState(paths: EnvPaths): EnvState | undefined {
  if (!existsSync(paths.stateFile)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(paths.stateFile, 'utf-8')) as EnvState;
    if (typeof raw.slot !== 'number' || !Array.isArray(raw.attachedSessions)) {
      throw new Error('unexpected state shape');
    }
    return raw;
  } catch {
    // Corrupt bookkeeping must never crash a command. Keep the evidence
    // for debugging and let the next start rebuild from scratch.
    try {
      renameSync(paths.stateFile, `${paths.stateFile}.bak`);
    } catch {
      /* best effort */
    }
    return undefined;
  }
}

export function writeState(paths: EnvPaths, state: EnvState): void {
  mkdirSync(paths.root, { recursive: true });
  const tmp = `${paths.stateFile}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  renameSync(tmp, paths.stateFile);
}

const LOCK_RETRY_MS = 50;
const LOCK_RETRIES = 100; // ~5s worst case

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Serialize mutations with an O_EXCL lock file containing the holder's PID.
 * A lock whose holder is dead is stale and gets stolen — a crashed ccw must
 * not wedge the worktree's environment forever.
 */
export async function withLock<T>(lockFile: string, fn: () => T | Promise<T>): Promise<T> {
  mkdirSync(dirname(lockFile), { recursive: true });
  for (let attempt = 0; attempt < LOCK_RETRIES; attempt++) {
    try {
      writeFileSync(lockFile, String(process.pid), { flag: 'wx' });
    } catch {
      try {
        const holder = Number(readFileSync(lockFile, 'utf-8'));
        if (Number.isInteger(holder) && holder > 0 && !isPidAlive(holder)) {
          unlinkSync(lockFile);
          continue;
        }
      } catch {
        /* lock vanished between attempts — retry immediately */
        continue;
      }
      await sleep(LOCK_RETRY_MS);
      continue;
    }
    try {
      return await fn();
    } finally {
      try {
        unlinkSync(lockFile);
      } catch {
        /* best effort */
      }
    }
  }
  throw new Error(`Could not acquire environment lock: ${lockFile}`);
}

export interface PruneResult {
  state: EnvState;
  changed: boolean;
  /** True only on a non-empty -> empty transition (triggers teardown). */
  prunedToEmpty: boolean;
}

export function pruneAttachments(state: EnvState, alive: (pid: number) => boolean = isPidAlive): PruneResult {
  const before = state.attachedSessions.length;
  const kept = state.attachedSessions.filter((s) => alive(s.ccwPid));
  return {
    state: { ...state, attachedSessions: kept },
    changed: kept.length !== before,
    prunedToEmpty: before > 0 && kept.length === 0,
  };
}

/**
 * Lowest free non-negative integer across all worktrees' env states in this
 * repo. Dense like fd numbering: active worktrees keep small numbers even
 * after many others have come and gone. Callers must hold the slot lock
 * (see lifecycle.ts) to avoid two creates picking the same slot.
 */
export function allocateSlot(repoConfigPath: string): number {
  const root = envRoot(repoConfigPath);
  const used = new Set<number>();
  if (existsSync(root)) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const raw = JSON.parse(readFileSync(join(root, entry.name, 'state.json'), 'utf-8')) as { slot?: number };
        if (typeof raw.slot === 'number') used.add(raw.slot);
      } catch {
        /* absent or corrupt — holds no slot */
      }
    }
  }
  let slot = 0;
  while (used.has(slot)) slot++;
  return slot;
}
