# `@ccw/plugin-jira`

Pulls task context from Jira (Atlassian Cloud) and injects it into Claude when you start work on a worktree whose name contains a Jira ticket key (e.g. `PROJ-123-fix-the-thing`).

This plugin is bundled with the ccw binary. Enable it per-repo via `ccw init`.

## What it does

- **Detects ticket keys** in feature names. With a configured `project`, only that project's keys (case-insensitive) match — so `hackday-spring-2026` is correctly ignored.
- **Fetches the entire ticket** when you create a worktree — every field, including custom fields specific to your Jira instance — and resolves field IDs (`customfield_NNNNN`) to the human-readable display names your Jira admin configured.
- **Identifies the description field** with a one-time `claude -p` classification per `(project, ticket type)`. This handles instances where bugs put the real description in `Bug Description` and leave the standard `description` empty, or where teams override standard fields entirely. Result is cached so subsequent ccw create flows skip the LLM call.
- **Renders the full context** as markdown with each field under its own Jira display name, plus structured sections for subtasks, linked issues, and recent comments.
- **Verifies the ticket exists** before persisting the link — bogus keys never end up in `~/.ccw/sessions.json`.
- **Renders a clickable badge** in `ccw ls` / `ccw rm` linking to the Jira issue page.

## Setup

Run `ccw init` in your repo and select the Jira plugin. You'll be asked for:

| Field         | Description                                                                          |
| ------------- | ------------------------------------------------------------------------------------ |
| **Base URL**  | Your Atlassian Cloud instance, e.g. `https://your-org.atlassian.net`. No default.    |
| **Project key** | The project's key prefix, e.g. `PROJ`. Used to scope ticket detection in branch names. |
| **Board ID**  | Optional. Reserved for future board-aware features.                                  |
| **Email**     | Your Atlassian account email. Defaults to `git config user.email`.                   |
| **API token** | Generated at https://id.atlassian.com/manage-profile/security/api-tokens.            |

Init verifies your credentials by calling `/rest/api/3/myself` before saving anything. If the call fails, you can re-enter the token or hit Esc to skip Jira setup.

## How custom fields are handled

Different teams configure Jira differently. Some put bug descriptions in a custom field and leave the standard `description` empty; some put acceptance criteria in an Atlassian Marketplace plugin (e.g. Checklists for Jira); some override standard fields with renamed copies.

Rather than hard-coding any of this, the plugin:

1. Fetches every field on the ticket with `expand=names,renderedFields` so values come back pre-rendered as HTML and field IDs map to display names.
2. The first time it sees a ticket of a given `(project, ticket type)` combination, it shells out to `claude -p` (the Claude Code CLI you already have installed) and asks Claude to pick which field holds the description. The result is cached at `~/.ccw/jira-fields.json`:

   ```json
   {
     "PROJ": {
       "Bug": { "description": "Bug Description" },
       "Story": { "description": "Description" }
     }
   }
   ```

3. Subsequent ccw create flows for tickets in that `(project, ticket type)` skip the LLM call entirely — cache lookup only.

4. If `claude -p` is unavailable or returns an unparseable response, the plugin falls back to a heuristic: prefer standard `description`, otherwise the first field whose display name contains "description". The plugin always produces useful context; it just renders less smartly without the LLM.

5. **Every** custom field (not just the description) appears in Claude's context under its Jira display name. Acceptance Criteria, Steps to Reproduce, Environment, Expected Behavior, custom plugin fields — whatever your team uses, Claude sees it.

The classifier prompt itself includes field names and ~200-char samples of each value, so the LLM call is tiny — usually well under 10KB of input. One call per `(project, ticket type)` per user, forever (unless field structure changes and the cache invalidates itself).

### Reclassifying

If a Jira admin reshuffles fields and the cached classification goes stale, delete `~/.ccw/jira-fields.json` (or just the project's entry within it) and the next ticket fetch re-classifies.

## Where things live

The non-secret config goes in your repo's per-repo config:

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
├── credentials/
│   └── jira.json        # { "token": "..." }, mode 0600
└── jira-fields.json     # field-role cache, per (project, ticket type)
```

## Environment variable overrides

Both env vars are optional and override the stored credentials:

| Variable          | Purpose                                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------------------- |
| `JIRA_USER_EMAIL` | Overrides `email` from the repo config. Useful for shared shell setups with multiple Atlassian accounts. |
| `JIRA_API_TOKEN`  | Overrides the stored token. If set, init detects it and won't write to `~/.ccw/credentials/jira.json`.    |
| `CCW_DATA_DIR`    | Overrides `~/.ccw` — affects the field-classification cache location too.                            |

Precedence: env var > stored credentials > repo config (for email; tokens are never stored in repo config).

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

Claude opens with the full ticket context — every field, comments, subtasks, linked issues — already in its system prompt, and is prompted to research the codebase and present an implementation plan before writing code.

## Troubleshooting

**`Jira API … failed: 401 Unauthorized`** — your token is wrong, expired, or revoked. Re-run `ccw init` and re-enter it.

**`Jira API … failed: 404 Not Found`** — the ticket key in your branch name doesn't exist. Double-check the key.

**Ticket key not detected** — check that your `project` is set correctly in the repo config and matches the case-insensitive prefix in your branch name. Without a `project`, the plugin only matches strict-uppercase keys (so `proj-123` won't match — `PROJ-123` will).

**Wrong field promoted to "## Description"** — the LLM classifier picked something unexpected. Delete `~/.ccw/jira-fields.json` (or the relevant project entry) to force re-classification on the next ticket fetch. If it keeps picking wrong, the heuristic fallback still runs — file an issue with details so we can improve the prompt.

**`claude -p` slow** — the first classification per `(project, ticket type)` takes 5-15s. It's cached afterward; subsequent tickets in the same combo are instant.
