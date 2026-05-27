import { describe, expect, test } from 'vitest';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import {
  MinisignError,
  parsePublicKey,
  parseSignature,
  verifyMinisign,
  type MinisignAlgorithm,
} from '../src/lib/update/minisign.ts';

// --- Test fixture generator (an inline minisign signer) ------------------
//
// We don't have the `minisign` CLI on this machine, and even if we did, an
// independent signer in the test file is cleaner than coupling the verifier
// tests to a verifier-style helper. This signer uses node:crypto directly
// (ed25519 + blake2b-512) to produce real minisign files.

const ALG_BYTES: Record<MinisignAlgorithm, Buffer> = {
  pure: Buffer.from('Ed', 'ascii'),
  prehashed: Buffer.from('ED', 'ascii'),
};

interface SignerFixture {
  publicKeyFile: string;
  keyId: Buffer;
  rawPublicKey: Buffer;
  sign: (payload: Buffer, trustedComment: string, algorithm?: MinisignAlgorithm) => string;
}

function makeSigner(): SignerFixture {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rawPublicKey = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url');
  const keyId = randomBytes(8);

  const pkBlob = Buffer.concat([ALG_BYTES.pure, keyId, rawPublicKey]);
  const publicKeyFile = `untrusted comment: minisign public key ${keyId.toString('hex').toUpperCase()}\n${pkBlob.toString('base64')}\n`;

  function signFn(payload: Buffer, trustedComment: string, algorithm: MinisignAlgorithm = 'prehashed'): string {
    const messageToSign = algorithm === 'prehashed' ? createHash('blake2b512').update(payload).digest() : payload;
    const signature = sign(null, messageToSign, privateKey);
    const sigBlob = Buffer.concat([ALG_BYTES[algorithm], keyId, signature]);
    const globalMessage = Buffer.concat([signature, Buffer.from(trustedComment, 'utf-8')]);
    const globalSignature = sign(null, globalMessage, privateKey);
    return [
      'untrusted comment: signature from minisign secret key',
      sigBlob.toString('base64'),
      `trusted comment: ${trustedComment}`,
      globalSignature.toString('base64'),
      '',
    ].join('\n');
  }

  return { publicKeyFile, keyId, rawPublicKey, sign: signFn };
}

// --- Tests ---------------------------------------------------------------

describe('parsePublicKey', () => {
  test('parses a well-formed public key', () => {
    const f = makeSigner();
    const pk = parsePublicKey(f.publicKeyFile);
    expect(pk.algorithm).toBe('pure');
    expect(pk.keyId.equals(f.keyId)).toBe(true);
    expect(pk.publicKey.equals(f.rawPublicKey)).toBe(true);
  });

  test('rejects missing untrusted-comment header', () => {
    const f = makeSigner();
    const broken = f.publicKeyFile.replace(/^untrusted comment:.*\n/, '');
    expect(() => parsePublicKey(broken)).toThrow(MinisignError);
  });

  test('rejects wrong-length payload', () => {
    const truncated = `untrusted comment: x\n${Buffer.from('Ed', 'ascii').toString('base64')}\n`;
    expect(() => parsePublicKey(truncated)).toThrow(/expected 42 bytes/);
  });

  test('rejects unsupported algorithm bytes', () => {
    const blob = Buffer.concat([Buffer.from('XX', 'ascii'), Buffer.alloc(40, 0)]);
    const broken = `untrusted comment: x\n${blob.toString('base64')}\n`;
    expect(() => parsePublicKey(broken)).toThrow(/unsupported algorithm bytes/);
  });
});

describe('parseSignature', () => {
  test('parses a well-formed signature', () => {
    const f = makeSigner();
    const sigFile = f.sign(Buffer.from('hello'), 'release v0.1.0');
    const sig = parseSignature(sigFile);
    expect(sig.algorithm).toBe('prehashed');
    expect(sig.keyId.equals(f.keyId)).toBe(true);
    expect(sig.signature.length).toBe(64);
    expect(sig.trustedComment).toBe('release v0.1.0');
    expect(sig.globalSignature.length).toBe(64);
  });

  test('rejects missing trusted-comment header', () => {
    const f = makeSigner();
    const sigFile = f.sign(Buffer.from('hello'), 'tc');
    const broken = sigFile.replace(/^trusted comment: /m, 'tc: ');
    expect(() => parseSignature(broken)).toThrow(/missing "trusted comment: " header/);
  });

  test('rejects too few lines', () => {
    expect(() => parseSignature('untrusted comment: x\n')).toThrow(/expected at least 4 lines/);
  });

  test('tolerates CRLF line endings', () => {
    const f = makeSigner();
    const sigFile = f.sign(Buffer.from('hello'), 'tc').replace(/\n/g, '\r\n');
    expect(() => parseSignature(sigFile)).not.toThrow();
  });
});

