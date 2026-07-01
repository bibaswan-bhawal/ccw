/**
 * Run Claude inside a PTY and proxy bytes between the real terminal and the
 * PTY master.
 *
 * Claude reads/writes the PTY *slave*, so it believes it's on a real terminal
 * (full TUI), while ccw stays in the input path only as a forwarder. Crucially,
 * Claude never reads ccw's fd 0 — ccw does — so there's no shared-fd contention
 * and no dropped keystrokes, even though ccw's event loop keeps running. That
 * live event loop is the whole point: it's what a future background-task
 * supervisor needs (the synchronous fallback freezes it for the session).
 */
import { appendFileSync, closeSync, createReadStream, writeSync } from 'node:fs';
import { setWinsize, terminalSize, type Pty } from './index.ts';

// Poll interval for the resize backstop. SIGWINCH handles the common case
// instantly; this catches terminals that resize the grid without delivering
// SIGWINCH (e.g. Warp toggling its side panel). Cheap: two ioctls per tick.
const RESIZE_POLL_MS = 500;

// Set CCW_PTY_DEBUG=/path/to/log to trace resize handling. Off by default; must
// go to a file, never stdout (that's the live terminal the child is drawing to).
const debug: (msg: string) => void = process.env.CCW_PTY_DEBUG
  ? (msg) => {
      try {
        appendFileSync(process.env.CCW_PTY_DEBUG as string, `${new Date().toISOString()} ${msg}\n`);
      } catch {
        /* debug logging is best-effort */
      }
    }
  : () => {};

export async function runClaudeInPty(pty: Pty, args: string[], cwd: string): Promise<number> {
  // Spawn first; if this throws, the caller cleans up the PTY and falls back.
  const proc = Bun.spawn(['claude', ...args], {
    cwd,
    stdin: pty.slave,
    stdout: pty.slave,
    stderr: pty.slave,
  });

  // The child now owns the slave. Drop our copy so the master sees EOF when the
  // child exits (otherwise the read stream below would never end).
  try {
    closeSync(pty.slave);
  } catch {
    /* already closed */
  }

  const stdin = process.stdin;
  const stdout = process.stdout;
  // Clear any stdin handling left over from earlier Ink UI before we take over.
  stdin.removeAllListeners('readable');
  stdin.removeAllListeners('data');
  const restoreRaw = stdin.isTTY ? (stdin.isRaw ?? false) : false;
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();

  // master -> screen
  const masterRead = createReadStream(null as unknown as string, { fd: pty.master, autoClose: false });
  masterRead.on('data', (chunk) => stdout.write(chunk));
  masterRead.on('error', () => {
    /* EIO when the slave closes is the normal end-of-session signal */
  });

  // keyboard -> master. Normalise to a Buffer in case stdin has a string
  // encoding left over from earlier Ink UI.
  const onInput = (chunk: Buffer | string): void => {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    try {
      writeSync(pty.master, buf);
    } catch {
      /* master closed mid-write — session is ending */
    }
  };
  stdin.on('data', onInput);

  // terminal resize -> PTY. Read the real terminal's size straight from the fd
  // (TIOCGWINSZ) rather than process.stdout.columns/rows, which Bun caches and
  // refreshes inconsistently. Only push when it actually changes, so we don't
  // spam Claude with redundant SIGWINCHs.
  const termFd = typeof stdout.fd === 'number' ? stdout.fd : 1;
  let lastRows = 0;
  let lastCols = 0;
  const syncWinsize = (source: string): void => {
    const size = terminalSize(termFd) ?? { rows: stdout.rows ?? 24, cols: stdout.columns ?? 80 };
    if (size.rows === lastRows && size.cols === lastCols) return;
    lastRows = size.rows;
    lastCols = size.cols;
    setWinsize(pty.master, size.rows, size.cols);
    // Setting the master's winsize only delivers SIGWINCH to the slave's
    // controlling process group. Claude was spawned without being made the
    // slave's session/controlling terminal, so that automatic signal never
    // reaches it — which is why a single resize (e.g. a Warp panel toggle)
    // doesn't reflow, while a drag's flood of terminal SIGWINCHs eventually
    // does. Signal Claude explicitly so it re-reads its size every time.
    if (proc.pid) {
      try {
        process.kill(proc.pid, 'SIGWINCH');
      } catch {
        /* child already gone */
      }
    }
    debug(`resize(${source}) -> ${size.cols}x${size.rows} -> pid ${proc.pid}`);
  };
  process.on('SIGWINCH', () => syncWinsize('sigwinch'));
  // Backstop for terminals that change the grid without sending SIGWINCH.
  const resizePoll = setInterval(() => syncWinsize('poll'), RESIZE_POLL_MS);

  let exitCode = 0;
  try {
    exitCode = await proc.exited;
    // Let the last master output flush before we tear the stream down. EOF
    // ('close') arrives once the child's slave is gone; cap the wait so a stuck
    // fd can't hang exit.
    await Promise.race([
      new Promise<void>((resolve) => masterRead.once('close', resolve)),
      new Promise<void>((resolve) => setTimeout(resolve, 200)),
    ]);
  } finally {
    clearInterval(resizePoll);
    process.removeListener('SIGWINCH', syncWinsize);
    stdin.removeListener('data', onInput);
    masterRead.destroy();
    try {
      closeSync(pty.master);
    } catch {
      /* already closed */
    }
    if (stdin.isTTY && !restoreRaw) stdin.setRawMode(false);
    stdin.pause();
  }
  return exitCode;
}
