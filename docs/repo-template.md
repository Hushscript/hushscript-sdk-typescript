# Repo template

This repository is the template for the Python, Go, PHP and CLI SDK repositories. It pins down the
container model, the `just` entry points, the static-analysis gates and the CI and release
automation from the SDK spec (sections 11 and 13). A new repository copies the files marked "copy"
below unchanged and edits the files marked "adapt" at the lines listed for its language.

The spec (`docs/sdk/spec.md` in the workspace) is binding. This document records how the TypeScript
repository satisfies it and which lines are language-specific. Where it says "same as", copy the
file from this repository byte for byte.

## Files

| File                                                            | Copy or adapt | What changes per language                                                                                                                                                                               |
| --------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LICENSE`, `SECURITY.md`                                        | copy          | Nothing.                                                                                                                                                                                                |
| `.github/CODEOWNERS`                                            | copy          | Nothing. The team handle is a placeholder until the org team exists.                                                                                                                                    |
| `.github/workflows/scorecard.yml`, `dependency-review.yml`      | copy          | Nothing.                                                                                                                                                                                                |
| `.github/workflows/codeql.yml`                                  | adapt         | `languages:` and the `category` (`javascript-typescript`, `python`, `go`). PHP has no CodeQL job; see "PHP".                                                                                            |
| `.github/workflows/ci.yml`                                      | adapt         | The matrix values (`node: ['22', '24']` becomes the language's floor and latest) and the env name passed to `just ci`.                                                                                  |
| `.github/workflows/nightly.yml`                                 | adapt         | Recipe names stay. Drop the `fuzz` job for PHP. Python uses `FC_RUNS_FACTOR` equivalents (Hypothesis `max_examples` profile), Go runs native fuzz targets for 60 s each.                                |
| `.github/workflows/regenerate.yml`                              | adapt         | Nothing for the control flow. `just regen` is the generator step. Egress list gains the language's registry hosts.                                                                                      |
| `.github/workflows/release.yml`                                 | adapt         | `release-type` in the workflow input and in `release-please-config.json` (`node`, `python`, `go`, `php`).                                                                                               |
| `.github/workflows/publish.yml`                                 | adapt         | The registry steps; see "Publish".                                                                                                                                                                      |
| `.github/dependabot.yml`                                        | adapt         | The language ecosystem (`npm`, `pip` or `uv`, `gomod`, `composer`); keep `docker` on `/docker` and `github-actions`. Keep the 7-day cooldown and the `chore` commit prefix.                             |
| `release-please-config.json`, `.release-please-manifest.json`   | adapt         | `release-type`, `package-name`. Keep `bump-minor-pre-major: true` (spec section 11: a breaking regen PR bumps the minor in 0.x). Manifest starts at `0.0.0`; the first `feat:` release becomes `0.1.0`. |
| `docker/dev.Dockerfile`                                         | adapt         | The `base` image, the `deps` install command, the version stages and the `proddeps` stage; see "Dockerfile".                                                                                            |
| `docker/typos.Dockerfile`                                       | copy          | Nothing.                                                                                                                                                                                                |
| `compose.yaml`                                                  | adapt         | Service commands, the `x-scratch` tmpfs list, the `regen` bind mounts. Structure, hardening and the `mock` service are copied.                                                                          |
| `justfile`                                                      | adapt         | Recipe bodies for `test`, `mutation`, `lint`, `build`, `regen`; the image table. Recipe names and arguments are fixed by spec 13.1.                                                                     |
| `.hadolint.yaml`, `zizmor.yml`, `_typos.toml`, `.gitleaks.toml` | copy          | `_typos.toml` and `.gitleaks.toml` paths follow the repo layout.                                                                                                                                        |
| `.dockerignore`, `.gitignore`, `.prettierignore`                | adapt         | Language build output and caches.                                                                                                                                                                       |
| `scripts/generate.*`                                            | adapt         | The generator. Writes the spec to `openapi.json` byte for byte, then the language's low-level layer, then the three tables.                                                                             |
| `scripts/check-regen-diff.sh`                                   | copy          | Nothing. Fails unless only `openapi.json` and the generated directory changed.                                                                                                                          |
| `openapi.json`                                                  | copy          | Identical in every repo (the committed spec).                                                                                                                                                           |
| `README.md`                                                     | adapt         | Stub per language; no em-dashes.                                                                                                                                                                        |
| Static-analysis configs                                         | adapt         | Per the language column of spec 13.2: `eslint.config.js`, `.prettierrc`, `knip.json`, `stryker.config.json`, `tsconfig*.json` here.                                                                     |

## Container model

Everything runs in containers (spec 13.1). The facts the compose file relies on:

- Services `test`, `mutation`, `lint`, `conformance` and `examples` use the `dev` image with
  `network_mode: "service:mock"` and `depends_on: mock: condition: service_healthy`. They share the
  mock's network namespace, so the SDK reaches `http://127.0.0.1:4010` and has nothing else. The
  mock's network `sdk` is `internal: true`.
