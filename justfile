# Every recipe runs in containers; nothing here touches host toolchains.
# Examples: `just ci`, `just test 24`, `CONFORMANCE_CONTEXT=../hushscript-sdk-conformance just conformance`.
set shell := ["bash", "-euo", "pipefail", "-c"]

export HOST_UID := `id -u`
export HOST_GID := `id -g`

node22_image := "node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392"
node24_image := "node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20"
bun_image := "oven/bun:1.2.23@sha256:6ebf306367da43ad75c4d5119563e24de9b66372929ad4fa31546be053a16f74"
deno_image := "denoland/deno:debian-2.9.7@sha256:fa335acdf6b72106eda2cb6a8cb5f4187e7630e357467489db4b2e7352d5e432"
hadolint_image := "hadolint/hadolint:v2.14.0@sha256:27086352fd5e1907ea2b934eb1023f217c5ae087992eb59fde121dce9c9ff21e"
actionlint_image := "rhysd/actionlint:1.7.8@sha256:96d4a8c87dbbfb3bdd324f8fdc285fc3df5261e2decc619a4dd7e8ee52bbfd46"
zizmor_image := "ghcr.io/zizmorcore/zizmor:1.16.0@sha256:a6460f1b6fe3dc08e588d314e73563bdd218ee30c995a4be5e9ee5bd300391ce"
shellcheck_image := "koalaman/shellcheck:v0.11.0@sha256:61862eba1fcf09a484ebcc6feea46f1782532571a34ed51fedf90dd25f925a8d"
gitleaks_image := "ghcr.io/gitleaks/gitleaks:v8.28.0@sha256:cdbb7c955abce02001a9f6c9f602fb195b7fadc1e812065883f695d1eeaba854"
sandbox := "--rm --init --label sdk.test=1 --cap-drop ALL --read-only --security-opt no-new-privileges --pids-limit 512 --memory 4g --tmpfs /tmp"
floor := "22"
latest := "24"

# unit tests with coverage on Node 22 (default) or 24; no network beyond the mock
test version=floor:
    #!/usr/bin/env bash
    set -euo pipefail
    {{ if version == "22" { "" } else if version == "24" { "" } else { error("version must be 22 or 24") } }}
    export NODE_VERSION={{version}}
    trap 'docker compose down --remove-orphans >/dev/null 2>&1 || true' EXIT
    docker compose build mock test
    docker compose run --rm test

# StrykerJS on src/http and src/transcribe (nightly)
mutation version=floor:
    #!/usr/bin/env bash
    set -euo pipefail
    {{ if version == "22" { "" } else if version == "24" { "" } else { error("version must be 22 or 24") } }}
    export NODE_VERSION={{version}}
    trap 'docker compose down --remove-orphans >/dev/null 2>&1 || true' EXIT
    docker compose build mock mutation
    docker compose run --rm mutation

# the conformance suite against the mock
conformance version=floor:
    #!/usr/bin/env bash
    set -euo pipefail
    {{ if version == "22" { "" } else if version == "24" { "" } else { error("version must be 22 or 24") } }}
    export NODE_VERSION={{version}}
    trap 'docker compose down --remove-orphans >/dev/null 2>&1 || true' EXIT
    docker compose build mock conformance
    docker compose run --rm conformance

# every example against the mock
examples version=floor:
    #!/usr/bin/env bash
    set -euo pipefail
    {{ if version == "22" { "" } else if version == "24" { "" } else { error("version must be 22 or 24") } }}
    export NODE_VERSION={{version}}
    trap 'docker compose down --remove-orphans >/dev/null 2>&1 || true' EXIT
    docker compose build mock examples
    docker compose run --rm examples

