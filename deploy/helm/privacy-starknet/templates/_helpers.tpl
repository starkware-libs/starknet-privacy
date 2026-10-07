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
Effective values of one component, merged in increasing precedence: built-in defaults
(see _defaults.tpl), `global`, then the component's own values. Maps merge key by key
and any other value (lists, scalars) replaces the lower layer outright, so `false` and
`0` still override. `null` removes the key, as it does in Helm values, which templates
treat the same as disabling it.
Usage: {{- $prover := include "privacy-starknet.componentValues" (list . "transactionProver") | fromYaml }}
For the sidecar, pass a path: (list . "transactionProver" "proofInterceptor").
*/}}
{{- define "privacy-starknet.componentValues" -}}
{{- $root := first . -}}
{{- $builtin := include "privacy-starknet.builtinDefaults" $root | fromYaml -}}
{{- $merged := $builtin.shared -}}
{{- $component := $root.Values -}}
{{- range rest . -}}
{{- $builtin = get $builtin . -}}
{{- $component = get $component . -}}
{{- end -}}
{{- $global := default (dict) $root.Values.global -}}
{{- if gt (len (rest .)) 1 -}}
{{- /* A sidecar sized like its main container is never intended. */ -}}
{{- $global = omit $global "resources" -}}
{{- end -}}
{{- range list $builtin $global $component -}}
{{- $_ := include "privacy-starknet.mergeInto" (list $merged (default (dict) .)) -}}
{{- end -}}
{{- toYaml $merged -}}
{{- end -}}

{{/* Recursively writes the second map's entries into the first, in place. */}}
{{- define "privacy-starknet.mergeInto" -}}
{{- $target := first . -}}
{{- range $key, $value := last . -}}
{{- if kindIs "invalid" $value -}}
{{- $_ := unset $target $key -}}
{{- else if and (kindIs "map" $value) (kindIs "map" (get $target $key)) -}}
{{- $_ := include "privacy-starknet.mergeInto" (list (get $target $key) $value) -}}
{{- else -}}
{{- $_ := set $target $key (deepCopy $value) -}}
{{- end -}}
{{- end -}}
{{- end -}}

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
{{- $discovery := include "privacy-starknet.componentValues" (list . "discoveryService") | fromYaml -}}
{{- with $discovery.config -}}
[rpc]
url = {{ include "privacy-starknet.tomlString" .rpcUrl }}
[indexer]
ws_url = {{ include "privacy-starknet.tomlString" .wsUrl }}
[api]
health_max_lag_secs = {{ .api.health_max_lag_secs }}
[logging]
level = {{ include "privacy-starknet.tomlString" .rustLog }}
{{- end }}
{{- if $discovery.ohttp.enabled }}
[ohttp]
enabled = true
{{- end }}
{{- end }}

{{/*
Transaction-prover config.json: rendered into its ConfigMap and hashed for the Pod
template. The blocking_check_* fields point the prover at the enabled sidecar.
*/}}
{{- define "privacy-starknet.transactionProver.configJson" -}}
{{- $prover := include "privacy-starknet.componentValues" (list . "transactionProver") | fromYaml -}}
{{- $sidecar := include "privacy-starknet.componentValues" (list . "transactionProver" "proofInterceptor") | fromYaml -}}
{{- $cfg := deepCopy $prover.config -}}
{{- if $sidecar.enabled -}}
{{- $_ := set $cfg "blocking_check_url" (printf "http://localhost:%v" $sidecar.port) -}}
{{- $_ := set $cfg "blocking_check_timeout_millis" (int $sidecar.blockingCheck.timeoutMillis) -}}
{{- $_ := set $cfg "blocking_check_fail_open" $sidecar.blockingCheck.failOpen -}}
{{- end -}}
{{- $cfg | toPrettyJson -}}
{{- end }}

{{/*
Proof-interceptor non-secret env: rendered into its ConfigMap and hashed for the Pod
template. SCREENING_RPC_URL follows the prover's node so both containers read the same
state. Partner credentials stay explicit Secret references in the Deployment.
*/}}
{{- define "privacy-starknet.proofInterceptor.env" -}}
{{- $prover := include "privacy-starknet.componentValues" (list . "transactionProver") | fromYaml -}}
{{- with include "privacy-starknet.componentValues" (list . "transactionProver" "proofInterceptor") | fromYaml -}}
PORT: {{ .port | quote }}
SCREENING_URL: {{ .screening.url | quote }}
SCREENING_POOL_ADDRESS: {{ .screening.poolAddress | quote }}
SCREENING_ANONYMIZER_ADDRESS: {{ .screening.anonymizerAddress | quote }}
SCREENING_FAIL_OPEN: {{ .screening.failOpen | quote }}
SCREENING_TIMEOUT_MS: {{ .screening.timeoutMs | quote }}
SCREENING_MAX_RETRIES: {{ .screening.maxRetries | quote }}
SCREENING_RPC_URL: {{ $prover.config.rpc_node_url | quote }}
{{- end }}
{{- end }}
