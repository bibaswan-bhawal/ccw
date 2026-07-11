import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResolvedConfig } from '../src/lib/config.ts';
import { createEnvHandle, ensureState, hasEnvHooks, runSetup, startEnvironment, stopEnvironment, removeEnvironment, type EnvHandle } from '../src/lib/env/lifecycle.ts';
import { isPidAlive, readState } from '../src/lib/env/state.ts';

let tmp: string;
let cfg: ResolvedConfig;
let worktreePath: string;

function fakeConfig(): ResolvedConfig {
  return {
    gitRoot: join(tmp, 'repo'),
    repoName: 'repo',
    worktreeDir: join(tmp, 'repo_worktrees'),
    appSubdir: '',
    baseBranch: 'main',
    pluginConfigs: {},
    dataDir: join(tmp, 'data'),
    sessionsFile: join(tmp, 'data', 'sessions.json'),
    repoConfigPath: join(tmp, 'data', 'repos', '-repo', 'config.json'),
    environment: {},
  };
}

function writeHook(name: string, body: string): string {
  const dir = join(worktreePath, '.ccw', 'hooks');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function handle(): EnvHandle {
  return createEnvHandle(cfg, 'feat-a', worktreePath);
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ccw-lifecycle-'));
  cfg = fakeConfig();
  worktreePath = join(cfg.worktreeDir, 'feat-a');
  mkdirSync(worktreePath, { recursive: true });
  mkdirSync(join(tmp, 'data', 'repos', '-repo'), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('createEnvHandle', () => {
  test('hookCwd is the worktree when no appSubdir', () => {
    expect(handle().hookCwd).toBe(worktreePath);
  });

  test('hookCwd respects appSubdir when it exists', () => {
    mkdirSync(join(worktreePath, 'app'), { recursive: true });
    const h = createEnvHandle({ ...cfg, appSubdir: 'app' }, 'feat-a', worktreePath);
    expect(h.hookCwd).toBe(join(worktreePath, 'app'));
  });
});

describe('hasEnvHooks', () => {
  test('false with no hooks', () => {
    expect(hasEnvHooks(handle())).toBe(false);
  });

  test('true when any hook exists', () => {
    writeHook('env-status', 'echo "{}"');
    expect(hasEnvHooks(handle())).toBe(true);
  });
});

describe('ensureState', () => {
  test('creates state with allocated slot on first touch', async () => {
    const state = await ensureState(handle());
    expect(state.slot).toBe(0);
    expect(state.phase).toBe('setup');
    expect(state.attachedSessions).toEqual([]);
  });

  test('returns existing state on second call', async () => {
    await ensureState(handle());
    const again = await ensureState(handle());
    expect(again.slot).toBe(0);
  });
});

describe('runSetup', () => {
  test('no hook: ran=false ok=true', async () => {
    expect(await runSetup(handle())).toEqual({ ran: false, ok: true });
  });

  test('successful setup logs output and records setupCompletedAt', async () => {
    writeHook('env-setup', 'echo "setup for $CCW_WORKTREE_NAME slot $CCW_WORKTREE_SLOT"');
    const h = handle();
    const result = await runSetup(h);
    expect(result).toEqual({ ran: true, ok: true });
    expect(readFileSync(h.paths.logFile, 'utf-8')).toContain('setup for feat-a slot 0');
    expect(readState(h.paths)?.setupCompletedAt).toBeTruthy();
    expect(existsSync(h.paths.scratchDir)).toBe(true);
  });

  test('setup is not re-run once completed', async () => {
    writeHook('env-setup', 'echo ran-once');
    const h = handle();
    await runSetup(h);
    const second = await runSetup(h);
    expect(second).toEqual({ ran: false, ok: true });
    const log = readFileSync(h.paths.logFile, 'utf-8');
    expect(log.match(/ran-once/g)).toHaveLength(1);
  });

  test('failing setup: ok=false with warning, phase failed, retryable', async () => {
    writeHook('env-setup', 'echo doomed; exit 3');
    const h = handle();
    const result = await runSetup(h);
    expect(result.ran).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.warning).toContain('exit');
    expect(readState(h.paths)?.phase).toBe('failed');
    expect(readState(h.paths)?.setupCompletedAt).toBeUndefined();
  });

  test('non-executable hook warns with chmod hint', async () => {
    const dir = join(worktreePath, '.ccw', 'hooks');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'env-setup'), '#!/bin/sh\nexit 0\n'); // no chmod
    const result = await runSetup(handle());
    expect(result.ok).toBe(false);
    expect(result.warning).toContain('chmod +x');
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('startEnvironment', () => {
  test('no hook: started=false, no state side effects beyond none', async () => {
    const result = await startEnvironment(handle());
    expect(result.started).toBe(false);
    expect(result.alreadyRunning).toBe(false);
  });

  test('spawns detached, records pid, phase starting, logs output', async () => {
    writeHook('env-start', 'echo "starting slot $CCW_WORKTREE_SLOT"; sleep 30');
    const h = handle();
    const result = await startEnvironment(h);
    expect(result.started).toBe(true);
    const state = readState(h.paths);
    expect(state?.phase).toBe('starting');
    expect(state?.pid).toBeGreaterThan(0);
    expect(state?.startedAt).toBeTruthy();
    expect(isPidAlive(state!.pid!)).toBe(true);
    await sleep(200); // let the shell write its echo
    expect(readFileSync(h.paths.logFile, 'utf-8')).toContain('starting slot 0');
    // cleanup: kill the sleeping process group
    process.kill(-state!.pid!, 'SIGKILL');
  });

  test('already running: does not double-start', async () => {
    writeHook('env-start', 'sleep 30');
    const h = handle();
    await startEnvironment(h);
    const pid = readState(h.paths)!.pid!;
    const second = await startEnvironment(h);
    expect(second.started).toBe(false);
    expect(second.alreadyRunning).toBe(true);
    expect(readState(h.paths)!.pid).toBe(pid);
    process.kill(-pid, 'SIGKILL');
  });

  test('non-executable env-start warns', async () => {
    const dir = join(worktreePath, '.ccw', 'hooks');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'env-start'), '#!/bin/sh\nsleep 30\n'); // no chmod
    const result = await startEnvironment(handle());
    expect(result.started).toBe(false);
    expect(result.warning).toContain('chmod +x');
  });
});

describe('stopEnvironment', () => {
  test('kills the process group of a foreground env-start', async () => {
    // Hook spawns a child of its own so we verify the whole GROUP dies.
    writeHook('env-start', 'sleep 30 & sleep 30');
    const h = handle();
    await startEnvironment(h);
    const pid = readState(h.paths)!.pid!;
    expect(isPidAlive(pid)).toBe(true);
    await stopEnvironment(h);
    expect(isPidAlive(pid)).toBe(false);
    const state = readState(h.paths);
    expect(state?.phase).toBe('stopped');
    expect(state?.pid).toBeUndefined();
  }, 15_000);

  test('prefers env-stop hook and still reaps the group', async () => {
    writeHook('env-start', 'sleep 30');
    writeHook('env-stop', `echo stopped-by-hook >> "$CCW_ENV_DIR/marker"`);
    const h = handle();
    await startEnvironment(h);
    await stopEnvironment(h);
    expect(readFileSync(join(h.paths.scratchDir, 'marker'), 'utf-8')).toContain('stopped-by-hook');
    expect(readState(h.paths)?.phase).toBe('stopped');
  }, 15_000);

  test('no state: no-op', async () => {
    await expect(stopEnvironment(handle())).resolves.toBeUndefined();
  });
});

describe('removeEnvironment', () => {
  test('stops and deletes the env dir (slot freed)', async () => {
    writeHook('env-start', 'sleep 30');
    const h = handle();
    await startEnvironment(h);
    await removeEnvironment(h);
    expect(existsSync(h.paths.root)).toBe(false);
  }, 15_000);
});
