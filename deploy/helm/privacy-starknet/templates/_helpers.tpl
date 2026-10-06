{{- define "privacy-starknet.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "privacy-starknet.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "privacy-starknet.labels" -}}
helm.sh/chart: {{ include "privacy-starknet.chart" . }}
app.kubernetes.io/name: {{ include "privacy-starknet.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
TOML basic string. JSON string escapes are a subset of TOML's. `$` is written as a
unicode escape because the discovery loader expands ${VAR} in the raw file before
parsing, so a literal value must never reach it as a placeholder.
*/}}
{{- define "privacy-starknet.tomlString" -}}
{{- ternary "" (toString .) (kindIs "invalid" .) | toRawJson | replace "$" "\\u0024" -}}
{{- end }}

{{/*
Discovery config.toml: rendered into its ConfigMap and hashed for the Pod template.
API_HOST stays an env var because the image bakes a default that overrides the file.
*/}}
{{- define "privacy-starknet.discoveryService.configToml" -}}
{{- with .Values.discoveryService.config -}}
[rpc]
url = {{ include "privacy-starknet.tomlString" .rpcUrl }}
[indexer]
ws_url = {{ include "privacy-starknet.tomlString" .wsUrl }}
[api]
health_max_lag_secs = {{ .api.health_max_lag_secs }}
[logging]
level = {{ include "privacy-starknet.tomlString" .rustLog }}
{{- end }}
{{- if .Values.discoveryService.ohttp.enabled }}
[ohttp]
enabled = true
{{- end }}
{{- end }}

{{/*
Transaction-prover config.json: rendered into its ConfigMap and hashed for the Pod
template. The blocking_check_* fields point the prover at the enabled sidecar.
*/}}
{{- define "privacy-starknet.transactionProver.configJson" -}}
{{- $cfg := deepCopy .Values.transactionProver.config -}}
{{- if .Values.transactionProver.proofInterceptor.enabled -}}
{{- $pi := .Values.transactionProver.proofInterceptor -}}
{{- $_ := set $cfg "blocking_check_url" (printf "http://localhost:%v" $pi.port) -}}
{{- $_ := set $cfg "blocking_check_timeout_millis" (int $pi.blockingCheck.timeoutMillis) -}}
{{- $_ := set $cfg "blocking_check_fail_open" $pi.blockingCheck.failOpen -}}
{{- end -}}
{{- $cfg | toPrettyJson -}}
{{- end }}
