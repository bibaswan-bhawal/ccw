# Isolated Environments for Worktrees Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When `ccw <feature>` runs, ccw starts the project's dev environment in the background via project-supplied hook scripts, tracks it in a state file under `~/.ccw`, tears it down when the last Claude session exits, and tells Claude how to inspect/use it.

**Architecture:** Hook scripts (`env-setup`/`env-start`/`env-stop`/`env-status`) discovered in-tree first then user-level. `env-start` is spawned detached in its own process group with output to a log file; a per-worktree `state.json` records PID, slot, and attached sessions. Supervision is lazy — every reader re-derives truth (PID liveness, log grep, prune dead attachers). **No environment work happens while Claude runs** (hard constraint from PTY input bugs).

**Tech Stack:** Bun runtime, TypeScript ESM (`.ts` import suffixes), commander, vitest (Node) for tests.

**Spec:** `docs/superpowers/specs/2026-07-10-isolated-environments-design.md` — read it before starting.

## Global Constraints

- ccw must do **zero environment work while Claude runs**: env operations happen before `launchClaude()`, after it returns, or in a separate `ccw env` invocation. Never add watchers/timers that live during the session.
- ccw never writes to the working tree. All state under `~/.ccw/repos/<encoded>/env/<feature>/`.
- Use `node:child_process` (NOT `Bun.spawn`) in all new env code — vitest runs under Node and must be able to import and execute these modules. Bun implements `node:child_process` at runtime.
- All imports use explicit `.ts` extensions (repo convention).
- State writes are atomic (temp file + `renameSync`); mutations hold a lock file.
- Corrupt state must never crash a command.
- Teardown must never hang: `env-stop` capped at 30s, group kill grace 5s.
- Commit style: conventional commits (`feat:`, `test:`, `docs:`), one commit per task, message body ends with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Run `npx vitest run tests/<file>` for single files; full check before finishing a task: `bun run typecheck && npx vitest run`.

## File Structure

```
src/lib/env/paths.ts        env dir layout (root, state.json, env.log, scratch/)   [Task 1]
src/lib/env/state.ts        EnvState read/write/lock/prune/slot allocation         [Tasks 1-2]
src/lib/env/hooks.ts        hook discovery + hook env vars                         [Task 3]
src/lib/env/lifecycle.ts    setup/start/stop/status/attach/detach orchestration    [Tasks 5-8]
src/commands/env.ts         ccw env status|logs|start|stop|restart                 [Task 10]
src/lib/config.ts           + environment.ready_pattern block                      [Task 4]
src/lib/claude.ts           + buildEnvironmentSystemPrompt                         [Task 9]
src/index.ts                + env command wiring                                   [Task 10]
src/lib/reserved.ts         + 'env' reserved name                                  [Task 10]
src/commands/create.ts      create/resume env integration                          [Task 11]
src/commands/ls.ts          env badge + picker delegates resume to runCreate       [Tasks 11-12]
src/commands/rm.ts          teardown before removal                                [Task 12]
tests/env-state.test.ts, tests/env-hooks.test.ts, tests/env-lifecycle.test.ts
```

---

### Task 1: Env paths + state file read/write

**Files:**
- Create: `src/lib/env/paths.ts`
- Create: `src/lib/env/state.ts`
- Test: `tests/env-state.test.ts`

**Interfaces:**
- Produces: `envRoot(repoConfigPath): string`, `envPaths(repoConfigPath, featureName): EnvPaths` (`{root, stateFile, lockFile, logFile, scratchDir}`); `EnvPhase`, `AttachedSession`, `EnvState`; `readState(paths): EnvState | undefined`, `writeState(paths, state): void`, `isPidAlive(pid): boolean`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/env-state.test.ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/env-state.test.ts`
Expected: FAIL — cannot resolve `../src/lib/env/paths.ts`

- [ ] **Step 3: Implement paths.ts and state.ts**

```ts
// src/lib/env/paths.ts
import { dirname, join } from 'node:path';

/**
 * Filesystem layout for one worktree's environment. Everything lives beside
 * the per-repo config.json under ~/.ccw — never in the working tree.
 */
export interface EnvPaths {
  /** ~/.ccw/repos/<encoded>/env/<feature> */
  root: string;
  stateFile: string;
  lockFile: string;
  /** env-setup and env-start stdout+stderr, append-only. */
  logFile: string;
  /** Exposed to hooks as CCW_ENV_DIR — pidfiles, sockets, scratch. */
  scratchDir: string;
}

export function envRoot(repoConfigPath: string): string {
  return join(dirname(repoConfigPath), 'env');
}

export function envPaths(repoConfigPath: string, featureName: string): EnvPaths {
  const root = join(envRoot(repoConfigPath), featureName);
  return {
    root,
    stateFile: join(root, 'state.json'),
    lockFile: join(root, 'state.lock'),
    logFile: join(root, 'env.log'),
    scratchDir: join(root, 'scratch'),
  };
}
```

```ts
// src/lib/env/state.ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/env-state.test.ts`
Expected: PASS (all)

- [ ] **Step 5: Typecheck and commit**

```bash
bun run typecheck
git add src/lib/env/paths.ts src/lib/env/state.ts tests/env-state.test.ts
git commit -m "feat(env): env dir layout and durable state file"
```

---

### Task 2: State lock, attachment pruning, slot allocation

**Files:**
- Modify: `src/lib/env/state.ts` (append)
- Test: `tests/env-state.test.ts` (append)

