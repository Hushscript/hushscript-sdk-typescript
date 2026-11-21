ARG NODE_VERSION=24

FROM node:26-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1 AS node24
FROM node:26-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1 AS node26
# The full images carry procps (ps), which StrykerJS needs and the slim images lack. The mutation stage
# builds on them so that nothing installs packages at build time (CI builds under an egress block).
FROM node:26-bookworm@sha256:b7087bc4d973034b30854b378ba107f9fab622b47514cb7e2592e41b8bab8d49 AS node24full
FROM node:26-bookworm@sha256:b7087bc4d973034b30854b378ba107f9fab622b47514cb7e2592e41b8bab8d49 AS node26full

# node24 and node26 above are the digest-pinned images; the build arg only selects one.
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
