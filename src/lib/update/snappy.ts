/**
 * Snappy raw-format decoder.
 *
 * GitHub serves attestation bundles as `application/x-snappy` blobs from
 * an Azure CDN. The format is Snappy's *raw* encoding (not the framed
 * encoding used by Hadoop/Snappy CLI) — a varint length followed by a
 * stream of tagged elements. We need to decompress these client-side
 * during `ccw update`.
 *
 * Spec: https://github.com/google/snappy/blob/master/format_description.txt
 *
 * We hand-roll this rather than pulling in the `snappy` npm package
 * (native bindings — won't Bun-compile) or `snappyjs` (works but adds
 * ~30KB of bundle for one well-specified ~100-line format).
 */

export class SnappyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnappyError';
  }
}

/**
 * Decompress a Snappy-raw-format buffer. Returns the decompressed bytes.
 * Throws SnappyError on malformed input (unexpected EOF, length mismatch,
 * out-of-range offset).
 */
export function snappyDecompress(input: Buffer): Buffer {
  let inPos = 0;

  // --- Read varint uncompressed length (1-5 bytes, little-endian) ---
  let expectedLength = 0;
  for (let shift = 0; shift < 35; shift += 7) {
    if (inPos >= input.length) throw new SnappyError('unexpected EOF reading length varint');
    const byte = input[inPos++]!;
    expectedLength |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    if (shift === 28) throw new SnappyError('length varint too long');
  }

  const output = Buffer.alloc(expectedLength);
  let outPos = 0;

  while (inPos < input.length) {
    const tag = input[inPos++]!;
    const type = tag & 0x03;

    if (type === 0) {
      // --- Literal ---
      let length: number;
      const upper = tag >> 2;
      if (upper < 60) {
        length = upper + 1;
      } else {
        const extraBytes = upper - 59; // 1, 2, 3, or 4
        if (inPos + extraBytes > input.length) {
          throw new SnappyError('unexpected EOF reading literal length');
        }
        let len = 0;
        for (let i = 0; i < extraBytes; i++) {
          len |= input[inPos++]! << (i * 8);
        }
        length = len + 1;
      }
      if (inPos + length > input.length) {
        throw new SnappyError(`literal of ${length} bytes overruns input`);
      }
      if (outPos + length > expectedLength) {
        throw new SnappyError(`literal output exceeds declared length ${expectedLength}`);
      }
      input.copy(output, outPos, inPos, inPos + length);
      inPos += length;
      outPos += length;
    } else {
      // --- Copy (back-reference) ---
      let length: number;
      let offset: number;

      if (type === 1) {
        // 1-byte offset: length 4-11 in bits 2-4, offset high 3 bits in bits 5-7,
        // offset low 8 bits in next byte.
        if (inPos >= input.length) throw new SnappyError('unexpected EOF reading 1-byte copy offset');
        length = ((tag >> 2) & 0x07) + 4;
        offset = ((tag >> 5) << 8) | input[inPos++]!;
      } else if (type === 2) {
        // 2-byte offset: length-1 in bits 2-7, offset in next 2 bytes (LE).
        if (inPos + 2 > input.length) throw new SnappyError('unexpected EOF reading 2-byte copy offset');
        length = (tag >> 2) + 1;
        offset = input[inPos]! | (input[inPos + 1]! << 8);
        inPos += 2;
      } else {
        // type === 3 — 4-byte offset.
        if (inPos + 4 > input.length) throw new SnappyError('unexpected EOF reading 4-byte copy offset');
        length = (tag >> 2) + 1;
        offset = input.readUInt32LE(inPos);
        inPos += 4;
      }

      if (offset === 0) throw new SnappyError('copy offset of 0 is invalid');
      if (offset > outPos) throw new SnappyError(`copy offset ${offset} exceeds output position ${outPos}`);
      if (outPos + length > expectedLength) {
        throw new SnappyError(`copy output exceeds declared length ${expectedLength}`);
      }

      // Byte-by-byte copy — REQUIRED when offset < length so writes feed reads.
      const start = outPos - offset;
      for (let i = 0; i < length; i++) {
        output[outPos + i] = output[start + i]!;
      }
      outPos += length;
    }
  }

  if (outPos !== expectedLength) {
    throw new SnappyError(`decompressed ${outPos} bytes but declared length was ${expectedLength}`);
  }
  return output;
}
