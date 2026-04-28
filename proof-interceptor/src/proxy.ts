// src/proxy.ts
import type { IncomingMessage, ServerResponse } from "node:http";
import { validateRpcRequest } from "./rpc.js";
import {
  runInterceptors,
  notifyInterceptorError,
  notifyInterceptorComplete,
  type TransactionInterceptor,
} from "./interceptor.js";
import { jsonRpcError } from "./types.js";
import { DEFAULT_MAX_BODY_BYTES } from "./config.js";
import {
  registry,
  rpcRequestsTotal,
  requestDuration,
  errorsTotal,
  inFlightRequests,
} from "./metrics.js";

const TRANSACTION_REJECTED = 10000;

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

    inFlightRequests.inc();
    const startTime = Date.now();
    function finishRequest(rpcAction: string, fields: object) {
      const durationSeconds = (Date.now() - startTime) / 1000;
      inFlightRequests.dec();
      requestDuration.observe({ action: rpcAction }, durationSeconds);
      console.log(
        JSON.stringify({
          method: req.method,
          url: req.url,
          ...fields,
          latencyMs: Date.now() - startTime,
        })
      );
    }

    const declaredLength = parseInt(req.headers["content-length"] ?? "", 10);
    if (!Number.isNaN(declaredLength) && declaredLength > maxBodyBytes) {
      errorsTotal.inc({ type: "payload_too_large" });
      finishRequest("error", { error: "payload_too_large" });
      res.writeHead(413, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "payload too large" }));
      req.destroy();
      return;
    }

    let body: Buffer;
    try {
      body = await readBody(req, maxBodyBytes);
    } catch {
      errorsTotal.inc({ type: "payload_too_large" });
      finishRequest("error", { error: "payload_too_large" });
      res.writeHead(413, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "payload too large" }));
      return;
    }

    // Only JSON-RPC POST requests are handled
    if (req.method !== "POST" || !isJsonContent(req)) {
      errorsTotal.inc({ type: "invalid_request" });
      finishRequest("error", { error: "invalid_request" });
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ error: "only JSON-RPC POST requests are supported" })
      );
      return;
    }

    const verdict = validateRpcRequest(body.toString());

    if (!verdict.ok) {
      rpcRequestsTotal.inc({ action: "error", method: "" });
      errorsTotal.inc({ type: verdict.errorType });
      finishRequest("error", {
        rpcAction: "error",
        errorType: verdict.errorType,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(verdict.response));
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
      await notifyInterceptorError(
        interceptors,
        TRANSACTION_REJECTED,
        verdict.transaction
      );
      console.error(JSON.stringify({ error: "transaction_rejected" }));
      finishRequest("check_with_interceptors", {
        rpcAction: "check_with_interceptors",
        interceptorVerdict: "block",
      });
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
      return;
    }

    notifyInterceptorComplete(interceptors, verdict.transaction);

    // All interceptors allowed the transaction
    finishRequest("check_with_interceptors", {
      rpcAction: "check_with_interceptors",
      interceptorVerdict: "allow",
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: verdict.requestId,
        result: { allowed: true },
      })
    );
  };
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
