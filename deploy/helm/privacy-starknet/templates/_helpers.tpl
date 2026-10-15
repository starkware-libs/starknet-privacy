{{- define "privacy-starknet.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Release-scoped name prefix. Truncated so component suffixes still fit the 63-character
DNS label limit; the longest, "-transaction-prover-ohttp", is 25 characters.
*/}}
{{- define "privacy-starknet.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 38 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 38 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 38 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "privacy-starknet.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Name of a component's resources.
Usage: {{ include "privacy-starknet.componentName" (list . "transaction-prover") }}
*/}}
{{- define "privacy-starknet.componentName" -}}
{{- printf "%s-%s" (include "privacy-starknet.fullname" (first .)) (last .) }}
{{- end }}

{{/*
Labels on every resource of a component. Usage as for componentName.
*/}}
{{- define "privacy-starknet.labels" -}}
{{- $root := first . -}}
helm.sh/chart: {{ include "privacy-starknet.chart" $root }}
{{ include "privacy-starknet.selectorLabels" . }}
{{- if $root.Chart.AppVersion }}
app.kubernetes.io/version: {{ $root.Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ $root.Release.Service }}
app.kubernetes.io/part-of: {{ include "privacy-starknet.name" $root }}
{{- end }}

{{/*
Pod selector of a component. Immutable on a Deployment, so never add to it.
*/}}
{{- define "privacy-starknet.selectorLabels" -}}
{{- $root := first . -}}
app.kubernetes.io/name: {{ include "privacy-starknet.name" $root }}
app.kubernetes.io/instance: {{ $root.Release.Name }}
app.kubernetes.io/component: {{ last . }}
{{- end }}

{{/*
Container image reference; the tag defaults to the chart's appVersion, which the release
workflow sets to the release tag.
Usage: {{ include "privacy-starknet.image" (list . .Values.discoveryService.image) }}
*/}}
{{- define "privacy-starknet.image" -}}
{{- $image := last . }}
{{- printf "%s:%s" $image.repository (default (first .).Chart.AppVersion $image.tag) }}
{{- end }}

{{/*
Name of the Secret holding a component's OHTTP key: the user's existingSecret, or the
one the chart creates from ohttp.key.
Usage: {{ include "privacy-starknet.ohttpSecretName" (list . "discovery-service" .Values.discoveryService.ohttp) }}
*/}}
{{- define "privacy-starknet.ohttpSecretName" -}}
{{- $ohttp := last . }}
{{- if $ohttp.existingSecret }}
{{- $ohttp.existingSecret }}
{{- else }}
{{- printf "%s-ohttp" (include "privacy-starknet.componentName" (list (first .) (index . 1))) }}
{{- end }}
{{- end }}
