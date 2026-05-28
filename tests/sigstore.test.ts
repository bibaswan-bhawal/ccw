import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bundleFromJSON } from '@sigstore/bundle';
import {
  AttestationError,
  assertSubjectDigest,
  parseInTotoStatement,
  verifyAttestation,
  type InTotoStatement,
} from '../src/lib/update/sigstore.ts';

// Real GitHub-Actions-produced Sigstore bundle for cli/cli v2.93.0.
// Uses GitHub's INTERNAL trust root (Fulcio Intermediate l1 / O=GitHub, Inc.),
// not public Sigstore — so end-to-end verification with our embedded trusted
// root is expected to fail. Useful for shape/parse tests and as a known
// trust-root-mismatch case to exercise the error path.
const CLI_FIXTURE_PATH = join(__dirname, 'fixtures/sigstore/cli-cli-attestation.json');
const CLI_FIXTURE_JSON = JSON.parse(readFileSync(CLI_FIXTURE_PATH, 'utf-8'));
// Hash of the gh_2.93.0_macOS_arm64.zip artifact this bundle attests to.
const CLI_FIXTURE_DIGEST = 'a86be4e0a86c26456cf71177d6572d6f1165cf1679e532b72f7f15918ee51fd2';

// Real ccw release bundle — signed by public Sigstore, chains to the same
// trusted root we ship. The golden end-to-end happy-path fixture.
const CCW_FIXTURE_PATH = join(__dirname, 'fixtures/sigstore/ccw-v0.1.1-attestation.jsonl');
const CCW_FIXTURE_JSON = JSON.parse(readFileSync(CCW_FIXTURE_PATH, 'utf-8').trim().split('\n')[0]!);
const CCW_FIXTURE_DIGEST = '31a30d02d5eba2013a45611757c376c7433dc1d39f89f069deb0f16c9148919a';
const CCW_FIXTURE_IDENTITY = 'https://github.com/bibaswan-bhawal/ccw/.github/workflows/release.yml@refs/heads/main';

describe('parseInTotoStatement', () => {
  test('extracts the in-toto statement from a real DSSE bundle', () => {
    const bundle = bundleFromJSON(CLI_FIXTURE_JSON);
    const stmt = parseInTotoStatement(bundle);
    expect(stmt._type).toBe('https://in-toto.io/Statement/v1');
    expect(Array.isArray(stmt.subject)).toBe(true);
    expect(stmt.subject.length).toBeGreaterThan(0);
    // At least one subject should reference our known digest.
    const digests = stmt.subject.map((s) => s.digest.sha256).filter((d): d is string => Boolean(d));
    expect(digests).toContain(CLI_FIXTURE_DIGEST);
  });
});

describe('assertSubjectDigest', () => {
  function stmt(subjects: Array<{ sha256?: string }>): InTotoStatement {
    return {
      _type: 'https://in-toto.io/Statement/v1',
      subject: subjects.map((s) => ({ digest: { sha256: s.sha256 } })),
    };
  }

  test('passes when the digest matches a subject', () => {
    const s = stmt([{ sha256: 'aa'.repeat(32) }, { sha256: 'bb'.repeat(32) }]);
    expect(() => assertSubjectDigest(s, 'bb'.repeat(32))).not.toThrow();
  });

  test('is case-insensitive', () => {
    const s = stmt([{ sha256: 'AA'.repeat(32) }]);
    expect(() => assertSubjectDigest(s, 'aa'.repeat(32))).not.toThrow();
  });

  test('throws when no subject matches', () => {
    const s = stmt([{ sha256: 'aa'.repeat(32) }, { sha256: 'bb'.repeat(32) }]);
    expect(() => assertSubjectDigest(s, 'cc'.repeat(32))).toThrow(AttestationError);
    expect(() => assertSubjectDigest(s, 'cc'.repeat(32))).toThrow(/not found among 2 attested subjects/);
  });

  test('throws when subjects list is empty', () => {
    const s = stmt([]);
    expect(() => assertSubjectDigest(s, 'aa'.repeat(32))).toThrow(/not found among 0 attested subjects/);
  });

  test('throws when subject digest is missing', () => {
    const s = stmt([{ sha256: undefined }]);
    expect(() => assertSubjectDigest(s, 'aa'.repeat(32))).toThrow(/not found among 1 attested subjects/);
  });
});

describe('verifyAttestation', () => {
  test('rejects malformed bundle JSON', () => {
    expect(() =>
      verifyAttestation({
        bundleJson: { not: 'a bundle' },
        artifactDigest: 'aa'.repeat(32),
        expectedIdentity: 'https://github.com/example/example/.github/workflows/release.yml@refs/tags/v1',
      }),
    ).toThrow(/bundle parse failed/);
  });

  test('rejects non-object bundle', () => {
    expect(() =>
      verifyAttestation({
        bundleJson: 'not an object',
        artifactDigest: 'aa'.repeat(32),
        expectedIdentity: 'https://github.com/example/example/.github/workflows/release.yml@refs/tags/v1',
      }),
    ).toThrow(AttestationError);
  });

  // The cli/cli bundle is real and parses correctly, but it was signed by
  // GitHub's internal Fulcio instance — not the public Sigstore Fulcio whose
  // CA is in our embedded trusted root. So sigstore verification should fail
  // with a certificate trust error (not a generic crash). This exercises the
  // unhappy-path error wrapping.
  test('wraps sigstore verification errors when trust root does not match', () => {
    expect(() =>
      verifyAttestation({
        bundleJson: CLI_FIXTURE_JSON,
        artifactDigest: CLI_FIXTURE_DIGEST,
        expectedIdentity: 'https://dotcom.releases.github.com',
      }),
    ).toThrow(/sigstore verification failed/);
  });

  // End-to-end golden path: a real ccw release bundle, our real embedded
  // trusted root, the real expected identity. Regression coverage for two
  // bugs that v0.1.1 shipped with:
  //   - `as unknown as TrustedRoot` cast left ISO date strings as strings,
  //     so filter-by-time returned empty arrays → CERTIFICATE_ERROR.
  //   - @sigstore/core's verify wrapper calls crypto.verify with undefined
  //     algorithm; Bun requires explicit 'sha256' for ECDSA keys, so SET
  //     verification silently returned false → TLOG_INCLUSION_PROMISE_ERROR.
  test('verifies a real ccw release bundle end-to-end', () => {
    expect(() =>
      verifyAttestation({
        bundleJson: CCW_FIXTURE_JSON,
        artifactDigest: CCW_FIXTURE_DIGEST,
        expectedIdentity: CCW_FIXTURE_IDENTITY,
      }),
    ).not.toThrow();
  });

  test('rejects the ccw bundle when artifact digest does not match', () => {
    expect(() =>
      verifyAttestation({
        bundleJson: CCW_FIXTURE_JSON,
        artifactDigest: 'ff'.repeat(32),
        expectedIdentity: CCW_FIXTURE_IDENTITY,
      }),
    ).toThrow(/not found among/);
  });

  test('rejects the ccw bundle when identity does not match', () => {
    expect(() =>
      verifyAttestation({
        bundleJson: CCW_FIXTURE_JSON,
        artifactDigest: CCW_FIXTURE_DIGEST,
        expectedIdentity: 'https://github.com/some-other-owner/ccw/.github/workflows/release.yml@refs/heads/main',
      }),
    ).toThrow(/sigstore verification failed/);
  });
});
