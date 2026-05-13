/**
 * Per-plugin credential storage.
 *
 * Plugins that need secrets (API tokens, passwords) save them with
 * writeCredentials() and read them back with readCredentials(). Files
 * land at `~/.ccw/credentials/<plugin>.json` with mode 0600 so other
 * users on the system can't read them.
 *
 * This is deliberately simple — no Keychain, no encryption at rest,
 * just file permissions. Acceptable for tokens that already live in
 * the user's shell history / env vars in most workflows.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function credentialsDir(): string {
  return join(homedir(), '.ccw', 'credentials');
}

function credentialsPath(pluginName: string): string {
  return join(credentialsDir(), `${pluginName}.json`);
}

export function readCredentials<T = unknown>(pluginName: string): T | undefined {
  const path = credentialsPath(pluginName);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch {
    return undefined;
  }
}

export function writeCredentials(pluginName: string, data: unknown): void {
  const dir = credentialsDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = credentialsPath(pluginName);
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
  // chmod separately — Node's writeFileSync mode arg only applies on create,
  // and existing files keep their previous perms.
  chmodSync(path, 0o600);
}

export function hasCredentials(pluginName: string): boolean {
  return existsSync(credentialsPath(pluginName));
}
