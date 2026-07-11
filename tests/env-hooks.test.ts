import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findHook, hookEnv } from '../src/lib/env/hooks.ts';

let tmp: string;
let worktreePath: string;
let repoConfigPath: string;

function writeHook(dir: string, name: string, executable = true): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, '#!/bin/sh\nexit 0\n');
  if (executable) chmodSync(path, 0o755);
  return path;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ccw-hooks-'));
  worktreePath = join(tmp, 'worktree');
  mkdirSync(worktreePath, { recursive: true });
  repoConfigPath = join(tmp, 'data', 'repos', '-x', 'config.json');
  mkdirSync(join(tmp, 'data', 'repos', '-x'), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('findHook', () => {
  test('returns undefined when hook absent everywhere', () => {
    expect(findHook('env-start', worktreePath, repoConfigPath)).toBeUndefined();
  });

  test('finds in-tree hook', () => {
    const p = writeHook(join(worktreePath, '.ccw', 'hooks'), 'env-start');
    const found = findHook('env-start', worktreePath, repoConfigPath);
    expect(found).toEqual({ path: p, source: 'repo', executable: true });
  });

  test('finds user-level hook when in-tree absent', () => {
    const p = writeHook(join(tmp, 'data', 'repos', '-x', 'hooks'), 'env-stop');
    const found = findHook('env-stop', worktreePath, repoConfigPath);
    expect(found).toEqual({ path: p, source: 'user', executable: true });
  });

  test('in-tree wins over user-level', () => {
    writeHook(join(tmp, 'data', 'repos', '-x', 'hooks'), 'env-start');
    const repoHook = writeHook(join(worktreePath, '.ccw', 'hooks'), 'env-start');
    expect(findHook('env-start', worktreePath, repoConfigPath)?.path).toBe(repoHook);
  });

  test('non-executable hook is reported, not skipped', () => {
    writeHook(join(worktreePath, '.ccw', 'hooks'), 'env-setup', false);
    const found = findHook('env-setup', worktreePath, repoConfigPath);
    expect(found?.executable).toBe(false);
    expect(found?.source).toBe('repo');
  });
});

describe('hookEnv', () => {
  test('exposes the documented CCW_* contract', () => {
    const env = hookEnv({
      worktreePath: '/w',
      worktreeName: 'feat-a',
      gitRoot: '/repo',
      scratchDir: '/scratch',
      slot: 3,
    });
    expect(env.CCW_WORKTREE_PATH).toBe('/w');
    expect(env.CCW_WORKTREE_NAME).toBe('feat-a');
    expect(env.CCW_GIT_ROOT).toBe('/repo');
    expect(env.CCW_ENV_DIR).toBe('/scratch');
    expect(env.CCW_WORKTREE_SLOT).toBe('3');
    // Inherits the parent environment so hooks see PATH etc.
    expect(env.PATH).toBe(process.env.PATH);
  });
});
