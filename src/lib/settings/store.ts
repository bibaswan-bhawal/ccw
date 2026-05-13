/**
 * Read/write ~/.ccw/settings.json with three-layer precedence:
 *
 *   env var > settings.json > schema default
 *
 * `loadSettings()` returns a fully-resolved Settings object. `setSetting()`
 * persists into the file (env vars and defaults are never written). The
 * file is allowed to be missing; we just use defaults.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  listSettingKeys,
  parseSettingValue,
  SETTINGS_SCHEMA,
  type SettingDef,
  type Settings,
  type SettingsKey,
} from './schema.ts';

function ccwDataDir(): string {
  return process.env.CCW_DATA_DIR && process.env.CCW_DATA_DIR.length > 0
    ? process.env.CCW_DATA_DIR
    : join(homedir(), '.ccw');
}

export function settingsPath(): string {
  return join(ccwDataDir(), 'settings.json');
}

type RawSettings = Partial<Record<SettingsKey, unknown>>;

function readRaw(): RawSettings {
  const path = settingsPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as RawSettings;
  } catch {
    return {};
  }
}

function writeRaw(data: RawSettings): void {
  const path = settingsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}

/**
 * Apply env var override for a single key. Returns the parsed value or
 * undefined if no env override applies (or it failed to parse).
 */
function envOverride<K extends SettingsKey>(key: K): Settings[K] | undefined {
  const def = SETTINGS_SCHEMA[key];
  if (!def.envVar) return undefined;
  const raw = process.env[def.envVar];
  if (raw === undefined || raw === '') return undefined;
  const parsed = parseSettingValue(key, raw);
  if ('error' in parsed) return undefined;
  return parsed.value;
}

/**
 * Coerce a raw on-disk value into the typed setting. We're lenient about
 * shape because users may hand-edit the file: anything that fails type
 * validation falls back to the default.
 */
function coerceFile<K extends SettingsKey>(key: K, raw: unknown): Settings[K] | undefined {
  // Widen the narrow schema literal so we can see all SettingDef fields.
  const def = SETTINGS_SCHEMA[key] as SettingDef;
  switch (def.type) {
    case 'enum':
      if (typeof raw === 'string' && (def.options as readonly string[]).includes(raw)) {
        return raw as Settings[K];
      }
      return undefined;
    case 'boolean':
      return typeof raw === 'boolean' ? (raw as Settings[K]) : undefined;
    case 'number':
      if (typeof raw === 'number' && Number.isFinite(raw)) {
        if (def.min !== undefined && raw < def.min) return undefined;
        if (def.max !== undefined && raw > def.max) return undefined;
        return raw as Settings[K];
      }
      return undefined;
    case 'string':
      return typeof raw === 'string' ? (raw as Settings[K]) : undefined;
  }
}

export function loadSettings(): Settings {
  const file = readRaw();
  const result: Partial<Settings> = {};
  for (const key of listSettingKeys()) {
    const fromEnv = envOverride(key);
    if (fromEnv !== undefined) {
      (result[key] as Settings[typeof key]) = fromEnv;
      continue;
    }
    const fromFile = coerceFile(key, file[key]);
    if (fromFile !== undefined) {
      (result[key] as Settings[typeof key]) = fromFile;
      continue;
    }
    (result[key] as Settings[typeof key]) = SETTINGS_SCHEMA[key].default as Settings[typeof key];
  }
  return result as Settings;
}

export function getSetting<K extends SettingsKey>(key: K): Settings[K] {
  return loadSettings()[key];
}

/**
 * Persist a setting to the file. Throws if the value fails validation.
 * Env-var overrides are not written to disk; if one is active, the
 * stored value is shadowed at read time.
 */
export function setSetting<K extends SettingsKey>(key: K, value: Settings[K]): void {
  const raw = readRaw();
  // Round-trip through parseSettingValue with the stringified value to
  // confirm it survives validation; this catches programmer errors when
  // callers pass odd shapes.
  const stringified = String(value);
  const parsed = parseSettingValue(key, stringified);
  if ('error' in parsed) throw new Error(`Invalid value for ${key}: ${parsed.error}`);
  raw[key] = parsed.value;
  writeRaw(raw);
}

/** Remove the user override, falling back to env or default on next read. */
export function unsetSetting(key: SettingsKey): void {
  const raw = readRaw();
  delete raw[key];
  writeRaw(raw);
}

/**
 * Source of a setting's current value. Useful for `ccw config list` to
 * tell users where a value came from.
 */
export type SettingSource = 'env' | 'file' | 'default';

export function describeSetting<K extends SettingsKey>(key: K): { value: Settings[K]; source: SettingSource } {
  const file = readRaw();
  const fromEnv = envOverride(key);
  if (fromEnv !== undefined) return { value: fromEnv, source: 'env' };
  const fromFile = coerceFile(key, file[key]);
  if (fromFile !== undefined) return { value: fromFile, source: 'file' };
  return {
    value: SETTINGS_SCHEMA[key].default as Settings[K],
    source: 'default',
  };
}
