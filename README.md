# @hushscript/sdk

The official TypeScript SDK for the [Hushscript](https://hushscript.com) transcription API.

This repository is a scaffold. It holds the generated API types, the error catalog and the build,
test and release automation. The client itself is not published yet, so there is nothing to install.

## Requirements

Node 22 or newer, Bun 1.2 or newer, or Deno 2 or newer. The SDK is for server runtimes only: a token
in a browser bundle is a leaked token.

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
