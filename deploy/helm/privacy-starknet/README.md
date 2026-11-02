# Privacy Starknet Helm Chart

Deploys the Starknet privacy transaction prover and discovery service. The
proof-interceptor screening sidecar runs in the transaction-prover Pod and is enabled by
default.

See [`values.yaml`](values.yaml) for every setting and its default.

## Prerequisites

- Helm 3.14 or newer.
- A Pathfinder RPC endpoint for the transaction prover. It must retain enough recent
  state tries for the blocks you intend to prove (`PATHFINDER_STORAGE_STATE_TRIES`).
- HTTP RPC and WebSocket endpoints for the discovery service.
- Nodes that fit the prover, which typically needs around 32 CPUs and 48 GiB of memory.
- Screening partner credentials when the proof interceptor is enabled.

## Install

The chart is published to `oci://ghcr.io/starkware-libs/starknet-privacy/charts` on every
`PRIVACY-*` release. Its images default to that release's tag.

Create the Secret the sidecar reads its partner credentials from:

```bash
kubectl create secret generic proof-interceptor-screening \
  --namespace <namespace> \
  --from-literal=partner-name="<partner-name>" \
  --from-literal=partner-secret="<partner-secret>"
```

Write a private values file with the required settings:

```yaml
transactionProver:
  config:
    rpc_node_url: "<pathfinder-rpc-url>"
    chain_id: "<chain-id>"
  ohttp:
    key: "<32-byte-hex-key>"
  proofInterceptor:
    screening:
      url: "<screening-proxy-url>"
      poolAddress: "<pool-contract-address>"
      anonymizerAddress: "<anonymizer-contract-address>"

discoveryService:
  config:
    rpcUrl: "<rpc-url>"
    wsUrl: "<websocket-url>"
  ohttp:
    key: "<32-byte-hex-key>"
```

Then install:

```bash
helm install privacy-starknet oci://ghcr.io/starkware-libs/starknet-privacy/charts/privacy-starknet \
  --version <chart-version> \
  --namespace <namespace> \
  --atomic --timeout 15m \
  -f <private-values-file>
```

Resources are named `<release>-transaction-prover` and `<release>-discovery-service`, or
just `<release>-…` when the release name contains `privacy-starknet`. Use
`fullnameOverride` to choose the prefix.

## Secrets

The chart stores each OHTTP key in a Secret it creates from `ohttp.key`, so the key is
also kept in the Helm release state. To keep it out of Helm, create the Secret yourself
with the key under `key` and reference it instead:

```yaml
transactionProver:
  ohttp:
    existingSecret: <secret-name>
```

## Configuration delivery

| Container | Settings | Delivered as |
| --- | --- | --- |
| discovery-service | `config.rpcUrl`, `config.wsUrl`, `config.rustLog`, `config.api.*`, `ohttp.enabled` | `config.toml` in ConfigMap `<release>-discovery-service` |
| discovery-service | `port` | `API_HOST` env var, because the image sets `API_HOST` and an env var overrides the file |
| discovery-service | OHTTP key | `OHTTP_KEY` from the OHTTP Secret |
| transaction-prover | `config.*`, plus `blocking_check_*` when the sidecar is enabled | `config.json` in ConfigMap `<release>-transaction-prover` |
| transaction-prover | `ohttp.enabled`, OHTTP key | `OHTTP_ENABLED`, and `OHTTP_KEY` from the OHTTP Secret |
| proof-interceptor | `proofInterceptor.port`, `proofInterceptor.screening.*` except `existingSecret`, and `config.rpc_node_url` as `SCREENING_RPC_URL` | `envFrom` ConfigMap `<release>-proof-interceptor`, rendered only when the sidecar is enabled |
| proof-interceptor | Partner credentials | `SCREENING_PARTNER_NAME` and `SCREENING_PARTNER_SECRET` from Secret `proofInterceptor.screening.existingSecret` |

Each Pod template carries a checksum of every ConfigMap and Secret the chart renders for
it, so changing one rolls only the Deployment that reads it. A Secret you create yourself
(`existingSecret`) is not covered; restart the Deployment after rotating it.

## Optional features

OHTTP and proof interception are enabled by default. Disable them explicitly:

```yaml
transactionProver:
  ohttp:
    enabled: false
  proofInterceptor:
    enabled: false
discoveryService:
  ohttp:
    enabled: false
```

Both screening failure policies fail closed: a screening error, timeout, or unreachable
sidecar blocks the transaction. Review `proofInterceptor.screening.failOpen` and
`proofInterceptor.blockingCheck.failOpen` before changing that.

## GKE

Each component gets a `cloud.google.com/v1` BackendConfig, linked to its Service by the
`cloud.google.com/backend-config` annotation. The prover's health check targets the
sidecar, because the prover has no GET health route. On other clusters, disable it:

```yaml
transactionProver:
  backendConfig:
    enabled: false
discoveryService:
  backendConfig:
    enabled: false
```

## Network exposure

Both Services are `ClusterIP` and both Ingresses are disabled. For public access,
configure the `ingress` blocks (class, hosts, annotations, TLS). With an ACME HTTP-01
issuer, port 80 must stay reachable during certificate issuance; use DNS-01 otherwise.
Setting a Service `type` to `LoadBalancer` exposes it directly, bypassing Ingress TLS.

## Upgrading from 0.4.x

0.5.0 moves the discovery service's `rpcUrl`, `wsUrl` and `rustLog` from env vars into its
`config.toml`, and the proof-interceptor's non-secret settings into ConfigMap
`<release>-proof-interceptor`. Values keys are unchanged.

These settings now reach the services exactly as written. As container `env` entries,
Kubernetes rewrote them: `$$` became `$`, and `$(NAME)` was replaced by an earlier env var
of the same container. Before upgrading, check `discoveryService.config.rpcUrl`, `wsUrl`
and `rustLog`, `transactionProver.config.rpc_node_url`, and
`transactionProver.proofInterceptor.port` and `screening.*` for `$$` or `$(`, and replace
each with its intended literal value.

## Upgrading from 0.3.x

0.4.0 follows standard Helm conventions, which changes resource names, selectors and
values:

- Resources are named after the release and selected by `app.kubernetes.io/*` labels.
  Deployment selectors are immutable, so the upgrade replaces the Deployments and
  Services instead of updating them, and in-cluster Service DNS names change.
- Image tags default to the chart's appVersion; `image.tag` is only needed to pin a
  different release. `pullPolicy` defaults to `IfNotPresent`.
- `replicas` is now `replicaCount`. `discoveryService.containerPort` is now
  `discoveryService.port`, and `config.apiHost` is derived from it.
- `proofInterceptor.screeningSecretName` is now `proofInterceptor.screening.existingSecret`.
- Probes are full Kubernetes probe objects. Pod settings that only repeated Kubernetes
  defaults (`dnsPolicy`, `restartPolicy`, `strategy`, …) are removed.
- Ingress `defaultBackend` and per-path `servicePort` are removed; every path routes to
  the component's Service.
- The OHTTP key is read from a Secret instead of a plain environment variable.
- The `cloud.google.com/backend-config` Service annotation is set by the chart; remove
  it from your values.

## Uninstall

```bash
helm uninstall privacy-starknet --namespace <namespace>
```
