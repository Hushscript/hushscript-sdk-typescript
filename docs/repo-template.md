# Repo template

This repository is the template for the Python, Go, PHP and CLI SDK repositories. It pins down the
container model, the `just` entry points, the static-analysis gates and the CI and release
automation from the SDK spec (sections 11 and 13). A new repository copies the files marked "copy"
below unchanged and edits the files marked "adapt" at the lines listed for its language.

The spec (`docs/sdk/spec.md` in the workspace) is binding. This document records how the TypeScript
repository satisfies it and which lines are language-specific. Where it says "same as", copy the
file from this repository byte for byte.

## Files

| File                                                            | Copy or adapt | What changes per language                                                                                                                                                   |
| --------------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LICENSE`, `SECURITY.md`                                        | copy          | Nothing.                                                                                                                                                                    |
| `.github/CODEOWNERS`                                            | copy          | Nothing. The team handle is a placeholder until the org team exists.                                                                                                        |
| `.github/workflows/scorecard.yml`, `dependency-review.yml`      | copy          | Nothing.                                                                                                                                                                    |
| `.github/workflows/codeql.yml`                                  | adapt         | `languages:` and the `category` (`javascript-typescript`, `python`, `go`). PHP has no CodeQL job; see "PHP".                                                                |
| `.github/workflows/ci.yml`                                      | adapt         | The matrix values (`node: ['24', '26']` becomes the language's floor and latest) and the env name passed to `just ci`.                                                      |
| `.github/workflows/nightly.yml`                                 | adapt         | Recipe names stay. Drop the `fuzz` job for PHP. Python uses `FC_RUNS_FACTOR` equivalents (Hypothesis `max_examples` profile), Go runs native fuzz targets for 60 s each.    |
| `.github/workflows/release.yml`                                 | adapt         | `release-type` in the workflow input and in `release-please-config.json` (`node`, `python`, `go`, `php`).                                                                   |
| `.github/workflows/publish.yml`                                 | adapt         | The registry steps; see "Publish".                                                                                                                                          |
| `.github/dependabot.yml`                                        | adapt         | The language ecosystem (`npm`, `pip` or `uv`, `gomod`, `composer`); keep `docker` on `/docker` and `github-actions`. Keep the 7-day cooldown and the `chore` commit prefix. |
| `release-please-config.json`, `.release-please-manifest.json`   | adapt         | `release-type`, `package-name`. Set `initial-version` to `1.0.0`. Manifest starts at `0.0.0`; the first release becomes `1.0.0`, and a breaking spec sync bumps the major.  |
| `docker/dev.Dockerfile`                                         | adapt         | The `base` image, the `deps` install command, the version stages and the `proddeps` stage; see "Dockerfile".                                                                |
| `docker/typos.Dockerfile`                                       | copy          | Nothing.                                                                                                                                                                    |
| `compose.yaml`                                                  | adapt         | Service commands, the `x-scratch` tmpfs list, the `regen` bind mounts. Structure, hardening and the `mock` service are copied.                                              |
| `justfile`                                                      | adapt         | Recipe bodies for `test`, `mutation`, `lint`, `build`, `regen`; the image table. Recipe names and arguments are fixed by spec 13.1.                                         |
| `.hadolint.yaml`, `zizmor.yml`, `_typos.toml`, `.gitleaks.toml` | copy          | `_typos.toml` and `.gitleaks.toml` paths follow the repo layout.                                                                                                            |
| `.dockerignore`, `.gitignore`, `.prettierignore`                | adapt         | Language build output and caches.                                                                                                                                           |
| `scripts/generate.*`                                            | adapt         | The generator. Writes the spec to `openapi.json` byte for byte, then the language's low-level layer, then the three tables.                                                 |
| `openapi.json`                                                  | copy          | Identical in every repo (the committed spec).                                                                                                                               |
| `README.md`                                                     | adapt         | Stub per language; no em-dashes.                                                                                                                                            |
| Static-analysis configs                                         | adapt         | Per the language column of spec 13.2: `eslint.config.js`, `.prettierrc`, `knip.json`, `stryker.config.json`, `tsconfig*.json` here.                                         |

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
  `./openapi.json` and the generated directory read-write. Nothing else is writable. When `just regen`
  gets a path to an existing file, the recipe bind-mounts that file read-only at `/spec/openapi.json`
  and passes that path to the generator, so the generator reads exactly the bytes that were diffed.
- Long commands carry their own limit inside the container (`timeout 1800 ...`). A host-side
  `timeout` only kills the client.
- Every recipe that starts compose installs `trap 'docker compose down --remove-orphans' EXIT`, so the
  mock never outlives the recipe. After a run, `docker ps -q --filter label=sdk.test` must be empty.
- Host code never runs tools. The only host-side commands in CI are `just`, `git` and `jq` (the tag
  guard) and `npm` in `publish.yml` (the registry upload has
  to run where the OIDC token is).
- Builds must not install OS packages: CI blocks egress, so `apt-get` at image build time would need
  Debian mirror hosts on the allow-list. The TypeScript `mutation` stage builds on the full
  `node:*-bookworm` images, which carry `ps` (StrykerJS needs it), instead of apt-installing `procps`
  into the slim image. Other languages: bake the tool into a pinned image stage, never `apt-get`.

### The mock and the conformance repository

`compose.yaml` builds the mock from `${CONFORMANCE_CONTEXT}`, which the justfile always sets: by
default the git URL of the conformance repository at the tag or commit in `package.json` `config.conformanceRef`,
the one place the ref is pinned. Until
the conformance repository is public and tagged, set
`CONFORMANCE_CONTEXT=../hushscript-sdk-conformance` (a sibling checkout) in the environment of every
`just` call. Every workflow job that builds compose services builds the mock too, so its egress allow-list carries
`github.com` and `codeload.github.com` (BuildKit fetches the git context) plus the Docker Hub hosts
(the mock's base image). `hints.json` is read from `$CONFORMANCE_DIR/hints.json` when `CONFORMANCE_DIR` is set (the
`regen` recipe mounts it read-only at `/conformance` and rewrites the variable), otherwise from
`raw.githubusercontent.com` at the tag or commit in `package.json` `config.conformanceRef`. The other languages keep the tag in one place of their own (a manifest
field or a constant in the generator); the mock's build context and `hints.json` both follow it.

### Justfile

Recipes and arguments are fixed: `test [version]`, `lint [version]`, `conformance [version]`,
`examples [version]`, `build [version]`, `regen [spec-path-or-url]`, `ci [version]`, `smoke`, plus `mutation`
(used by the nightly job). The version argument is the runtime version (default: the floor) and is
validated by a `just` `error()` expression. `ci` with no argument runs lint on the floor, test and
conformance on floor and latest, then examples and build on the floor. With an argument it runs
everything on that one version, which is what the CI matrix passes.

Tool images other than the dev image (hadolint, actionlint, zizmor, gitleaks, typos,
Bun, Deno) are `docker run` calls from the justfile, pinned by digest, with the sandbox flags
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

1. Named stages hold the digest-pinned official images (`node24`, `node26`). `ARG NODE_VERSION` selects
   one through `FROM node${NODE_VERSION} AS base`. This keeps the digests as literal `FROM` lines,
   which Dependabot can update. The indirection needs `# hadolint ignore=DL3006`.
