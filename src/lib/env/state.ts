import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { EnvPaths } from './paths.ts';

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
