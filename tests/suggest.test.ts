import { describe, expect, test } from 'vitest';
import { editDistance, findClosestMatch } from '../src/lib/suggest.ts';

describe('editDistance', () => {
  test('zero distance for equal strings', () => {
    expect(editDistance('ls', 'ls')).toBe(0);
  });

  test('one insertion', () => {
    expect(editDistance('ls', 'lsa')).toBe(1);
  });

  test('one deletion', () => {
    expect(editDistance('list', 'lis')).toBe(1);
  });

  test('one substitution', () => {
    expect(editDistance('help', 'hslp')).toBe(1);
  });

  test('handles empty strings', () => {
    expect(editDistance('', 'abc')).toBe(3);
    expect(editDistance('abc', '')).toBe(3);
    expect(editDistance('', '')).toBe(0);
  });

  test('multiple edits', () => {
    expect(editDistance('hlp', 'help')).toBe(1);
    expect(editDistance('hellpp', 'help')).toBe(2);
  });
});

describe('findClosestMatch', () => {
  const commands = ['init', 'ls', 'list', 'rm', 'remove', 'help', 'version'];

  test('finds exact typo corrections', () => {
    expect(findClosestMatch('hlp', commands)).toBe('help');
    expect(findClosestMatch('liiist', commands)).toBe('list');
    expect(findClosestMatch('remv', commands)).toBe('rm');
    expect(findClosestMatch('vrsion', commands)).toBe('version');
  });

  test('prefers the shortest match when tied', () => {
    // "la" is distance 1 from both "ls" and "list" — returns "ls" (found first, same distance)
    const result = findClosestMatch('la', commands);
    expect(result).toBe('ls');
  });

  test('case-insensitive match', () => {
    expect(findClosestMatch('HLP', commands)).toBe('help');
    expect(findClosestMatch('Init', commands)).toBe('init');
  });

  test('returns undefined for far-off input', () => {
    expect(findClosestMatch('gergegrege', commands)).toBeUndefined();
    expect(findClosestMatch('xyzzy', commands)).toBeUndefined();
  });

  test('respects custom max distance', () => {
    expect(findClosestMatch('hel', commands, 1)).toBe('help');
    expect(findClosestMatch('hel', commands, 0)).toBeUndefined();
  });
});
