/**
 * Embedded public key used to verify ccw release signatures.
 *
 * The matching private key lives only in GitHub Actions secrets — it never
 * touches a developer machine after the one-time key ceremony. When the
 * release workflow signs SHA256SUMS, it uses that private key; this binary
 * verifies with the public key below.
 *
 * Rotation: if the private key is compromised, generate a new keypair, ship
 * a new ccw version with the new public key, and tell users to reinstall.
 * Minisign has no revocation mechanism — the embedded key IS the trust root.
 */

import { parsePublicKey, type MinisignPublicKey } from './minisign.ts';

/**
 * Public key for ccw release artifacts. Generated 2026-05 with
 * `minisign -G -p ccw-release.pub -s ccw-release.key -W`.
 *
 * Matching private key is stored as the MINISIGN_PRIVATE_KEY repo secret
 * (base64-encoded) and is used by the release workflow to sign SHA256SUMS.
 */
export const CCW_RELEASE_PUBLIC_KEY = `untrusted comment: minisign public key 0605A379F436D4D7
RWTX1Db0eaMFBoWsAN0cI0XodrqfXrJeqPsHBqLfNB6UaSXUwGE74NhH`;

/** Parse the embedded release key into the form `verifyMinisign` expects. */
export function getReleasePublicKey(): MinisignPublicKey {
  return parsePublicKey(CCW_RELEASE_PUBLIC_KEY);
}
