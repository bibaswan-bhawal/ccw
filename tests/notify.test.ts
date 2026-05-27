import { describe, expect, test } from 'vitest';
import { nagMessage } from '../src/lib/update/notify.ts';
import type { UpdateCheck } from '../src/lib/update/check.ts';

function cacheWith(latestTag: string | null): UpdateCheck {
  return {
    checkedAt: Date.now(),
    currentVersion: '0.1.0',
    latest:
      latestTag === null
        ? null
        : {
            tag: latestTag,
            url: `https://example.com/${latestTag}`,
            publishedAt: '2026-05-01T00:00:00Z',
            prerelease: false,
            assets: [],
          },
  };
}

describe('nagMessage', () => {
  test('returns undefined when there is no cache', () => {
    expect(nagMessage(undefined, '0.1.0')).toBeUndefined();
  });

  test('returns undefined when cache.latest is null (no releases yet)', () => {
    expect(nagMessage(cacheWith(null), '0.1.0')).toBeUndefined();
  });

  test('returns undefined when running version matches the latest release', () => {
    expect(nagMessage(cacheWith('v0.1.0'), '0.1.0')).toBeUndefined();
  });

  test('returns undefined when the running version is newer than the cached latest', () => {
    // E.g. user just ran `ccw update` and the cache hasn't been refreshed yet.
    expect(nagMessage(cacheWith('v0.1.0'), '0.2.0')).toBeUndefined();
  });

  test('returns a nag when the cached latest is newer than current version', () => {
    const message = nagMessage(cacheWith('v0.2.0'), '0.1.0');
    expect(message).toBeDefined();
    expect(message).toContain('v0.2.0');
    expect(message).toContain('ccw update');
  });

  test('handles prerelease versions correctly', () => {
    expect(nagMessage(cacheWith('v0.2.0-rc.1'), '0.2.0')).toBeUndefined();
    expect(nagMessage(cacheWith('v0.2.0-rc.2'), '0.2.0-rc.1')).toBeDefined();
  });
});
