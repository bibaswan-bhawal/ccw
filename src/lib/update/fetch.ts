/**
 * HTTP fetches for `ccw update`: release assets, signing materials, and
 * GitHub attestation bundles (Snappy-decompressed inline).
 *
 * Kept separate from `check.ts` (which only hits the releases API) so the
 * mainline notifier path doesn't pull in the download/sigstore deps.
 */

import { snappyDecompress } from './snappy.ts';

export class FetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FetchError';
  }
}

const USER_AGENT = 'ccw-update';

/**
 * Fetch a URL and return its body as a Buffer. Throws FetchError on any
 * non-2xx response or network failure.
 */
export async function fetchBuffer(url: string, headers: Record<string, string> = {}): Promise<Buffer> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, ...headers },
    });
  } catch (e) {
    throw new FetchError(`request to ${url} failed: ${(e as Error).message}`);
  }
  if (!response.ok) {
    throw new FetchError(`request to ${url} failed: HTTP ${response.status} ${response.statusText}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Fetch a URL and return its body as a UTF-8 string. Used for SHA256SUMS
 * and signature files which are small text artifacts.
 */
export async function fetchText(url: string, headers: Record<string, string> = {}): Promise<string> {
  return (await fetchBuffer(url, headers)).toString('utf-8');
}

interface AttestationEntry {
  bundle_url?: string;
  bundle?: unknown;
}

interface AttestationResponse {
  attestations?: AttestationEntry[];
}

/**
 * Resolve a Sigstore attestation bundle for the given artifact digest.
 *
 * Newer GitHub responses include `bundle_url` and `bundle: null`; the
 * bundle blob is served separately as `application/x-snappy` from Azure
 * (Snappy raw format). Older responses include `bundle` inline. We handle
 * both transparently.
 *
 * Throws FetchError if no attestation exists for the digest or all
 * candidate bundles fail to decode.
 */
export async function fetchAttestationBundle(opts: {
  owner: string;
  repo: string;
  /** Hex SHA-256 of the artifact, no `sha256:` prefix. */
  digest: string;
  /** Optional GitHub token for higher rate limits. */
  githubToken?: string;
}): Promise<unknown> {
  const apiHeaders: Record<string, string> = { Accept: 'application/vnd.github+json' };
  if (opts.githubToken) apiHeaders.Authorization = `Bearer ${opts.githubToken}`;

  const apiUrl = `https://api.github.com/repos/${opts.owner}/${opts.repo}/attestations/sha256:${opts.digest}`;
  const apiResp = await fetchBuffer(apiUrl, apiHeaders);
  let parsed: AttestationResponse;
  try {
    parsed = JSON.parse(apiResp.toString('utf-8')) as AttestationResponse;
  } catch (e) {
    throw new FetchError(`attestations API response was not JSON: ${(e as Error).message}`);
  }

  const entries = parsed.attestations ?? [];
  if (entries.length === 0) {
    throw new FetchError(`no attestation found for sha256:${opts.digest}`);
  }

  let lastError: Error | undefined;
  for (const entry of entries) {
    try {
      if (entry.bundle && typeof entry.bundle === 'object') return entry.bundle;
      if (!entry.bundle_url) {
        lastError = new FetchError('attestation entry has neither inline bundle nor bundle_url');
        continue;
      }
      const blob = await fetchBuffer(entry.bundle_url);
      const json = snappyDecompress(blob).toString('utf-8');
      return JSON.parse(json);
    } catch (e) {
      lastError = e as Error;
    }
  }
  throw new FetchError(`all ${entries.length} attestation candidates failed: ${lastError?.message ?? 'unknown'}`);
}
