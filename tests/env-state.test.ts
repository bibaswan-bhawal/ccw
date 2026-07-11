import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { envPaths, envRoot } from '../src/lib/env/paths.ts';
import { allocateSlot, isPidAlive, pruneAttachments, readState, withLock, writeState, type EnvState } from '../src/lib/env/state.ts';

let tmp: string;
let repoConfigPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ccw-env-'));
  repoConfigPath = join(tmp, 'repos', '-Users-me-proj', 'config.json');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const baseState: EnvState = { slot: 0, phase: 'setup', attachedSessions: [] };

describe('envPaths', () => {
  test('lays out env dir beside config.json', () => {
    expect(envRoot(repoConfigPath)).toBe(join(tmp, 'repos', '-Users-me-proj', 'env'));
    const p = envPaths(repoConfigPath, 'feat-a');
    expect(p.root).toBe(join(tmp, 'repos', '-Users-me-proj', 'env', 'feat-a'));
    expect(p.stateFile).toBe(join(p.root, 'state.json'));
    expect(p.lockFile).toBe(join(p.root, 'state.lock'));
    expect(p.logFile).toBe(join(p.root, 'env.log'));
    expect(p.scratchDir).toBe(join(p.root, 'scratch'));
  });
});

describe('state read/write', () => {
  test('readState returns undefined when no file', () => {
    expect(readState(envPaths(repoConfigPath, 'feat-a'))).toBeUndefined();
  });

  test('round-trips state and creates dirs', () => {
    const p = envPaths(repoConfigPath, 'feat-a');
    writeState(p, { ...baseState, pid: 1234, phase: 'running' });
    expect(readState(p)).toEqual({ ...baseState, pid: 1234, phase: 'running' });
  });

  test('write is atomic: no partial tmp file left behind', () => {
    const p = envPaths(repoConfigPath, 'feat-a');
    writeState(p, baseState);
    const entries = readFileSync(p.stateFile, 'utf-8');
    expect(JSON.parse(entries).slot).toBe(0);
    expect(existsSync(`${p.stateFile}.tmp-${process.pid}`)).toBe(false);
  });

  test('corrupt state file is renamed to .bak and read as undefined', () => {
    const p = envPaths(repoConfigPath, 'feat-a');
    mkdirSync(p.root, { recursive: true });
    writeFileSync(p.stateFile, '{not json');
    expect(readState(p)).toBeUndefined();
    expect(existsSync(`${p.stateFile}.bak`)).toBe(true);
    expect(existsSync(p.stateFile)).toBe(false);
  });

  test('state with wrong shape treated as corrupt', () => {
    const p = envPaths(repoConfigPath, 'feat-a');
    mkdirSync(p.root, { recursive: true });
    writeFileSync(p.stateFile, JSON.stringify({ slot: 'zero' }));
    expect(readState(p)).toBeUndefined();
  });
});

describe('isPidAlive', () => {
  test('own pid is alive', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  test('unlikely pid is dead', () => {
    expect(isPidAlive(2 ** 22 - 7)).toBe(false);
  });
});

describe('withLock', () => {
  test('runs fn and releases the lock', async () => {
    const p = envPaths(repoConfigPath, 'feat-a');
    const result = await withLock(p.lockFile, () => 42);
    expect(result).toBe(42);
    expect(existsSync(p.lockFile)).toBe(false);
  });

  test('releases the lock when fn throws', async () => {
    const p = envPaths(repoConfigPath, 'feat-a');
    await expect(withLock(p.lockFile, () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(existsSync(p.lockFile)).toBe(false);
  });

  test('steals a stale lock held by a dead pid', async () => {
    const p = envPaths(repoConfigPath, 'feat-a');
    mkdirSync(p.root, { recursive: true });
    writeFileSync(p.lockFile, String(2 ** 22 - 7)); // dead pid
    const result = await withLock(p.lockFile, () => 'ok');
    expect(result).toBe('ok');
  });

  test('concurrent withLock calls serialize (mutual exclusion)', async () => {
    const p = envPaths(repoConfigPath, 'feat-a');
    let inside = 0;
    let maxInside = 0;
    await Promise.all(
      [1, 2, 3].map(() =>
        withLock(p.lockFile, async () => {
          inside++;
          maxInside = Math.max(maxInside, inside);
          await new Promise((r) => setTimeout(r, 30));
          inside--;
        }),
      ),
    );
    expect(maxInside).toBe(1);
  });
});

describe('pruneAttachments', () => {
  test('keeps live attachers, drops dead ones', () => {
    const state: EnvState = {
      ...baseState,
      attachedSessions: [
        { sessionId: 'a', ccwPid: 111 },
        { sessionId: 'b', ccwPid: 222 },
      ],
    };
    const alive = (pid: number) => pid === 222;
    const result = pruneAttachments(state, alive);
    expect(result.state.attachedSessions).toEqual([{ sessionId: 'b', ccwPid: 222 }]);
    expect(result.changed).toBe(true);
    expect(result.prunedToEmpty).toBe(false);
  });

  test('prunedToEmpty only on non-empty -> empty transition', () => {
    const dead = () => false;
    const nonEmpty: EnvState = { ...baseState, attachedSessions: [{ sessionId: 'a', ccwPid: 111 }] };
    expect(pruneAttachments(nonEmpty, dead).prunedToEmpty).toBe(true);
    // Explicit `ccw env start` shape: empty from the outset — not a transition.
    expect(pruneAttachments(baseState, dead).prunedToEmpty).toBe(false);
    expect(pruneAttachments(baseState, dead).changed).toBe(false);
  });
});

describe('allocateSlot', () => {
  test('first slot is 0', () => {
    expect(allocateSlot(repoConfigPath)).toBe(0);
  });

  test('allocates lowest free integer', () => {
    writeState(envPaths(repoConfigPath, 'feat-a'), { ...baseState, slot: 0 });
    writeState(envPaths(repoConfigPath, 'feat-b'), { ...baseState, slot: 2 });
    expect(allocateSlot(repoConfigPath)).toBe(1);
  });

  test('freed slots are reused (dense allocation)', () => {
    writeState(envPaths(repoConfigPath, 'feat-a'), { ...baseState, slot: 0 });
    writeState(envPaths(repoConfigPath, 'feat-b'), { ...baseState, slot: 1 });
    rmSync(envPaths(repoConfigPath, 'feat-a').root, { recursive: true });
    expect(allocateSlot(repoConfigPath)).toBe(0);
  });

  test('corrupt sibling state does not hold a slot', () => {
    const p = envPaths(repoConfigPath, 'feat-a');
    mkdirSync(p.root, { recursive: true });
    writeFileSync(p.stateFile, 'garbage');
    expect(allocateSlot(repoConfigPath)).toBe(0);
  });
});
