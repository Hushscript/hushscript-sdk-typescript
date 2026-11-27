# Changelog

## Unreleased

### Features

* add the `vet_mode` (Veterinary mode, beta; en, en_au, en_uk, en_us, es, fr, de, de_ch; refused with `medical_mode` and in private mode) and `keep_disfluencies` (free, default off) transcription options, both echoed in the job options summary; the medical language list and the API spec are synced.

### Bug Fixes

* translation no longer forces speaker detection on: `speakers` is sent exactly as given. `translateTo` accepts every base source language and takes at most 15 distinct targets (trimmed, lowercased); more is refused before any request with `PreflightError` `invalid_option`.
* `medical` and `vet` read `language` the way the server does (trimmed, ASCII-lowercased), so a padded or upper-case code is no longer refused client-side.
* the API spec is synced: the `origin_source` request option and the `origin_source`, `origin_app` and job `title` response fields.
* the API spec matches production: `translation_targets` drops its `maxItems` of 15, because the backend counts the cap after deduplication; the SDK still refuses more than 15 distinct targets before any request.
* the conformance suite is pinned to the `v1.1.0` tag.

### Documentation

* README links point at the live pricing page and the SDK section of the developers page; the old `/pricing` and `/sdks` URLs redirect there.

## [1.1.3](https://github.com/Hushscript/hushscript-sdk-typescript/compare/v1.1.2...v1.1.3) (2026-11-09)


### Miscellaneous Chores

* release 1.1.3 ([b23def9](https://github.com/Hushscript/hushscript-sdk-typescript/commit/b23def942470931b0294241f5ed9f229d4627a4e))

## [1.1.2](https://github.com/Hushscript/hushscript-sdk-typescript/compare/v1.1.1...v1.1.2) (2026-11-08)


### Bug Fixes

* keep the caller's abort reaching a request after a gc ([126d53e](https://github.com/Hushscript/hushscript-sdk-typescript/commit/126d53ee2480b81eb72080805ac66a97760a4f31))
* raise the abort listener cap and pin the abort reason ([b3b014f](https://github.com/Hushscript/hushscript-sdk-typescript/commit/b3b014f227ec1a34f4ce7cc07ea675746ea65d54))

## [1.1.1](https://github.com/Hushscript/hushscript-sdk-typescript/compare/v1.1.0...v1.1.1) (2026-10-31)


### Bug Fixes

* **deps:** update dependencies to latest ([ebbd530](https://github.com/Hushscript/hushscript-sdk-typescript/commit/ebbd5305ce5169febd892154cb38f957d9102870))

## [1.1.0](https://github.com/Hushscript/hushscript-sdk-typescript/compare/v1.0.1...v1.1.0) (2026-10-23)


### Features

* sync with the api spec ([ef37f79](https://github.com/Hushscript/hushscript-sdk-typescript/commit/ef37f79636d2eb86912b77d3f0050f9796d8c511))

## [1.0.1](https://github.com/Hushscript/hushscript-sdk-typescript/compare/v1.0.0...v1.0.1) (2026-10-13)


### Miscellaneous Chores

* release 1.0.1 ([6061daa](https://github.com/Hushscript/hushscript-sdk-typescript/commit/6061daa0e53967e8c2d9383d4d80eaa5c54ca934))

## 1.0.0 (2026-10-13)


### Features

* initial release ([adca89e](https://github.com/Hushscript/hushscript-sdk-typescript/commit/adca89e0c1b70c9be0f6dc0dbf7a333ebaae6831))
