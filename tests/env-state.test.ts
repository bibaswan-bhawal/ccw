import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { envPaths, envRoot } from '../src/lib/env/paths.ts';
import { isPidAlive, readState, writeState, type EnvState } from '../src/lib/env/state.ts';

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
