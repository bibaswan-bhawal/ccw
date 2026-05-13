/**
 * `ccw config` — manage global ccw settings.
 *
 * Default invocation is an interactive wizard that lists every setting
 * and lets the user edit it. Flags expose the scriptable equivalents:
 *
 *   ccw config                       interactive wizard
 *   ccw config --get <key>           print one resolved value
 *   ccw config --set <key> <value>   persist a value (validated)
 *   ccw config --unset <key>         remove a stored override
 *   ccw config --path                print the absolute settings path
 */

import { describeSetting, setSetting, settingsPath, unsetSetting } from '../lib/settings/store.ts';
import {
  listSettingKeys,
  parseSettingValue,
  SETTINGS_SCHEMA,
  type SettingDef,
  type SettingsKey,
} from '../lib/settings/schema.ts';
import { runWizard, type AnswerMap, type InitStep } from '../lib/wizard/index.ts';
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

// --- Scriptable paths ---------------------------------------------------

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

// --- Interactive wizard -------------------------------------------------

const SECTION = 'Global settings';

function buildSettingStep(key: SettingsKey): InitStep {
  const def = SETTINGS_SCHEMA[key] as SettingDef;
  const { value, source } = describeSetting(key);
  const sourceTag = source === 'env' ? ' (currently set via env var)' : '';
  const hint = `${def.description}${sourceTag}`;

  if (def.type === 'enum') {
    return {
      id: key,
      section: SECTION,
      type: 'select',
      question: key,
      hint,
      default: String(value),
      options: (def.options as readonly string[]).map((opt) => ({
        value: opt,
        label: opt,
      })),
    };
  }

  if (def.type === 'boolean') {
    return {
      id: key,
      section: SECTION,
      type: 'select',
      question: key,
      hint,
      default: value ? 'true' : 'false',
      options: [
        { value: 'true', label: 'true' },
        { value: 'false', label: 'false' },
      ],
    };
  }

  // number / string — render as text input.
  return {
    id: key,
    section: SECTION,
    type: 'text',
    question: key,
    hint,
    default: String(value),
    required: false,
  };
}

export async function runConfigInteractive(): Promise<void> {
  const keys = listSettingKeys();
  const steps = keys.map(buildSettingStep);

  const result = await runWizard({
    steps,
    title: 'Global ccw settings',
    subtitle: 'Edit each value, or hit Enter to keep the current default.',
  });

  if (result.aborted) {
    ui.hint('Aborted. No changes saved.');
    return;
  }

  // Persist each answer that differs from its current resolved value.
  // Skip env-shadowed settings — those would be silently overridden anyway.
  const answers: AnswerMap = result.answers;
  let savedCount = 0;
  for (const key of keys) {
    const raw = answers[key];
    if (raw === undefined) continue;
    const { value: current, source } = describeSetting(key);
    if (source === 'env') continue; // user can't override env from this UI

    const parsed = parseSettingValue(key, String(raw));
    if ('error' in parsed) {
      ui.warn(`${key}: ${parsed.error} — kept previous value.`);
      continue;
    }
    if (parsed.value === current) continue;
    setSetting(key, parsed.value);
    savedCount += 1;
  }

  ui.blank();
  if (savedCount === 0) {
    ui.success('No changes.');
  } else {
    ui.success(`Saved ${savedCount} setting${savedCount === 1 ? '' : 's'} to ${settingsPath()}`);
  }
}
