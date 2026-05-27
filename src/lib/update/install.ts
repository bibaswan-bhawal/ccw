/**
 * Atomic binary replacement for `ccw update`.
 *
 * macOS attaches a `com.apple.provenance` xattr to executables it has run
 * before; if a new binary is dropped in place with the prior xattr still
 * present, Gatekeeper signature-mismatch logic SIGKILLs it on next launch
 * (exit 137). The mitigation is the four-step ritual below:
 *
 *   1. Write the new bytes to `<execPath>.new`.
 *   2. `xattr -c` to clear quarantine/provenance attributes.
 *   3. Ad-hoc `codesign --force --sign -` to give it a fresh signature.
 *   4. Atomic `rename` over `<execPath>`.
 *
 * On non-macOS platforms we only do steps 1 and 4.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';

export class InstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstallError';
  }
}

export interface InstallOptions {
  /** Absolute path to the binary that will be replaced (typically process.execPath). */
  targetPath: string;
  /** New binary bytes to install. */
  newBytes: Buffer;
}

/**
 * Atomically replace `targetPath` with `newBytes`. On macOS, applies the
 * xattr clear + ad-hoc codesign ritual that prevents Gatekeeper SIGKILL.
 * On failure mid-install, attempts to remove the partial `.new` file so
 * a retry isn't blocked.
 */
export function installBinary(opts: InstallOptions): void {
  const tempPath = `${opts.targetPath}.new`;

  try {
    writeFileSync(tempPath, opts.newBytes);
    chmodSync(tempPath, 0o755);

    if (process.platform === 'darwin') {
      runOrThrow('xattr', ['-c', tempPath], 'clearing xattrs');
      runOrThrow('codesign', ['--force', '--sign', '-', tempPath], 'ad-hoc codesign');
    }

    renameSync(tempPath, opts.targetPath);
  } catch (e) {
    // Best-effort cleanup. If `tempPath` doesn't exist, unlinkSync throws
    // — swallow that since the original error is what the caller cares about.
    try {
      unlinkSync(tempPath);
    } catch {
      // ignore
    }
    if (e instanceof InstallError) throw e;
    throw new InstallError(`install failed: ${(e as Error).message}`);
  }
}

function runOrThrow(command: string, args: string[], label: string): void {
  const result = spawnSync(command, args, { stdio: 'pipe' });
  if (result.error) {
    throw new InstallError(`${label}: failed to spawn ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = result.stderr?.toString().trim() ?? '';
    throw new InstallError(`${label}: ${command} exited ${result.status}${stderr ? ` — ${stderr}` : ''}`);
  }
}
