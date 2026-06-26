import type { Plugin, PluginInit, Task, TaskBadge, TaskProvider } from '../../lib/plugin.ts';
import type { AnswerMap, InitStep } from '../../lib/wizard/index.ts';
import { readCredentials, writeCredentials } from '../../lib/credentials.ts';
import { extractJiraKey, fetchJiraIssue, formatJiraIssue, JiraError, verifyAuth, type JiraAuth } from './api.ts';
import { classifyDescriptionField } from './classifier.ts';

const PLUGIN_NAME = 'jira';
const TOKEN_INSTRUCTIONS_URL = 'https://id.atlassian.com/manage-profile/security/api-tokens';
const SECTION = 'Configure jira';

// Step ids — also used as keys in the answer map.
const ID = {
  baseUrl: 'jira:base_url',
  project: 'jira:project',
  boardId: 'jira:board_id',
  email: 'jira:email',
  token: 'jira:token',
  verify: 'jira:verify',
} as const;

export interface JiraConfig {
  /** e.g. https://your-org.atlassian.net — required, no default. */
  base_url?: string;
  /** Project key, e.g. "PROJ". Required for the strict-key matcher. */
  project?: string;
  /** Optional board ID; reserved for future board-aware features. */
  board_id?: string;
  /** Email used to authenticate against Jira. May also come from env. */
  email?: string;
}

interface StoredCredentials {
  token: string;
}

function readJiraConfig(rawConfig: unknown): JiraConfig {
  if (rawConfig && typeof rawConfig === 'object') {
    return rawConfig as JiraConfig;
  }
  return {};
}

