/**
 * Update check — fetches the latest applicable release from GitHub and
 * caches the result locally. The notifier and `ccw update` both consume
 * this module.
 *
 * Channel handling:
 *   stable     -> /releases/latest (skips prereleases)
 *   prerelease -> /releases (full list); we pick the highest semver that
 *                 includes prereleases
 *   none       -> short-circuits; never hits the network
 *
 * Caching: the result is written to ~/.ccw/update-cache.json. On read,
 * if it's fresher than `update_check_interval_hours`, we return it
 * without re-fetching. Stale or missing → caller decides whether to
 * fetch synchronously or in the background.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { compareVersions, isPrerelease, parseVersion } from './semver.ts';

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

export interface ReleaseInfo {
  tag: string;
  url: string;
  publishedAt: string;
  prerelease: boolean;
  assets: ReleaseAsset[];
}

export interface UpdateCheck {
  /** Wall-clock ms epoch when the check ran. */
  checkedAt: number;
  /** Currently-installed ccw version at check time. */
  currentVersion: string;
  /** Latest matching release, or null if the channel returned nothing. */
  latest: ReleaseInfo | null;
}

export type UpdateChannel = 'stable' | 'prerelease' | 'none';

const REPO_OWNER = 'bibaswan-bhawal';
const REPO_NAME = 'ccw';
const USER_AGENT = `ccw-update-check`;

function ccwDataDir(): string {
  return process.env.CCW_DATA_DIR && process.env.CCW_DATA_DIR.length > 0
    ? process.env.CCW_DATA_DIR
    : join(homedir(), '.ccw');
}

export function updateCachePath(): string {
  return join(ccwDataDir(), 'update-cache.json');
}

// --- Cache I/O ---------------------------------------------------------

export function readCache(): UpdateCheck | undefined {
  const path = updateCachePath();
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as UpdateCheck;
  } catch {
    return undefined;
  }
}

export function writeCache(check: UpdateCheck): void {
  const path = updateCachePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(check, null, 2) + '\n');
}

/**
 * Has the cache aged past intervalHours? An interval of 0 means
 * "always stale" (i.e. always re-check on launch).
 */
export function isCacheStale(check: UpdateCheck | undefined, intervalHours: number): boolean {
  if (!check) return true;
  if (intervalHours <= 0) return true;
  const ageMs = Date.now() - check.checkedAt;
  return ageMs >= intervalHours * 60 * 60 * 1000;
}

// --- GitHub fetch ------------------------------------------------------

interface GitHubRelease {
  tag_name: string;
  html_url: string;
  published_at: string;
  prerelease: boolean;
  draft: boolean;
  assets: Array<{ name: string; browser_download_url: string; size: number }>;
}

async function fetchJson<T>(url: string): Promise<T | undefined> {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/vnd.github+json',
      },
    });
    if (!response.ok) return undefined;
    return (await response.json()) as T;
  } catch {
    return undefined;
  }
}

function shapeRelease(r: GitHubRelease): ReleaseInfo {
  return {
    tag: r.tag_name,
    url: r.html_url,
    publishedAt: r.published_at,
    prerelease: r.prerelease,
    assets: r.assets.map((a) => ({
      name: a.name,
      browser_download_url: a.browser_download_url,
      size: a.size,
    })),
  };
}

/**
 * Fetch the latest release matching the requested channel. Returns null
 * if the upstream has no matching release (e.g. brand-new repo with no
 * tags yet) or the request fails — callers treat both the same way.
 */
export async function fetchLatestRelease(channel: UpdateChannel): Promise<ReleaseInfo | null> {
  if (channel === 'none') return null;

  if (channel === 'stable') {
    const r = await fetchJson<GitHubRelease>(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`);
    if (!r || r.draft) return null;
    return shapeRelease(r);
  }

  // prerelease channel: pick the highest-semver release including prereleases.
  const list = await fetchJson<GitHubRelease[]>(
    `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases?per_page=20`,
  );
  if (!list || list.length === 0) return null;
  const candidates = list
    .filter((r) => !r.draft)
    .map((r) => {
      const parsed = parseVersion(r.tag_name);
      return parsed ? { release: r, parsed } : undefined;
    })
    .filter((x): x is { release: GitHubRelease; parsed: NonNullable<ReturnType<typeof parseVersion>> } => Boolean(x));
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => compareVersions(b.parsed, a.parsed));
  const best = candidates[0]!;
  return shapeRelease(best.release);
}

// --- Run a check ------------------------------------------------------

export interface RunCheckOptions {
  channel: UpdateChannel;
  currentVersion: string;
}

/**
 * Hit GitHub, build a fresh UpdateCheck, persist it, and return.
 */
export async function runCheck(options: RunCheckOptions): Promise<UpdateCheck> {
  const latest = await fetchLatestRelease(options.channel);
  const check: UpdateCheck = {
    checkedAt: Date.now(),
    currentVersion: options.currentVersion,
    latest,
  };
  writeCache(check);
  return check;
}

// --- Comparison ------------------------------------------------------

/**
 * Decide whether the cached check indicates an upgrade is available
 * (relative to the *currently running* version, which may differ from
 * the version captured in the cache if the user just ran `ccw update`).
 */
export function hasAvailableUpdate(
  check: UpdateCheck | undefined,
  currentVersion: string,
): { available: false } | { available: true; release: ReleaseInfo } {
  if (!check?.latest) return { available: false };
  const latest = parseVersion(check.latest.tag);
  const current = parseVersion(currentVersion);
  if (!latest || !current) return { available: false };
  if (compareVersions(latest, current) <= 0) return { available: false };
  return { available: true, release: check.latest };
}

export { isPrerelease, parseVersion, compareVersions };
