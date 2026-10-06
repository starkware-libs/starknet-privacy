{{/*
Built-in defaults for the settings that `global` can override. They live here rather
than in values.yaml because Helm merges values.yaml into user values before templates
run: a default shipped under a component would be indistinguishable from a user's
component setting and would always beat `global`.
Precedence: component values > global > the component's block below > shared.
*/}}
{{- define "privacy-starknet.builtinDefaults" -}}
shared:
  image:
    tag: PRIVACY-0.14.2-RC.6
    pullPolicy: Always
  replicas: 1
  progressDeadlineSeconds: 600
  revisionHistoryLimit: 10
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 25%
      maxUnavailable: 25%
  dnsPolicy: ClusterFirst
  restartPolicy: Always
  terminationGracePeriodSeconds: 30
  livenessProbe:
    timeoutSeconds: 2
    failureThreshold: 3
    successThreshold: 1
  readinessProbe:
    timeoutSeconds: 2
    failureThreshold: 3
    successThreshold: 1
  ohttp:
    enabled: true
  service:
    type: ClusterIP
  backendConfig:
    enabled: true
    healthCheck:
      type: HTTP
      requestPath: /health

transactionProver:
  livenessProbe:
    initialDelaySeconds: 10
    periodSeconds: 30
    timeoutSeconds: 1
  readinessProbe:
    initialDelaySeconds: 5
    periodSeconds: 10
    timeoutSeconds: 1
  # The prover's JSON-RPC backend is POST-only, so GCE checks the proof-interceptor
  # /health endpoint instead; keep this port aligned with proofInterceptor.port.
  backendConfig:
    healthCheck:
      port: 8080
  proofInterceptor:
    livenessProbe:
      initialDelaySeconds: 5
      periodSeconds: 10
    readinessProbe:
      initialDelaySeconds: 3
      periodSeconds: 5
    resources:
      requests:
        cpu: "0.5"
        memory: 256Mi
      limits:
        cpu: "1"
        memory: 512Mi

discoveryService:
  # The readiness probe also gives GKE a health-check path to infer.
  readinessProbe:
    path: /health
    initialDelaySeconds: 5
    periodSeconds: 10
  livenessProbe:
    path: /health
    initialDelaySeconds: 15
    periodSeconds: 30
{{- end -}}
