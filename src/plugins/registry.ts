/**
 * Built-in plugins, bundled into the ccw binary.
 *
 * To add a new first-party plugin, drop it under src/plugins/<name>/ and
 * register it here. Repo-level enablement is decided by .ccw.json.
 */

import type { Plugin } from '../lib/plugin.ts';
import { jiraPlugin } from './jira/index.ts';

export const BUILTIN_PLUGINS: Plugin[] = [jiraPlugin];

export function findBuiltin(name: string): Plugin | undefined {
  return BUILTIN_PLUGINS.find((p) => p.name === name);
}
