ARG NODE_VERSION=22

FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS node22
FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS node24
FROM node:26-bookworm-slim@sha256:298992629d69bbd5b2b03ad57094d8e4fcb3a8eeb7c4e25d29de656519568913 AS node26
# The full images carry procps (ps), which StrykerJS needs and the slim images lack. The mutation stage
# builds on them so that nothing installs packages at build time (CI builds under an egress block).
FROM node:22-bookworm@sha256:0e5f906573693feaa1e21057ebdcfdb5bd5021f050b2dc7c9deceb629c7da2a8 AS node22full
FROM node:24-bookworm@sha256:14078204b6bb268c107ceff6d3c43f45a888105e5c2b18b14c32b3409d93a1b0 AS node24full
FROM node:26-bookworm@sha256:a856ae5e25d498bbe5ec85fde88f00f5ed99908fda803ba39d7735ab8574f58c AS node26full

# node22, node24, and node26 above are the digest-pinned images; the build arg only selects one.
# hadolint ignore=DL3006
FROM node${NODE_VERSION} AS base
RUN groupadd --gid 10001 dev && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin dev
ENV HOME=/tmp
WORKDIR /work

FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY scripts/patch-stryker-vitest.mjs /tmp/patch-stryker-vitest.mjs
RUN node /tmp/patch-stryker-vitest.mjs && node /tmp/patch-stryker-vitest.mjs

FROM base AS dev
ENV PATH=/work/node_modules/.bin:$PATH
COPY --from=deps /work/node_modules node_modules
COPY --chown=10001:10001 . .
USER 10001:10001

# Production dependencies only: the consumer check in `just build` installs the packed tarball next to these.
FROM base AS proddeps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# hadolint ignore=DL3006
FROM node${NODE_VERSION}full AS mutation
RUN groupadd --gid 10001 dev && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin dev
ENV HOME=/tmp
ENV PATH=/work/node_modules/.bin:$PATH
WORKDIR /work
COPY --from=deps /work/node_modules node_modules
COPY --chown=10001:10001 . .
USER 10001:10001
RUN timeout 120 node scripts/check-stryker-selection.mjs
