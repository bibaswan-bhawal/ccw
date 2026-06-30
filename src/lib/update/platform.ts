/**
 * Platform / install-method detection for `ccw update`.
 *
 * Two responsibilities:
 *   1. Map the running platform/arch to the release asset name we should
 *      download (must match what `bun run build:*` produces).
 *   2. Detect whether ccw was installed via Homebrew so we can route
 *      the user to `brew upgrade ccw` instead of clobbering brew's binary.
 */

import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';

/**
 * Brew install prefixes by platform. Order matters for matching: we check
 * the longest path first so `/opt/homebrew/bin/ccw` doesn't match a more
 * generic `/usr/local/bin/` rule.
 */
const BREW_BIN_PREFIXES = [
  '/opt/homebrew/bin/', // macOS Apple Silicon
  '/usr/local/bin/', // macOS Intel (and some custom installs)
  '/home/linuxbrew/.linuxbrew/bin/', // Linuxbrew default
] as const;

export interface PlatformAsset {
  /** Asset filename in the GitHub release (matches `build:*` script outputs). */
  name: string;
  /** Friendly label used in user-facing messages. */
  label: string;
}

/**
 * Resolve the release asset for the current platform/arch. Returns
 * `undefined` if ccw doesn't (yet) ship a binary for this combination.
 */
export function currentPlatformAsset(): PlatformAsset | undefined {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === 'darwin' && arch === 'arm64') return { name: 'ccw-macos-arm64', label: 'macOS (Apple Silicon)' };
  if (platform === 'darwin' && arch === 'x64') return { name: 'ccw-macos-x64', label: 'macOS (Intel)' };
  if (platform === 'linux' && arch === 'x64') return { name: 'ccw-linux-x64', label: 'Linux (x86_64)' };
  return undefined;
}

/**
 * Does this path look like a Homebrew-managed binary?
 *
 * process.execPath is the *resolved* path, so a brew install resolves to its
 * Cellar location (e.g. /opt/homebrew/Cellar/ccw/0.3.0/bin/ccw), NOT the
 * /opt/homebrew/bin/ccw symlink. We therefore match both the bin symlink dirs
 * and any `/Cellar/` path — otherwise the check below would never fire for a
 * real brew install (the bug that let `ccw update` clobber brew binaries).
 */
export function looksLikeBrewPath(execPath: string): boolean {
  if (BREW_BIN_PREFIXES.some((prefix) => execPath.startsWith(prefix))) return true;
  return execPath.includes('/Cellar/');
}

/**
 * Best-effort check for whether the running binary was installed via Homebrew.
 *
 * We need BOTH signals: a brew-style path *and* `brew list ccw` succeeding.
 * Path alone produces false positives (users sometimes drop unrelated binaries
 * into `/usr/local/bin/`). `brew list ccw` alone is too slow to call when
 * we're nowhere near a brew install.
 */
export function isBrewInstall(execPath: string = process.execPath): boolean {
  if (!looksLikeBrewPath(execPath)) return false;
  const result = spawnSync('brew', ['list', 'ccw'], { stdio: 'ignore' });
  return result.status === 0;
}

// JS runtimes ccw might be running *under* when launched from source (e.g. the
// dev wrapper runs `bun run src/index.ts`, so process.execPath is the Bun
// binary). Self-update must never overwrite one of these.
const RUNTIME_BASENAMES = new Set(['bun', 'bun-debug', 'node', 'nodejs', 'deno']);

/**
 * True when ccw is running from source via a JS runtime rather than as the
 * compiled standalone binary. In that case process.execPath points at the
 * runtime (bun/node), and overwriting it during `ccw update` would destroy the
 * user's runtime — which is exactly how a dev-wrapper `ccw update` once clobbered
 * the Homebrew `bun`. Guards self-update against ever doing that again.
 */
export function isRunningFromSource(execPath: string = process.execPath): boolean {
  const base = basename(execPath).toLowerCase();
  return RUNTIME_BASENAMES.has(base);
}
