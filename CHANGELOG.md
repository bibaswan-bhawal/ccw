# Changelog

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
