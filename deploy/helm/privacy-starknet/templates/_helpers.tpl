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
