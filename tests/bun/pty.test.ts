// Runs under `bun test` (NOT vitest): the PTY layer uses bun:ffi, which only
// resolves under the Bun runtime. vitest is configured to exclude tests/bun/**.
import { describe, expect, test } from 'bun:test';
import { closeSync, createReadStream, readSync } from 'node:fs';
import { isPtyAvailable, openPty, setWinsize, getWinsize, terminalSize } from '../../src/lib/pty/index.ts';

describe('pty layer', () => {
  test('is available on this platform', () => {
    expect(isPtyAvailable()).toBe(true);
  });

  test('openPty allocates a master/slave pair sized to the request', () => {
    const pty = openPty(30, 90);
    try {
      expect(pty.master).toBeGreaterThanOrEqual(0);
      expect(pty.slave).toBeGreaterThanOrEqual(0);
      expect(getWinsize(pty.master)).toEqual({ rows: 30, cols: 90 });
    } finally {
      closeSync(pty.slave);
      closeSync(pty.master);
    }
  });

  test('setWinsize updates the size (the resize path)', () => {
    const pty = openPty(24, 80);
    try {
      expect(setWinsize(pty.master, 50, 120)).toBe(true);
      expect(getWinsize(pty.master)).toEqual({ rows: 50, cols: 120 });
    } finally {
      closeSync(pty.slave);
      closeSync(pty.master);
    }
  });

  test('terminalSize reads the authoritative size and nulls on a non-terminal fd', () => {
    const pty = openPty(33, 111);
    try {
      // A real PTY fd reports its size...
      expect(terminalSize(pty.master)).toEqual({ rows: 33, cols: 111 });
    } finally {
      closeSync(pty.slave);
      closeSync(pty.master);
    }
    // ...and a non-terminal fd (e.g. a pipe) returns null rather than -1s.
    expect(terminalSize(2_000_000_000)).toBeNull();
  });

  test('a child re-reads its size after setWinsize + an explicit SIGWINCH (the resize fix)', async () => {
    const pty = openPty(24, 80);
    // A child (run under the same Bun) that reports its terminal size when it
    // receives SIGWINCH — the way Claude reflows — then exits. It reads the size
    // via stty on fd 0 (the slave), the authoritative source. A safety timeout
    // guarantees it never lingers and hangs the test runner.
    const childSrc = [
      "const { execSync } = require('node:child_process');",
      "process.stdout.write('READY\\n');",
      'process.on("SIGWINCH", () => {',
      "  try { process.stdout.write('WINCH ' + execSync('stty size', { stdio: ['inherit', 'pipe', 'ignore'] }).toString().trim() + '\\n'); }",
      "  catch { process.stdout.write('WINCH err\\n'); }",
      '  process.exit(0);',
      '});',
      'setTimeout(() => process.exit(1), 3000);',
    ].join('\n');
    const child = Bun.spawn([process.execPath, '-e', childSrc], {
      stdin: pty.slave,
      stdout: pty.slave,
      stderr: pty.slave,
    });
    // Child owns the slave now; drop ours so the master EOFs when the child dies.
    closeSync(pty.slave);
    let out = '';
    const rs = createReadStream(null as unknown as string, { fd: pty.master, autoClose: false });
    rs.on('data', (d) => (out += d.toString()));
    rs.on('error', () => {});
    try {
      await new Promise((r) => setTimeout(r, 400));
      // Updating the master's winsize propagates to the slave; the explicit
      // SIGWINCH then makes the child re-read it. Without the signal the child
      // never learns (it isn't the slave's controlling process) — the Warp
      // panel-toggle bug this guards against.
      setWinsize(pty.master, 44, 130);
      process.kill(child.pid, 'SIGWINCH');
      await child.exited;
      expect(out).toContain('44 130');
    } finally {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already exited */
      }
      rs.destroy();
      try {
        closeSync(pty.master);
      } catch {
        /* already closed */
      }
    }
  });

  test('a child spawned on the slave sees a TTY and its output reaches the master', () => {
    const pty = openPty(24, 80);
    try {
      const res = Bun.spawnSync(['sh', '-c', 'test -t 1 && echo IS_A_TTY; echo done'], {
        stdin: pty.slave,
        stdout: pty.slave,
        stderr: pty.slave,
      });
      expect(res.success).toBe(true);

      // Read the master with the slave still open (closing it first can discard
      // queued output on macOS).
      const buf = Buffer.alloc(4096);
      const n = readSync(pty.master, buf, 0, buf.length, null);
      const out = buf.subarray(0, Math.max(0, n)).toString('utf8');
      expect(out).toContain('IS_A_TTY');
      expect(out).toContain('done');
    } finally {
      closeSync(pty.slave);
      closeSync(pty.master);
    }
  });
});
