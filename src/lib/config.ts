import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { getGitRoot, getDefaultBranch } from './git.ts';

/**
 * On-disk shape of the per-repo config file (lives at
 * ~/.ccw/repos/<encoded-git-root>/config.json).
 *
 * Earlier versions of ccw stored this file at <gitroot>/.ccw.json. That
 * caused friction in shared monorepos where touching the working tree
 * is unwelcome. The legacy in-tree file is auto-migrated on first read
 * and removed; the new shape lives entirely under ~/.ccw.
 */
export interface RepoConfig {
  worktree_dir?: string;
  app_subdir?: string;
  base_branch?: string;
  /** Per-plugin config keyed by plugin name (e.g. "jira"). */
  plugins?: Record<string, unknown>;

  // --- legacy ---
  jira_base_url?: string;
  jira_project?: string;
  jira_board_id?: string;

  /** Optional environment settings for worktree env hooks. */
  environment?: {
    /** Substring/regex matched against env.log to decide readiness. */
    ready_pattern?: string;
  };
}

export interface ResolvedConfig {
  gitRoot: string;
  repoName: string;
  worktreeDir: string;
  appSubdir: string;
  baseBranch: string;
  /** Per-plugin config map (already migrated from legacy fields if needed). */
  pluginConfigs: Record<string, unknown>;
  dataDir: string;
  sessionsFile: string;
  /** Path of the active per-repo config file under ~/.ccw/repos/<encoded>/config.json */
  repoConfigPath: string;
  /** Resolved environment settings for worktree env hooks (empty when unset). */
  environment: { readyPattern?: string };
}

/**
 * Thrown when commands that require config are run in a repo that hasn't
 * been initialised. The top-level handler in index.ts formats this as a
 * "run ccw init" message rather than a stack trace.
 */
export class ConfigMissingError extends Error {
  readonly repoConfigPath: string;
  constructor(repoConfigPath: string) {
    super(`This repository is not configured for ccw (no ${repoConfigPath}).`);
    this.repoConfigPath = repoConfigPath;
    this.name = 'ConfigMissingError';
  }
}

// --- Path encoding -----------------------------------------------------------

/**
 * Encode an absolute path into a single safe directory name. We replace
 * directory separators with `-` and prefix with `-` so the leading `/`
 * survives the round-trip. Stable, reversible, and human-readable when
 * browsing ~/.ccw/repos/.
 */
export function encodeRepoKey(absolutePath: string): string {
  return absolutePath.replaceAll('/', '-');
}

export function decodeRepoKey(encoded: string): string {
  return encoded.replaceAll('-', '/');
}

function ccwDataDir(): string {
  return process.env.CCW_DATA_DIR && process.env.CCW_DATA_DIR.length > 0
    ? process.env.CCW_DATA_DIR
    : join(homedir(), '.ccw');
}

export function userRepoConfigPath(gitRoot: string): string {
  return join(ccwDataDir(), 'repos', encodeRepoKey(gitRoot), 'config.json');
}

// --- Read / migrate ---------------------------------------------------------

function readRawRepoConfig(repoConfigPath: string): RepoConfig | undefined {
  if (!existsSync(repoConfigPath)) return undefined;
  try {
    return JSON.parse(readFileSync(repoConfigPath, 'utf-8')) as RepoConfig;
  } catch {
    return {};
  }
}

/**
 * If a legacy in-tree `.ccw.json` exists, copy it to the user-level
 * location and remove the original. Idempotent: if the user-level file
 * already exists we just delete the legacy one (the user-level wins).
 *
 * Returns true if a migration happened so the caller can surface a one-time
 * notice.
 */
function migrateLegacyInTreeConfig(gitRoot: string, userConfigPath: string): boolean {
  const legacyPath = join(gitRoot, '.ccw.json');
  if (!existsSync(legacyPath)) return false;

  mkdirSync(dirname(userConfigPath), { recursive: true });
  if (!existsSync(userConfigPath)) {
    try {
      renameSync(legacyPath, userConfigPath);
    } catch {
      // Cross-device renames or perms — fall back to copy + unlink.
      writeFileSync(userConfigPath, readFileSync(legacyPath, 'utf-8'));
      try {
        unlinkSync(legacyPath);
      } catch {
        // Couldn't remove; user can clean up manually.
      }
    }
  } else {
    try {
      unlinkSync(legacyPath);
    } catch {
      // Best effort — same as above.
    }
  }
  return true;
}

// --- Plugin config resolution -----------------------------------------------

