/**
 * Sigstore attestation verification for ccw release artifacts.
 *
 * Wraps `@sigstore/verify` with ccw-specific defaults:
 *   - Vendored public-Sigstore trusted root (Fulcio CA + rekor public key + TSA cert chain).
 *     Updated whenever Sigstore rotates roots — ccw must ship a new release to track.
 *   - Expects a Sigstore Bundle v0.3 (DSSE envelope) as produced by GitHub's
 *     `actions/attest-build-provenance@v1`.
 *   - Verifies the artifact's SHA-256 digest matches a subject in the in-toto statement.
 *
 * What the verifier proves:
 *   1. The bundle was signed by a Fulcio-issued cert.
 *   2. The cert's SAN matches the expected GitHub Actions workflow URI.
 *   3. Rekor has a tlog entry for the signature (transparency log inclusion).
 *   4. A subject in the attestation's in-toto statement has the SHA-256 digest of
 *      the binary we downloaded.
 *
 * What the verifier does NOT prove:
 *   - That the workflow source itself is benign (the SAN identifies a workflow path,
 *     but not what that file contained at run time — GitHub provides separate
 *     `source` attestations for that).
 *   - That the artifact contents themselves are safe — only that they were produced
 *     by the specified workflow.
 */

// MUST come before any @sigstore/* imports — patches crypto.verify so the
// underlying libraries can verify ECDSA signatures under Bun. See file
// header for the gory details.
import './crypto-shim.ts';

import { bundleFromJSON, type Bundle } from '@sigstore/bundle';
import { Verifier, toSignedEntity, toTrustMaterial } from '@sigstore/verify';
import { TrustedRoot } from '@sigstore/protobuf-specs';
import trustedRootJson from './trusted-root.json' with { type: 'json' };

export class AttestationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttestationError';
  }
}

/**
 * Public-Sigstore trusted root, vendored from
 * https://tuf-repo-cdn.sigstore.dev (extracted from sigstore-js's TUF seeds).
 *
 * Must round-trip through `TrustedRoot.fromJSON` — not a plain cast — because
 * the JSON shape encodes timestamps as ISO strings and bytes as base64.
 * `fromJSON` converts those into Date objects and Buffers; without it, date
 * comparisons in `filterCertAuthorities`/`filterTLogAuthorities` silently
 * return empty arrays (string-vs-Date comparison coerces to string).
 */
const TRUSTED_ROOT = TrustedRoot.fromJSON(trustedRootJson);

export interface VerifyAttestationOptions {
  /** Raw bundle JSON from GitHub's attestations API (after snappy decompression). */
  bundleJson: unknown;
  /** Hex-encoded SHA-256 digest of the downloaded artifact (no `sha256:` prefix). */
  artifactDigest: string;
  /**
   * Expected SAN on the signing cert — typically the full workflow ref URI, e.g.
   * `https://github.com/bibaswan-bhawal/ccw/.github/workflows/release.yml@refs/tags/v0.2.0`.
   * Using the tagged ref makes the policy version-specific.
   */
  expectedIdentity: string;
  /**
   * Minimum transparency-log entries (rekor inclusion proofs) required.
   * Default: 1 — public Sigstore always logs to rekor.
   */
  tlogThreshold?: number;
  /**
   * Minimum RFC3161 timestamp signatures required.
   * Default: 0 — attest-build-provenance optionally includes TSA timestamps but
   * the rekor inclusion is already a trusted-time source.
   */
  timestampThreshold?: number;
}

export interface InTotoSubject {
  name?: string;
  uri?: string;
  digest: { sha256?: string };
}

export interface InTotoStatement {
  _type: string;
  subject: InTotoSubject[];
}

export function parseInTotoStatement(bundle: Bundle): InTotoStatement {
  if (bundle.content.$case !== 'dsseEnvelope') {
    throw new AttestationError('bundle content is not a DSSE envelope');
  }
  const payload = Buffer.from(bundle.content.dsseEnvelope.payload).toString('utf-8');
  try {
    return JSON.parse(payload) as InTotoStatement;
  } catch (e) {
    throw new AttestationError(`DSSE payload is not valid JSON: ${(e as Error).message}`);
  }
}

export function assertSubjectDigest(stmt: InTotoStatement, artifactDigest: string): void {
  const lowerDigest = artifactDigest.toLowerCase();
  for (const subject of stmt.subject) {
    if (subject.digest.sha256?.toLowerCase() === lowerDigest) return;
  }
  throw new AttestationError(
    `artifact digest ${artifactDigest} not found among ${stmt.subject.length} attested subjects`,
  );
}

/**
 * Verify a Sigstore attestation. Throws AttestationError on any verification
 * failure (parse, signature, policy, missing subject). Returns normally on success.
 */
export function verifyAttestation(opts: VerifyAttestationOptions): void {
  let bundle: Bundle;
  try {
    bundle = bundleFromJSON(opts.bundleJson);
  } catch (e) {
    throw new AttestationError(`bundle parse failed: ${(e as Error).message}`);
  }

  const trustMaterial = toTrustMaterial(TRUSTED_ROOT);
  const verifier = new Verifier(trustMaterial, {
    tlogThreshold: opts.tlogThreshold ?? 1,
    timestampThreshold: opts.timestampThreshold ?? 0,
  });

  const entity = toSignedEntity(bundle);

  try {
    verifier.verify(entity, { subjectAlternativeName: opts.expectedIdentity });
  } catch (e) {
    // @sigstore/verify throws VerificationError or PolicyError. Re-wrap with
    // the upstream message + error code so callers can present a clear reason.
    const err = e as { message?: string; code?: string };
    const code = err.code ? ` [${err.code}]` : '';
    throw new AttestationError(`sigstore verification failed${code}: ${err.message ?? String(e)}`);
  }

  // @sigstore/verify confirms the DSSE signature is authentic but does NOT
  // verify that the artifact we downloaded is among the attested subjects.
  // That's the link between "this attestation is real" and "this attestation
  // is about THIS artifact" — checked here.
  const statement = parseInTotoStatement(bundle);
  assertSubjectDigest(statement, opts.artifactDigest);
}
