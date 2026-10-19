# Multi-stage build for the proof-interceptor sidecar.
#
# Build context MUST be the workspace root (`starknet-privacy/`) because
# proof-interceptor depends on the local SDK via `"file:../sdk"` in its
# package.json. Build with:
#
#   docker build -f deploy/proof-interceptor/Dockerfile -t proof-interceptor:<tag> .
#
# The runtime stage is `node:22-slim` and runs as the unprivileged `node`
# user on port 8080. /health responds 200 OK; use it for liveness +
# readiness probes (see the deployment guide).

# ---- build stage ----------------------------------------------------------
FROM node:22-slim AS build
WORKDIR /app

# Build the local SDK first so its compiled `dist/` is available when
# proof-interceptor's `npm ci` resolves `file:../sdk`. The SDK is an npm workspace
# member, so it installs from the root lockfile into the hoisted /app/node_modules.
# Every member's package.json must be present for `npm ci` to accept that lockfile.
COPY package.json package-lock.json ./
COPY client/package.json ./client/
COPY sdk/ ./sdk/
RUN cd sdk \
 && npm ci \
 && npm run build

# Build proof-interceptor against the just-built SDK.
COPY proof-interceptor/ ./proof-interceptor/
RUN cd proof-interceptor \
 && npm ci \
 && npm run build

# Drop devDependencies once compilation is done; the runtime stage only needs
# the production deps. The SDK is pruned too — it is a file: dependency, so its
# hoisted workspace tree ships in the image rather than being flattened into the
# interceptor's.
RUN cd proof-interceptor \
 && npm prune --omit=dev \
 && cd ../sdk \
 && npm prune --omit=dev

# ---- runtime stage --------------------------------------------------------
FROM node:22-slim
WORKDIR /app/proof-interceptor

# The SDK is a file: dependency, so the runtime needs both directories present
# at the path npm resolved during install: the interceptor's
# node_modules/@starkware-libs/starknet-privacy-sdk is a symlink to /app/sdk,
# whose own dependencies resolve from the workspace's hoisted /app/node_modules.
# No first-party sources, tests or configs are copied. The node_modules trees are
# not minimal: `--omit=dev` keeps optional peers and the SDK's own prod deps.
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
