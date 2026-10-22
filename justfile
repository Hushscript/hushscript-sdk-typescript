# Every recipe runs in containers; nothing here touches host toolchains.
# Examples: `just ci`, `just test 24`, `CONFORMANCE_CONTEXT=../hushscript-sdk-conformance just conformance`.
set shell := ["bash", "-euo", "pipefail", "-c"]

export HOST_UID := `id -u`
export HOST_GID := `id -g`
export MUTATION_REPORT_DIR := env("MUTATION_REPORT_DIR", "/tmp/hushscript-mutation-unused")
# No scenario may be skipped: an unmapped op fails the conformance run.
export CONFORMANCE_STRICT := env("CONFORMANCE_STRICT", "1")
# The conformance suite is built from the ref in package.json (`config.conformanceRef`), the one place it is pinned.
conformance_ref := `sed -n 's/^ *"conformanceRef": *"\([^"]*\)".*/\1/p' package.json`
export CONFORMANCE_CONTEXT := env("CONFORMANCE_CONTEXT", "https://github.com/Hushscript/hushscript-sdk-conformance.git#" + conformance_ref)

node24_image := "node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205"
node26_image := "node:26-bookworm-slim@sha256:28147155d47dc31abe0a46e0d12b59b2fb3d0a2dcc5dc65fce76a074180b16fe"
bun_image := "oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d"
deno_image := "denoland/deno:debian-2.9.8@sha256:a0d88a7fcbd44f062cba2748e19df67d30290ad12aa203c7c1e0b12462c483f0"
hadolint_image := "hadolint/hadolint:v2.15.1@sha256:32dac94127fd60b7b7e3fbfc65e1383b9b5e25c9bfd7b8536de7a539fe68a12d"
actionlint_image := "rhysd/actionlint:1.7.12@sha256:b1934ee5f1c509618f2508e6eb47ee0d3520686341fec936f3b79331f9315667"
zizmor_image := "ghcr.io/zizmorcore/zizmor:1.31.1@sha256:42d409dbb851d4c5d35a058cf042b828bea1e3f2884378c526eb0974780e18d9"
gitleaks_image := "ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f"
sandbox := "--rm --init --label sdk.test=1 --cap-drop ALL --read-only --security-opt no-new-privileges --pids-limit 512 --memory 4g --tmpfs /tmp"
floor := "24"
latest := "26"
supported := "24 26"

# unit tests with coverage on Node 24 (default) or 26; no network beyond the mock
test version=floor:
    #!/usr/bin/env bash
    set -euo pipefail
    {{ if version == "24" { "" } else if version == "26" { "" } else { error("version must be 24 or 26") } }}
    export NODE_VERSION={{version}}
    trap 'docker compose down --remove-orphans >/dev/null 2>&1 || true' EXIT
    extra=()
    if [ -n "${CONFORMANCE_DIR:-}" ]; then
      conformance_dir="$(realpath "$CONFORMANCE_DIR")"
      extra=(-v "$conformance_dir":/conformance:ro -e CONFORMANCE_DIR=/conformance)
    fi
    docker compose build mock test
    docker compose run --rm ${extra[@]+"${extra[@]}"} test

# StrykerJS on src/http and src/transcribe (nightly)
mutation version=floor:
    #!/usr/bin/env bash
    set -euo pipefail
    {{ if version == "24" { "" } else if version == "26" { "" } else { error("version must be 24 or 26") } }}
    export NODE_VERSION={{version}}
    trap 'docker compose down --remove-orphans >/dev/null 2>&1 || true' EXIT
    mkdir -p reports/mutation
    export MUTATION_REPORT_DIR="$(mktemp -d "$(pwd)/reports/mutation/node{{version}}-XXXXXX")"
    printf 'Mutation report directory: %s\n' "$MUTATION_REPORT_DIR"
    docker compose build mock mutation
    docker compose run --rm mutation

# the conformance suite against the mock
conformance version=floor:
    #!/usr/bin/env bash
    set -euo pipefail
    {{ if version == "24" { "" } else if version == "26" { "" } else { error("version must be 24 or 26") } }}
    export NODE_VERSION={{version}}
    trap 'docker compose down --remove-orphans >/dev/null 2>&1 || true' EXIT
    docker compose build mock conformance
    docker compose run --rm conformance

# every example against the mock
examples version=floor:
    #!/usr/bin/env bash
    set -euo pipefail
    {{ if version == "24" { "" } else if version == "26" { "" } else { error("version must be 24 or 26") } }}
    export NODE_VERSION={{version}}
    trap 'docker compose down --remove-orphans >/dev/null 2>&1 || true' EXIT
    docker compose build mock examples
    docker compose run --rm examples

