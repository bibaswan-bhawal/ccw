# Isolated Environments for Worktrees — Design

**Date:** 2026-07-10
**Status:** Approved

## Problem

ccw reduces the overhead of working on many ideas/tickets in parallel, but a fresh
worktree is not runnable: gitignored files are missing, dependencies aren't installed,
and each project has its own way of running locally (dermose_care's parallel-branch dev
tooling, apm_bundle's docker + foreman stack). Today the user does all of that by hand,
and Claude has no way to see or use the running environment.

Goal: when `ccw <feature>` runs, ccw loads task context (existing), starts the project's
isolated environment in the background, and connects Claude to it so Claude can read its
state and use it for testing.

ccw cannot know how every project runs. It provides the lifecycle scaffolding — hook
discovery, background process ownership, state tracking, teardown, Claude integration —
and projects provide the "how" through hook scripts. Flexibility is the primary design
value.

## Constraints (learned from prior work)

- **ccw must do near-zero work while Claude runs.** ccw hosts Claude behind a PTY proxy;
  earlier in-session work caused dropped-input bugs that took multiple fixes
  (`relinquishStdin`, the spawnSync fallback, the PTY proxy itself). All environment
  operations happen before Claude launches, after `launchClaude` returns, or in a
  separate short-lived `ccw env` invocation. No in-session watchers, timers, or tails.
- **ccw never touches the working tree** for its own state. Hooks may be committed by
  projects that want them shared; ccw's runtime state lives under `~/.ccw`.
- Must work in both launch paths (PTY and spawnSync fallback) identically.

## Architecture summary

Detached processes + evidence-based state file, supervised lazily:

- `env-start` is spawned **detached in its own process group**, logs redirected to a
  file. ccw records the PID and metadata in a per-worktree `state.json` under `~/.ccw`.
- Nothing watches the process. Every reader (`ccw env status`, `ccw ls`, teardown)
  re-derives truth on demand: check PID liveness, prune attachments whose ccw process is
  dead, grep the log for a ready pattern. State that can be re-verified against the OS
  cannot rot after a crash.
- Teardown happens when the last attached Claude session exits, on `ccw rm`, or on
  explicit `ccw env stop`.

Rejected alternatives:

- **In-session supervision** (ccw's own process holds the env as a child): breaks under
  the near-zero-in-session-work constraint, orphans the environment if the terminal or
  ccw dies, and silently degrades on the spawnSync fallback path.
- **Dedicated supervisor daemon:** most robust (auto-restart, socket status) but a whole
  second program to build, version, and debug. Can grow out of this design later if
  auto-restart ever matters.
- **Dynamically loaded JS plugins** as the extension surface: runtime import from a
  compiled Bun binary is risky and forces env authors into TypeScript against ccw's API.
  Hooks are language-agnostic and maximally flexible.

## §1 Hook contract

Four well-known hooks. Discovery order: `<repo>/.ccw/hooks/` (committed, team-shared)
wins over `~/.ccw/repos/<encoded-git-root>/hooks/` (personal; for repos where committing
ccw files is unwelcome). A hook is any file with the exec bit — shell, ruby, anything.
All hooks are optional and behavior degrades per missing hook.

| Hook | When | Contract |
| --- | --- | --- |
| `env-setup` | Once per worktree at creation, blocking (before Claude) | One-time provisioning: copy `.env`, install deps, create db. Non-zero exit → warn, continue without environment. Re-run by `ccw env start` if it never succeeded. |
| `env-start` | Every `ccw <feature>` (create and resume) when env not running; detached | Either a long-running foreground process (foreman) or a self-daemonizing script (`docker compose up -d`). stdout/stderr → `env.log`. |
| `env-stop` | Last session out, `ccw rm`, `ccw env stop` | Graceful teardown. If absent, ccw signals the process group: SIGTERM → grace → SIGKILL. |
| `env-status` | On demand only | Prints JSON to stdout: `{ "ready": bool, "services": [{ "name", "url", "status" }], ... }`. If absent, fallback is PID liveness + optional `ready_pattern` grep. |

Hooks receive context as environment variables (no argv parsing):

```
CCW_WORKTREE_PATH    absolute path to this worktree
CCW_WORKTREE_NAME    feature name, e.g. PROJ-123-add-thing
CCW_GIT_ROOT         the main checkout (source for .env copies)
CCW_ENV_DIR          ~/.ccw/repos/<repo>/env/<worktree>/scratch — free space for hooks
CCW_WORKTREE_SLOT    stable small integer unique per active worktree in this repo
```

`CCW_WORKTREE_SLOT` is a generic per-worktree uniqueness token, not a port number.
Hooks map it onto whatever namespace their platform collides in: ports
(`$((3000 + SLOT))`), emulator/simulator pool indexes, `COMPOSE_PROJECT_NAME` suffixes,
display numbers, scratch db names. Allocation is lowest-free-integer (dense, like fd
numbering — active worktrees hold small numbers even after many worktrees have come and
gone), persisted in the state file, freed by `ccw rm`.

Hook working directory: the worktree (respecting `app_subdir`).

Repo config gains an optional block:

```json
{
  "environment": {
    "ready_pattern": "Listening on"
  }
}
```

## §2 State + process management

Layout (all under the per-repo data dir, never in the working tree):

```
~/.ccw/repos/<encoded-git-root>/
  config.json                    existing
  env/
    <feature-name>/
      state.json                 durable record, below
      env.log                    env-start stdout+stderr, append-only
      scratch/                   CCW_ENV_DIR — pidfiles, sockets, hook scratch
```

`state.json`:

```json
{
  "slot": 0,
  "phase": "running",
  "pid": 43210,
  "startedAt": "2026-07-10T18:02:11Z",
  "setupCompletedAt": "2026-07-10T18:01:40Z",
  "attachedSessions": [{ "sessionId": "…uuid…", "ccwPid": 40021 }]
}
```

- `phase`: `setup | starting | running | stopped | failed`.
- `pid`: the detached `env-start` process-group leader. May be dead if the hook
  self-daemonized and exited; that shape is detected at start (exited 0, nothing alive
  in the group) and triggers a one-time warning if no `env-stop` hook exists, since ccw
  then has no way to tear the environment down.
- `setupCompletedAt` present ⇒ `env-setup` succeeded once; don't re-run.

**Spawning:** `Bun.spawn` detached with its own session/process group, stdio redirected
to `env.log`. Teardown prefers the `env-stop` hook; otherwise SIGTERM to the process
group, SIGKILL after a grace period.

**Readiness is computed lazily, never watched:** `env-status` hook if present; else
`ready_pattern` grep of `env.log`; else PID liveness is the whole answer.

**Reference counting with evidence, not counters:** each `ccw <feature>` appends
`{sessionId, ccwPid}` before launching Claude and removes itself after `launchClaude`
returns; removing the last entry triggers teardown. Because a crashed ccw can't
decrement, every state read first prunes entries whose `ccwPid` is dead. A killed
terminal self-heals on the next status/ls/create.

Teardown-on-prune rule: pruning that takes `attachedSessions` from non-empty to empty
triggers teardown (a crashed terminal must not leave the environment running forever).
An environment started explicitly via `ccw env start` has an empty list from the outset
— empty→empty on read is not a transition, so it keeps running until a session lifecycle
ends it or `ccw env stop` is called.

**Concurrency:** atomic writes (temp file + rename); mutations take a `state.lock`
(`O_EXCL`, stale-lock detection via recorded PID). Two ccw invocations racing on the
same worktree is rare but real.

## §3 Command surface + flow changes

New command `ccw env <sub>` — resolves the feature from `cwd` when run inside a
worktree, or explicitly: `ccw env <sub> <feature>`.

| Subcommand | Behavior |
| --- | --- |
| `ccw env status` | Prune stale attachments, check liveness, run `env-status` hook; `--json` for scripts/Claude |
| `ccw env logs` | Tail `env.log` (`-n`, `--follow`) |
| `ccw env start` | Start if not running (runs setup first if it never succeeded) |
| `ccw env stop` | Teardown even with attached sessions (explicit override) |
| `ccw env restart` | stop + start |

**Create flow additions** (all outside the Claude session):

1. After worktree creation: if `env-setup` exists, run blocking with a spinner,
   output → `env.log`. Failure → warn, skip environment, continue to Claude.
2. If `env-start` exists: allocate slot, spawn detached, attach session, print
   `Environment starting in background (ccw env status)`. No waiting.
3. Append an environment section to the system prompt alongside task context:

   > A development environment for this worktree is starting in the background.
   > - Check state: `ccw env status --json`
   > - Logs: `ccw env logs` (file: <env.log path>)
   > - Restart after config changes: `ccw env restart`
   > Verify the environment is ready before using it for testing.

4. After `launchClaude` returns: detach session; last one out → teardown.

**Resume flow:** ensure env running (start if stopped), attach, inject the same prompt
section, launch, detach on exit. Caveat: `--resume` currently passes no system prompt;
whether `--append-system-prompt` works with `--resume` must be verified during
implementation. If unsupported, resumed sessions rely on session-one memory plus
`ccw env --help` discoverability — acceptable.

**`ccw ls`:** env badge (`● env` green/gray) from PID liveness only — no hook execution,
picker stays instant.

**`ccw rm`:** teardown, free slot, delete `env/<feature>/`.

**Claude integration phases:** v1 is prompt injection + `ccw env` subcommands +
`env-status` JSON. Exposing the environment as MCP tools is a later phase, out of scope
here.

## §4 Error handling & edge cases

- `env-setup` fails → warn with exit code + last log lines, `phase: "failed"`, continue
  to Claude without environment. Retry via `ccw env start`.
- `env-start` dies immediately → next `ccw env status` finds the dead PID, flips phase
  to `failed`, shows log tail.
- Hook present but not executable → explicit warning naming the file and the `chmod +x`
  fix. Silent skips are reserved for absent hooks; repos with no hooks see zero
  environment noise.
- `env-stop` hangs/fails → ~30s timeout, then group SIGTERM → grace → SIGKILL. Teardown
  must never hang the user's terminal.
- Corrupt `state.json` → treat as no environment, rename to `state.json.bak`, rebuild on
  next start. Never crash a command over bookkeeping.
- Self-daemonizing hook without `env-stop` → one-time warning at start; status still
  works via `env-status`.
- Worktree removed manually (bypassing `ccw rm`) → env dir orphans harmlessly
  out-of-tree; `ccw env stop <feature>` still works.
- Slot exhaustion → none; slots are unbounded, density comes from freeing on rm.

## §5 Testing

vitest + existing `tests/` tree; `CCW_DATA_DIR` redirects all state to a temp dir.

- **Unit:** slot allocation (lowest-free, stable, freed on rm); hook discovery
  precedence and exec-bit check; state read/prune (dead `ccwPid` removed, last-out
  detection); atomic write + stale-lock recovery; `ready_pattern` grep on fixture logs.
- **Process integration:** real dummy scripts spawned detached — group kill terminates
  children; self-daemonizing shape detection; `env-status` JSON parsing incl. malformed
  output.
- **Command-level:** `ccw env status/logs` against fixture state dirs; create flow
  assembles the right `claudeArgs` (env prompt section present/absent) without launching
  Claude — same style as existing session tests.
- **Regression guard:** crash recovery — state file with a dead attacher PID → status
  prunes it and teardown eligibility is correct.
- **Real-world validation:** the dermose_care project (which already has parallel
  branch/worktree dev tooling) is the dogfood target — write its `.ccw/hooks/` against
  this contract and exercise the full create → background start → Claude status/logs →
  exit teardown loop before calling the feature done.
