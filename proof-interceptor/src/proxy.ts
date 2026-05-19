// src/proxy.ts
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { validateRpcRequest } from "./rpc.js";
import { runInterceptors, type TransactionInterceptor } from "./interceptor.js";
import { jsonRpcError } from "./types.js";
import { DEFAULT_MAX_BODY_BYTES } from "./config.js";
import { logger, withRequestId } from "./logger.js";
import {
  registry,
  rpcRequestsTotal,
  requestDuration,
  errorsTotal,
  inFlightRequests,
} from "./metrics.js";

const TRANSACTION_REJECTED = 10000;
const REQUEST_ID_HEADER = "x-request-id";

export interface HandlerOptions {
  interceptors?: TransactionInterceptor[];
  maxBodyBytes?: number;
}

export function createHandler(options: HandlerOptions = {}) {
  const interceptors = options.interceptors ?? [];
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  return async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/health" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    if (req.url === "/metrics" && req.method === "GET") {
      const metricsBody = await registry.metrics();
      res.writeHead(200, { "content-type": registry.contentType });
      res.end(metricsBody);
      return;
    }

    // Generate or accept a request id. Caller-supplied ids are accepted
    // only when short and printable-ASCII — CR/LF would let a client
    // smuggle headers into the response via `res.setHeader`, and very
    // long values would balloon every log line for the request.
    const incomingId = req.headers[REQUEST_ID_HEADER];
    const candidate = Array.isArray(incomingId) ? incomingId[0] : incomingId;
    const requestId = isSafeRequestId(candidate) ? candidate : randomUUID();
    res.setHeader(REQUEST_ID_HEADER, requestId);

    await withRequestId(requestId, () =>
      handleRequest({ req, res, interceptors, maxBodyBytes })
    );
  };
}

interface RequestHandlerArgs {
  req: IncomingMessage;
  res: ServerResponse;
  interceptors: TransactionInterceptor[];
  maxBodyBytes: number;
}

async function handleRequest({
  req,
  res,
  interceptors,
  maxBodyBytes,
}: RequestHandlerArgs): Promise<void> {
  inFlightRequests.inc();
  const startTime = Date.now();

  function finishRequest(rpcAction: string, fields: object): void {
    const latencyMs = Date.now() - startTime;
    const durationSeconds = latencyMs / 1000;
    inFlightRequests.dec();
    requestDuration.observe({ action: rpcAction }, durationSeconds);
    logger.info({
      event: "request",
      method: req.method,
      url: req.url,
      status: res.statusCode,
      latencyMs,
      ...fields,
    });
  }

  const declaredLength = parseInt(req.headers["content-length"] ?? "", 10);
  if (!Number.isNaN(declaredLength) && declaredLength > maxBodyBytes) {
    errorsTotal.inc({ type: "payload_too_large" });
    res.writeHead(413, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "payload too large" }));
    req.destroy();
    finishRequest("error", { error: "payload_too_large" });
    return;
  }

  let body: Buffer;
  try {
    body = await readBody(req, maxBodyBytes);
  } catch {
    errorsTotal.inc({ type: "payload_too_large" });
    res.writeHead(413, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "payload too large" }));
    finishRequest("error", { error: "payload_too_large" });
    return;
  }

  // Only accept JSON-RPC POST requests
  if (req.method !== "POST" || !isJsonContent(req)) {
    errorsTotal.inc({ type: "invalid_request" });
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "only JSON-RPC POST requests accepted" }));
    finishRequest("error", { error: "invalid_request" });
    return;
  }

  const verdict = validateRpcRequest(body.toString());

  if (!verdict.ok) {
    rpcRequestsTotal.inc({ action: "error", method: "" });
    errorsTotal.inc({ type: verdict.errorType });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(verdict.response));
    finishRequest("error", {
      rpcAction: "error",
      errorType: verdict.errorType,
    });
    return;
  }

  rpcRequestsTotal.inc({
    action: "check_with_interceptors",
    method: "starknet_checkTransaction",
  });

  const interceptorVerdict = await runInterceptors(
    interceptors,
    verdict.transaction
  );

  if (interceptorVerdict.action === "block") {
    logger.warn({ event: "transaction_rejected" });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify(
        jsonRpcError(
          verdict.requestId,
          TRANSACTION_REJECTED,
          "Transaction rejected",
          interceptorVerdict.reason
        )
      )
    );
    finishRequest("check_with_interceptors", {
      rpcAction: "check_with_interceptors",
      interceptorVerdict: "block",
    });
    return;
  }

  // All interceptors allowed the transaction
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      id: verdict.requestId,
      result: { allowed: true },
    })
  );
  finishRequest("check_with_interceptors", {
    rpcAction: "check_with_interceptors",
    interceptorVerdict: "allow",
  });
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    function resolveOnce(value: Buffer) {
      if (settled) return;
      settled = true;
      resolve(value);
    }

    function rejectOnce(error: Error) {
      if (settled) return;
      settled = true;
      reject(error);
    }

    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        req.destroy();
        rejectOnce(new Error("body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveOnce(Buffer.concat(chunks)));
    req.on("error", (error) => rejectOnce(error));
    req.on("close", () => {
      if (!req.complete) {
        rejectOnce(new Error("request closed before body was fully received"));
      }
    });
  });
}

function isJsonContent(req: IncomingMessage): boolean {
  const contentType = req.headers["content-type"] ?? "";
  return contentType.includes("application/json");
}

const MAX_REQUEST_ID_LEN = 128;
// Printable ASCII excluding whitespace — same allow-list the prover uses.
const REQUEST_ID_RE = /^[\x21-\x7e]+$/;

function isSafeRequestId(value: string | undefined): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_REQUEST_ID_LEN &&
    REQUEST_ID_RE.test(value)
  );
}
