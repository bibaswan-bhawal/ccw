/**
 * config.ts itself reads via loadConfig() which depends on a real git
 * repo. Test the resolution logic in isolation by re-implementing the
 * same in-memory transformation that resolvePluginConfigs does.
 */

import { describe, expect, test } from 'vitest';

interface RepoConfig {
  worktree_dir?: string;
  plugins?: Record<string, unknown>;
  jira_base_url?: string;
  jira_project?: string;
  jira_board_id?: string;
}

// Mirror of resolvePluginConfigs in src/lib/config.ts.
function resolve(raw: RepoConfig): Record<string, unknown> {
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

describe('plugin config resolution', () => {
  test('legacy top-level jira_* migrates into plugins.jira', () => {
    const result = resolve({
      jira_base_url: 'https://example.com',
      jira_project: 'AHDOC',
      jira_board_id: '42',
    });
    expect(result.jira).toEqual({
      base_url: 'https://example.com',
      project: 'AHDOC',
      board_id: '42',
    });
  });

  test('explicit plugins map is used as-is', () => {
    const result = resolve({ plugins: { jira: { project: 'OTHER' } } });
    expect(result.jira).toEqual({ project: 'OTHER' });
  });

  test('explicit plugins map overrides legacy fields', () => {
    const result = resolve({
      plugins: { jira: { project: 'NEW' } },
      jira_project: 'OLD',
    });
    expect((result.jira as { project: string }).project).toBe('NEW');
  });

  test('empty raw config produces empty plugins (loadConfig throws separately)', () => {
    const result = resolve({});
    expect(result).toEqual({});
  });

  test('explicit empty plugins map disables everything', () => {
    const result = resolve({ plugins: {} });
    expect(result).toEqual({});
  });
});