function resolvePluginConfigs(raw: RepoConfig): Record<string, unknown> {
  if (raw.plugins) return { ...raw.plugins };

  const hasLegacy =
    raw.jira_base_url !== undefined || raw.jira_project !== undefined || raw.jira_board_id !== undefined;

  if (hasLegacy) {
    return {
      jira: {
        ...(raw.jira_base_url !== undefined ? { base_url: raw.jira_base_url } : {}),
        ...(raw.jira_project !== undefined ? { project: raw.jira_project } : {}),
        ...(raw.jira_board_id !== undefined ? { board_id: raw.jira_board_id } : {}),
      },
    };
  }

  return {};
}

function pick<T extends string>(envVal: string | undefined, configVal: T | undefined, fallback: T): T {
  if (envVal !== undefined && envVal !== '') return envVal as T;
  if (configVal !== undefined && configVal !== '') return configVal;
  return fallback;
}

// --- Loaders ----------------------------------------------------------------

export interface LoadResult {
  config: ResolvedConfig;
  /** True when this call moved a legacy in-tree .ccw.json into ~/.ccw. */
  migratedFromInTree: boolean;
}

/**
 * Load resolved config for a configured repo. Throws ConfigMissingError when
 * the user-level config file (and any legacy in-tree fallback) is absent.
 */
export function loadConfig(): ResolvedConfig {
  const { config, migratedFromInTree } = loadConfigInternal();
  void migratedFromInTree;
  return config;
}

/**
 * Like loadConfig() but also reports whether a migration just happened, so
 * callers can print a one-time notice.
 */
export function loadConfigWithMigration(): LoadResult {
  return loadConfigInternal();
}

/**
 * Load config for `ccw init`. Never throws on missing config — init is the
 * command that creates it. Still triggers legacy in-tree migration so the
 * user gets a clean slate.
 */
export function loadConfigForInit(): ResolvedConfig {
  const { base, raw, migratedFromInTree } = readBase({ throwOnMissing: false });
  void migratedFromInTree;
  return resolveFromRaw(base, raw ?? {});
}

export interface ConfigBase {
  gitRoot: string;
  repoName: string;
  repoConfigPath: string;
  detectedBranch: string;
  defaultWorktreeDir: string;
  dataDir: string;
  sessionsFile: string;
}

interface BaseRead {
  base: ConfigBase;
  raw: RepoConfig | undefined;
  migratedFromInTree: boolean;
}

function readBase(opts: { throwOnMissing: boolean }): BaseRead {
  const gitRoot = getGitRoot();
  const repoName = basename(gitRoot);
  const repoConfigPath = userRepoConfigPath(gitRoot);

  const migratedFromInTree = migrateLegacyInTreeConfig(gitRoot, repoConfigPath);
  const raw = readRawRepoConfig(repoConfigPath);
  if (raw === undefined && opts.throwOnMissing) {
    throw new ConfigMissingError(repoConfigPath);
  }

  const dataDir = ccwDataDir();
  const sessionsFile = join(dataDir, 'sessions.json');
  const detectedBranch = getDefaultBranch(gitRoot) ?? 'main';
  const defaultWorktreeDir = join(dirname(gitRoot), `${repoName}_worktrees`);

  return {
    raw,
    migratedFromInTree,
    base: {
      gitRoot,
      repoName,
      repoConfigPath,
      detectedBranch,
      defaultWorktreeDir,
      dataDir,
      sessionsFile,
    },
  };
}

function loadConfigInternal(): LoadResult {
  const { base, raw, migratedFromInTree } = readBase({ throwOnMissing: true });
  // raw is guaranteed defined when throwOnMissing: true and we reach here.
  return { config: resolveFromRaw(base, raw!), migratedFromInTree };
}

export function resolveFromRaw(base: ConfigBase, raw: RepoConfig): ResolvedConfig {
  return {
    gitRoot: base.gitRoot,
    repoName: base.repoName,
    worktreeDir: pick(process.env.CCW_WORKTREE_DIR, raw.worktree_dir, base.defaultWorktreeDir),
    appSubdir: pick(process.env.CCW_APP_SUBDIR, raw.app_subdir, ''),
    baseBranch: pick(process.env.CCW_BASE_BRANCH, raw.base_branch, base.detectedBranch),
    pluginConfigs: resolvePluginConfigs(raw),
    dataDir: base.dataDir,
    sessionsFile: base.sessionsFile,
    repoConfigPath: base.repoConfigPath,
    environment: raw.environment?.ready_pattern ? { readyPattern: raw.environment.ready_pattern } : {},
  };
}

// --- Writer -----------------------------------------------------------------

/**
 * Write the per-repo config to ~/.ccw/repos/<encoded>/config.json. Ensures
 * the directory exists. Used by `ccw init`.
 */
export function writeRepoConfig(gitRoot: string, config: RepoConfig): string {
  const path = userRepoConfigPath(gitRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n');
  return path;
}
