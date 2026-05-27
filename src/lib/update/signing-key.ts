/**
 * Embedded public key used to verify ccw release signatures.
 *
 * The matching private key lives only in GitHub Actions secrets — it never
 * touches a developer machine. When the release workflow signs SHA256SUMS,
 * it uses that private key; this binary verifies with the public key below.
 *
 * Key ceremony (one-time, before first release):
 *   1. On a clean machine: `minisign -G -p ccw-release.pub -s ccw-release.key`
 *      (passphrase optional; CI signing can skip it with `minisign -W`).
 *   2. Paste the two lines of `ccw-release.pub` into CCW_RELEASE_PUBLIC_KEY
 *      below — including the "untrusted comment:" line.
 *   3. Base64-encode `ccw-release.key` and store as MINISIGN_PRIVATE_KEY in
 *      GitHub Actions repo secrets. Back up the original to 1Password.
 *   4. Delete the local private key file.
 *
 * Rotation: if the private key is compromised, generate a new keypair, ship
 * a new ccw version with the new public key, and tell users to reinstall.
 * Minisign has no revocation mechanism — the embedded key IS the trust root.
 */

import { MinisignError, parsePublicKey, type MinisignPublicKey } from './minisign.ts';

/**
 * Placeholder until the real key ceremony has been performed. The
 * release-signing workflow refuses to publish if this is still empty.
 */
export const CCW_RELEASE_PUBLIC_KEY = '';

/**
 * Parse the embedded release key. Throws MinisignError if the key hasn't
 * been configured yet — used as a guard in `ccw update` to prevent
 * accidentally running signature checks against an empty trust root.
 */
export function getReleasePublicKey(): MinisignPublicKey {
  if (CCW_RELEASE_PUBLIC_KEY === '') {
    throw new MinisignError('release public key is not configured in this build');
  }
  return parsePublicKey(CCW_RELEASE_PUBLIC_KEY);
}
