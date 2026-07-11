import { describe, expect, test } from 'vitest';
import { isReservedName, RESERVED_NAMES } from '../src/lib/reserved.ts';

describe('reserved names', () => {
  test('subcommand names are reserved', () => {
    expect(isReservedName('init')).toBe(true);
    expect(isReservedName('ls')).toBe(true);
    expect(isReservedName('list')).toBe(true);
    expect(isReservedName('rm')).toBe(true);
    expect(isReservedName('remove')).toBe(true);
    expect(isReservedName('config')).toBe(true);
    expect(isReservedName('help')).toBe(true);
    expect(isReservedName('version')).toBe(true);
  });

  test('help/version flags are reserved', () => {
    expect(isReservedName('--help')).toBe(true);
    expect(isReservedName('-h')).toBe(true);
    expect(isReservedName('--version')).toBe(true);
    expect(isReservedName('-v')).toBe(true);
    expect(isReservedName('-V')).toBe(true);
  });

  test('case-insensitive', () => {
    expect(isReservedName('INIT')).toBe(true);
    expect(isReservedName('Help')).toBe(true);
    expect(isReservedName('Remove')).toBe(true);
  });

  test('normal feature names are not reserved', () => {
    expect(isReservedName('AHDOC-123-my-feature')).toBe(false);
    expect(isReservedName('fix-the-thing')).toBe(false);
    expect(isReservedName('rm-bench')).toBe(false); // prefix match, not equal
  });

  test('RESERVED_NAMES is not empty', () => {
    expect(RESERVED_NAMES.length).toBeGreaterThan(0);
  });

  test("'env' is reserved", () => {
    expect(isReservedName('env')).toBe(true);
    expect(isReservedName('ENV')).toBe(true);
  });
});