**Interfaces:**
- Consumes: Task 1's `EnvState`, `EnvPaths`, `isPidAlive`, `readState`.
- Produces: `withLock<T>(lockFile: string, fn: () => T | Promise<T>): Promise<T>`; `pruneAttachments(state: EnvState, alive?: (pid: number) => boolean): PruneResult` where `PruneResult = { state: EnvState; changed: boolean; prunedToEmpty: boolean }`; `allocateSlot(repoConfigPath: string): number`.

- [ ] **Step 1: Write the failing tests (append to tests/env-state.test.ts)**

```ts
// append imports at top of tests/env-state.test.ts:
import { allocateSlot, pruneAttachments, withLock } from '../src/lib/env/state.ts';

// append at bottom:
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
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx vitest run tests/env-state.test.ts`
Expected: FAIL — `withLock` / `pruneAttachments` / `allocateSlot` not exported

- [ ] **Step 3: Implement (append to src/lib/env/state.ts)**

```ts
// add to imports at top:
import { readdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { envRoot } from './paths.ts';

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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/env-state.test.ts`
Expected: PASS (all)

- [ ] **Step 5: Typecheck and commit**

```bash
bun run typecheck
git add src/lib/env/state.ts tests/env-state.test.ts
git commit -m "feat(env): state locking, attachment pruning, dense slot allocation"
```

---

### Task 3: Hook discovery + hook environment variables

**Files:**
- Create: `src/lib/env/hooks.ts`
- Test: `tests/env-hooks.test.ts`

**Interfaces:**
- Produces: `HookName = 'env-setup' | 'env-start' | 'env-stop' | 'env-status'`; `HookLookup = { path: string; source: 'repo' | 'user'; executable: boolean }`; `findHook(name: HookName, worktreePath: string, repoConfigPath: string): HookLookup | undefined`; `hookEnv(input: HookEnvInput): NodeJS.ProcessEnv` where `HookEnvInput = { worktreePath; worktreeName; gitRoot; scratchDir; slot }`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/env-hooks.test.ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/env-hooks.test.ts`
Expected: FAIL — cannot resolve `../src/lib/env/hooks.ts`

- [ ] **Step 3: Implement src/lib/env/hooks.ts**

```ts
// src/lib/env/hooks.ts
import { accessSync, constants, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type HookName = 'env-setup' | 'env-start' | 'env-stop' | 'env-status';

export interface HookLookup {
  path: string;
  /** 'repo' = committed <worktree>/.ccw/hooks, 'user' = ~/.ccw/repos/<repo>/hooks */
  source: 'repo' | 'user';
  /** False = present but missing the exec bit; callers warn with a chmod hint. */
  executable: boolean;
}

/**
 * Discovery order: in-tree (committed, team-shared) wins over user-level
 * (personal, for repos where committing ccw files is unwelcome). The first
 * existing file decides — a broken in-tree hook is a warning, not a reason
 * to silently fall through to a different script.
 */
export function findHook(name: HookName, worktreePath: string, repoConfigPath: string): HookLookup | undefined {
  const candidates: Array<{ path: string; source: 'repo' | 'user' }> = [
    { path: join(worktreePath, '.ccw', 'hooks', name), source: 'repo' },
    { path: join(dirname(repoConfigPath), 'hooks', name), source: 'user' },
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate.path)) continue;
    let executable = true;
    try {
      accessSync(candidate.path, constants.X_OK);
    } catch {
      executable = false;
    }
    return { ...candidate, executable };
  }
  return undefined;
}

export interface HookEnvInput {
  worktreePath: string;
  worktreeName: string;
  gitRoot: string;
  scratchDir: string;
  slot: number;
}

/** The documented env-var contract hooks receive (spec §1). */
export function hookEnv(input: HookEnvInput): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CCW_WORKTREE_PATH: input.worktreePath,
    CCW_WORKTREE_NAME: input.worktreeName,
    CCW_GIT_ROOT: input.gitRoot,
    CCW_ENV_DIR: input.scratchDir,
    CCW_WORKTREE_SLOT: String(input.slot),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/env-hooks.test.ts`
Expected: PASS (all)

- [ ] **Step 5: Typecheck and commit**

```bash
bun run typecheck
git add src/lib/env/hooks.ts tests/env-hooks.test.ts
git commit -m "feat(env): hook discovery with in-tree precedence and CCW_* contract"
```

---

### Task 4: `environment` config block

**Files:**
- Modify: `src/lib/config.ts`
- Test: `tests/config-paths.test.ts` (append — it already exercises `loadConfig` against a temp `CCW_DATA_DIR`; follow its existing setup helpers)

**Interfaces:**
- Consumes: existing `RepoConfig`, `ResolvedConfig`, `resolveFromRaw`.
- Produces: `RepoConfig.environment?: { ready_pattern?: string }`; `ResolvedConfig.environment: { readyPattern?: string }`.

- [ ] **Step 1: Write the failing test**

Open `tests/config-paths.test.ts`, find how it writes a repo config file and calls `loadConfig`/`loadConfigForInit` (it sets `CCW_DATA_DIR` to a temp dir). Append a test using the same helpers:

```ts
test('resolves environment.ready_pattern from repo config', () => {
  // Use this file's existing helper that writes config.json for the temp repo,
  // passing: { environment: { ready_pattern: 'Listening on' } }
  // then load config the same way neighboring tests do.
  const cfg = loadConfigForTest({ environment: { ready_pattern: 'Listening on' } });
  expect(cfg.environment.readyPattern).toBe('Listening on');
});

test('environment block defaults to empty object', () => {
  const cfg = loadConfigForTest({});
  expect(cfg.environment).toEqual({});
});
```

(`loadConfigForTest` here means: whatever pattern the file already uses — write `config.json` under the temp data dir, then call the loader. Match the file's local helper names exactly; do not invent a new harness.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config-paths.test.ts`
Expected: FAIL — `environment` does not exist on `ResolvedConfig`

