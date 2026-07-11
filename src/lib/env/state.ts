import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { envPaths, envRoot, type EnvPaths } from './paths.ts';

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
 *
 * Steal path uses claim-by-rename rather than a bare unlink: `renameSync` is
 * atomic, so when multiple racers observe the same dead holder, exactly one
 * of them wins the rename onto a per-pid claim path and the rest fail and
 * retry. This closes a TOCTOU where two racers could each read a dead
 * holder, both unlink, and both then believe they're free to recreate the
 * lock — the old bug that let two callers hold the lock concurrently.
 *
 * Residual guarantee: steals are fully serialized by the rename. The only
 * remaining window is between the winner's read of the (dead) holder and
 * its renameSync call — if a new holder recreates the lock in that
 * microsecond-scale gap, the winner detects the mismatch after claiming and
 * restores the new content instead of clobbering it. That window is
 * acceptable because critical sections guarded by this lock are
 * millisecond-scale file mutations, not long-held resources.
 */
export async function withLock<T>(lockFile: string, fn: () => T | Promise<T>): Promise<T> {
  mkdirSync(dirname(lockFile), { recursive: true });
  for (let attempt = 0; attempt < LOCK_RETRIES; attempt++) {
    try {
      writeFileSync(lockFile, String(process.pid), { flag: 'wx' });
    } catch {
      let captured: string;
      try {
        captured = readFileSync(lockFile, 'utf-8');
      } catch {
        /* lock vanished between attempts — retry immediately */
        continue;
      }
      const holder = Number(captured);
      // Non-numeric content is treated as a live holder and simply retried
      // until timeout (~5s) — an intentional fail-safe: we'd rather wait out
      // garbled content than risk stealing a lock that's actually held.
      if (!(Number.isInteger(holder) && holder > 0 && !isPidAlive(holder))) {
        await sleep(LOCK_RETRY_MS);
        continue;
      }
      const claim = `${lockFile}.steal-${process.pid}`;
      try {
        renameSync(lockFile, claim);
      } catch {
        // Another racer won the rename (or a live holder already replaced
        // the name); back off and retry rather than fight over it.
        continue;
      }
      try {
        const claimedContent = readFileSync(claim, 'utf-8');
        if (claimedContent === captured) {
          // Still names the dead holder we saw before renaming — free to
          // remove. The next iteration's `wx` create decides who acquires.
          unlinkSync(claim);
        } else {
          // A live lock slipped in under the old name between our read and
          // our rename. Restore it without clobbering a newer holder that
          // may have already recreated the name in the meantime.
          try {
            writeFileSync(lockFile, claimedContent, { flag: 'wx' });
          } catch {
            /* a newer holder took the name in the interim — accept */
          }
          unlinkSync(claim);
        }
      } catch {
        /* claimed file vanished unexpectedly — nothing to restore */
      }
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
        const raw = JSON.parse(readFileSync(envPaths(repoConfigPath, entry.name).stateFile, 'utf-8')) as { slot?: number };
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
