# `@ccw/plugin-jira`

Pulls task context from Jira (Atlassian Cloud) and injects it into Claude when you start work on a worktree whose name contains a Jira ticket key (e.g. `PROJ-123-fix-the-thing`).

This plugin is bundled with the ccw binary. Enable it per-repo via `ccw init`.

## What it does

- **Detects ticket keys** in feature names. With a configured `project`, only that project's keys (case-insensitive) match — so `hackday-spring-2026` is correctly ignored.
- **Fetches the ticket** when you create a worktree and serializes the summary, description, status, assignee, labels, acceptance criteria, and recent comments into a markdown blob that becomes part of Claude's system prompt.
- **Verifies the ticket exists** before persisting the link — bogus keys never end up in `~/.ccw/sessions.json`.
- **Renders a clickable badge** in `ccw ls` / `ccw rm` linking to the Jira issue page.

## Setup

Run `ccw init` in your repo and select the Jira plugin. You'll be asked for:

| Field             | Description                                                                                               |
| ----------------- | --------------------------------------------------------------------------------------------------------- |
| **Base URL**      | Your Atlassian Cloud instance, e.g. `https://your-org.atlassian.net`. No default.                          |
| **Project key**   | The project's key prefix, e.g. `PROJ`. Used to scope ticket detection in branch names.                    |
| **Board ID**      | Optional. Reserved for future board-aware features.                                                       |
| **Email**         | Your Atlassian account email. Defaults to `git config user.email`.                                        |
| **API token**     | Generated at https://id.atlassian.com/manage-profile/security/api-tokens.                                 |

Init verifies your credentials by calling `/rest/api/3/myself` before saving anything. If the call fails, you can re-enter the token or hit Esc to skip Jira setup.

## Where things live

The non-secret config goes in your repo's `.ccw.json`:

```json
{
  "plugins": {
    "jira": {
      "base_url": "https://your-org.atlassian.net",
      "project": "PROJ",
      "email": "you@example.com",
      "board_id": "42"
    }
  }
}
```

The API token is stored separately at `~/.ccw/credentials/jira.json` with `chmod 0600` so it doesn't get checked in. The credentials file is never read or written by anything outside this plugin.

```
~/.ccw/
└── credentials/
    └── jira.json   # { "token": "..." }, mode 0600
```

## Environment variable overrides

Both env vars are optional and override the stored credentials:

| Variable          | Purpose                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| `JIRA_USER_EMAIL` | Overrides `email` from `.ccw.json`. Useful for shared shell setups with multiple Atlassian accounts. |
| `JIRA_API_TOKEN`  | Overrides the stored token. If set, init detects it and won't write to `~/.ccw/credentials/jira.json`. |

Precedence: env var > stored credentials > `.ccw.json` (for email; tokens are never stored in `.ccw.json`).

## Usage

```bash
ccw PROJ-123-add-new-thing
```

You'll see:

```
✓ Fetching master from origin
✓ Worktree created at /path/to/repo_worktrees/PROJ-123-add-new-thing
→ Detected jira task: PROJ-123
✓ Jira context loaded for PROJ-123
→ Starting Claude Code in /path/to/repo_worktrees/PROJ-123-add-new-thing
```

Claude opens with the ticket summary, description, and acceptance criteria already in its system context, and is prompted to research the codebase and present an implementation plan before writing code.

## Custom acceptance-criteria field

The plugin reads `customfield_11060` as "Acceptance Criteria." This field ID is hardcoded; different Jira instances use different custom-field IDs for the same logical field. If acceptance criteria don't show up in the Claude context, your instance probably uses a different ID. PRs welcome to make this configurable.

## Troubleshooting

**`Jira API … failed: 401 Unauthorized`** — your token is wrong, expired, or revoked. Re-run `ccw init` and re-enter it.

**`Jira API … failed: 404 Not Found`** — the ticket key in your branch name doesn't exist. Double-check the key.

**Ticket key not detected** — check that your `project` is set correctly in `.ccw.json` and matches the case-insensitive prefix in your branch name. Without a `project`, the plugin only matches strict-uppercase keys (so `proj-123` won't match — `PROJ-123` will).
