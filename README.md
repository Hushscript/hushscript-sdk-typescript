# @hushscript/sdk

The official TypeScript SDK for the [Hushscript](https://hushscript.com) transcription API.

This repository is a scaffold. It holds the generated API types, the error catalog and the build,
test and release automation. The client itself is not published yet, so there is nothing to install.

## Requirements

Node 22 or newer, Bun 1.2 or newer, or Deno 2 or newer. The SDK is for server runtimes only: a token
in a browser bundle is a leaked token.

The package is ESM-first: `import { ... } from "@hushscript/sdk"`. On Node 22.12 and newer,
`require("@hushscript/sdk")` also works, because Node can `require()` an ES module (the `default`
export condition points at the same ESM build). TypeScript consumers need TypeScript 5.5 or newer;
`just build` type-checks the packed declarations with exactly 5.5 in a container.

## Releases

Releases come from release-please. The package is published to npm by `publish.yml` through npm
trusted publishing (OIDC): no npm token is stored in GitHub. The very first publish of
`@hushscript/sdk` cannot use a trusted publisher, because the package does not exist on the registry
yet, so the owner publishes it once by hand (workspace plan, Task 19) and then attaches the trusted
publisher (this repository, workflow `publish.yml`, environment `release`) in the package settings on
npmjs.com. Every later release is published by the workflow with provenance.

## Development

Everything runs in containers; nothing touches a host toolchain. You need Docker with Compose v2 and
[just](https://github.com/casey/just).

```sh
just ci                 # lint, then test and conformance on Node 22 and 24, then examples and build
just test 24            # unit tests with coverage on one runtime
just lint               # every static check
just regen              # regenerate openapi.json and src/generated from the production spec
```

The conformance mock is built from the `hushscript-sdk-conformance` repository at the tag pinned in
`compose.yaml`. To use a local checkout instead:

```sh
CONFORMANCE_CONTEXT=../hushscript-sdk-conformance CONFORMANCE_DIR=../hushscript-sdk-conformance just ci
```

`docs/repo-template.md` describes how this repository is put together and how the sibling SDK
repositories reuse it.

## Security

See [SECURITY.md](SECURITY.md).

## License

MIT
