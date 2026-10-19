# Multi-stage build for the proof-interceptor sidecar.
#
# Build context MUST be the repo root (`starknet-privacy/`) because
# proof-interceptor and the SDK are npm workspace members installed from the
# root package-lock.json. Build with:
#
#   docker build -f deploy/proof-interceptor/Dockerfile -t proof-interceptor:<tag> .
#
# The runtime stage is `node:22-slim` and runs as the unprivileged `node`
# user on port 8080. /health responds 200 OK; use it for liveness +
# readiness probes (see the deployment guide).

# ---- build stage ----------------------------------------------------------
FROM node:22-slim AS build
WORKDIR /app

# Install both workspace members from the root lockfile. Every member's
# package.json must be present for `npm ci` to accept that lockfile.
COPY package.json package-lock.json ./
COPY client/package.json ./client/
COPY sdk/ ./sdk/
COPY proof-interceptor/ ./proof-interceptor/
RUN npm ci -w sdk -w proof-interceptor

# The SDK builds first: proof-interceptor imports its compiled `dist/`.
RUN npm run build -w sdk \
 && npm run build -w proof-interceptor

# Drop devDependencies once compilation is done; the runtime stage only needs
# the production deps.
RUN npm prune --omit=dev -w sdk -w proof-interceptor

# ---- runtime stage --------------------------------------------------------
FROM node:22-slim
WORKDIR /app/proof-interceptor

# Workspace layout must survive into the runtime: the hoisted
# /app/node_modules/@starkware-libs/starknet-privacy-sdk is a symlink to /app/sdk,
# and proof-interceptor/node_modules holds only the versions that could not be
# hoisted. No first-party sources, tests or configs are copied. The node_modules
# trees are not minimal: `--omit=dev` keeps optional peers and the SDK's own prod deps.
COPY --from=build /app/sdk/package.json /app/sdk/package.json
COPY --from=build /app/sdk/dist /app/sdk/dist
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/proof-interceptor/package.json /app/proof-interceptor/package.json
COPY --from=build /app/proof-interceptor/dist /app/proof-interceptor/dist
COPY --from=build /app/proof-interceptor/node_modules /app/proof-interceptor/node_modules

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

USER node

CMD ["node", "dist/index.js"]
