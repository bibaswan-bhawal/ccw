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
 * Best-effort check for whether the running binary was installed via Homebrew.
 *
 * We need BOTH signals: a brew-style path *and* `brew list ccw` succeeding.
 * Path alone produces false positives (users sometimes drop unrelated binaries
 * into `/usr/local/bin/`). `brew list ccw` alone is too slow to call when
 * we're nowhere near a brew install.
 */
export function isBrewInstall(execPath: string = process.execPath): boolean {
  const pathLooksBrew = BREW_BIN_PREFIXES.some((prefix) => execPath.startsWith(prefix));
  if (!pathLooksBrew) return false;
  const result = spawnSync('brew', ['list', 'ccw'], { stdio: 'ignore' });
  return result.status === 0;
}
