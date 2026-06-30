import { describe, expect, test } from 'vitest';
import { isRunningFromSource, looksLikeBrewPath } from '../src/lib/update/platform.ts';

describe('looksLikeBrewPath', () => {
  test('matches a resolved Cellar path (what process.execPath actually is)', () => {
    // The bug: process.execPath resolves the /opt/homebrew/bin/ccw symlink to
    // its Cellar target, which the old bin-prefix-only check missed.
    expect(looksLikeBrewPath('/opt/homebrew/Cellar/ccw/0.3.0/bin/ccw')).toBe(true);
    expect(looksLikeBrewPath('/home/linuxbrew/.linuxbrew/Cellar/ccw/0.3.0/bin/ccw')).toBe(true);
  });

  test('still matches the bin symlink dirs', () => {
    expect(looksLikeBrewPath('/opt/homebrew/bin/ccw')).toBe(true);
    expect(looksLikeBrewPath('/usr/local/bin/ccw')).toBe(true);
  });

  test('rejects a non-brew install path', () => {
    expect(looksLikeBrewPath('/Users/me/.local/bin/ccw')).toBe(false);
    expect(looksLikeBrewPath('/Users/me/code/ccw/dist/ccw')).toBe(false);
  });
});

describe('isRunningFromSource', () => {
  test('true when running under a JS runtime (the dev wrapper case)', () => {
    // This is exactly the path that let `ccw update` overwrite Homebrew's bun.
    expect(isRunningFromSource('/opt/homebrew/Cellar/bun/1.3.14/bin/bun')).toBe(true);
    expect(isRunningFromSource('/usr/local/bin/node')).toBe(true);
    expect(isRunningFromSource('/home/me/.deno/bin/deno')).toBe(true);
  });

  test('false for the compiled ccw binary', () => {
    expect(isRunningFromSource('/opt/homebrew/Cellar/ccw/0.3.0/bin/ccw')).toBe(false);
    expect(isRunningFromSource('/Users/me/.local/bin/ccw')).toBe(false);
    expect(isRunningFromSource('/Users/me/.local/bin/ccw-macos-arm64')).toBe(false);
  });
});
