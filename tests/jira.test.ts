import { describe, expect, test } from 'vitest';
import { extractJiraKey } from '../src/plugins/jira/api.ts';
import { adfToText } from '../src/plugins/jira/adf.ts';
import { formatJiraIssue, type JiraIssue } from '../src/plugins/jira/api.ts';

describe('extractJiraKey (no project configured)', () => {
  test('matches uppercase ticket prefix', () => {
    expect(extractJiraKey('AHDOC-567-my-feature')).toBe('AHDOC-567');
  });

  test('extracts bare ticket key', () => {
    expect(extractJiraKey('PROJ-123')).toBe('PROJ-123');
  });

  test('ignores lowercase prefixes (would catch hyphenated branch names)', () => {
    expect(extractJiraKey('hackday-spring-2026-folio-party')).toBeUndefined();
    expect(extractJiraKey('ahdoc-567-stuff')).toBeUndefined();
  });

  test('returns undefined when no uppercase key present', () => {
    expect(extractJiraKey('just-a-feature-name')).toBeUndefined();
  });

  test('returns first key when multiple present', () => {
    expect(extractJiraKey('PROJ-1-linked-to-OTHER-2')).toBe('PROJ-1');
  });
});

describe('extractJiraKey (with project configured)', () => {
  test('matches the configured project (case-insensitive)', () => {
    expect(extractJiraKey('AHDOC-567-my-feature', 'AHDOC')).toBe('AHDOC-567');
    expect(extractJiraKey('ahdoc-567-stuff', 'AHDOC')).toBe('AHDOC-567');
  });

  test("ignores other projects' keys", () => {
    expect(extractJiraKey('hackday-spring-2026', 'AHDOC')).toBeUndefined();
    expect(extractJiraKey('OTHER-99-feature', 'AHDOC')).toBeUndefined();
  });

  test('returns undefined when no key present', () => {
    expect(extractJiraKey('just-a-feature-name', 'AHDOC')).toBeUndefined();
  });
});

describe('adfToText', () => {
  test('extracts plain text from a paragraph', () => {
    const adf = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Hello world' }],
        },
      ],
    };
    expect(adfToText(adf).trim()).toBe('Hello world');
  });

  test('converts bullet lists to markdown', () => {
    const adf = {
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'first' }] }],
            },
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'second' }] }],
            },
          ],
        },
      ],
    };
    const out = adfToText(adf);
    expect(out).toContain('- first');
    expect(out).toContain('- second');
  });

  test('handles null input', () => {
    expect(adfToText(null)).toBe('');
  });

  test('preserves blockCard urls', () => {
    const adf = { type: 'blockCard', attrs: { url: 'https://example.com' } };
    expect(adfToText(adf)).toBe('https://example.com');
  });
});

describe('formatJiraIssue', () => {
  test('produces markdown with all sections when populated', () => {
    const ctx: JiraIssue = {
      key: 'PROJ-1',
      summary: 'Do the thing',
      status: 'In Progress',
      issueType: 'Task',
      priority: 'High',
      assignee: 'Jane Doe',
      labels: ['backend', 'urgent'],
      url: 'https://jira/PROJ-1',
      description: 'The thing must be done.',
      acceptanceCriteria: '- Thing is done.',
      recentComments: '[Jane — 2026-01-01]: Started',
    };
    const out = formatJiraIssue(ctx);
    expect(out).toContain('# Jira Ticket: PROJ-1');
    expect(out).toContain('**Summary**: Do the thing');
    expect(out).toContain('**Labels**: backend, urgent');
    expect(out).toContain('## Description');
    expect(out).toContain('## Acceptance Criteria');
    expect(out).toContain('## Recent Comments');
  });

  test('omits empty sections', () => {
    const ctx: JiraIssue = {
      key: 'PROJ-1',
      summary: 'X',
      status: 'Open',
      issueType: 'Task',
      priority: 'Low',
      assignee: 'Unassigned',
      labels: [],
      url: 'https://jira/PROJ-1',
      description: 'desc',
      acceptanceCriteria: '',
      recentComments: '',
    };
    const out = formatJiraIssue(ctx);
    expect(out).not.toContain('## Acceptance Criteria');
    expect(out).not.toContain('## Recent Comments');
    expect(out).toContain('**Labels**: none');
  });
});