describe('verifyMinisign', () => {
  test('verifies a valid prehashed signature', () => {
    const f = makeSigner();
    const payload = Buffer.from('the quick brown fox');
    const sigFile = f.sign(payload, 'timestamp:1740000000');
    const pk = parsePublicKey(f.publicKeyFile);
    const sig = parseSignature(sigFile);
    expect(() => verifyMinisign({ payload, signature: sig, publicKey: pk })).not.toThrow();
  });

  test('verifies a valid pure-mode signature', () => {
    const f = makeSigner();
    const payload = Buffer.from('legacy-mode payload');
    const sigFile = f.sign(payload, 'pure-mode', 'pure');
    const pk = parsePublicKey(f.publicKeyFile);
    const sig = parseSignature(sigFile);
    expect(() => verifyMinisign({ payload, signature: sig, publicKey: pk })).not.toThrow();
  });

  test('rejects key id mismatch', () => {
    const signer = makeSigner();
    const otherKey = makeSigner();
    const payload = Buffer.from('payload');
    const sigFile = signer.sign(payload, 'tc');
    const sig = parseSignature(sigFile);
    const wrongPk = parsePublicKey(otherKey.publicKeyFile);
    expect(() => verifyMinisign({ payload, signature: sig, publicKey: wrongPk })).toThrow(/key id mismatch/);
  });

  test('rejects tampered payload', () => {
    const f = makeSigner();
    const payload = Buffer.from('original');
    const sigFile = f.sign(payload, 'tc');
    const sig = parseSignature(sigFile);
    const pk = parsePublicKey(f.publicKeyFile);
    const tampered = Buffer.from('orig1nal'); // single-byte change
    expect(() => verifyMinisign({ payload: tampered, signature: sig, publicKey: pk })).toThrow(
      /signature is invalid for the provided payload/,
    );
  });

  test('rejects tampered signature bytes', () => {
    const f = makeSigner();
    const payload = Buffer.from('payload');
    const sigFile = f.sign(payload, 'tc');
    const sig = parseSignature(sigFile);
    sig.signature.writeUInt8(sig.signature.readUInt8(0) ^ 0xff, 0); // flip a bit
    const pk = parsePublicKey(f.publicKeyFile);
    expect(() => verifyMinisign({ payload, signature: sig, publicKey: pk })).toThrow(
      /signature is invalid for the provided payload/,
    );
  });

  test('rejects tampered trusted comment', () => {
    const f = makeSigner();
    const payload = Buffer.from('payload');
    const sigFile = f.sign(payload, 'release v0.1.0');
    const sig = parseSignature(sigFile);
    sig.trustedComment = 'release v9.9.9'; // attacker swaps version string
    const pk = parsePublicKey(f.publicKeyFile);
    expect(() => verifyMinisign({ payload, signature: sig, publicKey: pk })).toThrow(
      /trusted comment signature is invalid/,
    );
  });

  test('rejects wrong public key entirely (different signer)', () => {
    const realSigner = makeSigner();
    const impostor = makeSigner();
    const payload = Buffer.from('hi');
    const sigFile = impostor.sign(payload, 'tc');
    const sig = parseSignature(sigFile);
    // Force the impostor's signature to look like it came from the real key's id,
    // so we hit the actual ed25519 verification step rather than the key-id check.
    sig.keyId = realSigner.keyId;
    const pk = parsePublicKey(realSigner.publicKeyFile);
    expect(() => verifyMinisign({ payload, signature: sig, publicKey: pk })).toThrow(
      /signature is invalid for the provided payload/,
    );
  });
});
