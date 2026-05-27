/**
 * `ccw update` — self-update with full verification.
 *
 * Brew users are routed to `brew upgrade ccw`. Everyone else follows the
 * download/verify/install flow:
 *
 *   1. Fetch the latest release for the configured channel.
 *   2. If brew owns this binary, tell the user and stop.
 *   3. Download the platform-specific binary, SHA256SUMS, SHA256SUMS.minisig.
 *   4. Verify the minisig signature on SHA256SUMS (embedded public key).
 *   5. Verify the binary's sha256 matches its line in SHA256SUMS.
 *   6. Fetch the GitHub Sigstore attestation and verify it (public Sigstore
 *      trust root + expected workflow identity URI for this release tag).
 *   7. Atomic-replace the running binary (xattr/codesign ritual on macOS).
 *
 * Verification failures are hard aborts. There is no `--allow-unsigned`.
 *
 * Flags:
 *   --check   Run the check, print the result, do not install.
 */

import { createHash } from 'node:crypto';
import pkg from '../../package.json' with { type: 'json' };
import { hasAvailableUpdate, runCheck, type ReleaseInfo } from '../lib/update/check.ts';
import { fetchAttestationBundle, fetchBuffer, fetchText, FetchError } from '../lib/update/fetch.ts';
import { installBinary, InstallError } from '../lib/update/install.ts';
import { MinisignError, parseSignature, verifyMinisign } from '../lib/update/minisign.ts';
import { currentPlatformAsset, isBrewInstall } from '../lib/update/platform.ts';
import { AttestationError, verifyAttestation } from '../lib/update/sigstore.ts';
import { getReleasePublicKey } from '../lib/update/signing-key.ts';
import { loadSettings } from '../lib/settings/store.ts';
import { withSpinner } from '../lib/spinner.tsx';
import { ui } from '../lib/ui.ts';

const REPO_OWNER = 'bibaswan-bhawal';
const REPO_NAME = 'ccw';
const WORKFLOW_PATH = '.github/workflows/release.yml';

export interface UpdateOptions {
  check?: boolean;
}

export async function runUpdate(opts: UpdateOptions): Promise<void> {
  const asset = currentPlatformAsset();
  if (!asset) {
    ui.error(`Unsupported platform: ${process.platform}/${process.arch}`);
    ui.hint('ccw publishes binaries for macOS arm64/x64 and Linux x64.');
    process.exit(1);
  }

  const settings = loadSettings();
  const currentVersion = pkg.version;

  const check = await withSpinner('Checking for updates...', () =>
    runCheck({ channel: settings.update_channel, currentVersion }),
  );

  const available = hasAvailableUpdate(check, currentVersion);
  if (!available.available) {
    ui.info(`ccw is up to date (v${currentVersion}).`);
    return;
  }

  ui.info(`ccw ${ui.bold(available.release.tag)} is available (current: v${currentVersion}).`);

  if (opts.check) return;

  if (isBrewInstall()) {
    ui.blank();
    ui.info('This ccw was installed via Homebrew.');
    ui.hint(`Run: ${ui.bold('brew upgrade ccw')}`);
    return;
  }

  const release = available.release;
  const binaryAsset = findAsset(release, asset.name);
  const sumsAsset = findAsset(release, 'SHA256SUMS');
  const sigAsset = findAsset(release, 'SHA256SUMS.minisig');

  let binary: Buffer;
  let sumsText: string;
  let sigText: string;
  try {
    binary = await withSpinner(`Downloading ${asset.name} (${formatBytes(binaryAsset.size)})...`, () =>
      fetchBuffer(binaryAsset.browser_download_url),
    );
    sumsText = await withSpinner('Downloading SHA256SUMS...', () => fetchText(sumsAsset.browser_download_url));
    sigText = await withSpinner('Downloading SHA256SUMS.minisig...', () => fetchText(sigAsset.browser_download_url));
  } catch (e) {
    if (e instanceof FetchError) {
      ui.error(e.message);
      process.exit(1);
    }
    throw e;
  }

  // --- Layer 2: minisign on SHA256SUMS ---
  try {
    await withSpinner('Verifying release signature...', async () => {
      const pk = getReleasePublicKey();
      const sig = parseSignature(sigText);
      verifyMinisign({ payload: Buffer.from(sumsText, 'utf-8'), signature: sig, publicKey: pk });
    });
  } catch (e) {
    if (e instanceof MinisignError) {
      ui.error(`Minisign verification failed: ${e.message}`);
      ui.hint('Refusing to install — release artifacts may have been tampered with.');
      process.exit(1);
    }
    throw e;
  }

  // --- Layer 1: SHA256SUMS pins the binary's hash ---
  const computedSha = createHash('sha256').update(binary).digest('hex');
  const expectedSha = parseSha256sumsLine(sumsText, asset.name);
  if (!expectedSha) {
    ui.error(`SHA256SUMS does not include an entry for ${asset.name}.`);
    process.exit(1);
  }
  if (computedSha.toLowerCase() !== expectedSha.toLowerCase()) {
    ui.error(`Downloaded binary hash mismatch.`);
    ui.hint(`  expected: ${expectedSha}`);
    ui.hint(`  got:      ${computedSha}`);
    process.exit(1);
  }

  // --- Layer 3: Sigstore attestation ---
  try {
    await withSpinner('Verifying build provenance...', async () => {
      const bundle = await fetchAttestationBundle({
        owner: REPO_OWNER,
        repo: REPO_NAME,
        digest: computedSha,
      });
      const expectedIdentity = `https://github.com/${REPO_OWNER}/${REPO_NAME}/${WORKFLOW_PATH}@refs/tags/${release.tag}`;
      verifyAttestation({
        bundleJson: bundle,
        artifactDigest: computedSha,
        expectedIdentity,
      });
    });
  } catch (e) {
    if (e instanceof AttestationError || e instanceof FetchError) {
      ui.error(`Build provenance verification failed: ${e.message}`);
      ui.hint('Refusing to install — release does not have a valid Sigstore attestation.');
      process.exit(1);
    }
    throw e;
  }

  // --- Install ---
  try {
    await withSpinner('Installing...', () => {
      installBinary({ targetPath: process.execPath, newBytes: binary });
      return Promise.resolve();
    });
  } catch (e) {
    if (e instanceof InstallError) {
      ui.error(`Install failed: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }

  ui.blank();
  ui.success(`Updated to ${ui.bold(release.tag)}.`);
}

function findAsset(release: ReleaseInfo, name: string): ReleaseInfo['assets'][number] {
  const match = release.assets.find((a) => a.name === name);
  if (!match) {
    ui.error(`Release ${release.tag} is missing required asset: ${name}`);
    process.exit(1);
  }
  return match;
}

/**
 * Parse a single line out of a SHA256SUMS file. Format: each line is
 * `<64-hex-digest>  <filename>` (two spaces, per shasum/sha256sum output).
 * Returns the hex digest for `assetName`, or undefined if absent.
 */
function parseSha256sumsLine(sumsText: string, assetName: string): string | undefined {
  for (const line of sumsText.split('\n')) {
    const match = line.match(/^([0-9a-fA-F]{64})\s+\*?(\S+)\s*$/);
    if (match && match[2] === assetName) return match[1];
  }
  return undefined;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
