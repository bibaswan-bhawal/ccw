/**
 * Jira REST API helpers used by the Jira plugin.
 *
 * The Plugin definition in ./index.ts wraps these into the generic Task shape
 * defined in src/lib/plugin.ts so the rest of ccw never has to know about
 * Jira-specific concepts.
 */

import { adfToText } from './adf.ts';

export interface JiraAuth {
  baseUrl: string;
  email: string;
  apiToken: string;
}

export interface JiraIssue {
  key: string;
  summary: string;
  status: string;
  issueType: string;
  priority: string;
  assignee: string;
  labels: string[];
  url: string;
  description: string;
  acceptanceCriteria: string;
  recentComments: string;
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
  // No configured project: only match all-uppercase prefixes.
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
  accountId?: string;
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

interface JiraIssueResponse {
  key: string;
  fields: {
    summary?: string;
    status?: { name?: string };
    issuetype?: { name?: string };
    priority?: { name?: string };
    assignee?: { displayName?: string } | null;
    labels?: string[];
    description?: unknown;
    customfield_11060?: unknown;
    comment?: {
      comments?: Array<{
        author?: { displayName?: string };
        created?: string;
        body?: unknown;
      }>;
    };
  };
}

export async function fetchJiraIssue(auth: JiraAuth, ticketKey: string): Promise<JiraIssue> {
  const fields = [
    'summary',
    'description',
    'status',
    'issuetype',
    'priority',
    'assignee',
    'labels',
    'customfield_11060',
    'comment',
  ].join(',');

  const issue = await jiraApi<JiraIssueResponse>(auth, `/rest/api/3/issue/${ticketKey}?fields=${fields}`);
  const f = issue.fields;

  const description = adfToText(f.description).trim() || 'No description provided.';
  const acceptanceCriteria = adfToText(f.customfield_11060).trim();

  const commentList = f.comment?.comments ?? [];
  const recentComments = commentList
    .slice(-5)
    .map((c) => {
      const author = c.author?.displayName ?? 'Unknown';
      const date = c.created?.split('T')[0] ?? '';
      const body = typeof c.body === 'string' ? c.body : JSON.stringify(c.body);
      return `[${author} — ${date}]: ${body}`;
    })
    .join('\n');

  return {
    key: issue.key,
    summary: f.summary ?? 'N/A',
    status: f.status?.name ?? 'N/A',
    issueType: f.issuetype?.name ?? 'N/A',
    priority: f.priority?.name ?? 'N/A',
    assignee: f.assignee?.displayName ?? 'Unassigned',
    labels: f.labels ?? [],
    url: `${auth.baseUrl}/browse/${issue.key}`,
    description,
    acceptanceCriteria,
    recentComments,
  };
}

export function formatJiraIssue(issue: JiraIssue): string {
  const labelsStr = issue.labels.length > 0 ? issue.labels.join(', ') : 'none';
  const lines = [
    `# Jira Ticket: ${issue.key}`,
    '',
    `- **Summary**: ${issue.summary}`,
    `- **Type**: ${issue.issueType}`,
    `- **Status**: ${issue.status}`,
    `- **Priority**: ${issue.priority}`,
    `- **Assignee**: ${issue.assignee}`,
    `- **Labels**: ${labelsStr}`,
    `- **URL**: ${issue.url}`,
    '',
    '## Description',
    '',
    issue.description,
  ];

  if (issue.acceptanceCriteria) {
    lines.push('', '## Acceptance Criteria', '', issue.acceptanceCriteria);
  }
  if (issue.recentComments) {
    lines.push('', '## Recent Comments (last 5)', '', issue.recentComments);
  }

  return lines.join('\n');
}
