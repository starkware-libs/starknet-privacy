# Multi-stage build for the proof-interceptor sidecar.
#
# Build context MUST be the workspace root (`starknet-privacy/`) because
# proof-interceptor depends on the local SDK via `"file:../sdk"` in its
# package.json. Build with:
#
#   docker build -f deploy/proof-interceptor/Dockerfile -t proof-interceptor:<tag> .
#
# The runtime stage is `NODE_IMAGE` and runs as the unprivileged `node`
# user on port 8080. /health responds 200 OK; use it for liveness +
# readiness probes (see the deployment guide).

# Both stages share one pinned Node image, so a release image's Node version
# is fixed by the commit it was built from. The tag names the version; the
# digest (the multi-arch index) is what Docker resolves. Bump both together
# when Node ships a security release.
ARG NODE_IMAGE=node:22.23.4-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d

# ---- build stage ----------------------------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /app

# Build the local SDK first so its compiled `dist/` is available when
# proof-interceptor's `npm ci` resolves `file:../sdk`.
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
# tree ships in the image rather than being flattened into the interceptor's.
RUN cd proof-interceptor \
 && npm prune --omit=dev \
 && cd ../sdk \
 && npm prune --omit=dev

# ---- runtime stage --------------------------------------------------------
FROM ${NODE_IMAGE}
WORKDIR /app/proof-interceptor

# The SDK is a file: dependency, so the runtime needs both directories present
# at the path npm resolved during install: the interceptor's
# node_modules/@starkware-libs/starknet-privacy-sdk is a symlink to /app/sdk.
# No first-party sources, tests or configs are copied. The node_modules trees are
# not minimal: `--omit=dev` keeps optional peers and the SDK's own prod deps.
COPY --from=build /app/sdk/package.json /app/sdk/package.json
COPY --from=build /app/sdk/dist /app/sdk/dist
COPY --from=build /app/sdk/node_modules /app/sdk/node_modules
COPY --from=build /app/proof-interceptor/package.json /app/proof-interceptor/package.json
COPY --from=build /app/proof-interceptor/dist /app/proof-interceptor/dist
COPY --from=build /app/proof-interceptor/node_modules /app/proof-interceptor/node_modules

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

USER node

CMD ["node", "dist/index.js"]
