import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildClassifierPrompt,
  cachePath,
  classifyDescriptionField,
  heuristicDescriptionField,
  parseClassifierResponse,
} from '../src/plugins/jira/classifier.ts';
import type { JiraIssue } from '../src/plugins/jira/api.ts';

function makeIssue(overrides: Partial<JiraIssue> = {}): JiraIssue {
  return {
    key: 'PROJ-1',
    url: 'https://jira/PROJ-1',
    summary: 'Login page crashes',
    status: 'Open',
    issueType: 'Bug',
    priority: 'High',
    assignee: 'Jane',
    reporter: 'Bob',
    labels: [],
    fields: {},
    comments: [],
    subtasks: [],
    links: [],
    ...overrides,
  };
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ccw-jira-cls-'));
  process.env.CCW_DATA_DIR = tmp;
});
afterEach(() => {
  delete process.env.CCW_DATA_DIR;
  rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('heuristicDescriptionField', () => {
  test('prefers standard `description` when it has content', () => {
    const issue = makeIssue({
      fields: {
        'Bug Description': { id: 'customfield_99001', name: 'Bug Description', text: 'custom content' },
        Description: { id: 'description', name: 'Description', text: 'standard content' },
      },
    });
    expect(heuristicDescriptionField(issue)).toBe('Description');
  });

  test('falls back to a field whose name contains "description"', () => {
    const issue = makeIssue({
      fields: {
        'Bug Description': { id: 'customfield_99001', name: 'Bug Description', text: 'real content' },
        'Steps to Reproduce': { id: 'customfield_99002', name: 'Steps to Reproduce', text: 'steps' },
      },
    });
    expect(heuristicDescriptionField(issue)).toBe('Bug Description');
  });

  test('returns undefined when nothing looks like a description', () => {
    const issue = makeIssue({
      fields: {
        'Steps to Reproduce': { id: 'customfield_99002', name: 'Steps to Reproduce', text: 'steps' },
      },
    });
    expect(heuristicDescriptionField(issue)).toBeUndefined();
  });

  test('ignores empty standard description in favor of a populated custom one', () => {
    const issue = makeIssue({
      fields: {
        // `description` exists but is empty — heuristic skips it (we never write empty fields anyway)
        'Bug Description': { id: 'customfield_99001', name: 'Bug Description', text: 'real bug content' },
      },
    });
    expect(heuristicDescriptionField(issue)).toBe('Bug Description');
  });
});

describe('parseClassifierResponse', () => {
  test('extracts field name from clean JSON output', () => {
    expect(parseClassifierResponse('{"description_field": "Bug Description"}')).toBe('Bug Description');
  });

  test('tolerates surrounding chatter', () => {
    const out =
      'Sure, here is the answer:\n\n{"description_field": "Description"}\n\nLet me know if you need anything else.';
    expect(parseClassifierResponse(out)).toBe('Description');
  });

  test('returns undefined when description_field is null', () => {
    expect(parseClassifierResponse('{"description_field": null}')).toBeUndefined();
  });

  test('returns undefined on malformed JSON', () => {
    expect(parseClassifierResponse('not json at all')).toBeUndefined();
    expect(parseClassifierResponse('{"description_field":')).toBeUndefined();
  });
});

describe('buildClassifierPrompt', () => {
  test('includes ticket type, summary, and field samples', () => {
    const issue = makeIssue({
      issueType: 'Bug',
      summary: 'X',
      fields: {
        'Bug Description': { id: 'customfield_99001', name: 'Bug Description', text: 'Login crashes when ...' },
      },
    });
    const prompt = buildClassifierPrompt(issue);
    expect(prompt).toContain('Ticket type: Bug');
    expect(prompt).toContain('Summary: X');
    expect(prompt).toContain('"Bug Description"');
    expect(prompt).toContain('Login crashes when');
  });

  test('caps each field sample to keep the prompt small', () => {
    const issue = makeIssue({
      fields: {
        Huge: { id: 'customfield_99001', name: 'Huge', text: 'A'.repeat(5000) },
      },
    });
    const prompt = buildClassifierPrompt(issue);
    // 200 chars cap per sample
    expect(prompt.match(/A+/g)?.[0].length).toBeLessThan(250);
  });
});

describe('classifyDescriptionField', () => {
  test('uses runner result when it picks a real field, then caches', () => {
    const issue = makeIssue({
      fields: {
        'Bug Description': { id: 'customfield_99001', name: 'Bug Description', text: 'crash' },
      },
    });
    const runner = vi.fn(() => '{"description_field": "Bug Description"}');

    const first = classifyDescriptionField(issue, { project: 'PROJ', runner });
    expect(first).toBe('Bug Description');
    expect(runner).toHaveBeenCalledTimes(1);

    // Cache file should now exist with the right shape
    expect(existsSync(cachePath())).toBe(true);
    const cache = JSON.parse(readFileSync(cachePath(), 'utf-8'));
    expect(cache.PROJ.Bug.description).toBe('Bug Description');

    // Second call hits cache, doesn't invoke runner
    const second = classifyDescriptionField(issue, { project: 'PROJ', runner });
    expect(second).toBe('Bug Description');
    expect(runner).toHaveBeenCalledTimes(1);
  });

  test('force flag bypasses cache', () => {
    const issue = makeIssue({
      fields: { Description: { id: 'description', name: 'Description', text: 'x' } },
    });
    const runner = vi.fn(() => '{"description_field": "Description"}');
    classifyDescriptionField(issue, { project: 'PROJ', runner });
    classifyDescriptionField(issue, { project: 'PROJ', runner, force: true });
    expect(runner).toHaveBeenCalledTimes(2);
  });

  test('falls back to heuristic when runner returns garbage', () => {
    const issue = makeIssue({
      fields: {
        Description: { id: 'description', name: 'Description', text: 'standard content' },
        'Bug Description': { id: 'customfield_99001', name: 'Bug Description', text: 'custom' },
      },
    });
    const runner = vi.fn(() => 'I have no idea what you mean.');
    expect(classifyDescriptionField(issue, { project: 'PROJ', runner })).toBe('Description');
  });

  test('falls back to heuristic when runner returns a field that does not exist on the ticket', () => {
    const issue = makeIssue({
      fields: { Description: { id: 'description', name: 'Description', text: 'ok' } },
    });
    const runner = vi.fn(() => '{"description_field": "Made Up Field"}');
    expect(classifyDescriptionField(issue, { project: 'PROJ', runner })).toBe('Description');
  });

  test('falls back to heuristic when runner is unavailable (returns undefined)', () => {
    const issue = makeIssue({
      fields: { 'Bug Description': { id: 'customfield_99001', name: 'Bug Description', text: 'crash' } },
    });
    const runner = vi.fn(() => undefined);
    expect(classifyDescriptionField(issue, { project: 'PROJ', runner })).toBe('Bug Description');
  });

  test('invalidates cache when the cached field is gone from the ticket', () => {
    const issue1 = makeIssue({
      fields: { 'Bug Description': { id: 'customfield_99001', name: 'Bug Description', text: 'A' } },
    });
    const runner1 = vi.fn(() => '{"description_field": "Bug Description"}');
    classifyDescriptionField(issue1, { project: 'PROJ', runner: runner1 });

    // New ticket where the cached field doesn't exist
    const issue2 = makeIssue({
      fields: { Description: { id: 'description', name: 'Description', text: 'B' } },
    });
    const runner2 = vi.fn(() => '{"description_field": "Description"}');
    expect(classifyDescriptionField(issue2, { project: 'PROJ', runner: runner2 })).toBe('Description');
    expect(runner2).toHaveBeenCalledTimes(1);
  });

  test('caches by (project, ticketType) — Bugs and Stories get separate entries', () => {
    const bug = makeIssue({
      issueType: 'Bug',
      fields: { 'Bug Description': { id: 'customfield_99001', name: 'Bug Description', text: 'b' } },
    });
    const story = makeIssue({
      issueType: 'Story',
      fields: { Description: { id: 'description', name: 'Description', text: 's' } },
    });
    const runner = vi.fn((prompt: string) =>
      prompt.includes('Bug') ? '{"description_field": "Bug Description"}' : '{"description_field": "Description"}',
    );
    expect(classifyDescriptionField(bug, { project: 'PROJ', runner })).toBe('Bug Description');
    expect(classifyDescriptionField(story, { project: 'PROJ', runner })).toBe('Description');
    const cache = JSON.parse(readFileSync(cachePath(), 'utf-8'));
    expect(cache.PROJ.Bug.description).toBe('Bug Description');
    expect(cache.PROJ.Story.description).toBe('Description');
  });
});
