/**
 * Jira REST API helpers used by the Jira plugin.
 *
 * The Plugin definition in ./index.ts wraps these into the generic Task shape
 * defined in src/lib/plugin.ts so the rest of ccw never has to know about
 * Jira-specific concepts.
 *
 * Design note: we fetch the full ticket with `expand=names,renderedFields`
 * and `fields=*all` so that custom fields (which vary per project / ticket
 * type) come through with their human-readable display names. The classifier
 * (./classifier.ts) figures out which one is the description; everything
 * else flows into the prompt under its own Jira display name.
 */

import { adfToText } from './adf.ts';

export interface JiraAuth {
  baseUrl: string;
  email: string;
  apiToken: string;
}

/** A single Jira field, after we've resolved its ID to a display name. */
export interface JiraField {
  /** Jira field id, e.g. `summary`, `customfield_11060`. */
  id: string;
  /** Display name from Jira's `names` expand (e.g. "Acceptance Criteria"). */
  name: string;
  /** Rendered plain text — empty if the field had no content. */
  text: string;
}

export interface JiraComment {
  author: string;
  date: string;
  body: string;
}

export interface JiraSubtask {
  key: string;
  summary: string;
  status: string;
}

export interface JiraLink {
  type: string;
  key: string;
  summary: string;
  status: string;
}

export interface JiraIssue {
  key: string;
  url: string;

  // Always-present scalars (the at-a-glance header).
  summary: string;
  status: string;
  issueType: string;
  priority: string;
  assignee: string;
  reporter: string;
  labels: string[];

  /**
   * Every other non-empty field on the ticket, keyed by display name.
   * Order is preserved from the API response so the most-recently-edited
   * custom fields tend to appear first.
   */
  fields: Record<string, JiraField>;

  comments: JiraComment[];
  subtasks: JiraSubtask[];
  links: JiraLink[];
}

export class JiraError extends Error {}

/**
 * Extract a Jira ticket key from a feature name.
 *
 * If `project` is provided, only that project's keys match (e.g. project="AHDOC"
 * matches "AHDOC-123" / "ahdoc-123" but not "SPRING-2026"). Without a project,
 * we fall back to a strict uppercase pattern, so casual hyphenated branch names
 * like `hackday-spring-2026` don't get misidentified as tickets.
 */
export function extractJiraKey(input: string, project?: string): string | undefined {
  if (project) {
    const re = new RegExp(`\\b${project}-(\\d+)\\b`, 'i');
    const match = input.match(re);
    return match ? `${project.toUpperCase()}-${match[1]}` : undefined;
  }
  const match = input.match(/\b[A-Z][A-Z0-9]+-\d+\b/);
  return match ? match[0] : undefined;
}

function basicAuthHeader(email: string, token: string): string {
  return 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
}

