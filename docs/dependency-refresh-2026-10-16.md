# Dependency refresh: October 16, 2026

Base: `origin/develop` at `e00112a0ea24f85f730ad89fe9fd381829d37435`.
Scope: this TypeScript SDK only. No other language manifests exist in this repository.

## Changes

- tsup 8.5.1 → 9.0.0: remove the TypeScript deprecation workaround because tsup no longer sets
  `baseUrl` during declaration builds. Build-tool Node requirements fit every pinned CI image;
  the SDK still targets Node 22.
- Vitest and coverage 5.0.3 → 5.0.5: update the Stryker patch version guards and selection fixtures.
  Stryker remains at its latest stable release, 10.0.0. Its upstream test-name selection still needs
  the existing patch; the patch's upstream file hashes remain unchanged.
- Update music-metadata, Knip, Prettier, typescript-eslint, and eligible lockfile dependencies.
  Keep runtime caret ranges and exact development pins.
- Pin just 1.59.0 for the newer zizmor check. Keep the PR action because it updates existing PRs
  and signs commits through the App; document that reason in its scoped zizmor suppression.
- Refresh GitHub Actions to the latest stable release commit SHAs, with matching version comments.
  CodeQL uses the action release (`v4.39.0`), not its separate CodeQL bundle release.
- Refresh Node image digests within the existing 22/24/26 Bookworm matrix. Keep full mutation
  images because Stryker needs `ps`, which the slim variants lack.
- Update Bun, Hadolint, actionlint, zizmor, Gitleaks, and typos. The typos-only Python image moves
  from 3.14 to 3.15; typos publishes Python-independent wheels and requires Python 3.8 or newer.
  Image digests come from authenticated registry manifest responses.

## Holds checked

- Node `>=22`, CI 22/24/26, and `@types/node` 22.20.5: preserve the runtime support contract.
  22.20.5 is the latest Node 22 types release.
- TypeScript 6.0.3: latest 6.x; latest TypeScript is 7.0.2, but typescript-eslint 8.71.2 accepts
  `>=4.8.4 <6.1.0`.
- `typescript-floor` 5.5.4: README and package checks promise consumers TypeScript 5.5 support;
  this alias tests that promise and is intentionally ignored by Dependabot.
- The openapi-typescript override: latest openapi-typescript 7.13.0 still peers on `^5.x`.
  Preserve the existing mapping to the project's TypeScript compiler.
- Conformance `v1.0.0`: still the only published stable tag; use its exact mock and fixtures.
- Generated files and the OpenAPI snapshot: unchanged; the generator version did not change.
- Deno 2.9.7, ShellCheck 0.11.0, and oasdiff 1.33.0: already latest stable; registry digests match.

## Validation handoff

Native validation uses Node 24.21.0 and npm 12.2.0, through the workspace `scripts/heavy.sh` wrapper.
The conformance mock and fixtures are exported from tag `v1.0.0` into a temporary directory;
other worktrees are read only. Docker is unavailable, so the controller must still run `just ci`.

Passed: both TypeScript projects; ESLint; Prettier; Knip; 1,733 unit tests across 35 files;
coverage (99.11% statements, 97.02% branches); all 34 strict conformance scenarios; examples;
build; mutation-score guard tests; patched Stryker selection and idempotence checks; production
npm audit; npm signature verification; Hadolint; actionlint; ShellCheck; Gitleaks; typos.

Passed after pinning just: zizmor with no findings, actionlint, Prettier, and typos.
Packed-package checks also passed: exact file inventory, publint, attw (ESM profile), a clean
production-only tarball install, TypeScript 5.5.4 consumer declarations, ESM balance smoke, and
`require()` exports.

Native npm 12 changed `npm pack --json` to a keyed object; use npm 11 for package checks to match
the Node 24 CI image, rather than changing the SDK's CI scripts for a host-only difference.
An online publish dry run refused the already-published version 1.0.1; the final dry run uses an
empty offline cache to match the Docker recipe's network restriction. No SDK version is changed.

The full npm audit reports two existing moderate development-only entries (`qs` and its parent
`typed-rest-client`, through Stryker). The parent pins `qs` 6.15.1 exactly. This refresh does not
introduce an override of that upstream pin; production audit passes.

Not run: Docker recipes `just ci`, `just lint`, `just test`, `just conformance`, `just examples`,
`just build`, `just publish-dry-run`, `just mutation`, `just regen`, and `just smoke`. Native checks
cover ordinary lint/test/conformance/examples/build behavior on Node 24, but do not replace the
Node 22/26 lanes, clean Docker/Bun/Deno consumers, full mutation run, or production smoke.
No push, merge, release, or publication occurred.
