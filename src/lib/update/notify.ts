/**
 * Launch-time update notifier.
 *
 * Called on every ccw invocation. If the on-disk update cache shows a
 * newer release than the running binary, prints a one-line nag. If the
 * cache is older than `update_check_interval_hours`, kicks off a
 * fire-and-forget refresh — the next launch reads the updated cache.
 *
 * The contract is: this function returns synchronously. It never awaits
 * a network call, so command launch doesn't get a latency tax from the
 * update check.
 */
import pkg from '../../../package.json' with { type: 'json' };
import { loadSettings } from '../settings/store.ts';
import { ui } from '../ui.ts';
import { hasAvailableUpdate, isCacheStale, readCache, runCheck, type UpdateCheck } from './check.ts';

/**
 * Decide whether to print a nag and what it should say. Pure function so
 * the policy is unit-testable without mocking the filesystem or console.
 */
export function nagMessage(check: UpdateCheck | undefined, currentVersion: string): string | undefined {
  const available = hasAvailableUpdate(check, currentVersion);
  if (!available.available) return undefined;
  return `ccw ${available.release.tag} is available · run ${ui.bold('ccw update')}`;
}

/**
 * Print a nag if the cache shows an available update, and refresh the
 * cache in the background if it's stale. Returns immediately.
 */
export function maybeNotifyUpdate(): void {
  let settings;
  try {
    settings = loadSettings();
  } catch {
    return; // corrupted settings — fail silent rather than block startup
  }

  if (!settings.update_check_enabled) return;
  if (settings.update_channel === 'none') return;

  const cache = readCache();

  const nag = nagMessage(cache, pkg.version);
  if (nag) ui.info(nag);

  if (isCacheStale(cache, settings.update_check_interval_hours)) {
    // Fire-and-forget. Errors land in the cache as "no latest release"
    // on the next launch — we don't want network failures to surface
    // here, where the user is trying to run an unrelated command.
    void runCheck({
      channel: settings.update_channel,
      currentVersion: pkg.version,
    }).catch(() => {
      /* swallow */
    });
  }
}
