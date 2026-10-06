# Privacy Starknet Helm Chart

This chart deploys the Starknet privacy transaction prover and discovery service. The
proof-interceptor screening sidecar runs in the transaction-prover Pod and is enabled by
default.

## Prerequisites

- Helm 3.14 or newer and access to the target Kubernetes cluster.
- A Pathfinder RPC endpoint for the transaction prover. It must retain enough recent
  state tries for the blocks you intend to prove; configure
  `PATHFINDER_STORAGE_STATE_TRIES` when you operate the node.
- HTTP RPC and WebSocket endpoints for the discovery service.
- Nodes that satisfy the configured selectors, tolerations, and resource requests. The
  defaults select GKE node pools, and the prover requests 32 CPUs and 48 GiB of memory.
- Screening partner credentials when the proof interceptor is enabled.

Resource names and workload selectors are fixed, so install at most one release of this
chart in a namespace.

## Configure and install

Create a private values file or produce one from your secret manager. At minimum,
replace the placeholders below:

```yaml
transactionProver:
  config:
    rpc_node_url: "<pathfinder-rpc-url>"
    chain_id: "<chain-id>"
  ohttp:
    key: "<32-byte-hex-key>"
  proofInterceptor:
    image:
      tag: "<proof-interceptor-image-tag>"
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

`transactionProver.proofInterceptor.screening.rpcUrl` is chart-owned and must not be
set. The chart uses `transactionProver.config.rpc_node_url` for both prover and sidecar
policy reads.

Ensure the namespace exists, then create the Secret referenced by the sidecar:

```bash
kubectl create namespace <namespace>
kubectl create secret generic proof-interceptor-screening \
  --namespace <namespace> \
  --from-literal=partner-name="<partner-name>" \
  --from-literal=partner-secret="<partner-secret>"
```

Install the release:

```bash
helm install privacy ./privacy-starknet \
  --namespace <namespace> \
  --atomic --timeout 15m \
  -f <private-values-file>
```

OHTTP keys are stored in the Helm release state as well as the rendered workloads.
Protect values files and release-state Secrets, and avoid passing sensitive values with
`--set`, which also records them in shell history.

## Configuration delivery

| Component | Settings | Channel |
| --- | --- | --- |
| discovery-service | `config.rpcUrl`, `config.wsUrl`, `config.rustLog`, `config.api.health_max_lag_secs`, `ohttp.enabled` | `config.toml` in ConfigMap `discovery-service-config` |
| discovery-service | `config.apiHost` | `API_HOST` env var; the image bakes a default that overrides the file |
| discovery-service | `ohttp.key` | `OHTTP_KEY` env var |
| transaction-prover | `config.*`, plus `blocking_check_*` when the sidecar is enabled | `config.json` in ConfigMap `transaction-prover-config` |
| transaction-prover | `ohttp.enabled`, `ohttp.key` | `OHTTP_ENABLED` and `OHTTP_KEY` env vars |
| proof-interceptor | `proofInterceptor.port`, `proofInterceptor.screening.*`, and `config.rpc_node_url` as `SCREENING_RPC_URL` | env vars from ConfigMap `proof-interceptor-env`, rendered only when the sidecar is enabled |
| proof-interceptor | Partner credentials | `SCREENING_PARTNER_NAME` and `SCREENING_PARTNER_SECRET` from the `partner-name` and `partner-secret` keys of Secret `proofInterceptor.screeningSecretName` |

Each Deployment's Pod template carries a `checksum/config` annotation: the SHA-256 of
the configuration file its containers read. With the sidecar enabled, the prover Pod also
carries `checksum/proof-interceptor-env` for the sidecar's environment. Changing a
rendered payload therefore rolls only the Deployment that consumes it, while
chart-version or label changes do not, and neither do sidecar settings while the sidecar
is disabled. OHTTP keys and partner credentials are never written to a ConfigMap. Changes
to the content of externally managed Secrets are not covered by these checksums; restart
the Deployment after rotating them.

## Optional components

OHTTP and proof interception are enabled by default. Disable a feature explicitly when
it is not part of the deployment:

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

Both screening failure policies default to closed. A screening error, timeout, or
unreachable sidecar therefore blocks the transaction. Review
`transactionProver.proofInterceptor.screening.failOpen` and
`transactionProver.proofInterceptor.blockingCheck.failOpen` before changing that policy.

The sidecar is reachable only inside its Pod at `localhost:8080`; the chart does not
create a Service for it.

## Cluster-specific defaults

The defaults include GKE node selectors, a prover toleration, NEG Service annotations,
and `cloud.google.com/v1` BackendConfig resources. Override scheduling and resources for
your cluster. On a non-GKE cluster, also remove the annotations and disable the
BackendConfig resources:

```yaml
transactionProver:
  nodeSelector: null
  tolerations: []
  service:
    annotations: null
  backendConfig:
    enabled: false

discoveryService:
  nodeSelector: null
  service:
    annotations: null
  backendConfig:
    enabled: false
```

See [`values.yaml`](values.yaml) for every setting and its default.

## Network exposure

Both Services default to `ClusterIP`, and both Ingresses default to disabled. Configure
the Ingress blocks for public access, including the class, host, annotations, and TLS
Secret. If the issuer uses ACME HTTP-01, port 80 must remain reachable during certificate
issuance; use DNS-01 when HTTP must stay disabled.

To expose a Service directly, set its type explicitly:

```yaml
transactionProver:
  service:
    type: LoadBalancer
discoveryService:
  service:
    type: LoadBalancer
```

Direct Service exposure can bypass Ingress TLS and policy. Set a component's complete
`service` block to `null` when another resource manages access and the chart should not
create that Service.

## Upgrade notes

Chart `0.4.0` moves the discovery service's RPC, WebSocket, and log-level settings from
env vars into its `config.toml`, moves the proof-interceptor's non-secret settings into
ConfigMap `proof-interceptor-env`, and adds configuration checksum annotations to both
Pod templates. Values keys and effective settings are unchanged, but adopting the annotations
changes both Pod templates, so the first upgrade to `0.4.0` rolls both Deployments.

Chart `0.3.0` changes both default Service types from `LoadBalancer` to `ClusterIP`.
Deployments that require direct load balancers must set both Service types explicitly
before upgrading.

Recent chart versions also enable OHTTP and proof interception by default. The
`--reset-then-reuse-values` flag starts with the new chart defaults and reapplies existing
user values, so provide the required keys, addresses, image tag, and Secret or disable
those features. Plain `--reuse-values` can omit newly introduced nested defaults.

```bash
helm upgrade privacy ./privacy-starknet \
  --namespace <namespace> \
  --reset-then-reuse-values \
  --atomic --timeout 15m \
  -f <private-values-file>
```

For Helm versions older than 3.14, export the current user-supplied values and pass them
back with `-f`:

```bash
helm get values privacy --namespace <namespace> -o yaml > /secure/path/privacy-values.yaml
helm upgrade privacy ./privacy-starknet \
  --namespace <namespace> \
  --atomic --timeout 15m \
  -f /secure/path/privacy-values.yaml \
  -f <new-private-values-file>
```

The exported file can contain credentials; store and remove it according to your secret
handling policy.

To disable the sidecar after rollout, upgrade with existing values and the explicit
override:

```bash
helm upgrade privacy ./privacy-starknet \
  --namespace <namespace> \
  --reuse-values \
  --set transactionProver.proofInterceptor.enabled=false
```

Use `helm rollback privacy <revision> --namespace <namespace>` for a full release
rollback.

## Uninstall

```bash
helm uninstall privacy --namespace <namespace>
```
