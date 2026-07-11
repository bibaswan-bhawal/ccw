import { accessSync, constants, statSync } from 'node:fs';
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
    let stat;
    try {
      stat = statSync(candidate.path);
    } catch {
      continue;
    }
    // A directory happens to pass X_OK (traversable), so it must be
    // rejected explicitly here or it would be reported as an "executable"
    // hook and then fail to spawn.
    if (!stat.isFile()) continue;
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
