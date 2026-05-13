import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// credentials.ts derives its directory from os.homedir(); point that at a
// temp dir per test so we don't touch the real ~/.ccw on the developer's
// machine.
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ccw-creds-'));
  vi.doMock('node:os', async () => {
    const actual = await vi.importActual<typeof import('node:os')>('node:os');
    return { ...actual, homedir: () => tmp };
  });
});

afterEach(() => {
  vi.doUnmock('node:os');
  vi.resetModules();
  rmSync(tmp, { recursive: true, force: true });
});

describe('credentials', () => {
  test('readCredentials returns undefined when nothing is stored', async () => {
    const { readCredentials } = await import('../src/lib/credentials.ts');
    expect(readCredentials('nope')).toBeUndefined();
  });

  test('write then read round-trips JSON', async () => {
    const { readCredentials, writeCredentials } = await import('../src/lib/credentials.ts');
    writeCredentials('jira', { token: 'abc123' });
    expect(readCredentials<{ token: string }>('jira')).toEqual({ token: 'abc123' });
  });

  test('credentials file is created with mode 0600', async () => {
    const { writeCredentials } = await import('../src/lib/credentials.ts');
    writeCredentials('jira', { token: 'secret' });
    const path = join(tmp, '.ccw', 'credentials', 'jira.json');
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test('hasCredentials reflects existence', async () => {
    const { hasCredentials, writeCredentials } = await import('../src/lib/credentials.ts');
    expect(hasCredentials('jira')).toBe(false);
    writeCredentials('jira', { token: 'x' });
    expect(hasCredentials('jira')).toBe(true);
  });

  test('writeCredentials overwrites existing data and keeps mode 0600', async () => {
    const { readCredentials, writeCredentials } = await import('../src/lib/credentials.ts');
    writeCredentials('jira', { token: 'first' });
    writeCredentials('jira', { token: 'second' });
    expect(readCredentials<{ token: string }>('jira')).toEqual({ token: 'second' });
    const path = join(tmp, '.ccw', 'credentials', 'jira.json');
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
