/**
 * Pseudo-terminal primitives via bun:ffi.
 *
 * - `openpty(3)` is loaded by dlopen of a system library (no native addon, so
 *   it survives `bun build --compile`).
 * - The window-size setter is compiled at runtime from winsize.c by Bun's
 *   bundled TinyCC. We must extract the embedded source to a real temp path
 *   first: TinyCC cannot read the `/$bunfs/` virtual path inside a compiled
 *   binary. See winsize.c for why a C wrapper is needed at all (variadic ioctl
 *   segfaults under plain FFI on arm64-darwin).
 *
 * Everything here is best-effort: if dlopen or the TinyCC compile fails on some
 * platform, {@link isPtyAvailable} returns false and the caller falls back to a
 * plain synchronous spawn. We never crash trying to set up a PTY.
 */
import { cc, dlopen, FFIType, ptr } from 'bun:ffi';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import winsizeSource from './winsize.c' with { type: 'file' };

export interface Pty {
  master: number;
  slave: number;
}

interface Native {
  /** Calls openpty(amaster,aslave,NULL,NULL,NULL); fds land in the arrays below. */
  callOpenpty: () => number;
  amaster: Int32Array;
  aslave: Int32Array;
  setWinsize: (fd: number, rows: number, cols: number) => number;
  getRows: (fd: number) => number;
  getCols: (fd: number) => number;
}

// macOS: libSystem re-exports openpty. Linux: it lives in libutil.
const OPENPTY_LIB = process.platform === 'darwin' ? 'libSystem.B.dylib' : 'libutil.so.1';

let native: Native | null = null;
let initTried = false;

function initNative(): Native | null {
  if (initTried) return native;
  initTried = true;
  try {
    const util = dlopen(OPENPTY_LIB, {
      openpty: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
        returns: FFIType.i32,
      },
    });

    // TinyCC can't read the embedded /$bunfs/ source path, so stage it on disk.
    // Bun's fs API *can* read the embedded asset, even in a compiled binary.
    const dir = mkdtempSync(join(tmpdir(), 'ccw-pty-'));
    const cPath = join(dir, 'winsize.c');
    try {
      writeFileSync(cPath, readFileSync(winsizeSource, 'utf8'));
      const compiled = cc({
        source: cPath,
        symbols: {
          ccw_set_winsize: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
          ccw_get_rows: { args: [FFIType.i32], returns: FFIType.i32 },
          ccw_get_cols: { args: [FFIType.i32], returns: FFIType.i32 },
        },
      });

      const amaster = new Int32Array(1);
      const aslave = new Int32Array(1);
      native = {
        callOpenpty: () => util.symbols.openpty(ptr(amaster), ptr(aslave), null, null, null),
        amaster,
        aslave,
        setWinsize: (fd, rows, cols) => compiled.symbols.ccw_set_winsize(fd, rows, cols),
        getRows: (fd) => compiled.symbols.ccw_get_rows(fd),
        getCols: (fd) => compiled.symbols.ccw_get_cols(fd),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    native = null;
  }
  return native;
}

/** True if openpty + the TinyCC winsize wrapper initialised successfully. */
export function isPtyAvailable(): boolean {
  return initNative() !== null;
}

/** Allocate a PTY sized to (rows, cols). Throws if the PTY layer is unavailable. */
export function openPty(rows: number, cols: number): Pty {
  const n = initNative();
  if (!n) throw new Error('PTY layer unavailable');
  const rc = n.callOpenpty();
  if (rc !== 0) throw new Error(`openpty failed (rc=${rc})`);
  const pty: Pty = { master: n.amaster[0]!, slave: n.aslave[0]! };
  setWinsize(pty.master, rows, cols);
  return pty;
}

/** Set a PTY's window size. Best-effort; returns whether it succeeded. */
export function setWinsize(fd: number, rows: number, cols: number): boolean {
  const n = initNative();
  if (!n) return false;
  return n.setWinsize(fd, Math.max(1, rows | 0), Math.max(1, cols | 0)) === 0;
}

/** Test-only: read back a PTY's configured size (raw, may contain -1 on error). */
export function getWinsize(fd: number): { rows: number; cols: number } | null {
  const n = initNative();
  if (!n) return null;
  return { rows: n.getRows(fd), cols: n.getCols(fd) };
}

/**
 * Read a terminal's *current* size straight from the kernel via TIOCGWINSZ.
 * This is the authoritative size — unlike process.stdout.columns/rows, which is
 * a cached value Bun refreshes inconsistently (e.g. it can miss a Warp side-
 * panel toggle that changes the grid without a window resize). Returns null if
 * unavailable or the fd isn't a sized terminal.
 */
export function terminalSize(fd: number): { rows: number; cols: number } | null {
  const n = initNative();
  if (!n) return null;
  const rows = n.getRows(fd);
  const cols = n.getCols(fd);
  if (rows <= 0 || cols <= 0) return null;
  return { rows, cols };
}