# every static check: tsc, eslint, prettier, knip, hadolint, actionlint, zizmor, gitleaks, typos, npm audit
lint version=floor:
    #!/usr/bin/env bash
    set -euo pipefail
    {{ if version == "24" { "" } else if version == "26" { "" } else { error("version must be 24 or 26") } }}
    export NODE_VERSION={{version}}
    trap 'docker compose down --remove-orphans >/dev/null 2>&1 || true' EXIT
    docker compose build mock lint
    docker compose run --rm lint
    run() { docker run {{sandbox}} --network none --user "$(id -u):$(id -g)" -v "$(pwd)":/work:ro -w /work -e HOME=/tmp "$@"; }
    run {{hadolint_image}} /bin/hadolint docker/dev.Dockerfile docker/typos.Dockerfile
    run {{actionlint_image}} -color
    run {{zizmor_image}} --pedantic --offline --config zizmor.yml .github
    run {{gitleaks_image}} git --no-banner --redact --verbose /work
    docker build --quiet -f docker/typos.Dockerfile -t hushscript-typescript-typos:local docker
    run hushscript-typescript-typos:local --config _typos.toml
    # The one lint step with network access: it asks the registry about signatures, and about advisories on the
    # newest Node only (the package ships source; older runtimes are the consumer's to patch).
    audit=""
    if [ "{{version}}" = "{{latest}}" ]; then audit='timeout 300 npm audit --omit=dev --audit-level=high && '; fi
    docker run {{sandbox}} "hushscript-typescript-dev:node{{version}}" \
      sh -c "${audit}timeout 300 npm audit signatures"

# package checks, then call the packed SDK against loopback in clean Node, Bun and Deno.
# tsup bundles its config next to the file, so the (read-only) repo root gets a copy in /tmp.
build version=floor:
    #!/usr/bin/env bash
    set -euo pipefail
    {{ if version == "24" { "" } else if version == "26" { "" } else { error("version must be 24 or 26") } }}
    export NODE_VERSION={{version}}
    node_image={{ if version == "24" { node24_image } else { node26_image } }}
    docker build --quiet --target dev --build-arg NODE_VERSION={{version}} -f docker/dev.Dockerfile -t "hushscript-typescript-dev:node{{version}}" .
    docker build --quiet --target proddeps --build-arg NODE_VERSION={{version}} -f docker/dev.Dockerfile -t "hushscript-typescript-proddeps:node{{version}}" .
    out="$(mktemp -d)"
    trap 'rm -rf "$out"' EXIT
    mkdir -p "$out/dist" "$out/consumer/node_modules/@hushscript/sdk" "$out/npm-cache"
    user="$(id -u):$(id -g)"
    docker run {{sandbox}} --network none --user "$user" -e HOME=/tmp -e npm_config_cache=/tmp/npm \
      -v "$out/dist":/work/dist -v "$out":/out "hushscript-typescript-dev:node{{version}}" \
      sh -c 'timeout 120 node --test scripts/check-mutation-score.test.mjs && cp tsup.config.ts /tmp/tsup.config.ts && timeout 600 tsup --config /tmp/tsup.config.ts \
        && timeout 120 npm pack --dry-run --ignore-scripts \
        && timeout 120 npm pack --ignore-scripts --pack-destination /out \
        && timeout 120 publint /out/hushscript-sdk-*.tgz \
        && timeout 300 attw /out/hushscript-sdk-*.tgz --profile esm-only \
        && tar -xzf /out/hushscript-sdk-*.tgz -C /out/consumer/node_modules/@hushscript/sdk --strip-components=1'
    docker run {{sandbox}} --network none --user "$user" -v "$out":/out "hushscript-typescript-proddeps:node{{version}}" \
      sh -c 'cp -r /work/node_modules/. /out/consumer/node_modules/ && printf "{\"type\":\"module\",\"dependencies\":{\"@hushscript/sdk\":\"*\"}}\n" > /out/consumer/package.json'
    printf '%s\n' \
      'import { ERROR_CATALOG, HINTS, OPERATION_SCOPES } from "@hushscript/sdk";' \
      'import type { ErrorCatalogEntry, paths } from "@hushscript/sdk";' \
      'export const entry: ErrorCatalogEntry | undefined = ERROR_CATALOG["insufficient_balance"];' \
      'export type Account = paths["/v1/account"]["get"];' \
      'export const sizes = [Object.keys(HINTS).length, Object.keys(OPERATION_SCOPES).length];' > "$out/consumer/index.ts"
    printf '%s\n' '{"compilerOptions":{"target":"ES2022","module":"NodeNext","moduleResolution":"NodeNext","strict":true,"noUncheckedIndexedAccess":true,"exactOptionalPropertyTypes":true,"verbatimModuleSyntax":true,"skipLibCheck":false,"types":[],"noEmit":true},"files":["index.ts"]}' > "$out/consumer/tsconfig.json"
    # The oldest TypeScript a consumer may use (typescript-floor in package.json) must accept the packed d.ts.
    docker run {{sandbox}} --network none --user "$user" -v "$out/consumer":/consumer:ro "hushscript-typescript-dev:node{{version}}" \
      timeout 120 node /work/node_modules/typescript-floor/bin/tsc -p /consumer/tsconfig.json
    check='
    const sdk = await import("@hushscript/sdk");
    const { createServer } = await import("node:http");
    const { strict: assert } = await import("node:assert");
    assert.ok(Object.keys(sdk.ERROR_CATALOG).length > 0, "tables missing");
    const token = "hsr1:eu:pat.synthetic.consumer";
    const requests = [];
    const server = createServer((request, response) => {
      requests.push({ method: request.method, path: request.url, auth: request.headers.authorization });
      response.writeHead(200, { "content-type": "application/json", "connection": "close" });
      response.end(JSON.stringify({ balance_seconds: 18000, held_seconds: 600, credits_expire_at: null,
        card_on_file: true, data_region: "eu", limits: { max_daily_seconds: 36000,
        max_active_jobs: 3, active_jobs: 0, used_today_seconds: 0 } }));
    });
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const client = new sdk.Hushscript({ token, baseUrl: `http://127.0.0.1:${address.port}` });
      const balance = await client.balance();
      assert.equal(balance.seconds, 18000);
      assert.equal(balance.minutes, 300);
      assert.equal(balance.heldSeconds, 600);
      assert.equal(balance.expiresAt, null);
      assert.deepEqual(requests, [{ method: "GET", path: "/v1/account", auth: `Bearer ${token}` }]);
      console.log("packed SDK balance ok");
    } finally {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }'
    docker run {{sandbox}} --network none --user "$user" -v "$out/consumer":/consumer:ro -w /consumer "$node_image" \
      timeout 60 node --input-type=module -e "$check"
    # require(esm) works through the "default" export condition (every supported Node).
    docker run {{sandbox}} --network none --user "$user" -v "$out/consumer":/consumer:ro -w /consumer "$node_image" \
      timeout 60 node --disable-warning=ExperimentalWarning -e 'const sdk = require("@hushscript/sdk"); if (Object.keys(sdk.ERROR_CATALOG).length === 0) throw new Error("tables missing"); console.log("require ok");'
    docker run {{sandbox}} --network none --user "$user" -v "$out/consumer":/consumer:ro -w /consumer {{bun_image}} \
      timeout 60 bun --eval "$check"
    docker run {{sandbox}} --network none --user "$user" -e DENO_DIR=/tmp/deno -v "$out/consumer":/consumer:ro -w /consumer --entrypoint timeout {{deno_image}} \
      60 deno eval --node-modules-dir=manual "$check"