export async function jiraApi<T = unknown>(auth: JiraAuth, path: string): Promise<T> {
  const response = await fetch(`${auth.baseUrl}${path}`, {
    headers: {
      Authorization: basicAuthHeader(auth.email, auth.apiToken),
      Accept: 'application/json',
    },
  });
  if (!response.ok) {
    throw new JiraError(`Jira API ${path} failed: ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

interface JiraMyselfResponse {
  emailAddress?: string;
  displayName?: string;
}

/**
 * Validate auth by fetching the calling user's profile. Used during init
 * to give the user immediate feedback if their token is wrong.
 */
export async function verifyAuth(auth: JiraAuth): Promise<{ displayName: string }> {
  const me = await jiraApi<JiraMyselfResponse>(auth, '/rest/api/3/myself');
  return { displayName: me.displayName ?? me.emailAddress ?? 'Unknown' };
}

// --- Field rendering ----------------------------------------------------

/**
 * Field IDs we never want to render. Either pure metadata (avatarUrls), or
 * Jira plumbing (workratio, statuscategorychangedate), or things we
 * special-case elsewhere (comment, subtasks, issuelinks).
 */
const NOISE_FIELD_IDS = new Set([
  // Special-cased elsewhere
  'comment',
  'subtasks',
  'issuelinks',
  'attachment',
  // Already in the header scalars
  'summary',
  'status',
  'issuetype',
  'priority',
  'assignee',
  'reporter',
  'labels',
  // Pure internal plumbing
  'aggregateprogress',
  'aggregatetimeestimate',
  'aggregatetimeoriginalestimate',
  'aggregatetimespent',
  'progress',
  'timetracking',
  'timeestimate',
  'timeoriginalestimate',
  'timespent',
  'workratio',
  'statuscategorychangedate',
  'security',
  'thumbnail',
  'votes',
  'watches',
  'worklog',
  'lastViewed',
]);

/**
 * Strip HTML tags down to plain text. Atlassian's `renderedFields` returns
 * decent HTML for ADF content; for prompt consumption we mostly just need
 * text + structure. Keep <li>, <p>, headings as newline markers.
 */
function htmlToText(html: string): string {
  if (!html) return '';
  return html
    .replace(/<\s*(br|p|div|h[1-6]|li|tr)\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|h[1-6]|li|tr|ul|ol|table)\s*>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Render a single Jira field value to plain text. Prefers Atlassian's own
 * HTML rendering (from `renderedFields`) when available, falls back to ADF,
 * then to scalar values, then to a JSON dump for opaque shapes.
 */
function renderFieldValue(value: unknown, rendered: unknown): string {
  if (typeof rendered === 'string' && rendered.length > 0) {
    return htmlToText(rendered);
  }
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    // Common shapes: [{ name: "x" }], [{ value: "y" }], list of strings
    if (value.every((v) => typeof v === 'string')) return value.join(', ');
    if (value.every((v) => v && typeof v === 'object')) {
      const names = value
        .map((v) => {
          const o = v as Record<string, unknown>;
          return (o.name ?? o.value ?? o.displayName ?? '') as string;
        })
        .filter(Boolean);
      if (names.length === value.length) return names.join(', ');
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'object') {
    // ADF documents
    const doc = value as { type?: string };
    if (doc.type === 'doc') return adfToText(value).trim();
    // Single-name shapes like { name: "Bob" } or { value: "x", id: "10000" }
    const o = value as Record<string, unknown>;
    if (typeof o.name === 'string') return o.name;
    if (typeof o.value === 'string') return o.value;
    if (typeof o.displayName === 'string') return o.displayName;
    return JSON.stringify(value);
  }
  return '';
}

// --- Field shape from the Jira REST API ---------------------------------

interface JiraIssueResponse {
  key: string;
  fields: Record<string, unknown>;
  names?: Record<string, string>;
  renderedFields?: Record<string, unknown>;
}

function nameOf(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  return (value as { name?: string }).name ?? '';
}

function displayNameOf(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  return (value as { displayName?: string }).displayName ?? '';
}

export async function fetchJiraIssue(auth: JiraAuth, ticketKey: string): Promise<JiraIssue> {
  // expand=names → resolves customfield_NNNNN to display names
  // expand=renderedFields → ADF fields come back pre-rendered as HTML
  // fields=*all → include every field including unknown custom ones
  const issue = await jiraApi<JiraIssueResponse>(
    auth,
    `/rest/api/3/issue/${ticketKey}?expand=names,renderedFields&fields=*all`,
  );
  const f = issue.fields;
  const names = issue.names ?? {};
  const rendered = issue.renderedFields ?? {};

  // --- Header scalars
  const summary = (f.summary as string | undefined) ?? 'N/A';
  const status = nameOf(f.status) || 'N/A';
  const issueType = nameOf(f.issuetype) || 'N/A';
  const priority = nameOf(f.priority) || 'N/A';
  const assignee = displayNameOf(f.assignee) || 'Unassigned';
  const reporter = displayNameOf(f.reporter) || 'Unknown';
  const labels = Array.isArray(f.labels) ? (f.labels as string[]) : [];

  // --- All other fields, keyed by display name
  const fields: Record<string, JiraField> = {};
  for (const id of Object.keys(f)) {
    if (NOISE_FIELD_IDS.has(id)) continue;
    const text = renderFieldValue(f[id], rendered[id]);
    if (!text) continue;
    const name = names[id] ?? id;
    fields[name] = { id, name, text };
  }

  // --- Special-cased structured collections
  const commentList = (f.comment as { comments?: unknown[] } | undefined)?.comments ?? [];
  const renderedComments = (rendered.comment as { comments?: Array<{ body?: string }> } | undefined)?.comments ?? [];
  const comments: JiraComment[] = commentList.slice(-5).map((raw, i) => {
    const c = raw as { author?: { displayName?: string }; created?: string; body?: unknown };
    const renderedBody = renderedComments[commentList.length - Math.min(commentList.length, 5) + i]?.body;
    const body = renderFieldValue(c.body, renderedBody);
    return {
      author: c.author?.displayName ?? 'Unknown',
      date: c.created?.split('T')[0] ?? '',
      body,
    };
  });

  const subtaskList = Array.isArray(f.subtasks) ? (f.subtasks as unknown[]) : [];
  const subtasks: JiraSubtask[] = subtaskList.map((raw) => {
    const s = raw as { key?: string; fields?: { summary?: string; status?: { name?: string } } };
    return {
      key: s.key ?? '',
      summary: s.fields?.summary ?? '',
      status: s.fields?.status?.name ?? '',
    };
  });

  const linkList = Array.isArray(f.issuelinks) ? (f.issuelinks as unknown[]) : [];
  const links: JiraLink[] = linkList.map((raw) => {
    const l = raw as {
      type?: { inward?: string; outward?: string };
      inwardIssue?: { key?: string; fields?: { summary?: string; status?: { name?: string } } };
      outwardIssue?: { key?: string; fields?: { summary?: string; status?: { name?: string } } };
    };
    const other = l.inwardIssue ?? l.outwardIssue;
    const direction = l.inwardIssue ? l.type?.inward : l.type?.outward;
    return {
      type: direction ?? 'related to',
      key: other?.key ?? '',
      summary: other?.fields?.summary ?? '',
      status: other?.fields?.status?.name ?? '',
    };
  });

  return {
    key: issue.key,
    url: `${auth.baseUrl}/browse/${issue.key}`,
    summary,
    status,
    issueType,
    priority,
    assignee,
    reporter,
    labels,
    fields,
    comments,
    subtasks,
    links,
  };
}

// --- Markdown formatter -------------------------------------------------

const FIELD_TEXT_CAP = 4096;

function capped(text: string): string {
  if (text.length <= FIELD_TEXT_CAP) return text;
  return (
    text.slice(0, FIELD_TEXT_CAP) + `\n\n_[truncated — original was ${text.length} chars; see Jira for full content]_`
  );
}

export interface FormatOptions {
  /**
   * Display name of the field that should be rendered as the "## Description"
   * section. If undefined or no matching field is found, the Description
   * section is omitted; the field still appears in its own section if present.
   */
  descriptionField?: string;
}

export function formatJiraIssue(issue: JiraIssue, options: FormatOptions = {}): string {
  const labels = issue.labels.length > 0 ? issue.labels.join(', ') : 'none';
  const lines: string[] = [
    `# Jira Ticket: ${issue.key}`,
    '',
    `- **Summary**: ${issue.summary}`,
    `- **Type**: ${issue.issueType}`,
    `- **Status**: ${issue.status}`,
    `- **Priority**: ${issue.priority}`,
    `- **Assignee**: ${issue.assignee}`,
    `- **Reporter**: ${issue.reporter}`,
    `- **Labels**: ${labels}`,
    `- **URL**: ${issue.url}`,
  ];

  const descriptionField = options.descriptionField;
  const fieldsToRender = new Map<string, JiraField>();
  for (const [name, field] of Object.entries(issue.fields)) fieldsToRender.set(name, field);

  // Promote the classified description field to its own canonical section.
  // Remove it from the generic fields list so it doesn't appear twice.
  if (descriptionField && fieldsToRender.has(descriptionField)) {
    const field = fieldsToRender.get(descriptionField)!;
    lines.push('', '## Description', '', capped(field.text));
    fieldsToRender.delete(descriptionField);
  }

  for (const field of fieldsToRender.values()) {
    lines.push('', `## ${field.name}`, '', capped(field.text));
  }

  if (issue.subtasks.length > 0) {
    lines.push('', '## Subtasks');
    for (const s of issue.subtasks) {
      lines.push(`- ${s.key} — ${s.summary} (${s.status})`);
    }
  }

  if (issue.links.length > 0) {
    lines.push('', '## Linked Issues');
    for (const l of issue.links) {
      lines.push(`- ${l.type}: ${l.key} — ${l.summary} (${l.status})`);
    }
  }

  if (issue.comments.length > 0) {
    lines.push('', `## Recent Comments (last ${issue.comments.length})`, '');
    for (const c of issue.comments) {
      lines.push(`**${c.author} — ${c.date}**`, '', capped(c.body), '');
    }
  }

  return lines.join('\n');
}
