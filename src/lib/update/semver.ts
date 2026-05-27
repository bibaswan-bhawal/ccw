/**
 * Tiny semver helper. We compare versions like "0.1.0", "0.1.0-beta.2",
 * "1.2.3", with optional leading "v" prefix on either side.
 *
 * Not a full SemVer 2.0 implementation — we don't support build metadata
 * (`+...`) or wildcard ranges. Sufficient for "is the upstream version
 * newer than mine."
 */

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** Empty array if not a prerelease. */
  prerelease: Array<string | number>;
}

const RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export function parseVersion(input: string): ParsedVersion | undefined {
  const match = input.trim().match(RE);
  if (!match) return undefined;
  const [, major, minor, patch, pre] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: pre ? pre.split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [],
  };
}

/**
 * Compare a vs b: -1 if a<b, 0 if a==b, 1 if a>b.
 *
 * SemVer rule: prereleases sort *before* their corresponding release
 * (1.0.0-rc.1 < 1.0.0). Numeric prerelease segments compare numerically;
 * mixed numeric/string comparisons treat strings as greater.
 */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): -1 | 0 | 1 {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;

  // Equal core versions; consult prerelease channels.
  const aHasPre = a.prerelease.length > 0;
  const bHasPre = b.prerelease.length > 0;
  if (!aHasPre && !bHasPre) return 0;
  if (!aHasPre && bHasPre) return 1; // 1.0.0 > 1.0.0-rc.1
  if (aHasPre && !bHasPre) return -1;

  const len = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < len; i++) {
    const ai = a.prerelease[i];
    const bi = b.prerelease[i];
    if (ai === undefined) return -1;
    if (bi === undefined) return 1;
    if (ai === bi) continue;
    const aIsNum = typeof ai === 'number';
    const bIsNum = typeof bi === 'number';
    if (aIsNum && bIsNum) return ai < bi ? -1 : 1;
    if (aIsNum) return -1; // numeric < string
    if (bIsNum) return 1;
    return ai < bi ? -1 : 1; // both strings
  }
  return 0;
}

export function isNewer(remote: string, current: string): boolean {
  const r = parseVersion(remote);
  const c = parseVersion(current);
  if (!r || !c) return false;
  return compareVersions(r, c) > 0;
}

export function isPrerelease(version: ParsedVersion): boolean {
  return version.prerelease.length > 0;
}
