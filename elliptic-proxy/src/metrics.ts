// src/metrics.ts
//
// A dedicated Prometheus registry for the proxy, rendered on GET /metrics.
// Kept off prom-client's global default registry so test suites can reset
// accumulated state in isolation without touching process-wide globals.
import { Counter, Registry, collectDefaultMetrics } from "prom-client";

export const register = new Registry();

// Process-level series: memory, CPU, event-loop lag, and
// process_start_time_seconds — the last reveals a cold-start counter reset to
// any alert that compares against increase() over a window.
collectDefaultMetrics({ register });

// Outbound calls to the Elliptic upstream — the billed, allotment-capped
// resource. Split by partner so an abuse spike names whose secret to revoke,
// and by upstream so live ("elliptic") cost is separable from mock traffic.
export const ellipticRequests = new Counter({
  name: "elliptic_proxy_elliptic_requests_total",
  help: "Total requests forwarded to the Elliptic upstream.",
  labelNames: ["partner", "upstream"],
  registers: [register],
});

// The Prometheus text exposition served for a scrape.
export function renderMetrics(): Promise<string> {
  return register.metrics();
}

// The exposition content type prom-client expects scrapers to receive.
export const metricsContentType = register.contentType;

// Test-only: zero accumulated counter values between cases.
export function resetMetricsForTest(): void {
  register.resetMetrics();
}