function gitUserEmail(): string | undefined {
  try {
    const out = Bun.spawnSync(['git', 'config', 'user.email']).stdout.toString().trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

function resolveAuth(config: JiraConfig): JiraAuth | { error: string } {
  if (!config.base_url) {
    return { error: 'Jira base URL is not configured. Run `ccw init` to set it up.' };
  }
  const email = process.env.JIRA_USER_EMAIL ?? config.email ?? gitUserEmail() ?? '';
  if (!email) {
    return {
      error: 'No Jira email configured. Run `ccw init` or set JIRA_USER_EMAIL.',
    };
  }
  const stored = readCredentials<StoredCredentials>(PLUGIN_NAME);
  const apiToken = process.env.JIRA_API_TOKEN ?? stored?.token ?? '';
  if (!apiToken) {
    return {
      error: 'No Jira API token. Run `ccw init` to save one, or set JIRA_API_TOKEN.',
    };
  }
  return { baseUrl: config.base_url, email, apiToken };
}

const taskProvider: TaskProvider = {
  detectKey(featureName, rawConfig): string | undefined {
    const config = readJiraConfig(rawConfig);
    return extractJiraKey(featureName, config.project);
  },

  async fetchTask(key, rawConfig): Promise<Task> {
    const config = readJiraConfig(rawConfig);
    const auth = resolveAuth(config);
    if ('error' in auth) throw new JiraError(auth.error);
    const issue = await fetchJiraIssue(auth, key);

    // Identify which field holds the description for this (project, ticket
    // type). Cached after the first lookup; subsequent fetches skip the LLM
    // call. If the classifier fails or claude -p is unavailable, falls back
    // to a heuristic — the plugin always produces useful context.
    const descriptionField = config.project
      ? await classifyDescriptionField(issue, { project: config.project })
      : undefined;
    const description = descriptionField ? (issue.fields[descriptionField]?.text ?? '') : '';

    return {
      id: issue.key,
      title: issue.summary,
      url: issue.url,
      status: issue.status,
      description,
      claudeContext: formatJiraIssue(issue, { descriptionField }),
      metadata: {
        issueType: issue.issueType,
        priority: issue.priority,
        assignee: issue.assignee,
        reporter: issue.reporter,
        labels: issue.labels,
        descriptionField: descriptionField ?? null,
      },
    };
  },

  renderBadge(task): TaskBadge {
    return { label: task.id, url: task.url ?? '' };
  },

  buildTaskUrl(key, rawConfig): string | undefined {
    const config = readJiraConfig(rawConfig);
    if (!config.base_url) return undefined;
    return `${config.base_url}/browse/${key}`;
  },
};

const init: PluginInit = {
  steps(existingRaw): InitStep[] {
    const existing = readJiraConfig(existingRaw);
    const stored = readCredentials<StoredCredentials>(PLUGIN_NAME);
    const envToken = process.env.JIRA_API_TOKEN;
    const defaultEmail = existing.email ?? process.env.JIRA_USER_EMAIL ?? gitUserEmail() ?? '';

    const steps: InitStep[] = [
      {
        id: ID.baseUrl,
        section: SECTION,
        type: 'text',
        question: 'Jira base URL',
        hint: 'Your Atlassian Cloud workspace URL, e.g. https://your-org.atlassian.net',
        default: existing.base_url,
        required: true,
      },
      {
        id: ID.project,
        section: SECTION,
        type: 'text',
        question: 'Project key',
        hint: 'The prefix on your tickets (e.g. PROJ for PROJ-123). ccw uses this to detect tickets in branch names.',
        default: existing.project,
        required: true,
      },
      {
        id: ID.boardId,
        section: SECTION,
        type: 'text',
        question: 'Board ID',
        hint: 'Optional. The numeric ID of your team board (e.g. 42). Reserved for future board-aware features.',
        default: existing.board_id,
      },
      {
        id: ID.email,
        section: SECTION,
        type: 'text',
        question: 'Jira account email',
        hint: 'The email tied to your Atlassian account. Defaults to your git user.email.',
        default: defaultEmail,
        required: true,
      },
    ];

    // Token step — skip when env var is set; otherwise pre-fill from
    // credentials store if one exists.
    if (!envToken) {
      steps.push({
        id: ID.token,
        section: SECTION,
        type: 'text',
        question: 'Jira API token',
        hint: `Generate one at ${TOKEN_INSTRUCTIONS_URL}. Stored at ~/.ccw/credentials/jira.json (chmod 0600).`,
        default: stored?.token,
        masked: true,
        required: true,
      });
    }

    // Verify step — runs against the answers and rolls back to the token
    // step on failure (so the user re-enters whatever was wrong).
    steps.push({
      id: ID.verify,
      section: SECTION,
      type: 'verify',
      question: 'Verifying Jira credentials...',
      onFailGoTo: envToken ? ID.email : ID.token,
      run: async (answers) => {
        const baseUrl = (answers[ID.baseUrl] as string) ?? '';
        const email = (answers[ID.email] as string) ?? '';
        const token = envToken ?? (answers[ID.token] as string) ?? '';
        if (!baseUrl || !email || !token) throw new JiraError('Missing Jira credentials.');
        const me = await verifyAuth({ baseUrl, email, apiToken: token });
        return me.displayName;
      },
    });

    return steps;
  },

  reduceAnswers(answers: AnswerMap): JiraConfig {
    const baseUrl = (answers[ID.baseUrl] as string | undefined) ?? '';
    const project = (answers[ID.project] as string | undefined) ?? '';
    const boardId = (answers[ID.boardId] as string | undefined) ?? '';
    const email = (answers[ID.email] as string | undefined) ?? '';
    const token = answers[ID.token] as string | undefined;

    // Persist the token outside .ccw.json so the repo config stays free of
    // secrets. If the answer came from the env-token branch (no token step),
    // we leave the credentials store untouched so the user's env-managed
    // setup keeps winning.
    if (token) {
      const previous = readCredentials<StoredCredentials>(PLUGIN_NAME);
      if (token !== previous?.token) {
        writeCredentials(PLUGIN_NAME, { token } satisfies StoredCredentials);
      }
    }

    const config: JiraConfig = {};
    if (baseUrl) config.base_url = baseUrl;
    if (project) config.project = project;
    if (boardId) config.board_id = boardId;
    if (email) config.email = email;
    return config;
  },
};

export const jiraPlugin: Plugin = {
  name: PLUGIN_NAME,
  description: 'Pull ticket context from Jira (Atlassian Cloud)',
  task: taskProvider,
  init,
};

// Re-export so tests / migrations can use the helpers directly.
export { extractJiraKey, JiraError } from './api.ts';
export { adfToText } from './adf.ts';