- Only `regen` and `smoke` have outbound network. `regen` fetches the spec and `hints.json`;
  `smoke` talks to production with `SMOKE_TOKEN`.
- Every service has `init: true`, `read_only: true`, `cap_drop: [ALL]`,
  `security_opt: [no-new-privileges:true]`, `mem_limit: 4g` (the mock: 512m), `pids_limit: 512`
  (mock: 128) and the label `sdk.test: "1"`. The YAML anchor `x-hardening` carries these.
- Because the root filesystem is read-only, every path a tool writes to needs a `tmpfs` entry or a
  bind mount. The TypeScript list (`x-scratch`): `/tmp`, `/work/reports`, `/work/.stryker-tmp`,
  `/work/node_modules/.vite`, `/work/node_modules/.vite-temp`, `/work/node_modules/.cache`. Find the
  equivalent for the language's tools by running `just test` and reading the EROFS errors. Prefer a
  tool setting that points the output at `/tmp` over a new mount (the coverage report does this).
- `regen` runs as the host user (`HOST_UID`/`HOST_GID`, exported by the justfile) and bind-mounts
  `./openapi.json` and the generated directory read-write. Nothing else is writable.
- Long commands carry their own limit inside the container (`timeout 1800 ...`). A host-side
  `timeout` only kills the client.
- Every recipe that starts compose installs `trap 'docker compose down --remove-orphans' EXIT`, so the
  mock never outlives the recipe. After a run, `docker ps -q --filter label=sdk.test` must be empty.
- Host code never runs tools. The only host-side commands in CI are `just`, `curl` and `jq` (in
  `regenerate.yml`) and `npm` in `publish.yml` (a registry upload has to run where the credentials
  are).

### The mock and the conformance repository

`compose.yaml` builds the mock from
`${CONFORMANCE_CONTEXT:-https://github.com/Hushscript/hushscript-sdk-conformance.git#v0.1.0}`. Until
the conformance repository is public and tagged, set
`CONFORMANCE_CONTEXT=../hushscript-sdk-conformance` (a sibling checkout) in the environment of every
`just` call. `hints.json` is read from `$CONFORMANCE_DIR/hints.json` when `CONFORMANCE_DIR` is set (the
`regen` recipe mounts it read-only at `/conformance` and rewrites the variable), otherwise from
`raw.githubusercontent.com` at the tag in `package.json` `config.conformanceRef`. The other languages keep the tag in one place of their own (a manifest
field or a constant in the generator); it must equal the compose default.

### Justfile

Recipes and arguments are fixed: `test [version]`, `lint [version]`, `conformance [version]`,
`examples [version]`, `build [version]`, `regen [spec]`, `ci [version]`, `smoke`, plus `mutation`
(used by the nightly job). The version argument is the runtime version (default: the floor) and is
validated by a `just` `error()` expression. `ci` with no argument runs lint on the floor, test and
conformance on floor and latest, then examples and build on the floor. With an argument it runs
everything on that one version, which is what the CI matrix passes.

Tool images other than the dev image (hadolint, actionlint, zizmor, shellcheck, gitleaks, typos,
Bun, Deno, oasdiff) are `docker run` calls from the justfile, pinned by digest, with the sandbox flags
`--rm --init --label sdk.test=1 --cap-drop ALL --read-only --security-opt no-new-privileges
--pids-limit 512 --memory 4g --tmpfs /tmp --network none`. `just lint` also runs one step with network
access: the dependency audit (`npm audit --omit=dev --audit-level=high` and `npm audit signatures`,
`pip-audit`, `govulncheck`, `composer audit`). It asks the registry about advisories, so it cannot be
hermetic. Everything else in `lint` has no network.