2. `base` creates the non-root user (uid and gid 10001), sets `HOME=/tmp` and `WORKDIR /work`.
3. `deps` installs from the lockfile only (`npm ci --ignore-scripts`; the other languages per spec
   13.1).
4. `dev` copies `node_modules` from `deps`, copies the source, puts `node_modules/.bin` on `PATH` and
   switches to uid 10001.
5. `mutation` builds on the digest-pinned full images (`node24full`, `node26full`, selected like `base`)
   because StrykerJS needs `ps` and nothing may install packages at build time. It repeats the user,
   `PATH` and source steps of `dev`.
6. `proddeps` installs production dependencies only. `just build` uses it to assemble an install
   without a network: the packed tarball is extracted into `node_modules/@hushscript/sdk` next to
   these dependencies.

### Bootstrapping the lockfile

The lockfile is created once, in a container with network and the repository's manifest, then
committed (Dependabot maintains it afterwards):

```sh
d=$(mktemp -d) && cp package.json "$d" && chmod 777 "$d"
docker run --rm --init --label claude.adhoc=1 --label sdk.test=1 --cap-drop ALL \
  --security-opt no-new-privileges --memory 2g --pids-limit 256 --user "$(id -u):$(id -g)" \
  -e HOME=/tmp --tmpfs /tmp -v "$d":/work -w /work node:24-bookworm-slim@sha256:<digest> \
  timeout 300 npm install --package-lock-only --ignore-scripts --no-audit --no-fund
cp "$d/package-lock.json" .
```

