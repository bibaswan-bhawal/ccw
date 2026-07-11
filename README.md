# ccw — Claude Code Worktree

Spin up git worktrees with persistent [Claude Code](https://docs.claude.com/en/docs/claude-code) sessions and pluggable task-provider context. Work on multiple features concurrently, each with its own branch, working directory, and Claude conversation.

## Features

- **Per-feature git worktrees** — each branch lives in its own directory, no stashing or branch-switching.
- **Persistent Claude sessions** — each worktree is tied to a session UUID. Re-opening resumes the exact conversation.
- **Pluggable task providers** — feature names containing a task key (e.g. `PROJ-123-my-feature`) auto-fetch the task from a configured provider and inject it as Claude's system context.
- **Auto-planning** — on first launch, Claude is prompted to research the codebase and present an implementation plan before writing code.

## Requirements

- [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) on `$PATH`
- `git`

## Installation

### Homebrew (recommended)

```bash
brew install bibaswan-bhawal/ccw/ccw
```

Updates: `brew upgrade ccw`. `ccw update` will detect the brew install and route you back here.

### Direct binary

Pre-built binaries for macOS arm64/x64 and Linux x64 are attached to each [GitHub Release](https://github.com/bibaswan-bhawal/ccw/releases). Download the appropriate binary, drop it on your `$PATH`, and `chmod +x` it. After that, `ccw update` self-updates against future releases (with full signature + attestation verification).

### From source (development)

```bash
git clone https://github.com/bibaswan-bhawal/ccw.git
cd ccw
bun install
# Add the dev wrapper to your PATH
export PATH="$(pwd)/bin:$PATH"
```

Source builds require [Bun](https://bun.sh). If your network proxies npm through a private registry, see the [Development](#development) section for `bunfig.toml` setup.

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

| Command            | Description                                                          |
| ------------------ | -------------------------------------------------------------------- |
| `ccw init`         | Interactive setup for the current repo                               |
| `ccw`              | Interactive picker of existing worktrees                             |
| `ccw <feature>`    | Create worktree + start Claude Code (resumes if exists)              |
| `ccw ls`           | List active worktrees                                                |
| `ccw rm [feature]` | Remove a worktree and its session                                    |
| `ccw env <sub>`    | Manage the worktree's dev environment                                |
| `ccw config`       | Edit global ccw settings (interactive; supports `--get`/`--set`)     |
| `ccw update`       | Self-update to the latest release; skips when installed via Homebrew |

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

## Isolated environments

Give ccw hook scripts and every worktree gets its own running dev environment:
started in the background when you open the worktree, visible to Claude
(`ccw env status`), and torn down when your last session exits.

```
your-repo/.ccw/hooks/
  env-setup    # once per worktree: copy .env, install deps (blocking)
  env-start    # start the environment (foreground process or self-daemonizing)
  env-stop     # graceful teardown (optional if env-start runs in the foreground)
  env-status   # print JSON state: {"ready": true, "services": [...]} (optional)
```

Hooks receive: `CCW_WORKTREE_PATH`, `CCW_WORKTREE_NAME`, `CCW_GIT_ROOT`,
`CCW_ENV_DIR` (scratch dir), and `CCW_WORKTREE_SLOT` — a stable small integer
unique per worktree. Use the slot to avoid collisions between parallel
worktrees: ports (`$((3000 + CCW_WORKTREE_SLOT))`), emulator pools,
`COMPOSE_PROJECT_NAME=app-$CCW_WORKTREE_SLOT`, scratch database names.

Example `env-start` for a web app:

```sh
#!/bin/sh
cp "$CCW_GIT_ROOT/.env" .env 2>/dev/null || true
PORT=$((3000 + CCW_WORKTREE_SLOT)) exec bin/dev
```

| Command           | Description                                    |
| ----------------- | ---------------------------------------------- |
| `ccw env status`  | State, readiness, services (`--json` for CI)   |
| `ccw env logs`    | Environment log (`-n`/`--lines` count, `-f` to follow) |
| `ccw env start`   | Start (runs setup first if needed)             |
| `ccw env stop`    | Stop now                                       |
| `ccw env restart` | The "I broke it" recovery loop                 |

Can't commit files to the repo? Put the same hooks in
`~/.ccw/repos/<encoded-git-root>/hooks/` instead — in-tree wins when both exist.
Optional: set `environment.ready_pattern` in the repo config to a regex that,
when it appears in the log, marks the environment ready.

> **Security note:** env hooks are arbitrary code, committed to the repo like
> any other file. ccw executes them automatically the moment you run
> `ccw <feature>` on a worktree — there is no prompt or sandbox. Review
> `.ccw/hooks/` before opening worktrees on a repo you don't fully trust,
> the same way you'd review a `postinstall` script or a Makefile.

## Plugins

ccw is built around a plugin system. Plugins extend ccw with capabilities like task lookup (Jira / Linear / GitHub Issues / …), environment setup (foreman, docker, …), and lifecycle hooks. They're bundled into the binary; enable them per-repo via `ccw init`.

Each plugin owns its own configuration flow (so its prompts stay in one place) and ships with its own README.

| Plugin | Capabilities  | Docs                                                       |
| ------ | ------------- | ---------------------------------------------------------- |
| `jira` | Task provider | [`src/plugins/jira/README.md`](src/plugins/jira/README.md) |

To disable all plugins, set `"plugins": {}` in your repo config. ccw still works — you just lose task detection and any plugin-provided lifecycle hooks.

## Security

Each release is signed and attested before publication. See [SECURITY.md](SECURITY.md) for the full policy, supported versions, and how to report vulnerabilities.

`ccw update` enforces three independent verification layers before installing any binary:

1. **SHA-256 manifest** — pins the binary's hash against a signed `SHA256SUMS` file.
2. **Minisign signature** — the manifest is signed by the ccw release key (public key embedded in every ccw binary).
3. **Sigstore attestation** — the binary is cryptographically tied to the GitHub Actions workflow run that produced it.

To manually verify a release:

```bash
# Download release assets
gh release download v0.1.0 --repo bibaswan-bhawal/ccw

# Verify the minisign signature
minisign -Vm SHA256SUMS -P RWTX1Db0eaMFBoWsAN0cI0XodrqfXrJeqPsHBqLfNB6UaSXUwGE74NhH

# Verify Sigstore build provenance for any binary
gh attestation verify ccw-macos-arm64 --owner bibaswan-bhawal
```

Homebrew users get the SHA-256 pin for free (brew checks the formula's hash on install). The signature and attestation chains kick in when `ccw update` runs.

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