# what `npm publish` would upload, without uploading: the file list must be dist/, README, LICENSE and package.json only.
# Same sandbox as `build` (no network); the registry is never contacted.
publish-dry-run version=floor:
    #!/usr/bin/env bash
    set -euo pipefail
    {{ if version == "24" { "" } else if version == "26" { "" } else { error("version must be 24 or 26") } }}
    docker build --quiet --target dev --build-arg NODE_VERSION={{version}} -f docker/dev.Dockerfile -t "hushscript-typescript-dev:node{{version}}" .
    out="$(mktemp -d)"
    trap 'rm -rf "$out"' EXIT
    mkdir -p "$out/dist"
    docker run {{sandbox}} --network none --user "$(id -u):$(id -g)" -e HOME=/tmp -e npm_config_cache=/tmp/npm \
      -v "$out/dist":/work/dist "hushscript-typescript-dev:node{{version}}" \
      sh -c 'cp tsup.config.ts /tmp/tsup.config.ts && timeout 600 tsup --config /tmp/tsup.config.ts \
        && timeout 120 npm publish --dry-run --provenance=false --ignore-scripts \
        && timeout 120 npm pack --dry-run --ignore-scripts --json > /tmp/pack.json \
        && timeout 60 node scripts/check-publish-files.mjs /tmp/pack.json'

# regenerate openapi.json and src/generated from the production spec, or from a local spec file (outbound network)
regen spec="":
    #!/usr/bin/env bash
    set -euo pipefail
    export NODE_VERSION={{floor}}
    trap 'docker compose down --remove-orphans >/dev/null 2>&1 || true' EXIT
    extra=()
    if [ -n "${CONFORMANCE_DIR:-}" ]; then
      extra=(-v "$(realpath "$CONFORMANCE_DIR")":/conformance:ro -e CONFORMANCE_DIR=/conformance)
    fi
    spec="{{spec}}"
    # A local file is bind-mounted, so the generator reads exactly the bytes that were diffed.
    if [ -n "$spec" ] && [ -f "$spec" ]; then
      extra+=(-v "$(realpath "$spec")":/spec/openapi.json:ro)
      spec=/spec/openapi.json
    fi
    docker compose build regen
    docker compose run --rm ${extra[@]+"${extra[@]}"} regen timeout 600 node scripts/generate.mjs ${spec:+"$spec"}

# lint, then test and conformance, then examples and build; no argument runs Node 24 and 26
ci version="":
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -n "{{version}}" ]; then versions="{{version}}"; else versions="{{supported}}"; fi
    for v in $versions; do
      just lint "$v"
      just test "$v"
      just conformance "$v"
      just examples "$v"
      just build "$v"
    done

# nightly smoke against production; needs SMOKE_TOKEN (outbound network)
smoke:
    #!/usr/bin/env bash
    set -euo pipefail
    : "${SMOKE_TOKEN:?set SMOKE_TOKEN to a token that can read the account}"
    export NODE_VERSION={{floor}}
    docker compose build smoke
    docker compose run --rm smoke