The justfile holds image digests that Dependabot cannot bump (it reads Dockerfiles and workflows, not
justfiles). Refresh them by hand when a tool needs upgrading, and keep them equal to the conformance
repository's justfile for the images both use.

### Dockerfile

One multi-stage file, `docker/dev.Dockerfile`:

1. Named stages hold the digest-pinned official images (`node22`, `node24`). `ARG NODE_VERSION` selects
   one through `FROM node${NODE_VERSION} AS base`. This keeps the digests as literal `FROM` lines,
   which Dependabot can update. The indirection needs `# hadolint ignore=DL3006`.
2. `base` creates the non-root user (uid and gid 10001), sets `HOME=/tmp` and `WORKDIR /work`.
3. `deps` installs from the lockfile only (`npm ci --ignore-scripts`; the other languages per spec
   13.1).
4. `dev` copies `node_modules` from `deps`, copies the source, puts `node_modules/.bin` on `PATH` and
   switches to uid 10001.
5. `proddeps` installs production dependencies only. `just build` uses it to assemble an install
   without a network: the packed tarball is extracted into `node_modules/@hushscript/sdk` next to
   these dependencies.

### Bootstrapping the lockfile

The lockfile is created once, in a container with network and the repository's manifest, then
committed (Dependabot maintains it afterwards):

```sh
d=$(mktemp -d) && cp package.json "$d" && chmod 777 "$d"
docker run --rm --init --label claude.adhoc=1 --label sdk.test=1 --cap-drop ALL \
  --security-opt no-new-privileges --memory 2g --pids-limit 256 --user "$(id -u):$(id -g)" \
  -e HOME=/tmp --tmpfs /tmp -v "$d":/work -w /work node:22-bookworm-slim@sha256:<digest> \
  timeout 300 npm install --package-lock-only --ignore-scripts --no-audit --no-fund
cp "$d/package-lock.json" .
```

Substitute `uv lock`, `go mod tidy` and `composer update --no-plugins --no-scripts` with the matching
base image. Pin every dependency to an exact version (no ranges) in the manifest.

## Static analysis (TypeScript values)

The gates are in `just lint` and `just test`. Values for the other languages are in spec 13.2.

