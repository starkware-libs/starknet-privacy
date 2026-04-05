// src/proxy.ts
import type { IncomingMessage, ServerResponse } from "node:http";
import { RpcAction, validateRpcRequest } from "./rpc.js";
import { runInterceptors, type TransactionInterceptor } from "./interceptor.js";
import { jsonRpcError } from "./types.js";
import { DEFAULT_MAX_BODY_BYTES } from "./config.js";

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

    const startTime = Date.now();
    function logRequest(fields: object) {
      console.log(
        JSON.stringify({
          method: req.method,
          url: req.url,
          ...fields,
          latencyMs: Date.now() - startTime,
        })
      );
    }

    function finishRequest(fields: object, statusCode: number) {
      logRequest({ ...fields, statusCode });
    }

    const declaredLength = parseInt(req.headers["content-length"] ?? "", 10);
    if (!Number.isNaN(declaredLength) && declaredLength > maxBodyBytes) {
      finishRequest({ error: "payload_too_large" }, 413);
      res.writeHead(413, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "payload too large" }));
      req.destroy();
      return;
    }

    let body: Buffer;
    try {
      body = await readBody(req, maxBodyBytes);
    } catch {
      finishRequest({ error: "payload_too_large" }, 413);
      res.writeHead(413, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "payload too large" }));
      return;
    }

    if (req.method !== "POST" || !isJsonContent(req)) {
      finishRequest({ error: "not_json_rpc" }, 400);
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ error: "only JSON-RPC POST requests are supported" })
      );
      return;
    }

    const verdict = validateRpcRequest(body.toString());

    if (verdict.action === RpcAction.Error) {
      finishRequest({ rpcAction: "error" }, 200);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(verdict.response));
      return;
    }

    if (verdict.action === RpcAction.ForwardAsIs) {
      // starknet_specVersion: return a static response without upstream
      finishRequest({ rpcAction: "forward_as_is" }, 200);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: verdict.requestId,
          result: "0.10.1",
        })
      );
      return;
    }

    // RpcAction.CheckWithInterceptors
    const interceptorVerdict = await runInterceptors(
      interceptors,
      verdict.transaction
    );

    if (interceptorVerdict.action === "block") {
      console.error(JSON.stringify({ error: "transaction_rejected" }));
      finishRequest(
        { rpcAction: "check_with_interceptors", interceptorVerdict: "block" },
        200
      );
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

    finishRequest(
      { rpcAction: "check_with_interceptors", interceptorVerdict: "allow" },
      200
    );
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
