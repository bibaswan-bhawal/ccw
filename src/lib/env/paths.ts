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
