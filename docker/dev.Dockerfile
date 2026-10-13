ARG NODE_VERSION=22

FROM node:25-bookworm-slim@sha256:81db02c4b671288a03915da9534dbd54f96d0e7c24d80ccc54f5b36b2e684370 AS node22
FROM node:25-bookworm-slim@sha256:81db02c4b671288a03915da9534dbd54f96d0e7c24d80ccc54f5b36b2e684370 AS node24
FROM node:26-bookworm-slim@sha256:86f07bc9c5dce4578cf37e5a418b7bfc7f817cda25cde66e2b66e95ed86c4567 AS node26
# The full images carry procps (ps), which StrykerJS needs and the slim images lack. The mutation stage
# builds on them so that nothing installs packages at build time (CI builds under an egress block).
FROM node:25-bookworm@sha256:78839ac448c23517f8eab2e8f7943d9b4f73979eb7f8bed2c73dbf72ff869e7b AS node22full
FROM node:25-bookworm@sha256:78839ac448c23517f8eab2e8f7943d9b4f73979eb7f8bed2c73dbf72ff869e7b AS node24full
FROM node:26-bookworm@sha256:f1233c415b41ffcf237c717b3dea92e9d4ea006e0e4c71edcb790605d74f5404 AS node26full

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