# every static check: tsc, eslint, prettier, knip, hadolint, actionlint, zizmor, shellcheck, gitleaks, typos, npm audit
lint version=floor:
    #!/usr/bin/env bash
    set -euo pipefail
    {{ if version == "22" { "" } else if version == "24" { "" } else { error("version must be 22 or 24") } }}
    export NODE_VERSION={{version}}
    trap 'docker compose down --remove-orphans >/dev/null 2>&1 || true' EXIT
    docker compose build mock lint
    docker compose run --rm lint
    run() { docker run {{sandbox}} --network none --user "$(id -u):$(id -g)" -v "$(pwd)":/work:ro -w /work -e HOME=/tmp "$@"; }
    run {{hadolint_image}} /bin/hadolint docker/dev.Dockerfile docker/typos.Dockerfile
    run {{actionlint_image}} -color
    run {{zizmor_image}} --pedantic --offline --config zizmor.yml .github
    run {{shellcheck_image}} scripts/*.sh
    run {{gitleaks_image}} git --no-banner --redact --verbose /work
    docker build --quiet -f docker/typos.Dockerfile -t hushscript-typescript-typos:local docker
    run hushscript-typescript-typos:local --config _typos.toml
    # The one lint step with network access: it asks the registry about advisories and signatures.
    docker run {{sandbox}} "hushscript-typescript-dev:node{{version}}" \
      sh -c 'timeout 300 npm audit --omit=dev --audit-level=high && timeout 300 npm audit signatures'

# package build plus package-correctness checks, then import the packed tarball in clean Node, Bun and Deno.
# tsup bundles its config next to the file, so the (read-only) repo root gets a copy in /tmp.
build version=floor:
    #!/usr/bin/env bash
    set -euo pipefail
    {{ if version == "22" { "" } else if version == "24" { "" } else { error("version must be 22 or 24") } }}
    export NODE_VERSION={{version}}
    node_image={{ if version == "22" { node22_image } else { node24_image } }}
    docker build --quiet --target dev --build-arg NODE_VERSION={{version}} -f docker/dev.Dockerfile -t "hushscript-typescript-dev:node{{version}}" .
    docker build --quiet --target proddeps --build-arg NODE_VERSION={{version}} -f docker/dev.Dockerfile -t "hushscript-typescript-proddeps:node{{version}}" .
    out="$(mktemp -d)"
    trap 'rm -rf "$out"' EXIT
    mkdir -p "$out/dist" "$out/consumer/node_modules/@hushscript/sdk" "$out/npm-cache"
    user="$(id -u):$(id -g)"
    docker run {{sandbox}} --network none --user "$user" -e HOME=/tmp -e npm_config_cache=/tmp/npm \
      -v "$out/dist":/work/dist -v "$out":/out "hushscript-typescript-dev:node{{version}}" \
      sh -c 'cp tsup.config.ts /tmp/tsup.config.ts && timeout 600 tsup --config /tmp/tsup.config.ts \
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
    check='const sdk = await import("@hushscript/sdk"); if (Object.keys(sdk.ERROR_CATALOG).length === 0) throw new Error("tables missing"); console.log("import ok");'
    docker run {{sandbox}} --network none --user "$user" -v "$out/consumer":/consumer:ro -w /consumer "$node_image" \
      timeout 60 node --input-type=module -e "$check"
    # require(esm) works through the "default" export condition (Node 22.12 and newer).
    docker run {{sandbox}} --network none --user "$user" -v "$out/consumer":/consumer:ro -w /consumer "$node_image" \
      timeout 60 node --disable-warning=ExperimentalWarning -e 'const sdk = require("@hushscript/sdk"); if (Object.keys(sdk.ERROR_CATALOG).length === 0) throw new Error("tables missing"); console.log("require ok");'
    docker run {{sandbox}} --network none --user "$user" -v "$out/consumer":/consumer:ro -w /consumer {{bun_image}} \
      timeout 60 bun --eval "$check"
    docker run {{sandbox}} --network none --user "$user" -e DENO_DIR=/tmp/deno -v "$out/consumer":/consumer:ro -w /consumer --entrypoint timeout {{deno_image}} \
      60 deno eval --node-modules-dir=manual "$check"

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

# lint, then test and conformance, then examples and build; no argument runs Node 22 and 24
ci version="":
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -n "{{version}}" ]; then versions="{{version}}"; else versions="{{floor}} {{latest}}"; fi
    first="${versions%% *}"
    just lint "$first"
    for v in $versions; do
      just test "$v"
      just conformance "$v"
    done
    just examples "$first"
    just build "$first"

# nightly smoke against production; needs SMOKE_TOKEN (outbound network)
smoke:
    #!/usr/bin/env bash
    set -euo pipefail
    : "${SMOKE_TOKEN:?set SMOKE_TOKEN to a token that can read the account}"
    export NODE_VERSION={{floor}}
    docker compose build smoke
    docker compose run --rm smoke
