# Security Policy

## Supported Versions

Only the most recent minor release of ccw receives security updates. If you're on an older version, run `ccw update` (or `brew upgrade ccw`) before reporting an issue.

## Reporting a Vulnerability

**Please do not open public issues for security vulnerabilities.** Use GitHub's private security advisory channel:

→ [Open a security advisory](https://github.com/bibaswan-bhawal/ccw/security/advisories/new)

What to expect:

- **Initial acknowledgment** within 7 days.
- **Fix or substantive response** within 30 days for confirmed vulnerabilities.
- **Public credit** in the release notes for the fix (only if you'd like — please mention preferred attribution in the report).

If GitHub Security Advisories are unavailable for some reason, see the maintainer's profile for an alternate contact.

## Scope

In scope:

- ccw's signature verification, attestation verification, and download paths (`src/lib/update/`).
- Trust-root data: the embedded minisign public key and the vendored Sigstore trusted root.
- The Homebrew tap formula in [`bibaswan-bhawal/homebrew-ccw`](https://github.com/bibaswan-bhawal/homebrew-ccw).
- Embedded credentials or secrets accidentally committed to the repo.
- Dependency vulnerabilities that affect end users (e.g. a sigstore-js CVE).

Out of scope:

- Bugs unrelated to security — open a regular issue.
- Vulnerabilities in [Claude Code](https://docs.claude.com/en/docs/claude-code) itself — those go to Anthropic.
- Theoretical attacks requiring root, local filesystem write access to `~/.ccw/`, or a compromised CI environment that the maintainer also has access to. ccw doesn't defend against an attacker who already owns your machine.

## Release Integrity

Every release ships with three independent verification layers:

1. **`SHA256SUMS`** — manifest of binary hashes.
2. **`SHA256SUMS.minisig`** — minisign signature over the manifest, signed by the ccw release key.
3. **Sigstore build provenance attestations** — link each binary to the specific GitHub Actions workflow run that produced it, verifiable via [Sigstore's transparency log](https://search.sigstore.dev/).

`ccw update` and the embedded verification logic require all three to pass before installing any binary. There is no `--allow-unsigned` escape hatch.

### Public key

The ccw release minisign public key:

```
RWTX1Db0eaMFBoWsAN0cI0XodrqfXrJeqPsHBqLfNB6UaSXUwGE74NhH
```

This is embedded in every ccw binary at build time. If the key is ever rotated (e.g. compromise), a new ccw release will ship with the new key embedded, and users will need to reinstall (`brew reinstall ccw` or download fresh from the GitHub release).

### Manual verification

```bash
gh release download v0.1.0 --repo bibaswan-bhawal/ccw
minisign -Vm SHA256SUMS -P RWTX1Db0eaMFBoWsAN0cI0XodrqfXrJeqPsHBqLfNB6UaSXUwGE74NhH
sha256sum -c SHA256SUMS              # confirm the binary you downloaded matches
gh attestation verify ccw-macos-arm64 --owner bibaswan-bhawal
```
