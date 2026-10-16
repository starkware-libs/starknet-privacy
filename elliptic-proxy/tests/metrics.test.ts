// tests/metrics.test.ts
import { describe, it, expect, vi } from "vitest";
import type { Request } from "@google-cloud/functions-framework";
import { createHandler } from "../src/handler.js";
import { metricsContentType } from "../src/metrics.js";
import { makeConfig, makeResponse } from "./helpers.js";

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
