/**
 * Schema for global ccw settings (~/.ccw/settings.json).
 *
 * Each entry declares the type, default, optional environment variable
 * override, and a one-line description used by `ccw config list`.
 *
 * Adding a new setting: add an entry here. Everything else (validation,
 * env-var overlay, prompts in `ccw settings`, docs) reads from this table.
 */

export type SettingType = 'enum' | 'boolean' | 'number' | 'string';

interface BaseSettingDef {
  type: SettingType;
  description: string;
  envVar?: string;
}

export interface EnumSettingDef<T extends string = string> extends BaseSettingDef {
  type: 'enum';
  options: readonly T[];
  default: T;
}

export interface BooleanSettingDef extends BaseSettingDef {
  type: 'boolean';
  default: boolean;
}

export interface NumberSettingDef extends BaseSettingDef {
  type: 'number';
  default: number;
  min?: number;
  max?: number;
}

export interface StringSettingDef extends BaseSettingDef {
  type: 'string';
  default: string;
}

export type SettingDef = EnumSettingDef | BooleanSettingDef | NumberSettingDef | StringSettingDef;

export const SETTINGS_SCHEMA = {
  update_channel: {
    type: 'enum',
    options: ['stable', 'prerelease', 'none'] as const,
    default: 'stable',
    envVar: 'CCW_UPDATE_CHANNEL',
    description: 'Which release channel to follow for self-updates.',
  },
  update_check_enabled: {
    type: 'boolean',
    default: true,
    envVar: 'CCW_UPDATE_CHECK_ENABLED',
    description: 'Whether to check for updates on launch.',
  },
  update_check_interval_hours: {
    type: 'number',
    default: 24,
    min: 0,
    envVar: 'CCW_UPDATE_CHECK_HOURS',
    description: 'Hours between background update checks (0 = every launch).',
  },
} as const satisfies Record<string, SettingDef>;

export type SettingsKey = keyof typeof SETTINGS_SCHEMA;

/**
 * Resolved settings type — derived from the schema so adding a new entry
 * automatically updates the type.
 */
export type Settings = {
  [K in SettingsKey]: SettingValue<(typeof SETTINGS_SCHEMA)[K]>;
};

export type SettingValue<D extends SettingDef> =
  D extends EnumSettingDef<infer T>
    ? T
    : D extends BooleanSettingDef
      ? boolean
      : D extends NumberSettingDef
        ? number
        : D extends StringSettingDef
          ? string
          : never;

export function listSettingKeys(): SettingsKey[] {
  return Object.keys(SETTINGS_SCHEMA) as SettingsKey[];
}

/**
 * Parse a raw string (from env or `ccw config set`) into the typed value
 * for a setting. Returns { value } on success or { error } with a
 * human-readable message on failure.
 */
export function parseSettingValue<K extends SettingsKey>(
  key: K,
  raw: string,
): { value: Settings[K] } | { error: string } {
  const def = SETTINGS_SCHEMA[key] as SettingDef;
  switch (def.type) {
    case 'enum': {
      if ((def.options as readonly string[]).includes(raw)) {
        return { value: raw as Settings[K] };
      }
      return {
        error: `expected one of ${(def.options as readonly string[]).join(', ')} (got "${raw}")`,
      };
    }
    case 'boolean': {
      const truthy = ['true', '1', 'yes', 'on'];
      const falsy = ['false', '0', 'no', 'off'];
      const lower = raw.toLowerCase();
      if (truthy.includes(lower)) return { value: true as Settings[K] };
      if (falsy.includes(lower)) return { value: false as Settings[K] };
      return { error: `expected true/false (got "${raw}")` };
    }
    case 'number': {
      const n = Number(raw);
      if (!Number.isFinite(n)) return { error: `expected a number (got "${raw}")` };
      if (def.min !== undefined && n < def.min) return { error: `must be >= ${def.min}` };
      if (def.max !== undefined && n > def.max) return { error: `must be <= ${def.max}` };
      return { value: n as Settings[K] };
    }
    case 'string': {
      return { value: raw as Settings[K] };
    }
  }
}
