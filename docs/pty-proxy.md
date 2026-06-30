# PTY proxy — design notes & feasibility findings

Status: **investigation complete, implementation paused on a portability blocker.**

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

## Remaining path to ship it

Prebuilt per-arch native helper:

1. Compile `ccw-pty-{macos-arm64,macos-x64,linux-x64}.{dylib,so}` in CI (CI has
   real compilers) exposing non-variadic `ccw_set_winsize`.
2. Embed each via `import ... with { type: 'file' }`; at runtime read the
   embedded bytes (Bun's file API _does_ work on embedded assets in compiled
   binaries, unlike TinyCC), write to a temp path, `dlopen` it.
3. Initial size still comes from `openpty`'s `winp` arg (non-variadic, FFI-safe)
   so first paint is correct even before the dylib loads.

Cost: 3 build targets, larger binary, extract-and-dlopen at startup, temp
cleanup, and validation that an extracted unsigned dylib loads cleanly under the
brew-distributed (minisign/Sigstore, not Apple-notarized) binary.

## Recommendation

Pause here. The user-facing keystroke bug is already fixed and shipped (0.2.1).
The PTY proxy is infrastructure for the not-yet-started background-task feature,
and the clean portable path is blocked by current Bun limitations. Resume this
when background-task work actually begins — and re-check whether Bun has gained
variadic FFI or `cc`-in-compiled-binary support by then, which would collapse
the native-dylib step entirely.
