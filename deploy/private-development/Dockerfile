ARG NODE_IMAGE=node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203

FROM ${NODE_IMAGE} AS build

WORKDIR /workspace

COPY .npmrc package-lock.json package.json ./
RUN npm ci

COPY eslint.config.js tsconfig.build.json tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
COPY tests ./tests

RUN npm run verify:application

FROM ${NODE_IMAGE} AS production-dependencies

WORKDIR /app

COPY .npmrc package-lock.json package.json ./
RUN npm ci --omit=dev && mkdir -p node_modules && npm cache clean --force

FROM ${NODE_IMAGE} AS runtime

LABEL org.opencontainers.image.source="https://github.com/YishenTu/claudian-cloud-server"

ENV NODE_ENV=production
WORKDIR /app

COPY --from=production-dependencies --chown=10001:10001 /app/node_modules ./node_modules
COPY --from=build --chown=10001:10001 /workspace/dist ./dist
COPY --from=build --chown=10001:10001 /workspace/package.json ./package.json

USER 10001:10001
STOPSIGNAL SIGTERM

CMD ["node", "dist/main.js"]
