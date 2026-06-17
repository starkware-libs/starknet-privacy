// tests/metrics.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request } from "@google-cloud/functions-framework";
import { createHandler } from "../src/handler.js";
import {
  ellipticRequests,
  metricsContentType,
  resetMetricsForTest,
} from "../src/metrics.js";
import {
  makeConfig,
  makeMockEllipticConfig,
  makeRequest,
  makeResponse,
} from "./helpers.js";

// An upstream reply the handler treats as "not on chain" → allowed, so the
// flow reaches the dispatch site and completes without crafting a score body.
const NOT_ON_CHAIN = { status: 404, body: "", durationMs: 5 };

async function ellipticCount(
  partner: string,
  upstream: string
): Promise<number> {
  const metric = await ellipticRequests.get();
  const series = metric.values.find(
    (v) => v.labels.partner === partner && v.labels.upstream === upstream
  );
  return series?.value ?? 0;
}

const METRICS_TOKEN = "scrape-token";

function makeMetricsRequest(authHeader?: string): Request {
  return {
    method: "GET",
    path: "/metrics",
    headers: authHeader ? { authorization: authHeader } : {},
  } as unknown as Request;
}

describe("GET /metrics", () => {
  const mockForward = vi.fn();

  function handlerWith(token?: string) {
    const config = makeConfig(token ? { metricsAuthToken: token } : {});
    const configLoader = { get: vi.fn().mockResolvedValue(config) };
    return createHandler(configLoader, mockForward);
  }

  it("returns 404 when no metricsAuthToken is configured", async () => {
    const handler = handlerWith();
    const res = makeResponse();
    await handler(makeMetricsRequest(`Bearer ${METRICS_TOKEN}`), res);
    expect(res.statusCode).toBe(404);
    expect(mockForward).not.toHaveBeenCalled();
  });

  it("returns 401 when the bearer token is missing", async () => {
    const handler = handlerWith(METRICS_TOKEN);
    const res = makeResponse();
    await handler(makeMetricsRequest(), res);
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 when the bearer token is wrong", async () => {
    const handler = handlerWith(METRICS_TOKEN);
    const res = makeResponse();
    await handler(makeMetricsRequest("Bearer not-the-token"), res);
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 when the token matches but the scheme is not Bearer", async () => {
    const handler = handlerWith(METRICS_TOKEN);
    const res = makeResponse();
    await handler(makeMetricsRequest(METRICS_TOKEN), res);
    expect(res.statusCode).toBe(401);
  });

  it("serves the Prometheus exposition with a valid token", async () => {
    const handler = handlerWith(METRICS_TOKEN);
    const res = makeResponse();
    await handler(makeMetricsRequest(`Bearer ${METRICS_TOKEN}`), res);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe(metricsContentType);
    // collectDefaultMetrics always emits the process start time series.
    expect(res.body).toContain("process_start_time_seconds");
    expect(mockForward).not.toHaveBeenCalled();
  });
});

describe("elliptic_proxy_elliptic_requests_total", () => {
  beforeEach(() => resetMetricsForTest());

  function handlerFor(config = makeConfig(), forward = vi.fn()) {
    const configLoader = { get: vi.fn().mockResolvedValue(config) };
    return { handler: createHandler(configLoader, forward), forward };
  }

  it("increments by partner and upstream on a forwarded call", async () => {
    const { handler, forward } = handlerFor();
    forward.mockResolvedValue(NOT_ON_CHAIN);
    await handler(makeRequest(), makeResponse());
    expect(forward).toHaveBeenCalledTimes(1);
    expect(await ellipticCount("test-partner", "elliptic")).toBe(1);
  });

  it("labels the mock upstream when screening against it", async () => {
    const { handler, forward } = handlerFor(makeMockEllipticConfig());
    forward.mockResolvedValue(NOT_ON_CHAIN);
    await handler(makeRequest(), makeResponse());
    expect(await ellipticCount("test-partner", "mock")).toBe(1);
    expect(await ellipticCount("test-partner", "elliptic")).toBe(0);
  });

  it("does not count an allowlist hit (no upstream call)", async () => {
    const { handler, forward } = handlerFor(
      makeConfig({ blockOverrideAddresses: ["0xabc123"] })
    );
    await handler(makeRequest(), makeResponse());
    expect(forward).not.toHaveBeenCalled();
    expect(await ellipticCount("test-partner", "elliptic")).toBe(0);
  });

  it("does not count a request rejected before auth", async () => {
    const { handler, forward } = handlerFor();
    const req = makeRequest({
      headers: {
        "x-access-key": "test-partner",
        "x-access-sign": "bad-signature",
        "x-access-timestamp": Date.now().toString(),
      },
    });
    await handler(req, makeResponse());
    expect(forward).not.toHaveBeenCalled();
    expect(await ellipticCount("test-partner", "elliptic")).toBe(0);
  });
});
