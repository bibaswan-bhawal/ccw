# Changelog

## [0.5.0](https://github.com/bibaswan-bhawal/ccw/compare/v0.4.0...v0.5.0) (2026-07-10)


### Features

* name Claude sessions after the worktree feature name ([0de01ff](https://github.com/bibaswan-bhawal/ccw/commit/0de01ff628dc57ea8cb59c839818e93ca869b51c))
* name Claude sessions after the worktree feature name ([2147d14](https://github.com/bibaswan-bhawal/ccw/commit/2147d1463427dae6d2602ea6f333f0c3f93a5ec4))

## [0.4.0](https://github.com/bibaswan-bhawal/ccw/compare/v0.3.2...v0.4.0) (2026-07-01)


### Features

* **update:** drive brew upgrade for Homebrew installs ([f05166f](https://github.com/bibaswan-bhawal/ccw/commit/f05166ff74cbb9512d7b4ad82200d081de6fc44a))
* **update:** make ccw update drive brew upgrade for Homebrew installs ([c220cfd](https://github.com/bibaswan-bhawal/ccw/commit/c220cfdac2567cbbe2ec9b3d258eb4d812ebc932))

## [0.3.2](https://github.com/bibaswan-bhawal/ccw/compare/v0.3.1...v0.3.2) (2026-07-01)


### Bug Fixes

* **pty:** signal Claude on resize so single resizes (Warp panel toggle) reflow ([1f8d936](https://github.com/bibaswan-bhawal/ccw/commit/1f8d936c1aa679340c847b25b6d5cfea7f0a1895))
* **pty:** signal Claude on resize so single resizes reflow ([921b7ec](https://github.com/bibaswan-bhawal/ccw/commit/921b7ec93dcd448b8f9638eb91997babe127c013))

## [0.3.1](https://github.com/bibaswan-bhawal/ccw/compare/v0.3.0...v0.3.1) (2026-06-30)


### Bug Fixes

* **pty:** track terminal resizes via TIOCGWINSZ + poll backstop ([b095384](https://github.com/bibaswan-bhawal/ccw/commit/b095384a46ce4254b9a9a64622fa5aac6fc138fe))
* self-update binary-target guards + PTY resize tracking ([faa8143](https://github.com/bibaswan-bhawal/ccw/commit/faa814331963ca22e17ff7736c155149c5ac7f96))
* **update:** never self-update when running from source or under brew ([d54a27b](https://github.com/bibaswan-bhawal/ccw/commit/d54a27bc6a3c021f9c0339d43a10c76aef9a0016))

## [0.3.0](https://github.com/bibaswan-bhawal/ccw/compare/v0.2.1...v0.3.0) (2026-06-30)


### Features

* **claude:** run Claude in a PTY proxy with spawnSync fallback ([b65fda5](https://github.com/bibaswan-bhawal/ccw/commit/b65fda5200389017c1456425719b00531e64b714))
* **claude:** run Claude in a PTY proxy with spawnSync fallback ([c6c723e](https://github.com/bibaswan-bhawal/ccw/commit/c6c723e15af34f8a65595ec3218904fe1ca8728f))


### Documentation

* capture PTY proxy design + feasibility findings ([0ad2fe8](https://github.com/bibaswan-bhawal/ccw/commit/0ad2fe89cf2ed8547ffe450e0b3d0f0722ea455d))

## [0.2.1](https://github.com/bibaswan-bhawal/ccw/compare/v0.2.0...v0.2.1) (2026-06-30)


### Bug Fixes

* **claude:** spawn Claude synchronously to stop dropped keystrokes ([4f5a7a3](https://github.com/bibaswan-bhawal/ccw/commit/4f5a7a3ec5647e95f2e793e6e77d07bf496853f6))

## [0.2.0](https://github.com/bibaswan-bhawal/ccw/compare/v0.1.2...v0.2.0) (2026-06-26)


### Features

* **jira:** fetch every field, classify description via claude -p ([cf52b84](https://github.com/bibaswan-bhawal/ccw/commit/cf52b84ebb8aa85658f72b0623ae0191950b3424))


### Bug Fixes

* **claude:** relinquish stdin before launching Claude ([72f8b3c](https://github.com/bibaswan-bhawal/ccw/commit/72f8b3ca4404401e4acf15ba571daf928375bfba))
* **jira:** run description classifier without blocking the event loop ([c8c8e0d](https://github.com/bibaswan-bhawal/ccw/commit/c8c8e0da630a9f2bd41438b4ea390ef1b4f63cd2))
* **update:** bound update-check fetch with a 5s timeout ([06c2cbd](https://github.com/bibaswan-bhawal/ccw/commit/06c2cbd11aa3af3b5978130943dc4c8730b3912c))

## [0.1.2](https://github.com/bibaswan-bhawal/ccw/compare/v0.1.1...v0.1.2) (2026-05-28)


### Bug Fixes

* make Sigstore attestation verification actually work under Bun ([e1f25f1](https://github.com/bibaswan-bhawal/ccw/commit/e1f25f1e83a08f7d2b59e057c66e0a5eadce7645))

## [0.1.1](https://github.com/bibaswan-bhawal/ccw/compare/v0.1.0...v0.1.1) (2026-05-27)


### Documentation

* add security policy ([a57397b](https://github.com/bibaswan-bhawal/ccw/commit/a57397bf17fe46e9cea13813584c80abe017d536))
* document brew install, ccw update, and release verification ([ee900b6](https://github.com/bibaswan-bhawal/ccw/commit/ee900b65232ea316c991617a29de4dbd8d8116ae))

## [0.1.0](https://github.com/bibaswan-bhawal/ccw/compare/v0.1.0...v0.1.0) (2026-05-27)


### Features

* add ccw update with signed and attested self-update ([325b405](https://github.com/bibaswan-bhawal/ccw/commit/325b405829aa716adc0b6e0eded3f6e277677d3d))
* configure release signing public key ([d83a3d3](https://github.com/bibaswan-bhawal/ccw/commit/d83a3d38b59b81c20af11354a4aefb740d5c96df))