- `tsc --noEmit` with every strict flag from spec 13.2, plus `moduleDetection: force`,
  `erasableSyntaxOnly` and `allowImportingTsExtensions` (the conformance runner and the examples run
  under Node's type stripping and import `.ts` files). `isolatedDeclarations` cannot coexist with
  `allowJs`, so JavaScript files (`scripts/*.mjs`, `eslint.config.js`) are checked by
  `tsconfig.scripts.json` and the tests import the generator through `scripts/generate.d.mts`.
  `eslint.config.js` points JavaScript files at that second project.
- ESLint flat config: `typescript-eslint` `strictTypeChecked` and `stylisticTypeChecked`,
  `eslint-plugin-regexp`, `eslint-plugin-n`, `--max-warnings 0`, `reportUnusedDisableDirectives`.
  `src/generated/` is ignored by ESLint and Prettier but not by `tsc`.
- `knip` with `ignoreDependencies` for packages used by command line only (`openapi-typescript`,
  `prettier`, `publint`, `@arethetypeswrong/cli`) and for runtime dependencies that arrive with the
  client (`openapi-fetch`, `music-metadata`). Drop those two entries when the client imports them.
- vitest with v8 coverage: `include: ["src/**/*.ts"]`, `exclude: ["src/generated/**"]`, thresholds
  `lines: 90`, `branches: 85`, `maxWorkers: 4`. The report goes to `os.tmpdir()` because the root
  filesystem is read-only. `test/setup.ts` sets the global `fast-check` run count to `100 *
FC_RUNS_FACTOR`; the nightly job sets the factor to 10.
- Package checks in `just build`: `npm pack --dry-run`, `publint` and `attw --profile esm-only` on the
  real tarball, then an import of the tarball in clean Node (the matrix version), Bun and Deno
  containers.
- Mutation: `stryker.config.json` mutates `src/http` and `src/transcribe`, `break` at 80,
  `allowEmpty: true` until those directories exist.
- Whole-repo: hadolint (`.hadolint.yaml`, failure threshold `info`), actionlint, zizmor `--pedantic`
  with `zizmor.yml` requiring hash pins, shellcheck on `scripts/*.sh`, gitleaks on the full history,
  typos on the whole tree minus `openapi.json`, lockfiles and generated code.

Two tool quirks worth knowing:

- `tsup` bundles its own config next to the config file, which fails on a read-only root. `just
build` copies `tsup.config.ts` to `/tmp` and passes `--config`. Likewise `vitest` needs a tmpfs at
  `node_modules/.vite-temp`.
- `tsup`'s declaration build sets `baseUrl`, which TypeScript 6 deprecates: the config passes
  `dts.compilerOptions.ignoreDeprecations: "6.0"`. `openapi-typescript` peers on TypeScript 5, so
  `package.json` has an `overrides` entry mapping its `typescript` to the repo's.

## Generator contract

Every repository's generator (`scripts/generate.*`, run only by `just regen`):

1. Takes an optional spec path or URL (default `https://api.hushscript.com/openapi.json`).
2. Writes the spec to `openapi.json` byte for byte (adding a trailing newline if missing). Do not
   reserialize it: JSON libraries reorder numeric keys and make the regen diff unreadable.
3. Generates the language's low-level layer (spec section 5) into the generated directory.
4. Emits the error catalog (slug to code, status and meaning), the operation scope map (`"GET
/v1/account"` to scope) and the hints table (slug to text, from the conformance `hints.json`).
   Duplicate slugs, non-integer codes and empty strings fail the run.
5. Is idempotent: running it twice leaves `git status` clean. Tests re-emit the tables from the
   committed `openapi.json` and compare them with the committed files, so drift fails `just test`.

The tables in TypeScript are `ERROR_CATALOG`, `OPERATION_SCOPES` and `HINTS`. The other languages use
their own naming from spec section 4.

## Workflows

Every workflow starts with `permissions: {}` and grants each job the minimum. Every job's first step is
`step-security/harden-runner` with `egress-policy: block` and an allow-list. Every `actions/checkout`
sets `persist-credentials: false`. Every Action is pinned by full commit SHA with the version in a
comment, and every concurrency block sets `cancel-in-progress: true` (zizmor pedantic).

| Workflow                | Trigger                         | Job permissions                                                                    |
| ----------------------- | ------------------------------- | ---------------------------------------------------------------------------------- |
| `ci.yml`                | PR, push to `main`              | `contents: read`                                                                   |
| `nightly.yml`           | schedule only                   | `contents: read` (smoke runs in environment `smoke`)                               |
| `regenerate.yml`        | daily cron, `workflow_dispatch` | `contents: write`, `pull-requests: write`                                          |
| `release.yml`           | push to `main`                  | `contents: write`, `pull-requests: write` (release-please needs both)              |
| `publish.yml`           | `release: published`            | `contents: read`, `id-token: write`, `attestations: write` (environment `release`) |
| `codeql.yml`            | PR, push, weekly                | `contents: read`, `security-events: write`                                         |
| `scorecard.yml`         | weekly, push, branch protection | `contents: read`, `actions: read`, `security-events: write`, `id-token: write`     |
| `dependency-review.yml` | PR                              | `contents: read`                                                                   |

`regenerate.yml` flow: fetch the spec with `curl` and compare it with `openapi.json` after `jq -S`
normalization (stop if equal); run `oasdiff breaking --fail-on ERR` in the pinned image (exit 0 means
not breaking, 1 breaking, anything else fails the job); `just regen`;
`scripts/check-regen-diff.sh`; `just ci`; then `peter-evans/create-pull-request` on branch `regen/spec`
titled `feat: sync with api spec` (`feat!:` when breaking) with the oasdiff output as the body. A PR
opened with the default token does not start `ci.yml`, so the in-workflow `just ci` is the gate.

### Publish

`publish.yml` builds from the release tag, packs one tarball, writes a CycloneDX SBOM, attests the
tarball with `actions/attest-build-provenance`, uploads the tarball and SBOM as an artifact and
publishes that same tarball. Language-specific parts:

- TypeScript: `actions/setup-node` with `registry-url`, `npm ci --ignore-scripts`, `npm run build`,
  `npm pack`, `npm sbom --sbom-format cyclonedx`, `npm publish "$TARBALL" --provenance --access
public`, `NODE_AUTH_TOKEN` from the `NPM_TOKEN` secret of environment `release`.
- Python: build sdist and wheel in the pinned Python container, `twine check`, publish with PyPI
  trusted publishing (`pypa/gh-action-pypi-publish`, `id-token: write`, no token), attestations on.
  SBOM from `cyclonedx-py`.
- Go and PHP: there is no registry upload. The workflow attaches the attested source archive
  (`git archive`) to the GitHub release (`contents: write` for that job only) and a CycloneDX SBOM
  produced by a pinned tool image.
- CLI: as TypeScript, with its own package name.

`release.yml` passes `secrets.RELEASE_PLEASE_TOKEN || github.token`. A release created with the default
token does not start `publish.yml`, so set that secret to a GitHub App or fine-grained PAT token before
the first release.

### Pinned actions

Reuse these SHAs; refresh them with Dependabot.

| Action                             | SHA                                        | Version |
| ---------------------------------- | ------------------------------------------ | ------- |
| `actions/checkout`                 | `3d3c42e5aac5ba805825da76410c181273ba90b1` | v7.0.1  |
| `actions/setup-node`               | `820762786026740c76f36085b0efc47a31fe5020` | v7.0.0  |
| `actions/upload-artifact`          | `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a` | v7.0.1  |
| `actions/attest-build-provenance`  | `4d101475d8b20a2381f78447822ac1eab6504dd8` | v4.2.2  |
| `actions/dependency-review-action` | `a1d282b36b6f3519aa1f3fc636f609c47dddb294` | v5.0.0  |
| `step-security/harden-runner`      | `351661ca32ac09a36dc5ee2d536e3128f2a3c8ed` | v2.22.0 |
| `extractions/setup-just`           | `53165ef7e734c5c07cb06b3c8e7b647c5aa16db3` | v4.0.0  |
| `github/codeql-action`             | `2892aa5e19bbd11bc0cff5427e3b750a04d9e3c2` | v4.38.2 |
| `ossf/scorecard-action`            | `2d1146689b8cda280b9bc96326124645441f03bc` | v2.4.4  |
| `googleapis/release-please-action` | `45996ed1f6d02564a971a2fa1b5860e934307cf7` | v5.0.0  |
| `peter-evans/create-pull-request`  | `5f6978faf089d4d20b00c7766989d076bb2fc7f1` | v8.1.1  |

Tool images are listed with their digests at the top of this repository's `justfile` and in
`.github/workflows/regenerate.yml` (oasdiff).

## PHP

PHP has no CodeQL support; spec 13.3 covers it with PHPStan and `psalm --taint-analysis`. Drop
`codeql.yml` from the PHP repository and run Psalm in `just lint` instead. PHP also has no fuzz job
and no `mutation` job until Infection is wired in (spec 13.2).

## Repository settings (not files)

Set these by hand on a new repository; nothing in the workflows can do it:

- Branch protection on `main`: pull requests only, required checks `just ci (node 22)`,
  `just ci (node 24)` (renamed per language) and CodeQL, linear history, signed commits, no
  force-push, CODEOWNERS review.
- Private vulnerability reporting on. Environments `release` (secret `NPM_TOKEN`, or none for PyPI
  trusted publishing) and `smoke` (secret `SMOKE_TOKEN`, a token that can read the account).
- Secret `RELEASE_PLEASE_TOKEN` (see above). Actions allowed to create pull requests.

## Checklist for a new repository

1. Copy the "copy" files; adapt the others at the lines above.
2. Write the manifest with exact pins and bootstrap the lockfile.
3. Write the Dockerfile, compose file and justfile; run `just test` and fix every EROFS by tmpfs or a
   tool setting.
4. Write the generator; run `CONFORMANCE_DIR=../hushscript-sdk-conformance just regen`; write the
   table test first, watch it fail, then make it pass.
5. Run `just lint`, then `just ci`, each through `scripts/heavy.sh` in the workspace.
6. Check that `docker ps -q --filter label=sdk.test` is empty afterwards.
