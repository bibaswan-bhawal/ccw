# ccw — Claude Code Worktree

Spin up git worktrees with persistent [Claude Code](https://docs.claude.com/en/docs/claude-code) sessions and pluggable task-provider context. Work on multiple features concurrently, each with its own branch, working directory, and Claude conversation.

## Features

- **Per-feature git worktrees** — each branch lives in its own directory, no stashing or branch-switching.
- **Persistent Claude sessions** — each worktree is tied to a session UUID. Re-opening resumes the exact conversation.
- **Pluggable task providers** — feature names containing a task key (e.g. `PROJ-123-my-feature`) auto-fetch the task from a configured provider and inject it as Claude's system context.
- **Auto-planning** — on first launch, Claude is prompted to research the codebase and present an implementation plan before writing code.

## Requirements

- [Bun](https://bun.sh) (for now — binaries will be shipped soon)
- [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) on `$PATH`
- `git`

## Installation

### From source (development)

```bash
git clone https://github.com/bibaswan-bhawal/ccw.git
cd ccw
bun install
# Add the dev wrapper to your PATH
export PATH="$(pwd)/bin:$PATH"
```

> **Note**: If your network proxies npm through a private registry, see the [Development](#development) section for `bunfig.toml` setup.

### Homebrew (coming soon)

```bash
brew tap bibaswan-bhawal/ccw
brew install ccw
```

## Quick start

```bash
# One-time setup per repo
cd ~/code/my-repo
ccw init

# Start work on a new feature (detects PROJ-123 if a task provider is configured)
ccw PROJ-123-add-new-thing

# List active worktrees (interactive picker)
ccw ls

# Resume an existing worktree (same Claude session)
ccw PROJ-123-add-new-thing

# Clean up when done
ccw rm PROJ-123-add-new-thing
```

## Commands

| Command            | Description                                             |
| ------------------ | ------------------------------------------------------- |
| `ccw init`         | Interactive setup for the current repo                  |
| `ccw`              | Interactive picker of existing worktrees                |
| `ccw <feature>`    | Create worktree + start Claude Code (resumes if exists) |
| `ccw ls`           | List active worktrees                                   |
| `ccw rm [feature]` | Remove a worktree and its session                       |

## Configuration

ccw never touches the working tree. Per-repo config lives at:

```
~/.ccw/repos/<encoded-git-root>/config.json
```

For example, a repo at `/Users/me/code/my-repo` becomes `~/.ccw/repos/-Users-me-code-my-repo/config.json`. This keeps shared monorepos clean — no `.ccw.json` to commit, no `.gitignore` line to add. Earlier versions of ccw stored config in the repo; that file is migrated on first read.

```json
{
  "worktree_dir": "/path/to/my-repo_worktrees",
  "app_subdir": "",
  "base_branch": "main",
  "plugins": {
    "jira": {
      "base_url": "https://your-org.atlassian.net",
      "project": "PROJ",
      "email": "you@example.com"
    }
  }
}
```

Environment variables override the config file:

| Variable           | Purpose                                            |
| ------------------ | -------------------------------------------------- |
| `CCW_DATA_DIR`     | Override `~/.ccw` (sessions, configs, credentials) |
| `CCW_WORKTREE_DIR` | Where worktrees are created                        |
| `CCW_APP_SUBDIR`   | Subdirectory to cd into within the worktree        |
| `CCW_BASE_BRANCH`  | Base branch for new worktrees                      |

Plugins may add their own env vars; see each plugin's README.

## Plugins

ccw is built around a plugin system. Plugins extend ccw with capabilities like task lookup (Jira / Linear / GitHub Issues / …), environment setup (foreman, docker, …), and lifecycle hooks. They're bundled into the binary; enable them per-repo via `ccw init`.

Each plugin owns its own configuration flow (so its prompts stay in one place) and ships with its own README.

| Plugin | Capabilities  | Docs                                                       |
| ------ | ------------- | ---------------------------------------------------------- |
| `jira` | Task provider | [`src/plugins/jira/README.md`](src/plugins/jira/README.md) |

To disable all plugins, set `"plugins": {}` in your repo config. ccw still works — you just lose task detection and any plugin-provided lifecycle hooks.

## Development

```bash
bun install            # install deps
bun run dev -- ls      # run the CLI locally
bun run test           # run unit tests
bun run typecheck      # tsc --noEmit
bun run build          # build a standalone binary to dist/ccw
```

Lockfiles (`bun.lock`, `package-lock.json`) are gitignored. `bun install` resolves fresh from `package.json` for both contributors and CI, which avoids friction when contributors are on different networks (e.g. corporate proxies vs the public registry).

### If your network proxies npm

If your network blocks the public npm registry and uses a private one instead, copy `bunfig.toml.example` to `bunfig.toml` (gitignored) and fill in your registry URL. Make sure the URL ends with a trailing slash — without it, Bun strips the path prefix.

## License

MIT