- [ ] **Step 3: Implement in src/lib/config.ts**

Add to `RepoConfig`:

```ts
  /** Optional environment settings for worktree env hooks. */
  environment?: {
    /** Substring/regex matched against env.log to decide readiness. */
    ready_pattern?: string;
  };
```

Add to `ResolvedConfig`:

```ts
  environment: { readyPattern?: string };
```

In `resolveFromRaw`, add to the returned object:

```ts
    environment: raw.environment?.ready_pattern ? { readyPattern: raw.environment.ready_pattern } : {},
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/config-paths.test.ts tests/config-migration.test.ts`
Expected: PASS (all — migration tests must not regress)

- [ ] **Step 5: Typecheck and commit**

```bash
bun run typecheck && npx vitest run
git add src/lib/config.ts tests/config-paths.test.ts
git commit -m "feat(env): environment.ready_pattern repo config"
```

---

### Task 5: Lifecycle handle, state bootstrap, blocking setup

**Files:**
- Create: `src/lib/env/lifecycle.ts`
- Test: `tests/env-lifecycle.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4 (`envPaths`, state fns, `findHook`, `hookEnv`, `ResolvedConfig.environment`).
- Produces:
  - `EnvHandle = { featureName; worktreePath; hookCwd; gitRoot; repoConfigPath; readyPattern?: string; paths: EnvPaths }`
  - `createEnvHandle(cfg: ResolvedConfig, featureName: string, worktreePath: string): EnvHandle`
  - `hook(handle: EnvHandle, name: HookName): HookLookup | undefined`
  - `hasEnvHooks(handle: EnvHandle): boolean` (true if any of the four hooks exists)
  - `ensureState(handle: EnvHandle): Promise<EnvState>` (creates state with a freshly allocated slot on first touch)
  - `runSetup(handle: EnvHandle): Promise<SetupResult>` where `SetupResult = { ran: boolean; ok: boolean; warning?: string }`
  - `notExecutableWarning(lookup: HookLookup): string` (exported for reuse)

- [ ] **Step 1: Write the failing tests**

```ts
// tests/env-lifecycle.test.ts
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResolvedConfig } from '../src/lib/config.ts';
import { createEnvHandle, ensureState, hasEnvHooks, runSetup, type EnvHandle } from '../src/lib/env/lifecycle.ts';
import { readState } from '../src/lib/env/state.ts';

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/env-lifecycle.test.ts`
Expected: FAIL — cannot resolve `../src/lib/env/lifecycle.ts`

- [ ] **Step 3: Implement src/lib/env/lifecycle.ts**

```ts
// src/lib/env/lifecycle.ts
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import type { ResolvedConfig } from '../config.ts';
import { envPaths, type EnvPaths } from './paths.ts';
import { findHook, hookEnv, type HookLookup, type HookName } from './hooks.ts';
import { allocateSlot, readState, withLock, writeState, type EnvState } from './state.ts';
import { envRoot } from './paths.ts';

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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/env-lifecycle.test.ts`
Expected: PASS (all)

- [ ] **Step 5: Typecheck and commit**

```bash
bun run typecheck
git add src/lib/env/lifecycle.ts tests/env-lifecycle.test.ts
git commit -m "feat(env): lifecycle handle, state bootstrap, blocking env-setup"
```

---

### Task 6: Detached environment start

**Files:**
- Modify: `src/lib/env/lifecycle.ts` (append)
- Test: `tests/env-lifecycle.test.ts` (append)

**Interfaces:**
- Consumes: Task 5's `EnvHandle`, `ensureState`, `hook`, `buildHookEnv`.
- Produces: `startEnvironment(handle: EnvHandle): Promise<StartResult>` where `StartResult = { started: boolean; alreadyRunning: boolean; warning?: string }`.

- [ ] **Step 1: Write the failing tests (append to tests/env-lifecycle.test.ts)**

```ts
// add to imports:
import { startEnvironment, stopEnvironment } from '../src/lib/env/lifecycle.ts';
import { isPidAlive } from '../src/lib/env/state.ts';

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/env-lifecycle.test.ts`
Expected: FAIL — `startEnvironment` not exported

- [ ] **Step 3: Implement (append to src/lib/env/lifecycle.ts)**

```ts
// add to imports at top:
import { spawn } from 'node:child_process';
import { isPidAlive } from './state.ts';

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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/env-lifecycle.test.ts`
Expected: PASS (all)

- [ ] **Step 5: Typecheck and commit**

```bash
bun run typecheck
git add src/lib/env/lifecycle.ts tests/env-lifecycle.test.ts
git commit -m "feat(env): detached env-start with process-group ownership"
```

---

### Task 7: Stop, group kill, and full environment removal

**Files:**
- Modify: `src/lib/env/lifecycle.ts` (append)
- Test: `tests/env-lifecycle.test.ts` (append)

**Interfaces:**
- Consumes: Tasks 5–6.
- Produces: `stopEnvironment(handle: EnvHandle): Promise<void>` (env-stop hook with 30s cap, else/plus group SIGTERM → 5s grace → SIGKILL; sets phase stopped, clears pid); `removeEnvironment(handle: EnvHandle): Promise<void>` (stop + delete `paths.root`, freeing the slot).

- [ ] **Step 1: Write the failing tests (append to tests/env-lifecycle.test.ts)**

```ts
// add to imports:
import { removeEnvironment } from '../src/lib/env/lifecycle.ts';

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/env-lifecycle.test.ts`
Expected: FAIL — `stopEnvironment` / `removeEnvironment` not exported

- [ ] **Step 3: Implement (append to src/lib/env/lifecycle.ts)**

```ts
// add to imports at top:
import { rmSync } from 'node:fs';

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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/env-lifecycle.test.ts`
Expected: PASS (all)

- [ ] **Step 5: Typecheck and commit**

```bash
bun run typecheck
git add src/lib/env/lifecycle.ts tests/env-lifecycle.test.ts
git commit -m "feat(env): bounded teardown with env-stop hook and group kill"
```

---

### Task 8: Status, reconcile, attach/detach with last-out teardown

**Files:**
- Modify: `src/lib/env/lifecycle.ts` (append)
- Test: `tests/env-lifecycle.test.ts` (append)

**Interfaces:**
- Consumes: Tasks 5–7.
- Produces:
  - `EnvStatus = { exists: boolean; phase: EnvPhase; alive: boolean; ready?: boolean; hookStatus?: unknown; warnings: string[]; logFile: string; slot?: number; attachedSessions: number }`
  - `getStatus(handle: EnvHandle): Promise<EnvStatus>` — prunes, reconciles phase, tears down on prune-to-empty, runs `env-status` hook (10s cap) / `ready_pattern` grep.
  - `attachSession(handle: EnvHandle, sessionId: string): Promise<void>`
  - `detachSession(handle: EnvHandle, sessionId: string): Promise<void>` — removes own attachment; if it was the last, `stopEnvironment`.

- [ ] **Step 1: Write the failing tests (append to tests/env-lifecycle.test.ts)**

```ts
// add to imports:
import { attachSession, detachSession, getStatus } from '../src/lib/env/lifecycle.ts';
import { writeState } from '../src/lib/env/state.ts';
import type { EnvState } from '../src/lib/env/state.ts';

