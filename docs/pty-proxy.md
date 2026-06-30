# PTY proxy — design notes & feasibility findings

Status: **implemented behind a fallback; pending interactive validation on real
terminals + non-macOS-arm64 platforms.**

## Implementation

- `src/lib/pty/winsize.c` — header-free TinyCC source: non-variadic
  `ccw_set_winsize`/`ccw_get_rows`/`ccw_get_cols` wrapping the variadic `ioctl`.
- `src/lib/pty/index.ts` — `dlopen(openpty)` + extract the embedded `winsize.c`
  to a temp path and `cc()`-compile it. `isPtyAvailable()`, `openPty()`,
  `setWinsize()`. All best-effort; any failure → `isPtyAvailable() === false`.
- `src/lib/pty/proxy.ts` — `runClaudeInPty()`: spawn Claude on the slave, raw
  the real terminal, `createReadStream(master) → stdout`, `stdin → writeSync(master)`,
  `SIGWINCH → setWinsize`, restore + close on exit.
- `src/lib/claude.ts` — `launchClaude()` dynamically imports the PTY layer
  (keeps `bun:ffi` out of the vitest path), uses it when both stdio are TTYs and
  `CCW_NO_PTY` is unset, and falls back to the synchronous `spawnSync` otherwise
  or on any PTY init failure. PTY allocation happens before spawn, so a failure
  can never double-spawn Claude.
- Tests: `tests/bun/pty.test.ts` runs under `bun test` (the layer needs the Bun
  runtime); vitest excludes `tests/bun/**`. `npm test` runs both.

Opt out at runtime with `CCW_NO_PTY=1`.

### Validated

- Compiled-binary path: embed → extract-to-temp → `cc` → ioctl works in a
  `bun build --compile` binary on macOS arm64 (set 24×80, read back 24/80).
- `bun test`: openpty alloc, winsize set/get roundtrip, resize, child-on-slave
  sees a TTY and its output reaches the master.

### NOT yet validated (needs a human at a real terminal)

- End-to-end interactive session: keystroke fidelity, paste, Ctrl-C, mid-session
  resize redraw, exit/restore.
- TinyCC + openpty on Linux x64 and macOS x64 (only arm64-darwin tested here).
  The `spawnSync` fallback covers failures, but post-init glitches need eyes.

## Goal

Host Claude inside a pseudo-terminal that ccw owns, instead of spawning it
directly. ccw proxies bytes between the real terminal and the PTY master. This:

- **Fixes dropped keystrokes for good** — Claude reads from the PTY _slave_, not
  ccw's fd 0, so there is no shared-fd contention even with ccw's event loop
  running. (The shipped `spawnSync` fix in 0.2.1 also solves the keystroke bug,
  but only by freezing ccw's loop for the whole session.)
- **Keeps ccw's event loop alive** during the session, which is what a future
  background-task / environment supervisor needs (live log multiplexing, crash
  detection, restart). `spawnSync` forecloses that; a PTY proxy enables it.

## What was validated (macOS arm64, Bun 1.3.14)

All proven with throwaway probes:

1. **`openpty` via `bun:ffi` + `dlopen`** works and is compile-safe (runtime
   dlopen of a system lib, no addon). Lib: `libSystem.B.dylib` on macOS,
   `libutil.so.1` on Linux.
2. **Child sees a TTY**: `Bun.spawn(['claude', ...], { stdin: slave, stdout:
slave, stderr: slave })` — `test -t 1` returns true in the child.
3. **Async master reads**: `fs.createReadStream(null, { fd: master, autoClose:
false })` streams child output live under Bun. (`net.Socket({fd})` reads
   nothing; `Bun.file(fd).stream()` returns empty — it stats a char device as
   size 0. Both dead ends.)
4. **Master writes** (forward keystrokes): `fs.writeSync(master, chunk)` works.
5. PTY line discipline is real (ONLCR `\n`→`\r\n` observed).

## The blocker: live resize on macOS arm64

Forwarding terminal resize requires `ioctl(masterFd, TIOCSWINSZ, &winsize)`.
`ioctl` is variadic (`int ioctl(int, unsigned long, ...)`). On **arm64-darwin**
the variadic ABI passes the variadic args on the **stack**, but Bun FFI (no
variadic support) marshals the pointer into a register → the kernel writes the
winsize to a garbage address → wrong size, then segfault on readback. Works on
Linux x64 / macOS x64 (their variadic + fixed conventions coincide), but
**segfaults on Apple Silicon**, which is a primary user platform.

Escapes evaluated:

- **`cc` (inline TinyCC) header-free wrapper** — a non-variadic
  `ccw_set_winsize(fd, rows, cols)` whose C body calls variadic `ioctl`
  correctly. ✅ Works at runtime. ❌ **Not bundled into `bun build --compile`**:
  TinyCC tries to read the source from the embedded `/$bunfs/` path at runtime
  and fails (`file not found`). So it's unusable in the distributed binary.
- **Plain FFI ioctl** — segfaults on arm64-darwin (see above).
- **Disable PTY on arm64-darwin** — defeats the purpose (that's most users).

Without resize, a PTY proxy is a **regression** vs `spawnSync` (where Claude
holds the real terminal and resize works natively), so resize is mandatory.

## How the blocker was solved (no native dylibs needed)

The key realization: the `cc` failure in a compiled binary was _only_ the source
path. TinyCC itself **is bundled** in the compiled binary and runs — it just
couldn't read the embedded `/$bunfs/` path. So:

1. Embed `winsize.c` via `import ... with { type: 'file' }`.
2. At runtime, read the embedded source with Bun's fs API (which _does_ work on
   embedded assets) and write it to a real temp file.
3. `cc({ source: tempPath })` — TinyCC compiles from the real path and emits a
   correct variadic `ioctl` call on every arch, including arm64-darwin.

Verified end-to-end in an actual `bun build --compile` binary (set 24×80 → read
back 24/80). This removes the entire prebuilt-per-arch-dylib path: no extra CI
build targets, no macOS runners, no extract-and-`dlopen`, no signing concerns.

If TinyCC or openpty ever fails on some platform, `isPtyAvailable()` returns
false and `launchClaude` falls back to the synchronous `spawnSync` — so the
worst case is "no PTY there," never a crash or regression.
