ARG NODE_VERSION=22

FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS node22
FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS node24
# The full images carry procps (ps), which StrykerJS needs and the slim images lack. The mutation stage
# builds on them so that nothing installs packages at build time (CI builds under an egress block).
FROM node:22-bookworm@sha256:1caeacc40090c4607170d7508b4eb8d5575a681a1b3a02b9cd65e878fa2d4779 AS node22full
FROM node:24-bookworm@sha256:22f6fe5f59fb7fed238b19623506d573dffaa932ce33b84ce541a9a2e0eade28 AS node24full

# node22 and node24 above are the digest-pinned images; the build arg only selects one.
# hadolint ignore=DL3006
FROM node${NODE_VERSION} AS base
RUN groupadd --gid 10001 dev && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin dev
ENV HOME=/tmp
WORKDIR /work

FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund

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
