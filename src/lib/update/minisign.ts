/**
 * Minisign signature verification.
 *
 * Implements the verifier side of minisign (https://jedisct1.github.io/minisign/)
 * — enough to validate release artifacts signed by the ccw maintainer's
 * private key. ccw never signs in-binary; signing happens in CI with the
 * private key stored as a GitHub Actions secret.
 *
 * Format:
 *   Public key:
 *     untrusted comment: minisign public key <KEYID_HEX>
 *     <base64(2-byte sig_alg || 8-byte key_id || 32-byte ed25519 public key)>
 *
 *   Signature (.minisig):
 *     untrusted comment: <freeform>
 *     <base64(2-byte sig_alg || 8-byte key_id || 64-byte ed25519 signature)>
 *     trusted comment: <bound by the global signature below>
 *     <base64(64-byte ed25519 global signature)>
 *
 *   sig_alg byte pairs:
 *     "Ed" (0x45 0x64) — pure Ed25519, signs the payload directly
 *     "ED" (0x45 0x44) — signs BLAKE2b-512(payload) (recommended for large files)
 *
 *   The global signature is computed over (signature_bytes || trusted_comment_utf8),
 *   so a verified signature also authenticates the trusted comment. Bumping a
 *   version number into the trusted comment is one of the cheap ways to bind
 *   release metadata to the signature.
 */

import { createHash, createPublicKey, verify } from 'node:crypto';

export class MinisignError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MinisignError';
  }
}

/** "pure" = Ed25519 directly over payload; "prehashed" = Ed25519 over BLAKE2b-512(payload). */
export type MinisignAlgorithm = 'pure' | 'prehashed';

export interface MinisignPublicKey {
  /**
   * The algorithm byte stored in the public key file. Minisign's reference
   * implementation always writes "Ed" here regardless of whether signatures
   * are later created in prehashed mode — so this field is informational and
   * is NOT cross-checked against signature.algorithm.
   */
  algorithm: MinisignAlgorithm;
  keyId: Buffer; // 8 bytes
  publicKey: Buffer; // 32 bytes (raw Ed25519)
}

export interface MinisignSignature {
  /** The algorithm used to produce THIS signature — drives how we verify. */
  algorithm: MinisignAlgorithm;
  keyId: Buffer; // 8 bytes
  signature: Buffer; // 64 bytes
  trustedComment: string;
  globalSignature: Buffer; // 64 bytes
}

const ALG_PURE = Buffer.from('Ed', 'ascii'); // 0x45 0x64
const ALG_PREHASHED = Buffer.from('ED', 'ascii'); // 0x45 0x44

function decodeAlgorithm(bytes: Buffer): MinisignAlgorithm {
  if (bytes.equals(ALG_PURE)) return 'pure';
  if (bytes.equals(ALG_PREHASHED)) return 'prehashed';
  throw new MinisignError(`unsupported algorithm bytes: 0x${bytes.toString('hex')}`);
}

function splitLines(input: string): string[] {
  const lines = input.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function decodeBase64(line: string, expectedLength: number, label: string): Buffer {
  const bytes = Buffer.from(line, 'base64');
  if (bytes.length !== expectedLength) {
    throw new MinisignError(`${label}: expected ${expectedLength} bytes, got ${bytes.length}`);
  }
  return bytes;
}

export function parsePublicKey(text: string): MinisignPublicKey {
  const lines = splitLines(text);
  if (lines.length < 2) {
    throw new MinisignError('public key: expected at least 2 lines');
  }
  if (!lines[0]!.startsWith('untrusted comment:')) {
    throw new MinisignError('public key: missing "untrusted comment:" header');
  }
  // 2 (algo) + 8 (key id) + 32 (raw pubkey) = 42 bytes
  const decoded = decodeBase64(lines[1]!, 42, 'public key');
  return {
    algorithm: decodeAlgorithm(decoded.subarray(0, 2)),
    keyId: Buffer.from(decoded.subarray(2, 10)),
    publicKey: Buffer.from(decoded.subarray(10, 42)),
  };
}

export function parseSignature(text: string): MinisignSignature {
  const lines = splitLines(text);
  if (lines.length < 4) {
    throw new MinisignError('signature: expected at least 4 lines');
  }
  if (!lines[0]!.startsWith('untrusted comment:')) {
    throw new MinisignError('signature: missing "untrusted comment:" header');
  }
  // 2 (algo) + 8 (key id) + 64 (ed25519 sig) = 74 bytes
  const sigBlob = decodeBase64(lines[1]!, 74, 'signature');

  const trustedHeader = 'trusted comment: ';
  if (!lines[2]!.startsWith(trustedHeader)) {
    throw new MinisignError('signature: missing "trusted comment: " header');
  }
  const trustedComment = lines[2]!.slice(trustedHeader.length);
  const globalSignature = decodeBase64(lines[3]!, 64, 'global signature');

  return {
    algorithm: decodeAlgorithm(sigBlob.subarray(0, 2)),
    keyId: Buffer.from(sigBlob.subarray(2, 10)),
    signature: Buffer.from(sigBlob.subarray(10, 74)),
    trustedComment,
    globalSignature,
  };
}

/**
 * Wrap a raw 32-byte Ed25519 public key in the SubjectPublicKeyInfo DER
 * envelope that node:crypto's createPublicKey() requires. The fixed
 * 12-byte prefix encodes the algorithm OID 1.3.101.112 (Ed25519).
 */
function ed25519KeyObject(rawBytes: Buffer) {
  const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
  const der = Buffer.concat([SPKI_PREFIX, rawBytes]);
  return createPublicKey({ key: der, format: 'der', type: 'spki' });
}

function blake2b512(payload: Buffer): Buffer {
  // Works in both Bun runtime and Node (vitest workers). Bun doesn't list
  // blake2b512 in crypto.getHashes() but createHash() supports it anyway.
  return createHash('blake2b512').update(payload).digest();
}

export interface VerifyOptions {
  payload: Buffer;
  signature: MinisignSignature;
  publicKey: MinisignPublicKey;
}

/**
 * Verify a minisign signature over a payload. Throws MinisignError on any
 * mismatch — key id, payload signature, or global signature over the
 * trusted comment. Returns normally on success.
 */
export function verifyMinisign(opts: VerifyOptions): void {
  const { payload, signature, publicKey } = opts;

  if (!signature.keyId.equals(publicKey.keyId)) {
    throw new MinisignError(
      `key id mismatch: signature ${signature.keyId.toString('hex')}, ` +
        `public key ${publicKey.keyId.toString('hex')}`,
    );
  }

  const messageToVerify = signature.algorithm === 'prehashed' ? blake2b512(payload) : payload;
  const keyObject = ed25519KeyObject(publicKey.publicKey);

  if (!verify(null, messageToVerify, keyObject, signature.signature)) {
    throw new MinisignError('signature is invalid for the provided payload');
  }

  // The global signature covers (signature_bytes || trusted_comment_utf8),
  // so an attacker can't substitute one without invalidating the other.
  const globalMessage = Buffer.concat([signature.signature, Buffer.from(signature.trustedComment, 'utf-8')]);

  if (!verify(null, globalMessage, keyObject, signature.globalSignature)) {
    throw new MinisignError('trusted comment signature is invalid');
  }
}
