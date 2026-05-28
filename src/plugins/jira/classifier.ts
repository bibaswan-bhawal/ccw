/**
 * Identify which Jira field holds the ticket description.
 *
 * Different teams configure Jira differently. Some put bug descriptions in a
 * custom "Bug Description" field and leave the standard `description`
 * empty; some put acceptance criteria in an Atlassian Marketplace plugin's
 * custom field; some teams override the standard field with renamed copies.
 *
 * We can't hardcode any of that. Instead, on the first ticket we see for a
 * given (project, ticket type), we shell out to `claude -p` and ask Claude
 * to pick which field is the description. Result is cached per (project,
 * ticket type) at `~/.ccw/jira-fields.json` so subsequent ccw create flows
 * skip the LLM call entirely.
 *
 * Fallbacks: if `claude -p` is unavailable or returns garbage, we use a
 * simple heuristic — prefer the standard `description` field, otherwise any
 * field whose display name contains "description". The plugin never fails
 * because of classifier issues; it just renders less smartly.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { JiraIssue } from './api.ts';

type ClassificationCache = Record<string, Record<string, { description?: string }>>;

function ccwDataDir(): string {
  return process.env.CCW_DATA_DIR && process.env.CCW_DATA_DIR.length > 0
    ? process.env.CCW_DATA_DIR
    : join(homedir(), '.ccw');
}

export function cachePath(): string {
  return join(ccwDataDir(), 'jira-fields.json');
}

function readCache(): ClassificationCache {
  const path = cachePath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as ClassificationCache;
  } catch {
    return {};
  }
}

function writeCache(cache: ClassificationCache): void {
  const path = cachePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cache, null, 2) + '\n');
}

/**
 * Cheap deterministic fallback. Used when claude -p isn't available or its
 * response can't be parsed. Returns the display name of a likely description
 * field, or undefined if nothing looks like one.
 */
export function heuristicDescriptionField(issue: JiraIssue): string | undefined {
  // 1. Standard "description" field if it has content (most projects, most tickets).
  for (const [name, field] of Object.entries(issue.fields)) {
    if (field.id === 'description' && field.text.length > 0) return name;
  }
  // 2. Any field whose display name contains "description" (covers "Bug
  //    Description", "Problem Description", localized variants matching "description").
  for (const [name, field] of Object.entries(issue.fields)) {
    if (/description/i.test(name) && field.text.length > 0) return name;
  }
  return undefined;
}

/**
 * Build the classifier prompt. We include a short sample of each non-empty
 * field so Claude has enough signal to pick — but we cap each sample to keep
 * the prompt small (200 chars per field, typical ticket is well under 10KB
 * total prompt input).
 */
export function buildClassifierPrompt(issue: JiraIssue): string {
  const SAMPLE_LEN = 200;
  const samples: string[] = [];
  for (const [name, field] of Object.entries(issue.fields)) {
    const sample = field.text.slice(0, SAMPLE_LEN).replace(/\s+/g, ' ').trim();
    samples.push(`- ${JSON.stringify(name)}: ${sample}`);
  }
  return [
    'You are classifying fields on a Jira ticket. Identify the single field whose value is the human-written description of what the ticket is about — for example, the bug being reported, the feature being requested, or the task to do. Custom field names like "Bug Description" or "Problem Description" often hold the real content when the standard "Description" is empty.',
    '',
    `Ticket type: ${issue.issueType}`,
    `Summary: ${issue.summary}`,
    '',
    'Available fields (name: sample):',
    ...samples,
    '',
    'Respond with ONLY a single JSON object on one line. No commentary, no markdown fences.',
    '{"description_field": "exact field name from the list" } or {"description_field": null} if no field looks like a description.',
  ].join('\n');
}

/**
 * Extract the field name from `claude -p`'s output. Tolerates leading/trailing
 * chatter and markdown fences but expects a JSON object somewhere in the
 * response.
 */
export function parseClassifierResponse(stdout: string): string | undefined {
  const startIdx = stdout.indexOf('{');
  const endIdx = stdout.lastIndexOf('}');
  if (startIdx < 0 || endIdx <= startIdx) return undefined;
  const candidate = stdout.slice(startIdx, endIdx + 1);
  try {
    const parsed = JSON.parse(candidate) as { description_field?: unknown };
    if (typeof parsed.description_field === 'string' && parsed.description_field.length > 0) {
      return parsed.description_field;
    }
  } catch {
    // fall through to undefined
  }
  return undefined;
}

interface RunOptions {
  /** Injected for tests. Real callers leave this unset; classifyDescriptionField defaults to claude -p. */
  runner?: (prompt: string) => string | undefined;
}

function defaultRunner(prompt: string): string | undefined {
  const result = spawnSync('claude', ['-p', prompt], {
    encoding: 'utf-8',
    timeout: 60_000,
  });
  if (result.status !== 0) return undefined;
  return result.stdout;
}

export interface ClassifyOptions extends RunOptions {
  /** Jira project key, used as the cache namespace. */
  project: string;
  /** When true, bypass the cache and re-classify even if a result is stored. */
  force?: boolean;
}

/**
 * Identify the description field for an issue. Cached per (project, issueType).
 * Always returns a best guess: classifier result, then heuristic, then
 * undefined if neither finds anything plausible.
 */
export function classifyDescriptionField(issue: JiraIssue, opts: ClassifyOptions): string | undefined {
  const cache = readCache();
  const projectCache = cache[opts.project] ?? {};

  if (!opts.force) {
    const cached = projectCache[issue.issueType]?.description;
    // Make sure the cached field still exists on this ticket — Jira admins can
    // rename fields and the cache would be stale.
    if (cached && issue.fields[cached]) return cached;
  }

  const runner = opts.runner ?? defaultRunner;
  const stdout = runner(buildClassifierPrompt(issue));
  const fromLLM = stdout ? parseClassifierResponse(stdout) : undefined;
  const validated = fromLLM && issue.fields[fromLLM] ? fromLLM : heuristicDescriptionField(issue);

  if (validated) {
    const next: ClassificationCache = { ...cache };
    next[opts.project] = { ...projectCache, [issue.issueType]: { description: validated } };
    try {
      writeCache(next);
    } catch {
      // cache write is best-effort — classifier still returns a usable result
    }
  }

  return validated;
}
