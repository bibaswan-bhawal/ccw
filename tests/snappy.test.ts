import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SnappyError, snappyDecompress } from '../src/lib/update/snappy.ts';

// --- Helpers for crafting Snappy frames by hand ----------------------------
//
// We need synthetic inputs because Snappy has no Node-native encoder; the
// test fixtures cover the codec branches we care about.

function varint(n: number): number[] {
  const out: number[] = [];
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return out;
}

function literalTag(length: number): number[] {
  // length-1 in upper 6 bits when fits; otherwise extended form.
  if (length <= 60) return [((length - 1) << 2) | 0];
  const lenMinusOne = length - 1;
  if (lenMinusOne < 0x100) return [(60 << 2) | 0, lenMinusOne];
  if (lenMinusOne < 0x10000) return [(61 << 2) | 0, lenMinusOne & 0xff, (lenMinusOne >> 8) & 0xff];
  throw new Error('test helper only supports up to 2-byte literal lengths');
}

function copy1Byte(length: number, offset: number): number[] {
  // length 4-11, offset 0-2047
  const lenBits = (length - 4) & 0x07;
  const offHi = (offset >> 8) & 0x07;
  const offLo = offset & 0xff;
  return [0x01 | (lenBits << 2) | (offHi << 5), offLo];
}

function copy2Byte(length: number, offset: number): number[] {
  // length 1-64, offset 0-65535
  return [0x02 | ((length - 1) << 2), offset & 0xff, (offset >> 8) & 0xff];
}

function frame(uncompressedLength: number, ...elements: number[][]): Buffer {
  return Buffer.from([...varint(uncompressedLength), ...elements.flat()]);
}

// --- Tests -----------------------------------------------------------------

describe('snappyDecompress', () => {
  test('decodes a pure-literal frame', () => {
    const payload = Buffer.from('hello world');
    const input = frame(payload.length, literalTag(payload.length), Array.from(payload));
    expect(snappyDecompress(input).equals(payload)).toBe(true);
  });

  test('decodes a literal with extended length (>60 bytes)', () => {
    const payload = Buffer.alloc(120, 0x41); // 'A' x 120
    const input = frame(payload.length, literalTag(payload.length), Array.from(payload));
    expect(snappyDecompress(input).equals(payload)).toBe(true);
  });

  test('decodes a 1-byte-offset back-reference', () => {
    // Output: "abcdabcd"
    //   - literal "abcd" (4 bytes)
    //   - copy length=4 offset=4 → "abcd"
    const input = frame(8, literalTag(4), [0x61, 0x62, 0x63, 0x64], copy1Byte(4, 4));
    expect(snappyDecompress(input).toString()).toBe('abcdabcd');
  });

  test('decodes a 2-byte-offset back-reference', () => {
    // Output: 100 bytes of "X" followed by another 50 of "X"
    const literal = Buffer.alloc(100, 0x58);
    const input = frame(150, literalTag(100), Array.from(literal), copy2Byte(50, 100));
    expect(snappyDecompress(input).equals(Buffer.alloc(150, 0x58))).toBe(true);
  });

  test('handles overlapping copy (offset < length) byte-by-byte', () => {
    // Output: "abababab" — literal "ab" then copy length=6 offset=2 should
    // RLE-extend the pattern, not memcpy garbage.
    const input = frame(8, literalTag(2), [0x61, 0x62], copy1Byte(6, 2));
    expect(snappyDecompress(input).toString()).toBe('abababab');
  });

  test('rejects truncated literal', () => {
    const input = frame(10, literalTag(10), [0x61, 0x62]); // only 2 of 10 bytes
    expect(() => snappyDecompress(input)).toThrow(SnappyError);
  });

  test('rejects copy with offset 0', () => {
    const input = frame(4, literalTag(2), [0x61, 0x62], copy1Byte(4, 0));
    expect(() => snappyDecompress(input)).toThrow(/offset of 0/);
  });

  test('rejects copy with offset beyond current output', () => {
    const input = frame(8, literalTag(4), [0x61, 0x62, 0x63, 0x64], copy1Byte(4, 100));
    expect(() => snappyDecompress(input)).toThrow(/exceeds output position/);
  });

  test('rejects output longer than declared length', () => {
    const input = frame(4, literalTag(8), Array.from(Buffer.from('overflow')));
    expect(() => snappyDecompress(input)).toThrow(/exceeds declared length/);
  });

  test('decompresses a real GitHub attestation blob', () => {
    const fixture = readFileSync(join(__dirname, 'fixtures/sigstore/cli-cli-bundle.snappy'));
    const decompressed = snappyDecompress(fixture);
    const json = JSON.parse(decompressed.toString('utf-8'));
    expect(json.mediaType).toBe('application/vnd.dev.sigstore.bundle.v0.3+json');
    expect(json.verificationMaterial).toBeDefined();
    expect(json.dsseEnvelope).toBeDefined();
  });
});
