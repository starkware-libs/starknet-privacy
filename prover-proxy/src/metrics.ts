// src/metrics.ts
import {
  Registry,
  Counter,
  Histogram,
  Gauge,
  collectDefaultMetrics,
} from "prom-client";

export const registry = new Registry();

collectDefaultMetrics({ register: registry });

export const rpcRequestsTotal = new Counter({
  name: "prover_proxy_rpc_requests_total",
  help: "Total proxied requests by action, method, and transport",
  labelNames: ["action", "method", "transport"] as const,
  registers: [registry],
});

export const interceptorVerdicts = new Counter({
  name: "prover_proxy_interceptor_verdicts_total",
  help: "Total interceptor verdicts by interceptor name and verdict",
  labelNames: ["interceptor", "verdict"] as const,
  registers: [registry],
});

export const screeningResults = new Counter({
  name: "prover_proxy_screening_results_total",
  help: "Total screening outcomes",
  labelNames: ["result"] as const,
  registers: [registry],
});

export const screeningRetries = new Counter({
  name: "prover_proxy_screening_retries_total",
  help: "Total screening retry attempts (not counting first attempt)",
  registers: [registry],
});

export const upstreamResponses = new Counter({
  name: "prover_proxy_upstream_responses_total",
  help: "Total upstream prover responses by status code",
  labelNames: ["status_code"] as const,
  registers: [registry],
});

export const errorsTotal = new Counter({
  name: "prover_proxy_errors_total",
  help: "Total error events by type",
  labelNames: ["type"] as const,
  registers: [registry],
});

export const requestDuration = new Histogram({
  name: "prover_proxy_request_duration_seconds",
  help: "Total request latency by RPC action",
  labelNames: ["action"] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const upstreamDuration = new Histogram({
  name: "prover_proxy_upstream_duration_seconds",
  help: "Upstream prover call latency",
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const screeningDuration = new Histogram({
  name: "prover_proxy_screening_duration_seconds",
  help: "Elliptic-proxy screening call latency by result",
  labelNames: ["result"] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const interceptorDuration = new Histogram({
  name: "prover_proxy_interceptor_duration_seconds",
  help: "Per-interceptor execution latency",
  labelNames: ["interceptor", "verdict"] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const inFlightRequests = new Gauge({
  name: "prover_proxy_in_flight_requests",
  help: "Currently processing requests",
  registers: [registry],
});
