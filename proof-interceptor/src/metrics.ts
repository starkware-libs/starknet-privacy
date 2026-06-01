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
  name: "proof_interceptor_rpc_requests_total",
  help: "Total JSON-RPC requests by verdict action and method",
  labelNames: ["action", "method"] as const,
  registers: [registry],
});

export const interceptorVerdicts = new Counter({
  name: "proof_interceptor_interceptor_verdicts_total",
  help: "Total interceptor verdicts by interceptor name and verdict",
  labelNames: ["interceptor", "verdict"] as const,
  registers: [registry],
});

export const screeningResults = new Counter({
  name: "proof_interceptor_screening_results_total",
  help: "Total screening outcomes",
  labelNames: ["result"] as const,
  registers: [registry],
});

export const screeningRetries = new Counter({
  name: "proof_interceptor_screening_retries_total",
  help: "Total screening retry attempts (not counting first attempt)",
  registers: [registry],
});

export const signaturesIssued = new Counter({
  name: "proof_interceptor_screening_signatures_issued_total",
  help: "Total screening signatures relayed to the prover on an allowed deposit",
  registers: [registry],
});

export const errorsTotal = new Counter({
  name: "proof_interceptor_errors_total",
  help: "Total error events by type",
  labelNames: ["type"] as const,
  registers: [registry],
});

export const requestDuration = new Histogram({
  name: "proof_interceptor_request_duration_seconds",
  help: "Total request latency by RPC action",
  labelNames: ["action"] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const screeningDuration = new Histogram({
  name: "proof_interceptor_screening_duration_seconds",
  help: "Elliptic-proxy screening call latency by result",
  labelNames: ["result"] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const interceptorDuration = new Histogram({
  name: "proof_interceptor_interceptor_duration_seconds",
  help: "Per-interceptor execution latency",
  labelNames: ["interceptor", "verdict"] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const inFlightRequests = new Gauge({
  name: "proof_interceptor_in_flight_requests",
  help: "Currently processing requests",
  registers: [registry],
});
