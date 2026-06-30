// Runs under `bun test` (NOT vitest): the PTY layer uses bun:ffi, which only
// resolves under the Bun runtime. vitest is configured to exclude tests/bun/**.
import { describe, expect, test } from 'bun:test';
import { closeSync, readSync } from 'node:fs';
import { isPtyAvailable, openPty, setWinsize, getWinsize } from '../../src/lib/pty/index.ts';

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
