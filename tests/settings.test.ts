import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ccw-settings-'));
  vi.doMock('node:os', async () => {
    const actual = await vi.importActual<typeof import('node:os')>('node:os');
    return { ...actual, homedir: () => tmp };
  });
  // Make sure stray env vars don't bleed in.
  delete process.env.CCW_DATA_DIR;
  delete process.env.CCW_UPDATE_CHANNEL;
  delete process.env.CCW_UPDATE_CHECK_ENABLED;
  delete process.env.CCW_UPDATE_CHECK_HOURS;
});

afterEach(() => {
  vi.doUnmock('node:os');
  vi.resetModules();
  rmSync(tmp, { recursive: true, force: true });
});

describe('parseSettingValue', () => {
  test('enum: accepts valid options', async () => {
    const { parseSettingValue } = await import('../src/lib/settings/schema.ts');
    const r = parseSettingValue('update_channel', 'prerelease');
    expect('value' in r ? r.value : null).toBe('prerelease');
  });

  test('enum: rejects unknown options', async () => {
    const { parseSettingValue } = await import('../src/lib/settings/schema.ts');
    const r = parseSettingValue('update_channel', 'beta');
    expect('error' in r).toBe(true);
  });

  test('boolean: accepts truthy/falsy variants', async () => {
    const { parseSettingValue } = await import('../src/lib/settings/schema.ts');
    expect(parseSettingValue('update_check_enabled', 'true')).toEqual({ value: true });
    expect(parseSettingValue('update_check_enabled', '1')).toEqual({ value: true });
    expect(parseSettingValue('update_check_enabled', 'no')).toEqual({ value: false });
    expect(parseSettingValue('update_check_enabled', 'off')).toEqual({ value: false });
  });

  test('boolean: rejects nonsense', async () => {
    const { parseSettingValue } = await import('../src/lib/settings/schema.ts');
    const r = parseSettingValue('update_check_enabled', 'maybe');
    expect('error' in r).toBe(true);
  });

  test('number: validates min', async () => {
    const { parseSettingValue } = await import('../src/lib/settings/schema.ts');
    expect(parseSettingValue('update_check_interval_hours', '24')).toEqual({ value: 24 });
    const r = parseSettingValue('update_check_interval_hours', '-5');
    expect('error' in r).toBe(true);
  });

  test('number: rejects non-numeric', async () => {
    const { parseSettingValue } = await import('../src/lib/settings/schema.ts');
    const r = parseSettingValue('update_check_interval_hours', 'soon');
    expect('error' in r).toBe(true);
  });
});

describe('settings store', () => {
  test('loadSettings returns defaults when file does not exist', async () => {
    const { loadSettings } = await import('../src/lib/settings/store.ts');
    const settings = loadSettings();
    expect(settings.update_channel).toBe('stable');
    expect(settings.update_check_enabled).toBe(true);
    expect(settings.update_check_interval_hours).toBe(24);
  });

  test('setSetting persists and getSetting reads back', async () => {
    const { setSetting, getSetting } = await import('../src/lib/settings/store.ts');
    setSetting('update_channel', 'prerelease');
    expect(getSetting('update_channel')).toBe('prerelease');
  });

  test('setSetting validates values', async () => {
    const { setSetting } = await import('../src/lib/settings/store.ts');
    expect(() => setSetting('update_channel', 'beta' as 'stable' | 'prerelease' | 'none')).toThrow(/Invalid value/);
  });

  test('unsetSetting reverts to default', async () => {
    const { setSetting, unsetSetting, getSetting } = await import('../src/lib/settings/store.ts');
    setSetting('update_channel', 'prerelease');
    unsetSetting('update_channel');
    expect(getSetting('update_channel')).toBe('stable');
  });

  test('env var overrides file', async () => {
    const { setSetting } = await import('../src/lib/settings/store.ts');
    setSetting('update_channel', 'prerelease');
    process.env.CCW_UPDATE_CHANNEL = 'none';
    // Re-import so the new process.env is read inside the module.
    vi.resetModules();
    const { getSetting } = await import('../src/lib/settings/store.ts');
    expect(getSetting('update_channel')).toBe('none');
    delete process.env.CCW_UPDATE_CHANNEL;
  });

  test('env var with invalid value falls through to file', async () => {
    const { setSetting } = await import('../src/lib/settings/store.ts');
    setSetting('update_channel', 'prerelease');
    process.env.CCW_UPDATE_CHANNEL = 'garbage';
    vi.resetModules();
    const { getSetting } = await import('../src/lib/settings/store.ts');
    expect(getSetting('update_channel')).toBe('prerelease');
    delete process.env.CCW_UPDATE_CHANNEL;
  });

  test('describeSetting reports the source', async () => {
    const { setSetting, describeSetting } = await import('../src/lib/settings/store.ts');
    expect(describeSetting('update_channel').source).toBe('default');
    setSetting('update_channel', 'prerelease');
    expect(describeSetting('update_channel').source).toBe('file');
    process.env.CCW_UPDATE_CHANNEL = 'none';
    vi.resetModules();
    const next = await import('../src/lib/settings/store.ts');
    expect(next.describeSetting('update_channel').source).toBe('env');
    delete process.env.CCW_UPDATE_CHANNEL;
  });

  test('settingsPath uses CCW_DATA_DIR when set', async () => {
    process.env.CCW_DATA_DIR = join(tmp, 'custom');
    vi.resetModules();
    const { settingsPath } = await import('../src/lib/settings/store.ts');
    expect(settingsPath()).toBe(join(tmp, 'custom', 'settings.json'));
    delete process.env.CCW_DATA_DIR;
  });
});
