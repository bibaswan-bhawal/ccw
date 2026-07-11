import { describe, expect, test } from 'vitest';
import type { ResolvedConfig } from '../src/lib/config.ts';
import { createPluginHost } from '../src/lib/plugin-host.ts';

function buildConfig(pluginConfigs: Record<string, unknown>): ResolvedConfig {
  return {
    gitRoot: '/tmp/repo',
    repoName: 'repo',
    worktreeDir: '/tmp/repo_worktrees',
    appSubdir: '',
    baseBranch: 'main',
    pluginConfigs,
    dataDir: '/tmp/.ccw',
    sessionsFile: '/tmp/.ccw/sessions.json',
    repoConfigPath: '/tmp/repo/.ccw.json',
    environment: {},
  };
}

describe('createPluginHost', () => {
  test('loads built-in jira plugin when configured', () => {
    const host = createPluginHost(buildConfig({ jira: { project: 'AHDOC' } }));
    expect(host.active).toHaveLength(1);
    expect(host.active[0]?.plugin.name).toBe('jira');
  });

  test("ignores configs for plugins that don't exist", () => {
    const host = createPluginHost(buildConfig({ jira: {}, fictional: {} }));
    expect(host.active.map((a) => a.plugin.name)).toEqual(['jira']);
  });

  test('active list is empty when nothing is enabled', () => {
    const host = createPluginHost(buildConfig({}));
    expect(host.active).toHaveLength(0);
  });

  test('detectTask returns the matching plugin', () => {
    const host = createPluginHost(buildConfig({ jira: { project: 'AHDOC' } }));
    const detected = host.detectTask('AHDOC-123-feature');
    expect(detected?.plugin.plugin.name).toBe('jira');
    expect(detected?.key).toBe('AHDOC-123');
  });

  test('detectTask returns undefined when no provider matches', () => {
    const host = createPluginHost(buildConfig({ jira: { project: 'AHDOC' } }));
    expect(host.detectTask('hackday-spring-2026')).toBeUndefined();
  });

  test('badgeForStoredTask builds a Jira URL from cached id', () => {
    const host = createPluginHost(
      buildConfig({ jira: { base_url: 'https://example.atlassian.net', project: 'AHDOC' } }),
    );
    const badge = host.badgeForStoredTask('AHDOC-123', 'jira');
    expect(badge?.label).toBe('AHDOC-123');
    expect(badge?.url).toBe('https://example.atlassian.net/browse/AHDOC-123');
  });

  test('badgeForStoredTask returns undefined for an inactive provider', () => {
    const host = createPluginHost(buildConfig({}));
    expect(host.badgeForStoredTask('AHDOC-123', 'jira')).toBeUndefined();
  });

  test('findActive returns the plugin when present', () => {
    const host = createPluginHost(buildConfig({ jira: {} }));
    expect(host.findActive('jira')?.plugin.name).toBe('jira');
    expect(host.findActive('nonexistent')).toBeUndefined();
  });
});