describe('getStatus', () => {
  test('no state: exists=false', async () => {
    const s = await getStatus(handle());
    expect(s.exists).toBe(false);
    expect(s.alive).toBe(false);
  });

  test('live process without readiness info reports running', async () => {
    writeHook('env-start', 'sleep 30');
    const h = handle();
    await startEnvironment(h);
    const s = await getStatus(h);
    expect(s.alive).toBe(true);
    expect(s.phase).toBe('running');
    expect(readState(h.paths)?.phase).toBe('running'); // reconciled + persisted
    await stopEnvironment(h);
  }, 15_000);

  test('ready_pattern gates starting -> running', async () => {
    writeHook('env-start', 'echo warming; sleep 30');
    const h = { ...handle(), readyPattern: 'Listening on' };
    await startEnvironment(h);
    await sleep(200);
    let s = await getStatus(h);
    expect(s.ready).toBe(false);
    expect(s.phase).toBe('starting');
    // Simulate the server becoming ready:
    writeFileSync(h.paths.logFile, 'Listening on http://localhost:3000\n', { flag: 'a' });
    s = await getStatus(h);
    expect(s.ready).toBe(true);
    expect(s.phase).toBe('running');
    await stopEnvironment(h);
  }, 15_000);

  test('dead pid without env-status hook reports failed with log tail', async () => {
    writeHook('env-start', 'echo died-immediately; exit 1');
    const h = handle();
    await startEnvironment(h);
    await sleep(300); // let it die
    const s = await getStatus(h);
    expect(s.alive).toBe(false);
    expect(s.phase).toBe('failed');
  });

  test('env-status hook JSON drives readiness for daemonized envs', async () => {
    writeHook('env-start', 'exit 0'); // self-daemonizing shape: exits immediately
    writeHook('env-status', `echo '{"ready": true, "services": [{"name":"web","url":"http://localhost:3000"}]}'`);
    const h = handle();
    await startEnvironment(h);
    await sleep(300);
    const s = await getStatus(h);
    expect(s.ready).toBe(true);
    expect(s.phase).toBe('running');
    expect((s.hookStatus as { services: unknown[] }).services).toHaveLength(1);
    // Daemonized without env-stop: ccw can't tear it down — must warn.
    expect(s.warnings.some((w) => w.includes('env-stop'))).toBe(true);
  });

  test('malformed env-status JSON yields warning, not crash', async () => {
    writeHook('env-start', 'sleep 30');
    writeHook('env-status', 'echo not-json');
    const h = handle();
    await startEnvironment(h);
    const s = await getStatus(h);
    expect(s.warnings.some((w) => w.includes('env-status'))).toBe(true);
    await stopEnvironment(h);
  }, 15_000);
});

