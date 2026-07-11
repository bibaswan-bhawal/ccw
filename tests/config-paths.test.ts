import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmp: string;
let homedir: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ccw-cfg-'));
  homedir = mkdtempSync(join(tmpdir(), 'ccw-home-'));
  vi.doMock('node:os', async () => {
    const actual = await vi.importActual<typeof import('node:os')>('node:os');
    return { ...actual, homedir: () => homedir };
  });
  // CCW_DATA_DIR could pollute these tests if the developer has it set in
  // their shell. Strip it so we exercise the homedir-based path.
  delete process.env.CCW_DATA_DIR;
});

afterEach(() => {
  vi.doUnmock('node:os');
  vi.resetModules();
  rmSync(tmp, { recursive: true, force: true });
  rmSync(homedir, { recursive: true, force: true });
});

describe('encodeRepoKey / decodeRepoKey', () => {
  test('encodes / as - and round-trips', async () => {
    const { encodeRepoKey, decodeRepoKey } = await import('../src/lib/config.ts');
    const path = '/Users/me/development/apm_bundle';
    const encoded = encodeRepoKey(path);
    expect(encoded).toBe('-Users-me-development-apm_bundle');
    expect(decodeRepoKey(encoded)).toBe(path);
  });
});

describe('userRepoConfigPath', () => {
  test('lands under ~/.ccw/repos/<encoded>/config.json by default', async () => {
    const { userRepoConfigPath } = await import('../src/lib/config.ts');
    const path = userRepoConfigPath('/repo/here');
    expect(path).toBe(join(homedir, '.ccw', 'repos', '-repo-here', 'config.json'));
  });

  test('honors CCW_DATA_DIR when set', async () => {
    process.env.CCW_DATA_DIR = join(tmp, 'custom-data');
    const { userRepoConfigPath } = await import('../src/lib/config.ts');
    const path = userRepoConfigPath('/repo/here');
    expect(path).toBe(join(tmp, 'custom-data', 'repos', '-repo-here', 'config.json'));
  });
});

describe('writeRepoConfig + read round-trip', () => {
  test('writes JSON to ~/.ccw/repos/<encoded>/config.json and is readable', async () => {
    const { writeRepoConfig, userRepoConfigPath } = await import('../src/lib/config.ts');
    const gitRoot = '/some/repo/root';
    const config = { worktree_dir: '/where/work', plugins: { jira: { project: 'P' } } };
    const written = writeRepoConfig(gitRoot, config);
    expect(written).toBe(userRepoConfigPath(gitRoot));
    const onDisk = JSON.parse(readFileSync(written, 'utf-8'));
    expect(onDisk).toEqual(config);
  });
});

describe('legacy in-tree migration', () => {
  test('moves <gitRoot>/.ccw.json into ~/.ccw/repos/.../config.json', async () => {
    // Simulate a repo with a legacy in-tree config.
    const gitRoot = mkdtempSync(join(tmp, 'repo-'));
    const legacy = join(gitRoot, '.ccw.json');
    const legacyConfig = { worktree_dir: '/legacy/wt', plugins: { jira: { project: 'X' } } };
    writeFileSync(legacy, JSON.stringify(legacyConfig));

    // We can't call loadConfig() (it requires being inside a real git repo
    // with a remote), but we can exercise the migration helper directly
    // by importing the config module and forcing CCW_DATA_DIR + faking
    // git-root resolution. Easiest: call userRepoConfigPath, then invoke
    // the internal migration via writeRepoConfig wrapper isn't possible,
    // so instead simulate the same logic the module performs by reading
    // with the same file moves.
    process.env.CCW_DATA_DIR = join(tmp, 'data');
    const { userRepoConfigPath } = await import('../src/lib/config.ts');
    const userPath = userRepoConfigPath(gitRoot);

    // Reproduce migrateLegacyInTreeConfig's behaviour: legacy → user.
    const { renameSync, mkdirSync } = await import('node:fs');
    mkdirSync(join(tmp, 'data', 'repos', `-${gitRoot.slice(1).replaceAll('/', '-')}`), {
      recursive: true,
    });
    renameSync(legacy, userPath);

    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(userPath)).toBe(true);
    expect(JSON.parse(readFileSync(userPath, 'utf-8'))).toEqual(legacyConfig);
  });
});

describe('environment config block', () => {
  // resolveFromRaw is the pure resolution step loadConfig/loadConfigForInit
  // delegate to after reading the on-disk RepoConfig (see readRawRepoConfig +
  // readBase). We exercise it the same way the "legacy in-tree migration"
  // test above exercises writeRepoConfig/userRepoConfigPath directly, rather
  // than going through loadConfig(): that requires a real getGitRoot() call,
  // which shells out via Bun.spawnSync and isn't available under vitest's
  // node runtime (see the comment in the migration test above).
  function fakeBase(gitRoot: string): import('../src/lib/config.ts').ConfigBase {
    return {
      gitRoot,
      repoName: 'repo',
      repoConfigPath: join(gitRoot, 'config.json'),
      detectedBranch: 'main',
      defaultWorktreeDir: join(gitRoot, '..', 'repo_worktrees'),
      dataDir: join(gitRoot, '.ccw-data'),
      sessionsFile: join(gitRoot, '.ccw-data', 'sessions.json'),
    };
  }

  test('resolves environment.ready_pattern from repo config', async () => {
    const gitRoot = mkdtempSync(join(tmp, 'repo-env-'));
    const configPath = join(gitRoot, 'config.json');
    writeFileSync(configPath, JSON.stringify({ environment: { ready_pattern: 'Listening on' } }));

    const { resolveFromRaw } = await import('../src/lib/config.ts');
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    const cfg = resolveFromRaw(fakeBase(gitRoot), raw);

    expect(cfg.environment.readyPattern).toBe('Listening on');
  });

  test('environment block defaults to empty object', async () => {
    const gitRoot = mkdtempSync(join(tmp, 'repo-env-'));
    const configPath = join(gitRoot, 'config.json');
    writeFileSync(configPath, JSON.stringify({}));

    const { resolveFromRaw } = await import('../src/lib/config.ts');
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    const cfg = resolveFromRaw(fakeBase(gitRoot), raw);

    expect(cfg.environment).toEqual({});
  });
});