Substitute `uv lock`, `go mod tidy` and `composer update --no-plugins --no-scripts` with the matching
base image. Pin every tool and dev dependency to an exact version; library runtime dependencies use
compatible ranges so applications can dedupe them, and the lockfile pins what CI tests.

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
  real tarball, a type check of a consumer file against the packed `.d.ts` with the oldest supported
  TypeScript (devDependency alias `typescript-floor`, `npm:typescript@5.5.4`; Dependabot ignores it;
  `skipLibCheck: false`, `module: NodeNext`), then an `import` of the tarball in clean Node (the
  matrix version), a `require()` of it in the same Node image (`require(esm)`, Node 24 and newer)
  and an `import` in clean Bun and Deno containers. `package.json` `exports["."]` has `types`,
  `import` and `default` (the last makes `require(esm)` resolve). A new language states its consumer
  floor in the README and checks it the same way (Python: the oldest supported interpreter installs
  and imports the wheel; Go: `go.mod`'s `go` line is the floor; PHP: `composer.json` `php` constraint).
- Mutation: `stryker.config.json` mutates `src/http` and `src/transcribe`, `break` at 80,
  `allowEmpty: true` until those directories exist.
- Whole-repo: hadolint (`.hadolint.yaml`, failure threshold `info`), actionlint, zizmor `--pedantic`
  with `zizmor.yml` requiring hash pins, gitleaks on the full history,
  typos on the whole tree minus `openapi.json`, lockfiles and generated code.

Two tool quirks worth knowing:

- `tsup` bundles its own config next to the config file, which fails on a read-only root. `just
build` copies `tsup.config.ts` to `/tmp` and passes `--config`. Likewise `vitest` needs a tmpfs at
  `node_modules/.vite-temp`.
- `tsup` 9 no longer sets the deprecated `baseUrl` during declaration builds, so it needs no
  TypeScript 6 deprecation workaround. `openapi-typescript` still peers on TypeScript 5, so
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
| `release.yml`           | push to `main`                  | none (writes go through the App token)                                             |
| `publish.yml`           | `release: published`            | `contents: read`, `id-token: write`, `attestations: write` (environment `release`) |
| `codeql.yml`            | PR, push, weekly                | `contents: read`, `security-events: write`                                         |
| `scorecard.yml`         | weekly, push, branch protection | `contents: read`, `actions: read`, `security-events: write`, `id-token: write`     |
| `dependency-review.yml` | PR                              | `contents: read`                                                                   |

There is no scheduled regeneration. When the API changes, regenerate by hand: `just regen` fetches the
production spec, or `just regen path/to/openapi.json` reads a local file. Review the diff of
`openapi.json` and `src/generated/`, run `just ci`, and commit with `feat: sync with the api spec`
(`feat!:` when the change breaks the SDK).

### Publish

`publish.yml` builds from the release tag, packs one tarball, writes a CycloneDX SBOM, attests the
tarball with `actions/attest-build-provenance`, uploads the tarball and SBOM as an artifact and
publishes that same tarball. Language-specific parts:

- Every language first checks that the release tag equals `v` plus the manifest version and that the
  tagged commit is an ancestor of `origin/main` (`fetch-depth: 0`), before building anything.
- TypeScript: `actions/setup-node` with Node 24 (no `registry-url`, so no `.npmrc` token line), a step
  that fails when `npm --version` is below 11.5.1 (trusted publishing needs it), `npm ci
--ignore-scripts`, `npm run build`, `npm pack`, `npm sbom --sbom-format cyclonedx`, `npm publish
"$TARBALL" --provenance --access public`. No `NPM_TOKEN` and no `NODE_AUTH_TOKEN`: npm trades the
  job's OIDC token (`id-token: write`) for a short-lived publish token through the trusted publisher
  attached to the package. The first publish of a new package is an owner bootstrap (plan Task 19),
  after which the owner attaches the trusted publisher on npmjs.com; the egress list needs
  `registry.npmjs.org` and the sigstore hosts.
- Python: build sdist and wheel in the pinned Python container, `twine check`, publish with PyPI
  trusted publishing (`pypa/gh-action-pypi-publish`, `id-token: write`, no token), attestations on.
  SBOM from `cyclonedx-py`.
- Go and PHP: there is no registry upload. The workflow attaches the attested source archive
  (`git archive`) to the GitHub release (`contents: write` for that job only) and a CycloneDX SBOM
  produced by a pinned tool image.
- CLI: as TypeScript, with its own package name.

`release.yml` creates a GitHub App token (`actions/create-github-app-token`, secrets `APP_ID` and
`APP_PRIVATE_KEY`) and hands it to release-please, with no fallback: a release created with the
default token would not start `publish.yml`, and a missing secret should fail loudly. The token asks for `contents`, `pull-requests` and `issues` write; release-please needs
`issues: write` for its `autorelease:` labels (its README lists all three).

### Pinned actions

Reuse these SHAs; refresh them with Dependabot.

| Action                             | SHA                                        | Version |
| ---------------------------------- | ------------------------------------------ | ------- |
| `actions/checkout`                 | `3d3c42e5aac5ba805825da76410c181273ba90b1` | v7.0.1  |
| `actions/setup-node`               | `949feb2413d6458794dcd2491c4babbbce0c15c1` | v7.1.0  |
| `actions/upload-artifact`          | `cf430e030ddbb5b0abf93d22962f4752f3646cd9` | v7.0.2  |
| `actions/attest-build-provenance`  | `4d101475d8b20a2381f78447822ac1eab6504dd8` | v4.2.2  |
| `actions/dependency-review-action` | `a1d282b36b6f3519aa1f3fc636f609c47dddb294` | v5.0.0  |
| `step-security/harden-runner`      | `dc2769abcc0fcfbadfc1df54081c1608579ef6b2` | v2.22.2 |
| `extractions/setup-just`           | `53165ef7e734c5c07cb06b3c8e7b647c5aa16db3` | v4.0.0  |
| `github/codeql-action`             | `9b3254085494b55a0f7c4c2b3d2d52cc712ce370` | v4.39.1 |
| `ossf/scorecard-action`            | `fa7117db83c52d787ae5a89f350999701505d78e` | v2.5.0  |
| `googleapis/release-please-action` | `45996ed1f6d02564a971a2fa1b5860e934307cf7` | v5.0.0  |
| `actions/create-github-app-token`  | `64ab729a6294000f5aa4a4bc0b73d1f32bc45510` | v3.3.0  |

Tool images are listed with their digests at the top of this repository's `justfile`.

## PHP

PHP has no CodeQL support; spec 13.3 covers it with PHPStan and `psalm --taint-analysis`. Drop
`codeql.yml` from the PHP repository and run Psalm in `just lint` instead. PHP also has no fuzz job
and no `mutation` job until Infection is wired in (spec 13.2).

## Owner steps (repository settings, not files)

The workflows cannot do these. Do every one on a new repository before the first release:

1. **GitHub App.** Create one App for the SDK repositories (or one per repository) with repository
   permissions Contents, Pull requests and Issues set to read and write (Metadata read is implied) and
   install it on the repository. Generate a private key. Store the App id as the Actions secret
   `APP_ID` and the key as `APP_PRIVATE_KEY` (repository secrets, or organization secrets limited to
   the SDK repositories). `release.yml` uses them; there is no fallback token.
2. **Environments.** `release` (required reviewer is the owner; no secret, npm uses OIDC; for PyPI the
   environment name goes into the trusted publisher) and `smoke` (secret `SMOKE_TOKEN`, a token that
   can read the account).
3. **Actions may create pull requests.** Settings, Actions, General, "Allow GitHub Actions to create
   and approve pull requests": not required, because the App token opens the PRs. Leave it off.
4. **CODEOWNERS handle.** `.github/CODEOWNERS` names `@Hushscript/sdk-maintainers`, a placeholder:
   create that team (or change the handle) so CODEOWNERS review can be enforced.
5. **Package registry bootstrap and trusted publisher.** npm: the owner publishes the first version by
   hand (plan Task 19), then adds a trusted publisher on npmjs.com (organization `Hushscript`,
   repository, workflow `publish.yml`, environment `release`). PyPI: add a pending trusted publisher
   before the first release. Store no registry token in GitHub.
6. **Branch protection on `main`.** Pull requests only, required checks `just ci (node 24)`, `just ci
(node 26)` (renamed per language) and CodeQL, linear history, signed commits, no force-push,
   CODEOWNERS review. Releases and regen PRs are signed by the App through the API, so the signed
   commits rule holds for them.
7. **Private vulnerability reporting** on.

## Checklist for a new repository

1. Copy the "copy" files; adapt the others at the lines above.
2. Write the manifest with exact pins and bootstrap the lockfile.
3. Write the Dockerfile, compose file and justfile; run `just test` and fix every EROFS by tmpfs or a
   tool setting.
4. Write the generator; run `CONFORMANCE_DIR=../hushscript-sdk-conformance just regen`; write the
   table test first, watch it fail, then make it pass.
5. Run `just lint`, then `just ci`, each through `scripts/heavy.sh` in the workspace.
6. Check that `docker ps -q --filter label=sdk.test` is empty afterwards.
