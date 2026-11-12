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
sidecar's `/health` by default. Read
[Prover health, metrics and shutdown](#prover-health-metrics-and-shutdown) before pointing
it at the prover. On other clusters, disable it:

```yaml
transactionProver:
  backendConfig:
    enabled: false
discoveryService:
  backendConfig:
    enabled: false
```

## Prover health, metrics and shutdown

The prover answers two unauthenticated GET routes on its JSON-RPC port
(`transactionProver.config.port`). `/metrics` and the saturation check behind `/health`
need `transaction-prover:PRIVACY-0.14.4-RC.1` or newer; older images answer `/health`
with `200` unconditionally. The
[prover README](https://github.com/starkware-libs/sequencer/tree/PRIVACY-0.14.4-RC.1/crates/starknet_transaction_prover#observability)
is the reference for both.

### `/health`

Returns `200` while the prover accepts work. It returns `503` once the prover is
saturated: requests were rejected as busy (JSON-RPC error `-32005`) and no worker slot
made progress for `health_max_saturated_ms`, 10 seconds by default. An idle prover always
returns `200`. Set the threshold with the other prover settings:

```yaml
transactionProver:
  config:
    health_max_saturated_ms: 10000
```

The chart's default probes check the TCP port, so saturation does not affect them. If you
switch a check to `/health`:

- Use it for the readiness probe or the load balancer health check, where a `503` takes
  the Pod out of rotation until a proof finishes. With a single replica that leaves no
  backend, so clients get the load balancer's error in place of `-32005`.
- Keep it off the liveness probe. A saturated prover is busy proving, and a restart
  discards the proofs in flight.

### `/metrics`

Serves Prometheus metrics:

- `prover_prove_transaction_outcome_total` and `prover_prove_transaction_duration_seconds`,
  labelled by outcome. Busy-rejects and transactions rejected for an unsupported builtin
  (JSON-RPC error `1002`) are outcomes of their own.
- `prover_queue_waiting_requests` and `prover_queue_wait_duration_seconds`.
- `prover_http_requests_total`, `prover_http_request_duration_seconds` and
  `prover_http_inflight_requests`.
- `prover_panics_total`.
- `prover_build_info`, which carries the image's version and git SHA.

The chart does not create a scrape configuration. An Ingress path of `/` routes
`/metrics` and `/health` to the prover along with the JSON-RPC endpoint, so anyone who
can reach the host can read them. Restrict the Ingress paths or filter at the load
balancer if that is not acceptable.

### Shutdown

On `SIGTERM` the prover stops accepting requests and lets in-flight proofs finish.
Kubernetes sends `SIGKILL` when the Pod's termination grace period ends, 30 seconds by
default, and the chart does not set a longer one. A proof still running at that point is
lost and the client must retry.

## Network exposure

Both Services are `ClusterIP` and both Ingresses are disabled. For public access,
configure the `ingress` blocks (class, hosts, annotations, TLS). With an ACME HTTP-01
issuer, port 80 must stay reachable during certificate issuance; use DNS-01 otherwise.
Setting a Service `type` to `LoadBalancer` exposes it directly, bypassing Ingress TLS.

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
