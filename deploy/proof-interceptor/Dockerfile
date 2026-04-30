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

# Drop devDependencies once compilation is done; the runtime stage only
# needs the production deps.
RUN cd proof-interceptor \
 && npm prune --omit=dev

# ---- runtime stage --------------------------------------------------------
FROM node:22-slim
WORKDIR /app/proof-interceptor

# The SDK is a file: dependency, so the runtime needs both directories
# present at the path npm resolved during install.
COPY --from=build /app/sdk /app/sdk
COPY --from=build /app/proof-interceptor /app/proof-interceptor

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

USER node

CMD ["node", "dist/index.js"]
