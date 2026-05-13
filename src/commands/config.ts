/**
 * `ccw config` — manage global ccw settings stored at ~/.ccw/settings.json.
 *
 * Subcommands:
 *   ccw config list                    show every setting + current value + source
 *   ccw config get <key>               print one setting's resolved value
 *   ccw config set <key> <value>       persist a value (validated against schema)
 *   ccw config unset <key>             remove the user override (revert to default/env)
 *   ccw config path                    print the absolute path to settings.json
 */

import { describeSetting, loadSettings, setSetting, settingsPath, unsetSetting } from '../lib/settings/store.ts';
import { listSettingKeys, parseSettingValue, SETTINGS_SCHEMA, type SettingsKey } from '../lib/settings/schema.ts';
import { ui } from '../lib/ui.ts';

function isKey(name: string): name is SettingsKey {
  return (Object.keys(SETTINGS_SCHEMA) as string[]).includes(name);
}

function unknownKey(name: string): never {
  ui.error(`Unknown setting: ${name}`);
  ui.hint(`Known settings: ${listSettingKeys().join(', ')}`);
  process.exit(1);
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function sourceLabel(source: 'env' | 'file' | 'default'): string {
  switch (source) {
    case 'env':
      return ui.cyan('env');
    case 'file':
      return ui.green('file');
    case 'default':
      return ui.dim('default');
  }
}

export function runConfigList(): void {
  const settings = loadSettings();
  void settings;
  const keys = listSettingKeys();
  const longestKey = Math.max(...keys.map((k) => k.length));
  const longestValue = Math.max(...keys.map((k) => formatValue(describeSetting(k).value).length));

  ui.heading('Global ccw settings');
  for (const key of keys) {
    const def = SETTINGS_SCHEMA[key];
    const { value, source } = describeSetting(key);
    const padKey = key.padEnd(longestKey);
    const padVal = formatValue(value).padEnd(longestValue);
    console.log(`  ${ui.bold(padKey)}  ${padVal}  ${sourceLabel(source)}`);
    console.log(`    ${ui.dim(def.description)}`);
    if (def.envVar) {
      console.log(`    ${ui.dim(`env: ${def.envVar}`)}`);
    }
  }
  ui.blank();
  ui.hint(`Stored at ${settingsPath()}`);
}

export function runConfigGet(key: string): void {
  if (!isKey(key)) unknownKey(key);
  const { value, source } = describeSetting(key);
  console.log(formatValue(value));
  ui.hint(`source: ${source}`);
}

export function runConfigSet(key: string, raw: string): void {
  if (!isKey(key)) unknownKey(key);
  const parsed = parseSettingValue(key, raw);
  if ('error' in parsed) {
    ui.error(`Invalid value for ${key}: ${parsed.error}`);
    process.exit(1);
  }
  setSetting(key, parsed.value);
  ui.success(`${key} = ${formatValue(parsed.value)}`);
}

export function runConfigUnset(key: string): void {
  if (!isKey(key)) unknownKey(key);
  unsetSetting(key);
  const { value, source } = describeSetting(key);
  ui.success(`Unset ${key}; now ${formatValue(value)} (from ${source})`);
}

export function runConfigPath(): void {
  console.log(settingsPath());
}