describe('attach/detach', () => {
  test('attach records session with our pid', async () => {
    const h = handle();
    await ensureState(h);
    await attachSession(h, 'session-1');
    expect(readState(h.paths)?.attachedSessions).toEqual([{ sessionId: 'session-1', ccwPid: process.pid }]);
  });

  test('last detach tears down the environment', async () => {
    writeHook('env-start', 'sleep 30');
    const h = handle();
    await startEnvironment(h);
    await attachSession(h, 'session-1');
    const pid = readState(h.paths)!.pid!;
    await detachSession(h, 'session-1');
    expect(isPidAlive(pid)).toBe(false);
    expect(readState(h.paths)?.phase).toBe('stopped');
  }, 15_000);

  test('detach with another live attacher does not tear down', async () => {
    writeHook('env-start', 'sleep 30');
    const h = handle();
    await startEnvironment(h);
    await attachSession(h, 'session-1');
    // Another live attacher: use our own pid as evidence of liveness.
    const st = readState(h.paths)!;
    writeState(h.paths, {
      ...st,
      attachedSessions: [...st.attachedSessions, { sessionId: 'session-2', ccwPid: process.pid }],
    });
    const pid = readState(h.paths)!.pid!;
    await detachSession(h, 'session-1');
    expect(isPidAlive(pid)).toBe(true);
    await stopEnvironment(h);
  }, 15_000);

  test('prune-to-empty via getStatus tears down (crash recovery)', async () => {
    writeHook('env-start', 'sleep 30');
    const h = handle();
    await startEnvironment(h);
    const st = readState(h.paths)!;
    // A dead ccw pid: evidence of a crashed terminal.
    writeState(h.paths, { ...st, attachedSessions: [{ sessionId: 'ghost', ccwPid: 2 ** 22 - 7 }] });
    const pid = st.pid!;
    await getStatus(h);
    expect(isPidAlive(pid)).toBe(false);
    expect(readState(h.paths)?.phase).toBe('stopped');
  }, 15_000);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/env-lifecycle.test.ts`
Expected: FAIL — `getStatus` / `attachSession` / `detachSession` not exported

- [ ] **Step 3: Implement (append to src/lib/env/lifecycle.ts)**

```ts
// add to imports at top:
import { readFileSync } from 'node:fs';
import { pruneAttachments, type EnvPhase } from './state.ts';

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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/env-lifecycle.test.ts`
Expected: PASS (all)

- [ ] **Step 5: Typecheck, full suite, commit**

```bash
bun run typecheck && npx vitest run
git add src/lib/env/lifecycle.ts tests/env-lifecycle.test.ts
git commit -m "feat(env): lazy status reconciliation and last-out session teardown"
```

---

### Task 9: Environment system-prompt section

**Files:**
- Modify: `src/lib/claude.ts`
- Test: `tests/claude.test.ts` (append)

**Interfaces:**
- Consumes: nothing new.
- Produces: `buildEnvironmentSystemPrompt(logFile: string): string`; `combineSystemPrompts(sections: Array<string | undefined>): string | undefined` (joins non-empty sections with a blank line; undefined when nothing to say — callers push a single `--append-system-prompt`).

- [ ] **Step 1: Write the failing tests (append to tests/claude.test.ts, matching its existing import style)**

```ts
import { buildEnvironmentSystemPrompt, combineSystemPrompts } from '../src/lib/claude.ts';

describe('buildEnvironmentSystemPrompt', () => {
  test('mentions status, logs, restart commands and the log path', () => {
    const prompt = buildEnvironmentSystemPrompt('/home/u/.ccw/repos/x/env/feat-a/env.log');
    expect(prompt).toContain('ccw env status --json');
    expect(prompt).toContain('ccw env logs');
    expect(prompt).toContain('ccw env restart');
    expect(prompt).toContain('/home/u/.ccw/repos/x/env/feat-a/env.log');
    expect(prompt).toContain('Verify the environment is ready');
  });
});

describe('combineSystemPrompts', () => {
  test('joins non-empty sections with a blank line', () => {
    expect(combineSystemPrompts(['a', undefined, 'b'])).toBe('a\n\nb');
  });
  test('returns undefined when nothing to combine', () => {
    expect(combineSystemPrompts([undefined, ''])).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/claude.test.ts`
Expected: FAIL — not exported

- [ ] **Step 3: Implement (append to src/lib/claude.ts near the other prompt builders)**

```ts
/**
 * System prompt section injected when this worktree has an env-start hook.
 * Static facts only — the environment may still be booting when Claude
 * starts, so we point at the commands rather than assert liveness.
 */
export function buildEnvironmentSystemPrompt(logFile: string): string {
  return `A development environment for this worktree is starting in the background.
- Check state: \`ccw env status --json\`
- Logs: \`ccw env logs\` (file: ${logFile})
- Restart after config changes: \`ccw env restart\`
Verify the environment is ready before using it for testing.`;
}

/**
 * Claude gets at most one --append-system-prompt; merge task context and
 * environment sections into a single blob.
 */
export function combineSystemPrompts(sections: Array<string | undefined>): string | undefined {
  const nonEmpty = sections.filter((s): s is string => Boolean(s && s.length > 0));
  if (nonEmpty.length === 0) return undefined;
  return nonEmpty.join('\n\n');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/claude.test.ts`
Expected: PASS (all)

- [ ] **Step 5: Typecheck and commit**

```bash
bun run typecheck
git add src/lib/claude.ts tests/claude.test.ts
git commit -m "feat(env): environment system-prompt section and prompt combiner"
```

---

### Task 10: `ccw env` command + CLI wiring

**Files:**
- Create: `src/commands/env.ts`
- Modify: `src/index.ts` (register command, extend `KNOWN_COMMANDS`)
- Modify: `src/lib/reserved.ts` (add `'env'`)
- Test: `tests/reserved.test.ts` (append one case)

**Interfaces:**
- Consumes: `loadConfig`, lifecycle API (Tasks 5–8), `ui`.
- Produces: `runEnvStatus(featureName: string | undefined, opts: { json?: boolean }): Promise<void>`, `runEnvLogs(featureName, opts: { lines?: string; follow?: boolean })`, `runEnvStart(featureName)`, `runEnvStop(featureName)`, `runEnvRestart(featureName)` — all exported from `src/commands/env.ts`.

- [ ] **Step 1: Write the failing test for the reserved name (append to tests/reserved.test.ts, matching its style)**

```ts
test("'env' is reserved", () => {
  expect(isReservedName('env')).toBe(true);
  expect(isReservedName('ENV')).toBe(true);
});
```

Run: `npx vitest run tests/reserved.test.ts` — expected FAIL.

- [ ] **Step 2: Add `'env'` to `RESERVED_NAMES` in src/lib/reserved.ts (after `'update'`) and `'env'` to `KNOWN_COMMANDS` in src/index.ts**

Run: `npx vitest run tests/reserved.test.ts` — expected PASS.

- [ ] **Step 3: Implement src/commands/env.ts**

```ts
// src/commands/env.ts
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadConfig, type ResolvedConfig } from '../lib/config.ts';
import {
  createEnvHandle,
  getStatus,
  hasEnvHooks,
  runSetup,
  startEnvironment,
  stopEnvironment,
  type EnvHandle,
} from '../lib/env/lifecycle.ts';
import { ui } from '../lib/ui.ts';

/**
 * Resolve which worktree we're operating on: explicit argument wins, else
 * derive from cwd when it's inside the repo's worktree dir.
 */
function resolveHandle(featureName: string | undefined): { cfg: ResolvedConfig; handle: EnvHandle } {
  const cfg = loadConfig();
  let name = featureName;
  if (!name) {
    const rel = relative(cfg.worktreeDir, process.cwd());
    if (!rel.startsWith('..') && rel !== '') {
      name = rel.split(sep)[0];
    }
  }
  if (!name) {
    ui.error('Not inside a ccw worktree.');
    ui.hint('Usage: ccw env <status|logs|start|stop|restart> [feature-name]');
    process.exit(1);
  }
  const worktreePath = join(cfg.worktreeDir, name);
  if (!existsSync(worktreePath)) {
    ui.error(`Worktree not found: ${worktreePath}`);
    ui.hint("Run 'ccw ls' to see active worktrees.");
    process.exit(1);
  }
  return { cfg, handle: createEnvHandle(cfg, name, worktreePath) };
}

export async function runEnvStatus(featureName: string | undefined, opts: { json?: boolean }): Promise<void> {
  const { handle } = resolveHandle(featureName);
  const status = await getStatus(handle);

  if (opts.json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  if (!status.exists) {
    ui.info(`No environment for ${ui.bold(handle.featureName)}.`);
    if (!hasEnvHooks(handle)) {
      ui.hint('No env hooks found (.ccw/hooks/env-start). See README "Isolated environments".');
    } else {
      ui.hint(`Run ${ui.bold('ccw env start')} to start it.`);
    }
    return;
  }

  const phaseColor =
    status.phase === 'running' ? ui.green : status.phase === 'failed' ? ui.red : ui.yellow;
  ui.heading(`Environment for ${handle.featureName}`);
  console.log(`  phase     ${phaseColor(status.phase)}`);
  console.log(`  ready     ${status.ready === undefined ? ui.dim('unknown') : status.ready ? ui.green('yes') : ui.yellow('not yet')}`);
  console.log(`  sessions  ${status.attachedSessions}`);
  if (status.slot !== undefined) console.log(`  slot      ${status.slot}`);
  console.log(`  log       ${ui.dim(status.logFile)}`);
  const services = (status.hookStatus as { services?: Array<{ name?: string; url?: string; status?: string }> })
    ?.services;
  if (Array.isArray(services)) {
    for (const svc of services) {
      console.log(`  service   ${svc.name ?? '?'} ${svc.url ? ui.cyan(svc.url) : ''} ${svc.status ? ui.dim(svc.status) : ''}`);
    }
  }
  for (const w of status.warnings) ui.warn(w);
  if (status.phase === 'failed') {
    ui.hint(`Check ${ui.bold('ccw env logs')} and retry with ${ui.bold('ccw env restart')}.`);
  }
}

export async function runEnvLogs(
  featureName: string | undefined,
  opts: { lines?: string; follow?: boolean },
): Promise<void> {
  const { handle } = resolveHandle(featureName);
  if (!existsSync(handle.paths.logFile)) {
    ui.info('No environment log yet.');
    return;
  }
  const count = Number(opts.lines ?? '50') || 50;
  if (opts.follow) {
    // tail -f owns the terminal until Ctrl+C; fine — this is interactive use.
    spawnSync('tail', ['-n', String(count), '-f', handle.paths.logFile], { stdio: 'inherit' });
    return;
  }
  const lines = readFileSync(handle.paths.logFile, 'utf-8').split('\n');
  console.log(lines.slice(Math.max(0, lines.length - count - 1)).join('\n'));
}

export async function runEnvStart(featureName: string | undefined): Promise<void> {
  const { handle } = resolveHandle(featureName);
  if (!hasEnvHooks(handle)) {
    ui.error('No env hooks for this repo (.ccw/hooks/env-start).');
    process.exit(1);
  }
  const setup = await runSetup(handle);
  if (setup.warning) ui.warn(setup.warning);
  if (!setup.ok) process.exit(1);
  const result = await startEnvironment(handle);
  if (result.warning) ui.warn(result.warning);
  if (result.alreadyRunning) {
    ui.info('Environment already running.');
    return;
  }
  if (result.started) {
    ui.success(`Environment starting. Check with ${ui.bold('ccw env status')}.`);
  }
}

export async function runEnvStop(featureName: string | undefined): Promise<void> {
  const { handle } = resolveHandle(featureName);
  await stopEnvironment(handle);
  ui.success('Environment stopped.');
}

export async function runEnvRestart(featureName: string | undefined): Promise<void> {
  const { handle } = resolveHandle(featureName);
  await stopEnvironment(handle);
  const result = await startEnvironment(handle);
  if (result.warning) ui.warn(result.warning);
  if (result.started) ui.success(`Environment restarting. Check with ${ui.bold('ccw env status')}.`);
  else ui.warn('Nothing started — is there an env-start hook?');
}
```

- [ ] **Step 4: Register in src/index.ts (after the `update` command block)**

```ts
// add import at top:
import { runEnvLogs, runEnvRestart, runEnvStart, runEnvStatus, runEnvStop } from './commands/env.ts';

// after the update command registration:
  const env = program
    .command('env')
    .description('Manage the isolated dev environment for a worktree (see README "Isolated environments")');
  env
    .command('status [feature-name]')
    .description('Show environment state (auto-detects worktree from cwd)')
    .option('--json', 'Machine-readable output')
    .action(async (featureName: string | undefined, opts: { json?: boolean }) => {
      await runEnvStatus(featureName, opts);
    });
  env
    .command('logs [feature-name]')
    .description('Print the environment log')
    .option('-n, --lines <count>', 'Number of lines to show', '50')
    .option('-f, --follow', 'Follow the log (tail -f)')
    .action(async (featureName: string | undefined, opts: { lines?: string; follow?: boolean }) => {
      await runEnvLogs(featureName, opts);
    });
  env
    .command('start [feature-name]')
    .description('Start the environment (runs setup first if needed)')
    .action(async (featureName: string | undefined) => {
      await runEnvStart(featureName);
    });
  env
    .command('stop [feature-name]')
    .description('Stop the environment')
    .action(async (featureName: string | undefined) => {
      await runEnvStop(featureName);
    });
  env
    .command('restart [feature-name]')
    .description('Restart the environment')
    .action(async (featureName: string | undefined) => {
      await runEnvRestart(featureName);
    });
```

- [ ] **Step 5: Smoke-test the CLI manually**

```bash
bun run src/index.ts env --help          # shows the five subcommands
cd /tmp && bun run --cwd <repo> src/index.ts env status   # in a non-worktree dir: "Not inside a ccw worktree."
```
Expected: help renders; status outside a worktree errors with the usage hint, exit 1.

- [ ] **Step 6: Typecheck, full tests, commit**

```bash
bun run typecheck && npx vitest run
git add src/commands/env.ts src/index.ts src/lib/reserved.ts tests/reserved.test.ts
git commit -m "feat(env): ccw env status/logs/start/stop/restart commands"
```

---

### Task 11: Create/resume integration

**Files:**
- Modify: `src/commands/create.ts`
- Modify: `src/commands/ls.ts` (picker delegates to `runCreate`)

**Interfaces:**
- Consumes: lifecycle API, `buildEnvironmentSystemPrompt`, `combineSystemPrompts`, `withSpinner`.
- Produces: env-aware `runCreate` (the only Claude-launch path for worktrees).

- [ ] **Step 1: Rewrite src/commands/create.ts**

Replace the file body with (diff-level description, full code below): collect prompt sections into an array; add env setup/start before `launchClaude`; attach before / detach after; single `--append-system-prompt`.

```ts
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
  if (envRunning) await detachSession(env, sessionId);
  process.exit(exitCode);
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
    if (envRunning) await detachSession(env, existingSessionId);
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
  if (envRunning) await detachSession(env, sessionId);
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
```

Note the argv ordering in `runCreate`: the positional "Analyze the task..." prompt is Claude's initial user prompt and must come after every flag, so it is appended last via `initialPrompt` (never pushed early — a detected-but-failed task fetch must not leave flags after a positional).

Resume + `--append-system-prompt`: the resumed branch intentionally does NOT pass a system prompt (unchanged from today) because `--resume` + `--append-system-prompt` compatibility is unverified. The env section still reaches resumed sessions via the fresh-session path and `ccw env --help` discoverability. If you verify `claude --resume` accepts `--append-system-prompt` (check `claude --help`), add it to the resume branch the same way — this is the one approved deviation spot (spec §3 caveat).

- [ ] **Step 2: Update the picker to delegate resume through runCreate (src/commands/ls.ts)**

In `pickAndLaunch`, replace everything after `if (!selected) { ... return; }` with:

```ts
  const { runCreate } = await import('./create.ts');
  await runCreate(selected);
```

Delete the now-unused imports in ls.ts (`launchClaude`, `getSession` if unused elsewhere in the file — `getSession` is still used by `renderWorktree`, keep it; remove `launchClaude` and the `join` usage if orphaned). The dynamic import avoids a static cycle (`create.ts` does not import `ls.ts`, so a static import would also work — prefer static if eslint allows: `import { runCreate } from './create.ts';`).

- [ ] **Step 3: Manually verify the create flow end-to-end with a scratch repo**

```bash
cd $(mktemp -d) && git init -b main scratch && cd scratch && git commit --allow-empty -m init
mkdir -p .ccw/hooks
printf '#!/bin/sh\necho "hello from setup"\n' > .ccw/hooks/env-setup
printf '#!/bin/sh\necho "Listening on 3000"; sleep 300\n' > .ccw/hooks/env-start
chmod +x .ccw/hooks/*
git add .ccw && git commit -m hooks
CCW_DATA_DIR=$(mktemp -d) bun run --cwd <ccw-repo-path> src/index.ts init   # accept defaults
# then: ccw test-feature → observe "Environment starting in background", quit Claude immediately,
# observe the sleep process is gone afterwards (ps aux | grep sleep).
```
Expected: setup spinner runs, env starts, Claude launches; on Claude exit the sleep process group is killed.

- [ ] **Step 4: Typecheck, full tests, commit**

```bash
bun run typecheck && npx vitest run
git add src/commands/create.ts src/commands/ls.ts
git commit -m "feat(env): start environments on create/resume, teardown on last session exit"
```

---

### Task 12: `ccw rm` teardown + `ccw ls` env badge

**Files:**
- Modify: `src/commands/rm.ts`
- Modify: `src/commands/ls.ts`

**Interfaces:**
- Consumes: `removeEnvironment`, `createEnvHandle`, `envPaths`, `readState`, `isPidAlive`.

- [ ] **Step 1: rm — teardown before worktree removal**

In `src/commands/rm.ts`, add imports:

```ts
import { createEnvHandle, removeEnvironment } from '../lib/env/lifecycle.ts';
```

In `removeOne`, inside the `withSpinner` callback, BEFORE `removeWorktree(...)`:

```ts
      await removeEnvironment(createEnvHandle(cfg, featureName, worktreePath));
```

In `pickAndRemove`'s loop, same line before its `removeWorktree(...)` call (using `name` and `path`):

```ts
          await removeEnvironment(createEnvHandle(cfg, name, path));
```

- [ ] **Step 2: ls — cheap env badge (PID liveness only, no hooks, no prune)**

In `src/commands/ls.ts` add imports:

```ts
import { envPaths } from '../lib/env/paths.ts';
import { isPidAlive, readState } from '../lib/env/state.ts';
```

In `renderWorktree`, after the session row is pushed:

```ts
  const envState = readState(envPaths(cfg.repoConfigPath, name));
  if (envState) {
    const alive = envState.pid !== undefined && isPidAlive(envState.pid);
    rows.push({ label: 'env', value: alive ? ui.green('● running') : ui.dim('○ stopped') });
  }
```

(`rm.ts` has its own identical `renderWorktree` — add the same rows there so the remove picker shows env state too.)

- [ ] **Step 3: Manually verify**

Using the Task 11 scratch repo: `ccw env start test-feature`, then `ccw ls --pipe` shows `env ● running`; `ccw rm test-feature` kills the process and removes the env dir (`ls ~/.ccw-data.../repos/*/env/` empty).

- [ ] **Step 4: Typecheck, full tests, commit**

```bash
bun run typecheck && npx vitest run
git add src/commands/rm.ts src/commands/ls.ts
git commit -m "feat(env): teardown on rm and env badge in ls/rm pickers"
```

---

### Task 13: Documentation + dermose_care dogfood

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add an "Isolated environments" section to README.md** (after the Configuration section), documenting: the four hooks with a table, discovery order (`.ccw/hooks/` then `~/.ccw/repos/<encoded>/hooks/`), the five `CCW_*` env vars including what `CCW_WORKTREE_SLOT` is for (ports, emulator pools, compose project names), the `environment.ready_pattern` config key, the `ccw env` subcommands table, and lifecycle semantics (background start, last-session-out teardown, `ccw rm` teardown). Include a complete worked example:

````markdown
## Isolated environments

Give ccw hook scripts and every worktree gets its own running dev environment:
started in the background when you open the worktree, visible to Claude
(`ccw env status`), and torn down when your last session exits.

```
your-repo/.ccw/hooks/
  env-setup    # once per worktree: copy .env, install deps (blocking)
  env-start    # start the environment (foreground process or self-daemonizing)
  env-stop     # graceful teardown (optional if env-start runs in the foreground)
  env-status   # print JSON state: {"ready": true, "services": [...]} (optional)
```

Hooks receive: `CCW_WORKTREE_PATH`, `CCW_WORKTREE_NAME`, `CCW_GIT_ROOT`,
`CCW_ENV_DIR` (scratch dir), and `CCW_WORKTREE_SLOT` — a stable small integer
unique per worktree. Use the slot to avoid collisions between parallel
worktrees: ports (`$((3000 + CCW_WORKTREE_SLOT))`), emulator pools,
`COMPOSE_PROJECT_NAME=app-$CCW_WORKTREE_SLOT`, scratch database names.

Example `env-start` for a web app:

```sh
#!/bin/sh
cp "$CCW_GIT_ROOT/.env" .env 2>/dev/null || true
PORT=$((3000 + CCW_WORKTREE_SLOT)) exec bin/dev
```

| Command           | Description                                    |
| ----------------- | ---------------------------------------------- |
| `ccw env status`  | State, readiness, services (`--json` for CI)   |
| `ccw env logs`    | Environment log (`-f` to follow)               |
| `ccw env start`   | Start (runs setup first if needed)             |
| `ccw env stop`    | Stop now                                       |
| `ccw env restart` | The "I broke it" recovery loop                 |

Can't commit files to the repo? Put the same hooks in
`~/.ccw/repos/<encoded-git-root>/hooks/` instead — in-tree wins when both exist.
Optional: set `environment.ready_pattern` in the repo config to a regex that,
when it appears in the log, marks the environment ready.
````

- [ ] **Step 2: Dogfood on dermose_care (manual validation — the spec's acceptance test)**

In the dermose_care repo: write `.ccw/hooks/env-setup` + `env-start` against its existing parallel-branch dev tooling, then run the full loop with the dev build of ccw:

1. `ccw <some-feature>` → setup spinner, "Environment starting in background", Claude launches.
2. Inside Claude: `ccw env status --json` shows ready after boot; `ccw env logs` shows server output; the app responds on the slot-derived port.
3. Quit Claude → environment process gone (`ps`).
4. `ccw <same-feature>` again → environment restarts, session resumes.
5. `ccw rm <feature>` → worktree, env dir, and processes all gone.

Record any contract friction found here as follow-up issues before closing out the feature.

- [ ] **Step 3: Final full check and commit**

```bash
bun run typecheck && bun run lint && npx vitest run && bun test tests/bun/
git add README.md
git commit -m "docs(env): isolated environments hook guide"
```

---

## Task order & dependencies

Tasks 1→2→3 are foundations (2 depends on 1; 3 independent of 2). Task 4 independent. Tasks 5→6→7→8 build lifecycle in strict order. Task 9 independent after 4. Task 10 needs 8+9. Task 11 needs 8+9+10 (uses `ccw env` in printed hints). Task 12 needs 8. Task 13 last.
