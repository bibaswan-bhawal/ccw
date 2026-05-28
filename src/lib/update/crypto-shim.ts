/**
 * Bun compatibility shim for `node:crypto.verify`.
 *
 * Bun's `node:crypto.verify` requires an explicit digest algorithm when the
 * public key is ECDSA or RSA. Node infers SHA-256 in the same situation,
 * which `@sigstore/core`'s verify wrapper relies on:
 *
 *   crypto.verify(undefined, data, key, sig)
 *
 * Under Bun this throws ERR_OSSL_NO_DEFAULT_DIGEST, which `@sigstore/core`'s
 * try/catch swallows and returns `false` — silently breaking Sigstore
 * tlog SET verification and rekor checkpoint verification.
 *
 * This shim patches `crypto.verify` to default the algorithm to `'sha256'`
 * when none is given and the key is ECDSA/RSA. Ed25519 and Ed448 keys still
 * need `null`/`undefined` (those algorithms encode the digest internally),
 * so we leave that case alone.
 *
 * Import this module before anything that uses `@sigstore/verify` so the
 * patch is in place when those modules first call into crypto.
 */

import crypto from 'node:crypto';

interface KeyLike {
  asymmetricKeyType?: string;
}

type VerifyFn = typeof crypto.verify;
const original = crypto.verify.bind(crypto) as VerifyFn;

function shimmed(
  algorithm: string | null | undefined,
  data: Parameters<VerifyFn>[1],
  key: Parameters<VerifyFn>[2],
  signature: Parameters<VerifyFn>[3],
): boolean;
function shimmed(
  algorithm: string | null | undefined,
  data: Parameters<VerifyFn>[1],
  key: Parameters<VerifyFn>[2],
  signature: Parameters<VerifyFn>[3],
  callback: Parameters<VerifyFn>[4],
): void;
function shimmed(
  algorithm: string | null | undefined,
  data: unknown,
  key: unknown,
  signature: unknown,
  callback?: unknown,
): boolean | void {
  if (algorithm == null) {
    const keyType = (key as KeyLike | undefined)?.asymmetricKeyType;
    if (keyType === 'ec' || keyType === 'rsa' || keyType === 'rsa-pss') {
      algorithm = 'sha256';
    }
  }
  // The callback overload exists in Node's types but neither Sigstore nor we
  // use it; forward it through if it's ever passed.
  return (original as unknown as (...args: unknown[]) => boolean)(algorithm, data, key, signature, callback);
}

(crypto as unknown as { verify: VerifyFn }).verify = shimmed as unknown as VerifyFn;
