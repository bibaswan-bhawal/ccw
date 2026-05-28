import { describe, expect, test } from 'vitest';
import { extractJiraKey, formatJiraIssue, type JiraIssue } from '../src/plugins/jira/api.ts';
import { adfToText } from '../src/plugins/jira/adf.ts';

function baseIssue(overrides: Partial<JiraIssue> = {}): JiraIssue {
  return {
    key: 'PROJ-1',
    url: 'https://jira/PROJ-1',
    summary: 'Do the thing',
    status: 'In Progress',
    issueType: 'Task',
    priority: 'High',
    assignee: 'Jane Doe',
    reporter: 'Alice Reporter',
    labels: [],
    fields: {},
    comments: [],
    subtasks: [],
    links: [],
    ...overrides,
  };
}

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
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'first' }] }] },
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'second' }] }] },
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

describe('formatJiraIssue header', () => {
  test('renders all scalar fields with bold labels', () => {
    const out = formatJiraIssue(
      baseIssue({
        labels: ['backend', 'urgent'],
      }),
    );
    expect(out).toContain('# Jira Ticket: PROJ-1');
    expect(out).toContain('**Summary**: Do the thing');
    expect(out).toContain('**Type**: Task');
    expect(out).toContain('**Status**: In Progress');
    expect(out).toContain('**Priority**: High');
    expect(out).toContain('**Assignee**: Jane Doe');
    expect(out).toContain('**Reporter**: Alice Reporter');
    expect(out).toContain('**Labels**: backend, urgent');
    expect(out).toContain('**URL**: https://jira/PROJ-1');
  });

  test('renders empty labels as "none"', () => {
    const out = formatJiraIssue(baseIssue({ labels: [] }));
    expect(out).toContain('**Labels**: none');
  });
});

describe('formatJiraIssue description promotion', () => {
  test('promotes the classified field to "## Description" and skips its raw section', () => {
    const out = formatJiraIssue(
      baseIssue({
        fields: {
          'Bug Description': { id: 'customfield_99001', name: 'Bug Description', text: 'The login page crashes.' },
          'Steps to Reproduce': {
            id: 'customfield_99002',
            name: 'Steps to Reproduce',
            text: '1. Click login\n2. Crash',
          },
        },
      }),
      { descriptionField: 'Bug Description' },
    );

    expect(out).toContain('## Description\n\nThe login page crashes.');
    // The same content should NOT also appear under its raw name
    expect(out).not.toContain('## Bug Description');
    // Non-description fields still appear under their own headers
    expect(out).toContain('## Steps to Reproduce');
    expect(out).toContain('1. Click login');
  });

  test('omits the Description section when no field is classified', () => {
    const out = formatJiraIssue(
      baseIssue({
        fields: {
          'Steps to Reproduce': { id: 'customfield_99002', name: 'Steps to Reproduce', text: '1. Click' },
        },
      }),
    );
    expect(out).not.toContain('## Description');
    expect(out).toContain('## Steps to Reproduce');
  });

  test('skips promotion when the classified field is missing; real fields still render', () => {
    const out = formatJiraIssue(
      baseIssue({
        fields: { Description: { id: 'description', name: 'Description', text: 'ok' } },
      }),
      { descriptionField: 'Nonexistent Field' },
    );
    // The classified field doesn't exist on the ticket, so no promotion happens.
    // The "Description" field still appears under its own header — but only once
    // (no duplicate from the promotion path).
    const headerCount = (out.match(/^## Description$/gm) ?? []).length;
    expect(headerCount).toBe(1);
    expect(out).toContain('ok');
  });
});

describe('formatJiraIssue collections', () => {
  test('renders subtasks, links, comments', () => {
    const out = formatJiraIssue(
      baseIssue({
        subtasks: [{ key: 'PROJ-2', summary: 'Subtask one', status: 'Done' }],
        links: [{ type: 'blocks', key: 'OTHER-5', summary: 'Other thing', status: 'Open' }],
        comments: [{ author: 'Jane', date: '2026-01-01', body: 'Started work' }],
      }),
    );
    expect(out).toContain('## Subtasks');
    expect(out).toContain('- PROJ-2 — Subtask one (Done)');
    expect(out).toContain('## Linked Issues');
    expect(out).toContain('- blocks: OTHER-5 — Other thing (Open)');
    expect(out).toContain('## Recent Comments (last 1)');
    expect(out).toContain('**Jane — 2026-01-01**');
    expect(out).toContain('Started work');
  });

  test('omits empty collections', () => {
    const out = formatJiraIssue(baseIssue());
    expect(out).not.toContain('## Subtasks');
    expect(out).not.toContain('## Linked Issues');
    expect(out).not.toContain('## Recent Comments');
  });

  test('caps long field values with a truncation marker', () => {
    const longText = 'A'.repeat(5000);
    const out = formatJiraIssue(
      baseIssue({
        fields: { Description: { id: 'description', name: 'Description', text: longText } },
      }),
      { descriptionField: 'Description' },
    );
    expect(out).toContain('truncated — original was 5000 chars');
    expect(out.length).toBeLessThan(longText.length + 1000);
  });
});
